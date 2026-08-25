import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

import {
  Events,
  Methods,
  VendorMethods,
  previewSide,
  threadEntry,
  zoneEntry,
} from "./protocol.js";

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bridgePath = path.join(packageRoot, "build", "cm-bridge");

// Firmware ids are constrained to three digits; only one request is ever in
// flight, so a rolling counter is enough to match replies to callers.
const MAX_REQUEST_ID = 999;

/**
 * A connected Creator Micro. Emits `key`, `joystick`, `log`, `notify` and
 * `close`; every method returns a promise resolving to the firmware's reply.
 */
export class CreatorMicro extends EventEmitter {
  #bridge;
  #pending = new Map();
  #nextId = 1;
  #closed = false;

  constructor(bridge, info) {
    super();
    this.#bridge = bridge;
    this.info = info;
  }

  static async open({ productId, timeout = 5000 } = {}) {
    if (process.platform !== "darwin") {
      throw new Error("creator-micro-kit currently supports macOS only");
    }
    if (!fs.existsSync(bridgePath)) {
      throw new Error(`Native bridge is missing at ${bridgePath}. Run \`npm run build\`.`);
    }

    const args = productId === undefined ? [] : [String(productId)];
    const bridge = spawn(bridgePath, args, { stdio: ["pipe", "pipe", "pipe"] });
    const lines = createInterface({ input: bridge.stdout });

    const device = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for the device")), timeout);
      const onFirstLine = (line) => {
        let message;
        try { message = JSON.parse(line); } catch { return; }
        if (message.type === "ready") {
          clearTimeout(timer);
          lines.off("line", onFirstLine);
          resolve(new CreatorMicro(bridge, message));
        } else if (message.type === "error") {
          clearTimeout(timer);
          reject(new Error(message.message));
        }
      };
      lines.on("line", onFirstLine);
      bridge.once("error", (error) => { clearTimeout(timer); reject(error); });
      bridge.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Native bridge exited with code ${code} before connecting`));
      });
    });

    lines.on("line", (line) => device.#receive(line));
    bridge.once("exit", () => { device.#closed = true; device.emit("close"); });
    return device;
  }

  #receive(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }

    if (message.type === "log") return void this.emit("log", message.data);
    if (message.type === "error") return void this.emit("error", new Error(message.message));

    if (message.type === "rpc") {
      const settle = this.#pending.get(String(message.data?.id));
      if (!settle) return;
      this.#pending.delete(String(message.data.id));
      if (message.data.error) settle.reject(new Error(message.data.error.message ?? "RPC failed"));
      else settle.resolve(message.data.result);
      return;
    }

    if (message.type !== "notify") return;
    const { m: method, p: params } = message.data ?? {};
    this.emit("notify", { method, params });
    if (method === Events.key) {
      this.emit("key", { key: params?.k, pressed: params?.act === 1, agent: params?.ag });
    } else if (method === Events.joystick) {
      this.emit("joystick", { angle: params?.a, distance: params?.d });
    }
  }

  /** Sends a raw JSON-RPC request. Useful for methods this class does not wrap. */
  call(method, params = null, { timeout = 5000 } = {}) {
    if (this.#closed) return Promise.reject(new Error("Device is closed"));
    const id = this.#nextId % MAX_REQUEST_ID;
    this.#nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(String(id));
        reject(new Error(`Timed out calling ${method}`));
      }, timeout);
      this.#pending.set(String(id), {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.#bridge.stdin.write(`${JSON.stringify({ method, params, id })}\n`);
    });
  }

  getFirmwareVersion() {
    return this.call(Methods.firmwareVersion).then((result) => result?.version);
  }

  getStatus() {
    return this.call(Methods.deviceStatus);
  }

  /**
   * Sets per-key accent colours. Each entry needs an `id` (the key's index in
   * the KV_OAI_AG* row); `color`, `brightness`, `effect`, `speed`, `syncKeys`
   * and `syncAmbient` are optional and omitted fields stay unchanged.
   *
   * Only takes effect on layers whose keymap contains KV_OAI_* keycodes.
   */
  setThreadColors(threads) {
    if (!Array.isArray(threads)) throw new TypeError("setThreadColors expects an array");
    return this.call(VendorMethods.threadLighting, threads.map(threadEntry));
  }

  /** Sets the ambient ring and the backlight of keys no thread has claimed. */
  setZones({ ambient, keys } = {}) {
    return this.call(VendorMethods.zoneConfig, {
      ambient: zoneEntry(ambient),
      keys: zoneEntry(keys),
    });
  }

  /**
   * Applies a non-persistent lighting preview to the whole board. This works on
   * any layer, unlike thread colours, but is zone-level only. The firmware
   * re-applies the layer's stored lighting when the active layer changes, so
   * re-send to hold a value.
   */
  previewLighting({ backlight, underglow } = {}) {
    const payload = {};
    if (backlight) payload.backlight = previewSide(backlight);
    if (underglow) payload.underglow = previewSide(underglow);
    return this.call(Methods.lightingPreview, payload);
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#bridge.stdin.end();
    this.#bridge.kill();
  }
}
