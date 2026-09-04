# creator-micro-kit

Programmatic lighting and input control for the [Work Louder Creator Micro 2](https://worklouder.cc), from Node on macOS.

The keypad runs a JSON-RPC server on its vendor raw-HID collection. This library speaks it: set per-key colours, configure the ambient ring and key backlight, apply lighting previews, read and replace the keymap on the device's filesystem, and receive key and joystick events — without going through the Input app.

```js
import { open } from "creator-micro-kit";

const device = await open();

// Per-key colours, key 1 first. Send brightness and effect too — see below.
await device.setThreadColors([
  { id: 0, color: "#2D7FF9", brightness: 1, effect: 1, syncAmbient: true },
  { id: 1, color: "#00C853", brightness: 1, effect: 1 },
  { id: 2, color: "#FF8C00", brightness: 1, effect: 1 },
]);

device.on("key", ({ key, pressed }) => console.log(key, pressed ? "down" : "up"));

await device.close();
```

## Install

```sh
npm install creator-micro-kit
```

macOS only, and Xcode command line tools are needed to compile the native bridge (`xcode-select --install`).

The bridge is built by a `postinstall` script. That build only warns if it cannot run, so installing on a machine without the Swift toolchain does not fail the whole install — but nothing will open until you run `npm run build --prefix node_modules/creator-micro-kit` once.

## Why there is a native bridge

Node's hidapi bindings open macOS HID devices **exclusively** by default. The Creator Micro enumerates as a keyboard, so an exclusive open is refused with `kIOReturnNotPrivileged` unless the calling application holds Input Monitoring — which a terminal or a plain Node script generally does not.

Opening the same device **non-exclusively** through IOKit works without that grant. So the transport is a small Swift helper (`native/cm-bridge.swift`) that the library spawns once and talks to over line-delimited JSON on stdio. It also means this can run happily alongside the Input app, which keeps its own connection open.

## Transports

The keypad speaks the same protocol wired and wireless, and the library does not care which is in use — `device.info.transport` reports it.

Over USB the keypad publishes several HID devices: a keyboard, a consumer control, and the vendor collection. Only the vendor collection answers RPC. Over Bluetooth it publishes a single device carrying every collection, whose *primary* usage page is the keyboard's. So the bridge does not match on primary usage: it looks for usage page `0xFF00` anywhere in a device's usage pairs, and prefers a wired link over a wireless one when both are present. `creator-micro-kit devices` shows what it found and which entries can carry RPC.

A Bluetooth link drops whenever the keypad sleeps. Pass `reconnect: true` to have the library re-open it for you.

## API

### `open({ productId, serial, timeout, reconnect, reconnectDelay } = {})`

Opens the first connected Work Louder device and resolves to a `CreatorMicro`. `productId` and `serial` pick a specific one; `reconnect` re-spawns the transport after a drop, retrying every `reconnectDelay` ms (default 1000).

### `CreatorMicro.listDevices({ productId, serial } = {})`

Enumerates connected devices without opening one. Each entry reports `product`, `vendorId`, `productId`, `transport`, `serialNumber`, `locationId` and `hasVendorCollection` — the last being whether it can answer RPC at all.

### `device.setThreadColors(threads)`

Per-key accent colours. Each entry needs an `id` — the key's index in the `KV_OAI_AG*` row — and may set `color`, `brightness` (0–1), `effect`, `speed` (0–1), `syncKeys` and `syncAmbient`. Omitted fields stay unchanged on the device.

`syncAmbient` makes the ambient ring follow that key's colour; `syncKeys` does the same for the key backlight.

> **Always send `brightness` and `effect`, not just `color`.** Omitted fields keep their current value on the device — and after a power cycle that value is zero, so a colour-only update paints invisibly. `{ id, color, brightness: 1, effect: 1 }` is the minimum that is guaranteed to show.

> **This only takes effect on a layer whose keymap contains `KV_OAI_*` keycodes.** See [Per-key colours](#per-key-colours).

### `device.setZones({ ambient, keys })`

Sets the ambient ring and the backlight of any key no thread has claimed. Each zone takes `effect`, `brightness`, `speed`, `magic` and `color`.

### `device.previewLighting({ backlight, underglow })`

A non-persistent, board-wide lighting preview. Unlike thread colours this works on **any** layer, but it is zone-level only — every key gets the same colour.

Nothing is written to flash. The firmware re-applies the active layer's stored lighting whenever the layer changes, so re-send periodically to hold a value.

### `device.getFirmwareVersion()` / `device.getStatus()`

Status reports `{ version, profile_index, layer_index, battery, is_charging }`.

### `device.listFiles()` / `device.readFile(name)` / `device.writeFile(name, data)` / `device.deleteFile(name)`

The keypad's filesystem — `keymap.json` and `smart_actions.json` live there, and they are what the firmware actually runs. `listFiles` reports names, sizes and SHA-1 checksums; `writeFile` replaces a file using the delete-then-append-chunks sequence the official client uses, then re-reads the device's own checksum and throws if it does not match what was sent.

Writing `keymap.json` is how you change behaviour the Input app refuses to manage — for example, giving a layer `KV_OAI_AG*` keycodes so the firmware will colour its keys. The firmware may only pick the new file up after a replug. **Quit the Input app before writing:** the device buffers requests as a single byte stream, and two writers corrupt each other. Back up first — `creator-micro-kit pull keymap.json`.

### `device.call(method, params)`

Escape hatch for methods this library does not wrap.

### `device.connected` / `device.closed`

`connected` is true while a transport is live. `closed` is true once `close()` has been called, or the device dropped and no reconnect is coming.

### Events

| Event | Payload |
| --- | --- |
| `key` | `{ key: "AG00", pressed: true, agent }` |
| `joystick` | `{ angle, distance }` — both 0–1 |
| `log` | firmware debug line |
| `notify` | `{ method, params }` for any device event |
| `close` | the transport went away |
| `reconnect` | the new `device.info`, after `reconnect` re-opened it |
| `error` | a transport error; never fatal, and safe to ignore |

## CLI

```sh
npx creator-micro-kit devices
npx creator-micro-kit info
npx creator-micro-kit keys '#2D7FF9' '#00C853' '#FF8C00'
npx creator-micro-kit zones '#101010' '#FFFFFF'
npx creator-micro-kit preview rainbow
npx creator-micro-kit watch --reconnect
npx creator-micro-kit ls
npx creator-micro-kit pull keymap.json
npx creator-micro-kit push keymap.json ./keymap.json
```

`--product-id` and `--serial` pick a device; `push` confirms before writing unless given `-y`.

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

64-byte HID reports on the vendor collection (usage page `0xFF00`, usage `0x01`), which declares a 63-byte input, output and feature report under report id `0x06`:

| Byte | Meaning |
| --- | --- |
| 0 | report id, `0x06` |
| 1 | channel — `1` firmware debug, `2` JSON-RPC |
| 2 | payload length, up to 61 |
| 3–63 | UTF-8 payload |

Messages longer than 61 bytes span consecutive reports. The device buffers per channel and parses on line boundaries, so terminate each message with CRLF.

**Only one writer at a time.** The device has a single input buffer per channel; concurrent writers interleave mid-message and the firmware rejects the result as `JSON error - InvalidInput`.

### Requests and replies

Requests are `{"method": ..., "params": ..., "id": N}`, where `id` must be under 1000. Replies are `{"result": ..., "id": N, "method": ...}` or `{"error": {"code": ..., "message": ...}, "id": N, "method": ...}` — both name the method they answer.

Replies are broadcast to every open reader, so a reply carrying an id you are waiting on may still be another client's. Match the `method` as well as the `id`; this library does, which is what lets it share the device with the Input app.

### Methods

This is the whole surface. The firmware answers anything else with `{"code": 404, "message": "Method not found"}`, so the list was established by probing rather than inferred.

| Method | Params |
| --- | --- |
| `sys.version` | none → `{version}` |
| `device.status` | none → `{version, profile_index, layer_index, battery, is_charging}` |
| `lights.preview` | `{backlight, underglow}`, each `{effect, brightness, speed, magic, color}` |
| `host.focused_app` | host-supplied focus hint; returns null |
| `fs.list` | `{checksum}` → `[{name, size, checksum}]` |
| `fs.read` / `fs.readbin` | `{file, offset, len}` → `{data, total_size}` |
| `fs.write` / `fs.writebin` | `{file, data, append, completed, offset}` |
| `fs.delete` | `{file}` |
| `v.oai.thstatus` | array of `{id, c, b, e, s, sk, sa}` |
| `v.oai.rgbcfg` | `{ambient, keys}`, each `{e, b, s, m, c}` |

`lights.preview` takes effect **names**; the vendor methods take effect **indexes**. Colours are packed 24-bit integers. `brightness` and `speed` are 0–1.

The vendor methods return `{"ok": 1}` for any input, valid or not — they cannot be probed by response.

Notably absent: there is no method for changing the active profile or layer. Layer switching is a physical or Input-app affair.

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

## Tests

```sh
npm test                  # protocol and transport, no hardware needed
CMK_HARDWARE=1 npm test   # adds end-to-end checks against a connected keypad
```

The transport tests drive a scripted stand-in for the native bridge (`CMK_BRIDGE_PATH` selects it), so reconnects, timeouts and another client's replies are all covered without a device. The hardware pass is non-destructive: it only writes a scratch file, and asserts `keymap.json` is byte-identical afterwards.

## License

MIT
