// Codificacion del buffer de macros (4096 bytes).
//
//   0..31   : puntero de 16 bits (LE) por cada una de las 16 macros
//   32..63  : relleno 0xFF
//   64..    : eventos de 4 bytes -> [retardoLo, retardoHi, flags, codigo]
//
// flags: bit7 = ultimo evento, bit6 = pulsar (si no, soltar),
//        bits0-5 = tipo -> 3 boton de raton, 2 tecla, 4 rueda vertical,
//                          5 rueda horizontal

import { MACRO_SLOTS, MACRO_BUFFER } from './protocol.js';
import { hidKeyName } from './catalog.js';

export const EV_MOUSE = 1;
export const EV_KEY = 2;
export const EV_WHEEL_V = 3;
export const EV_WHEEL_H = 4;

export const MOUSE_CODES = {
  1: 'Clic izquierdo', 2: 'Clic derecho', 4: 'Clic central',
  8: 'Atras', 16: 'Adelante',
};

export function decodeMacros(bytes) {
  const macros = [];
  for (let i = 0; i < MACRO_SLOTS; i++) {
    const slot = { name: 'M' + i, events: [] };
    const lo = bytes[2 * i], hi = bytes[2 * i + 1];
    let ptr = (hi << 8) | lo;
    if ((lo === 0xff && hi === 0xff) || lo === 0 || ptr > MACRO_BUFFER) {
      macros.push(slot);
      continue;
    }
    let guard = 0;
    while (guard++ < 512 && ptr + 3 < MACRO_BUFFER) {
      const delay = (bytes[ptr + 1] << 8) | bytes[ptr];
      const flags = bytes[ptr + 2];
      const code = bytes[ptr + 3];
      const raw = flags & 63;
      let type = EV_MOUSE;
      if (raw === 2) type = EV_KEY;
      else if (raw === 4) type = EV_WHEEL_V;
      else if (raw === 5) type = EV_WHEEL_H;
      slot.events.push({
        type, code, delay,
        action: (flags >> 6) & 1 ? 1 : 2,   // 1 pulsar, 2 soltar
      });
      ptr += 4;
      if ((flags >> 7) & 1 || flags === 0) break;
    }
    macros.push(slot);
  }
  return macros;
}

export function encodeMacros(macros) {
  const out = new Uint8Array(MACRO_BUFFER);
  out.fill(0xff, 0, 64);
  out.fill(0, 64);
  let ptr = 64;
  macros.slice(0, MACRO_SLOTS).forEach((m, i) => {
    if (!m.events.length) return;
    out[2 * i] = ptr & 0xff;
    out[2 * i + 1] = (ptr >> 8) & 0xff;
    m.events.forEach((ev, j) => {
      let flags = 0;
      if (ev.action === 1) flags |= 64;
      if (ev.type === EV_MOUSE) flags |= 3;
      if (ev.type === EV_KEY) flags |= 2;
      if (ev.type === EV_WHEEL_V) flags |= 4;
      if (ev.type === EV_WHEEL_H) flags |= 5;
      if (j === m.events.length - 1) flags |= 128;
      const delay = Math.max(0, Math.min(65535, ev.delay || 0));
      out[ptr + 4 * j] = delay & 0xff;
      out[ptr + 4 * j + 1] = (delay >> 8) & 0xff;
      out[ptr + 4 * j + 2] = flags;
      out[ptr + 4 * j + 3] = ev.code & 0xff;
    });
    ptr += 4 * m.events.length;
  });
  return out;
}

export function eventLabel(ev) {
  const verb = ev.action === 1 ? 'pulsar' : 'soltar';
  if (ev.type === EV_KEY) return `${verb} ${hidKeyName(ev.code)}`;
  if (ev.type === EV_MOUSE) return `${verb} ${MOUSE_CODES[ev.code] || 'raton ' + ev.code}`;
  if (ev.type === EV_WHEEL_V) return ev.code === 1 ? 'rueda arriba' : 'rueda abajo';
  if (ev.type === EV_WHEEL_H) return ev.code === 1 ? 'rueda derecha' : 'rueda izquierda';
  return 'evento';
}

/** Espacio libre del buffer con la lista actual. */
export function usedBytes(macros) {
  return macros.reduce((n, m) => n + 4 * m.events.length, 0);
}

export const MACRO_CAPACITY = MACRO_BUFFER - 64;
