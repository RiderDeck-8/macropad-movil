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

// Formas de mover un reporte por USB. Cual funciona depende del teclado y del
// telefono, asi que se prueban todas y se recuerda la que conteste.
export const STRATEGIES = [
  { id: 1, name: 'bulk + lectura encolada', needsOut: true },
  { id: 2, name: 'request + lectura encolada', needsOut: true },
  { id: 3, name: 'bulk + bulk', needsOut: true },
  { id: 4, name: 'control + bulk', needsOut: false },
];

export class AndroidTransport {
  constructor(device, interfaceIndex, strategy = 1) {
    this.device = device;
    this.interfaceIndex = interfaceIndex;
    this.strategy = strategy;
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
    const err = window.AndroidHid.open(
      this.device.id, this.interfaceIndex, this.strategy
    );
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

  // Si ninguna contesta con la cabecera esperada, vale cualquiera que conteste
  // algo: el firmware puede enmarcar la respuesta de otra forma.
  let fallback = null;

  for (const iface of candidates) {
    for (const s of STRATEGIES) {
      if (s.needsOut && !iface.hasOut) continue;
      if (onStep) onStep(iface, s);
      const transport = new AndroidTransport(device, iface.index, s.id);
      try {
        await transport.open();
        const reply = await transport.send(6, [5], 1500);
        if (reply[0] === 6 && reply[1] === 5) return transport;
        if (reply.some((b) => b !== 0) && !fallback) {
          fallback = { index: iface.index, strategy: s.id };
        }
        await transport.close();
      } catch {
        try { await transport.close(); } catch { /* seguimos probando */ }
      }
    }
  }

  if (fallback) {
    const transport = new AndroidTransport(device, fallback.index, fallback.strategy);
    await transport.open();
    return transport;
  }
  return null;
}

/**
 * Informe completo: descriptores sobre una conexion limpia y despues los
 * intentos de dialogo con la interfaz propietaria. No toca las interfaces del
 * teclado, porque apartarlas a la fuerza puede tumbar la conexion entera.
 */
export function diagnose() {
  const devices = listDevices();
  if (!devices.length) return { error: 'Android no ve ningun dispositivo USB HID' };
  const out = [];
  for (const device of devices) {
    if (!device.hasPermission) {
      window.AndroidHid.requestPermission(device.id);
      out.push({ device, report: { error: 'falta aceptar el permiso USB; repite el diagnostico' } });
      continue;
    }
    let report;
    let threads;
    try {
      threads = JSON.parse(window.AndroidHid.threadTest(device.id));
    } catch (err) {
      threads = { error: err.message };
    }
    try {
      report = JSON.parse(window.AndroidHid.diagnose(device.id, '0605', 1500));
    } catch (err) {
      report = { error: err.message };
    }
    out.push({ device, report, threads });
  }
  return out;
}

// Algunos telefonos gamer interceptan teclados y ratones USB para mapearlos a
// controles en pantalla. Cuando lo hacen, el sistema entrega un dispositivo
// abierto pero no deja pasar ninguna transferencia.
const BLOCKED =
  'El sistema del telefono no deja pasar trafico USB a este teclado.<br><br>' +
  'Suele ser la capa de perifericos para juegos, que se queda con los teclados ' +
  'y ratones al enchufarlos. En RedMagic se llama <b>Gravity X</b>.<br><br>' +
  '<ol class="steps tight">' +
  '<li>Cierra con la <b>X</b> la tarjeta que sale al enchufar el teclado.</li>' +
  '<li>Busca sus ajustes en <b>Ajustes</b> o en el espacio de juego, y ' +
  'desactiva el mapeo o la deteccion de perifericos.</li>' +
  '<li>Si no aparece, en <b>Ajustes, Aplicaciones</b>, mostrando las del ' +
  'sistema, forzala a detenerse o desactivala.</li>' +
  '<li>Desenchufa y vuelve a enchufar el teclado, y prueba otra vez.</li>' +
  '</ol>' +
  'Tambien vale la pena probar con un concentrador USB en medio: a veces la ' +
  'capa de juegos solo se queda con lo que se enchufa directo.';

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

  // Antes de nada, comprobar que el canal USB deja pasar trafico. Si no, no se
  // insiste: cada intento de tomar interfaces molesta al teclado.
  for (const device of ordered) {
    if (!device.hasPermission) continue;
    const health = window.AndroidHid.health(device.id);
    if (health) throw new Error(BLOCKED);
    break;
  }

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
    const transport = await probe(device, (iface, s) =>
      report(`${label}: interfaz ${iface.index}, ${s.name}...`)
    );
    if (transport) return transport;
    errors.push(`${label}: ninguna interfaz contesto`);
  }
  try { window.AndroidHid.close(); } catch { /* ya cerrado */ }
  throw new Error(
    errors.join('. ') +
    '. Pulsa Diagnostico USB para ver que contesta cada interfaz.'
  );
}
