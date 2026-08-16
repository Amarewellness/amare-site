/**
 * Prove Deploy Preview DB ≠ production DB. Writes preview only. Never --prod.
 *
 *   AMARE_IDENTITY_ALLOW_PREVIEW=1 AMARE_IDENTITY_DB_BRANCH=<git-branch> npm run test:amare-identity-preview
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const QA_SITE_ID = "amare-qa-phase1";
const MIGRATION = "20260816000100_amare_identity";

const branch = (process.env.AMARE_IDENTITY_DB_BRANCH || "").trim();
if ((process.env.AMARE_IDENTITY_ALLOW_PREVIEW || "").trim() !== "1") {
  console.error("REFUSE — set AMARE_IDENTITY_ALLOW_PREVIEW=1");
  process.exit(2);
}
if (!branch || /^(production|main|master)$/i.test(branch)) {
  console.error("REFUSE — AMARE_IDENTITY_DB_BRANCH must be a preview git branch, not production/main.");
  process.exit(2);
}
if ((process.env.AMARE_IDENTITY_DB_TARGET || "").trim().toLowerCase() === "production") {
  console.error("REFUSE — will not run identity writes against production.");
  process.exit(2);
}

function netlifyCliPath() {
  return path.join(root, "node_modules/netlify-cli/bin/run.js");
}

async function databaseStatus(branchName, { credentials = false } = {}) {
  const args = ["database", "status", "--branch", branchName, "--json"];
  if (credentials) args.splice(3, 0, "--show-credentials");
  const { stdout } = await execFileAsync(process.execPath, [netlifyCliPath(), ...args], {
    cwd: root,
    windowsHide: true,
  });
  return JSON.parse(stdout);
}

function appliedNames(status) {
  return (status.applied || []).map((m) => m.name);
}

function pendingNames(status) {
  return (status.pending || []).map((m) => m.name);
}

let failed = 0;
function check(name, ok, detail) {
  if (ok) console.log(`PASS — ${name}`);
  else {
    failed += 1;
    console.log(`FAIL — ${name}${detail ? `\n  ${detail}` : ""}`);
  }
}

const previewStatus = await databaseStatus(branch);
check(
  `preview branch ${branch} has ${MIGRATION} applied`,
  appliedNames(previewStatus).includes(MIGRATION),
  JSON.stringify({ applied: appliedNames(previewStatus), pending: pendingNames(previewStatus) }),
);
check(
  "preview has no pending identity migration",
  !pendingNames(previewStatus).includes(MIGRATION),
  JSON.stringify(pendingNames(previewStatus)),
);

const productionStatus = await databaseStatus("production");
const prodHasSchema = appliedNames(productionStatus).includes(MIGRATION);
check(
  "production status is readable and distinct from preview",
  productionStatus.target === "production" && previewStatus.target !== "production",
  JSON.stringify({ previewTarget: previewStatus.target, prodTarget: productionStatus.target }),
);

if (!appliedNames(previewStatus).includes(MIGRATION)) {
  console.log("\nPreview migration not applied yet — isolation writes skipped.");
  process.exit(failed ? 1 : 2);
}

const creds = await databaseStatus(branch, { credentials: true });
const previewUrl = String(creds.database?.connectionString || "").trim();
if (!previewUrl || previewUrl.includes("***")) {
  console.error("REFUSE — preview connection string unresolved.");
  process.exit(2);
}
process.env.NETLIFY_DB_URL = previewUrl;

const { closeIdentityDb, createAmareUser, identityQuery } = await import(
  "../netlify/functions/amare-identity-store.mjs"
);

let qaUserId = "";
try {
  const created = await createAmareUser();
  qaUserId = created.amare_user_id;
  await identityQuery(
    `INSERT INTO amare_studio_associations
      (amare_user_id, system, site_id, client_id, status, claim_method)
     VALUES ($1, 'mindbody', $2, 100, 'candidate', 'none')`,
    [qaUserId, QA_SITE_ID],
  );
  const previewRow = await identityQuery(
    "SELECT amare_user_id FROM amare_users WHERE amare_user_id = $1",
    [qaUserId],
  );
  check("QA user exists on preview", previewRow.rows.length === 1, qaUserId);

  if (!prodHasSchema) {
    check(
      "production does not have identity schema (pending) so QA row cannot exist there",
      pendingNames(productionStatus).includes(MIGRATION) && appliedNames(productionStatus).length === 0,
      JSON.stringify({
        applied: appliedNames(productionStatus),
        pending: pendingNames(productionStatus),
      }),
    );
  } else {
    const prodCreds = await databaseStatus("production", { credentials: true });
    const prodUrl = String(prodCreds.database?.connectionString || "").trim();
    if (!prodUrl || prodUrl.includes("***")) {
      check("production SELECT connection", false, "unresolved");
    } else {
      const { getDatabase } = await import("@netlify/database");
      const prodDb = getDatabase({ connectionString: prodUrl });
      try {
        const found = await prodDb.pool.query("SELECT amare_user_id FROM amare_users WHERE amare_user_id = $1", [
          qaUserId,
        ]);
        check("QA user absent from production", (found.rows || []).length === 0, qaUserId);
      } finally {
        if (prodDb.pool?.end) await prodDb.pool.end();
      }
    }
  }
} finally {
  try {
    if (qaUserId) {
      await identityQuery("DELETE FROM amare_studio_associations WHERE amare_user_id = $1 AND site_id = $2", [
        qaUserId,
        QA_SITE_ID,
      ]);
      await identityQuery("DELETE FROM amare_users WHERE amare_user_id = $1", [qaUserId]);
      const leftover = await identityQuery("SELECT amare_user_id FROM amare_users WHERE amare_user_id = $1", [
        qaUserId,
      ]);
      check("preview QA row cleaned up", leftover.rows.length === 0);
    }
  } catch (err) {
    check("preview QA cleanup", false, String(err?.message || err));
  }
  await closeIdentityDb();
}

if (failed) {
  console.log(`\n${failed} preview isolation check(s) failed`);
  process.exit(1);
}
console.log("\nPreview DB isolation checks passed. Production was not written.");
