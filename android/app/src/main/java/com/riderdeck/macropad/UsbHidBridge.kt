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
import android.hardware.usb.UsbRequest
import android.os.Build
import android.webkit.JavascriptInterface
import org.json.JSONArray
import org.json.JSONObject
import java.nio.ByteBuffer

/**
 * Puente USB expuesto a la pagina web como `window.AndroidHid`.
 *
 * Android si deja tomar una interfaz HID que el sistema ya esta usando, con
 * claimInterface(forceClaim = true): desconecta el driver del kernel mientras
 * la app la tiene reclamada. Eso es lo que WebHID no puede hacer todavia en
 * Chrome para Android.
 *
 * Los metodos son sincronos a proposito: WebView los ejecuta en un hilo propio,
 * asi que pueden bloquear sin congelar la interfaz. Los datos viajan como
 * cadenas hexadecimales para no complicar el puente.
 */
class UsbHidBridge(private val context: Context) {

    companion object {
        private const val ACTION_PERMISSION = "com.riderdeck.macropad.USB_PERMISSION"
        private const val REPORT_SIZE = 64

        /** SET_REPORT de la clase HID, para interfaces sin endpoint de salida. */
        private const val HID_SET_REPORT = 0x09
        private const val HID_GET_REPORT = 0x01
        private const val HID_OUT_REQUEST_TYPE = 0x21
        private const val HID_IN_REQUEST_TYPE = 0xA1
        private const val HID_OUTPUT_REPORT = 0x0200
        private const val HID_INPUT_REPORT = 0x0100

        /** Formas de escribir un reporte, por orden de preferencia. */
        const val WRITE_ENDPOINT = 1
        const val WRITE_CONTROL = 2
    }

    private val manager = context.getSystemService(Context.USB_SERVICE) as UsbManager

    private var connection: UsbDeviceConnection? = null
    private var claimed: UsbInterface? = null
    private var endpointIn: UsbEndpoint? = null
    private var endpointOut: UsbEndpoint? = null
    private var interfaceNumber = 0
    private var writeMethod = WRITE_ENDPOINT

    private val permissionReceiver = object : BroadcastReceiver() {
        override fun onReceive(ctx: Context?, intent: Intent?) { /* se consulta con devices() */ }
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

    @JavascriptInterface
    fun devices(): String {
        val out = JSONArray()
        for (device in manager.deviceList.values) {
            val interfaces = JSONArray()
            for (i in 0 until device.interfaceCount) {
                val iface = device.getInterface(i)
                if (iface.interfaceClass != UsbConstants.USB_CLASS_HID) continue
                val inEp = firstEndpoint(iface, UsbConstants.USB_DIR_IN)
                val outEp = firstEndpoint(iface, UsbConstants.USB_DIR_OUT)
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
    fun open(deviceId: Int, interfaceIndex: Int, method: Int): String {
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

        val inEp = firstEndpoint(iface, UsbConstants.USB_DIR_IN)
        if (inEp == null) {
            conn.releaseInterface(iface)
            conn.close()
            return "ERR:la interfaz no tiene endpoint de entrada"
        }

        connection = conn
        claimed = iface
        endpointIn = inEp
        endpointOut = firstEndpoint(iface, UsbConstants.USB_DIR_OUT)
        interfaceNumber = iface.id
        writeMethod = if (method == WRITE_CONTROL || endpointOut == null) WRITE_CONTROL else WRITE_ENDPOINT
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

    @JavascriptInterface
    fun write(hex: String): String {
        val conn = connection ?: return "ERR:sin conexion"
        val data = hexToBytes(hex, REPORT_SIZE) ?: return "ERR:datos invalidos"
        val sent = writeReport(conn, endpointOut, interfaceNumber, data, writeMethod)
        return if (sent < 0) "ERR:fallo al escribir" else ""
    }

    @JavascriptInterface
    fun read(timeoutMs: Int): String {
        val conn = connection ?: return "ERR:sin conexion"
        val ep = endpointIn ?: return "ERR:sin endpoint"
        return readReport(conn, ep, timeoutMs)
    }

    /** Escribe y espera respuesta, que es el caso habitual. */
    @JavascriptInterface
    fun transfer(hex: String, timeoutMs: Int): String {
        val wrote = write(hex)
        if (wrote.isNotEmpty()) return wrote
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            val left = (deadline - System.currentTimeMillis()).toInt().coerceAtLeast(1)
            val reply = read(left)
            if (reply.startsWith("ERR:")) return reply
            if (reply.isEmpty()) continue
            // AA FA son avisos de luz que el teclado manda solo, no respuestas.
            if (reply.startsWith("aafa")) continue
            return reply
        }
        return "ERR:el teclado no respondio"
    }

    // ------------------------------------------------------------- diagnostico

    /**
     * Recorre todas las interfaces HID y prueba las dos formas de escribir,
     * devolviendo lo que conteste cada una en crudo. Es la herramienta para
     * averiguar que interfaz entiende el protocolo cuando el sondeo falla.
     */
    @JavascriptInterface
    fun diagnose(deviceId: Int, probeHex: String, timeoutMs: Int): String {
        close()
        val device = findDevice(deviceId)
            ?: return JSONObject().put("error", "dispositivo no encontrado").toString()
        if (!manager.hasPermission(device)) {
            return JSONObject().put("error", "sin permiso de Android").toString()
        }

        val report = JSONArray()
        for (i in 0 until device.interfaceCount) {
            val iface = device.getInterface(i)
            val entry = JSONObject()
                .put("index", i)
                .put("number", iface.id)
                .put("class", iface.interfaceClass)
                .put("subclass", iface.interfaceSubclass)
                .put("protocol", iface.interfaceProtocol)

            val eps = JSONArray()
            for (e in 0 until iface.endpointCount) {
                val ep = iface.getEndpoint(e)
                eps.put(
                    JSONObject()
                        .put("address", ep.address)
                        .put("dir", if (ep.direction == UsbConstants.USB_DIR_IN) "in" else "out")
                        .put("type", ep.type)
                        .put("packetSize", ep.maxPacketSize)
                )
            }
            entry.put("endpoints", eps)

            if (iface.interfaceClass != UsbConstants.USB_CLASS_HID) {
                entry.put("skip", "no es HID")
                report.put(entry)
                continue
            }
            val inEp = firstEndpoint(iface, UsbConstants.USB_DIR_IN)
            if (inEp == null) {
                entry.put("skip", "sin endpoint de entrada")
                report.put(entry)
                continue
            }

            val conn = manager.openDevice(device)
            if (conn == null) {
                entry.put("error", "no se pudo abrir el dispositivo")
                report.put(entry)
                continue
            }
            val ok = conn.claimInterface(iface, true)
            entry.put("claimed", ok)
            if (!ok) {
                conn.close()
                report.put(entry)
                continue
            }

            val data = hexToBytes(probeHex, REPORT_SIZE)
            val outEp = firstEndpoint(iface, UsbConstants.USB_DIR_OUT)
            val tries = JSONArray()
            for (method in intArrayOf(WRITE_ENDPOINT, WRITE_CONTROL)) {
                if (method == WRITE_ENDPOINT && outEp == null) continue
                val t = JSONObject().put("method", if (method == WRITE_ENDPOINT) "endpoint" else "control")
                if (data == null) {
                    t.put("result", "sonda invalida")
                } else {
                    val sent = writeReport(conn, outEp, iface.id, data, method)
                    t.put("sent", sent)
                    if (sent >= 0) {
                        // Sin filtrar: interesa ver todo lo que llega, avisos incluidos.
                        val reply = readReport(conn, inEp, timeoutMs)
                        t.put("reply", if (reply.isEmpty()) "sin respuesta" else reply)
                    }
                }
                tries.put(t)
            }
            entry.put("tries", tries)

            conn.releaseInterface(iface)
            conn.close()
            report.put(entry)
        }
        return report.toString()
    }

    // ------------------------------------------------------------------ utiles

    private fun firstEndpoint(iface: UsbInterface, direction: Int): UsbEndpoint? {
        for (e in 0 until iface.endpointCount) {
            val ep = iface.getEndpoint(e)
            if (ep.direction == direction) return ep
        }
        return null
    }

    private fun writeReport(
        conn: UsbDeviceConnection, out: UsbEndpoint?, ifaceNumber: Int,
        data: ByteArray, method: Int
    ): Int {
        if (method == WRITE_ENDPOINT && out != null) {
            val n = conn.bulkTransfer(out, data, data.size, 1000)
            if (n >= 0) return n
            // Algunos telefonos no mueven endpoints de interrupcion con
            // bulkTransfer; UsbRequest es la via correcta para ese tipo.
            return writeWithRequest(conn, out, data)
        }
        return conn.controlTransfer(
            HID_OUT_REQUEST_TYPE, HID_SET_REPORT, HID_OUTPUT_REPORT,
            ifaceNumber, data, data.size, 1000
        )
    }

    private fun writeWithRequest(
        conn: UsbDeviceConnection, out: UsbEndpoint, data: ByteArray
    ): Int {
        val request = UsbRequest()
        return try {
            if (!request.initialize(conn, out)) return -1
            val buffer = ByteBuffer.allocateDirect(data.size)
            buffer.put(data)
            if (!request.queue(buffer)) return -1
            val done = conn.requestWait(1000)
            if (done == null) -1 else data.size
        } catch (e: Exception) {
            -1
        } finally {
            runCatching { request.close() }
        }
    }

    private fun readReport(conn: UsbDeviceConnection, ep: UsbEndpoint, timeoutMs: Int): String {
        val size = maxOf(ep.maxPacketSize, REPORT_SIZE)
        val buffer = ByteArray(size)
        val n = conn.bulkTransfer(ep, buffer, size, timeoutMs)
        if (n > 0) return bytesToHex(buffer, n)
        if (n == 0) return ""
        return readWithRequest(conn, ep, size, timeoutMs)
    }

    private fun readWithRequest(
        conn: UsbDeviceConnection, ep: UsbEndpoint, size: Int, timeoutMs: Int
    ): String {
        val request = UsbRequest()
        return try {
            if (!request.initialize(conn, ep)) return ""
            val buffer = ByteBuffer.allocateDirect(size)
            if (!request.queue(buffer)) return ""
            val done = conn.requestWait(timeoutMs.toLong().coerceAtLeast(1L)) ?: return ""
            if (done !== request) return ""
            val length = buffer.position()
            if (length <= 0) return ""
            val bytes = ByteArray(length)
            buffer.rewind()
            buffer.get(bytes)
            bytesToHex(bytes, length)
        } catch (e: Exception) {
            ""
        } finally {
            runCatching { request.close() }
        }
    }

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
