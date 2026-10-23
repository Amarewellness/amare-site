/**
 * Membership change ledger — real local Postgres (Netlify local database only).
 * Proves the per-subscription lock (partial unique index), request idempotency and status CAS.
 * Synthetic subscription ids; rows are deleted afterwards. Refuses hosted database URLs.
 *
 * Run: node scripts/qa-membership-change-postgres.mjs
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "./load-env.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATION = "netlify/database/migrations/20261023190000_amare_membership_change_ops.sql";
const QA_PREFIX = "sub_amare_QAMCPG";

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`PASS — ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL — ${name}${detail !== undefined ? ` (${JSON.stringify(detail)})` : ""}`);
  }
}

/** @type {import("node:child_process").ChildProcess | null} */
let keeper = null;

function isLocal(url) {
  return /localhost|127\.0\.0\.1/i.test(String(url || ""));
}

async function localDbUrl() {
  for (const k of ["NETLIFY_DB_URL", "NETLIFY_DATABASE_URL", "DATABASE_URL"]) {
    const v = (process.env[k] || "").trim();
    if (v) {
      if (!isLocal(v)) throw new Error(`Refusing hosted database URL from ${k}`);
      return v;
    }
  }
  const child = spawn(process.execPath, [path.join(root, "node_modules/netlify-cli/bin/run.js"), "database", "connect"], {
    cwd: root,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  keeper = child;
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("local_db_connect_timeout")), 30000);
    const onData = (chunk) => {
      buf += String(chunk);
      const m = buf.match(/postgres(?:ql)?:\/\/\S+/);
      if (m) {
        clearTimeout(timer);
        resolve(m[0].replace(/[\s"'`]+$/, ""));
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", reject);
  });
}

function stopKeeper() {
  if (!keeper || keeper.killed) return;
  try {
    keeper.stdin?.write("\\q\n");
  } catch {
    /* ignore */
  }
  keeper.kill();
}

function splitSql(sql) {
  return String(sql)
    .split(/;\s*\n/)
    .map((s) => s.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join("\n").trim())
    .filter(Boolean);
}

function opInput(subId, requestId, extra = {}) {
  return {
    requestId,
    subscriptionRecordId: subId,
    stripeSubscriptionId: "sub_QA123",
    stripeCustomerId: "cus_QA123",
    mindbodyClientId: 1,
    actorId: "owner1",
    actorRole: "owner",
    fromSku: "monthly_5",
    toSku: "monthly_8",
    direction: "upgrade",
    timing: "immediate",
    billingPolicy: "new_cycle_no_credit",
    previewAmountCents: 16500,
    previewFingerprint: "fp",
    previewCreatedAt: new Date().toISOString(),
    targetAmountCents: 16500,
    status: "executing",
    warnings: ["commitment_preserved"],
    acknowledgements: { grandfathered_price: true },
    ...extra,
  };
}

async function main() {
  const url = await localDbUrl();
  if (!isLocal(url)) throw new Error("Refusing non-local database");
  process.env.NETLIFY_DB_URL = url;
  const { createPostgresMembershipChangeStore } = await import("../netlify/functions/membership-change-store.mjs");
  const { getDatabase } = await import("@netlify/database");
  const db = getDatabase({ connectionString: url });
  const q = (text, values = []) => db.pool.query(text, values);

  const reg = await q("SELECT to_regclass('public.amare_membership_change_operations') AS t");
  if (!reg.rows[0]?.t) {
    for (const stmt of splitSql(await readFile(path.join(root, MIGRATION), "utf8"))) await q(stmt);
    console.log("Migration applied locally.");
  }
  await q("DELETE FROM amare_membership_change_operations WHERE subscription_record_id LIKE $1", [`${QA_PREFIX}%`]);

  const store = createPostgresMembershipChangeStore();
  const subA = `${QA_PREFIX}AAAA0001`;
  const subB = `${QA_PREFIX}BBBB0001`;

  const first = await store.insertOperation(opInput(subA, `qa-req-${randomUUID()}`));
  check("insert creates active operation", first.created === true && first.operation.status === "executing");
  check("jsonb fields round-trip", first.operation.warnings[0] === "commitment_preserved" && first.operation.acknowledgements.grandfathered_price === true);

  const dupReq = await store.insertOperation(opInput(subA, first.operation.requestId));
  check("same request id → returns existing operation", dupReq.created === false && dupReq.reason === "request_id_exists" && dupReq.operation.id === first.operation.id);

  const second = await store.insertOperation(opInput(subA, `qa-req-${randomUUID()}`));
  check("second active op on same subscription refused (lock)", second.created === false && second.reason === "active_operation_exists" && second.operation?.id === first.operation.id);

  const concurrent = await Promise.all(
    Array.from({ length: 8 }, () => store.insertOperation(opInput(subB, `qa-req-${randomUUID()}`))),
  );
  check("8 concurrent inserts → exactly one lock holder", concurrent.filter((r) => r.created).length === 1, concurrent.map((r) => r.reason));

  const cas = await store.updateOperation(first.operation.id, { status: "syncing", stripeInvoiceId: "in_qa" }, { expectStatuses: ["executing"] });
  check("CAS update from expected status succeeds", cas?.status === "syncing" && cas.stripeInvoiceId === "in_qa");
  const casMiss = await store.updateOperation(first.operation.id, { status: "failed" }, { expectStatuses: ["executing"] });
  check("CAS update from wrong status is a no-op", casMiss === null);
  check("syncing still holds the lock", (await store.insertOperation(opInput(subA, `qa-req-${randomUUID()}`))).created === false);

  await store.updateOperation(first.operation.id, { status: "completed", completedAt: new Date().toISOString() }, { expectStatuses: ["syncing"] });
  const afterDone = await store.insertOperation(opInput(subA, `qa-req-${randomUUID()}`, { fromSku: "monthly_8", toSku: "monthly_unlimited" }));
  check("terminal status releases the lock", afterDone.created === true);

  const active = await store.getActiveOperation(subA);
  check("getActiveOperation returns the new holder", active?.id === afterDone.operation.id);
  const list = await store.listOperations(subA, 10);
  check("listOperations returns history newest first", list.length === 2 && list[0].id === afterDone.operation.id);

  let sameSkuRejected = false;
  try {
    await store.insertOperation(opInput(`${QA_PREFIX}CCCC0001`, `qa-req-${randomUUID()}`, { toSku: "monthly_5" }));
  } catch {
    sameSkuRejected = true;
  }
  check("same from/to SKU rejected", sameSkuRejected);

  let badStatus = false;
  try {
    await q("UPDATE amare_membership_change_operations SET status = 'bogus' WHERE id = $1::uuid", [afterDone.operation.id]);
  } catch {
    badStatus = true;
  }
  check("status CHECK constraint enforced by database", badStatus);

  await q("DELETE FROM amare_membership_change_operations WHERE subscription_record_id LIKE $1", [`${QA_PREFIX}%`]);
  await db.pool.end?.();
}

try {
  await main();
} catch (e) {
  failed += 1;
  console.error("FATAL —", e?.message || e);
} finally {
  stopKeeper();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
