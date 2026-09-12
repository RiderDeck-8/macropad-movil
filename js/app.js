import * as HID from './hid.js';
import { Keyboard, KeyType } from './protocol.js';
import * as Cat from './catalog.js';
import * as Mac from './macros.js';
import { DemoTransport } from './demo.js';
import { androidShell, connectAndroid, diagnose } from './android.js';

const $ = (id) => document.getElementById(id);
const DEMO = new URLSearchParams(location.search).has('demo');

const state = {
  transport: null,
  kb: null,
  layout: null,
  config: null,
  keys: [],        // { type, code1, code2, code3 } por indice fisico
  colors: [],      // [r,g,b] por indice fisico
  macros: [],
  macrosLoaded: false,
  light: null,
  profile: 0,
  layer: 0,
  selectedKey: -1,
  selectedMacro: 0,
  recording: false,
};

// ---------------------------------------------------------------- utilidades

let toastTimer;
function toast(msg, bad = false) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('bad', bad);
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}

async function guard(fn, what = 'la operacion') {
  try {
    return await fn();
  } catch (err) {
    console.error(err);
    toast(`No se pudo completar ${what}: ${err.message}`, true);
    throw err;
  }
}

const hex2 = (n) => n.toString(16).padStart(2, '0');
const toHex = ([r, g, b]) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;
const fromHex = (s) => [
  parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16),
];

function hsvToRgb(h, s, v) {          // h 0-360, s/v 0-1
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  const t = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][
    Math.floor(h / 60) % 6
  ];
  return t.map((n) => Math.round((n + m) * 255));
}

function rgbToHsv([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  return { h, s: max ? d / max : 0, v: max };
}

// ------------------------------------------------------------- compatibilidad

function checkSupport() {
  const note = $('supportNote');
  const secure = window.isSecureContext;
  if (DEMO) {
    note.className = 'note';
    note.innerHTML =
      '<b>Modo demostracion.</b> Hay un teclado simulado de 3 teclas y rueda: ' +
      'puedes recorrer toda la interfaz sin conectar nada. Quita <code>?demo=1</code> ' +
      'de la direccion para usar el teclado real.';
    $('welcomeActions').hidden = true;
    return true;
  }
  if (androidShell()) {
    note.className = 'note';
    note.innerHTML =
      '<b>Aplicacion de Android.</b> Aqui el acceso USB lo hace la propia app, ' +
      'sin depender de WebHID ni de la version de Chrome.<br><br>' +
      'Enchufa el teclado por USB-C (OTG), pulsa Conectar y acepta el permiso ' +
      'que pide Android.';
    $('btnAnyDevice').hidden = true;
    $('btnUsbDiag').hidden = false;
    return true;
  }
  $('btnAnyDevice').hidden = !HID.hidSupported();
  if (!secure) {
    note.className = 'note bad';
    note.innerHTML =
      'Esta pagina debe abrirse por <b>HTTPS</b> (o desde localhost). ' +
      'Sin conexion segura el navegador bloquea el acceso al teclado.' + diagnostics();
    $('connectBtn').disabled = true;
    return false;
  }
  if (!HID.hidSupported()) {
    note.className = 'note bad';
    note.innerHTML =
      '<b>Este navegador no expone WebHID.</b><br><br>' + advice() + diagnostics();
    $('connectBtn').disabled = true;
    return false;
  }
  note.className = 'note';
  note.innerHTML =
    'WebHID disponible. Conecta el teclado por USB-C (OTG) y pulsa Conectar. ' +
    'Si la lista sale vacia, revisa que el cable transmita datos y que el ' +
    'telefono tenga el modo anfitrion USB activo.' + diagnostics();
  return true;
}

/** Version de Chromium sobre la que corre el navegador, sea cual sea la marca. */
function engine() {
  const ua = navigator.userAgent;
  let version = 0;
  const brands = (navigator.userAgentData && navigator.userAgentData.brands) || [];
  for (const b of brands) {
    if (/Chromium|Google Chrome/i.test(b.brand)) {
      version = Math.max(version, parseInt(b.version, 10) || 0);
    }
  }
  if (!version) {
    const m = ua.match(/Chrom(?:e|ium)\/(\d+)/);
    version = m ? Number(m[1]) : 0;
  }
  return {
    version,
    android: /Android/i.test(ua),
    scheme: /Edg\//.test(ua) ? 'edge' : /OPR\//.test(ua) ? 'opera' : 'chrome',
  };
}

// WebHID en Android esta en fase DevTrial, asi que no tiene una casilla propia
// en chrome://flags: se enciende con el interruptor general de funciones web
// experimentales. Algunas compilaciones anaden ademas una casilla dedicada.
const FLAG_STEPS =
  '<ol class="steps tight">' +
  '<li>Abre <code>chrome://flags</code> en ese navegador.</li>' +
  '<li>Busca <b>experimental</b> y pon <b>Experimental Web Platform features</b> ' +
  'en <b>Enabled</b>.</li>' +
  '<li>Busca tambien <b>hid</b>. Si aparece una casilla de WebHID, activala.</li>' +
  '<li>Pulsa <b>Relaunch</b> y vuelve aqui.</li>' +
  '</ol>';

/** El primer paso concreto que le toca a este navegador en concreto. */
function advice() {
  const { version, android } = engine();
  if (!android) {
    return 'En ordenador funciona con Chrome, Edge u Opera. Firefox y Safari ' +
      'no implementan WebHID.';
  }
  if (version >= 154) {
    return `Tu navegador va sobre Chromium ${version}, que ya trae WebHID, ` +
      'pero viene apagado porque todavia esta en pruebas.<br><br>' + FLAG_STEPS;
  }
  return `Tu navegador va sobre Chromium ${version || 'desconocido'}, y WebHID ` +
    'no llega a Android hasta Chromium <b>154</b>.<br><br>' +
    'Para probarlo hoy, instala <b>Chrome Beta</b> o <b>Chrome Dev</b> desde ' +
    'Play Store: son aplicaciones aparte y conviven con tu navegador normal. ' +
    'Despues:<br><br>' + FLAG_STEPS +
    '<br>Si prefieres esperar, Chromium 157 lo trae activado sin tocar nada.';
}

function diagnostics() {
  const { version, android } = engine();
  const yes = (b) => (b ? 'si' : 'no');
  return '<br><br><span class="diag">Diagnostico: Chromium ' +
    `${version || '?'} · Android ${yes(android)} · HTTPS ${yes(window.isSecureContext)} ` +
    `· navigator.hid ${yes('hid' in navigator)}</span>`;
}

// -------------------------------------------------------------------- conexion

/** Mensaje persistente en la pantalla inicial; el toast se va demasiado rapido. */
function log(html, bad = false) {
  const el = $('connectLog');
  el.className = 'note' + (bad ? ' bad' : '');
  el.innerHTML = html;
  el.classList.remove('hidden');
}

const NOT_FOUND =
  'El navegador no encontro ningun teclado compatible.<br><br>' +
  'Repasa por este orden:<br>' +
  '<ol class="steps tight">' +
  '<li>El teclado tiene que estar enchufado al telefono <b>antes</b> de pulsar Conectar.</li>' +
  '<li>El cable o adaptador debe llevar datos. Muchos cables USB-C solo dan corriente.</li>' +
  '<li>Al enchufarlo, Android pregunta si permites el acceso al dispositivo USB. ' +
  'Hay que aceptar. Si no aparecio, desenchufa y vuelve a enchufar.</li>' +
  '<li>Si el teclado enciende sus luces, recibe corriente, pero eso no ' +
  'garantiza que haya datos.</li>' +
  '</ol>' +
  'Si aun asi no sale, pulsa <b>No aparece mi teclado</b> para ver la lista ' +
  'completa de dispositivos USB que ve el navegador.';

async function connect() {
  if (state.transport) return disconnect();
  await guard(async () => {
    let device = null;
    if (DEMO) {
      state.transport = await new DemoTransport().open();
    } else if (androidShell()) {
      state.transport = await connectAndroid((msg) => log(msg));
    } else {
      device = (await HID.knownDevices())[0];
      try {
        if (device) state.transport = await new HID.Transport(device).open();
      } catch {
        device = null;   // autorizado antes pero ya no responde
      }
      if (!state.transport) {
        log('Abriendo el selector de dispositivos del navegador...');
        device = await HID.pickDevice();
        if (!device) {
          log(NOT_FOUND, true);
          return;
        }
        state.transport = await new HID.Transport(device).open();
      }
    }
    await afterOpen(device);
  }, 'la conexion');
}

/** Lectura inicial del teclado, comun a los dos caminos de conexion. */
async function afterOpen(device) {
  state.kb = new Keyboard(state.transport);

  state.config = await state.kb.getConfig();
  state.profile = state.config.profile || 0;
  state.layer = 0;

  try {
    state.layout = await Cat.loadLayout(state.transport.key);
  } catch {
    state.layout = genericLayout();
    toast('Layout desconocido: se usa una rejilla generica');
  }
  state.light = await state.kb.getLight();
  await reloadKeys();

  if (device) {
    navigator.hid.addEventListener('disconnect', (e) => {
      if (e.device === device) disconnect(true);
    });
  }

  $('connectLog').classList.add('hidden');
  renderConnected();
}

/**
 * Selector sin filtros. Responde a la pregunta importante: el navegador no ve
 * nada por USB, o si lo ve pero este modelo no esta en la lista conocida.
 */
async function scanAny() {
  let ficha = '';
  try {
    log('Abriendo la lista completa de dispositivos USB...');
    const device = await HID.pickAnyDevice();
    if (!device) {
      log(
        'La lista del navegador salio vacia, asi que no llega ningun ' +
        'dispositivo USB al telefono. El problema esta en el cable, el ' +
        'adaptador OTG o el permiso de Android, no en la pagina.', true
      );
      return;
    }
    const d = HID.describeDevice(device);
    const known = await HID.isKnown(device);
    ficha =
      `<b>${d.productName}</b><br>` +
      `<span class="diag">VID ${d.vendorId} · PID ${d.productId}<br>` +
      `colecciones: ${d.collections.join(', ') || 'ninguna'}</span><br><br>`;

    log(ficha + (known
      ? 'Este modelo si esta en la lista de conocidos. Conectando...'
      : 'Este modelo no esta en la lista de VID/PID conocidos. Lo intento ' +
        'igualmente: si responde, funciona.'), !known);

    state.transport = await new HID.Transport(device).open();
    await afterOpen(device);
  } catch (err) {
    if (err && err.name === 'NotFoundError') {
      log(ficha + 'Selector cerrado sin elegir nada.', true);
      return;
    }
    log(
      ficha + `No se pudo hablar con el dispositivo: ${err.message}<br><br>` +
      'Si los datos de arriba son los de tu teclado macro, pasamelos y lo ' +
      'anado a la lista de modelos reconocidos.', true
    );
  }
}

/** Vuelca en pantalla el estado del canal USB y lo que contesta el teclado. */
function runDiagnose() {
  log('Hablando con el teclado...');
  setTimeout(() => {
    const result = diagnose();
    if (result.error) { log(result.error, true); return; }
    const hex = (n) => n.toString(16).padStart(4, '0');
    const lines = [];
    for (const { device, report } of result) {
      lines.push(`<b>${device.name}</b> ${hex(device.vendorId)}:${hex(device.productId)}`);
      if (report.error) { lines.push(report.error); continue; }
      lines.push(`descriptor comun: ${report.control}`);
      for (const a of report.attempts || []) {
        lines.push(`if ${a.iface} · toma ${a.claim}`);
        if (a.reportDescriptor) {
          lines.push(`&nbsp;&nbsp;descriptor de reporte: ${a.reportDescriptor}`);
        }
        for (const t of a.tries || []) {
          lines.push(`&nbsp;&nbsp;${t.name}: ${t.reply}`);
        }
      }
      if (report.raw) lines.push(`crudo: ${report.raw}`);
    }
    log('<span class="diag">' + lines.join('<br>') + '</span>');
  }, 300);
}

function genericLayout() {
  const keys = [];
  for (let i = 0; i < 12; i++) {
    keys.push({
      x: (i % 4) * 1.1, y: Math.floor(i / 4) * 1.1, w: 1, h: 1,
      index: i, name: 'K' + i, state: 1, type: 32, code: 0,
    });
  }
  return {
    name: 'generico', light: [], customkey: 'v1',
    layouts: { width: 4.4, height: 3.4, key_index_max: 12, keys },
  };
}

async function disconnect(silent = false) {
  try { await state.transport?.close(); } catch { /* ya cerrado */ }
  state.transport = null;
  state.kb = null;
  state.macrosLoaded = false;
  $('main').classList.add('hidden');
  $('tabs').classList.add('hidden');
  $('welcome').classList.remove('hidden');
  $('connectBtn').textContent = 'Conectar';
  $('statusDot').classList.remove('on');
  $('deviceName').textContent = 'Sin conectar';
  $('deviceSub').textContent = 'Toca conectar para empezar';
  if (!silent) toast('Teclado desconectado');
}

function renderConnected() {
  $('welcome').classList.add('hidden');
  $('main').classList.remove('hidden');
  $('tabs').classList.remove('hidden');
  $('connectBtn').textContent = 'Desconectar';
  $('statusDot').classList.add('on');
  $('deviceName').textContent = state.transport.productName || state.transport.key;
  const c = state.config;
  $('deviceSub').textContent =
    `Firmware ${c.firmware} · ${c.profileCount} perfiles · ${c.layerCount} capas`;
  renderProfiles();
  renderBoard();
  renderLight();
  renderSettings();
}

// ------------------------------------------------------------------ perfiles

function renderProfiles() {
  const { profileCount, layerCount } = state.config;
  const profRow = $('profileRow');
  profRow.innerHTML = '';
  for (let i = 0; i < profileCount; i++) {
    const b = document.createElement('button');
    b.className = 'chip' + (i === state.profile ? ' on' : '');
    b.textContent = 'Perfil ' + (i + 1);
    b.onclick = () => selectProfile(i);
    profRow.appendChild(b);
  }
  const layRow = $('layerRow');
  layRow.innerHTML = '';
  const names = ['Capa estandar', 'Capa Fn', 'Capa 3', 'Capa 4'];
  for (let i = 0; i < layerCount; i++) {
    const b = document.createElement('button');
    b.className = 'chip' + (i === state.layer ? ' on' : '');
    b.textContent = names[i] || 'Capa ' + (i + 1);
    b.onclick = () => selectLayer(i);
    layRow.appendChild(b);
  }
}

async function selectProfile(i) {
  if (i === state.profile) return;
  await guard(async () => {
    await state.kb.setProfile(i);
    state.profile = i;
    await reloadKeys();
    renderProfiles();
    renderBoard();
  }, 'el cambio de perfil');
}

async function selectLayer(i) {
  if (i === state.layer) return;
  await guard(async () => {
    state.layer = i;
    await reloadKeys();
    renderProfiles();
    renderBoard();
  }, 'el cambio de capa');
}

async function reloadKeys() {
  const n = state.layout.layouts.key_index_max;
  state.keys = await state.kb.readKeys(n, state.layer);
  state.colors = await state.kb.readColors(n);
  state.selectedKey = -1;
  $('keyDetail').hidden = true;
}

// -------------------------------------------------------------------- teclado

function renderBoard() {
  const L = state.layout.layouts;
  const board = $('board');
  board.innerHTML = '';
  // Los layouts oficiales son muy anchos; en vertical se estiran un poco para
  // que las teclas sigan siendo legibles y faciles de tocar.
  const ratio = Math.max(L.height / L.width, 0.42);
  board.style.paddingTop = ratio * 100 + '%';
  requestAnimationFrame(() => {
    const unit = board.clientWidth / L.width;
    board.style.fontSize = Math.max(9, Math.min(16, unit * 0.34)) + 'px';
  });

  // El dibujo solo situa cada tecla; la funcion asignada se lee en la lista.
  const short = boardLabels(L);

  for (const k of L.keys) {
    if (k.state === 201) continue;
    const el = document.createElement('div');
    el.className = 'key' + (k.state === 0 ? ' knob' : '');
    el.style.left = (k.x / L.width) * 100 + '%';
    el.style.top = (k.y / L.height) * 100 + '%';
    el.style.width = (k.w / L.width) * 100 + '%';
    el.style.height = (k.h / L.height) * 100 + '%';
    el.dataset.index = k.index;
    if (k.index === state.selectedKey) el.classList.add('on');

    el.append(document.createTextNode(short[k.index] || ''));

    const rgb = state.colors[k.index];
    if (rgb && (rgb[0] || rgb[1] || rgb[2])) {
      const sw = document.createElement('span');
      sw.className = 'swatch';
      sw.style.background = toHex(rgb);
      el.appendChild(sw);
    }
    el.onclick = () => selectKey(k.index);
    board.appendChild(el);
  }
  renderKeyList();
}

/**
 * Nombre de posicion de cada tecla. El campo `name` del layout guarda la
 * funcion de fabrica, no la posicion, asi que se numeran de izquierda a
 * derecha y la rueda se nombra por su papel.
 */
/** Etiqueta corta para el dibujo: numero de tecla o simbolo de la rueda. */
function boardLabels(L) {
  const visible = L.keys.filter((k) => k.state !== 201);
  const byX = (a, b) => a.x - b.x || a.y - b.y;
  const out = {};
  visible.filter((k) => k.state !== 0).sort(byX)
    .forEach((k, i) => { out[k.index] = String(i + 1); });
  const knobs = visible.filter((k) => k.state === 0).sort(byX);
  const marks = knobs.length === 3 ? ['◀', '●', '▶'] : null;
  knobs.forEach((k, i) => { out[k.index] = marks ? marks[i] : '●'; });
  return out;
}

function positionNames(L) {
  const visible = L.keys.filter((k) => k.state !== 201);
  const byX = (a, b) => a.x - b.x || a.y - b.y;
  const names = {};
  const pads = visible.filter((k) => k.state !== 0).sort(byX);
  pads.forEach((k, i) => { names[k.index] = `Tecla ${i + 1}`; });
  const knobs = visible.filter((k) => k.state === 0).sort(byX);
  const knobNames = knobs.length === 3
    ? ['Rueda izquierda', 'Rueda (pulsar)', 'Rueda derecha']
    : knobs.map((_, i) => `Rueda ${i + 1}`);
  knobs.forEach((k, i) => { names[k.index] = knobNames[i]; });
  return names;
}

/** Lista tocable: en un telefono es mas comodo que el dibujo. */
function renderKeyList() {
  const L = state.layout.layouts;
  const names = positionNames(L);
  const list = $('keyList');
  list.innerHTML = '';
  const order = (k) => (k.state === 0 ? 1 : 0);
  for (const k of [...L.keys].sort((a, b) => order(a) - order(b) || a.x - b.x)) {
    if (k.state === 201) continue;
    const info = state.keys[k.index] || {};
    const row = document.createElement('button');
    row.className = 'key-row' + (k.index === state.selectedKey ? ' on' : '');
    row.onclick = () => selectKey(k.index);

    const dot = document.createElement('span');
    dot.className = 'key-dot';
    dot.style.background = toHex(state.colors[k.index] || [60, 70, 85]);

    const name = document.createElement('span');
    name.className = 'key-name';
    name.textContent = names[k.index] || 'Tecla ' + k.index;

    const val = document.createElement('span');
    val.className = 'key-val';
    val.textContent = info.type
      ? Cat.describe(info.type, info.code1, info.code2, info.code3)
      : '—';

    row.append(dot, name, val);
    list.appendChild(row);
  }
}

function selectKey(index) {
  state.selectedKey = index;
  const info = state.keys[index] || { type: 0, code1: 0, code2: 0, code3: 0 };
  const names = positionNames(state.layout.layouts);
  $('keyDetail').hidden = false;
  $('keyDetailTitle').textContent = names[index] || 'Tecla ' + index;
  $('keyDetailName').textContent =
    Cat.describe(info.type, info.code1, info.code2, info.code3);
  $('keyDetailValue').textContent =
    `tipo ${info.type} · ${info.code1}, ${info.code2}, ${info.code3}`;
  $('keyColor').value = toHex(state.colors[index] || [255, 255, 255]);
  renderBoard();
}

async function assign(assignment) {
  const i = state.selectedKey;
  if (i < 0) return;
  await guard(async () => {
    await state.kb.writeKey(i, state.layer, assignment);
    state.keys[i] = {
      type: assignment.type,
      code1: assignment.code1 || 0,
      code2: assignment.code2 || 0,
      code3: assignment.code3 || 0,
    };
    closeSheet();
    selectKey(i);
    toast('Tecla actualizada');
  }, 'la asignacion');
}

// ------------------------------------------------------------- hoja de teclas

function openSheet(title, build) {
  $('sheetTitle').textContent = title;
  const box = $('sheetContent');
  box.innerHTML = '';
  build(box);
  $('sheet').classList.remove('hidden');
}

function closeSheet() {
  $('sheet').classList.add('hidden');
}

function openAssignSheet() {
  if (state.selectedKey < 0) return;
  const palette = Cat.paletteFor(state.layout);
  openSheet('Elegir funcion', (box) => {
    const tabs = document.createElement('div');
    tabs.className = 'chips';
    tabs.style.marginBottom = '12px';
    const grid = document.createElement('div');
    grid.className = 'grid-keys';

    const cats = [
      ...palette.map((c) => ({ id: c.id, label: Cat.t(c.id, c.label), keycodes: c.keycodes })),
      { id: 'combo', label: 'Combinacion', combo: true },
    ];

    const show = (cat, btn) => {
      [...tabs.children].forEach((c) => c.classList.remove('on'));
      btn.classList.add('on');
      grid.innerHTML = '';
      if (cat.combo) return buildCombo(grid);
      for (const kc of cat.keycodes) {
        const b = document.createElement('button');
        b.textContent = Cat.label(kc) || kc.code || '?';
        b.onclick = () => {
          if (kc.type === KeyType.MOUSE_MOVE) return openCursorSheet();
          if (kc.type === KeyType.CUSTOM) return openSheet('Combinacion', buildCombo);
          assign({ type: kc.type, code1: kc.value1, code2: kc.value2, code3: kc.value3 });
        };
        grid.appendChild(b);
      }
    };

    cats.forEach((cat, i) => {
      const b = document.createElement('button');
      b.className = 'chip';
      b.textContent = cat.label;
      b.onclick = () => show(cat, b);
      tabs.appendChild(b);
      if (i === 0) setTimeout(() => show(cat, b), 0);
    });

    box.append(tabs, grid);
  });
}

const MODS = [
  ['Ctrl', 0x01], ['Shift', 0x02], ['Alt', 0x04], ['Win', 0x08],
  ['RCtrl', 0x10], ['RShift', 0x20], ['RAlt', 0x40], ['RWin', 0x80],
];

function buildCombo(box) {
  const cur = state.keys[state.selectedKey] || {};
  let mask = cur.type === KeyType.KEYBOARD ? cur.code1 : 0;

  const p = document.createElement('p');
  p.className = 'muted small';
  p.textContent = 'Elige modificadores y despues la tecla base.';
  const mods = document.createElement('div');
  mods.className = 'mods';
  MODS.forEach(([name, bit]) => {
    const b = document.createElement('button');
    b.textContent = name;
    if (mask & bit) b.classList.add('on');
    b.onclick = () => { mask ^= bit; b.classList.toggle('on'); };
    mods.appendChild(b);
  });

  const grid = document.createElement('div');
  grid.className = 'grid-keys';
  const basics = Cat.paletteFor(state.layout).find((c) => c.id === '50');
  const none = document.createElement('button');
  none.textContent = 'Solo modificadores';
  none.onclick = () => assign({ type: KeyType.KEYBOARD, code1: mask, code2: 0, code3: 0 });
  grid.appendChild(none);
  for (const kc of basics.keycodes) {
    if (kc.type !== KeyType.KEYBOARD || !kc.value2) continue;
    const b = document.createElement('button');
    b.textContent = Cat.label(kc);
    b.onclick = () =>
      assign({ type: KeyType.KEYBOARD, code1: mask, code2: kc.value2, code3: 0 });
    grid.appendChild(b);
  }
  box.append(p, mods, grid);
}

function openCursorSheet() {
  openSheet('Mover el cursor', (box) => {
    const cur = state.keys[state.selectedKey] || {};
    const d = cur.type === KeyType.MOUSE_MOVE
      ? Cat.decodeCursor(cur.code1, cur.code2, cur.code3)
      : { up: 0, down: 0, left: 0, right: 0 };
    let dir = d.up ? 'up' : d.down ? 'down' : d.left ? 'left' : 'right';
    let step = d.up || d.down || d.left || d.right || 10;

    const dirs = document.createElement('div');
    dirs.className = 'mods';
    [['Arriba', 'up'], ['Abajo', 'down'], ['Izquierda', 'left'], ['Derecha', 'right']]
      .forEach(([label, id]) => {
        const b = document.createElement('button');
        b.textContent = label;
        if (id === dir) b.classList.add('on');
        b.onclick = () => {
          dir = id;
          [...dirs.children].forEach((c) => c.classList.remove('on'));
          b.classList.add('on');
        };
        dirs.appendChild(b);
      });

    const field = document.createElement('label');
    field.className = 'field';
    field.innerHTML = '<span>Pixeles por pulsacion <b id="cursorVal"></b></span>';
    const range = document.createElement('input');
    range.type = 'range'; range.min = 1; range.max = 255; range.value = step;
    const out = () => field.querySelector('#cursorVal').textContent = range.value;
    range.oninput = out;
    field.appendChild(range);

    const ok = document.createElement('button');
    ok.className = 'btn primary wide';
    ok.textContent = 'Asignar';
    ok.onclick = () => assign(Cat.encodeCursor({ [dir]: Number(range.value) }));

    box.append(dirs, field, ok);
    out();
  });
}

// ------------------------------------------------------------------------ luz

function renderLight() {
  const effects = state.layout.light || [];
  const list = $('effectList');
  list.innerHTML = '';
  if (!effects.length) {
    list.innerHTML = '<p class="muted small">Este layout no declara efectos.</p>';
  }
  for (const e of effects) {
    const b = document.createElement('button');
    b.className = 'chip' + (state.light && e.value === state.light.mode ? ' on' : '');
    b.textContent = Cat.t(e.lang, e.name);
    b.onclick = () => guard(async () => {
      state.light = await state.kb.applyEffect(e.value);
      renderLight();
      toast('Efecto aplicado');
    }, 'el cambio de efecto');
    list.appendChild(b);
  }

  const l = state.light;
  if (!l) return;
  $('brightness').value = l.brightness;
  $('brightVal').textContent = l.brightness;
  $('speed').value = l.speed;
  $('speedVal').textContent = l.speed;
  $('direction').checked = !!l.direction;
  $('fixedColor').checked = !!l.color;
  $('colorField').classList.toggle('hidden', !l.color);
  const hsv = { h: (l.h / 255) * 360, s: l.s / 255, v: l.v / 255 };
  $('lightColor').value = toHex(hsvToRgb(hsv.h, hsv.s, Math.max(hsv.v, 0.15)));
}

function pushLight(patch) {
  Object.assign(state.light, patch);
  return guard(() => state.kb.setLight(state.light), 'el ajuste de luz');
}

// --------------------------------------------------------------------- macros

async function ensureMacros() {
  if (state.macrosLoaded) return;
  await guard(async () => {
    toast('Leyendo macros...');
    const buf = await state.kb.readMacroBuffer();
    state.macros = Mac.decodeMacros(buf);
    state.macrosLoaded = true;
    renderMacros();
  }, 'la lectura de macros');
}

function renderMacros() {
  const list = $('macroList');
  list.innerHTML = '';
  state.macros.forEach((m, i) => {
    const b = document.createElement('button');
    b.className = 'chip' + (i === state.selectedMacro ? ' on' : '');
    b.textContent = m.name + (m.events.length ? ` (${m.events.length})` : '');
    b.onclick = () => { state.selectedMacro = i; renderMacros(); };
    list.appendChild(b);
  });

  const used = Mac.usedBytes(state.macros);
  $('macroUsage').textContent =
    `${used} de ${Mac.MACRO_CAPACITY} bytes usados`;

  const macro = state.macros[state.selectedMacro];
  $('macroTitle').textContent = macro.name;
  const ol = $('macroEvents');
  ol.innerHTML = '';
  if (!macro.events.length) {
    ol.innerHTML = '<li class="empty">Sin eventos todavia</li>';
    return;
  }
  macro.events.forEach((ev, i) => {
    const li = document.createElement('li');
    const txt = document.createElement('span');
    txt.className = 'txt';
    txt.textContent = `${i + 1}. ${Mac.eventLabel(ev)}`;
    const delay = document.createElement('input');
    delay.type = 'number'; delay.min = 0; delay.max = 60000; delay.value = ev.delay;
    delay.title = 'Retardo en ms antes del siguiente evento';
    delay.oninput = () => { ev.delay = Math.max(0, Math.min(60000, +delay.value || 0)); };
    const del = document.createElement('button');
    del.className = 'del'; del.textContent = '×';
    del.onclick = () => { macro.events.splice(i, 1); renderMacros(); };
    li.append(txt, delay, del);
    ol.appendChild(li);
  });
}

function openEventSheet() {
  openSheet('Anadir evento', (box) => {
    const macro = state.macros[state.selectedMacro];
    const add = (ev) => {
      macro.events.push({ delay: 20, ...ev });
      renderMacros();
      closeSheet();
    };

    const mk = (parent, label, fn) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = fn;
      parent.appendChild(b);
    };

    const h1 = document.createElement('p');
    h1.className = 'muted small';
    h1.textContent = 'Raton y rueda';
    const g1 = document.createElement('div');
    g1.className = 'grid-keys';
    for (const [code, name] of Object.entries(Mac.MOUSE_CODES)) {
      mk(g1, name, () => {
        macro.events.push({ type: Mac.EV_MOUSE, code: +code, action: 1, delay: 20 });
        macro.events.push({ type: Mac.EV_MOUSE, code: +code, action: 2, delay: 20 });
        renderMacros(); closeSheet();
      });
    }
    mk(g1, 'Rueda arriba', () => add({ type: Mac.EV_WHEEL_V, code: 1, action: 1 }));
    mk(g1, 'Rueda abajo', () => add({ type: Mac.EV_WHEEL_V, code: 255, action: 1 }));

    const h2 = document.createElement('p');
    h2.className = 'muted small';
    h2.textContent = 'Teclas (se anade pulsar y soltar)';
    const g2 = document.createElement('div');
    g2.className = 'grid-keys';
    const basics = Cat.paletteFor(state.layout).find((c) => c.id === '50');
    for (const kc of basics.keycodes) {
      if (kc.type !== KeyType.KEYBOARD || !kc.value2) continue;
      mk(g2, Cat.label(kc), () => {
        macro.events.push({ type: Mac.EV_KEY, code: kc.value2, action: 1, delay: 20 });
        macro.events.push({ type: Mac.EV_KEY, code: kc.value2, action: 2, delay: 20 });
        renderMacros(); closeSheet();
      });
    }
    box.append(h1, g1, h2, g2);
  });
}

function toggleRecord() {
  state.recording = !state.recording;
  $('btnRecord').textContent = state.recording ? 'Detener grabacion' : 'Grabar teclado';
  toast(state.recording
    ? 'Grabando: pulsa teclas en un teclado fisico'
    : 'Grabacion detenida');
}

function onRecordKey(e) {
  if (!state.recording) return;
  const code = Cat.BROWSER_TO_HID[e.code];
  if (!code) return;
  e.preventDefault();
  state.macros[state.selectedMacro].events.push({
    type: Mac.EV_KEY, code, action: e.type === 'keydown' ? 1 : 2, delay: 20,
  });
  renderMacros();
}

// -------------------------------------------------------------------- ajustes

function renderSettings() {
  const c = state.config;
  const t = state.transport;
  const rows = [
    ['Producto', t.productName || '—'],
    ['VID:PID', t.key.replace('_', ':')],
    ['Firmware', c.firmware],
    ['Version de protocolo', c.version],
    ['Perfiles', c.profileCount],
    ['Capas', c.layerCount],
    ['Bateria', c.battery ? c.battery + '%' : 'sin bateria'],
    ['Numero de serie', c.serial || '—'],
    ['Teclas', state.layout.layouts.key_index_max],
  ];
  $('deviceInfo').innerHTML = rows
    .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`)
    .join('');
  const mins = Math.round((c.autoSleepTime || 0) / 60);
  $('sleepTime').value = mins;
  $('sleepVal').textContent = mins;
}

async function exportConfig() {
  await guard(async () => {
    toast('Leyendo toda la configuracion...');
    const n = state.layout.layouts.key_index_max;
    const original = state.profile;
    const profiles = [];
    for (let p = 0; p < state.config.profileCount; p++) {
      await state.kb.setProfile(p);
      const layers = [];
      for (let l = 0; l < state.config.layerCount; l++) {
        layers.push(await state.kb.readKeys(n, l));
      }
      profiles.push(layers);
    }
    await state.kb.setProfile(original);
    await ensureMacros();

    const blob = new Blob([JSON.stringify({
      app: 'macropad-movil', version: 1,
      device: state.transport.key,
      productName: state.transport.productName,
      keyCount: n,
      profiles,
      colors: state.colors,
      light: state.light,
      macros: state.macros,
    }, null, 1)], { type: 'application/json' });

    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${state.transport.key}-config.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('Configuracion exportada');
  }, 'la exportacion');
}

async function importConfig(file) {
  await guard(async () => {
    const data = JSON.parse(await file.text());
    if (data.device !== state.transport.key &&
        !confirm('El archivo es de otro modelo. ¿Escribirlo igualmente?')) return;
    const original = state.profile;
    for (let p = 0; p < data.profiles.length; p++) {
      await state.kb.setProfile(p);
      for (let l = 0; l < data.profiles[p].length; l++) {
        await state.kb.writeKeys(data.profiles[p][l], l);
      }
    }
    await state.kb.setProfile(original);
    if (data.colors) await state.kb.writeColors(data.colors);
    if (data.light) await state.kb.setLight(data.light);
    if (data.macros) {
      state.macros = data.macros;
      state.macrosLoaded = true;
      await state.kb.writeMacroBuffer(Mac.encodeMacros(state.macros));
    }
    await reloadKeys();
    state.light = await state.kb.getLight();
    renderBoard(); renderLight(); renderMacros();
    toast('Configuracion importada');
  }, 'la importacion');
}

// ------------------------------------------------------------------- arranque

function switchView(name) {
  for (const v of document.querySelectorAll('.view')) {
    v.classList.toggle('hidden', v.id !== 'view-' + name);
  }
  for (const t of document.querySelectorAll('.tab')) {
    t.classList.toggle('active', t.dataset.view === name);
  }
  if (name === 'macros') ensureMacros();
}

function wire() {
  $('connectBtn').onclick = connect;
  $('btnAnyDevice').onclick = scanAny;
  $('btnUsbDiag').onclick = runDiagnose;
  $('btnDemo').onclick = () => {
    location.search = '?demo=1';
  };
  document.querySelectorAll('.tab').forEach((t) => {
    t.onclick = () => switchView(t.dataset.view);
  });
  document.querySelectorAll('[data-close]').forEach((el) => {
    el.onclick = closeSheet;
  });

  $('btnAssign').onclick = openAssignSheet;
  $('btnDisable').onclick = () => assign({ type: KeyType.DISABLED });
  $('keyColor').onchange = (e) => guard(async () => {
    const rgb = fromHex(e.target.value);
    await state.kb.writeColor(state.selectedKey, rgb);
    state.colors[state.selectedKey] = rgb;
    renderBoard();
    toast('Color guardado');
  }, 'el cambio de color');

  $('brightness').oninput = (e) => { $('brightVal').textContent = e.target.value; };
  $('brightness').onchange = (e) => pushLight({ brightness: +e.target.value });
  $('speed').oninput = (e) => { $('speedVal').textContent = e.target.value; };
  $('speed').onchange = (e) => pushLight({ speed: +e.target.value });
  $('direction').onchange = (e) => pushLight({ direction: e.target.checked ? 1 : 0 });
  $('fixedColor').onchange = (e) => {
    $('colorField').classList.toggle('hidden', !e.target.checked);
    pushLight({ color: e.target.checked ? 1 : 0 });
  };
  $('lightColor').onchange = (e) => {
    const { h, s, v } = rgbToHsv(fromHex(e.target.value));
    pushLight({
      h: Math.round((h / 360) * 255),
      s: Math.round(s * 255),
      v: Math.round(v * 255),
    });
  };
  $('btnReadColors').onclick = () => guard(async () => {
    state.colors = await state.kb.readColors(state.layout.layouts.key_index_max);
    renderBoard();
    toast('Colores actualizados');
  }, 'la lectura de colores');

  $('btnAddEvent').onclick = openEventSheet;
  $('btnRecord').onclick = toggleRecord;
  $('btnClearMacro').onclick = () => {
    state.macros[state.selectedMacro].events = [];
    renderMacros();
  };
  $('btnSaveMacros').onclick = () => guard(async () => {
    if (Mac.usedBytes(state.macros) > Mac.MACRO_CAPACITY) {
      throw new Error('las macros no caben en el teclado');
    }
    await state.kb.writeMacroBuffer(Mac.encodeMacros(state.macros));
    toast('Macros guardadas');
  }, 'el guardado de macros');

  $('btnExport').onclick = exportConfig;
  $('btnImport').onclick = () => $('importFile').click();
  $('importFile').onchange = (e) => {
    if (e.target.files[0]) importConfig(e.target.files[0]);
    e.target.value = '';
  };
  $('sleepTime').oninput = (e) => { $('sleepVal').textContent = e.target.value; };
  $('btnSleep').onclick = () => guard(async () => {
    await state.kb.setAutoSleep(+$('sleepTime').value * 60);
    toast('Suspension actualizada');
  }, 'el ajuste de suspension');
  $('btnResetMacros').onclick = () => {
    if (!confirm('¿Borrar todas las macros del teclado?')) return;
    guard(async () => {
      await state.kb.resetMacros();
      state.macros = Mac.decodeMacros(await state.kb.readMacroBuffer());
      renderMacros();
      toast('Macros borradas');
    }, 'el borrado de macros');
  };
  $('btnFactory').onclick = () => {
    if (!confirm('¿Restablecer el teclado a valores de fabrica?')) return;
    guard(async () => {
      await state.kb.factoryReset();
      await reloadKeys();
      state.light = await state.kb.getLight();
      renderBoard(); renderLight();
      toast('Teclado restablecido');
    }, 'el restablecimiento');
  };

  window.addEventListener('keydown', onRecordKey);
  window.addEventListener('keyup', onRecordKey);
}

async function main() {
  await Cat.loadCatalog(navigator.language.startsWith('es') ? 'es' : 'en');
  wire();
  if (!checkSupport()) return;
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  if (DEMO) return;
  // Avisa si el usuario ya autorizo el teclado en una sesion anterior.
  const known = await HID.knownDevices();
  if (known.length) $('deviceSub').textContent = 'Teclado autorizado: pulsa Conectar';
}

main();
