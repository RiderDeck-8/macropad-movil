// Transporte alternativo para la aplicacion Android.
//
// Cuando la pagina corre dentro de la carcasa nativa existe `window.AndroidHid`,
// un puente que habla USB con la API de Android. Eso funciona aunque el sistema
// este usando el teclado, que es justo donde WebHID de Chrome para Android
// todavia no llega.
//
// Las llamadas al puente son sincronas, pero cada transferencia dura pocos
// milisegundos, asi que no se nota. Los datos viajan en hexadecimal.

import { REPORT_SIZE } from './hid.js';
import { loadFilters } from './hid.js';

export function androidShell() {
  return typeof window !== 'undefined' && typeof window.AndroidHid !== 'undefined';
}

const hex = (bytes) =>
  Array.from(bytes).map((b) => (b & 0xff).toString(16).padStart(2, '0')).join('');

function unhex(text) {
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(text.substr(i * 2, 2), 16);
  }
  return out;
}

export function listDevices() {
  try {
    return JSON.parse(window.AndroidHid.devices());
  } catch {
    return [];
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Pide el permiso de Android y espera a que el usuario conteste. */
export async function ensurePermission(device, onWaiting) {
  if (device.hasPermission) return true;
  window.AndroidHid.requestPermission(device.id);
  if (onWaiting) onWaiting();
  for (let i = 0; i < 60; i++) {
    await wait(500);
    const again = listDevices().find((d) => d.id === device.id);
    if (!again) return false;
    if (again.hasPermission) return true;
  }
  return false;
}

export class AndroidTransport {
  constructor(device, interfaceIndex) {
    this.device = device;
    this.interfaceIndex = interfaceIndex;
    this.vendorId = device.vendorId;
    this.productId = device.productId;
    this.productName = device.name || '';
    this.queue = Promise.resolve();
    this.lightHandlers = [];
  }

  get key() {
    const h = (n) => n.toString(16).padStart(4, '0');
    return `${h(this.vendorId)}_${h(this.productId)}`;
  }

  async open() {
    const err = window.AndroidHid.open(this.device.id, this.interfaceIndex);
    if (err) throw new Error(err.replace(/^ERR:/, ''));
    return this;
  }

  async close() {
    window.AndroidHid.close();
  }

  onLight(fn) { this.lightHandlers.push(fn); }

  _enqueue(task) {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }

  _frameHex(cmd, payload) {
    const out = new Uint8Array(REPORT_SIZE);
    out[0] = cmd & 0xff;
    for (let i = 0; i < payload.length && i + 1 < REPORT_SIZE; i++) {
      out[i + 1] = payload[i] & 0xff;
    }
    return hex(out);
  }

  send(cmd, payload = [], timeout = 1200) {
    return this._enqueue(async () => {
      const reply = window.AndroidHid.transfer(this._frameHex(cmd, payload), timeout);
      if (reply.startsWith('ERR:')) throw new Error(reply.slice(4));
      if (!reply) throw new Error('el teclado no respondio');
      // Devuelve el control al navegador para que la interfaz siga viva.
      await wait(0);
      return unhex(reply);
    });
  }

  write(cmd, payload = []) {
    return this._enqueue(async () => {
      const err = window.AndroidHid.write(this._frameHex(cmd, payload));
      if (err) throw new Error(err.replace(/^ERR:/, ''));
    });
  }

  pause(ms) {
    return this._enqueue(() => wait(ms));
  }
}

/**
 * Elige interfaz por prueba: le pregunta la configuracion y se queda con la
 * primera que contesta algo con sentido. Estos teclados exponen varias
 * interfaces HID y solo una entiende el protocolo.
 */
async function probe(device, onStep) {
  const candidates = [...device.interfaces].sort((a, b) => {
    // La interfaz de configuracion no es la del teclado de arranque y suele
    // mover paquetes de 64 bytes.
    const score = (i) => (i.subclass === 0 ? 0 : 1) + (i.packetSize === 64 ? 0 : 2);
    return score(a) - score(b);
  });

  for (const iface of candidates) {
    if (onStep) onStep(iface);
    const transport = new AndroidTransport(device, iface.index);
    try {
      await transport.open();
      const reply = await transport.send(6, [5], 800);
      if (reply[0] === 6 && reply[1] === 5) return transport;
      await transport.close();
    } catch {
      try { await transport.close(); } catch { /* seguimos probando */ }
    }
  }
  return null;
}

/**
 * Busca el teclado, pide permiso y devuelve un transporte listo.
 * `report` recibe mensajes para mostrar en pantalla.
 */
export async function connectAndroid(report = () => {}) {
  const filters = await loadFilters();
  const devices = listDevices();
  if (!devices.length) {
    throw new Error(
      'Android no ve ningun dispositivo USB con interfaz HID. Revisa el cable ' +
      'y el adaptador OTG.'
    );
  }

  const isKnown = (d) =>
    filters.some((f) => f.vendorId === d.vendorId && f.productId === d.productId);
  const ordered = [...devices].sort((a, b) => Number(isKnown(b)) - Number(isKnown(a)));
  const errors = [];

  for (const device of ordered) {
    const label = `${device.name} (${device.vendorId.toString(16)}:${device.productId.toString(16)})`;
    report(`Probando ${label}...`);
    const granted = await ensurePermission(device, () =>
      report(`Acepta el permiso USB que pide Android para ${label}.`)
    );
    if (!granted) {
      errors.push(`${label}: permiso denegado`);
      continue;
    }
    const transport = await probe(device);
    if (transport) return transport;
    errors.push(`${label}: no responde al protocolo`);
  }
  throw new Error(
    'Ninguno de los dispositivos conectados respondio. ' + errors.join('. ')
  );
}
