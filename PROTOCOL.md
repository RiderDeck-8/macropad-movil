# Protocolo HID de los teclados SDCX

Documentado a partir del bundle público del configurador oficial
(`sdcx-tech.com`) para poder hablar con el mismo hardware desde otro cliente.
Todo lo de aquí está implementado en `js/protocol.js`.

## Transporte

- Interfaz HID propietaria: **usagePage `0xFF00`, usage `0x02`**.
- Salida: `sendReport(0, bytes)` con **64 bytes**.
- Entrada: reportes de 64 bytes.
- Los reportes de entrada que empiezan por `AA FA` son avisos de luz no
  solicitados, no respuestas.

Estructura de un paquete de salida:

```
byte 0    comando     (6 = configuración, 85 = IAP, 90 = IAP Artery)
byte 1    subcomando
byte 2    longitud
byte 3-4  desplazamiento, little endian
byte 5+   cabecera extra y datos, según el subcomando
```

Casi todo usa comando `6`. Cada escritura espera una respuesta antes de la
siguiente: el firmware no tolera comandos solapados.

## Subcomandos del comando 6

| Sub | Operación | Petición | Respuesta |
|---|---|---|---|
| 5 | Leer configuración | `[5]` | datos en el byte 5 |
| 7 | Leer teclas (sin capa) | `[7, 56, offLo, offHi]` | datos en el byte 8 |
| 8 | Leer teclas de una capa | `[8, 58, offLo, offHi, 0, capa, 0]` | datos en el byte 8 |
| 9 | Escribir teclas en bloque | `[9, n+3, offLo, offHi, 0, capa, 0, …datos]` (datos desde el byte 8) | — |
| 16 | Escribir una tecla | `[16, 7, offLo, offHi, 0, capa, 0, tipo, c1, c2, c3]` | — |
| 19 | Leer colores | `[19, 58, offLo, offHi]` | datos en el byte 8 |
| 18 | Escribir colores en bloque | `[18, n+3, offLo, offHi, 0, 0, 0, …datos]` | — |
| 20 | Escribir un color | `[20, 3, offLo, offHi, 0, 0, 0, r, g, b]` | — |
| 10 | Leer luz | `[10]` | 11 bytes en el byte 5 |
| 11 | Escribir luz | `[11, 11, 0, 0, …11 bytes]` | — |
| 22 | Valores por defecto de un efecto | `[22, 0, 0, 0, 1, 0, modo]` | 11 bytes en el byte 5 |
| 12 | Leer macros | `[12, n, offLo, offHi]` | datos en el byte 8 |
| 13 | Escribir macros | `[13, n, offLo, offHi, …datos]` (datos desde el byte 5, máximo 59) | — |
| 15 | Restablecer | `[15, 4]` borra macros, `[15, 255]` valores de fábrica | — |
| 64 / 65 | Escribir / leer URL (modelos "website") | igual que macros, buffer de 128 bytes | — |
| 251 | Cambiar de perfil | `[251, perfil]` | — |
| 252 | Suspensión automática | `[252, 2, 0, 0, segLo, segHi]` | — |

El desplazamiento de teclas es `índice × 4`; el de colores, `índice × 3`.

## Configuración general (subcomando 5)

Los datos empiezan en el byte 5 de la respuesta. `respuesta[2]` es la longitud.

| Offset | Campo |
|---|---|
| 0-1 | versión de protocolo (LE16) |
| 2-3 | product id (LE16) |
| 4-5 | versión de firmware (LE16) |
| 6 | modo de trabajo |
| 7 | estado del enlace |
| 8 | batería |
| 9 | carga |
| 10 | número de perfiles |
| 11 | perfil activo |
| 12 | número de capas |
| 13 | capa activa |
| 14-15 | suspensión automática en segundos (si la longitud es ≥ 16) |

Con longitud ≥ 40, los bytes 21 a 42 de la respuesta son el número de serie
ASCII.

## Asignación de una tecla

Cada tecla ocupa 4 bytes: `tipo, código1, código2, código3`.

| Tipo | Significado | Códigos |
|---|---|---|
| 16 | Botón de ratón | c1 = máscara: 1 izq, 2 der, 4 central, 8 atrás, 16 adelante; c3 = rueda (1 arriba, 255 abajo) |
| 17 | Mover el cursor | c1 bit 3 = vertical hacia arriba, bit 7 = horizontal hacia la izquierda; c2 = píxeles en horizontal; c3 = píxeles en vertical |
| 19 | Desactivada | — |
| 31 | Control de luz | c1 = acción (0 encender/apagar, 1 efecto, 2 brillo−, 4 color, 5 velocidad+, 6 velocidad−, 19 cambiar perfil, 20 dirección, 25 bloquear teclado) |
| 32 | Tecla de teclado | c1 = máscara de modificadores, c2 = uso HID |
| 48 | Multimedia | c1 = código de consumo, c2 = página (0 consumer, 1 y 2 páginas extendidas) |
| 64 | Sistema | c1: 1 apagar, 2 suspender, 4 despertar |
| 96 | Macro | c1 = índice de macro (0-15), c2 = repeticiones |
| 112 | Rueda de perfil | c1: 1 arriba, 255 abajo |
| 128 | Abrir web | usa el buffer de URL |

Máscara de modificadores del tipo 32: bit 0 LCtrl, 1 LShift, 2 LAlt, 3 LWin,
4 RCtrl, 5 RShift, 6 RAlt, 7 RWin.

## Luz (11 bytes)

| Offset | Campo |
|---|---|
| 0 | tipo, siempre 1 |
| 1 | reservado |
| 2 | modo o efecto |
| 3 | brillo, 0 a 4 |
| 4 | velocidad, 0 a 4 |
| 5 | dirección, 0 o 1 |
| 6 | 1 si usa el color fijo, 0 si el efecto elige color |
| 7 | índice de color único |
| 8 | matiz, 0 a 255 sobre 360° |
| 9 | saturación, 0 a 255 |
| 10 | valor, 0 a 255 |

Con el modo 0 el byte 6 se fuerza a 0.

## Buffer de macros (4096 bytes)

```
0..31     puntero LE16 de cada una de las 16 macros
32..63    relleno 0xFF
64..4095  eventos
```

Puntero `0xFFFF` o con byte bajo 0 significa macro vacía.

Cada evento ocupa 4 bytes: `retardoLo, retardoHi, flags, código`.

- bit 7 de flags: último evento de la macro
- bit 6 de flags: 1 pulsar, 0 soltar
- bits 0-5 de flags: 3 botón de ratón, 2 tecla, 4 rueda vertical, 5 rueda horizontal

El retardo es el tiempo en milisegundos antes del siguiente evento.

## Actualización de firmware

No está implementada en esta app, pero el configurador oficial usa el comando
`85` (`[255, 0, 0]` iniciar, `[255, 1, 0]` entrar en bootloader,
`[255, 2, 4, …]` fijar dirección y tamaño, `[255, 4, 0]` verificar,
`[255, 5, 1, 1]` terminar) y el comando `90` con `[160]` para MCU Artery.
Escribir firmware mal puede dejar el teclado inservible.
