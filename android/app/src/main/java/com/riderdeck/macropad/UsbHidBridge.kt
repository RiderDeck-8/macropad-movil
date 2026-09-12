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
 * No hay una sola forma correcta de mover reportes por USB en Android, y cual
 * funciona depende del teclado y del telefono. Por eso el puente implementa
 * varias estrategias y deja que el lado web pruebe cual responde.
 */
class UsbHidBridge(private val context: Context) {

    companion object {
        private const val ACTION_PERMISSION = "com.riderdeck.macropad.USB_PERMISSION"
        private const val REPORT_SIZE = 64

        private const val HID_SET_REPORT = 0x09
        private const val HID_SET_IDLE = 0x0A
        private const val HID_OUT_REQUEST_TYPE = 0x21
        private const val HID_OUTPUT_REPORT = 0x0200

        private const val ENDPOINT_REQUEST_TYPE = 0x02
        private const val CLEAR_FEATURE = 0x01
        private const val ENDPOINT_HALT = 0x00

        /** GET_DESCRIPTOR estandar, para comprobar si el canal de control vive. */
        private const val GET_DESCRIPTOR = 0x06
        private const val DEVICE_IN_REQUEST_TYPE = 0x80
        private const val INTERFACE_IN_REQUEST_TYPE = 0x81
        private const val DESCRIPTOR_DEVICE = 0x0100
        private const val DESCRIPTOR_HID_REPORT = 0x2200

        /**
         * Combinaciones de escritura y lectura, por orden de preferencia.
         *
         * Las variantes "encolada" piden la lectura ANTES de escribir. Con
         * endpoints de interrupcion esa es la forma correcta: si se escribe
         * primero, la respuesta puede llegar antes de que nadie escuche.
         */
        const val S_BULK_QUEUED = 1     // escribe con bulkTransfer, lectura encolada
        const val S_REQ_QUEUED = 2      // escribe con UsbRequest, lectura encolada
        const val S_BULK_BULK = 3       // todo con bulkTransfer
        const val S_CONTROL_BULK = 4    // escribe con SET_REPORT de control

        private val STRATEGY_NAMES = mapOf(
            S_BULK_QUEUED to "bulk + lectura encolada",
            S_REQ_QUEUED to "request + lectura encolada",
            S_BULK_BULK to "bulk + bulk",
            S_CONTROL_BULK to "control + bulk"
        )
    }

    private val manager = context.getSystemService(Context.USB_SERVICE) as UsbManager

    private var connection: UsbDeviceConnection? = null
    private var claimed: UsbInterface? = null
    private var endpointIn: UsbEndpoint? = null
    private var endpointOut: UsbEndpoint? = null
    private var interfaceNumber = 0
    private var strategy = S_BULK_QUEUED

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
                val inEp = firstEndpoint(iface, UsbConstants.USB_DIR_IN) ?: continue
                interfaces.put(
                    JSONObject()
                        .put("index", i)
                        .put("number", iface.id)
                        .put("subclass", iface.interfaceSubclass)
                        .put("protocol", iface.interfaceProtocol)
                        .put("packetSize", inEp.maxPacketSize)
                        .put("hasOut", firstEndpoint(iface, UsbConstants.USB_DIR_OUT) != null)
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

    @JavascriptInterface
    fun open(deviceId: Int, interfaceIndex: Int, strategyId: Int): String {
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
        settle(conn, iface)

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
        strategy = if (endpointOut == null) S_CONTROL_BULK else strategyId
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

    /** Escribe y espera respuesta. Devuelve el hexadecimal o "ERR:...". */
    @JavascriptInterface
    fun transfer(hex: String, timeoutMs: Int): String {
        val conn = connection ?: return "ERR:sin conexion"
        val inEp = endpointIn ?: return "ERR:sin endpoint de entrada"
        val data = hexToBytes(hex, REPORT_SIZE) ?: return "ERR:datos invalidos"

        val deadline = System.currentTimeMillis() + timeoutMs
        while (true) {
            val left = (deadline - System.currentTimeMillis()).toInt()
            if (left <= 0) return "ERR:el teclado no respondio"
            val reply = exchange(conn, interfaceNumber, inEp, endpointOut, data, left, strategy)
            if (reply.startsWith("ERR:")) return reply
            if (reply.isEmpty()) return "ERR:el teclado no respondio"
            // AA FA son avisos de luz que el teclado manda solo, no respuestas.
            if (reply.startsWith("aafa")) continue
            return reply
        }
    }

    /** Escribe sin esperar respuesta. */
    @JavascriptInterface
    fun write(hex: String): String {
        val conn = connection ?: return "ERR:sin conexion"
        val data = hexToBytes(hex, REPORT_SIZE) ?: return "ERR:datos invalidos"
        val out = endpointOut
        val sent = if (out != null && strategy != S_CONTROL_BULK) {
            if (strategy == S_REQ_QUEUED) writeWithRequest(conn, out, data)
            else conn.bulkTransfer(out, data, data.size, 1000)
        } else {
            conn.controlTransfer(
                HID_OUT_REQUEST_TYPE, HID_SET_REPORT, HID_OUTPUT_REPORT,
                interfaceNumber, data, data.size, 1000
            )
        }
        return if (sent < 0) "ERR:fallo al escribir" else ""
    }

    // ------------------------------------------------------------- diagnostico

    /**
     * Recorre las interfaces HID y prueba todas las estrategias en cada una,
     * devolviendo en crudo lo que conteste. Con eso se ve cual entiende el
     * protocolo y por que via hay que hablarle.
     */
    @JavascriptInterface
    fun diagnose(deviceId: Int, probeHex: String, timeoutMs: Int): String {
        close()
        val device = findDevice(deviceId)
            ?: return JSONObject().put("error", "dispositivo no encontrado").toString()
        if (!manager.hasPermission(device)) {
            return JSONObject().put("error", "sin permiso de Android").toString()
        }
        val data = hexToBytes(probeHex, REPORT_SIZE)
            ?: return JSONObject().put("error", "sonda invalida").toString()

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

            val inEp = firstEndpoint(iface, UsbConstants.USB_DIR_IN)
            if (iface.interfaceClass != UsbConstants.USB_CLASS_HID || inEp == null) {
                entry.put("skip", "sin interfaz HID utilizable")
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
            settle(conn, iface)

            val outEp = firstEndpoint(iface, UsbConstants.USB_DIR_OUT)
            val tries = JSONArray()
            for (s in intArrayOf(S_BULK_QUEUED, S_REQ_QUEUED, S_BULK_BULK, S_CONTROL_BULK)) {
                if (s != S_CONTROL_BULK && outEp == null) continue
                val reply = exchange(conn, iface.id, inEp, outEp, data, timeoutMs, s)
                tries.put(
                    JSONObject()
                        .put("strategy", s)
                        .put("name", STRATEGY_NAMES[s])
                        .put("reply", if (reply.isEmpty()) "sin respuesta" else reply)
                )
            }
            entry.put("tries", tries)

            conn.releaseInterface(iface)
            conn.close()
            report.put(entry)
        }
        return report.toString()
    }

    /**
     * Escucha cada interfaz sin escribir nada, mientras el usuario pulsa las
     * teclas del macropad. Separa las dos causas posibles de que no llegue
     * respuesta: que nuestras lecturas no funcionen, o que el teclado no
     * conteste a lo que le mandamos.
     */
    @JavascriptInterface
    fun listen(deviceId: Int, msPerInterface: Int): String {
        close()
        val device = findDevice(deviceId)
            ?: return JSONObject().put("error", "dispositivo no encontrado").toString()
        if (!manager.hasPermission(device)) {
            return JSONObject().put("error", "sin permiso de Android").toString()
        }

        val report = JSONArray()
        for (i in 0 until device.interfaceCount) {
            val iface = device.getInterface(i)
            val inEp = firstEndpoint(iface, UsbConstants.USB_DIR_IN)
            if (iface.interfaceClass != UsbConstants.USB_CLASS_HID || inEp == null) continue

            val entry = JSONObject().put("index", i)
            val conn = manager.openDevice(device)
            if (conn == null) {
                entry.put("error", "no se pudo abrir")
                report.put(entry)
                continue
            }
            if (!conn.claimInterface(iface, true)) {
                entry.put("error", "no se pudo reclamar")
                conn.close()
                report.put(entry)
                continue
            }
            settle(conn, iface)

            val size = maxOf(inEp.maxPacketSize, REPORT_SIZE)
            val half = (msPerInterface / 2).coerceAtLeast(200)

            val buffer = ByteArray(size)
            val n = conn.bulkTransfer(inEp, buffer, size, half)
            entry.put("bulk", if (n > 0) bytesToHex(buffer, n) else "nada")

            val request = UsbRequest()
            var queued = "nada"
            runCatching {
                if (request.initialize(conn, inEp)) {
                    val direct = ByteBuffer.allocateDirect(size)
                    if (request.queue(direct)) {
                        val got = awaitRequest(conn, request, direct, half)
                        if (got.isNotEmpty()) queued = got
                    }
                }
            }
            runCatching { request.close() }
            entry.put("queued", queued)

            conn.releaseInterface(iface)
            conn.close()
            report.put(entry)
        }
        return report.toString()
    }

    /** Descriptores del dispositivo y prueba del canal de control. */
    @JavascriptInterface
    fun descriptors(deviceId: Int): String {
        close()
        val device = findDevice(deviceId)
            ?: return JSONObject().put("error", "dispositivo no encontrado").toString()
        val conn = manager.openDevice(device)
            ?: return JSONObject().put("error", "no se pudo abrir").toString()

        val out = JSONObject()
        runCatching {
            val raw = conn.rawDescriptors
            if (raw != null) out.put("raw", bytesToHex(raw, minOf(raw.size, 200)))
        }

        val probe = ByteArray(18)
        val deviceDesc = conn.controlTransfer(
            DEVICE_IN_REQUEST_TYPE, GET_DESCRIPTOR, DESCRIPTOR_DEVICE, 0, probe, probe.size, 1000
        )
        out.put("control", if (deviceDesc > 0) bytesToHex(probe, deviceDesc) else "fallo ($deviceDesc)")

        val reports = JSONArray()
        for (i in 0 until device.interfaceCount) {
            val iface = device.getInterface(i)
            if (iface.interfaceClass != UsbConstants.USB_CLASS_HID) continue
            conn.claimInterface(iface, true)
            val buf = ByteArray(256)
            val n = conn.controlTransfer(
                INTERFACE_IN_REQUEST_TYPE, GET_DESCRIPTOR, DESCRIPTOR_HID_REPORT,
                iface.id, buf, buf.size, 1000
            )
            reports.put(
                JSONObject()
                    .put("index", i)
                    .put("descriptor", if (n > 0) bytesToHex(buf, n) else "fallo ($n)")
            )
            conn.releaseInterface(iface)
        }
        out.put("reportDescriptors", reports)

        conn.close()
        return out.toString()
    }

    // ---------------------------------------------------------------- interno

    /**
     * Un intercambio completo con la estrategia indicada. Devuelve el
     * hexadecimal de la respuesta, "" si no llego nada, o "ERR:..." si fallo
     * la escritura.
     */
    private fun exchange(
        conn: UsbDeviceConnection, ifaceNumber: Int, inEp: UsbEndpoint, outEp: UsbEndpoint?,
        data: ByteArray, timeoutMs: Int, strategyId: Int
    ): String {
        val size = maxOf(inEp.maxPacketSize, REPORT_SIZE)

        if (strategyId == S_BULK_BULK || strategyId == S_CONTROL_BULK) {
            val sent = if (strategyId == S_BULK_BULK && outEp != null) {
                conn.bulkTransfer(outEp, data, data.size, 1000)
            } else {
                conn.controlTransfer(
                    HID_OUT_REQUEST_TYPE, HID_SET_REPORT, HID_OUTPUT_REPORT,
                    ifaceNumber, data, data.size, 1000
                )
            }
            if (sent < 0) return "ERR:fallo al escribir"
            val buffer = ByteArray(size)
            val n = conn.bulkTransfer(inEp, buffer, size, timeoutMs)
            return if (n > 0) bytesToHex(buffer, n) else ""
        }

        // Estrategias con la lectura encolada antes de escribir.
        if (outEp == null) return "ERR:sin endpoint de salida"
        val read = UsbRequest()
        return try {
            if (!read.initialize(conn, inEp)) return "ERR:no se pudo preparar la lectura"
            val buffer = ByteBuffer.allocateDirect(size)
            if (!read.queue(buffer)) return "ERR:no se pudo encolar la lectura"

            val sent = if (strategyId == S_REQ_QUEUED) {
                writeWithRequest(conn, outEp, data)
            } else {
                conn.bulkTransfer(outEp, data, data.size, 1000)
            }
            if (sent < 0) {
                runCatching { read.cancel() }
                return "ERR:fallo al escribir"
            }
            awaitRequest(conn, read, buffer, timeoutMs)
        } catch (e: Exception) {
            "ERR:${e.javaClass.simpleName}"
        } finally {
            runCatching { read.close() }
        }
    }

    /** Espera a que termine la peticion indicada, ignorando las demas. */
    private fun awaitRequest(
        conn: UsbDeviceConnection, expected: UsbRequest, buffer: ByteBuffer, timeoutMs: Int
    ): String {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            val left = (deadline - System.currentTimeMillis()).coerceAtLeast(1L)
            val done = try {
                conn.requestWait(left)
            } catch (e: Exception) {
                null
            } ?: break
            if (done !== expected) continue
            // Segun la version de Android, queue(ByteBuffer) actualiza la
            // posicion del buffer o no. Si no lo hace, hay que mirar el
            // contenido entero y quedarse con lo que no sea relleno.
            var length = buffer.position()
            if (length <= 0) length = trimmedLength(buffer)
            if (length <= 0) return ""
            val bytes = ByteArray(length)
            buffer.rewind()
            buffer.get(bytes)
            return bytesToHex(bytes, length)
        }
        runCatching { expected.cancel() }
        return ""
    }

    /** Ultimo byte distinto de cero del buffer, para cuando no hay posicion. */
    private fun trimmedLength(buffer: ByteBuffer): Int {
        buffer.rewind()
        var last = 0
        for (i in 0 until buffer.capacity()) {
            if (buffer.get(i).toInt() != 0) last = i + 1
        }
        return last
    }

    private fun writeWithRequest(
        conn: UsbDeviceConnection, out: UsbEndpoint, data: ByteArray
    ): Int {
        val request = UsbRequest()
        return try {
            if (!request.initialize(conn, out)) return -1
            val buffer = ByteBuffer.allocateDirect(data.size)
            buffer.put(data)
            buffer.rewind()
            if (!request.queue(buffer)) return -1
            data.size
        } catch (e: Exception) {
            -1
        } finally {
            // No se cierra aqui: la peticion se resuelve en el requestWait de
            // la lectura, que descarta las que no son suyas.
        }
    }

    /**
     * Da un respiro al firmware tras apartar al driver del sistema y le manda
     * SET_IDLE, que algunos teclados necesitan para empezar a enviar reportes.
     */
    private fun settle(conn: UsbDeviceConnection, iface: UsbInterface) {
        runCatching {
            conn.controlTransfer(HID_OUT_REQUEST_TYPE, HID_SET_IDLE, 0, iface.id, null, 0, 500)
        }
        // Un endpoint que quedo detenido no vuelve a transferir hasta que se
        // le quita esa condicion.
        for (e in 0 until iface.endpointCount) {
            val address = iface.getEndpoint(e).address
            runCatching {
                conn.controlTransfer(
                    ENDPOINT_REQUEST_TYPE, CLEAR_FEATURE, ENDPOINT_HALT, address, null, 0, 500
                )
            }
        }
        runCatching { Thread.sleep(120) }
    }

    private fun firstEndpoint(iface: UsbInterface, direction: Int): UsbEndpoint? {
        for (e in 0 until iface.endpointCount) {
            val ep = iface.getEndpoint(e)
            if (ep.direction == direction) return ep
        }
        return null
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
