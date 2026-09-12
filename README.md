# MacroPad Móvil

Configurador web para teclados macro de la familia SDCX (los que en Windows se
configuran desde `sdcx-tech.com`), pensado para usarse desde el teléfono.

Habla el mismo protocolo HID que la herramienta oficial, así que hace lo mismo:
reasignar teclas, colores por tecla, efectos de luz, macros, perfiles y capas.

Es un sitio estático: HTML, CSS y JavaScript sin dependencias ni compilación.

Viene en dos formas, con la misma interfaz:

- **Web**, que funciona en el navegador de un ordenador desde hoy.
- **Aplicación de Android**, en la carpeta `android/`, que hace el acceso USB
  por su cuenta y no depende de la versión de Chrome. Es la que hay que usar en
  el teléfono.

---

## Aplicación de Android

Chrome para Android todavía no expone por WebHID los teclados que el sistema ya
está usando como teclado. La aplicación esquiva eso: usa la API USB de Android,
que sí puede reclamar la interfaz con `claimInterface(forceClaim = true)`,
apartando temporalmente al controlador del sistema.

Por dentro es una carcasa mínima. Un `WebView` muestra exactamente la misma web
de este repositorio, servida desde los assets, y un puente en Kotlin le da el
acceso USB. La interfaz, el protocolo y los layouts son los mismos archivos: al
compilar se copian, así que web y app nunca se desincronizan.

**Cómo conseguir el APK sin instalar nada.** Cada cambio en `main` dispara el
flujo *APK de Android* en GitHub Actions. Entra en la pestaña **Actions** del
repositorio, abre la última ejecución en verde y descarga el artefacto
`macropad-movil-apk`. Dentro está el APK.

Es una compilación de depuración, firmada con la clave de depuración, así que
Android pedirá permiso para instalar desde esa fuente. Al enchufar el teclado,
la app pide el permiso USB del sistema: hay que aceptarlo.

Para compilarlo en local hace falta el SDK de Android y `gradle assembleDebug`
dentro de `android/`.

---

## Qué necesitas para que funcione en Android desde el navegador

Esto aplica sólo si quieres usar la web en el móvil en vez de la aplicación. El
navegador sólo puede hablar con el teclado a través de **WebHID**, y en Android
esa API es muy reciente:

| Plataforma | Estado |
|---|---|
| Chrome / Edge / Opera en PC | Funciona desde hace años |
| Chrome en Android 154, 155, 156 | Funciona activando una bandera |
| Chrome en Android 157 o superior | Funciona sin tocar nada |
| Chrome en Android 153 o anterior | No funciona: la API no existe |
| Firefox y Safari, cualquier plataforma | No funciona: no implementan WebHID |

En Chromium 154, 155 y 156 la API está en fase de prueba para desarrolladores
(*DevTrial*), así que no tiene una casilla propia en `chrome://flags`: se
enciende con el interruptor general de funciones experimentales.

1. Abre `chrome://flags`
2. Busca **experimental** y pon **Experimental Web Platform features** en **Enabled**
3. Busca también **hid**, por si esa compilación añade una casilla dedicada
4. Pulsa **Relaunch**

Mientras Chrome estable siga en 153, la forma de probarlo es instalar **Chrome
Beta** (154) o **Chrome Dev** (155) desde Play Store. Son aplicaciones aparte,
conviven con el Chrome normal. Brave y otros Chromium de terceros van por
detrás de Chrome, así que tardarán más en traer la API.

La propia app te dice en qué versión de Chromium estás y qué te falta: en la
pantalla inicial hay una línea de diagnóstico.

Además el teléfono tiene que ser **anfitrión USB (OTG)** y el cable tiene que
llevar datos, no sólo corriente.

WebUSB no sirve como alternativa: Chrome bloquea a propósito el acceso a
interfaces de clase HID desde WebUSB, en todas las plataformas.

---

## Cómo publicarlo

WebHID exige contexto seguro, así que la página tiene que servirse por HTTPS
(o desde `localhost`). Abrirla con doble clic como `file://` no vale.

**Netlify**, que es como está desplegado

En [app.netlify.com](https://app.netlify.com) entra con la cuenta de GitHub,
elige *Add new site* → *Import an existing project* → GitHub, y selecciona este
repositorio. No hay que rellenar nada más: `netlify.toml` ya declara que el
sitio se publica desde la raíz y que no hay compilación. Cada `git push` a
`main` vuelve a desplegar solo.

El sitio queda en `https://NOMBRE.netlify.app`, con HTTPS incluido, que es lo
que WebHID necesita.

**GitHub Pages**, como alternativa

En Settings → Pages elige la rama `main` y la carpeta raíz. Queda en
`https://USUARIO.github.io/macropad-movil/`. Cloudflare Pages y Vercel sirven
igual de bien.

**En local para probar**

```bash
python -m http.server 8123
```

y abre `http://localhost:8123`.

---

## Modo demostración

Añade `?demo=1` a la dirección y aparece un teclado simulado de 3 teclas y
rueda. Sirve para recorrer toda la interfaz sin conectar nada.

---

## Qué hace cada pestaña

**Teclas** — dibujo del dispositivo más lista de teclas. Al tocar una tecla
puedes asignarle cualquier función del catálogo (teclas normales, multimedia,
botones y movimiento del ratón, atajos, control de luz, macros), montar una
combinación con modificadores, o darle un color propio. El selector de perfil
y de capa está arriba.

**Luz** — efecto, brillo, velocidad, dirección y color fijo. Los efectos
disponibles salen del perfil del propio modelo.

**Macros** — 16 huecos. Puedes añadir eventos desde el móvil (botones de ratón,
rueda y teclas) o grabarlos con un teclado físico si estás en PC. Cada evento
lleva su retardo en milisegundos. El buffer del teclado es de 4032 bytes útiles
y la app te dice cuánto llevas usado.

**Ajustes** — datos del dispositivo, copia de seguridad en JSON de todo
(teclas de todos los perfiles y capas, colores, luz y macros), suspensión
automática y restablecimiento de fábrica.

---

## Estructura

```
index.html          interfaz
styles.css          estilos
sw.js               service worker, permite abrir la app sin red
manifest.webmanifest
js/hid.js           transporte WebHID: apertura, cola de comandos, respuestas
js/protocol.js      un método por comando del firmware
js/catalog.js       catálogo de teclas, traducciones y layouts
js/macros.js        codificación y decodificación del buffer de macros
js/demo.js          teclado simulado para ?demo=1
js/app.js           estado e interfaz
data/devices.json   196 combinaciones VID/PID reconocidas
data/keycodes.json  catálogo de funciones asignables
data/layouts/       199 layouts de dispositivo
data/i18n/          textos en español e inglés
```

Los datos de `data/` se extrajeron del bundle público del configurador oficial
para que la app reconozca los mismos modelos y muestre los mismos nombres.
En `PROTOCOL.md` está documentado el protocolo completo.

---

## Compatibilidad

`data/devices.json` cubre los 196 pares VID/PID que acepta la herramienta
oficial, y `data/layouts/` los 199 modelos que tiene mapeados. Si conectas un
modelo sin layout, la app sigue funcionando con una rejilla genérica: podrás
usar luces y macros, y asignar teclas por índice.
