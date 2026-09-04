import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";

import {
  Events,
  FileMethods,
  Methods,
  VendorMethods,
  previewSide,
  threadEntry,
  zoneEntry,
} from "./protocol.js";

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// CMK_BRIDGE_PATH swaps in a different transport binary. The tests use it to
// drive the protocol from a scripted stand-in instead of real hardware.
const bridgePath = process.env.CMK_BRIDGE_PATH || path.join(packageRoot, "build", "cm-bridge");

// Firmware request ids are constrained to three digits.
const MAX_REQUEST_ID = 999;
// The device broadcasts every reply to every open reader, so the Input app's
// ids land here too. Starting the counter somewhere random makes an overlap
// with another client's in-flight id unlikely; matching the reply's `method`
// (see #receive) is what actually makes a mismatch harmless.
const randomRequestId = () => 1 + Math.floor(Math.random() * (MAX_REQUEST_ID - 1));

function bridgeArguments({ productId, serial } = {}) {
  const args = [];
  if (productId !== undefined) args.push("--product-id", String(productId));
  if (serial !== undefined) args.push("--serial", String(serial));
  return args;
}

function assertUsable() {
  if (process.platform !== "darwin") {
    throw new Error("creator-micro-kit currently supports macOS only");
  }
  if (!fs.existsSync(bridgePath)) {
    throw new Error(`Native bridge is missing at ${bridgePath}. Run \`npm run build\`.`);
  }
}

/**
 * Spawns the bridge and resolves once it reports a device, or rejects with the
 * bridge's own diagnostics. Rejection tears the child down so a failed attempt
 * never leaves a stray process behind.
 */
function spawnBridge({ productId, serial, timeout = 5000 } = {}) {
  const bridge = spawn(bridgePath, bridgeArguments({ productId, serial }), {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: bridge.stdout });
  // stderr is small but must still be drained: an undrained pipe fills and
  // blocks the child. Keeping the text also turns a spawn failure into a
  // readable error instead of a bare exit code.
  let stderr = "";
  bridge.stderr.setEncoding("utf8");
  bridge.stderr.on("data", (chunk) => { stderr += chunk; });

  return new Promise((resolve, reject) => {
    const fail = (error) => {
      clearTimeout(timer);
      cleanup();
      lines.close();
      bridge.kill();
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error("Timed out waiting for the device")), timeout);

    const onLine = (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.type === "ready") {
        clearTimeout(timer);
        cleanup();
        resolve({ bridge, lines, info: message });
      } else if (message.type === "error") {
        fail(new Error(message.message));
      }
    };
    const onError = (error) => fail(error);
    const onExit = (code) => {
      const detail = stderr.trim();
      fail(new Error(
        `Native bridge exited with code ${code} before connecting${detail ? `: ${detail}` : ""}`,
      ));
    };
    const cleanup = () => {
      lines.off("line", onLine);
      bridge.off("error", onError);
      bridge.off("exit", onExit);
    };

    lines.on("line", onLine);
    bridge.on("error", onError);
    bridge.on("exit", onExit);
  });
}

/**
 * A connected Creator Micro. Emits `key`, `joystick`, `log`, `notify`, `close`
 * and — when opened with `reconnect` — `reconnect`; every method returns a
 * promise resolving to the firmware's reply.
 */
export class CreatorMicro extends EventEmitter {
  #bridge;
  #lines;
  #options;
  #pending = new Map();
  #nextId = randomRequestId();
  // #closing is set by close(); #closed means there is no bridge and none is
  // coming. Between a drop and a successful reconnect both are false.
  #closing = false;
  #closed = false;
  #reconnecting = false;
  #wakeReconnect;

  constructor(bridge, lines, info, options = {}) {
    super();
    this.info = info;
    this.#options = options;
    // A transport error with no listener must not crash the host process
    // (Node throws on unhandled 'error' events). Callers can still subscribe.
    this.on("error", () => {});
    this.#attach(bridge, lines);
  }

  /** Lists every connected Work Louder HID device without opening one. */
  static listDevices({ productId, serial, timeout = 5000 } = {}) {
    assertUsable();
    const args = ["--list", ...bridgeArguments({ productId, serial })];
    const bridge = spawn(bridgePath, args, { stdio: ["ignore", "pipe", "pipe"] });
    return new Promise((resolve, reject) => {
      let out = "";
      const timer = setTimeout(() => {
        bridge.kill();
        reject(new Error("Timed out listing devices"));
      }, timeout);
      bridge.stdout.setEncoding("utf8");
      bridge.stdout.on("data", (chunk) => { out += chunk; });
      bridge.on("error", (error) => { clearTimeout(timer); reject(error); });
      bridge.on("exit", () => {
        clearTimeout(timer);
        for (const line of out.split("\n")) {
          try {
            const message = JSON.parse(line);
            if (message.type === "devices") return resolve(message.data);
          } catch { /* not a complete JSON line */ }
        }
        resolve([]);
      });
    });
  }

  /**
   * Opens the first connected Creator Micro. `productId` and `serial` pick a
   * specific one; `reconnect` re-spawns the bridge after the device drops,
   * which a Bluetooth link does whenever the keypad sleeps.
   */
  static async open(options = {}) {
    assertUsable();
    const { bridge, lines, info } = await spawnBridge(options);
    return new CreatorMicro(bridge, lines, info, options);
  }

  /** True once `close()` has been called, or the bridge exited for good. */
  get closed() {
    return this.#closed;
  }

  /** True while a bridge is live and able to carry a request. */
  get connected() {
    return !this.#closed && Boolean(this.#bridge?.stdin.writable);
  }

  #attach(bridge, lines) {
    this.#bridge = bridge;
    this.#lines = lines;
    lines.on("line", (line) => this.#receive(line));
    bridge.once("exit", () => this.#onBridgeExit());
  }

  #onBridgeExit() {
    // Nothing can answer an in-flight request any more, so fail them now
    // rather than making every caller wait out its own timeout.
    this.#rejectPending(new Error(this.#closing ? "Device is closed" : "Device disconnected"));
    if (!this.#closing && this.#options.reconnect) {
      this.emit("close");
      this.#reconnect();
      return;
    }
    this.#closed = true;
    this.emit("close");
  }

  async #reconnect() {
    if (this.#reconnecting || this.#closing) return;
    this.#reconnecting = true;
    const delay = this.#options.reconnectDelay ?? 1000;
    while (!this.#closing) {
      // Waiting is interruptible: close() wakes it so a long reconnectDelay
      // neither holds the process open nor delays the shutdown.
      await new Promise((resolve) => {
        this.#wakeReconnect = resolve;
        setTimeout(resolve, delay).unref?.();
      });
      this.#wakeReconnect = undefined;
      if (this.#closing) break;
      try {
        const { bridge, lines, info } = await spawnBridge(this.#options);
        this.info = info;
        this.#lines?.close();
        this.#attach(bridge, lines);
        this.#reconnecting = false;
        this.emit("reconnect", info);
        return;
      } catch (error) {
        this.emit("error", error);
      }
    }
    this.#reconnecting = false;
  }

  #rejectPending(error) {
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const settle of pending) settle.reject(error);
  }

  #receive(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }

    if (message.type === "log") return void this.emit("log", message.data);
    if (message.type === "error") return void this.emit("error", new Error(message.message));

    if (message.type === "rpc") {
      const reply = message.data ?? {};
      const key = String(reply.id);
      const settle = this.#pending.get(key);
      // An id we are not waiting on belongs to another client — the Input app
      // keeps its own connection open and the device broadcasts every reply.
      if (!settle) return;
      // Replies name the method they answer. A disagreement means this reply
      // is another client's, sent while it happened to be using our id.
      if (reply.method !== undefined && reply.method !== settle.method) return;
      this.#pending.delete(key);
      if (reply.error) settle.reject(new Error(reply.error.message ?? "RPC failed"));
      else settle.resolve(reply.result);
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
    // With `reconnect` there is a gap between a drop and the next bridge.
    if (!this.#bridge?.stdin.writable) {
      return Promise.reject(new Error("Device disconnected"));
    }
    const id = this.#nextId % MAX_REQUEST_ID;
    this.#nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(String(id));
        reject(new Error(`Timed out calling ${method}`));
      }, timeout);
      this.#pending.set(String(id), {
        method,
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
   * and `syncAmbient` are optional and omitted fields stay unchanged — which
   * after a power cycle means zero, so send `brightness` and `effect` too.
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

  /** Lists files on the device filesystem, with sizes and SHA-1 checksums. */
  listFiles() {
    return this.call(FileMethods.list, { checksum: true });
  }

  /** Reads a whole file from the device filesystem as a Buffer. */
  async readFile(name, { chunkSize = 1024 } = {}) {
    const parts = [];
    let offset = 0;
    let total = Infinity;
    while (offset < total) {
      const chunk = await this.call(FileMethods.readBinary, { file: name, offset, len: chunkSize });
      total = chunk.total_size;
      const data = Buffer.from(chunk.data, "base64");
      if (data.length === 0) break;
      parts.push(data);
      offset += data.length;
    }
    return Buffer.concat(parts);
  }

  /**
   * Replaces a file on the device filesystem: delete, then append base64
   * chunks of up to 3072 raw bytes (4096 base64 characters, the firmware's
   * per-request limit) with `completed` set on the last one.
   *
   * The device buffers requests as one byte stream, so nothing else may be
   * writing to it while this runs — including the Input app.
   *
   * Verifies by default: `fs.list` reports a SHA-1 per file, so a truncated or
   * interleaved write is caught here rather than at the next power cycle.
   */
  async writeFile(name, data, { chunkSize = 3072, verify = true } = {}) {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    await this.call(FileMethods.delete, { file: name }).catch(() => {});
    for (let offset = 0; offset < buffer.length; offset += chunkSize) {
      const slice = buffer.subarray(offset, offset + chunkSize);
      await this.call(FileMethods.writeBinary, {
        file: name,
        data: slice.toString("base64"),
        append: true,
        completed: offset + chunkSize >= buffer.length,
        offset,
      }, { timeout: 15000 });
    }
    if (!verify) return;
    const expected = createHash("sha1").update(buffer).digest("hex");
    const entry = (await this.listFiles()).find((file) => file.name === name);
    if (!entry) throw new Error(`Wrote ${name} but the device does not list it`);
    if (entry.checksum !== expected) {
      throw new Error(
        `Checksum mismatch after writing ${name}: device reports ${entry.checksum}, `
        + `expected ${expected}. The file on the device is not what was sent — `
        + "quit the Input app so nothing else is writing, then retry.",
      );
    }
  }

  /** Deletes a file from the device filesystem. */
  deleteFile(name) {
    return this.call(FileMethods.delete, { file: name });
  }

  async close() {
    if (this.#closing) return;
    this.#closing = true;
    this.#closed = true;
    this.#rejectPending(new Error("Device is closed"));
    this.#wakeReconnect?.();
    const bridge = this.#bridge;
    // Between a drop and a reconnect the child is already gone, and waiting on
    // an `exit` that has fired would never return.
    const running = bridge && bridge.exitCode === null && bridge.signalCode === null;
    if (running) {
      // Ask the bridge to exit so it can drain queued writes; kill only if it
      // does not take the hint.
      const exited = new Promise((resolve) => bridge.once("exit", resolve));
      if (bridge.stdin.writable) bridge.stdin.write("quit\n");
      bridge.stdin.end();
      const timer = setTimeout(() => bridge.kill(), 1000);
      await exited;
      clearTimeout(timer);
    } else {
      this.emit("close");
    }
    this.#lines?.close();
  }
}
