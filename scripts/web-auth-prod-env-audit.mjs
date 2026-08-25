/**
 * Read-only production env audit. Never prints secret values.
 * Usage: node scripts/web-auth-prod-env-audit.mjs
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "node_modules/netlify-cli/bin/run.js");
const SITE = "f315d80d-f61e-4fef-9a06-68bb09192d56";
const ACCOUNT = "68bd260c9ca87a8197818d4c";

const SECRET_KEYS = new Set([
  "AMARE_SESSION_SECRET",
  "AMARE_OTP_PEPPER",
  "MINDBODY_SESSION_SECRET",
  "RESEND_API_KEY",
  "MINDBODY_OAUTH_CLIENT_SECRET",
  "MINDBODY_API_KEY",
  "MINDBODY_STAFF_PASSWORD",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
]);

const FLAG_KEYS = [
  "ENABLE_AMARE_AUTH",
  "ENABLE_AMARE_SESS_ISSUE",
  "ENABLE_AMARE_AUTH_EMAIL_OTP",
  "ENABLE_AMARE_AUTH_UI",
  "ENABLE_AMARE_AUTH_MINDBODY_BRIDGE",
  "ENABLE_AMARE_AUTH_GOOGLE",
  "ENABLE_AMARE_MEMBER_READ",
  "ENABLE_AMARE_STUDIO_OPERATIONS",
  "ENABLE_AMARE_COMMERCE",
  "ENABLE_AMARE_PUSH",
  "ENABLE_AMARE_PUSH_TEST",
  "ENABLE_AMARE_PUSH_WEBHOOKS",
  "ENABLE_AMARE_PUSH_REMINDERS",
  "ENABLE_MOBILE_BEARER_AUTH",
  "ENABLE_STRIPE_ONE_TIME_CHECKOUT",
  "ENABLE_STRIPE_RECURRING_CHECKOUT",
  "ENABLE_STRIPE_RECURRING_CHECKOUT_FRONTEND",
];

const INTEREST = [
  ...FLAG_KEYS,
  "AMARE_SESSION_SECRET",
  "AMARE_OTP_PEPPER",
  "AMARE_OTP_FROM",
  "RESEND_API_KEY",
  "RESEND_FROM",
  "MINDBODY_SESSION_SECRET",
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GOOGLE_OAUTH_REDIRECT_URI",
];

function parseJson(raw) {
  const text = String(raw || "");
  const i = Math.min(
    ...[text.indexOf("{"), text.indexOf("[")].filter((n) => n >= 0),
  );
  if (!Number.isFinite(i) || i < 0) throw new Error("no_json");
  return JSON.parse(text.slice(i));
}

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
}

const api = run(["api", "getEnvVars", "--data", JSON.stringify({ account_id: ACCOUNT, site_id: SITE })]);
if (api.status !== 0) {
  console.error("FAIL getEnvVars", String(api.stderr || api.stdout || "").slice(0, 300));
  process.exit(api.status || 1);
}

const rows = parseJson(api.stdout);
if (!Array.isArray(rows)) {
  console.error("FAIL getEnvVars not an array; keys=", Object.keys(rows || {}).join(","));
  process.exit(1);
}

function productionValue(row) {
  const values = Array.isArray(row.values) ? row.values : [];
  const prod = values.find((v) => Array.isArray(v.context) && v.context.includes("production"))
    || values.find((v) => v.context === "production")
    || values.find((v) => v.context === "all")
    || values.find((v) => Array.isArray(v.context) && v.context.includes("all"));
  if (!prod) return { found: false, value: "", contexts: values.map((v) => JSON.stringify(v.context)) };
  const value = typeof prod.value === "string" ? prod.value : "";
  return { found: true, value, contexts: values.flatMap((v) => (Array.isArray(v.context) ? v.context : [v.context]).filter(Boolean)) };
}

const byKey = new Map(rows.map((r) => [r.key, r]));
console.log("SITE", SITE);
console.log("TOTAL_ENV_KEYS", rows.length);
console.log("ALL_KEYS", rows.map((r) => r.key).sort().join(","));
console.log("---");

for (const key of INTEREST) {
  const row = byKey.get(key);
  if (!row) {
    console.log(`MISSING\t${key}\tnot_in_netlify_env`);
    continue;
  }
  const { found, value, contexts } = productionValue(row);
  const secret = SECRET_KEYS.has(key) || row.is_secret === true;
  if (!found) {
    console.log(`MISSING\t${key}\tno_production_context contexts=${contexts.join("|")}`);
    continue;
  }
  if (secret) {
    console.log(`PRESENT\t${key}\tsecret contexts=${[...new Set(contexts)].join("|")} len=${value.length}`);
  } else if (FLAG_KEYS.includes(key)) {
    const v = value.trim();
    console.log(`FLAG\t${key}\t${v === "1" ? "1" : v === "0" ? "0" : `OTHER len=${v.length}`}\tcontexts=${[...new Set(contexts)].join("|")}`);
  } else {
    console.log(`PRESENT\t${key}\tnonsecret contexts=${[...new Set(contexts)].join("|")} len=${value.length}`);
  }
}

const listed = run(["env:list", "--json", "--context", "production", "--site", SITE]);
if (listed.status === 0) {
  try {
    const parsed = parseJson(listed.stdout);
    const keys = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? Object.keys(parsed)
      : Array.isArray(parsed)
        ? parsed.map((x) => x.key || x.name).filter(Boolean)
        : [];
    console.log("---");
    console.log("ENV_LIST_PRODUCTION_KEYS", keys.sort().join(","));
    for (const key of INTEREST) {
      console.log((keys.includes(key) ? "LISTED" : "UNLISTED") + "\t" + key);
    }
    for (const key of FLAG_KEYS.filter((k) => k.startsWith("ENABLE_STRIPE"))) {
      const v = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed[key] : null;
      if (typeof v === "string") {
        console.log(`STRIPE_FLAG_FROM_LIST\t${key}\t${v.trim() === "1" ? "1" : v.trim() === "0" ? "0" : "OTHER"}`);
      }
    }
  } catch (e) {
    console.log("ENV_LIST_PARSE_FAIL", String(e && e.message));
  }
}
