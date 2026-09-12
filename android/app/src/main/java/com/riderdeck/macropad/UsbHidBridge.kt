package com.riderdeck.macropad

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbEndpoint
import android.hardware.usb.UsbInterface
import android.hardware.usb.UsbManager
import android.os.Build
import android.webkit.JavascriptInterface
import org.json.JSONArray
import org.json.JSONObject

/**
 * Puente USB expuesto a la pagina web como `window.AndroidHid`.
 *
 * Android si deja tomar una interfaz HID que el sistema ya esta usando, con
 * claimInterface(forceClaim = true): desconecta el driver del kernel mientras
 * la app la tiene reclamada. Eso es justo lo que WebHID no puede hacer todavia
 * en Chrome para Android.
 *
 * Los metodos son sincronos a proposito: WebView los ejecuta en un hilo propio,
 * asi que pueden bloquear sin congelar la interfaz. Los datos viajan como
 * cadenas hexadecimales para no complicar el puente.
 */
class UsbHidBridge(private val context: Context) {

    companion object {
        private const val ACTION_PERMISSION = "com.riderdeck.macropad.USB_PERMISSION"
        private const val REPORT_SIZE = 64

        /** SET_REPORT de la clase HID, por si la interfaz no tiene endpoint de salida. */
        private const val HID_SET_REPORT = 0x09
        private const val HID_OUT_REQUEST_TYPE = 0x21
        private const val HID_OUTPUT_REPORT = 0x0200
    }

    private val manager = context.getSystemService(Context.USB_SERVICE) as UsbManager

    private var connection: UsbDeviceConnection? = null
    private var claimed: UsbInterface? = null
    private var endpointIn: UsbEndpoint? = null
    private var endpointOut: UsbEndpoint? = null
    private var interfaceNumber = 0

    private val permissionReceiver = object : BroadcastReceiver() {
        override fun onReceive(ctx: Context?, intent: Intent?) { /* el estado se consulta con devices() */ }
    }

    fun register() {
        val filter = IntentFilter(ACTION_PERMISSION)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            context.registerReceiver(permissionReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            context.registerReceiver(permissionReceiver, filter)
        }
    }

    fun unregister() {
        runCatching { context.unregisterReceiver(permissionReceiver) }
        close()
    }

    // ------------------------------------------------------------- enumeracion

    /** Todos los dispositivos USB conectados, con sus interfaces HID utiles. */
    @JavascriptInterface
    fun devices(): String {
        val out = JSONArray()
        for (device in manager.deviceList.values) {
            val interfaces = JSONArray()
            for (i in 0 until device.interfaceCount) {
                val iface = device.getInterface(i)
                if (iface.interfaceClass != UsbConstants.USB_CLASS_HID) continue
                var inEp: UsbEndpoint? = null
                var outEp: UsbEndpoint? = null
                for (e in 0 until iface.endpointCount) {
                    val ep = iface.getEndpoint(e)
                    if (ep.direction == UsbConstants.USB_DIR_IN && inEp == null) inEp = ep
                    if (ep.direction == UsbConstants.USB_DIR_OUT && outEp == null) outEp = ep
                }
                if (inEp == null) continue
                interfaces.put(
                    JSONObject()
                        .put("index", i)
                        .put("number", iface.id)
                        .put("subclass", iface.interfaceSubclass)
                        .put("protocol", iface.interfaceProtocol)
                        .put("packetSize", inEp.maxPacketSize)
                        .put("hasOut", outEp != null)
                )
            }
            if (interfaces.length() == 0) continue
            out.put(
                JSONObject()
                    .put("id", device.deviceId)
                    .put("name", device.productName ?: device.deviceName)
                    .put("manufacturer", device.manufacturerName ?: "")
                    .put("vendorId", device.vendorId)
                    .put("productId", device.productId)
                    .put("hasPermission", manager.hasPermission(device))
                    .put("interfaces", interfaces)
            )
        }
        return out.toString()
    }

    /** Lanza el dialogo de permiso de Android. El resultado se consulta con devices(). */
    @JavascriptInterface
    fun requestPermission(deviceId: Int): Boolean {
        val device = findDevice(deviceId) ?: return false
        if (manager.hasPermission(device)) return true
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
        } else {
            PendingIntent.FLAG_UPDATE_CURRENT
        }
        val intent = PendingIntent.getBroadcast(
            context, 0, Intent(ACTION_PERMISSION).setPackage(context.packageName), flags
        )
        manager.requestPermission(device, intent)
        return false
    }

    // -------------------------------------------------------------- conexion

    /** Reclama una interfaz HID, apartando al driver del sistema si hace falta. */
    @JavascriptInterface
    fun open(deviceId: Int, interfaceIndex: Int): String {
        close()
        val device = findDevice(deviceId) ?: return "ERR:dispositivo no encontrado"
        if (!manager.hasPermission(device)) return "ERR:sin permiso de Android"
        if (interfaceIndex >= device.interfaceCount) return "ERR:interfaz inexistente"

        val iface = device.getInterface(interfaceIndex)
        val conn = manager.openDevice(device) ?: return "ERR:no se pudo abrir el dispositivo"
        if (!conn.claimInterface(iface, true)) {
            conn.close()
            return "ERR:otra cosa tiene tomada la interfaz"
        }

        var inEp: UsbEndpoint? = null
        var outEp: UsbEndpoint? = null
        for (e in 0 until iface.endpointCount) {
            val ep = iface.getEndpoint(e)
            if (ep.direction == UsbConstants.USB_DIR_IN && inEp == null) inEp = ep
            if (ep.direction == UsbConstants.USB_DIR_OUT && outEp == null) outEp = ep
        }
        if (inEp == null) {
            conn.releaseInterface(iface)
            conn.close()
            return "ERR:la interfaz no tiene endpoint de entrada"
        }

        connection = conn
        claimed = iface
        endpointIn = inEp
        endpointOut = outEp
        interfaceNumber = iface.id
        return ""
    }

    @JavascriptInterface
    fun close() {
        claimed?.let { connection?.releaseInterface(it) }
        connection?.close()
        connection = null
        claimed = null
        endpointIn = null
        endpointOut = null
    }

    @JavascriptInterface
    fun isOpen(): Boolean = connection != null

    // ------------------------------------------------------------ transferencia

    /** Escribe un reporte de 64 bytes. Devuelve "" si fue bien. */
    @JavascriptInterface
    fun write(hex: String): String {
        val conn = connection ?: return "ERR:sin conexion"
        val data = hexToBytes(hex, REPORT_SIZE) ?: return "ERR:datos invalidos"
        val out = endpointOut
        val sent = if (out != null) {
            conn.bulkTransfer(out, data, data.size, 1000)
        } else {
            conn.controlTransfer(
                HID_OUT_REQUEST_TYPE, HID_SET_REPORT, HID_OUTPUT_REPORT,
                interfaceNumber, data, data.size, 1000
            )
        }
        return if (sent < 0) "ERR:fallo al escribir" else ""
    }

    /** Lee un reporte. Devuelve el hexadecimal, "" si no llego nada a tiempo. */
    @JavascriptInterface
    fun read(timeoutMs: Int): String {
        val conn = connection ?: return "ERR:sin conexion"
        val ep = endpointIn ?: return "ERR:sin endpoint"
        val buffer = ByteArray(maxOf(ep.maxPacketSize, REPORT_SIZE))
        val n = conn.bulkTransfer(ep, buffer, buffer.size, timeoutMs)
        if (n <= 0) return ""
        return bytesToHex(buffer, n)
    }

    /** Escribe y espera respuesta en una sola llamada, que es el caso habitual. */
    @JavascriptInterface
    fun transfer(hex: String, timeoutMs: Int): String {
        val wrote = write(hex)
        if (wrote.isNotEmpty()) return wrote
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            val reply = read((deadline - System.currentTimeMillis()).toInt().coerceAtLeast(1))
            if (reply.startsWith("ERR:")) return reply
            if (reply.isEmpty()) continue
            // AA FA son avisos de luz que el teclado manda solo, no respuestas.
            if (reply.startsWith("aafa")) continue
            return reply
        }
        return "ERR:el teclado no respondio"
    }

    // ------------------------------------------------------------------ utiles

    private fun findDevice(deviceId: Int): UsbDevice? =
        manager.deviceList.values.firstOrNull { it.deviceId == deviceId }

    private fun hexToBytes(hex: String, pad: Int): ByteArray? {
        if (hex.length % 2 != 0) return null
        val n = hex.length / 2
        if (n > pad) return null
        val out = ByteArray(pad)
        for (i in 0 until n) {
            val v = hex.substring(i * 2, i * 2 + 2).toIntOrNull(16) ?: return null
            out[i] = v.toByte()
        }
        return out
    }

    private fun bytesToHex(bytes: ByteArray, length: Int): String {
        val sb = StringBuilder(length * 2)
        for (i in 0 until length) sb.append("%02x".format(bytes[i].toInt() and 0xff))
        return sb.toString()
    }
}
