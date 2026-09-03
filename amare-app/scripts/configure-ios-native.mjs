#!/usr/bin/env node
/**
 * Post-cap-add-ios native tweaks for AMARÉ (run on macOS only).
 * - iPhone-only target (no iPad multitasking / orientation validation)
 * - Portrait-only iPhone orientations
 * - CFBundleDisplayName = AMARÉ
 * - ITSAppUsesNonExemptEncryption = false (standard HTTPS/TLS only; no export docs)
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
const pbxPath = path.join(root, "ios", "App", "App.xcodeproj", "project.pbxproj");

/** App Store marketing version (CFBundleShortVersionString). */
const IOS_MARKETING_VERSION = "1.0";
/** App Store build number (CFBundleVersion). Increment before each upload. */
const IOS_BUILD_NUMBER = "3";

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

function plistSetBool(key, value) {
  const bool = value ? "true" : "false";
  try {
    execSync(`/usr/libexec/PlistBuddy -c "Set :${key} ${bool}" "${plistPath}"`);
  } catch {
    execSync(`/usr/libexec/PlistBuddy -c "Add :${key} bool ${bool}" "${plistPath}"`);
  }
}

function plistDelete(key) {
  execSync(`/usr/libexec/PlistBuddy -c "Delete :${key}" "${plistPath}" 2>/dev/null || true`);
}

function plistSet(key, value, type = "string") {
  const escaped = String(value).replace(/"/g, '\\"');
  if (type === "array") {
    plistDelete(key);
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

function configureXcodeProject() {
  if (!fs.existsSync(pbxPath)) {
    console.warn(`WARN: project.pbxproj not found: ${pbxPath}`);
    return;
  }

  let pbx = fs.readFileSync(pbxPath, "utf8");
  const before = pbx;

  // Capacitor default is universal (iPhone + iPad) → triggers iPad multitasking checks.
  pbx = pbx.replace(/TARGETED_DEVICE_FAMILY = "?1,2"?;/g, "TARGETED_DEVICE_FAMILY = 1;");
  pbx = pbx.replace(/TARGETED_DEVICE_FAMILY = "?2,1"?;/g, "TARGETED_DEVICE_FAMILY = 1;");

  // Align with Capacitor 7+ templates; satisfies upcoming App Store minimum warnings.
  pbx = pbx.replace(/IPHONEOS_DEPLOYMENT_TARGET = 14\.0;/g, "IPHONEOS_DEPLOYMENT_TARGET = 15.0;");

  // Drop generated iPad orientation build settings if present.
  pbx = pbx.replace(/^\s*INFOPLIST_KEY_UISupportedInterfaceOrientations_iPad = .*;\n/gm, "");

  // Capacitor template defaults to build 1; Info.plist uses $(CURRENT_PROJECT_VERSION).
  pbx = pbx.replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${IOS_MARKETING_VERSION};`);
  pbx = pbx.replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${IOS_BUILD_NUMBER};`);

  if (pbx !== before) {
    fs.writeFileSync(pbxPath, pbx, "utf8");
    console.log(`Updated ${pbxPath}`);
  } else {
    console.log(`No pbxproj changes needed: ${pbxPath}`);
  }
}

console.log(`Configuring ${plistPath}`);

plistSet("CFBundleDisplayName", "AMARÉ");
plistSetBool("ITSAppUsesNonExemptEncryption", false);
plistSet("UISupportedInterfaceOrientations", ["UIInterfaceOrientationPortrait"], "array");

// iPhone-only: remove iPad orientation/multitasking keys (universal target opt-out).
plistDelete("UISupportedInterfaceOrientations~ipad");
plistDelete("UIRequiresFullScreen");

configureXcodeProject();

console.log("Done:");
console.log("  CFBundleDisplayName = AMARÉ");
console.log("  ITSAppUsesNonExemptEncryption = false");
console.log("  TARGETED_DEVICE_FAMILY = 1 (iPhone only)");
console.log("  UISupportedInterfaceOrientations = Portrait (iPhone)");
console.log("  UISupportedInterfaceOrientations~ipad = removed");
console.log("  IPHONEOS_DEPLOYMENT_TARGET = 15.0 (when previously 14.0)");
console.log(`  MARKETING_VERSION = ${IOS_MARKETING_VERSION} (CFBundleShortVersionString)`);
console.log(`  CURRENT_PROJECT_VERSION = ${IOS_BUILD_NUMBER} (CFBundleVersion)`);
console.log("");
console.log("Manual Xcode checks still required:");
console.log("  - Signing & Capabilities → Team + Bundle ID com.amarewellness.app");
console.log("  - Launch Screen background #faf3eb (Assets / Splash)");
console.log("  - AppIcon asset catalog (automated by configure-ios-app-icon.mjs)");
console.log("  - Push Notifications capability ONLY after Firebase iOS + APNs configured");
console.log("  - Product → Archive for TestFlight");
