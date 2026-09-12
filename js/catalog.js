// Catalogo de teclas, textos traducidos y layouts de dispositivo.

import { KeyType } from './protocol.js';

let data = null;      // { flat, palettes }
let strings = {};     // langid -> texto
let lang = 'es';

export async function loadCatalog(preferred = 'es') {
  if (!data) {
    const res = await fetch('data/keycodes.json');
    data = await res.json();
  }
  lang = preferred;
  try {
    const res = await fetch(`data/i18n/${lang}.json`);
    strings = await res.json();
  } catch {
    strings = {};
  }
  if (lang !== 'en') {
    try {
      const res = await fetch('data/i18n/en.json');
      const en = await res.json();
      strings = { ...en, ...strings };
    } catch { /* sin respaldo */ }
  }
  return data;
}

/** Texto de un langid; devuelve el respaldo si falta o dice "None". */
export function t(langid, fallback = '') {
  const v = strings[String(langid)];
  if (!v || v === 'None') return fallback;
  return v;
}

export function label(entry) {
  return t(entry.langid, entry.name || '').replace(/\n/g, ' ');
}

/** Categorias de teclas para un layout (segun su campo customkey). */
export function paletteFor(layout) {
  const ck = layout && layout.customkey;
  return (ck && data.palettes[ck]) || data.palettes._default;
}

export async function loadLayout(key) {
  const res = await fetch(`data/layouts/${key}.json`);
  if (!res.ok) throw new Error(`Sin layout para ${key}`);
  return res.json();
}

const MOD_BITS = [
  [0x01, 'LCtrl'], [0x08, 'LWin'], [0x04, 'LAlt'], [0x02, 'LShift'],
  [0x10, 'RCtrl'], [0x40, 'RAlt'], [0x20, 'RShift'], [0x80, 'RWin'],
];

/** Nombre legible de una asignacion, igual que en la app oficial. */
export function describe(type, c1, c2, c3) {
  const flat = data.flat;
  if (type === 0 || type === KeyType.DISABLED) return 'Desactivada';
  if (type === KeyType.KEYBOARD) {
    const base = flat.find((k) => k.type === KeyType.KEYBOARD && k.value2 === c2);
    const parts = MOD_BITS.filter(([bit]) => c1 & bit).map(([, n]) => n);
    const name = base ? label(base) : '';
    return [...parts, name].filter(Boolean).join(' + ') || '—';
  }
  if (type === KeyType.MACRO) return 'M' + c1;
  if (type === KeyType.PROFILE) {
    if (c1 === 255) return t('70007', 'Rueda abajo');
    if (c1 === 1) return t('70006', 'Rueda arriba');
    return '—';
  }
  if (type === KeyType.MOUSE_MOVE) {
    const e = flat.find((k) => k.type === KeyType.MOUSE_MOVE);
    return e ? label(e) : 'Mover cursor';
  }
  if (type === KeyType.WEBSITE) return t('30000', 'Abrir web');
  const e = flat.find(
    (k) => k.type === type && k.value1 === c1 && k.value2 === c2 && k.value3 === c3
  );
  if (e) return label(e);
  return `0x${type.toString(16)} ${c1},${c2},${c3}`;
}

/** Codificacion de "mover cursor" (misma que el configurador oficial). */
export function encodeCursor({ up = 0, down = 0, left = 0, right = 0 }) {
  let code1 = 0, code2 = 0, code3 = 0;
  const clamp = (n) => Math.max(0, Math.min(255, Math.round(n)));
  if (up) { code3 = clamp(up); code1 |= 0x08; }
  else if (down) { code3 = clamp(down); }
  if (left) { code2 = clamp(left); code1 |= 0x80; }
  else if (right) { code2 = clamp(right); }
  return { type: KeyType.MOUSE_MOVE, code1, code2, code3 };
}

export function decodeCursor(c1, c2, c3) {
  const horiz = c2, vert = c3;
  return {
    left: c1 & 0x80 ? horiz : 0,
    right: c1 & 0x80 ? 0 : horiz,
    up: c1 & 0x08 ? vert : 0,
    down: c1 & 0x08 ? 0 : vert,
  };
}

/** Tabla codigo-de-tecla-del-navegador -> uso HID, para grabar macros. */
export const BROWSER_TO_HID = {
  Digit1: 30, Digit2: 31, Digit3: 32, Digit4: 33, Digit5: 34, Digit6: 35,
  Digit7: 36, Digit8: 37, Digit9: 38, Digit0: 39,
  KeyA: 4, KeyB: 5, KeyC: 6, KeyD: 7, KeyE: 8, KeyF: 9, KeyG: 10, KeyH: 11,
  KeyI: 12, KeyJ: 13, KeyK: 14, KeyL: 15, KeyM: 16, KeyN: 17, KeyO: 18,
  KeyP: 19, KeyQ: 20, KeyR: 21, KeyS: 22, KeyT: 23, KeyU: 24, KeyV: 25,
  KeyW: 26, KeyX: 27, KeyY: 28, KeyZ: 29,
  Comma: 54, Period: 55, Semicolon: 51, Quote: 52, BracketLeft: 47,
  BracketRight: 48, Backspace: 42, Backquote: 53, Slash: 56, Backslash: 49,
  Minus: 45, Equal: 46, IntlRo: 135, IntlYen: 137,
  AltLeft: 226, AltRight: 230, CapsLock: 57, ControlLeft: 224,
  ControlRight: 228, MetaLeft: 227, MetaRight: 231, ShiftLeft: 225,
  ShiftRight: 229, ContextMenu: 101, Enter: 40, Space: 44, Tab: 43,
  Delete: 76, End: 77, Home: 74, Insert: 73, PageDown: 78, PageUp: 75,
  ArrowDown: 81, ArrowLeft: 80, ArrowRight: 79, ArrowUp: 82, Escape: 41,
  PrintScreen: 70, ScrollLock: 71, Pause: 72,
  F1: 58, F2: 59, F3: 60, F4: 61, F5: 62, F6: 63, F7: 64, F8: 65, F9: 66,
  F10: 67, F11: 68, F12: 69,
  NumLock: 83, Numpad0: 98, Numpad1: 89, Numpad2: 90, Numpad3: 91,
  Numpad4: 92, Numpad5: 93, Numpad6: 94, Numpad7: 95, Numpad8: 96,
  Numpad9: 97, NumpadAdd: 87, NumpadDecimal: 99, NumpadDivide: 84,
  NumpadEnter: 88, NumpadMultiply: 85, NumpadSubtract: 86,
};

const HID_TO_NAME = {};
export function hidKeyName(code) {
  if (!Object.keys(HID_TO_NAME).length) {
    for (const [k, v] of Object.entries(BROWSER_TO_HID)) {
      if (!(v in HID_TO_NAME)) HID_TO_NAME[v] = k.replace(/^(Key|Digit)/, '');
    }
    if (data) {
      for (const e of data.flat) {
        if (e.type === KeyType.KEYBOARD && e.value1 === 0 && e.value2) {
          HID_TO_NAME[e.value2] = label(e).replace(/\n/g, ' ') || HID_TO_NAME[e.value2];
        }
      }
    }
  }
  return HID_TO_NAME[code] || `0x${code.toString(16)}`;
}
