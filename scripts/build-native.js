#!/usr/bin/env node
// Compiles the native bridge.
//
// Run as `postinstall` a failure only warns: installing as a dependency must
// not break the whole install on a machine without the Swift toolchain, and
// `open()` already reports a missing bridge with instructions. Run directly
// (`npm run build`) a failure is fatal, because building is the whole point.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = path.join(root, "native", "cm-bridge.swift");
const output = path.join(root, "build", "cm-bridge");
const optional = process.env.npm_lifecycle_event === "postinstall";

/** Warns and exits 0 for an optional build; fails loudly for a deliberate one. */
function give(reason, detail) {
  const message = `creator-micro-kit: ${reason}`;
  if (optional) {
    console.warn(`${message}. Run \`npm run build --prefix ${path.relative(process.cwd(), root) || "."}\` once the toolchain is available.`);
    if (detail) console.warn(detail);
    process.exit(0);
  }
  console.error(message);
  if (detail) console.error(detail);
  process.exit(1);
}

if (process.platform !== "darwin") {
  console.log("creator-micro-kit: skipping native build, macOS only");
  process.exit(0);
}
try {
  await run("swiftc", ["--version"]);
} catch {
  give("swiftc not found, skipping native build — install the Xcode command line tools with `xcode-select --install`");
}

await fs.mkdir(path.dirname(output), { recursive: true });
try {
  await run("swiftc", ["-O", source, "-o", output]);
} catch (error) {
  give("could not compile the native bridge", error.stderr || error.message);
}
await fs.chmod(output, 0o755);
console.log(`creator-micro-kit: built ${output}`);
