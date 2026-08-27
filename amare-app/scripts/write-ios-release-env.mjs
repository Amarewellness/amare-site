/**
 * Writes gitignored .env.ios-release for App Store / TestFlight builds against production HTTPS.
 * Does not change Android env files or production backend flags.
 *
 * Default push OFF for iOS until Firebase iOS + APNs is verified (see AMARE_IOS_RELEASE_1.0/push-diagnosis.txt).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const base = String(process.env.AMARE_IOS_RELEASE_API_BASE || "https://www.amarewellness.com")
  .trim()
  .replace(/\/$/, "");

if (!/^https:\/\//i.test(base)) {
  console.error("AMARE_IOS_RELEASE_API_BASE must be HTTPS.");
  process.exit(1);
}
if (/localhost|127\.0\.0\.1|0\.0\.0\.0|192\.168\.|10\.\d+\.|172\.(1[6-9]|2\d|3[01])\./i.test(base)) {
  console.error("AMARE_IOS_RELEASE_API_BASE must not point at localhost or LAN.");
  process.exit(1);
}

/** iOS push infra not verified — default 0. Set AMARE_IOS_RELEASE_PUSH=1 only after Firebase iOS QA. */
const pushFlag = String(process.env.AMARE_IOS_RELEASE_PUSH || "0").trim() === "1" ? "1" : "0";

const contents = `# Generated for iOS App Store / TestFlight release. Do not commit.
# Baked into production-built Vite assets; not a dev server.
VITE_API_BASE=${base}
VITE_OAUTH_API_BASE=${base}
VITE_PRICING_URL=${base}/pricing
VITE_ENABLE_AMARE_PUSH=${pushFlag}
`;

const dest = path.join(root, ".env.ios-release");
fs.writeFileSync(dest, contents, "utf8");
console.log(`Wrote ${dest}`);
console.log(`Release API: ${base}`);
console.log(`Push in iOS app build: ${pushFlag}`);
