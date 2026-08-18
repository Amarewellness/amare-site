/**
 * Read live Stripe webhook enabled_events. Never prints API keys or secrets.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Stripe from "stripe";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "node_modules/netlify-cli/bin/run.js");

function extractKey(raw) {
  const text = String(raw || "");
  const found = [];
  const start = text.indexOf("{");
  if (start >= 0) {
    try {
      const walk = (x) => {
        if (typeof x === "string" && /^sk_(live|test)_/.test(x)) found.push(x.trim());
        else if (Array.isArray(x)) x.forEach(walk);
        else if (x && typeof x === "object") Object.values(x).forEach(walk);
      };
      walk(JSON.parse(text.slice(start)));
    } catch {
      /* ignore */
    }
  }
  const m = text.match(/sk_(live|test)_[A-Za-z0-9]+/);
  if (m) found.push(m[0]);
  return found[0] || "";
}

function keyFromDotEnv() {
  try {
    const lines = readFileSync(path.join(root, ".env"), "utf8").split(/\r?\n/);
    for (const line of lines) {
      if (!/^STRIPE_SECRET_KEY=/.test(line) || line.trim().startsWith("#")) continue;
      const v = line.slice("STRIPE_SECRET_KEY=".length).trim().replace(/^['"]|['"]$/g, "");
      if (/^sk_(live|test)_/.test(v)) return v;
    }
  } catch {
    return "";
  }
  return "";
}

const got = spawnSync(process.execPath, [cli, "env:get", "STRIPE_SECRET_KEY", "--context", "production"], {
  cwd: root,
  encoding: "utf8",
  windowsHide: true,
});
let key = extractKey(got.stdout);
let source = "netlify";
if (!key.startsWith("sk_")) {
  key = keyFromDotEnv();
  source = "dotenv";
}
if (!key.startsWith("sk_")) {
  console.error("FAIL Stripe key not readable from Netlify CLI or local .env");
  process.exit(1);
}
console.log("key_mode=" + (key.startsWith("sk_live_") ? "live" : "test") + " source=" + source);
if (key.startsWith("sk_test_")) {
  console.error("STOP live webhook audit requires a live Stripe key");
  process.exit(1);
}

const stripe = new Stripe(key, { timeout: 20000 });
const list = await stripe.webhookEndpoints.list({ limit: 20 });
const prodUrls = list.data.filter((e) => /amarewellness\.com/i.test(e.url || ""));
const rows = prodUrls.length ? prodUrls : list.data;
for (const e of rows) {
  const events = [...(e.enabled_events || [])].sort();
  console.log("id=" + e.id);
  console.log("status=" + e.status);
  console.log("url=" + (e.url || "").replace(/https?:\/\/[^/]+/, (h) => h));
  console.log("api_version=" + (e.api_version || ""));
  console.log("events=" + events.join(","));
  console.log("HAS_PAYMENT_INTENT_SUCCEEDED=" + (events.includes("payment_intent.succeeded") ? "YES" : "NO"));
  console.log("HAS_CHECKOUT_SESSION_COMPLETED=" + (events.includes("checkout.session.completed") ? "YES" : "NO"));
  console.log("HAS_INVOICE_PAID=" + (events.includes("invoice.paid") ? "YES" : "NO"));
  console.log("---");
}
