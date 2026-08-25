/**
 * Writes gitignored .env.android-staging for native QA APKs against staging/preview HTTPS.
 * Does not change production or LAN debug env.
 *
 * Required: AMARE_ANDROID_STAGING_API_BASE=https://your-deploy-preview--silly-bubblegum-ad7f6c.netlify.app
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const base = String(process.env.AMARE_ANDROID_STAGING_API_BASE || "").trim().replace(/\/$/, "");
if (!base) {
  console.error("Set AMARE_ANDROID_STAGING_API_BASE to your Netlify deploy-preview or branch-deploy HTTPS URL.");
  console.error("Example: https://deploy-preview-123--silly-bubblegum-ad7f6c.netlify.app");
  process.exit(1);
}
if (!/^https:\/\//i.test(base)) {
  console.error("AMARE_ANDROID_STAGING_API_BASE must be HTTPS (no localhost).");
  process.exit(1);
}
if (/localhost|127\.0\.0\.1|0\.0\.0\.0|192\.168\.|10\.\d+\.|172\.(1[6-9]|2\d|3[01])\./i.test(base)) {
  console.error("AMARE_ANDROID_STAGING_API_BASE must not point at localhost or LAN.");
  process.exit(1);
}

const contents = `# Generated for Android staging QA APK. Do not commit.
# Baked into production-built Vite assets; not a dev server.
VITE_API_BASE=${base}
VITE_OAUTH_API_BASE=${base}
VITE_PRICING_URL=${base}/pricing
VITE_ENABLE_AMARE_PUSH=0
`;

const dest = path.join(root, ".env.android-staging");
fs.writeFileSync(dest, contents, "utf8");
console.log(`Wrote ${dest}`);
console.log(`Staging API: ${base}`);
