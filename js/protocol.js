// Capa de protocolo: todos los comandos del teclado sobre el transporte WebHID.
// Cada metodo replica byte a byte lo que envia el configurador oficial.

import { CMD_DATA } from './hid.js';

const lo = (n) => n & 0xff;
const hi = (n) => (n >> 8) & 0xff;
const le16 = (a, b) => (b << 8) | a;

export const KeyType = {
  MOUSE_BUTTON: 16,
  MOUSE_MOVE: 17,
  DISABLED: 19,
  LIGHT: 31,
  KEYBOARD: 32,
  COMBO: 33,
  MEDIA: 48,
  SYSTEM: 64,
  MACRO: 96,
  PROFILE: 112,
  WEBSITE: 128,
  CUSTOM: 255,
};

export const MACRO_SLOTS = 16;
export const MACRO_BUFFER = 4096;

export class Keyboard {
  constructor(transport) {
    this.t = transport;
  }

  get productName() { return this.t.productName; }
  get key() { return this.t.key; }

  // ---------------------------------------------------------------- estado

  async getConfig() {
    const r = await this.t.send(CMD_DATA, [5]);
    const len = r[2];
    const d = r.slice(5, 43);
    let serial = '';
    if (len >= 40) {
      serial = Array.from(r.slice(21, 43))
        .filter((c) => c !== 0)
        .map((c) => String.fromCharCode(c))
        .join('');
    }
    return {
      version: le16(d[0], d[1]),
      pid: le16(d[2], d[3]),
      firmware: le16(d[4], d[5]),
      workMode: d[6],
      linkStatus: d[7],
      battery: d[8],
      charge: d[9],
      profileCount: d[10] || 1,
      profile: d[11],
      layerCount: d[12] || 1,
      layer: d[13],
      autoSleepTime: len >= 16 ? le16(d[14], d[15]) : 0,
      serial,
    };
  }

  setProfile(index) {
    return this.t.send(CMD_DATA, [251, index]);
  }

  setAutoSleep(seconds) {
    return this.t.send(CMD_DATA, [252, 2, 0, 0, lo(seconds), hi(seconds)]);
  }

  factoryReset() {
    return this.t.send(CMD_DATA, [15, 255]);
  }

  // ------------------------------------------------------- asignacion de teclas

  /** Lee [type, code1, code2, code3] por tecla para una capa. */
  async readKeys(keyCount, layer) {
    const total = keyCount * 4;
    const out = new Uint8Array(total);
    for (let off = 0; off < total; off += 56) {
      const r = await this.t.send(CMD_DATA, [8, 58, lo(off), hi(off), 0, layer, 0]);
      const n = Math.min(56, total - off);
      for (let i = 0; i < n; i++) out[off + i] = r[i + 8] ?? 0;
    }
    const keys = [];
    for (let i = 0; i < keyCount; i++) {
      keys.push({
        type: out[i * 4],
        code1: out[i * 4 + 1],
        code2: out[i * 4 + 2],
        code3: out[i * 4 + 3],
      });
    }
    return keys;
  }

  /** Escribe una sola tecla (lo que hace la app oficial al tocar una tecla). */
  writeKey(keyIndex, layer, { type, code1 = 0, code2 = 0, code3 = 0 }) {
    const off = keyIndex * 4;
    return this.t.send(CMD_DATA, [
      16, 7, lo(off), hi(off), 0, layer, 0, type, code1, code2, code3,
    ]);
  }

  /** Escribe todas las teclas de una capa de golpe (usado al importar). */
  async writeKeys(keys, layer) {
    const total = keys.length * 4;
    const flat = new Uint8Array(total);
    keys.forEach((k, i) => {
      flat[i * 4] = k.type;
      flat[i * 4 + 1] = k.code1;
      flat[i * 4 + 2] = k.code2;
      flat[i * 4 + 3] = k.code3;
    });
    for (let off = 0; off < total; off += 56) {
      const n = Math.min(56, total - off);
      const payload = new Array(63).fill(0);
      payload[0] = 9;
      payload[1] = n + 3;
      payload[2] = lo(off);
      payload[3] = hi(off);
      payload[5] = layer;
      for (let i = 0; i < n; i++) payload[i + 7] = flat[off + i];
      await this.t.send(CMD_DATA, payload);
    }
  }

  // ------------------------------------------------------------ color por tecla

  async readColors(keyCount) {
    const total = keyCount * 3;
    const out = new Uint8Array(total);
    for (let off = 0; off < total; off += 56) {
      const r = await this.t.send(CMD_DATA, [19, 58, lo(off), hi(off)]);
      const n = Math.min(56, total - off);
      for (let i = 0; i < n; i++) out[off + i] = r[i + 8] ?? 0;
    }
    const colors = [];
    for (let i = 0; i < keyCount; i++) {
      colors.push([out[i * 3], out[i * 3 + 1], out[i * 3 + 2]]);
    }
    return colors;
  }

  writeColor(keyIndex, [r, g, b]) {
    const off = keyIndex * 3;
    return this.t.send(CMD_DATA, [20, 3, lo(off), hi(off), 0, 0, 0, r, g, b]);
  }

  async writeColors(colors) {
    const total = colors.length * 3;
    const flat = new Uint8Array(total);
    colors.forEach(([r, g, b], i) => {
      flat[i * 3] = r; flat[i * 3 + 1] = g; flat[i * 3 + 2] = b;
    });
    for (let off = 0; off < total; off += 56) {
      const n = Math.min(56, total - off);
      const payload = new Array(63).fill(0);
      payload[0] = 18;
      payload[1] = n + 3;
      payload[2] = lo(off);
      payload[3] = hi(off);
      for (let i = 0; i < n; i++) payload[i + 7] = flat[off + i];
      await this.t.send(CMD_DATA, payload);
    }
  }

  // --------------------------------------------------------------------- luz

  async getLight() {
    const r = await this.t.send(CMD_DATA, [10]);
    const d = r.slice(5, 16);
    return {
      type: d[0], mode: d[2], brightness: d[3], speed: d[4],
      direction: d[5], color: d[6], singleColorIndex: d[7],
      h: d[8], s: d[9], v: d[10],
    };
  }

  setLight(cfg) {
    const d = [
      cfg.type ?? 1, 0, cfg.mode, cfg.brightness, cfg.speed,
      cfg.direction, cfg.mode === 0 ? 0 : cfg.color, 0,
      cfg.h, cfg.s, cfg.v,
    ];
    return this.t.send(CMD_DATA, [11, d.length, 0, 0, ...d]);
  }

  /** Pide al firmware los valores por defecto de un efecto y los aplica. */
  async applyEffect(mode) {
    const r = await this.t.send(CMD_DATA, [22, 0, 0, 0, 1, 0, mode]);
    const d = Array.from(r.slice(5, 16));
    d[2] = mode;
    await this.t.send(CMD_DATA, [11, d.length, 0, 0, ...d]);
    return {
      type: d[0], mode, brightness: d[3], speed: d[4], direction: d[5],
      color: d[6], singleColorIndex: d[7], h: d[8], s: d[9], v: d[10],
    };
  }

  // ------------------------------------------------------------------ macros

  async readMacroBuffer() {
    const out = new Uint8Array(MACRO_BUFFER);
    for (let off = 0; off < MACRO_BUFFER; off += 56) {
      const n = Math.min(MACRO_BUFFER - off, 56);
      const r = await this.t.send(CMD_DATA, [12, n, lo(off), hi(off)]);
      for (let i = 0; i < n; i++) out[off + i] = r[i + 8] ?? 0;
    }
    return out;
  }

  async writeMacroBuffer(bytes) {
    for (let off = 0; off < bytes.length; off += 59) {
      const chunk = Array.from(bytes.slice(off, Math.min(off + 59, bytes.length)));
      await this.t.send(CMD_DATA, [13, chunk.length, lo(off), hi(off), ...chunk]);
    }
  }

  resetMacros() {
    return this.t.send(CMD_DATA, [15, 4]);
  }
}
