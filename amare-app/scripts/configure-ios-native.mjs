#!/usr/bin/env node
/**
 * Post-cap-add-ios native tweaks for AMARÉ (run on macOS only).
 * - Portrait-only orientations
 * - CFBundleDisplayName = AMARÉ
 * - Documents Launch Screen / splash expectations
 *
 * Usage (Mac, after npx cap add ios && npx cap sync ios):
 *   node scripts/configure-ios-native.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const plistPath = path.join(root, "ios", "App", "App", "Info.plist");

if (process.platform !== "darwin") {
  console.error("configure-ios-native.mjs must run on macOS (after cap add ios).");
  console.error("On Windows/Linux, use docs/IOS-MAC-HANDOFF.md instead.");
  process.exit(1);
}

if (!fs.existsSync(plistPath)) {
  console.error(`Info.plist not found: ${plistPath}`);
  console.error("Run: npx cap add ios && npx cap sync ios");
  process.exit(1);
}

function plistSet(key, value, type = "string") {
  const escaped = String(value).replace(/"/g, '\\"');
  if (type === "array") {
    execSync(`/usr/libexec/PlistBuddy -c "Delete :${key}" "${plistPath}" 2>/dev/null || true`);
    execSync(`/usr/libexec/PlistBuddy -c "Add :${key} array" "${plistPath}"`);
    for (let i = 0; i < value.length; i += 1) {
      execSync(`/usr/libexec/PlistBuddy -c "Add :${key}:${i} string ${value[i]}" "${plistPath}"`);
    }
    return;
  }
  try {
    execSync(`/usr/libexec/PlistBuddy -c "Set :${key} ${escaped}" "${plistPath}"`);
  } catch {
    execSync(`/usr/libexec/PlistBuddy -c "Add :${key} string ${escaped}" "${plistPath}"`);
  }
}

console.log(`Configuring ${plistPath}`);

plistSet("CFBundleDisplayName", "AMARÉ");
plistSet("UISupportedInterfaceOrientations", ["UIInterfaceOrientationPortrait"], "array");
plistSet("UISupportedInterfaceOrientations~ipad", ["UIInterfaceOrientationPortrait"], "array");

console.log("Done:");
console.log("  CFBundleDisplayName = AMARÉ");
console.log("  UISupportedInterfaceOrientations = Portrait only");
console.log("");
console.log("Manual Xcode checks still required:");
console.log("  - Signing & Capabilities → Team + Bundle ID com.amarewellness.app");
console.log("  - Launch Screen background #faf3eb (Assets / Splash)");
console.log("  - AppIcon asset catalog from resources/icon.png or 1024 master");
console.log("  - Push Notifications capability ONLY after Firebase iOS + APNs configured");
console.log("  - Product → Archive for TestFlight");
