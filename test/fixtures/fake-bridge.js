#!/usr/bin/env node
// A scripted stand-in for build/cm-bridge, so the transport can be tested
// without hardware. Behaviour is chosen by CMK_FAKE:
//
//   ready   (default) answer requests, echoing the method back on the reply
//   crosstalk           answer every request with another client's method name
//   events              emit key and joystick notifications, then idle
//   fail                report an error and exit before ever becoming ready
//   silent              never say anything (exercises the open timeout)
//   die-once            become ready, then drop; the next spawn behaves as ready
import { createInterface } from "node:readline";
import fs from "node:fs";

const mode = process.env.CMK_FAKE ?? "ready";
const emit = (object) => process.stdout.write(`${JSON.stringify(object)}\n`);

if (mode === "fail") {
  process.stderr.write("fake bridge diagnostics\n");
  emit({ type: "error", message: "no Work Louder device found" });
  process.exit(2);
}
if (mode === "silent") setInterval(() => {}, 1000);
else {
  emit({
    type: "ready",
    product: "Fake Creator Micro",
    manufacturer: "Work Louder",
    vendorId: 0x303a,
    productId: 0x8298,
    transport: "USB",
    serialNumber: "FAKE",
    locationId: 1,
    hasVendorCollection: true,
  });
}

// The first `die-once` spawn drops the connection; the marker file makes the
// spawn that follows behave normally, so a reconnect can succeed.
if (mode === "die-once") {
  const marker = process.env.CMK_FAKE_MARKER;
  if (marker && !fs.existsSync(marker)) {
    fs.writeFileSync(marker, "dropped");
    setTimeout(() => process.exit(3), 100);
  }
}

if (mode === "events") {
  emit({ type: "log", data: "firmware says hello" });
  emit({ type: "notify", data: { m: "v.oai.hid", p: { k: "AG03", act: 1 } } });
  emit({ type: "notify", data: { m: "v.oai.hid", p: { k: "AG03", act: 0 } } });
  emit({ type: "notify", data: { m: "v.oai.rad", p: { a: 0.25, d: 0.5 } } });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (line.trim() === "quit") process.exit(0);
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (mode === "crosstalk") {
    // Same id, a method we never asked for: another client's reply.
    emit({ type: "rpc", data: { result: { stolen: true }, id: request.id, method: "someone.else" } });
    return;
  }
  emit({ type: "rpc", data: { result: { echo: request.method, params: request.params }, id: request.id, method: request.method } });
});
