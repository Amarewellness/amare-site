#!/usr/bin/env node
/**
 * Capawesome Cloud iOS web-build step (runs from amare-app/ on macOS).
 * Push OFF via build:ios-release. Native plist tweaks after cap sync.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(cmd, opts = {}) {
  execSync(cmd, { cwd: root, stdio: "inherit", ...opts });
}

console.log("== Capawesome iOS build prep ==");

run("npm run build:ios-release");

if (!fs.existsSync(path.join(root, "ios"))) {
  console.log("Adding iOS platform (first build)...");
  run("npx cap add ios");
}

run("npx cap sync ios");

if (process.platform === "darwin") {
  run("node scripts/configure-ios-native.mjs");
  run("node scripts/configure-ios-app-icon.mjs");
  run("pod install", { cwd: path.join(root, "ios", "App") });
} else {
  console.warn("WARN: Skipping configure-ios-native.mjs and pod install — not macOS.");
}

console.log("== Capawesome iOS build prep complete ==");
