// Teclado simulado. Permite probar toda la interfaz sin hardware: abre la
// pagina con ?demo=1. Responde a los mismos comandos que el firmware real.

import { MACRO_BUFFER } from './protocol.js';

const KEY_SLOTS = 19;   // key_index_max del modelo de 3 teclas + rueda

export class DemoTransport {
  constructor(key = '0816_06a1') {
    this._key = key;
    this.productName = 'k3_n1 (demo)';
    this.vendorId = parseInt(key.slice(0, 4), 16);
    this.productId = parseInt(key.slice(5), 16);

    this.profile = 0;
    this.sleep = 0;
    // teclas[perfil][capa] = Uint8Array(KEY_SLOTS*4)
    this.keys = Array.from({ length: 6 }, () =>
      Array.from({ length: 2 }, () => this._defaultKeys())
    );
    this.colors = new Uint8Array(KEY_SLOTS * 3).fill(0x40);
    this.macros = new Uint8Array(MACRO_BUFFER);
    this.macros.fill(0xff, 0, 64);
    this.light = [1, 0, 2, 3, 1, 0, 1, 0, 40, 255, 255];
  }

  get key() { return this._key; }

  _defaultKeys() {
    const b = new Uint8Array(KEY_SLOTS * 4);
    const set = (i, t, c1, c2, c3) => {
      b[i * 4] = t; b[i * 4 + 1] = c1; b[i * 4 + 2] = c2; b[i * 4 + 3] = c3;
    };
    set(0, 32, 0x08, 7, 0);    // Win + D
    set(1, 32, 0x01, 25, 0);   // Ctrl + V
    set(2, 32, 0x01, 6, 0);    // Ctrl + C
    set(3, 48, 226, 0, 0);     // silencio
    set(4, 48, 234, 0, 0);     // volumen -
    set(5, 48, 233, 0, 0);     // volumen +
    return b;
  }

  async open() { return this; }
  async close() { }
  onLight() { }
  pause(ms) { return new Promise((r) => setTimeout(r, ms)); }

  async write() { }

  async send(cmd, payload = []) {
    await new Promise((r) => setTimeout(r, 4));
    const r = new Uint8Array(64);
    r[0] = cmd;
    const sub = payload[0];
    r[1] = sub;
    const off = (payload[2] || 0) | ((payload[3] || 0) << 8);

    const put = (at, bytes) => bytes.forEach((b, i) => { r[at + i] = b; });

    switch (sub) {
      case 5: {                                   // configuracion general
        r[2] = 16;
        const d = new Uint8Array(38);
        d.set([1, 0, this.productId & 0xff, this.productId >> 8, 0x0a, 0x00]);
        d[6] = 1; d[7] = 1; d[8] = 0; d[9] = 0;
        d[10] = 6; d[11] = this.profile; d[12] = 2; d[13] = 0;
        d[14] = this.sleep & 0xff; d[15] = (this.sleep >> 8) & 0xff;
        put(5, d.subarray(0, 38));
        break;
      }
      case 8: {                                   // leer teclas
        const layer = payload[5] || 0;
        const src = this.keys[this.profile][layer];
        r[2] = 58;
        for (let i = 0; i < 56 && off + i < src.length; i++) r[i + 8] = src[off + i];
        break;
      }
      case 9: {                                   // escribir teclas (bloque)
        const layer = payload[5] || 0;
        const dst = this.keys[this.profile][layer];
        const n = Math.max(0, (payload[1] || 3) - 3);
        for (let i = 0; i < n && off + i < dst.length; i++) dst[off + i] = payload[i + 7];
        break;
      }
      case 16: {                                  // escribir una tecla
        const layer = payload[5] || 0;
        const dst = this.keys[this.profile][layer];
        for (let i = 0; i < 4; i++) dst[off + i] = payload[i + 7];
        break;
      }
      case 19:                                    // leer colores
        r[2] = 58;
        for (let i = 0; i < 56 && off + i < this.colors.length; i++) {
          r[i + 8] = this.colors[off + i];
        }
        break;
      case 18: {                                  // escribir colores (bloque)
        const n = Math.max(0, (payload[1] || 3) - 3);
        for (let i = 0; i < n && off + i < this.colors.length; i++) {
          this.colors[off + i] = payload[i + 7];
        }
        break;
      }
      case 20:                                    // color de una tecla
        for (let i = 0; i < 3; i++) this.colors[off + i] = payload[i + 7];
        break;
      case 10:                                    // leer luz
        put(5, this.light);
        break;
      case 11:                                    // escribir luz
        this.light = payload.slice(4, 15);
        break;
      case 22:                                    // valores por defecto del efecto
        put(5, [1, 0, payload[6], 3, 1, 0, 1, 0, 40, 255, 255]);
        break;
      case 12: {                                  // leer macros
        const n = payload[1] || 56;
        for (let i = 0; i < n && off + i < MACRO_BUFFER; i++) {
          r[i + 8] = this.macros[off + i];
        }
        break;
      }
      case 13: {                                  // escribir macros
        const n = payload[1] || 0;
        for (let i = 0; i < n && off + i < MACRO_BUFFER; i++) {
          this.macros[off + i] = payload[i + 4];
        }
        break;
      }
      case 15:                                    // reset
        if (payload[1] === 4) { this.macros.fill(0); this.macros.fill(0xff, 0, 64); }
        else this.keys = this.keys.map((p) => p.map(() => this._defaultKeys()));
        break;
      case 251:
        this.profile = payload[1];
        break;
      case 252:
        this.sleep = payload[4] | (payload[5] << 8);
        break;
      default:
        break;
    }
    return r;
  }
}
