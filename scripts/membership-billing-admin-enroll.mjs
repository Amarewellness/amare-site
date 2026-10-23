/**
 * Membership billing administrators — bootstrap and inspection.
 *
 * Production database access from the Netlify CLI is READ-ONLY, and there is deliberately no
 * HTTP bootstrap route. The first owner is therefore enrolled through the deploy pipeline:
 * this script writes a migration that inserts only a salted scrypt hash, marked `must_rotate`,
 * so the owner must set a new key in /admin/monthly-memberships before any billing action works
 * (the committed hash stops being valid at first sign-in). After that, owners enroll and revoke
 * other admins in the admin UI.
 *
 * Bootstrap first owner:  node scripts/membership-billing-admin-enroll.mjs --bootstrap-owner
 *                         (then commit the generated migration and deploy)
 * List (read-only):       node scripts/membership-billing-admin-enroll.mjs --list
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getDatabase } from "@netlify/database";
import { ACTOR_ID_RE, BILLING_ROLES, hashBillingKey, validateBillingKey } from "../netlify/functions/membership-change-auth.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "node_modules/netlify-cli/bin/run.js");
const MIGRATIONS_DIR = path.join(root, "netlify/database/migrations");

function netlifyJson(args) {
  const r = spawnSync(process.execPath, [cli, ...args, "--json"], { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`netlify ${args.slice(0, 2).join(" ")} failed (are you logged in to Netlify?)`);
  return JSON.parse(String(r.stdout));
}

/** Read-only production database pool via the Netlify CLI. */
export function connectProductionDb(branch = "production") {
  const status = netlifyJson(["database", "status", "--branch", branch, "--show-credentials"]);
  const url = String(status?.database?.connectionString || "");
  if (status?.target !== branch || !/^postgres(ql)?:\/\//.test(url) || url.includes("***")) {
    throw new Error(`Could not resolve the ${branch} database connection.`);
  }
  const db = getDatabase({ connectionString: url });
  return {
    query: (text, values = []) => db.pool.query(text, values),
    close: () => db.pool.end?.(),
  };
}

/** Netlify account email of the operator, recorded as `created_by`. */
export function operatorIdentity() {
  try {
    const r = spawnSync(process.execPath, [cli, "api", "getCurrentUser"], { cwd: root, encoding: "utf8", windowsHide: true });
    const user = JSON.parse(String(r.stdout));
    return `netlify:${String(user.email || user.id || "unknown").toLowerCase()}`;
  } catch {
    return "netlify:unknown";
  }
}

/** @param {string} s */
function sqlString(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/**
 * SQL that inserts one billing admin (hash only). Idempotent: never overwrites an existing row.
 * @param {{ actorId: string, role: string, displayName?: string | null, key: string, createdBy: string, mustRotate: boolean, expiresInterval?: string | null }} input
 */
export function billingAdminMigrationSql(input) {
  if (!ACTOR_ID_RE.test(input.actorId)) throw new Error("invalid_actor_id");
  if (!BILLING_ROLES.includes(input.role)) throw new Error("invalid_role");
  const problem = validateBillingKey(input.key);
  if (problem) throw new Error(problem);
  if (input.expiresInterval && !/^\d{1,3} (minutes|hours|days)$/.test(input.expiresInterval)) throw new Error("invalid_interval");
  const { keySalt, keyHash } = hashBillingKey(input.key);
  const expires = input.expiresInterval ? `NOW() + INTERVAL ${sqlString(input.expiresInterval)}` : "NULL";
  return [
    `-- Billing admin "${input.actorId}" (${input.role}). Salted scrypt hash only; no plaintext key.`,
    input.mustRotate ? "-- must_rotate: billing actions stay blocked until the admin sets their own key." : "",
    input.expiresInterval ? `-- Expires ${input.expiresInterval} after this migration is applied.` : "",
    "",
    `INSERT INTO amare_billing_admins (actor_id, display_name, role, key_salt, key_hash, created_by, must_rotate, expires_at)`,
    `VALUES (${sqlString(input.actorId)}, ${input.displayName ? sqlString(input.displayName) : "NULL"}, ${sqlString(input.role)}, ${sqlString(keySalt)}, ${sqlString(keyHash)}, ${sqlString(input.createdBy)}, ${input.mustRotate ? "TRUE" : "FALSE"}, ${expires})`,
    `ON CONFLICT (actor_id) DO NOTHING;`,
    "",
    `INSERT INTO amare_billing_audit_log (actor_id, action, outcome, detail)`,
    `VALUES (${sqlString(input.createdBy)}, 'migration_enroll', 'ok', ${sqlString(JSON.stringify({ enrolled: input.actorId, role: input.role, mustRotate: input.mustRotate, expires: input.expiresInterval || null }))}::jsonb);`,
    "",
  ]
    .filter((line, i, all) => line !== "" || all[i - 1] !== "")
    .join("\n");
}

/** UTC migration version (YYYYMMDDHHMMSS) later than every existing migration. */
export function nextMigrationVersion() {
  const existing = fs.readdirSync(MIGRATIONS_DIR).map((f) => Number(f.slice(0, 14))).filter(Number.isFinite);
  const now = Number(new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14));
  return String(Math.max(now, ...existing.map((v) => v + 1)));
}

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      const write = rl._writeToOutput.bind(rl);
      rl._writeToOutput = (s) => write(s.includes(question) ? s : "");
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

async function main() {
  if (process.argv.includes("--list")) {
    const db = connectProductionDb();
    try {
      const r = await db.query(
        `SELECT actor_id, role, status, must_rotate, expires_at, created_by, last_verified_at FROM amare_billing_admins ORDER BY actor_id`,
      );
      if (!r.rows.length) console.log("No billing admins enrolled in production.");
      for (const a of r.rows) {
        console.log(
          `${a.actor_id}  ${a.role}  ${a.status}${a.must_rotate ? "  must-rotate" : ""}${a.expires_at ? `  expires=${new Date(a.expires_at).toISOString()}` : ""}  created_by=${a.created_by}  last_verified=${a.last_verified_at ? new Date(a.last_verified_at).toISOString() : "never"}`,
        );
      }
    } finally {
      await db.close();
    }
    return;
  }

  if (!process.argv.includes("--bootstrap-owner")) {
    console.log("Usage: --bootstrap-owner | --list   (see file header)");
    return;
  }
  const db = connectProductionDb();
  try {
    const owners = await db.query(
      `SELECT COUNT(*)::int AS n FROM amare_billing_admins WHERE role = 'owner' AND status = 'active' AND (expires_at IS NULL OR expires_at > NOW())`,
    );
    if (owners.rows[0].n > 0) {
      console.log("Production already has an active owner. Enroll further admins in /admin/monthly-memberships.");
      return;
    }
  } finally {
    await db.close();
  }
  const actorId = (await ask("Owner billing admin id (e.g. snir): ")).toLowerCase();
  const displayName = await ask("Display name (optional): ");
  const key = await ask("One-time bootstrap key (min 12 chars, hidden): ", { hidden: true });
  const again = await ask("Repeat key: ", { hidden: true });
  if (key !== again) throw new Error("Keys do not match.");
  const sql = billingAdminMigrationSql({
    actorId,
    role: "owner",
    displayName: displayName || null,
    key,
    createdBy: operatorIdentity(),
    mustRotate: true,
  });
  const file = path.join(MIGRATIONS_DIR, `${nextMigrationVersion()}_amare_billing_owner_${actorId.replace(/[^a-z0-9]/g, "_")}.sql`);
  fs.writeFileSync(file, sql);
  console.log(`Wrote ${path.relative(root, file)}.`);
  console.log("Commit it and deploy. Then sign in at /admin/monthly-memberships with this key and set your own key.");
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
