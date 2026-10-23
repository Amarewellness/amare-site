/**
 * Enroll (or re-key / remove) an owner / superadmin for admin membership billing changes.
 *
 * Stores only a salted scrypt hash in the Netlify production env var MEMBERSHIP_BILLING_ADMINS.
 * The billing key is typed with hidden input and never written to disk or printed.
 *
 * Run:    node scripts/membership-billing-admin-enroll.mjs
 * Remove: node scripts/membership-billing-admin-enroll.mjs --remove <actorId>
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { billingAdminEntry, BILLING_ROLES } from "../netlify/functions/membership-change-auth.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "node_modules/netlify-cli/bin/run.js");
const ENV_NAME = "MEMBERSHIP_BILLING_ADMINS";

function netlify(args) {
  const r = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new Error(`netlify ${args[0]} failed: ${String(r.stderr || r.stdout).slice(0, 300)}`);
  return String(r.stdout || "");
}

function currentEntries() {
  const out = netlify(["env:get", ENV_NAME, "--context", "production"]).trim();
  if (!out || /no value|not set|not found/i.test(out)) return [];
  const value = out.split(/\r?\n/).pop() || "";
  return value
    .split(";")
    .map((s) => s.trim())
    .filter((s) => /^[a-z0-9][a-z0-9._-]{1,39}:[a-z]+:[0-9a-f]+:[0-9a-f]{64}$/i.test(s));
}

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      const write = rl._writeToOutput.bind(rl);
      rl._writeToOutput = (s) => {
        if (s.includes(question)) write(s);
        else write("");
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

async function main() {
  const removeIdx = process.argv.indexOf("--remove");
  const existing = currentEntries();
  if (removeIdx >= 0) {
    const actorId = String(process.argv[removeIdx + 1] || "").toLowerCase();
    const next = existing.filter((e) => e.split(":")[0] !== actorId);
    if (next.length === existing.length) {
      console.log(`No billing admin "${actorId}" enrolled.`);
      return;
    }
    netlify(["env:set", ENV_NAME, next.join(";"), "--context", "production"]);
    console.log(`Removed "${actorId}". Redeploy for the change to reach running functions.`);
    return;
  }

  console.log(`Enrolled billing admins: ${existing.map((e) => e.split(":").slice(0, 2).join(" (") + ")").join(", ") || "none"}`);
  const actorId = (await ask("Billing admin id (e.g. snir): ")).toLowerCase();
  const role = (await ask(`Role (${BILLING_ROLES.join(" / ")}): `)).toLowerCase();
  const key = await ask("Billing key (min 12 chars, hidden): ", { hidden: true });
  const again = await ask("Repeat billing key: ", { hidden: true });
  if (key !== again) throw new Error("Keys do not match.");
  const entry = billingAdminEntry(actorId, role, key);
  const next = [...existing.filter((e) => e.split(":")[0] !== actorId), entry];
  netlify(["env:set", ENV_NAME, next.join(";"), "--context", "production"]);
  console.log(`Enrolled "${actorId}" as ${role}. Redeploy for the change to reach running functions.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
