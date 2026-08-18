/**
 * Writes gitignored android/app/google-services.json from env.
 * Never commit the output. Does not change production flags.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const raw = (process.env.FIREBASE_ANDROID_GOOGLE_SERVICES_JSON || "").trim();
if (!raw) {
  console.error("Set FIREBASE_ANDROID_GOOGLE_SERVICES_JSON to the google-services.json contents.");
  process.exit(1);
}
let parsed;
try {
  parsed = JSON.parse(raw);
} catch {
  console.error("FIREBASE_ANDROID_GOOGLE_SERVICES_JSON is not valid JSON.");
  process.exit(1);
}
const dest = path.join(root, "amare-app/android/app/google-services.json");
writeFileSync(dest, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
console.log(`Wrote ${dest}`);
