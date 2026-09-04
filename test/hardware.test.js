// End-to-end checks against a connected keypad. Opt in with CMK_HARDWARE=1;
// without it every case is skipped so `npm test` stays hardware-free.
//
// Non-destructive by construction: lighting calls are previews or vendor
// settings the Input app overwrites on the next layer change, and the only
// file touched is a scratch file this test creates and removes. It asserts
// that keymap.json is byte-identical before and after.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { CreatorMicro, Effect } from "../src/index.js";

const enabled = process.env.CMK_HARDWARE === "1";
const options = { skip: enabled ? false : "set CMK_HARDWARE=1 with a keypad connected" };
const SCRATCH = "_cmk_hardware_test.txt";

test("hardware", options, async (t) => {
  const devices = await CreatorMicro.listDevices();
  assert.ok(devices.length > 0, "no Work Louder device found");
  assert.ok(
    devices.some((device) => device.hasVendorCollection),
    "no connected device exposes the vendor HID collection",
  );

  const device = await CreatorMicro.open();
  let keymapBefore;
  try {
    await t.test("reports firmware version and status", async () => {
      assert.match(await device.getFirmwareVersion(), /^\d+\.\d+/);
      const status = await device.getStatus();
      assert.equal(typeof status.profile_index, "number");
      assert.equal(typeof status.layer_index, "number");
      assert.equal(typeof status.battery, "number");
    });

    await t.test("rejects a method the firmware does not have", async () => {
      await assert.rejects(device.call("nope.nope"), /Method not found/);
    });

    await t.test("lists the device filesystem with checksums", async () => {
      const files = await device.listFiles();
      keymapBefore = files.find((file) => file.name === "keymap.json");
      assert.ok(keymapBefore, "keymap.json is missing");
      assert.match(keymapBefore.checksum, /^[0-9a-f]{40}$/);
    });

    await t.test("reads a file back byte for byte", async () => {
      const keymap = await device.readFile("keymap.json");
      assert.equal(keymap.length, keymapBefore.size);
      assert.equal(createHash("sha1").update(keymap).digest("hex"), keymapBefore.checksum);
      JSON.parse(keymap.toString("utf8"));
    });

    await t.test("writes across chunk boundaries and verifies", async () => {
      // 7000 bytes is more than two 3072-byte chunks, so this exercises the
      // append path rather than a single-request write.
      const payload = Buffer.from("cmk".repeat(2334), "utf8");
      await device.writeFile(SCRATCH, payload);
      const back = await device.readFile(SCRATCH);
      assert.ok(back.equals(payload), "read back differs from what was written");
      await device.deleteFile(SCRATCH);
      const names = (await device.listFiles()).map((file) => file.name);
      assert.ok(!names.includes(SCRATCH), "scratch file survived deletion");
    });

    await t.test("accepts every lighting path", async () => {
      const side = { effect: Effect.solid, color: "#101010", brightness: 0.2 };
      await device.previewLighting({ backlight: side, underglow: side });
      assert.deepEqual(await device.setZones({ ambient: side, keys: side }), { ok: 1 });
      assert.deepEqual(
        await device.setThreadColors([{ id: 0, color: "#101010", brightness: 0.2, effect: Effect.solid }]),
        { ok: 1 },
      );
    });

    await t.test("leaves keymap.json untouched", async () => {
      const after = (await device.listFiles()).find((file) => file.name === "keymap.json");
      assert.deepEqual(after, keymapBefore);
    });
  } finally {
    await device.close();
  }
});
