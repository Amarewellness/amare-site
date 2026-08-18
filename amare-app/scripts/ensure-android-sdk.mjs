/**
 * Local-only Android SDK bootstrap for debug APK builds.
 * Does not change production Netlify/Android store config.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(os.homedir(), "AppData", "Local", "Android", "Sdk");
const zipUrl = "https://dl.google.com/android/repository/commandlinetools-win-13114758_latest.zip";
const latest = path.join(sdk, "cmdline-tools", "latest");
const sdkmanager = path.join(latest, "bin", "sdkmanager.bat");

function haveSdkManager() {
  return fs.existsSync(sdkmanager);
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download_failed_${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
}

function unzip(zipPath, dest) {
  fs.mkdirSync(dest, { recursive: true });
  execFileSync("tar", ["-xf", zipPath, "-C", dest], { stdio: "inherit" });
}

if (!haveSdkManager()) {
  console.log(`Installing Android command-line tools into ${sdk}`);
  fs.mkdirSync(sdk, { recursive: true });
  const tmp = path.join(os.tmpdir(), "amare-commandlinetools.zip");
  await download(zipUrl, tmp);
  const extract = path.join(os.tmpdir(), "amare-commandlinetools");
  fs.rmSync(extract, { recursive: true, force: true });
  unzip(tmp, extract);
  const unpacked = path.join(extract, "cmdline-tools");
  fs.mkdirSync(path.join(sdk, "cmdline-tools"), { recursive: true });
  fs.rmSync(latest, { recursive: true, force: true });
  fs.renameSync(unpacked, latest);
}

const licenses = path.join(sdk, "licenses");
fs.mkdirSync(licenses, { recursive: true });
const known = {
  "android-sdk-license": "24333f8a63b6825ea9c5514f83de0cb6ba8fd81a\n",
  "android-sdk-preview-license": "84831b9409646161da1d3241cf3cd337\n",
};
for (const [name, body] of Object.entries(known)) {
  fs.writeFileSync(path.join(licenses, name), body);
}

const packages = ["platform-tools", "platforms;android-35", "build-tools;35.0.0"];
console.log("Installing SDK packages:", packages.join(", "));
const r = spawnSync(sdkmanager, [`--sdk_root=${sdk}`, ...packages], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk, JAVA_HOME: process.env.JAVA_HOME || "" },
});
if (r.status !== 0) process.exit(r.status || 1);

const localProps = path.join(appRoot, "android", "local.properties");
const sdkDir = sdk.replace(/\\/g, "\\\\");
fs.writeFileSync(localProps, `sdk.dir=${sdkDir}\n`, "utf8");
console.log(`ANDROID_HOME=${sdk}`);
console.log(`Wrote ${localProps}`);
