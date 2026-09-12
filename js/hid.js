// Transporte WebHID: abre el dispositivo, serializa comandos y espera respuesta.
//
// Formato del protocolo (idéntico al configurador oficial):
//   salida : reporte de 64 bytes con reportId 0 -> [cmd, ...payload, 0...]
//   entrada: reporte de 64 bytes -> [cmd, subcmd, len, offLo, offHi, ...datos]
// Los reportes que empiezan por AA FA son notificaciones de luz no solicitadas.

export const REPORT_SIZE = 64;
export const CMD_DATA = 6;    // comandos de configuracion
export const CMD_IAP = 85;    // actualizacion de firmware (no usado aqui)
export const CMD_ARTERY = 90;

let filtersCache = null;

export async function loadFilters() {
  if (!filtersCache) {
    const res = await fetch('data/devices.json');
    filtersCache = await res.json();
  }
  return filtersCache;
}

export function hidSupported() {
  return typeof navigator !== 'undefined' && 'hid' in navigator;
}

/** Dispositivos ya autorizados por el usuario en una sesion anterior. */
export async function knownDevices() {
  if (!hidSupported()) return [];
  const filters = await loadFilters();
  const all = await navigator.hid.getDevices();
  return all.filter((d) => matches(d, filters));
}

/** Abre el selector nativo del navegador. */
export async function pickDevice() {
  const filters = await loadFilters();
  const picked = await navigator.hid.requestDevice({ filters });
  return picked.filter((d) => matches(d, filters))[0] || picked[0] || null;
}

/**
 * Selector sin filtros: muestra todo lo que el navegador ve por USB.
 * Sirve para distinguir "no hay conexion USB" de "este modelo no esta en la
 * lista de VID/PID conocidos".
 */
export async function pickAnyDevice() {
  const picked = await navigator.hid.requestDevice({ filters: [] });
  return picked[0] || null;
}

/** Describe un dispositivo para poder anadirlo a data/devices.json. */
export function describeDevice(device) {
  const hex = (n) => '0x' + n.toString(16).padStart(4, '0');
  return {
    productName: device.productName || '(sin nombre)',
    vendorId: hex(device.vendorId),
    productId: hex(device.productId),
    collections: (device.collections || []).map(
      (c) => `${hex(c.usagePage)}:${hex(c.usage)}`
    ),
  };
}

export async function isKnown(device) {
  return matches(device, await loadFilters());
}

function matches(device, filters) {
  const cols = device.collections || [];
  return filters.some((f) => {
    if (f.vendorId !== device.vendorId || f.productId !== device.productId) return false;
    // Algunas plataformas no exponen las colecciones; basta con VID/PID.
    if (!cols.length) return true;
    return cols.some((c) => c.usagePage === f.usagePage && c.usage === f.usage);
  });
}

export class Transport {
  constructor(device) {
    this.device = device;
    this.pending = [];       // resolvers esperando un reporte de entrada
    this.buffer = [];        // reportes llegados sin solicitante
    this.queue = Promise.resolve();
    this.lightHandlers = [];
    this._onReport = this._onReport.bind(this);
  }

  get vendorId() { return this.device.vendorId; }
  get productId() { return this.device.productId; }
  get productName() { return this.device.productName || ''; }

  /** "36ae_246d" — clave del archivo de layout. */
  get key() {
    const hex = (n) => n.toString(16).padStart(4, '0');
    return `${hex(this.vendorId)}_${hex(this.productId)}`;
  }

  async open() {
    if (!this.device.opened) await this.device.open();
    this.device.addEventListener('inputreport', this._onReport);
    return this;
  }

  async close() {
    this.device.removeEventListener('inputreport', this._onReport);
    if (this.device.opened) await this.device.close();
  }

  onLight(fn) { this.lightHandlers.push(fn); }

  _onReport(event) {
    const bytes = new Uint8Array(
      event.data.buffer, event.data.byteOffset, event.data.byteLength
    );
    if (bytes[0] === 0xaa && bytes[1] === 0xfa) {
      this.lightHandlers.forEach((fn) => fn(bytes));
      return;
    }
    const waiter = this.pending.shift();
    if (waiter) waiter(bytes);
    else this.buffer.push({ at: Date.now(), bytes });
  }

  /** Encola una operacion; garantiza que no se solapen escrituras. */
  _enqueue(task) {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }

  _frame(cmd, payload) {
    const out = new Uint8Array(REPORT_SIZE);
    out[0] = cmd & 0xff;
    for (let i = 0; i < payload.length && i + 1 < REPORT_SIZE; i++) {
      out[i + 1] = payload[i] & 0xff;
    }
    return out;
  }

  /** Escribe y espera la respuesta del dispositivo. */
  send(cmd, payload = [], timeout = 2000) {
    return this._enqueue(async () => {
      this.pending.length = 0;
      this.buffer.length = 0;
      const reply = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const i = this.pending.indexOf(resolve);
          if (i >= 0) this.pending.splice(i, 1);
          reject(new Error('El dispositivo no respondio a tiempo'));
        }, timeout);
        this.pending.push((bytes) => { clearTimeout(timer); resolve(bytes); });
      });
      await this.device.sendReport(0, this._frame(cmd, payload));
      return reply;
    });
  }

  /** Escribe sin esperar respuesta. */
  write(cmd, payload = []) {
    return this._enqueue(async () => {
      await this.device.sendReport(0, this._frame(cmd, payload));
    });
  }

  /** Pausa dentro de la cola, para dar aire al firmware entre escrituras. */
  pause(ms) {
    return this._enqueue(() => new Promise((r) => setTimeout(r, ms)));
  }
}
