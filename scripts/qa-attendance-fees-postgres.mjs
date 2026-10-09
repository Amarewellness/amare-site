/**
 * AMARÉ attendance fees — real Postgres integration (Phase 2).
 * Non-production only. Synthetic visit IDs. Cleans up after run.
 *
 * Run (default — local Netlify Postgres only):
 *   npm run test:attendance-fees-postgres
 *   node scripts/qa-attendance-fees-postgres.mjs --local
 *
 * Hosted preview (explicit opt-in; never production/main):
 *   node scripts/qa-attendance-fees-postgres.mjs --preview <git-branch>
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import "./load-env.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATION_NAME = "20261009160000_amare_attendance_fees";
const QA_VISIT_BASE = 9_100_000_000_000;
/** Synthetic visit_id namespace — reconciler QA must not scan rows outside this range. */
const QA_VISIT_ID_MIN = QA_VISIT_BASE;
const QA_VISIT_ID_MAX = QA_VISIT_BASE + 9_999;
const QA_RECONCILE_LIST_OPTS = { visitIdMin: QA_VISIT_ID_MIN, visitIdMax: QA_VISIT_ID_MAX };
const QA_CLIENT_ID = 9_100_000_001;
const QA_CLASS_ID = 9_100_000_002;
const QA_SITE_ID = 9_100_000_003;

/** @type {import("node:child_process").ChildProcess | null} */
let localDbKeeper = null;

const CONFIG_DRY = { enabled: true, dryRun: true };

/**
 * @param {string[]} argv
 * @returns {{ mode: "local" | "preview"; previewBranch: string | null }}
 */
function parseCliArgs(argv) {
  /** @type {{ mode: "local" | "preview"; previewBranch: string | null }} */
  const out = { mode: "local", previewBranch: null };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: node scripts/qa-attendance-fees-postgres.mjs [--local] [--preview <branch>]",
      );
      process.exit(0);
    }
    if (arg === "--local") {
      out.mode = "local";
      continue;
    }
    if (arg === "--preview") {
      out.mode = "preview";
      const branch = (argv[i + 1] || "").trim();
      if (!branch || branch.startsWith("-")) {
        console.error("--preview requires a non-production git branch name");
        process.exit(2);
      }
      out.previewBranch = branch;
      i += 1;
      continue;
    }
    console.error(`Unknown argument: ${arg}`);
    process.exit(2);
  }
  if (out.mode === "preview") {
    assertNotProductionBranch(out.previewBranch || "");
    if (/production/i.test(out.previewBranch || "")) {
      console.error("REFUSE — preview branch name must not be production");
      process.exit(2);
    }
  }
  return out;
}

const cli = parseCliArgs(process.argv);

let failed = 0;
function check(name, ok, detail) {
  if (ok) console.log(`PASS — ${name}`);
  else {
    failed += 1;
    console.error(`FAIL — ${name}${detail ? ` (${detail})` : ""}`);
  }
}

function netlifyCliPath() {
  return path.join(root, "node_modules/netlify-cli/bin/run.js");
}

function assertNotProductionBranch(branch) {
  if (/^(production|main|master)$/i.test(branch)) {
    throw new Error("refusing_attendance_fee_writes_on_production_branch");
  }
}

function describeConnectionString(url) {
  const raw = String(url || "").trim();
  const m = raw.match(/^postgres(?:ql)?:\/\/(?:[^@]+@)?([^:/]+)(?::(\d+))?\/([^?]+)/i);
  if (!m) return { host: "(unparsed)", port: null, database: null };
  return { host: m[1], port: m[2] || "5432", database: m[3] };
}

function isLocalDbUrl(url) {
  return /localhost|127\.0\.0\.1|\.local(?:[:/]|$)/i.test(String(url || ""));
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
  return url;
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

async function resolvePostgresUrl(opts) {
  if (opts.mode === "preview") {
    const url = await hostedBranchConnectionString(opts.previewBranch || "");
    process.env.NETLIFY_DB_URL = url;
    return url;
  }

  const existing = (
    process.env.NETLIFY_DB_URL ||
    process.env.NETLIFY_DATABASE_URL ||
    process.env.DATABASE_URL ||
    ""
  ).trim();

  if (existing) {
    if (!isLocalDbUrl(existing)) {
      throw new Error(
        "Hosted DATABASE_URL refused in default local mode; use --preview <branch> or a localhost URL.",
      );
    }
    process.env.NETLIFY_DB_URL = existing;
    return existing;
  }

  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [netlifyCliPath(), "database", "status", "--json"],
      { cwd: root, windowsHide: true },
    );
    const parsed = JSON.parse(stdout);
    const statusUrl = String(parsed.database?.connectionString || "").trim();
    const target = String(parsed.target || "").trim().toLowerCase();
    if (statusUrl && (target === "local" || isLocalDbUrl(statusUrl))) {
      process.env.NETLIFY_DB_URL = statusUrl;
      return statusUrl;
    }
  } catch {
    /* fall through to connect spawn */
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
    }, 25000);
    const onData = (chunk) => {
      buf += String(chunk);
      const match = buf.match(/postgres:\/\/\S+/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0].replace(/[\s"'`]+$/, ""));
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      if (!buf.match(/postgres:\/\//)) {
        clearTimeout(timer);
        reject(new Error(`local_netlify_db_connect_exit_${code}`));
      }
    });
  });

  process.env.NETLIFY_DB_URL = url;
  return url;
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

async function applyMigrationIfNeeded(query) {
  const reg = await query("SELECT to_regclass('public.amare_attendance_fees') AS t", []);
  if (reg.rows[0]?.t) {
    console.log("Migration already applied (amare_attendance_fees exists).");
    return;
  }
  const sql = await readFile(
    path.join(root, "netlify/database/migrations/20261009160000_amare_attendance_fees.sql"),
    "utf8",
  );
  for (const statement of splitSqlStatements(sql)) {
    await query(statement, []);
  }
  console.log("Migration applied: 20261009160000_amare_attendance_fees.sql");
}

function qaVisitId(suffix) {
  return QA_VISIT_BASE + suffix;
}

function cs(id, productId, name, remaining = 1) {
  return {
    Id: id,
    ProductId: productId,
    Name: name,
    Remaining: remaining,
    ExpirationDate: "2027-12-31T00:00:00",
  };
}

function visitRow(clientServiceId, visitId) {
  return {
    Id: visitId,
    ClassId: QA_CLASS_ID,
    ClientId: QA_CLIENT_ID,
    ClientServiceId: clientServiceId,
  };
}

const unlimited135 = cs(910001, 100135, "AMARÉ Monthly Unlimited", 999999);
const unlimited056 = cs(910002, 100056, "Unlimited", 999999);
const monthly8 = cs(910003, 100134, "Monthly 8", 8);
const ncs = cs(910004, 100012, "NCS", 3);
const pack10 = cs(910005, 100127, "10 Pack", 4);

const url = await resolvePostgresUrl(cli);

const { host, port, database } = describeConnectionString(url);
console.log("=== Non-production Postgres target (no secrets) ===");
console.log(`mode=${cli.mode} host=${host} port=${port} database=${database}`);
console.log(`local_url=${isLocalDbUrl(url)}`);

if (cli.mode === "local" && !isLocalDbUrl(url)) {
  console.error("BLOCKER — local mode requires a localhost database URL");
  stopLocalDbKeeper();
  process.exit(2);
}
if (cli.mode === "preview") {
  assertNotProductionBranch(cli.previewBranch || "");
}

const {
  attendanceFeeQuery,
  createPostgresAttendanceFeeStore,
  ATTENDANCE_FEE_STALE_PROCESSING_MS,
  ATTENDANCE_FEE_AMOUNT_CENTS,
} = await import("../netlify/functions/attendance-fee-store.mjs");

const { recordAttendanceFeeCandidate } = await import("../netlify/functions/attendance-fee-lib.mjs");

const query = attendanceFeeQuery;
await applyMigrationIfNeeded(query);

const store = createPostgresAttendanceFeeStore();
/** @type {number[]} */
const createdVisitIds = [];

async function trackVisit(visitId) {
  createdVisitIds.push(visitId);
}

async function cleanup() {
  if (!createdVisitIds.length) return;
  await query(
    `DELETE FROM amare_attendance_fees WHERE visit_id = ANY($1::bigint[])`,
    [createdVisitIds],
  );
}

function baseCandidate(visitId, overrides = {}) {
  return {
    visitId,
    siteId: QA_SITE_ID,
    classId: QA_CLASS_ID,
    clientId: QA_CLIENT_ID,
    clientServiceId: unlimited135.Id,
    mindbodyProductId: 100135,
    feeType: "late_cancel",
    amountCents: ATTENDANCE_FEE_AMOUNT_CENTS,
    currency: "usd",
    status: "pending",
    dryRun: false,
    skipReason: null,
    failureClass: null,
    triggerSource: "qa_postgres",
    triggerAt: new Date().toISOString(),
    classStartAt: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
    webhookMessageId: null,
    ...overrides,
  };
}

console.log("\n=== Schema verification ===");
{
  const cols = await query(
    `SELECT column_name, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'amare_attendance_fees'
      ORDER BY ordinal_position`,
    [],
  );
  check("table amare_attendance_fees exists", cols.rows.length > 20);
  const pk = await query(
    `SELECT a.attname
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = 'amare_attendance_fees'::regclass AND i.indisprimary`,
    [],
  );
  check("PK is visit_id", pk.rows.some((r) => r.attname === "visit_id"));
  const idx = await query(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'amare_attendance_fees'`,
    [],
  );
  const names = idx.rows.map((r) => r.indexname);
  check("status index present", names.some((n) => n.includes("status")));
  check("default amount_cents", cols.rows.some((r) => r.column_name === "amount_cents" && r.column_default));
}

console.log("\n=== Postgres store / concurrency ===");

{
  const visitId = qaVisitId(1);
  await trackVisit(visitId);
  const ins = await store.recordOrGetAttendanceFeeCandidate(baseCandidate(visitId));
  check("1 insert pending candidate", ins.created && ins.record?.status === "pending");
}

{
  const visitId = qaVisitId(2);
  await trackVisit(visitId);
  await store.recordOrGetAttendanceFeeCandidate(baseCandidate(visitId));
  const dup = await store.recordOrGetAttendanceFeeCandidate(baseCandidate(visitId));
  const row = await store.getAttendanceFeeByVisitId(visitId);
  check("2 duplicate insert → one row", !dup.created && row?.visitId === visitId);
}

{
  const visitId = qaVisitId(3);
  await trackVisit(visitId);
  await store.recordOrGetAttendanceFeeCandidate(baseCandidate(visitId, { feeType: "late_cancel" }));
  const dup = await store.recordOrGetAttendanceFeeCandidate(
    baseCandidate(visitId, { feeType: "no_show" }),
  );
  check("3 first fee_type preserved", dup.record?.feeType === "late_cancel");
}

{
  const visitId = qaVisitId(4);
  await trackVisit(visitId);
  await store.recordOrGetAttendanceFeeCandidate(baseCandidate(visitId));
  const lock = await store.acquireAttendanceFeeProcessingLock(visitId);
  check("4 pending → processing", lock.acquired && lock.record?.status === "processing");
}

{
  const visitId = qaVisitId(5);
  await trackVisit(visitId);
  await store.recordOrGetAttendanceFeeCandidate(baseCandidate(visitId));
  const results = await Promise.all(
    Array.from({ length: 8 }, () => store.acquireAttendanceFeeProcessingLock(visitId)),
  );
  const winners = results.filter((r) => r.acquired);
  check("5 concurrent lock → one winner", winners.length === 1);
}

{
  const visitId = qaVisitId(6);
  await trackVisit(visitId);
  await store.recordOrGetAttendanceFeeCandidate(baseCandidate(visitId));
  const first = await store.acquireAttendanceFeeProcessingLock(visitId);
  const second = await store.acquireAttendanceFeeProcessingLock(visitId);
  check(
    "6 attempt_count increments once for winner",
    first.record?.attemptCount === 1 && (second.record?.attemptCount ?? 0) === 1,
  );
}

async function terminalCannotReacquire(visitId, setup) {
  await trackVisit(visitId);
  await store.recordOrGetAttendanceFeeCandidate(baseCandidate(visitId));
  const lock = await store.acquireAttendanceFeeProcessingLock(visitId);
  if (!lock.acquired) throw new Error("setup_lock_failed");
  await setup(visitId, lock);
  const again = await store.acquireAttendanceFeeProcessingLock(visitId);
  return again.acquired === false;
}

{
  const visitId = qaVisitId(7);
  const ok = await terminalCannotReacquire(visitId, async (vid) => {
    await store.markAttendanceFeeCharged(vid, {});
  });
  check("7 charged terminal cannot reacquire", ok);
}

{
  const visitId = qaVisitId(8);
  const ok = await terminalCannotReacquire(visitId, async (vid) => {
    await store.markAttendanceFeeWaived(vid, {});
  });
  check("8 waived terminal cannot reacquire", ok);
}

{
  const visitId = qaVisitId(9);
  await trackVisit(visitId);
  await store.markAttendanceFeeSkipped({
    ...baseCandidate(visitId),
    skipReason: "dry_run_would_charge",
    dryRun: true,
  });
  const again = await store.acquireAttendanceFeeProcessingLock(visitId);
  check("9 skipped terminal cannot reacquire", !again.acquired);
}

{
  const visitId = qaVisitId(10);
  const ok = await terminalCannotReacquire(visitId, async (vid) => {
    await store.markAttendanceFeeFailed(vid, { failureClass: "permanent" });
  });
  check("10 failed permanent cannot reacquire", ok);
}

{
  const visitId = qaVisitId(11);
  await trackVisit(visitId);
  await store.recordOrGetAttendanceFeeCandidate(baseCandidate(visitId));
  const lock = await store.acquireAttendanceFeeProcessingLock(visitId);
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  await store.markAttendanceFeeFailed(visitId, { failureClass: "retryable", nextRetryAt: future });
  const early = await store.acquireAttendanceFeeProcessingLock(visitId);
  check("11 retryable blocked before next_retry_at", !early.acquired);
  await query(
    `UPDATE amare_attendance_fees SET next_retry_at = NOW() - interval '1 minute' WHERE visit_id = $1`,
    [visitId],
  );
  const late = await store.acquireAttendanceFeeProcessingLock(visitId);
  check("11b retryable acquire after next_retry_at", late.acquired);
}

{
  const visitId = qaVisitId(12);
  await trackVisit(visitId);
  await store.recordOrGetAttendanceFeeCandidate(baseCandidate(visitId));
  await store.acquireAttendanceFeeProcessingLock(visitId);
  const staleSec = Math.ceil(ATTENDANCE_FEE_STALE_PROCESSING_MS / 1000) + 5;
  await query(
    `UPDATE amare_attendance_fees
        SET processing_started_at = NOW() - ($2::int * interval '1 second')
      WHERE visit_id = $1`,
    [visitId, staleSec],
  );
  const reclaimed = await store.acquireAttendanceFeeProcessingLock(visitId);
  check("12 stale processing reclaimed", reclaimed.acquired);
}

{
  const visitId = qaVisitId(13);
  await trackVisit(visitId);
  const [a, b] = await Promise.all([
    store.recordOrGetAttendanceFeeCandidate(baseCandidate(visitId)),
    store.recordOrGetAttendanceFeeCandidate(baseCandidate(visitId)),
  ]);
  const row = await store.getAttendanceFeeByVisitId(visitId);
  check(
    "13 concurrent recordOrGet → one row",
    row && (a.created !== b.created || (!a.created && !b.created)),
  );
}

{
  const visitId = qaVisitId(14);
  await trackVisit(visitId);
  await store.markAttendanceFeeSkipped({
    ...baseCandidate(visitId),
    skipReason: "dry_run_would_charge",
    dryRun: true,
  });
  const row = await store.getAttendanceFeeByVisitId(visitId);
  const again = await store.recordOrGetAttendanceFeeCandidate(baseCandidate(visitId, { status: "pending" }));
  check("14 dry-run row terminal", row?.dryRun === true && row?.status === "skipped" && !again.created);
}

{
  let rejected = false;
  try {
    await query(
      `INSERT INTO amare_attendance_fees (
        visit_id, site_id, class_id, client_id, fee_type, amount_cents, currency, status, trigger_source, trigger_at
      ) VALUES ($1,$2,$3,$4,'late_cancel',500,'usd','pending','qa',NOW())`,
      [qaVisitId(99), QA_SITE_ID, QA_CLASS_ID, QA_CLIENT_ID],
    );
  } catch (err) {
    rejected = /check|constraint/i.test(String(err?.message || err));
  }
  check("15 SQL rejects invalid amount_cents", rejected);
}

console.log("\n=== Dry-run / eligibility on Postgres store ===");

async function recordDryLate(opts) {
  const visitId = opts.visitId;
  await trackVisit(visitId);
  return recordAttendanceFeeCandidate(
    {
      feeType: "late_cancel",
      triggerSource: "qa_postgres",
      visitId,
      clientId: QA_CLIENT_ID,
      classId: QA_CLASS_ID,
      classStartMs: Date.now() + 6 * 60 * 60 * 1000,
      triggerAtMs: Date.now(),
      visitRow: opts.visitRow,
      clientServiceRows: opts.clientServiceRows,
      siteId: QA_SITE_ID,
    },
    { store, config: CONFIG_DRY },
  );
}

{
  const visitId = qaVisitId(101);
  const r = await recordDryLate({
    visitId,
    visitRow: visitRow(unlimited135.Id, visitId),
    clientServiceRows: [unlimited135],
  });
  check(
    "H1 Unlimited dry-run late cancel → skipped dry_run",
    r.outcome === "dry_run" &&
      r.record?.status === "skipped" &&
      r.record?.skipReason === "dry_run_would_charge" &&
      r.record?.dryRun === true,
  );
}

{
  const visitId = qaVisitId(102);
  const r = await recordDryLate({
    visitId,
    visitRow: visitRow(monthly8.Id, visitId),
    clientServiceRows: [monthly8],
  });
  check("H2 Monthly 8 → no billable row", r.persisted === false && r.outcome === "skipped");
}

{
  const visitId = qaVisitId(103);
  const r = await recordDryLate({
    visitId,
    visitRow: visitRow(ncs.Id, visitId),
    clientServiceRows: [ncs],
  });
  check("H3 NCS → no billable row", r.persisted === false);
}

{
  const visitId = qaVisitId(104);
  const r = await recordDryLate({
    visitId,
    visitRow: visitRow(pack10.Id, visitId),
    clientServiceRows: [unlimited135, pack10],
  });
  check("H4 mixed wallet pack visit → no row", r.persisted === false);
}

{
  const visitId = qaVisitId(105);
  const r = await recordDryLate({
    visitId,
    visitRow: visitRow(unlimited056.Id, visitId),
    clientServiceRows: [unlimited056, pack10],
  });
  check(
    "H5 mixed wallet Unlimited visit → dry-run skipped",
    r.record?.dryRun === true && r.record?.status === "skipped",
  );
}

{
  const visitId = qaVisitId(106);
  const r = await recordDryLate({
    visitId,
    visitRow: visitRow(999999, visitId),
    clientServiceRows: [unlimited135],
  });
  check(
    "H6 ClientService not found → persisted skipped",
    r.persisted === true && r.record?.skipReason === "client_service_row_not_found",
  );
}

console.log("\n=== Postgres reconciler lifecycle (mock Stripe) ===");

await query(
  `DELETE FROM amare_attendance_fees WHERE visit_id >= $1::bigint AND visit_id <= $2::bigint`,
  [QA_VISIT_ID_MIN, QA_VISIT_ID_MAX],
);
createdVisitIds.length = 0;

const { runAttendanceFeeReconciliation } = await import(
  "../netlify/functions/attendance-fee-reconcile-scan.mjs"
);

const CONFIG_LIVE_QA = { enabled: true, dryRun: false, stripePriceId: "price_qa_postgres_fee" };
const fakeStripe = /** @type {import("stripe").default} */ ({});

{
  const visitId = qaVisitId(201);
  await trackVisit(visitId);
  await store.recordOrGetAttendanceFeeCandidate({
    visitId,
    siteId: QA_SITE_ID,
    classId: QA_CLASS_ID,
    clientId: QA_CLIENT_ID,
    clientServiceId: unlimited135.Id,
    mindbodyProductId: 100135,
    feeType: "late_cancel",
    amountCents: 1000,
    currency: "usd",
    status: "pending",
    triggerSource: "qa_postgres",
    triggerAt: new Date().toISOString(),
    dryRun: false,
  });
  const summary = await runAttendanceFeeReconciliation({
    store,
    stripe: fakeStripe,
    config: CONFIG_LIVE_QA,
    listProcessableOpts: QA_RECONCILE_LIST_OPTS,
    collectPayment: async () => ({
      ok: true,
      stripeCustomerId: "cus_pg",
      stripeInvoiceId: "in_pg",
      stripePaymentIntentId: "pi_pg",
    }),
  });
  const row = await store.getAttendanceFeeByVisitId(visitId);
  check(
    "PG1 pending → charged via reconciler (namespace isolated)",
    summary.scanned === 1 &&
      summary.charged.length === 1 &&
      summary.charged[0]?.visitId === visitId &&
      row?.status === "charged",
  );
}

{
  const visitId = qaVisitId(202);
  await trackVisit(visitId);
  await store.recordOrGetAttendanceFeeCandidate({
    visitId,
    siteId: QA_SITE_ID,
    classId: QA_CLASS_ID,
    clientId: QA_CLIENT_ID,
    clientServiceId: unlimited135.Id,
    mindbodyProductId: 100135,
    feeType: "late_cancel",
    amountCents: 1000,
    currency: "usd",
    status: "pending",
    triggerSource: "qa_postgres",
    triggerAt: new Date().toISOString(),
    dryRun: false,
  });
  await runAttendanceFeeReconciliation({
    store,
    stripe: fakeStripe,
    config: CONFIG_LIVE_QA,
    listProcessableOpts: QA_RECONCILE_LIST_OPTS,
    collectPayment: async () => ({
      ok: false,
      failureClass: "retryable",
      failureCode: "stripe_server_error",
      failureMessage: "500",
    }),
  });
  const row = await store.getAttendanceFeeByVisitId(visitId);
  check("PG2 retryable failed + next_retry_at", row?.status === "failed" && row?.failureClass === "retryable" && row?.nextRetryAt);
  await query(
    `UPDATE amare_attendance_fees SET next_retry_at = NOW() - interval '1 minute' WHERE visit_id = $1`,
    [visitId],
  );
  await runAttendanceFeeReconciliation({
    store,
    stripe: fakeStripe,
    config: CONFIG_LIVE_QA,
    listProcessableOpts: QA_RECONCILE_LIST_OPTS,
    collectPayment: async () => ({
      ok: true,
      stripeCustomerId: "cus_pg",
      stripeInvoiceId: "in_pg2",
      stripePaymentIntentId: "pi_pg2",
    }),
  });
  const row2 = await store.getAttendanceFeeByVisitId(visitId);
  check("PG2b retry → charged", row2?.status === "charged");
}

{
  const visitId = qaVisitId(203);
  await trackVisit(visitId);
  await store.recordOrGetAttendanceFeeCandidate({
    visitId,
    siteId: QA_SITE_ID,
    classId: QA_CLASS_ID,
    clientId: QA_CLIENT_ID,
    clientServiceId: unlimited135.Id,
    mindbodyProductId: 100135,
    feeType: "late_cancel",
    amountCents: 1000,
    currency: "usd",
    status: "pending",
    triggerSource: "qa_postgres",
    triggerAt: new Date().toISOString(),
    dryRun: false,
  });
  await runAttendanceFeeReconciliation({
    store,
    stripe: fakeStripe,
    config: CONFIG_LIVE_QA,
    listProcessableOpts: QA_RECONCILE_LIST_OPTS,
    collectPayment: async () => ({
      ok: false,
      failureClass: "permanent",
      failureCode: "missing_stripe_customer",
      failureMessage: "none",
    }),
  });
  const row = await store.getAttendanceFeeByVisitId(visitId);
  const list = await store.listProcessableAttendanceFees(QA_RECONCILE_LIST_OPTS);
  check("PG3 permanent not processable", row?.failureClass === "permanent" && !list.some((r) => r.visitId === visitId));
}

await cleanup();
stopLocalDbKeeper();

if (failed) {
  console.error(`\n${failed} Postgres attendance-fee check(s) failed.`);
  process.exit(1);
}
console.log("\nAll Postgres attendance-fee Phase 2 checks passed.");
