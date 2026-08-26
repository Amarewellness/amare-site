/**
 * Writes gitignored android/keystore.properties from env vars (never commit secrets).
 *
 * Required:
 *   AMARE_ANDROID_KEYSTORE_PATH — absolute or amare-app/android-relative .jks path
 *   AMARE_ANDROID_KEYSTORE_PASSWORD
 *   AMARE_ANDROID_KEY_ALIAS
 *   AMARE_ANDROID_KEY_PASSWORD
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const androidRoot = path.join(root, "android");

const storePathRaw = String(process.env.AMARE_ANDROID_KEYSTORE_PATH || "").trim();
const storePassword = String(process.env.AMARE_ANDROID_KEYSTORE_PASSWORD || "");
const keyAlias = String(process.env.AMARE_ANDROID_KEY_ALIAS || "").trim();
const keyPassword = String(process.env.AMARE_ANDROID_KEY_PASSWORD || "");

if (!storePathRaw || !storePassword || !keyAlias || !keyPassword) {
  console.error("Missing one or more signing env vars:");
  console.error("  AMARE_ANDROID_KEYSTORE_PATH");
  console.error("  AMARE_ANDROID_KEYSTORE_PASSWORD");
  console.error("  AMARE_ANDROID_KEY_ALIAS");
  console.error("  AMARE_ANDROID_KEY_PASSWORD");
  process.exit(1);
}

const storeFile = path.isAbsolute(storePathRaw)
  ? storePathRaw
  : path.resolve(androidRoot, storePathRaw);

if (!fs.existsSync(storeFile)) {
  console.error(`Keystore not found: ${storeFile}`);
  process.exit(1);
}

const relStore = path.relative(androidRoot, storeFile).split(path.sep).join("/");
const lines = [
  `storeFile=${relStore}`,
  `storePassword=${storePassword}`,
  `keyAlias=${keyAlias}`,
  `keyPassword=${keyPassword}`,
  "",
];

const dest = path.join(androidRoot, "keystore.properties");
fs.writeFileSync(dest, lines.join("\n"), "utf8");
console.log(`Wrote ${dest}`);
console.log(`storeFile=${relStore}`);
