#!/usr/bin/env node
// Shows the state of your Claude Code sessions on the keypad's keys.
//
//   blue    working — the assistant is mid-turn
//   amber   stalled — mid-turn but quiet, usually a prompt waiting on you
//   green   your turn — the assistant finished and is waiting for a reply
//   dim     idle — nothing recent
//   off     no session for that key
//
// Key N shows the Nth most recently active session, matching what Cmd+N
// selects in the app. Press a key to see which session it is; pass --switch
// to have it actually switch (needs Accessibility permission for the terminal).
//
// Per-key colour only works on a layer whose keymap carries KV_OAI_* keycodes
// — this checks the device's own keymap and says so if you are on another one.
import { execFile } from "node:child_process";
import { open, Effect } from "../src/index.js";
import { sessionStatuses, State } from "./claude-sessions.js";

const KEYS = 6;
const REPAINT_MS = 2000;
const switching = process.argv.includes("--switch");

// Most urgent first: what the board shows when it can only show one colour.
const PRIORITY = [State.stalled, State.yourTurn, State.working, State.idle];

const LOOK = {
  [State.working]:  { color: "#2D7FF9", brightness: 1,    label: "working"   },
  [State.stalled]:  { color: "#FF8C00", brightness: 1,    label: "stalled"   },
  [State.yourTurn]: { color: "#00C853", brightness: 1,    label: "your turn" },
  [State.idle]:     { color: "#3A3A3A", brightness: 0.25, label: "idle"      },
};
const EMPTY = { color: "#000000", brightness: 0, label: "—" };

const stamp = () => new Date().toISOString().slice(11, 19);
const say = (...parts) => console.log(stamp(), ...parts);

const device = await open({ reconnect: true, reconnectDelay: 2000 });
say(`connected to ${device.info.product} over ${device.info.transport}`);

// Which layers can show per-key colour at all.
const keymap = JSON.parse((await device.readFile("keymap.json")).toString("utf8"));
const paintable = new Map();
for (const profile of keymap.profiles) {
  profile.layers.forEach((layer, index) => {
    const codes = layer.layout.keymap.flat();
    paintable.set(`${profile.id}/${index}`, {
      name: layer.name,
      ok: codes.some((code) => code.startsWith("KV_OAI")),
    });
  });
}
const paintableList = [...paintable.entries()].filter(([, l]) => l.ok).map(([k, l]) => `${k} (${l.name})`);
say(`layers that can show per-key colour: ${paintableList.join(", ") || "none"}`);

let lastSignature = null;
let lastLayerKey = null;
let lastAggregate = null;

async function tick() {
  const sessions = sessionStatuses().slice(0, KEYS);

  const threads = [];
  for (let id = 0; id < KEYS; id += 1) {
    const session = sessions[id];
    const look = session ? LOOK[session.state] : EMPTY;
    threads.push({ id, color: look.color, brightness: look.brightness, effect: Effect.solid });
  }
  // Fields left out keep their old value on the device, so every update sends
  // brightness and effect as well as colour.
  await device.setThreadColors(threads);

  const signature = sessions.map((s) => `${s.sessionId}:${s.state}`).join("|");
  if (signature !== lastSignature) {
    lastSignature = signature;
    console.log(`\n${stamp()} ── keys now show ──`);
    for (let id = 0; id < KEYS; id += 1) {
      const session = sessions[id];
      const look = session ? LOOK[session.state] : EMPTY;
      const age = session?.quietFor === undefined ? "" : `${(session.quietFor / 60000).toFixed(0)}m ago`;
      console.log(`  key ${id + 1}  ${look.color}  ${look.label.padEnd(9)} ${(session?.name ?? "").padEnd(32)} ${age}`);
    }
  }

  const status = await device.getStatus();
  const layerKey = `${status.profile_index}/${status.layer_index}`;
  const layer = paintable.get(layerKey);

  if (!layer?.ok) {
    // This layer cannot show per-key colour, but lights.preview works on any
    // layer — so show the single most urgent state across all six instead of
    // nothing. Board-wide is a real downgrade, not a substitute.
    const worst = PRIORITY.find((state) => sessions.some((s) => s.state === state));
    const look = worst ? LOOK[worst] : EMPTY;
    const side = { effect: Effect.solid, color: look.color, brightness: look.brightness, speed: 0 };
    await device.previewLighting({ backlight: side, underglow: side });
    if (layerKey !== lastLayerKey || worst !== lastAggregate) {
      lastAggregate = worst;
      say(`layer ${layerKey} (${layer?.name ?? "?"}) cannot show per-key colour — whole board = ${look.label} ${look.color}`);
    }
  } else if (layerKey !== lastLayerKey) {
    say(`on layer ${layerKey} (${layer.name}) — per-key colours are showing`);
  }
  lastLayerKey = layerKey;
}

device.on("key", ({ key, pressed }) => {
  if (!pressed || !/^AG\d\d$/.test(key ?? "")) return;
  const slot = Number(key.slice(2));
  const session = sessionStatuses()[slot];
  say(`key ${slot + 1} pressed → ${session ? `${session.name} (${session.state})` : "no session"}`);
  if (!switching) return;
  execFile("osascript", [
    "-e", `tell application "System Events" to keystroke "${slot + 1}" using command down`,
  ], (error) => { if (error) say(`  could not send Cmd+${slot + 1}: ${error.message}`); });
});

device.on("close", () => say("device dropped, reconnecting…"));
device.on("reconnect", () => { lastLayerKey = null; say("reconnected"); });

await tick();
const timer = setInterval(() => tick().catch((error) => say(`tick failed: ${error.message}`)), REPAINT_MS);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    clearInterval(timer);
    say("clearing keys and exiting");
    // Hand the keys back rather than leaving our colours frozen on them.
    await device.setThreadColors(
      Array.from({ length: KEYS }, (_, id) => ({ id, color: "#000000", brightness: 0, effect: Effect.off })),
    ).catch(() => {});
    await device.close();
    process.exit(0);
  });
}
