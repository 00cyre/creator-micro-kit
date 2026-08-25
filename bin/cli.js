#!/usr/bin/env node
import { open, Effect, toHexColor, toPackedColor } from "../src/index.js";

const [command, ...args] = process.argv.slice(2);

function usage() {
  console.log(`creator-micro-kit — programmatic control for the Work Louder Creator Micro 2

Usage:
  creator-micro-kit info                       firmware version and device status
  creator-micro-kit keys <color> [<color>...]  per-key colours, key 1 first
  creator-micro-kit zones <ambient> <keys>     ambient ring and unclaimed keys
  creator-micro-kit preview <effect> <color>   whole-board lighting preview
  creator-micro-kit watch                      print key and joystick events

Colours accept #RRGGBB, #RGB, or a packed integer.
Effects: ${Object.keys(Effect).join(", ")}

Per-key colours only appear on layers whose keymap uses KV_OAI_* keycodes.
On other layers the firmware applies that layer's own stored lighting instead.`);
}

if (!command || command === "--help" || command === "-h") {
  usage();
  process.exit(0);
}

const device = await open();
try {
  switch (command) {
    case "info": {
      console.log(`${device.info.product} (0x${device.info.productId.toString(16)})`);
      console.log(`firmware ${await device.getFirmwareVersion()}`);
      const status = await device.getStatus();
      console.log(`profile ${status.profile_index}  layer ${status.layer_index}  battery ${status.battery}%${status.is_charging ? " (charging)" : ""}`);
      break;
    }
    case "keys": {
      if (!args.length) throw new Error("keys needs at least one colour");
      await device.setThreadColors(args.map((color, id) => ({ id, color })));
      console.log(args.map((c, i) => `key ${i + 1} ${c}`).join(", "));
      break;
    }
    case "zones": {
      const [ambient, keys] = args;
      if (!ambient || !keys) throw new Error("zones needs an ambient and a keys colour");
      await device.setZones({ ambient: { color: ambient }, keys: { color: keys } });
      console.log(`ambient ${ambient}, keys ${keys}`);
      break;
    }
    case "preview": {
      const [effect, color = "#FFFFFF"] = args;
      if (!(effect in Effect)) throw new Error(`Unknown effect: ${effect}`);
      const side = { effect: Effect[effect], color };
      await device.previewLighting({ backlight: side, underglow: side });
      console.log(`preview ${effect} ${toHexColor(toPackedColor(color))}`);
      break;
    }
    case "watch": {
      console.log("watching for events, ctrl-c to stop");
      device.on("key", ({ key, pressed }) => console.log(`${key} ${pressed ? "down" : "up"}`));
      device.on("joystick", ({ angle, distance }) => console.log(`joystick angle=${angle} distance=${distance}`));
      await new Promise(() => {});
      break;
    }
    default:
      usage();
      process.exitCode = 1;
  }
} finally {
  if (command !== "watch") await device.close();
}
