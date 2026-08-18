/**
 * Real-Postgres constraint proof for AMARÉ identity (Phase 1).
 * Uses the local Netlify Database by default. Never writes the live Mindbody site_id.
 *
 * Run: npm run test:amare-identity-db
 * Hosted preview only:
 *   AMARE_IDENTITY_ALLOW_PREVIEW=1 AMARE_IDENTITY_DB_BRANCH=<git-branch> npm run test:amare-identity-db
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const QA_SITE_ID = "amare-qa-phase1";
const REQUIRED_INDEXES = [
  "amare_studio_assoc_site_client_active_uidx",
  "amare_studio_assoc_user_site_active_uidx",
];
/** @type {import("node:child_process").ChildProcess | null} */
let localDbKeeper = null;

if ((process.env.AMARE_IDENTITY_DB_TARGET || "").trim().toLowerCase() === "production") {
  console.error("REFUSE — will not run identity writes against production.");
  process.exit(2);
}

const liveSiteId = (process.env.MINDBODY_SITE_ID || "").trim();
if (liveSiteId && liveSiteId === QA_SITE_ID) {
  console.error("REFUSE — MINDBODY_SITE_ID must not equal the QA site_id.");
  process.exit(2);
}

await resolveNetlifyDbUrl();

const {
  attachIdentity,
  closeIdentityDb,
  confirmAssociation,
  createAmareUser,
  createUserWithIdentity,
  findIdentity,
  identityQuery,
  listIdentities,
  promoteAssociationToLinked,
  proposeAssociation,
} = await import("../netlify/functions/amare-identity-store.mjs");

let failed = 0;
const createdUserIds = [];

function check(name, ok, detail) {
  if (ok) console.log(`PASS — ${name}`);
  else {
    failed += 1;
    console.log(`FAIL — ${name}${detail ? `\n  ${detail}` : ""}`);
  }
}

function isUniqueViolation(err) {
  const code = err?.code || err?.cause?.code;
  if (code === "23505") return true;
  return /duplicate key|unique constraint/i.test(String(err?.message || err));
}

function uniqueIndexName(err) {
  const msg = String(err?.constraint || err?.message || "");
  const match = msg.match(/amare_studio_assoc_[a-z_]+_uidx|amare_identities_provider_sub_uidx/);
  return match ? match[0] : "";
}

function stopLocalDbKeeper() {
  if (!localDbKeeper || localDbKeeper.killed) return;
  try {
    localDbKeeper.stdin?.write("\\q\n");
  } catch {
    /* ignore */
  }
  localDbKeeper.kill();
  localDbKeeper = null;
}

function splitSqlStatements(sql) {
  return String(sql)
    .split(/;\s*\n/)
    .map((s) =>
      s
        .split(/\r?\n/)
        .filter((line) => !/^\s*--/.test(line))
        .join("\n")
        .trim(),
    )
    .filter(Boolean);
}

async function applyOtpMigrationIfNeeded() {
  const exists = await identityQuery("SELECT to_regclass('public.amare_otp_challenges') AS t");
  const tableOk = Boolean(exists.rows[0]?.t);
  const chk = await identityQuery(
    `SELECT pg_get_constraintdef(oid) AS def
       FROM pg_constraint
      WHERE conname = 'amare_studio_assoc_block_reason_chk'`,
  );
  const reasonOk = /shared_computer_continue_as_new/.test(String(chk.rows[0]?.def || ""));
  if (!tableOk || !reasonOk) {
    const sql = await readFile(
      path.join(root, "netlify/database/migrations/20260816193000_amare_otp_challenges.sql"),
      "utf8",
    );
    for (const statement of splitSqlStatements(sql)) {
      const isTable = /CREATE TABLE amare_otp_challenges/i.test(statement);
      const isIndex = /CREATE INDEX amare_otp_challenges_/i.test(statement);
      const isReason = /amare_studio_assoc_block_reason_chk/i.test(statement);
      if (tableOk && (isTable || isIndex)) continue;
      if (reasonOk && isReason) continue;
      await identityQuery(statement);
    }
  }
  const ledger = await identityQuery("SELECT name FROM netlify.migrations WHERE name = $1", [
    "20260816193000_amare_otp_challenges",
  ]);
  if (!ledger.rows[0]) {
    try {
      await identityQuery("INSERT INTO netlify.migrations (name, applied_at) VALUES ($1, NOW())", [
        "20260816193000_amare_otp_challenges",
      ]);
    } catch (err) {
      check("record 2A.5 OTP migration in netlify.migrations", false, String(err?.message || err));
    }
  }
}

/**
 * Local Netlify Database is PGlite behind a short-lived TCP proxy.
 * `connect --json` prints a URL and then tears the proxy down, so tests must
 * hold `netlify database connect` open for the duration of the run.
 */
function netlifyCliPath() {
  return path.join(root, "node_modules/netlify-cli/bin/run.js");
}

function assertNotProductionBranch(branch) {
  if (/^(production|main|master)$/i.test(branch)) {
    throw new Error("refusing hosted identity writes on production/main");
  }
}

async function hostedBranchConnectionString(branch) {
  assertNotProductionBranch(branch);
  const { stdout } = await execFileAsync(
    process.execPath,
    [netlifyCliPath(), "database", "status", "--branch", branch, "--show-credentials", "--json"],
    { cwd: root, windowsHide: true },
  );
  const parsed = JSON.parse(stdout);
  const url = String(parsed.database?.connectionString || "").trim();
  if (!url || url.includes("***")) throw new Error("preview_db_url_unresolved");
  const applied = (parsed.applied || []).map((m) => m.name);
  if (!applied.includes("20260816000100_amare_identity")) {
    throw new Error("preview_migration_not_applied");
  }
  if (!applied.includes("20260816083000_amare_identities_provider_mindbody")) {
    throw new Error("preview_2a1_migration_not_applied");
  }
  if (!applied.includes("20260816193000_amare_otp_challenges")) {
    throw new Error("preview_2a5_otp_migration_not_applied");
  }
  return url;
}

async function resolveNetlifyDbUrl() {
  const branch = (process.env.AMARE_IDENTITY_DB_BRANCH || "").trim();
  if (branch) {
    if ((process.env.AMARE_IDENTITY_ALLOW_PREVIEW || "").trim() !== "1") {
      throw new Error("AMARE_IDENTITY_DB_BRANCH requires AMARE_IDENTITY_ALLOW_PREVIEW=1");
    }
    process.env.NETLIFY_DB_URL = await hostedBranchConnectionString(branch);
    return;
  }

  const existing = (
    process.env.NETLIFY_DB_URL ||
    process.env.NETLIFY_DATABASE_URL ||
    process.env.DATABASE_URL ||
    ""
  ).trim();
  if (existing) {
    if ((process.env.AMARE_IDENTITY_ALLOW_PREVIEW || "").trim() !== "1") {
      const localHint = /localhost|127\.0\.0\.1|\.local(?:[:/]|$)/i.test(existing);
      if (!localHint) {
        throw new Error(
          "Hosted NETLIFY_DB_URL requires AMARE_IDENTITY_ALLOW_PREVIEW=1 (preview branch only).",
        );
      }
    }
    process.env.NETLIFY_DB_URL = existing;
    return;
  }

  const child = spawn(process.execPath, [netlifyCliPath(), "database", "connect"], {
    cwd: root,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  localDbKeeper = child;

  const url = await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => {
      stopLocalDbKeeper();
      reject(new Error("local_netlify_db_connect_timeout"));
    }, 20000);
    const onData = (chunk) => {
      buf += String(chunk);
      const match = buf.match(/postgres:\/\/\S+/);
      if (match) {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        child.stderr.off("data", onData);
        resolve(match[0].replace(/[.,;]+$/, ""));
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`local_netlify_db_connect_exited:${code}`));
    });
  });

  process.env.NETLIFY_DB_URL = url;
}

async function expectUniqueFail(name, fn, expectedIndex) {
  try {
    await fn();
    check(name, false, "expected unique violation, write succeeded");
    return false;
  } catch (err) {
    const ok = isUniqueViolation(err);
    const index = uniqueIndexName(err);
    const indexOk = !expectedIndex || index === expectedIndex;
    check(
      name,
      ok && indexOk,
      `code=${err?.code || "?"} index=${index || "?"} ${err?.message || err}`,
    );
    return ok && indexOk;
  }
}

try {
  const indexes = await identityQuery(
    `SELECT indexname, indexdef
       FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = ANY($1::text[])
      ORDER BY indexname`,
    [REQUIRED_INDEXES],
  );
  const byName = new Map(indexes.rows.map((r) => [r.indexname, r.indexdef]));
  for (const name of REQUIRED_INDEXES) {
    const def = String(byName.get(name) || "");
    check(`index exists: ${name}`, Boolean(def));
    check(
      `index is UNIQUE + partial verified/linked: ${name}`,
      /UNIQUE INDEX/i.test(def) && /verified/.test(def) && /linked/.test(def),
      def,
    );
  }

  if ((process.env.AMARE_IDENTITY_DB_BRANCH || "").trim()) {
    check(
      "hosted CLI status tracks 20260816000100_amare_identity (preview branch)",
      true,
    );
    check(
      "hosted CLI status tracks 20260816083000_amare_identities_provider_mindbody (preview branch)",
      true,
    );
    check(
      "hosted CLI status tracks 20260816193000_amare_otp_challenges (preview branch)",
      true,
    );
  } else {
    await applyOtpMigrationIfNeeded();
    const ledger = await identityQuery(
      "SELECT name, applied_at FROM netlify.migrations WHERE name = ANY($1::text[])",
      [
        [
          "20260816000100_amare_identity",
          "20260816083000_amare_identities_provider_mindbody",
          "20260816193000_amare_otp_challenges",
        ],
      ],
    );
    const names = ledger.rows.map((r) => r.name);
    check(
      "netlify.migrations tracks 20260816000100_amare_identity",
      names.includes("20260816000100_amare_identity"),
      JSON.stringify(ledger.rows),
    );
    check(
      "netlify.migrations tracks 20260816083000_amare_identities_provider_mindbody",
      names.includes("20260816083000_amare_identities_provider_mindbody"),
      JSON.stringify(ledger.rows),
    );
    check(
      "netlify.migrations tracks 20260816193000_amare_otp_challenges",
      names.includes("20260816193000_amare_otp_challenges"),
      JSON.stringify(ledger.rows),
    );
  }

  const providerChk = await identityQuery(
    `SELECT pg_get_constraintdef(oid) AS def
       FROM pg_constraint
      WHERE conname = 'amare_identities_provider_chk'`,
  );
  const chkDef = String(providerChk.rows[0]?.def || "");
  check(
    "provider CHECK allows google | apple | email | mindbody",
    /google/.test(chkDef) && /apple/.test(chkDef) && /email/.test(chkDef) && /mindbody/.test(chkDef),
    chkDef,
  );

  const googleCreated = await createUserWithIdentity({
    provider: "google",
    providerSub: `qa-2a1-google-${Date.now()}`,
    email: "qa-2a1-google@example.test",
    email_verified: true,
  });
  createdUserIds.push(googleCreated.amare_user_id);
  check("provider=google accepted", googleCreated.provider === "google");
  const foundGoogle = await findIdentity("google", googleCreated.provider_sub);
  check(
    "findIdentity resolves exact provider+sub",
    foundGoogle && foundGoogle.amare_user_id === googleCreated.amare_user_id,
  );
  const listed = await listIdentities(googleCreated.amare_user_id);
  check("listIdentities returns the created google identity", listed.length === 1 && listed[0].provider === "google");
  const googleAssoc = await identityQuery(
    "SELECT COUNT(*)::int AS n FROM amare_studio_associations WHERE amare_user_id = $1",
    [googleCreated.amare_user_id],
  );
  check(
    "identity creation creates zero Studio associations",
    Number(googleAssoc.rows[0]?.n || 0) === 0,
  );

  const mbCreated = await createUserWithIdentity({
    provider: "mindbody",
    provider_sub: `qa-2a1-mb-oidc-${Date.now()}`,
  });
  createdUserIds.push(mbCreated.amare_user_id);
  check("provider=mindbody accepted", mbCreated.provider === "mindbody");

  const mbNumeric = await createUserWithIdentity({
    provider: "mindbody",
    provider_sub: "24400320",
  });
  createdUserIds.push(mbNumeric.amare_user_id);
  check(
    "mindbody sub \"24400320\" accepted when supplied as an actual provider_sub input",
    mbNumeric.provider === "mindbody" && mbNumeric.provider_sub === "24400320",
  );
  await expectUniqueFail(
    "identity uniqueness still enforced",
    () =>
      createUserWithIdentity({
        provider: "mindbody",
        provider_sub: "24400320",
      }),
    "amare_identities_provider_sub_uidx",
  );
  const mbAssoc = await identityQuery(
    "SELECT COUNT(*)::int AS n FROM amare_studio_associations WHERE amare_user_id = $1",
    [mbCreated.amare_user_id],
  );
  check(
    "Mindbody identity creation creates zero Studio associations",
    Number(mbAssoc.rows[0]?.n || 0) === 0,
  );
  const mbStatuses = await identityQuery(
    `SELECT status FROM amare_studio_associations
      WHERE amare_user_id = $1 AND status IN ('candidate', 'verified', 'linked')`,
    [mbCreated.amare_user_id],
  );
  check("Mindbody identity did not create candidate/verified/linked", mbStatuses.rows.length === 0);

  const beforeCount = await identityQuery("SELECT COUNT(*)::int AS n FROM amare_users");
  await expectUniqueFail(
    "same provider+sub cannot belong to two users (google)",
    () =>
      createUserWithIdentity({
        provider: "google",
        provider_sub: googleCreated.provider_sub,
      }),
    "amare_identities_provider_sub_uidx",
  );
  const afterCount = await identityQuery("SELECT COUNT(*)::int AS n FROM amare_users");
  check(
    "createUserWithIdentity is atomic",
    Number(afterCount.rows[0]?.n) === Number(beforeCount.rows[0]?.n),
    `before=${beforeCount.rows[0]?.n} after=${afterCount.rows[0]?.n}`,
  );

  for (const provider of ["apple", "email", "mindbody"]) {
    const first = await createUserWithIdentity({
      provider,
      provider_sub: `qa-2a1-${provider}-uniq-${Date.now()}`,
      email: provider === "email" ? `qa-2a1-${provider}@example.test` : null,
      email_verified: provider === "email",
    });
    createdUserIds.push(first.amare_user_id);
    check(`provider=${provider} accepted`, first.provider === provider);
    await expectUniqueFail(
      `same provider+sub cannot belong to two users (${provider})`,
      () =>
        createUserWithIdentity({
          provider,
          provider_sub: first.provider_sub,
        }),
      "amare_identities_provider_sub_uidx",
    );
  }

  let unknownDbThrew = false;
  try {
    await createUserWithIdentity({ provider: "facebook", provider_sub: "x" });
  } catch (err) {
    unknownDbThrew = String(err.message) === "unknown_identity_provider";
  }
  check("unknown provider rejected", unknownDbThrew);

  const userA = await createAmareUser();
  const userB = await createAmareUser();
  createdUserIds.push(userA.amare_user_id, userB.amare_user_id);
  check("create user A", /^usr_/.test(userA.amare_user_id));
  check("create user B", /^usr_/.test(userB.amare_user_id) && userB.amare_user_id !== userA.amare_user_id);

  await attachIdentity({
    amare_user_id: userA.amare_user_id,
    provider: "google",
    provider_sub: `qa-phase1-${userA.amare_user_id}`,
    email: "qa-a@example.test",
    email_verified: true,
  });
  check("attach identity A", true);
  await expectUniqueFail(
    "identity duplicate (provider, provider_sub) MUST FAIL",
    () =>
      attachIdentity({
        amare_user_id: userB.amare_user_id,
        provider: "google",
        provider_sub: `qa-phase1-${userA.amare_user_id}`,
        email: "qa-b@example.test",
        email_verified: true,
      }),
    "amare_identities_provider_sub_uidx",
  );

  await confirmAssociation({
    amare_user_id: userA.amare_user_id,
    site_id: QA_SITE_ID,
    fromStatus: "candidate",
    client_id: 100,
    claim_method: "staff_manual",
    claim_proof_ref: "qa-phase1-user-a-100",
    explicitConfirm: true,
  });
  const verifiedA = await identityQuery(
    `SELECT status, client_id FROM amare_studio_associations
      WHERE amare_user_id = $1 AND site_id = $2 AND status = 'verified'`,
    [userA.amare_user_id, QA_SITE_ID],
  );
  check(
    "User A → clientId 100 → verified PASS",
    verifiedA.rows.length === 1 && Number(verifiedA.rows[0].client_id) === 100,
    JSON.stringify(verifiedA.rows),
  );

  const siteClientUnique = await expectUniqueFail(
    "User B → same clientId 100 → verified MUST FAIL",
    () =>
      confirmAssociation({
        amare_user_id: userB.amare_user_id,
        site_id: QA_SITE_ID,
        fromStatus: "candidate",
        client_id: 100,
        claim_method: "staff_manual",
        claim_proof_ref: "qa-phase1-user-b-100",
        explicitConfirm: true,
      }),
    "amare_studio_assoc_site_client_active_uidx",
  );

  const userSiteUnique = await expectUniqueFail(
    "User A → another clientId 200 → verified MUST FAIL",
    () =>
      confirmAssociation({
        amare_user_id: userA.amare_user_id,
        site_id: QA_SITE_ID,
        fromStatus: "candidate",
        client_id: 200,
        claim_method: "staff_manual",
        claim_proof_ref: "qa-phase1-user-a-200",
        explicitConfirm: true,
      }),
    "amare_studio_assoc_user_site_active_uidx",
  );

  const userC = await createAmareUser();
  const userD = await createAmareUser();
  createdUserIds.push(userC.amare_user_id, userD.amare_user_id);
  await proposeAssociation({
    amare_user_id: userC.amare_user_id,
    site_id: QA_SITE_ID,
    status: "candidate",
    client_id: 100,
  });
  await proposeAssociation({
    amare_user_id: userD.amare_user_id,
    site_id: QA_SITE_ID,
    status: "candidate",
    client_id: 100,
  });
  const candidates = await identityQuery(
    `SELECT amare_user_id FROM amare_studio_associations
      WHERE site_id = $1 AND status = 'candidate' AND client_id = 100`,
    [QA_SITE_ID],
  );
  check("candidate duplicate → allowed", candidates.rows.length === 2, JSON.stringify(candidates.rows));

  const userE = await createAmareUser();
  const userF = await createAmareUser();
  createdUserIds.push(userE.amare_user_id, userF.amare_user_id);
  await proposeAssociation({
    amare_user_id: userE.amare_user_id,
    site_id: QA_SITE_ID,
    status: "ambiguous",
    candidate_client_ids: [100, 200],
    block_reason: "duplicate_clients",
  });
  await proposeAssociation({
    amare_user_id: userF.amare_user_id,
    site_id: QA_SITE_ID,
    status: "ambiguous",
    candidate_client_ids: [100, 200],
    block_reason: "duplicate_clients",
  });
  const ambiguous = await identityQuery(
    `SELECT amare_user_id FROM amare_studio_associations
      WHERE site_id = $1 AND status = 'ambiguous'`,
    [QA_SITE_ID],
  );
  check("ambiguous duplicate → allowed", ambiguous.rows.length === 2, JSON.stringify(ambiguous.rows));

  const prevMemberRead = process.env.ENABLE_AMARE_MEMBER_READ;
  const prevStudioOps = process.env.ENABLE_AMARE_STUDIO_OPERATIONS;
  const prevAuthForLink = process.env.ENABLE_AMARE_AUTH;
  delete process.env.ENABLE_AMARE_MEMBER_READ;
  delete process.env.ENABLE_AMARE_STUDIO_OPERATIONS;
  let linkedThrew = false;
  try {
    await promoteAssociationToLinked();
  } catch (err) {
    linkedThrew = String(err.message) === "linked_forbidden_in_phase1";
  }
  check("verified → linked MUST FAIL in Phase 1", linkedThrew);
  check("linked remains forbidden", linkedThrew);
  check("candidate/ambiguous remain non-exclusive", candidates.rows.length === 2 && ambiguous.rows.length === 2);
  check("both Phase 1 association unique indexes still enforce", siteClientUnique && userSiteUnique);

  const stillVerified = await identityQuery(
    `SELECT status FROM amare_studio_associations
      WHERE amare_user_id = $1 AND site_id = $2 AND status IN ('verified', 'linked')`,
    [userA.amare_user_id, QA_SITE_ID],
  );
  check(
    "User A remains verified only (no linked row)",
    stillVerified.rows.length === 1 && stillVerified.rows[0].status === "verified",
    JSON.stringify(stillVerified.rows),
  );

  process.env.ENABLE_AMARE_AUTH = "1";
  process.env.ENABLE_AMARE_MEMBER_READ = "1";
  const linkedA = await promoteAssociationToLinked({
    amare_user_id: userA.amare_user_id,
    site_id: QA_SITE_ID,
    explicitPromote: true,
  });
  check("2B User A verified → linked with explicitPromote", linkedA.status === "linked" && linkedA.already !== true);
  const linkedAgain = await promoteAssociationToLinked({
    amare_user_id: userA.amare_user_id,
    site_id: QA_SITE_ID,
    explicitPromote: true,
  });
  check("2B linked promote is idempotent", linkedAgain.status === "linked" && linkedAgain.already === true);
  let noSteal = false;
  try {
    await promoteAssociationToLinked({
      amare_user_id: userB.amare_user_id,
      site_id: QA_SITE_ID,
      explicitPromote: true,
    });
  } catch (err) {
    noSteal = String(err.message) === "linked_requires_verified" || String(err.message) === "claim_conflict";
  }
  check("2B User B cannot steal User A linked client", noSteal);
  const linkedOwner = await identityQuery(
    `SELECT amare_user_id, status FROM amare_studio_associations
      WHERE site_id = $1 AND client_id = 100 AND status IN ('verified', 'linked')`,
    [QA_SITE_ID],
  );
  check(
    "2B one active owner of client 100 after link",
    linkedOwner.rows.length === 1 &&
      linkedOwner.rows[0].amare_user_id === userA.amare_user_id &&
      linkedOwner.rows[0].status === "linked",
    JSON.stringify(linkedOwner.rows),
  );
  if (prevMemberRead === undefined) delete process.env.ENABLE_AMARE_MEMBER_READ;
  else process.env.ENABLE_AMARE_MEMBER_READ = prevMemberRead;
  if (prevStudioOps === undefined) delete process.env.ENABLE_AMARE_STUDIO_OPERATIONS;
  else process.env.ENABLE_AMARE_STUDIO_OPERATIONS = prevStudioOps;
  if (prevAuthForLink === undefined) delete process.env.ENABLE_AMARE_AUTH;
  else process.env.ENABLE_AMARE_AUTH = prevAuthForLink;

  const liveLeak = await identityQuery(
    `SELECT COUNT(*)::int AS n FROM amare_studio_associations WHERE site_id = $1`,
    [liveSiteId || "__no_live_site__"],
  );
  check("QA writes did not use live MINDBODY_SITE_ID", Number(liveLeak.rows[0]?.n || 0) === 0);

  process.env.AMARE_OTP_PEPPER = process.env.AMARE_OTP_PEPPER || "qa-2a5-identity-db-otp-pepper!!";
  const { hashOtpCode } = await import("../netlify/functions/amare-auth-lib.mjs");
  const { consumeOtpChallenge, insertOtpChallenge } = await import("../netlify/functions/amare-otp-store.mjs");
  const otpEmail = `qa-2a5-otp-conc-${Date.now()}@example.test`;
  const otpCode = "246801";
  const otpHash = hashOtpCode(otpEmail, otpCode, process.env.AMARE_OTP_PEPPER);
  await insertOtpChallenge({
    email_normalized: otpEmail,
    code_hash: otpHash,
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    request_key: "qa-2a5-otp",
  });
  const stored = await identityQuery(
    "SELECT code_hash, attempt_count, consumed_at FROM amare_otp_challenges WHERE email_normalized = $1",
    [otpEmail],
  );
  check(
    "OTP table stores hash not plaintext",
    stored.rows.length === 1 &&
      stored.rows[0].code_hash === otpHash &&
      stored.rows[0].code_hash !== otpCode &&
      !JSON.stringify(stored.rows[0]).includes(otpCode),
  );
  const [left, right] = await Promise.all([
    consumeOtpChallenge({ emailNormalized: otpEmail, codeHash: otpHash }),
    consumeOtpChallenge({ emailNormalized: otpEmail, codeHash: otpHash }),
  ]);
  check(
    "Postgres concurrent double consume permits only one success",
    [left, right].filter((r) => r.ok).length === 1 && [left, right].some((r) => r.ok === false && r.reason === "consumed"),
  );
  const reasonChk = await identityQuery(
    `SELECT pg_get_constraintdef(oid) AS def
       FROM pg_constraint
      WHERE conname = 'amare_studio_assoc_block_reason_chk'`,
  );
  check(
    "block_reason allows shared_computer_continue_as_new",
    /shared_computer_continue_as_new/.test(String(reasonChk.rows[0]?.def || "")),
    String(reasonChk.rows[0]?.def || ""),
  );
} finally {
  try {
    await identityQuery("DELETE FROM amare_otp_challenges WHERE email_normalized LIKE 'qa-2a5-otp-%'");
    await identityQuery("DELETE FROM amare_studio_associations WHERE site_id = $1", [QA_SITE_ID]);
    if (createdUserIds.length) {
      await identityQuery("DELETE FROM amare_identities WHERE amare_user_id = ANY($1::text[])", [
        createdUserIds,
      ]);
      await identityQuery("DELETE FROM amare_users WHERE amare_user_id = ANY($1::text[])", [
        createdUserIds,
      ]);
    }
    const leftover = await identityQuery(
      "SELECT COUNT(*)::int AS n FROM amare_studio_associations WHERE site_id = $1",
      [QA_SITE_ID],
    );
    check("QA site_id rows cleaned up", Number(leftover.rows[0]?.n || 0) === 0);
  } catch (err) {
    check("QA cleanup", false, String(err?.message || err));
  }
  await closeIdentityDb();
  stopLocalDbKeeper();
}

if (failed) {
  console.log(`\n${failed} real-DB check(s) failed`);
  process.exit(1);
}
console.log("\nAll AMARÉ identity real-Postgres constraint checks passed.");
