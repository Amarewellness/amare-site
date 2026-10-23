/**
 * Calls production Netlify Amanda upgrade ops endpoint (uses server STRIPE_SECRET_KEY).
 * Requires ADMIN_DEBUG_TOKEN in amare-app/.env.production or env — never logs token.
 */
import fs from "node:fs";
import path from "node:path";
import { loadLocalEnv } from "../../scripts/load-env.mjs";

loadLocalEnv();
const prodEnv = path.join("amare-app", ".env.production");
if (fs.existsSync(prodEnv)) {
  for (const line of fs.readFileSync(prodEnv, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    if (process.env[k] === undefined) {
      let v = t.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[k] = v;
    }
  }
}

const BASE = "https://www.amarewellness.com/api/stripe/admin/amanda-upgrade";
const token = (process.env.ADMIN_DEBUG_TOKEN || "").trim();
if (!token) {
  console.error(JSON.stringify({ fatal: "ADMIN_DEBUG_TOKEN missing" }));
  process.exit(1);
}

async function call(method, action) {
  const url = `${BASE}?action=${encodeURIComponent(action)}`;
  const res = await fetch(url, {
    method,
    headers: {
      "x-admin-token": token,
      "Content-Type": "application/json",
    },
    ...(method === "POST" ? { body: JSON.stringify({ action }) } : {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  return { action, status: res.status, json };
}

const steps = [
  ["GET", "runtime-check"],
  ["GET", "preflight"],
  ["POST", "prepare-product"],
  ["GET", "preview-b"],
  ["POST", "execute"],
  ["GET", "verify"],
];

const report = { at: new Date().toISOString(), steps: [] };
for (const [method, action] of steps) {
  const out = await call(method, action);
  report.steps.push(out);
  if (action === "preview-b" && out.json?.preview?.amount_due !== 22900) {
    report.blocked = "preview_not_22900";
    break;
  }
  if (out.status >= 400 && action !== "prepare-product") {
    report.blocked = `${action}_http_${out.status}`;
    if (action === "execute") break;
    if (action === "preflight" && out.json?.alreadyUpgraded) {
      report.blocked = null;
      continue;
    }
    break;
  }
}

console.log(JSON.stringify(report, null, 2));
process.exit(report.blocked ? 1 : 0);
