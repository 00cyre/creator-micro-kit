// Wire protocol for the Work Louder Creator Micro 2 vendor HID interface.
//
// The keypad exposes a JSON-RPC server on its raw-HID interface (usage page
// 0xFF00). Requests are `{method, params, id}`; replies are `{result, id,
// method}` or `{error: {code, message}, id}`. Unsolicited device events use a
// shorter envelope, `{m: method, p: params}`.

/** USB vendor id shared by Work Louder devices (an Espressif id). */
export const VENDOR_ID = 0x303a;

/** USB product ids, by device. */
export const PRODUCT_IDS = {
  creatorMicroV2: 0x8298,
  creatorMicroV2Alt: 0x8297,
  codexMicro: 0x8360,
};

/** Generic firmware methods. */
export const Methods = {
  firmwareVersion: "sys.version",
  deviceStatus: "device.status",
  lightingPreview: "lights.preview",
  homeAccentColor: "ui.home_accent_color",
  focusedApp: "host.focused_app",
};

// Vendor methods added for the ChatGPT integration. Despite the name they are
// generic: the firmware holds no opinion about what any colour means, the host
// supplies every value. They are the only per-key colour path this firmware has.
export const VendorMethods = {
  /** Per-thread accent lighting; paints the KV_OAI_AG* keys. */
  threadLighting: "v.oai.thstatus",
  /** Ambient ring and key backlight configuration. */
  zoneConfig: "v.oai.rgbcfg",
};

/** Unsolicited event names. */
export const Events = {
  key: "v.oai.hid",
  joystick: "v.oai.rad",
};

/** LED animation effects, by firmware index. */
export const Effect = {
  off: 0,
  solid: 1,
  snake: 2,
  rainbow: 3,
  breath: 4,
  gradient: 5,
  shallowBreath: 6,
};

/** Effect names accepted by `lights.preview`, which takes strings not indexes. */
export const EffectName = {
  0: "off",
  1: "solid",
  2: "snake",
  3: "rainbow",
  4: "breath",
  5: "gradient",
  6: "shallow_breath",
};

/**
 * Per-key colours only appear on layers whose keymap contains KV_OAI_* keycodes.
 * On any other layer the firmware applies that layer's own stored zone lighting
 * and ignores thread lighting entirely.
 */
export const AGENT_KEYCODES = Object.freeze(
  Array.from({ length: 20 }, (_, index) => `KV_OAI_AG${String(index).padStart(2, "0")}`),
);

/** Accepts `"#RRGGBB"`, `"RGB"`, or a packed integer; returns a packed integer. */
export function toPackedColor(color) {
  if (typeof color === "number") return color & 0xffffff;
  if (typeof color !== "string") throw new TypeError(`Unsupported color: ${color}`);
  let hex = color.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(hex)) hex = [...hex].map((c) => c + c).join("");
  if (!/^[0-9a-f]{6}$/i.test(hex)) throw new TypeError(`Unsupported color: ${color}`);
  return Number.parseInt(hex, 16);
}

/** Formats a packed integer as `"#RRGGBB"`. */
export function toHexColor(packed) {
  return `#${(packed & 0xffffff).toString(16).toUpperCase().padStart(6, "0")}`;
}

function normalized(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || value < 0 || value > 1) {
    throw new RangeError(`Expected a value between 0 and 1, received ${value}`);
  }
  return value;
}

/** Builds one `v.oai.thstatus` entry. Only `id` is required. */
export function threadEntry(thread) {
  if (typeof thread?.id !== "number") throw new TypeError("Each thread needs a numeric id");
  const entry = { id: thread.id };
  if (thread.color !== undefined) entry.c = toPackedColor(thread.color);
  if (thread.brightness !== undefined) entry.b = normalized(thread.brightness);
  if (thread.effect !== undefined) entry.e = thread.effect;
  if (thread.speed !== undefined) entry.s = normalized(thread.speed);
  if (thread.syncKeys !== undefined) entry.sk = thread.syncKeys ? 1 : 0;
  if (thread.syncAmbient !== undefined) entry.sa = thread.syncAmbient ? 1 : 0;
  return entry;
}

/** Builds one zone of a `v.oai.rgbcfg` payload. */
export function zoneEntry(zone = {}) {
  return {
    e: zone.effect ?? Effect.solid,
    b: normalized(zone.brightness, 1),
    s: normalized(zone.speed, 0),
    m: zone.magic ?? 1,
    c: toPackedColor(zone.color ?? 0xffffff),
  };
}

/** Builds one side of a `lights.preview` payload, which uses long field names. */
export function previewSide(side = {}) {
  return {
    effect: typeof side.effect === "number" ? EffectName[side.effect] : (side.effect ?? "solid"),
    brightness: normalized(side.brightness, 1),
    speed: normalized(side.speed, 0.5),
    magic: side.magic ?? 1,
    color: toPackedColor(side.color ?? 0xffffff),
  };
}
