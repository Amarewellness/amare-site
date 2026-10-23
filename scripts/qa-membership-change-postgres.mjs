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
const BILLING_MIGRATION = "netlify/database/migrations/20261023210000_amare_billing_admins.sql";
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

  /* ---------------- billing admins ---------------- */
  const billingReg = await q("SELECT to_regclass('public.amare_billing_admins') AS t");
  if (!billingReg.rows[0]?.t) {
    for (const stmt of splitSql(await readFile(path.join(root, BILLING_MIGRATION), "utf8"))) await q(stmt);
    console.log("Billing migration applied locally.");
  }
  const cleanupBilling = async () => {
    await q("DELETE FROM amare_billing_admins WHERE actor_id LIKE 'qa-pg-%'");
    await q("DELETE FROM amare_billing_auth_attempts WHERE actor_id LIKE 'qa-pg-%' OR ip_hash = 'qa-pg-ip'");
    await q("DELETE FROM amare_billing_audit_log WHERE actor_id LIKE 'qa-pg-%'");
  };
  await cleanupBilling();
  const { createPostgresBillingAuthStore } = await import("../netlify/functions/membership-billing-auth-store.mjs");
  const { hashBillingKey, verifyBillingActor, RATE_LIMIT } = await import("../netlify/functions/membership-change-auth.mjs");
  const bs = createPostgresBillingAuthStore();
  const ownerKey = "qa-pg-owner-key-123";
  const e1 = await bs.enrollAdmin({ actorId: "qa-pg-owner", role: "owner", createdBy: "qa", ...hashBillingKey(ownerKey) });
  check("postgres: enroll owner", e1.ok === true && e1.admin.role === "owner");
  const dup = await bs.enrollAdmin({ actorId: "qa-pg-owner", role: "owner", createdBy: "qa", ...hashBillingKey("other-key-123456") });
  check("postgres: active admin cannot be re-enrolled", dup.ok === false && dup.reason === "already_enrolled");
  let badRole = false;
  try {
    await q("INSERT INTO amare_billing_admins (actor_id, role, key_salt, key_hash, created_by) VALUES ('qa-pg-bad', 'frontdesk', $1, $2, 'qa')", [
      "0".repeat(32),
      "0".repeat(64),
    ]);
  } catch {
    badRole = true;
  }
  check("postgres: role CHECK rejects non-billing roles", badRole);

  const ownersBefore = await q("SELECT COUNT(*)::int AS n FROM amare_billing_admins WHERE role = 'owner' AND status = 'active'");
  if (ownersBefore.rows[0].n === 1) {
    const last = await bs.revokeAdmin("qa-pg-owner", "qa");
    check("postgres: last active owner cannot be revoked", last.ok === false && last.reason === "last_owner");
  }
  await bs.enrollAdmin({ actorId: "qa-pg-super", role: "superadmin", createdBy: "qa-pg-owner", ...hashBillingKey("qa-pg-super-key-1") });
  check("postgres: revoke superadmin", (await bs.revokeAdmin("qa-pg-super", "qa-pg-owner")).ok === true);
  const reEnroll = await bs.enrollAdmin({ actorId: "qa-pg-super", role: "superadmin", createdBy: "qa-pg-owner", ...hashBillingKey("qa-pg-super-key-2") });
  check("postgres: revoked admin can be re-enrolled with a new key", reEnroll.ok === true && reEnroll.admin.status === "active");

  const ev = (actor, key) => ({ headers: { "x-billing-actor": actor, "x-billing-key": key, "x-nf-client-connection-ip": "198.51.100.77" } });
  const good = await verifyBillingActor(ev("qa-pg-owner", ownerKey), bs);
  check("postgres: real scrypt verification accepts the right key", good.ok === true && good.actor.id === "qa-pg-owner");
  for (let i = 0; i < RATE_LIMIT.perActor; i += 1) await verifyBillingActor(ev("qa-pg-owner", `wrong-key-${i}-xxxxx`), bs);
  const locked = await verifyBillingActor(ev("qa-pg-owner", ownerKey), bs);
  check("postgres: rate limit locks after repeated failures", locked.ok === false && locked.status === 429);
  const later = await verifyBillingActor(ev("qa-pg-owner", ownerKey), bs, { nowMs: Date.now() + RATE_LIMIT.windowMs + 60000 });
  check("postgres: lock expires after the window", later.ok === true);

  await bs.appendAudit({ actorId: "qa-pg-owner", action: "preview", subscriptionRecordId: "sub_amare_QAMCPGAUDIT01", outcome: "ok", detail: { toSku: "monthly_8" } });
  const auditRows = await q("SELECT action, outcome, detail FROM amare_billing_audit_log WHERE actor_id = 'qa-pg-owner'");
  check("postgres: audit row written with actor and detail", auditRows.rows.some((r) => r.action === "preview" && r.detail?.toSku === "monthly_8"));
  const stored = await q("SELECT key_hash, key_salt FROM amare_billing_admins WHERE actor_id = 'qa-pg-owner'");
  check("postgres: only hash + salt stored", stored.rows[0].key_hash.length === 64 && !JSON.stringify(stored.rows).includes(ownerKey));

  await cleanupBilling();
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
