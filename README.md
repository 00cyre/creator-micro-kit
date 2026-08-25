# creator-micro-kit

Programmatic lighting and input control for the [Work Louder Creator Micro 2](https://worklouder.cc), from Node on macOS.

The keypad runs a JSON-RPC server on its vendor raw-HID interface. This library speaks it: set per-key colours, configure the ambient ring and key backlight, apply lighting previews, and receive key and joystick events — without going through the Input app.

```js
import { open } from "creator-micro-kit";

const device = await open();

// Per-key colours, key 1 first.
await device.setThreadColors([
  { id: 0, color: "#2D7FF9", syncAmbient: true },
  { id: 1, color: "#00C853" },
  { id: 2, color: "#FF8C00" },
]);

device.on("key", ({ key, pressed }) => console.log(key, pressed ? "down" : "up"));

await device.close();
```

## Install

```sh
npm install creator-micro-kit
```

macOS only, and Xcode command line tools are needed at install time to compile the native bridge (`xcode-select --install`).

## Why there is a native bridge

Node's hidapi bindings open macOS HID devices **exclusively** by default. The Creator Micro enumerates as a keyboard, so an exclusive open is refused with `kIOReturnNotPrivileged` unless the calling application holds Input Monitoring — which a terminal or a plain Node script generally does not.

Opening the same device **non-exclusively** through IOKit works without that grant. So the transport is a small Swift helper (`native/cm-bridge.swift`) that the library spawns once and talks to over line-delimited JSON on stdio. It also means this can run happily alongside the Input app, which keeps its own connection open.

## API

### `open({ productId, timeout } = {})`

Opens the first connected Work Louder device and resolves to a `CreatorMicro`. Pass `productId` to pick a specific one.

### `device.setThreadColors(threads)`

Per-key accent colours. Each entry needs an `id` — the key's index in the `KV_OAI_AG*` row — and may set `color`, `brightness` (0–1), `effect`, `speed` (0–1), `syncKeys` and `syncAmbient`. Omitted fields stay unchanged on the device.

`syncAmbient` makes the ambient ring follow that key's colour; `syncKeys` does the same for the key backlight.

> **This only takes effect on a layer whose keymap contains `KV_OAI_*` keycodes.** See [Per-key colours](#per-key-colours).

### `device.setZones({ ambient, keys })`

Sets the ambient ring and the backlight of any key no thread has claimed. Each zone takes `effect`, `brightness`, `speed`, `magic` and `color`.

### `device.previewLighting({ backlight, underglow })`

A non-persistent, board-wide lighting preview. Unlike thread colours this works on **any** layer, but it is zone-level only — every key gets the same colour.

Nothing is written to flash. The firmware re-applies the active layer's stored lighting whenever the layer changes, so re-send periodically to hold a value.

### `device.getFirmwareVersion()` / `device.getStatus()`

Status reports `{ version, profile_index, layer_index, battery, is_charging }`.

### `device.call(method, params)`

Escape hatch for methods this library does not wrap.

### Events

| Event | Payload |
| --- | --- |
| `key` | `{ key: "AG00", pressed: true, agent }` |
| `joystick` | `{ angle, distance }` — both 0–1 |
| `log` | firmware debug line |
| `notify` | `{ method, params }` for any device event |
| `close` | the bridge exited |

## CLI

```sh
npx creator-micro-kit info
npx creator-micro-kit keys '#2D7FF9' '#00C853' '#FF8C00'
npx creator-micro-kit zones '#101010' '#FFFFFF'
npx creator-micro-kit preview rainbow
npx creator-micro-kit watch
```

## Per-key colours

The firmware paints individual keys **only on layers whose keymap contains `KV_OAI_*` keycodes.** On any other layer it applies that layer's own stored zone lighting and ignores per-key colours entirely.

The Input app reflects this: it hides its lighting controls for those layers, because the device is driving their LEDs rather than the stored configuration.

So to colour keys individually, map them to `KV_OAI_AG00`…`KV_OAI_AG05` in Input. Those keycodes send no keystroke of their own — they emit a `key` event to the host instead, which is what the `key` event above delivers. Turn them back into whatever you want in your own code:

```js
const shortcuts = ["Cmd+1", "Cmd+2", "Cmd+3"];
device.on("key", ({ key, pressed }) => {
  if (!pressed || !key.startsWith("AG")) return;
  send(shortcuts[Number(key.slice(2))]);
});
```

## Protocol

Documented from observed device behaviour, for interoperability. Verified against firmware `0.6.2` on a Creator Micro 2 (`0x303A:0x8298`).

### Framing

64-byte HID reports on the vendor interface (usage page `0xFF00`):

| Byte | Meaning |
| --- | --- |
| 0 | report id, `0x06` |
| 1 | channel — `1` firmware debug, `2` JSON-RPC |
| 2 | payload length, up to 61 |
| 3–63 | UTF-8 payload |

Messages longer than 61 bytes span consecutive reports. The device buffers per channel and parses on line boundaries, so terminate each message with CRLF.

**Only one writer at a time.** The device has a single input buffer per channel; concurrent writers interleave mid-message and the firmware rejects the result as `JSON error - InvalidInput`.

### Requests and replies

Requests are `{"method": ..., "params": ..., "id": N}`, where `id` must be under 1000. Replies are `{"result": ..., "id": N, "method": ...}` or `{"error": {"code": ..., "message": ...}, "id": N}`.

Replies are visible to every open reader, so an unknown `id` is another client's traffic.

### Methods

| Method | Params |
| --- | --- |
| `sys.version` | none → `{version}` |
| `device.status` | none → `{version, profile_index, layer_index, battery, is_charging}` |
| `lights.preview` | `{backlight, underglow}`, each `{effect, brightness, speed, magic, color}` |
| `v.oai.thstatus` | array of `{id, c, b, e, s, sk, sa}` |
| `v.oai.rgbcfg` | `{ambient, keys}`, each `{e, b, s, m, c}` |

`lights.preview` takes effect **names**; the vendor methods take effect **indexes**. Colours are packed 24-bit integers. `brightness` and `speed` are 0–1.

The vendor methods return `{"ok": 1}` for any input, valid or not — they cannot be probed by response.

### Events

Device-to-host events use a shorter envelope, `{"m": method, "p": params}`:

| Event | Params |
| --- | --- |
| `v.oai.hid` | `{k: "AG00", act: 1}` — `act` is 1 press, 0 release |
| `v.oai.rad` | `{a: angle, d: distance}` |

### Effects

`off` 0, `solid` 1, `snake` 2, `rainbow` 3, `breath` 4, `gradient` 5, `shallowBreath` 6.

## Note on the `v.oai.*` names

These methods were added to the firmware for the ChatGPT integration and keep its naming, but nothing about them is specific to it — the firmware stores no meaning for any colour, the host supplies every value. They are simply the only per-key colour path this firmware exposes.

This library is an independent implementation written against observed device behaviour. It contains no code from Work Louder or OpenAI.

## License

MIT
