import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fakeBridge = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-bridge.js");

/** Loads the device module with the fake bridge selected, in the given mode. */
async function withFake(mode, run) {
  process.env.CMK_BRIDGE_PATH = fakeBridge;
  if (mode) process.env.CMK_FAKE = mode;
  else delete process.env.CMK_FAKE;
  // A cache-busting query gives each mode a fresh module, since the bridge path
  // is read once at import time.
  const { CreatorMicro } = await import(`../src/device.js?fake=${mode ?? "ready"}`);
  return run(CreatorMicro);
}

test("open reports the device the bridge selected", async () => {
  await withFake("ready", async (CreatorMicro) => {
    const device = await CreatorMicro.open();
    assert.equal(device.info.product, "Fake Creator Micro");
    assert.equal(device.info.transport, "USB");
    assert.equal(device.closed, false);
    await device.close();
    assert.equal(device.closed, true);
  });
});

test("calls resolve with the firmware's result", async () => {
  await withFake("ready", async (CreatorMicro) => {
    const device = await CreatorMicro.open();
    assert.deepEqual(await device.call("sys.version"), { echo: "sys.version", params: null });
    assert.deepEqual(
      await device.setZones({ ambient: { color: "#000000" }, keys: { color: "#FFFFFF" } }),
      { echo: "v.oai.rgbcfg", params: { ambient: { e: 1, b: 1, s: 0, m: 1, c: 0 }, keys: { e: 1, b: 1, s: 0, m: 1, c: 0xffffff } } },
    );
    await device.close();
  });
});

test("a reply for another client's method is not mistaken for ours", async () => {
  // The device broadcasts every reply to every reader, and the Input app keeps
  // its own connection open, so ids collide. Matching the method is what makes
  // that harmless — here every reply names a method we never called.
  await withFake("crosstalk", async (CreatorMicro) => {
    const device = await CreatorMicro.open();
    await assert.rejects(
      device.call("sys.version", null, { timeout: 250 }),
      /Timed out calling sys\.version/,
    );
    await device.close();
  });
});

test("decodes key, joystick and log events", async () => {
  await withFake("events", async (CreatorMicro) => {
    const device = await CreatorMicro.open();
    const keys = [];
    const joysticks = [];
    const logs = [];
    device.on("key", (event) => keys.push(event));
    device.on("joystick", (event) => joysticks.push(event));
    device.on("log", (line) => logs.push(line));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(keys, [
      { key: "AG03", pressed: true, agent: undefined },
      { key: "AG03", pressed: false, agent: undefined },
    ]);
    assert.deepEqual(joysticks, [{ angle: 0.25, distance: 0.5 }]);
    assert.deepEqual(logs, ["firmware says hello"]);
    await device.close();
  });
});

test("a bridge that never connects reports its own diagnostics", async () => {
  await withFake("fail", async (CreatorMicro) => {
    await assert.rejects(CreatorMicro.open(), /no Work Louder device found/);
  });
});

test("open gives up when the bridge says nothing", async () => {
  await withFake("silent", async (CreatorMicro) => {
    await assert.rejects(CreatorMicro.open({ timeout: 250 }), /Timed out waiting for the device/);
  });
});

test("in-flight calls fail as soon as the device drops", async () => {
  // `crosstalk` answers, but never with our method, so the call is still
  // pending when we close: the rejection must come from close, not the timeout.
  await withFake("crosstalk", async (CreatorMicro) => {
    const device = await CreatorMicro.open();
    const pending = device.call("sys.version", null, { timeout: 30_000 });
    // Attach the expectation before closing: close rejects synchronously, and
    // an unhandled rejection in between would fail the run.
    const rejected = assert.rejects(pending, /Device is closed/);
    await device.close();
    await rejected;
  });
});

test("close stops the bridge process and reports it", async () => {
  await withFake("ready", async (CreatorMicro) => {
    const device = await CreatorMicro.open();
    const closed = once(device, "close");
    await device.close();
    await closed;
    assert.equal(device.connected, false);
    await assert.rejects(device.call("sys.version"), /Device is closed/);
  });
});

test("reconnect re-opens after the device drops", async () => {
  const marker = path.join(os.tmpdir(), `cmk-reconnect-${process.pid}-${Date.now()}`);
  process.env.CMK_FAKE_MARKER = marker;
  try {
    await withFake("die-once", async (CreatorMicro) => {
      const device = await CreatorMicro.open({ reconnect: true, reconnectDelay: 50 });
      const dropped = once(device, "close");
      const back = once(device, "reconnect");
      await dropped;
      assert.equal(device.connected, false, "no transport between the drop and the reconnect");
      await assert.rejects(device.call("sys.version"), /Device disconnected/);
      const [info] = await back;
      assert.equal(info.product, "Fake Creator Micro");
      assert.equal(device.connected, true);
      assert.deepEqual(await device.call("sys.version"), { echo: "sys.version", params: null });
      await device.close();
    });
  } finally {
    fs.rmSync(marker, { force: true });
    delete process.env.CMK_FAKE_MARKER;
  }
});

test("listDevices returns what the bridge enumerated", async () => {
  await withFake("ready", async (CreatorMicro) => {
    // The fake ignores --list and just says ready, so nothing is enumerated.
    assert.deepEqual(await CreatorMicro.listDevices(), []);
  });
});
