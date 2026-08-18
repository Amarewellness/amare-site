/**
 * Writes gitignored .env.android-debug with this machine's LAN IP.
 * Does not change production or default Vite env.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function lanIPv4() {
  const forced = String(process.env.AMARE_ANDROID_LAN_IP || "").trim();
  if (forced) return forced;
  const nets = os.networkInterfaces();
  const preferred = [];
  const other = [];
  for (const [name, list] of Object.entries(nets)) {
    for (const entry of list || []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      if (entry.address.startsWith("172.3") && /wsl|vethernet|hyper-v/i.test(name)) continue;
      const row = { name, address: entry.address };
      if (/wi-?fi|wlan|wireless/i.test(name)) preferred.push(row);
      else other.push(row);
    }
  }
  return (preferred[0] || other[0] || {}).address || "";
}

const forced = String(process.env.AMARE_ANDROID_API_BASE || "").trim().replace(/\/$/, "");
const ip = lanIPv4();
const port = String(process.env.LOCAL_FULL_DEV_PORT || "4321");
const base = forced || (ip ? `http://${ip}:${port}` : "");
if (!base) {
  console.error("No API base. Set AMARE_ANDROID_API_BASE or AMARE_ANDROID_LAN_IP.");
  process.exit(1);
}

const contents = `# Generated for Android debug APK QA. Do not commit.
# Production / default Vite build is unchanged.
VITE_API_BASE=${base}
VITE_OAUTH_API_BASE=${base}
VITE_PRICING_URL=${base}/pricing
`;

const dest = path.join(root, ".env.android-debug");
fs.writeFileSync(dest, contents, "utf8");
console.log(`Wrote ${dest}`);
console.log(`Debug API: ${base}`);
