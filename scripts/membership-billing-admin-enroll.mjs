/**
 * Enroll, list or revoke membership billing administrators directly in the PRODUCTION database.
 *
 * This is the only way to create the first owner: it requires a Netlify-authenticated operator
 * (the CLI resolves the production database credentials), so there is no HTTP bootstrap route.
 * Later admins can also be enrolled by an existing owner in /admin/monthly-memberships.
 *
 * Only a salted scrypt hash is stored. The key is typed with hidden input and never printed;
 * the database connection string is held in memory only.
 *
 * Run:     node scripts/membership-billing-admin-enroll.mjs
 * List:    node scripts/membership-billing-admin-enroll.mjs --list
 * Revoke:  node scripts/membership-billing-admin-enroll.mjs --revoke <actorId>
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getDatabase } from "@netlify/database";
import { ACTOR_ID_RE, BILLING_ROLES, hashBillingKey, validateBillingKey } from "../netlify/functions/membership-change-auth.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "node_modules/netlify-cli/bin/run.js");

function netlifyJson(args) {
  const r = spawnSync(process.execPath, [cli, ...args, "--json"], { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`netlify ${args.slice(0, 2).join(" ")} failed (are you logged in to Netlify?)`);
  return JSON.parse(String(r.stdout));
}

/** Production database pool via the Netlify CLI (operator must be logged in to the site's team). */
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

/** Netlify account email of the operator, recorded as `created_by` / audit actor. */
export function operatorIdentity() {
  try {
    const r = spawnSync(process.execPath, [cli, "api", "getCurrentUser"], { cwd: root, encoding: "utf8", windowsHide: true });
    const user = JSON.parse(String(r.stdout));
    return `netlify:${String(user.email || user.id || "unknown").toLowerCase()}`;
  } catch {
    return "netlify:unknown";
  }
}

/** @param {{ query: Function }} db */
export async function assertBillingTables(db) {
  const r = await db.query("SELECT to_regclass('public.amare_billing_admins') AS t");
  if (!r.rows[0]?.t) throw new Error("amare_billing_admins does not exist yet — deploy the migration first.");
}

/**
 * @param {{ query: Function }} db
 * @param {{ actorId: string, role: string, displayName?: string | null, key: string, createdBy: string }} input
 */
export async function enrollBillingAdmin(db, input) {
  if (!ACTOR_ID_RE.test(input.actorId)) throw new Error("invalid_actor_id");
  if (!BILLING_ROLES.includes(input.role)) throw new Error("invalid_role");
  const problem = validateBillingKey(input.key);
  if (problem) throw new Error(problem);
  const { keySalt, keyHash } = hashBillingKey(input.key);
  const r = await db.query(
    `INSERT INTO amare_billing_admins (actor_id, display_name, role, key_salt, key_hash, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (actor_id) DO UPDATE SET
       display_name = EXCLUDED.display_name, role = EXCLUDED.role,
       key_salt = EXCLUDED.key_salt, key_hash = EXCLUDED.key_hash,
       status = 'active', revoked_at = NULL, revoked_by = NULL,
       key_rotated_at = NOW(), updated_at = NOW()
     RETURNING actor_id, role, status`,
    [input.actorId, input.displayName ?? null, input.role, keySalt, keyHash, input.createdBy],
  );
  await db.query(
    `INSERT INTO amare_billing_audit_log (actor_id, action, outcome, detail) VALUES ($1, 'cli_enroll', 'ok', $2::jsonb)`,
    [input.createdBy, JSON.stringify({ enrolled: input.actorId, role: input.role })],
  );
  return r.rows[0];
}

/** @param {{ query: Function }} db @param {string} actorId @param {string} revokedBy */
export async function revokeBillingAdmin(db, actorId, revokedBy) {
  const r = await db.query(
    `UPDATE amare_billing_admins SET status = 'revoked', revoked_at = NOW(), revoked_by = $2, updated_at = NOW()
      WHERE actor_id = $1 AND status = 'active' RETURNING actor_id`,
    [actorId, revokedBy],
  );
  await db.query(
    `INSERT INTO amare_billing_audit_log (actor_id, action, outcome, detail) VALUES ($1, 'cli_revoke', $2, $3::jsonb)`,
    [revokedBy, r.rows[0] ? "ok" : "not_active", JSON.stringify({ revoked: actorId })],
  );
  return Boolean(r.rows[0]);
}

/** @param {{ query: Function }} db */
export async function listBillingAdmins(db) {
  const r = await db.query(
    `SELECT actor_id, role, status, created_by, created_at, last_verified_at, revoked_at FROM amare_billing_admins ORDER BY actor_id`,
  );
  return r.rows;
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
  const db = connectProductionDb();
  try {
    await assertBillingTables(db);
    const operator = operatorIdentity();
    if (process.argv.includes("--list")) {
      for (const a of await listBillingAdmins(db)) {
        console.log(`${a.actor_id}  ${a.role}  ${a.status}  created_by=${a.created_by}  last_verified=${a.last_verified_at ?? "never"}`);
      }
      return;
    }
    const revokeIdx = process.argv.indexOf("--revoke");
    if (revokeIdx >= 0) {
      const actorId = String(process.argv[revokeIdx + 1] || "").toLowerCase();
      console.log((await revokeBillingAdmin(db, actorId, operator)) ? `Revoked "${actorId}".` : `"${actorId}" was not active.`);
      return;
    }
    const actorId = (await ask("Billing admin id (e.g. snir): ")).toLowerCase();
    const role = (await ask(`Role (${BILLING_ROLES.join(" / ")}): `)).toLowerCase();
    const displayName = await ask("Display name (optional): ");
    const key = await ask("Billing key (min 12 chars, hidden): ", { hidden: true });
    const again = await ask("Repeat billing key: ", { hidden: true });
    if (key !== again) throw new Error("Keys do not match.");
    const row = await enrollBillingAdmin(db, { actorId, role, displayName: displayName || null, key, createdBy: operator });
    console.log(`Enrolled "${row.actor_id}" as ${row.role} in the production database. No redeploy needed.`);
  } finally {
    await db.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
