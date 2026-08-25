import test from "node:test";
import assert from "node:assert/strict";
import {
  Effect,
  toHexColor,
  toPackedColor,
  threadEntry,
  zoneEntry,
  previewSide,
  AGENT_KEYCODES,
} from "../src/protocol.js";

test("parses the colour forms the firmware needs as packed integers", () => {
  assert.equal(toPackedColor("#2D7FF9"), 0x2d7ff9);
  assert.equal(toPackedColor("2d7ff9"), 0x2d7ff9);
  assert.equal(toPackedColor("#F00"), 0xff0000);
  assert.equal(toPackedColor(0x00c853), 0x00c853);
  assert.equal(toHexColor(0x2d7ff9), "#2D7FF9");
  assert.throws(() => toPackedColor("not a colour"), TypeError);
});

test("thread entries omit fields the caller left out", () => {
  assert.deepEqual(threadEntry({ id: 3 }), { id: 3 });
  assert.deepEqual(threadEntry({ id: 0, color: "#FF8C00", syncAmbient: true, syncKeys: false }), {
    id: 0, c: 0xff8c00, sa: 1, sk: 0,
  });
  assert.throws(() => threadEntry({ color: "#FFF" }), TypeError);
  assert.throws(() => threadEntry({ id: 0, brightness: 2 }), RangeError);
});

test("zone entries fill in the firmware's defaults", () => {
  assert.deepEqual(zoneEntry({ color: "#000000" }), { e: Effect.solid, b: 1, s: 0, m: 1, c: 0 });
});

test("lighting previews use effect names, not indexes", () => {
  assert.equal(previewSide({ effect: Effect.rainbow }).effect, "rainbow");
  assert.equal(previewSide({ effect: Effect.shallowBreath }).effect, "shallow_breath");
  assert.equal(previewSide({}).effect, "solid");
});

test("agent keycodes match the firmware's naming", () => {
  assert.equal(AGENT_KEYCODES[0], "KV_OAI_AG00");
  assert.equal(AGENT_KEYCODES[5], "KV_OAI_AG05");
  assert.equal(AGENT_KEYCODES.length, 20);
});
