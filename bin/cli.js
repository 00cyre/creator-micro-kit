#!/usr/bin/env node
import fs from "node:fs";
import { createInterface } from "node:readline";
import { CreatorMicro, open, Effect, toHexColor, toPackedColor } from "../src/index.js";

const argv = process.argv.slice(2);
// Leading flags pick a device when more than one is connected.
const openOptions = {};
let assumeYes = false;
let reconnect = false;
while (argv.length) {
  const flag = argv[0];
  if (flag === "--product-id") { openOptions.productId = Number(argv[1]); argv.splice(0, 2); }
  else if (flag === "--serial") { openOptions.serial = argv[1]; argv.splice(0, 2); }
  else if (flag === "--yes" || flag === "-y") { assumeYes = true; argv.shift(); }
  else if (flag === "--reconnect") { reconnect = true; argv.shift(); }
  else break;
}
const [command, ...args] = argv;

function usage() {
  console.log(`creator-micro-kit — programmatic control for the Work Louder Creator Micro 2

Usage:
  creator-micro-kit devices                    list connected Work Louder devices
  creator-micro-kit info                       firmware version and device status
  creator-micro-kit keys <color> [<color>...]  per-key colours, key 1 first
  creator-micro-kit zones <ambient> <keys>     ambient ring and unclaimed keys
  creator-micro-kit preview <effect> [<color>] whole-board lighting preview
  creator-micro-kit watch                      print key and joystick events
  creator-micro-kit ls                         list files on the device
  creator-micro-kit pull <file> [dest]         copy a device file to disk
  creator-micro-kit push <file> <src>          replace a device file from disk

Options:
  --product-id <n>   pick a device by USB product id
  --serial <s>       pick a device by serial number
  --reconnect        (watch) re-open when the device drops, e.g. a Bluetooth sleep
  -y, --yes          (push) skip the confirmation prompt

Colours accept #RRGGBB, #RGB, or a packed integer.
Effects: ${Object.keys(Effect).join(", ")}

Per-key colours only appear on layers whose keymap uses KV_OAI_* keycodes.
On other layers the firmware applies that layer's own stored lighting instead.`);
}

function confirm(question) {
  const input = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    input.question(`${question} [y/N] `, (answer) => {
      input.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

if (!command || command === "--help" || command === "-h") {
  usage();
  process.exit(0);
}

// `devices` is the one command that must work with nothing connected.
if (command === "devices") {
  const devices = await CreatorMicro.listDevices(openOptions);
  if (!devices.length) {
    console.log("no Work Louder devices found");
    process.exit(1);
  }
  for (const device of devices) {
    const rpc = device.hasVendorCollection ? "rpc" : "no rpc collection";
    console.log(
      `${device.product} (0x${device.productId.toString(16)})  ${device.transport}  `
      + `serial ${device.serialNumber || "—"}  ${rpc}`,
    );
  }
  process.exit(0);
}

const device = await open({ ...openOptions, reconnect: command === "watch" && reconnect });
try {
  switch (command) {
    case "info": {
      console.log(`${device.info.product} (0x${device.info.productId.toString(16)}) over ${device.info.transport}`);
      console.log(`firmware ${await device.getFirmwareVersion()}`);
      const status = await device.getStatus();
      console.log(`profile ${status.profile_index}  layer ${status.layer_index}  battery ${status.battery}%${status.is_charging ? " (charging)" : ""}`);
      break;
    }
    case "keys": {
      if (!args.length) throw new Error("keys needs at least one colour");
      // Fields left out keep whatever the device already holds, and after a
      // power cycle that is zero — so a colour-only update paints nothing.
      await device.setThreadColors(
        args.map((color, id) => ({ id, color, brightness: 1, effect: Effect.solid })),
      );
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
    case "ls": {
      for (const file of await device.listFiles()) {
        console.log(`${String(file.size).padStart(7)}  ${file.checksum ?? ""}  ${file.name}`);
      }
      break;
    }
    case "pull": {
      const [name, destination = name] = args;
      if (!name) throw new Error("pull needs a file name");
      const data = await device.readFile(name);
      fs.writeFileSync(destination, data);
      console.log(`${name} → ${destination} (${data.length} bytes)`);
      break;
    }
    case "push": {
      const [name, source] = args;
      if (!name || !source) throw new Error("push needs a device file name and a source path");
      const data = fs.readFileSync(source);
      if (!assumeYes) {
        console.log(
          `About to replace ${name} on the device with ${source} (${data.length} bytes).\n`
          + "Quit the Input app first — two writers corrupt each other's requests.\n"
          + `Back up first with: creator-micro-kit pull ${name}`,
        );
        if (!(await confirm("Continue?"))) {
          console.log("aborted");
          process.exitCode = 1;
          break;
        }
      }
      await device.writeFile(name, data);
      console.log(`${source} → ${name} (${data.length} bytes, checksum verified)`);
      break;
    }
    case "watch": {
      console.log("watching for events, ctrl-c to stop");
      device.on("key", ({ key, pressed }) => console.log(`${key} ${pressed ? "down" : "up"}`));
      device.on("joystick", ({ angle, distance }) => console.log(`joystick angle=${angle} distance=${distance}`));
      device.on("close", () => console.log(reconnect ? "device dropped, reconnecting…" : "device closed"));
      device.on("reconnect", (info) => console.log(`reconnected over ${info.transport}`));
      if (!reconnect) await new Promise((resolve) => device.on("close", resolve));
      else await new Promise(() => {});
      break;
    }
    default:
      usage();
      process.exitCode = 1;
  }
} finally {
  if (command !== "watch") await device.close();
}
