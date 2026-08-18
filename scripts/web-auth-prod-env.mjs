/**
 * Production website AMARÉ auth env (presence + set). Never prints secret values.
 * Usage: node scripts/web-auth-prod-env.mjs
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "node_modules/netlify-cli/bin/run.js");

function runNetlify(args, { input } = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    input,
  });
}

function parseEnvList(raw) {
  const startObj = raw.indexOf("{");
  const startArr = raw.indexOf("[");
  const i = startObj >= 0 && (startArr < 0 || startObj < startArr) ? startObj : startArr;
  if (i < 0) throw new Error("env_list_not_json");
  return JSON.parse(raw.slice(i));
}

function envKeys(parsed) {
  const keys = [];
  function walk(x) {
    if (!x) return;
    if (Array.isArray(x)) {
      x.forEach(walk);
      return;
    }
    if (typeof x === "object") {
      if (typeof x.key === "string") {
        keys.push(x.key);
        return;
      }
      if (typeof x.name === "string" && ("value" in x || "values" in x || "scopes" in x)) {
        keys.push(x.name);
        return;
      }
      for (const [k, v] of Object.entries(x)) {
        if (v && typeof v === "object" && !Array.isArray(v) && ("value" in v || "values" in v || v.context || v.scopes)) {
          keys.push(k);
        } else if (typeof v === "string" && k === k.toUpperCase()) keys.push(k);
        else walk(v);
      }
    }
  }
  walk(parsed);
  return new Set(keys);
}

function redact(text, secrets) {
  let out = String(text || "");
  for (const s of secrets) {
    if (s) out = out.split(s).join("[redacted]");
  }
  return out;
}

function setEnv(key, value, extra = []) {
  const args = ["env:set", key, value, "--context", "production", "--force", ...extra];
  const r = runNetlify(args);
  const combined = redact(`${r.stdout || ""}${r.stderr || ""}`, [value]);
  if (r.status !== 0) {
    console.error(`FAIL set ${key}: ${combined.slice(0, 300)}`);
    process.exit(r.status || 1);
  }
  const leaked = combined.includes(value);
  if (leaked) {
    console.error(`FAIL set ${key}: CLI output appeared to echo the value`);
    process.exit(1);
  }
  console.log(`SET ${key}`);
}

function setSecret(key, value) {
  setEnv(key, value, ["--secret"]);
}

const listed = runNetlify(["env:list", "--json", "--context", "production"]);
if (listed.status !== 0) {
  console.error((listed.stderr || listed.stdout || "").slice(0, 400));
  process.exit(listed.status || 1);
}
const present = envKeys(parseEnvList(listed.stdout || ""));

const requiredPresent = ["MINDBODY_SESSION_SECRET", "RESEND_API_KEY", "RESEND_FROM"];
for (const k of requiredPresent) {
  console.log(present.has(k) ? `PRESENT ${k}` : `MISSING ${k}`);
  if (!present.has(k)) process.exit(2);
}

if (!present.has("AMARE_SESSION_SECRET")) {
  setSecret("AMARE_SESSION_SECRET", randomBytes(32).toString("hex"));
} else {
  console.log("PRESENT AMARE_SESSION_SECRET");
}
if (!present.has("AMARE_OTP_PEPPER")) {
  setSecret("AMARE_OTP_PEPPER", randomBytes(32).toString("hex"));
} else {
  console.log("PRESENT AMARE_OTP_PEPPER");
}

const flags = {
  ENABLE_AMARE_AUTH: "1",
  ENABLE_AMARE_SESS_ISSUE: "1",
  ENABLE_AMARE_AUTH_EMAIL_OTP: "1",
  ENABLE_AMARE_AUTH_UI: "1",
  ENABLE_AMARE_AUTH_MINDBODY_BRIDGE: "1",
  ENABLE_AMARE_MEMBER_READ: "1",
  ENABLE_AMARE_STUDIO_OPERATIONS: "1",
  ENABLE_AMARE_AUTH_GOOGLE: "0",
  ENABLE_AMARE_COMMERCE: "0",
  ENABLE_AMARE_PUSH: "0",
  ENABLE_AMARE_PUSH_TEST: "0",
  ENABLE_MOBILE_BEARER_AUTH: "0",
};

for (const [k, v] of Object.entries(flags)) setEnv(k, v);

console.log("DO_NOT_TOUCH Stripe checkout flags");
console.log("ENABLE_AMARE_COMMERCE=0 (not required for Hosted Checkout)");
console.log("DONE");
