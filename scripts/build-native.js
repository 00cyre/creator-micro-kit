#!/usr/bin/env node
// Compiles the native bridge. Skipped off macOS and when swiftc is absent, so
// installing as a dependency on other platforms does not fail the whole install.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = path.join(root, "native", "cm-bridge.swift");
const output = path.join(root, "build", "cm-bridge");

if (process.platform !== "darwin") {
  console.log("creator-micro-kit: skipping native build, macOS only");
  process.exit(0);
}
try {
  await run("swiftc", ["--version"]);
} catch {
  console.warn("creator-micro-kit: swiftc not found, skipping native build");
  process.exit(0);
}

await fs.mkdir(path.dirname(output), { recursive: true });
await run("swiftc", ["-O", source, "-o", output]);
await fs.chmod(output, 0o755);
console.log(`creator-micro-kit: built ${output}`);
