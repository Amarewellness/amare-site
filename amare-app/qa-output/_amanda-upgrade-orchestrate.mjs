/**
 * Runs Amanda approved Scenario B pipeline; writes phase JSON to qa-output. Never logs API keys.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "../../scripts/load-env.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const executeScript = path.join(root, "amare-app/qa-output/_amanda-upgrade-execute.mjs");
const outDir = path.join(root, "amare-app/qa-output");

loadLocalEnv();
const prodEnv = path.join(root, "amare-app", ".env.production");
if (fs.existsSync(prodEnv)) {
  for (const line of fs.readFileSync(prodEnv, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    if (process.env[k] !== undefined) continue;
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[k] = v;
  }
}

function hasLiveStripeKey() {
  for (const k of ["STRIPE_RESTRICTED_LIVE_KEY", "STRIPE_LIVE_SECRET_KEY", "STRIPE_SECRET_KEY"]) {
    const v = (process.env[k] || "").trim();
    if (/^(sk_live_|rk_live_)/.test(v)) return true;
  }
  return false;
}

function tryNetlifyProductionStripeKey() {
  const cli = path.join(root, "node_modules/netlify-cli/bin/run.js");
  for (const name of ["STRIPE_RESTRICTED_LIVE_KEY", "STRIPE_LIVE_SECRET_KEY", "STRIPE_SECRET_KEY"]) {
    const r = spawnSync(process.execPath, [cli, "env:get", name, "--context", "production"], {
      encoding: "utf8",
      cwd: root,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    const text = String(r.stdout || "").trim();
    const m = text.match(/^(sk_live_|rk_live_)[A-Za-z0-9]+$/m) || text.match(/(sk_live_[A-Za-z0-9]+)/);
    const key = m ? (m[0].startsWith("sk_live_") || m[0].startsWith("rk_live_") ? m[0] : m[1]) : "";
    if (/^(sk_live_|rk_live_)/.test(key)) {
      process.env.STRIPE_RESTRICTED_LIVE_KEY = key.startsWith("rk_live_") ? key : process.env.STRIPE_RESTRICTED_LIVE_KEY || "";
      if (key.startsWith("sk_live_")) process.env.STRIPE_LIVE_SECRET_KEY = key;
      return key.startsWith("rk_live_") ? "restricted" : "secret";
    }
  }
  return null;
}

function runPhase(phase, extraArgs = [], envExtra = {}) {
  const env = { ...process.env, ...envExtra };
  delete env.STRIPE_SECRET_KEY;
  if (env.STRIPE_LIVE_SECRET_KEY && !env.STRIPE_RESTRICTED_LIVE_KEY?.startsWith("rk_live_")) {
    /* keep */
  }
  const r = spawnSync(process.execPath, [executeScript, phase, ...extraArgs], {
    encoding: "utf8",
    cwd: root,
    env,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  const combined = String(r.stdout || "");
  const err = String(r.stderr || "");
  const jsonStart = combined.indexOf("{");
  let parsed = null;
  if (jsonStart >= 0) {
    try {
      parsed = JSON.parse(combined.slice(jsonStart));
    } catch {
      parsed = { parseError: true, rawHead: combined.slice(0, 2000), stderrHead: err.slice(0, 500) };
    }
  } else if (err.includes("{")) {
    try {
      parsed = JSON.parse(err.slice(err.indexOf("{")));
    } catch {
      parsed = { fatal: err.slice(0, 500) };
    }
  }
  const outPath = path.join(outDir, `_amanda-phase-${phase.replace(/\s+/g, "-")}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ phase, exitCode: r.status ?? 1, result: parsed }, null, 2));
  return { phase, exitCode: r.status ?? 1, result: parsed, outPath };
}

const report = { startedAt: new Date().toISOString(), phases: [], blocked: null };

if (!hasLiveStripeKey()) {
  const mode = tryNetlifyProductionStripeKey();
  report.keySource = mode ? `netlify_production_${mode}` : "missing";
} else {
  report.keySource = (process.env.STRIPE_RESTRICTED_LIVE_KEY || "").startsWith("rk_live_") ? "env_restricted" : "env_secret";
}

if (!hasLiveStripeKey()) {
  report.blocked = "missing_stripe_live_key";
  fs.writeFileSync(path.join(outDir, "_amanda-orchestrate-report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ blocked: report.blocked, keySource: report.keySource }));
  process.exit(2);
}

for (const phase of ["permissions", "preflight"]) {
  const p = runPhase(phase);
  report.phases.push(p);
  if (p.exitCode !== 0) {
    report.blocked = `${phase}_failed`;
    break;
  }
}

if (!report.blocked) {
  const perm = report.phases.find((x) => x.phase === "permissions")?.result;
  const needPrep =
    perm?.checks?.find((c) => String(c.op || "").includes("products.search"))?.prepareProductRequired === true;
  if (needPrep) {
    const prep = runPhase("prepare-product");
    report.phases.push(prep);
    if (prep.exitCode !== 0) report.blocked = "prepare-product_failed";
  }
}

if (!report.blocked) {
  const prev = runPhase("preview", ["B"]);
  report.phases.push(prev);
  if (prev.exitCode !== 0) {
    report.blocked = "preview_B_failed";
  } else {
    const amount = prev.result?.preview?.amount_due;
    report.scenarioBAmountDue = amount;
    if (amount !== 22900) {
      report.blocked = "preview_amount_mismatch";
      report.expectedCents = 22900;
    }
  }
}

if (!report.blocked) {
  const exec = runPhase("execute", ["B"], {
    AMANDA_UPGRADE_APPROVED_SCENARIO: "B",
    AMANDA_UPGRADE_APPROVED_AMOUNT_CENTS: "22900",
  });
  report.phases.push(exec);
  if (exec.exitCode !== 0) report.blocked = "execute_failed";
}

if (!report.blocked) {
  const ver = runPhase("verify");
  report.phases.push(ver);
  if (ver.exitCode !== 0) report.blocked = "verify_failed";
}

report.finishedAt = new Date().toISOString();
report.blocked = report.blocked || null;
fs.writeFileSync(path.join(outDir, "_amanda-orchestrate-report.json"), JSON.stringify(report, null, 2));
console.log(
  JSON.stringify({
    blocked: report.blocked,
    keySource: report.keySource,
    scenarioBAmountDue: report.scenarioBAmountDue ?? null,
    phaseCount: report.phases.length,
    reportPath: "amare-app/qa-output/_amanda-orchestrate-report.json",
  }),
);

process.exit(report.blocked ? 1 : 0);
