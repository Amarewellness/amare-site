/**
 * Writes gitignored .env.android-release for Play Store AAB builds against production HTTPS.
 * Does not change staging or LAN debug env.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const base = String(process.env.AMARE_ANDROID_RELEASE_API_BASE || "https://www.amarewellness.com")
  .trim()
  .replace(/\/$/, "");

if (!/^https:\/\//i.test(base)) {
  console.error("AMARE_ANDROID_RELEASE_API_BASE must be HTTPS.");
  process.exit(1);
}
if (/localhost|127\.0\.0\.1|0\.0\.0\.0|192\.168\.|10\.\d+\.|172\.(1[6-9]|2\d|3[01])\./i.test(base)) {
  console.error("AMARE_ANDROID_RELEASE_API_BASE must not point at localhost or LAN.");
  process.exit(1);
}

const pushFlag = String(process.env.AMARE_ANDROID_RELEASE_PUSH || "1").trim() === "1" ? "1" : "0";

const contents = `# Generated for Android Play Store release AAB. Do not commit.
# Baked into production-built Vite assets; not a dev server.
VITE_API_BASE=${base}
VITE_OAUTH_API_BASE=${base}
VITE_PRICING_URL=${base}/pricing
VITE_ENABLE_AMARE_PUSH=${pushFlag}
`;

const dest = path.join(root, ".env.android-release");
fs.writeFileSync(dest, contents, "utf8");
console.log(`Wrote ${dest}`);
console.log(`Release API: ${base}`);
console.log(`Push in app build: ${pushFlag}`);
