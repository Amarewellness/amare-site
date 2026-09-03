#!/usr/bin/env node
/**
 * Apply AMARÉ App Store icon to the Capacitor iOS asset catalog.
 * Run after `npx cap sync ios` on macOS (Capawesome CI or local Xcode).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceIcon = path.join(root, "resources", "app-icon-1024.png");
const assetsCatalog = path.join(root, "ios", "App", "App", "Assets.xcassets");
const appIconSet = path.join(assetsCatalog, "AppIcon.appiconset");
const destIconName = "AppIcon-1024.png";
const destIcon = path.join(appIconSet, destIconName);

const contentsJson = {
  images: [
    {
      filename: destIconName,
      idiom: "universal",
      platform: "ios",
      size: "1024x1024",
    },
  ],
  info: {
    author: "xcode",
    version: 1,
  },
};

function readPngInfo(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.length < 26 || buf.toString("ascii", 1, 4) !== "PNG") {
    throw new Error(`Not a PNG: ${filePath}`);
  }
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    colorType: buf[25],
    hasAlpha: buf[25] === 4 || buf[25] === 6,
    bytes: buf.length,
  };
}

function validateSourceIcon() {
  if (!fs.existsSync(sourceIcon)) {
    console.error(`ERROR: App icon source not found: ${sourceIcon}`);
    process.exit(1);
  }
  const info = readPngInfo(sourceIcon);
  if (info.width !== 1024 || info.height !== 1024) {
    console.error(`ERROR: Expected 1024x1024 PNG, got ${info.width}x${info.height}: ${sourceIcon}`);
    process.exit(1);
  }
  if (info.hasAlpha) {
    console.warn("WARN: App Store icons must be opaque; source PNG has an alpha channel.");
  }
  return info;
}

function cleanAppIconSet() {
  if (!fs.existsSync(appIconSet)) return;
  for (const entry of fs.readdirSync(appIconSet)) {
    if (entry === destIconName || entry === "Contents.json") continue;
    fs.unlinkSync(path.join(appIconSet, entry));
  }
}

function configureIosAppIcon() {
  const info = validateSourceIcon();

  if (!fs.existsSync(assetsCatalog)) {
    console.error(`ERROR: iOS asset catalog not found: ${assetsCatalog}`);
    console.error("Run: npx cap add ios && npx cap sync ios");
    process.exit(1);
  }

  fs.mkdirSync(appIconSet, { recursive: true });
  cleanAppIconSet();
  fs.copyFileSync(sourceIcon, destIcon);
  fs.writeFileSync(path.join(appIconSet, "Contents.json"), `${JSON.stringify(contentsJson, null, 2)}\n`);

  console.log("Configured iOS AppIcon.appiconset:");
  console.log(`  source: ${path.relative(root, sourceIcon)} (${info.width}x${info.height}, ${info.bytes} bytes)`);
  console.log(`  target: ${path.relative(root, appIconSet)}`);
  console.log("  mode:   single-size 1024x1024 (Xcode generates other slots at build time)");
  return info;
}

const checkOnly = process.argv.includes("--check");

if (checkOnly) {
  const info = validateSourceIcon();
  console.log("App icon source OK:");
  console.log(`  path:   ${path.relative(root, sourceIcon)}`);
  console.log(`  size:   ${info.width}x${info.height}`);
  console.log(`  alpha:  ${info.hasAlpha ? "yes (warn)" : "no"}`);
  console.log(`  bytes:  ${info.bytes}`);
  process.exit(0);
}

configureIosAppIcon();
