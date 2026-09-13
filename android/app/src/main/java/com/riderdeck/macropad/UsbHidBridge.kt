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
import java.util.concurrent.Callable
import java.util.concurrent.Executors

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

    /**
     * Hilo propio para todo el trafico USB. WebView llama a estos metodos desde
     * su hilo puente, que no es buen sitio para operaciones bloqueantes largas:
     * una transferencia interrumpida se reporta como error sin mas.
     */
    private val usbExec = Executors.newSingleThreadExecutor { r ->
        Thread(r, "usb-hid").apply { isDaemon = true }
    }

    /**
     * Ejecuta en el hilo USB y nunca deja escapar una excepcion: si una salta
     * dentro de un metodo llamado desde JavaScript, WebView tumba la app
     * entera. Mejor devolver un error legible.
     */
    private fun onUsb(block: () -> String): String = try {
        usbExec.submit(Callable { block() }).get()
    } catch (e: Exception) {
        val cause = e.cause ?: e
        "ERR:${cause.javaClass.simpleName} ${cause.message ?: ""}".trim()
    }

    private fun onUsbUnit(block: () -> Unit) {
        runCatching { usbExec.submit(Callable { block() }).get() }
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
        runCatching { close() }
        usbExec.shutdownNow()
    }

    // ------------------------------------------------------------- enumeracion

    @JavascriptInterface
    fun devices(): String = try {
        devicesImpl()
    } catch (e: Exception) {
        JSONArray().toString()
    }

    private fun devicesImpl(): String {
        val out = JSONArray()
        for (device in manager.deviceList.values) {
            // Solo las interfaces propietarias: las del teclado las usa Android
            // y apartarlas a la fuerza puede tumbar la conexion entera.
            val useful = vendorInterfaces(device)
            val interfaces = JSONArray()
            for (iface in useful) {
                val inEp = firstEndpoint(iface, UsbConstants.USB_DIR_IN) ?: continue
                interfaces.put(
                    JSONObject()
                        .put("index", indexOfInterface(device, iface))
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
    fun requestPermission(deviceId: Int): Boolean = try {
        requestPermissionImpl(deviceId)
    } catch (e: Exception) {
        false
    }

    private fun requestPermissionImpl(deviceId: Int): Boolean {
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

    /**
     * Comprueba si por el canal pasa trafico, con una peticion estandar y sin
     * reclamar ninguna interfaz. Si esto falla no tiene sentido insistir: cada
     * intento de tomar interfaces molesta al teclado y puede tumbarlo.
     */
    @JavascriptInterface
    fun health(deviceId: Int): String = onUsb { healthImpl(deviceId) }

    private fun healthImpl(deviceId: Int): String {
        closeImpl()
        val device = findDevice(deviceId) ?: return "ERR:dispositivo no encontrado"
        if (!manager.hasPermission(device)) return "ERR:sin permiso de Android"
        val conn = manager.openDevice(device) ?: return "ERR:no se pudo abrir el dispositivo"
        val iface = vendorInterfaces(device).firstOrNull()
        return try {
            // Reclamar primero: ademas de dar acceso a los endpoints, despierta
            // al dispositivo si el sistema lo tenia suspendido.
            var claimedHere = false
            if (iface != null) {
                claimedHere = conn.claimInterface(iface, false) || conn.claimInterface(iface, true)
            }
            val probe = ByteArray(18)
            var n = conn.controlTransfer(
                DEVICE_IN_REQUEST_TYPE, GET_DESCRIPTOR, DESCRIPTOR_DEVICE, 0,
                probe, probe.size, 2000
            )
            if (n <= 0) {
                runCatching { Thread.sleep(200) }
                n = conn.controlTransfer(
                    DEVICE_IN_REQUEST_TYPE, GET_DESCRIPTOR, DESCRIPTOR_DEVICE, 0,
                    probe, probe.size, 3000
                )
            }
            if (claimedHere && iface != null) conn.releaseInterface(iface)
            if (n > 0) "" else "ERR:el sistema no deja pasar trafico USB"
        } finally {
            conn.close()
        }
    }

    /**
     * Prueba diferencial: la misma peticion estandar desde tres hilos
     * distintos. Si funciona en unos y en otros no, el problema es donde se
     * ejecuta, no el USB.
     */
    @JavascriptInterface
    fun threadTest(deviceId: Int): String = try {
        threadTestImpl(deviceId)
    } catch (e: Exception) {
        JSONObject().put("error", e.javaClass.simpleName).toString()
    }

    private fun threadTestImpl(deviceId: Int): String {
        close()
        val out = JSONObject()
        val device = findDevice(deviceId)
            ?: return out.put("error", "dispositivo no encontrado").toString()
        if (!manager.hasPermission(device)) {
            return out.put("error", "sin permiso de Android").toString()
        }
        out.put("puente", probeOnce(device))
        out.put("hiloPropio", onUsb { probeOnce(device) })
        var fresh = "no ejecutado"
        val t = Thread { fresh = probeOnce(device) }
        t.start()
        t.join(8000)
        out.put("hiloNuevo", fresh)
        return out.toString()
    }

    /** Abre, pide el descriptor de dispositivo y cierra. Nada mas. */
    private fun probeOnce(device: UsbDevice): String {
        val conn = manager.openDevice(device) ?: return "no abre"
        return try {
            val buf = ByteArray(18)
            val n = conn.controlTransfer(
                DEVICE_IN_REQUEST_TYPE, GET_DESCRIPTOR, DESCRIPTOR_DEVICE, 0, buf, buf.size, 2000
            )
            if (n > 0) "ok " + bytesToHex(buf, n) else "fallo ($n)"
        } catch (e: Exception) {
            "excepcion ${e.javaClass.simpleName}"
        } finally {
            runCatching { conn.close() }
        }
    }

    /**
     * Prueba a fondo, interfaz por interfaz. Para cada una: reclamar, pedir el
     * descriptor comun, escuchar sin escribir nada mientras el usuario pulsa
     * teclas, y solo despues escribir la sonda y volver a escuchar.
     *
     * Escuchar sin escribir es lo que decide: si por la interfaz del teclado
     * llegan bytes al pulsar, la lectura funciona y el fallo esta en el
     * dialogo con la interfaz propietaria. Si no llega nada por ninguna, lo
     * que esta roto es el transporte.
     */
    @JavascriptInterface
    fun deepTest(deviceId: Int, probeHex: String, listenMs: Int): String =
        onUsb { deepTestImpl(deviceId, probeHex, listenMs) }

    private fun deepTestImpl(deviceId: Int, probeHex: String, listenMs: Int): String {
        closeImpl()
        val out = JSONObject()
        val device = findDevice(deviceId)
            ?: return out.put("error", "dispositivo no encontrado").toString()
        if (!manager.hasPermission(device)) {
            return out.put("error", "sin permiso de Android").toString()
        }
        val data = hexToBytes(probeHex, REPORT_SIZE)
            ?: return out.put("error", "sonda invalida").toString()

        val results = JSONArray()
        for (i in 0 until device.interfaceCount) {
            val iface = device.getInterface(i)
            val inEp = firstEndpoint(iface, UsbConstants.USB_DIR_IN)
            val entry = JSONObject()
                .put("iface", iface.id)
                .put("subclass", iface.interfaceSubclass)
            if (iface.interfaceClass != UsbConstants.USB_CLASS_HID || inEp == null) {
                entry.put("skip", "sin interfaz HID utilizable")
                results.put(entry)
                continue
            }

            val conn = manager.openDevice(device)
            if (conn == null) {
                entry.put("error", "no abre")
                results.put(entry)
                continue
            }
            try {
                var how = "normal"
                var ok = conn.claimInterface(iface, false)
                if (!ok) {
                    how = "forzada"
                    ok = conn.claimInterface(iface, true)
                }
                entry.put("claim", if (ok) how else "fallo")
                if (!ok) continue

                // Reactivar la interfaz. Al desenganchar el controlador del
                // sistema, sus endpoints pueden quedar deshabilitados, y esto
                // es lo que los vuelve a poner en marcha.
                entry.put("setInterface", runCatching { conn.setInterface(iface) }.getOrDefault(false))

                val started = System.currentTimeMillis()
                val buf = ByteArray(18)
                val n = conn.controlTransfer(
                    DEVICE_IN_REQUEST_TYPE, GET_DESCRIPTOR, DESCRIPTOR_DEVICE, 0,
                    buf, buf.size, 2000
                )
                entry.put(
                    "control",
                    if (n > 0) "ok" else "fallo $n en ${System.currentTimeMillis() - started}ms"
                )

                // 1. Escuchar sin escribir nada, con los dos mecanismos de
                //    lectura: el sincrono y el asincrono del kernel.
                entry.put("escuchaBulk", readRaw(conn, inEp, listenMs))
                entry.put("escuchaRequest", readRequestRaw(conn, inEp, listenMs))

                // 2. Escribir la sonda y volver a escuchar.
                val outEp = firstEndpoint(iface, UsbConstants.USB_DIR_OUT)
                if (outEp != null) {
                    val sent = conn.bulkTransfer(outEp, data, data.size, 1000)
                    entry.put("escrito", sent)
                    entry.put("respuesta", readRaw(conn, inEp, listenMs))
                } else {
                    val sent = conn.controlTransfer(
                        HID_OUT_REQUEST_TYPE, HID_SET_REPORT, HID_OUTPUT_REPORT,
                        iface.id, data, data.size, 1000
                    )
                    entry.put("escrito", "control $sent")
                    if (sent >= 0) entry.put("respuesta", readRaw(conn, inEp, listenMs))
                }
                conn.releaseInterface(iface)
            } catch (e: Exception) {
                entry.put("error", e.javaClass.simpleName)
            } finally {
                runCatching { conn.close() }
                results.put(entry)
            }
        }
        out.put("interfaces", results)
        return out.toString()
    }

    /** Lo mismo pero por la via asincrona del kernel, que es otra ruta. */
    private fun readRequestRaw(
        conn: UsbDeviceConnection, ep: UsbEndpoint, timeoutMs: Int
    ): String {
        val size = maxOf(ep.maxPacketSize, REPORT_SIZE)
        val request = UsbRequest()
        val started = System.currentTimeMillis()
        return try {
            if (!request.initialize(conn, ep)) return "no inicializa"
            val buffer = ByteBuffer.allocateDirect(size)
            if (!request.queue(buffer)) return "no encola"
            val hex = awaitRequest(conn, request, buffer, timeoutMs)
            val took = System.currentTimeMillis() - started
            if (hex.isEmpty()) "nada en ${took}ms" else "$hex (${took}ms)"
        } catch (e: Exception) {
            "excepcion ${e.javaClass.simpleName}"
        } finally {
            runCatching { request.close() }
        }
    }

    /**
     * Lee del endpoint informando del tiempo empleado. El dato importante es
     * ese: si vuelve al instante, el sistema rechaza la peticion; si tarda lo
     * que dura la espera, es que el dispositivo no envio nada.
     */
    private fun readRaw(conn: UsbDeviceConnection, ep: UsbEndpoint, timeoutMs: Int): String {
        val size = maxOf(ep.maxPacketSize, REPORT_SIZE)
        val buffer = ByteArray(size)
        val started = System.currentTimeMillis()
        val n = conn.bulkTransfer(ep, buffer, size, timeoutMs)
        val took = System.currentTimeMillis() - started
        return when {
            n > 0 -> bytesToHex(buffer, n) + " (${took}ms)"
            n == 0 -> "vacio (${took}ms)"
            else -> "nada, $n en ${took}ms"
        }
    }

    // -------------------------------------------------------------- conexion

    @JavascriptInterface
    fun open(deviceId: Int, interfaceIndex: Int, strategyId: Int): String =
        onUsb { openImpl(deviceId, interfaceIndex, strategyId) }

    private fun openImpl(deviceId: Int, interfaceIndex: Int, strategyId: Int): String {
        closeImpl()
        val device = findDevice(deviceId) ?: return "ERR:dispositivo no encontrado"
        if (!manager.hasPermission(device)) return "ERR:sin permiso de Android"
        if (interfaceIndex >= device.interfaceCount) return "ERR:interfaz inexistente"

        val iface = device.getInterface(interfaceIndex)
        val conn = manager.openDevice(device) ?: return "ERR:no se pudo abrir el dispositivo"
        // Sin forzar primero: apartar al driver del sistema solo si hace falta.
        if (!conn.claimInterface(iface, false) && !conn.claimInterface(iface, true)) {
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

        // Reactiva los endpoints, que pueden haber quedado deshabilitados al
        // desenganchar el controlador del sistema. Si no prospera, se reintenta
        // tras volver a reclamar: es la unica forma de rehabilitarlos.
        if (!runCatching { conn.setInterface(iface) }.getOrDefault(false)) {
            runCatching { conn.releaseInterface(iface) }
            runCatching { conn.claimInterface(iface, true) }
            runCatching { conn.setInterface(iface) }
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
    fun close() = onUsbUnit { closeImpl() }

    private fun closeImpl() {
        claimed?.let { connection?.releaseInterface(it) }
        connection?.close()
        connection = null
        claimed = null
        endpointIn = null
        endpointOut = null
    }

    @JavascriptInterface
    fun isOpen(): Boolean = runCatching { connection != null }.getOrDefault(false)

    // ------------------------------------------------------------ transferencia

    /** Escribe y espera respuesta. Devuelve el hexadecimal o "ERR:...". */
    @JavascriptInterface
    fun transfer(hex: String, timeoutMs: Int): String =
        onUsb { transferImpl(hex, timeoutMs) }

    private fun transferImpl(hex: String, timeoutMs: Int): String {
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
    fun write(hex: String): String = onUsb { writeImpl(hex) }

    private fun writeImpl(hex: String): String {
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
     * Interfaces candidatas: solo las de proposito propietario. Las de
     * subclase 1 son el teclado y la parte multimedia que Android esta usando,
     * y apartarlas a la fuerza puede provocar que el dispositivo se reinicie y
     * deje la conexion muerta.
     */
    private fun vendorInterfaces(device: UsbDevice): List<UsbInterface> {
        val out = mutableListOf<UsbInterface>()
        for (i in 0 until device.interfaceCount) {
            val iface = device.getInterface(i)
            if (iface.interfaceClass != UsbConstants.USB_CLASS_HID) continue
            if (iface.interfaceSubclass != 0) continue
            if (firstEndpoint(iface, UsbConstants.USB_DIR_IN) == null) continue
            out.add(iface)
        }
        return out
    }

    /**
     * Informe completo y en el orden correcto: primero los descriptores sobre
     * una conexion limpia y sin reclamar nada, despues los intentos de dialogo
     * sobre la interfaz propietaria.
     */
    @JavascriptInterface
    fun diagnose(deviceId: Int, probeHex: String, timeoutMs: Int): String =
        onUsb { diagnoseImpl(deviceId, probeHex, timeoutMs) }

    private fun diagnoseImpl(deviceId: Int, probeHex: String, timeoutMs: Int): String {
        closeImpl()
        val out = JSONObject()
        val device = findDevice(deviceId)
            ?: return out.put("error", "dispositivo no encontrado").toString()
        if (!manager.hasPermission(device)) {
            return out.put("error", "sin permiso de Android").toString()
        }
        val data = hexToBytes(probeHex, REPORT_SIZE)
            ?: return out.put("error", "sonda invalida").toString()

        out.put("android", Build.VERSION.RELEASE)
        out.put("modelo", "${Build.MANUFACTURER} ${Build.MODEL}")
        out.put("dispositivos", manager.deviceList.size)
        out.put("deviceId", device.deviceId)

        val conn = manager.openDevice(device)
            ?: return out.put("error", "no se pudo abrir el dispositivo").toString()
        out.put("fd", conn.fileDescriptor)
        runCatching { out.put("serie", conn.serial ?: "sin serie") }
        runCatching {
            val raw = conn.rawDescriptors
            if (raw != null) out.put("raw", bytesToHex(raw, minOf(raw.size, 200)))
        }

        // Peticion estandar, sin reclamar nada: dice si el canal de control vive.
        // El -1 de Android tapa igual un error inmediato que una espera agotada,
        // asi que se reintenta con mas margen antes de dar nada por perdido.
        val probe = ByteArray(18)
        var n = conn.controlTransfer(
            DEVICE_IN_REQUEST_TYPE, GET_DESCRIPTOR, DESCRIPTOR_DEVICE, 0, probe, probe.size, 1000
        )
        if (n <= 0) {
            runCatching { Thread.sleep(300) }
            n = conn.controlTransfer(
                DEVICE_IN_REQUEST_TYPE, GET_DESCRIPTOR, DESCRIPTOR_DEVICE, 0,
                probe, probe.size, 4000
            )
            out.put("controlReintento", true)
        }
        out.put("control", if (n > 0) bytesToHex(probe, n) else "fallo ($n)")

        // Seleccionar la configuracion explicitamente desencalla algunos casos.
        runCatching {
            val cfg = device.getConfiguration(0)
            out.put("setConfig", conn.setConfiguration(cfg))
        }

        val candidates = vendorInterfaces(device)
        out.put("vendorInterfaces", JSONArray(candidates.map { it.id }))
        if (candidates.isEmpty()) {
            out.put("error", "el teclado no expone una interfaz propietaria")
            conn.close()
            return out.toString()
        }

        val attempts = JSONArray()
        for (iface in candidates) {
            val inEp = firstEndpoint(iface, UsbConstants.USB_DIR_IN)!!
            val outEp = firstEndpoint(iface, UsbConstants.USB_DIR_OUT)

            // Primero sin forzar: si el sistema no la tiene tomada, mejor no
            // apartar a nadie.
            var how = "normal"
            var ok = conn.claimInterface(iface, false)
            if (!ok) {
                how = "forzada"
                ok = conn.claimInterface(iface, true)
            }
            val entry = JSONObject().put("iface", iface.id).put("claim", if (ok) how else "fallo")
            if (!ok) {
                attempts.put(entry)
                continue
            }

            // Repetir la peticion estandar ya con la interfaz reclamada. Es
            // distinto: reclamar despierta al dispositivo si el sistema lo
            // habia dormido, y antes de eso ep0 puede no contestar.
            val after = ByteArray(18)
            val an = conn.controlTransfer(
                DEVICE_IN_REQUEST_TYPE, GET_DESCRIPTOR, DESCRIPTOR_DEVICE, 0,
                after, after.size, 2000
            )
            entry.put("controlTrasTomar", if (an > 0) bytesToHex(after, an) else "fallo ($an)")

            settle(conn, iface)

            // El descriptor de reporte dice si se usan identificadores, que
            // cambiarian el primer byte de cada paquete.
            val rd = ByteArray(256)
            val rdLen = conn.controlTransfer(
                INTERFACE_IN_REQUEST_TYPE, GET_DESCRIPTOR, DESCRIPTOR_HID_REPORT,
                iface.id, rd, rd.size, 1000
            )
            entry.put("reportDescriptor", if (rdLen > 0) bytesToHex(rd, rdLen) else "fallo ($rdLen)")

            val tries = JSONArray()
            for (s in intArrayOf(S_BULK_QUEUED, S_REQ_QUEUED, S_BULK_BULK, S_CONTROL_BULK)) {
                if (s != S_CONTROL_BULK && outEp == null) continue
                val reply = exchange(conn, iface.id, inEp, outEp, data, timeoutMs, s)
                tries.put(
                    JSONObject()
                        .put("name", STRATEGY_NAMES[s])
                        .put("reply", if (reply.isEmpty()) "sin respuesta" else reply)
                )
            }
            entry.put("tries", tries)
            conn.releaseInterface(iface)
            attempts.put(entry)
        }
        out.put("attempts", attempts)
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

    private fun indexOfInterface(device: UsbDevice, iface: UsbInterface): Int {
        for (i in 0 until device.interfaceCount) {
            if (device.getInterface(i) === iface) return i
        }
        return 0
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
