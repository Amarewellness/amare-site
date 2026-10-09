/**
 * AMARÉ attendance fee Phase 1 — ledger, eligibility, state machine.
 * Local only. Memory store. No Stripe. No production DB.
 *
 * Run: node scripts/qa-attendance-fees.mjs
 */

const STUDIO_LATE_CANCEL_MS = 12 * 60 * 60 * 1000;

const CONFIG_OFF = { enabled: false, dryRun: true };
const CONFIG_LIVE = { enabled: true, dryRun: false };
const CONFIG_DRY = { enabled: true, dryRun: true };

const {
  resetAttendanceFeeStoreForTests,
  ATTENDANCE_FEE_STALE_PROCESSING_MS,
  isAttendanceFeeRowProcessable,
} = await import("../netlify/functions/attendance-fee-store.mjs");

const {
  recordAttendanceFeeCandidate,
  resolveVisitUnlimitedEligibility,
  assertLateCancelFeeGate,
  resolveAttendanceFeeRuntimeConfig,
} = await import("../netlify/functions/attendance-fee-lib.mjs");

const { ATTENDANCE_FEES_ENABLED, ATTENDANCE_FEES_DRY_RUN } = await import(
  "../netlify/functions/attendance-fee-config.mjs"
);

let failed = 0;
function check(name, ok, detail) {
  if (ok) console.log(`PASS — ${name}`);
  else {
    failed += 1;
    console.error(`FAIL — ${name}${detail ? ` (${detail})` : ""}`);
  }
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

function visit(clientServiceId, extra = {}) {
  return {
    Id: 9001,
    ClassId: 500,
    ClientId: 42,
    ClientServiceId: clientServiceId,
    ...extra,
  };
}

function classStartFromNow(offsetMs) {
  return Date.now() + offsetMs;
}

async function recordLateCancel(opts) {
  const store = resetAttendanceFeeStoreForTests();
  return recordAttendanceFeeCandidate(
    {
      feeType: "late_cancel",
      triggerSource: "test",
      visitId: opts.visitId ?? 9001,
      clientId: opts.clientId ?? 42,
      classId: opts.classId ?? 500,
      classStartMs: opts.classStartMs,
      triggerAtMs: opts.triggerAtMs,
      visitRow: opts.visitRow,
      clientServiceRows: opts.clientServiceRows,
      noShowVerified: opts.noShowVerified,
    },
    { store, forceMemory: true, config: opts.config ?? CONFIG_LIVE },
  );
}

async function recordNoShow(opts) {
  const store = resetAttendanceFeeStoreForTests();
  return recordAttendanceFeeCandidate(
    {
      feeType: "no_show",
      triggerSource: "test",
      visitId: opts.visitId ?? 9001,
      clientId: opts.clientId ?? 42,
      classId: opts.classId ?? 500,
      visitRow: opts.visitRow,
      clientServiceRows: opts.clientServiceRows,
      noShowVerified: opts.noShowVerified === true,
    },
    { store, forceMemory: true, config: opts.config ?? CONFIG_LIVE },
  );
}

const unlimited135 = cs(1, 100135, "AMARÉ Monthly Unlimited", 999999);
const unlimited056 = cs(2, 100056, "Unlimited", 999999);
const monthly8 = cs(3, 100134, "Monthly 8", 8);
const ncs = cs(4, 100012, "NCS", 3);
const pack10 = cs(5, 100127, "10 Pack", 4);
const guestPass = cs(6, 100136, "Guest Pass", 1);

console.log("=== Runtime config (injected) ===");
check(
  "source defaults ENABLED=true DRY_RUN=true (production dry-run)",
  ATTENDANCE_FEES_ENABLED === true && ATTENDANCE_FEES_DRY_RUN === true,
);
{
  const r = await recordLateCancel({
    config: CONFIG_OFF,
    visitRow: visit(1),
    clientServiceRows: [unlimited135],
    classStartMs: classStartFromNow(2 * 60 * 60 * 1000),
    triggerAtMs: Date.now(),
  });
  check("config enabled=false → disabled, no row", r.outcome === "disabled" && r.persisted === false);
}
{
  const r = await recordLateCancel({
    config: CONFIG_DRY,
    visitId: 8801,
    visitRow: visit(1, { Id: 8801 }),
    clientServiceRows: [unlimited135],
    classStartMs: classStartFromNow(2 * 60 * 60 * 1000),
    triggerAtMs: Date.now(),
  });
  check(
    "config enabled=true dryRun=true → dry_run skipped",
    r.outcome === "dry_run" && r.record?.dryRun === true,
  );
}
{
  const r = await recordLateCancel({
    config: CONFIG_LIVE,
    visitId: 8802,
    visitRow: visit(1, { Id: 8802 }),
    clientServiceRows: [unlimited135],
    classStartMs: classStartFromNow(2 * 60 * 60 * 1000),
    triggerAtMs: Date.now(),
  });
  check(
    "config enabled=true dryRun=false → pending",
    r.outcome === "pending_created" && r.record?.status === "pending",
  );
}

console.log("=== Eligibility / late cancel recording ===");

{
  const now = Date.now();
  const r = await recordLateCancel({
    visitRow: visit(1),
    clientServiceRows: [unlimited135],
    classStartMs: classStartFromNow(11 * 60 * 60 * 1000 + 59 * 60 * 1000),
    triggerAtMs: now,
  });
  check("1 Unlimited 100135 late cancel → pending", r.outcome === "pending_created" && r.record?.status === "pending");
}

{
  const now = Date.now();
  const r = await recordLateCancel({
    visitRow: visit(2),
    clientServiceRows: [unlimited056],
    classStartMs: classStartFromNow(6 * 60 * 60 * 1000),
    triggerAtMs: now,
  });
  check("2 Unlimited 100056 late cancel → pending", r.outcome === "pending_created" && r.record?.status === "pending");
}

{
  const now = Date.now();
  const r = await recordLateCancel({
    visitRow: visit(1),
    clientServiceRows: [unlimited135],
    classStartMs: classStartFromNow(13 * 60 * 60 * 1000),
    triggerAtMs: now,
  });
  check("3 Unlimited 13h before → no pending", r.outcome === "skipped" && r.reason === "outside_late_cancel_window" && !r.persisted);
}

{
  const now = Date.now();
  const exactly12h = classStartFromNow(STUDIO_LATE_CANCEL_MS);
  const gateEarly = assertLateCancelFeeGate({ classStartMs: exactly12h, triggerAtMs: now });
  check("4a exactly 12h before → not late window", gateEarly.ok === false && gateEarly.reason === "outside_late_cancel_window");
  const gateLate = assertLateCancelFeeGate({
    classStartMs: classStartFromNow(STUDIO_LATE_CANCEL_MS - 1000),
    triggerAtMs: now,
  });
  check("4b 1s inside 12h window → late", gateLate.ok === true);
}

{
  const r = await recordLateCancel({
    visitRow: visit(3),
    clientServiceRows: [monthly8],
    classStartMs: classStartFromNow(2 * 60 * 60 * 1000),
    triggerAtMs: Date.now(),
  });
  check("5 Monthly 8 → no pending", r.outcome === "skipped" && r.reason === "not_unlimited_visit" && !r.persisted);
}

{
  const r = await recordLateCancel({
    visitRow: visit(4),
    clientServiceRows: [ncs],
    classStartMs: classStartFromNow(2 * 60 * 60 * 1000),
    triggerAtMs: Date.now(),
  });
  check("6 NCS → no pending", r.outcome === "skipped" && !r.persisted);
}

{
  const r = await recordLateCancel({
    visitRow: visit(5),
    clientServiceRows: [pack10],
    classStartMs: classStartFromNow(2 * 60 * 60 * 1000),
    triggerAtMs: Date.now(),
  });
  check("7 Pack → no pending", r.outcome === "skipped" && !r.persisted);
}

{
  const r = await recordLateCancel({
    visitRow: visit(6),
    clientServiceRows: [guestPass],
    classStartMs: classStartFromNow(2 * 60 * 60 * 1000),
    triggerAtMs: Date.now(),
  });
  check("8 Guest pass → no pending", r.outcome === "skipped" && !r.persisted);
}

{
  const r = await recordLateCancel({
    visitRow: visit(5),
    clientServiceRows: [unlimited135, pack10],
    classStartMs: classStartFromNow(2 * 60 * 60 * 1000),
    triggerAtMs: Date.now(),
  });
  check("9 mixed wallet visit uses pack → no fee", r.outcome === "skipped" && r.reason === "not_unlimited_visit");
}

{
  const r = await recordLateCancel({
    visitRow: visit(1),
    clientServiceRows: [unlimited135, pack10],
    classStartMs: classStartFromNow(2 * 60 * 60 * 1000),
    triggerAtMs: Date.now(),
  });
  check("10 mixed wallet visit uses Unlimited → pending", r.outcome === "pending_created");
}

{
  const r = await recordLateCancel({
    visitRow: visit(99, { ClientServiceId: null }),
    clientServiceRows: [unlimited135],
    classStartMs: classStartFromNow(2 * 60 * 60 * 1000),
    triggerAtMs: Date.now(),
  });
  check("11 missing ClientServiceId → fail closed persisted", r.persisted === true && r.record?.skipReason === "missing_client_service_id");
}

{
  const r = await recordLateCancel({
    visitRow: visit(999),
    clientServiceRows: [unlimited135],
    classStartMs: classStartFromNow(2 * 60 * 60 * 1000),
    triggerAtMs: Date.now(),
  });
  check("12 ClientService row not found → fail closed persisted", r.record?.skipReason === "client_service_row_not_found");
}

console.log("\n=== Dry-run ===");

{
  const r = await recordLateCancel({
    config: CONFIG_DRY,
    visitRow: visit(1),
    clientServiceRows: [unlimited135],
    classStartMs: classStartFromNow(2 * 60 * 60 * 1000),
    triggerAtMs: Date.now(),
  });
  check("13 dry-run → skipped dry_run=true", r.outcome === "dry_run" && r.record?.dryRun === true && r.record?.skipReason === "dry_run_would_charge");
}

{
  const store = resetAttendanceFeeStoreForTests();
  await recordAttendanceFeeCandidate(
    {
      feeType: "late_cancel",
      triggerSource: "test",
      visitId: 777,
      clientId: 42,
      classId: 500,
      classStartMs: classStartFromNow(2 * 60 * 60 * 1000),
      triggerAtMs: Date.now(),
      visitRow: visit(1),
      clientServiceRows: [unlimited135],
    },
    { store, forceMemory: true, config: CONFIG_DRY },
  );
  const again = await recordAttendanceFeeCandidate(
    {
      feeType: "no_show",
      triggerSource: "test",
      visitId: 777,
      clientId: 42,
      classId: 500,
      visitRow: visit(1),
      clientServiceRows: [unlimited135],
      noShowVerified: true,
    },
    { store, forceMemory: true, config: CONFIG_LIVE },
  );
  check(
    "14 dry-run row stays terminal after live switch",
    again.outcome === "duplicate_terminal" && again.record?.dryRun === true && again.record?.feeType === "late_cancel",
  );
}

console.log("\n=== One fee per visit ===");

{
  const store = resetAttendanceFeeStoreForTests();
  const base = {
    visitRow: visit(1),
    clientServiceRows: [unlimited135],
    classStartMs: classStartFromNow(2 * 60 * 60 * 1000),
    triggerAtMs: Date.now(),
  };
  const a = await recordAttendanceFeeCandidate(
    { ...base, feeType: "late_cancel", triggerSource: "t", visitId: 555, clientId: 42, classId: 500 },
    { store, forceMemory: true, config: CONFIG_LIVE },
  );
  const b = await recordAttendanceFeeCandidate(
    {
      feeType: "late_cancel",
      triggerSource: "t",
      visitId: 555,
      clientId: 42,
      classId: 500,
      visitRow: visit(1),
      clientServiceRows: [unlimited135],
      classStartMs: classStartFromNow(2 * 60 * 60 * 1000),
      triggerAtMs: Date.now(),
    },
    { store, forceMemory: true, config: CONFIG_LIVE },
  );
  check("15 duplicate candidate → one row", a.created && b.outcome === "existing");
}

{
  const store = resetAttendanceFeeStoreForTests();
  await recordAttendanceFeeCandidate(
    {
      feeType: "late_cancel",
      triggerSource: "t",
      visitId: 556,
      clientId: 42,
      classId: 500,
      visitRow: visit(1),
      clientServiceRows: [unlimited135],
      classStartMs: classStartFromNow(2 * 60 * 60 * 1000),
      triggerAtMs: Date.now(),
    },
    { store, forceMemory: true, config: CONFIG_LIVE },
  );
  const ns = await recordAttendanceFeeCandidate(
    {
      feeType: "no_show",
      triggerSource: "t",
      visitId: 556,
      clientId: 42,
      classId: 500,
      visitRow: visit(1),
      clientServiceRows: [unlimited135],
      noShowVerified: true,
    },
    { store, forceMemory: true, config: CONFIG_LIVE },
  );
  check("16 late then no-show → one row same fee_type", ns.outcome === "existing" && ns.record?.feeType === "late_cancel");
}

{
  const store = resetAttendanceFeeStoreForTests();
  await recordAttendanceFeeCandidate(
    {
      feeType: "no_show",
      triggerSource: "t",
      visitId: 557,
      clientId: 42,
      classId: 500,
      visitRow: visit(1),
      clientServiceRows: [unlimited135],
      noShowVerified: true,
    },
    { store, forceMemory: true, config: CONFIG_LIVE },
  );
  const lc = await recordAttendanceFeeCandidate(
    {
      feeType: "late_cancel",
      triggerSource: "t",
      visitId: 557,
      clientId: 42,
      classId: 500,
      visitRow: visit(1),
      clientServiceRows: [unlimited135],
      classStartMs: classStartFromNow(2 * 60 * 60 * 1000),
      triggerAtMs: Date.now(),
    },
    { store, forceMemory: true, config: CONFIG_LIVE },
  );
  check("17 no-show first then late cancel → one row", lc.outcome === "existing" && lc.record?.feeType === "no_show");
}

console.log("\n=== State machine / locks ===");

{
  const store = resetAttendanceFeeStoreForTests();
  await store.recordOrGetAttendanceFeeCandidate({
    visitId: 800,
    siteId: 1,
    classId: 1,
    clientId: 1,
    clientServiceId: 1,
    mindbodyProductId: 100135,
    feeType: "late_cancel",
    status: "pending",
    triggerSource: "test",
    triggerAt: new Date().toISOString(),
    dryRun: false,
  });
  const [a, b] = await Promise.all([
    store.acquireAttendanceFeeProcessingLock(800),
    store.acquireAttendanceFeeProcessingLock(800),
  ]);
  const wins = [a, b].filter((x) => x.acquired);
  check("18 concurrent lock → one winner", wins.length === 1);
}

{
  const store = resetAttendanceFeeStoreForTests();
  await store.recordOrGetAttendanceFeeCandidate({
    visitId: 801,
    siteId: 1,
    classId: 1,
    clientId: 1,
    clientServiceId: 1,
    mindbodyProductId: 100135,
    feeType: "late_cancel",
    status: "pending",
    triggerSource: "test",
    triggerAt: new Date().toISOString(),
    dryRun: false,
  });
  const lock = await store.acquireAttendanceFeeProcessingLock(801);
  check("19 pending → processing", lock.acquired && lock.record?.status === "processing");
}

{
  const store = resetAttendanceFeeStoreForTests();
  const staleStart = new Date(Date.now() - ATTENDANCE_FEE_STALE_PROCESSING_MS - 5000).toISOString();
  await store.recordOrGetAttendanceFeeCandidate({
    visitId: 802,
    siteId: 1,
    classId: 1,
    clientId: 1,
    clientServiceId: 1,
    mindbodyProductId: 100135,
    feeType: "late_cancel",
    status: "processing",
    processingStartedAt: staleStart,
    processingToken: "stale",
    attemptCount: 1,
    triggerSource: "test",
    triggerAt: new Date().toISOString(),
    dryRun: false,
  });
  const rel = await store.releaseStaleProcessing(802);
  check("20 stale processing → pending", rel.ok && rel.record?.status === "pending");
}

{
  const store = resetAttendanceFeeStoreForTests();
  await store.recordOrGetAttendanceFeeCandidate({
    visitId: 803,
    siteId: 1,
    classId: 1,
    clientId: 1,
    clientServiceId: 1,
    mindbodyProductId: 100135,
    feeType: "late_cancel",
    status: "failed",
    failureClass: "retryable",
    nextRetryAt: new Date(Date.now() - 1000).toISOString(),
    triggerSource: "test",
    triggerAt: new Date().toISOString(),
    dryRun: false,
  });
  const lock = await store.acquireAttendanceFeeProcessingLock(803);
  check("21 failed retryable → processing", lock.acquired && lock.record?.status === "processing");
}

{
  const store = resetAttendanceFeeStoreForTests();
  await store.recordOrGetAttendanceFeeCandidate({
    visitId: 804,
    siteId: 1,
    classId: 1,
    clientId: 1,
    clientServiceId: 1,
    mindbodyProductId: 100135,
    feeType: "late_cancel",
    status: "failed",
    failureClass: "permanent",
    triggerSource: "test",
    triggerAt: new Date().toISOString(),
    dryRun: false,
  });
  const lock = await store.acquireAttendanceFeeProcessingLock(804);
  check("22 failed permanent → not acquired", !lock.acquired);
}

{
  const store = resetAttendanceFeeStoreForTests();
  await store.recordOrGetAttendanceFeeCandidate({
    visitId: 805,
    siteId: 1,
    classId: 1,
    clientId: 1,
    clientServiceId: 1,
    mindbodyProductId: 100135,
    feeType: "late_cancel",
    status: "charged",
    triggerSource: "test",
    triggerAt: new Date().toISOString(),
    dryRun: false,
  });
  const lock = await store.acquireAttendanceFeeProcessingLock(805);
  check("23 charged → not acquired", !lock.acquired);
}

{
  const store = resetAttendanceFeeStoreForTests();
  await store.recordOrGetAttendanceFeeCandidate({
    visitId: 806,
    siteId: 1,
    classId: 1,
    clientId: 1,
    clientServiceId: 1,
    mindbodyProductId: 100135,
    feeType: "late_cancel",
    status: "waived",
    triggerSource: "test",
    triggerAt: new Date().toISOString(),
    dryRun: false,
  });
  const lock = await store.acquireAttendanceFeeProcessingLock(806);
  check("24 waived → not acquired", !lock.acquired);
}

{
  const store = resetAttendanceFeeStoreForTests();
  await store.recordOrGetAttendanceFeeCandidate({
    visitId: 807,
    siteId: 1,
    classId: 1,
    clientId: 1,
    clientServiceId: 1,
    mindbodyProductId: 100135,
    feeType: "late_cancel",
    status: "skipped",
    skipReason: "dry_run_would_charge",
    dryRun: true,
    triggerSource: "test",
    triggerAt: new Date().toISOString(),
  });
  const lock = await store.acquireAttendanceFeeProcessingLock(807);
  check("25 skipped → not acquired", !lock.acquired);
}

{
  const store = resetAttendanceFeeStoreForTests();
  await store.recordOrGetAttendanceFeeCandidate({
    visitId: 808,
    siteId: 1,
    classId: 1,
    clientId: 1,
    clientServiceId: 1,
    mindbodyProductId: 100135,
    feeType: "late_cancel",
    status: "pending",
    triggerSource: "test",
    triggerAt: new Date().toISOString(),
    dryRun: false,
  });
  const lock1 = await store.acquireAttendanceFeeProcessingLock(808);
  const lock2 = await store.acquireAttendanceFeeProcessingLock(808);
  check(
    "26 attempt_count increments once while processing held",
    lock1.acquired && lock1.record?.attemptCount === 1 && lock2.acquired === false,
  );
}

{
  const store = resetAttendanceFeeStoreForTests();
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  await store.recordOrGetAttendanceFeeCandidate({
    visitId: 809,
    siteId: 1,
    classId: 1,
    clientId: 1,
    clientServiceId: 1,
    mindbodyProductId: 100135,
    feeType: "late_cancel",
    status: "failed",
    failureClass: "retryable",
    nextRetryAt: future,
    triggerSource: "test",
    triggerAt: new Date().toISOString(),
    dryRun: false,
  });
  const raw = await store.getAttendanceFeeByVisitId(809);
  check(
    "27 next_retry_at respected",
    !isAttendanceFeeRowProcessable(
      {
        status: raw.status,
        failure_class: raw.failureClass,
        next_retry_at: raw.nextRetryAt,
        processing_started_at: raw.processingStartedAt,
      },
      Date.now(),
      ATTENDANCE_FEE_STALE_PROCESSING_MS,
    ),
  );
}

{
  const el = resolveVisitUnlimitedEligibility(visit(1), 42, [unlimited135]);
  check("resolveVisitUnlimitedEligibility sanity", el.eligible === true && el.mindbodyProductId === 100135);
}

{
  const r = await recordLateCancel({
    config: CONFIG_OFF,
    visitRow: visit(1),
    clientServiceRows: [unlimited135],
    classStartMs: classStartFromNow(2 * 60 * 60 * 1000),
    triggerAtMs: Date.now(),
  });
  check(
    "runtime disabled → no row",
    resolveAttendanceFeeRuntimeConfig(CONFIG_OFF).enabled === false && r.outcome === "disabled",
  );
}

if (failed) {
  console.error(`\nFAILED ${failed} check(s)`);
  process.exit(1);
}
console.log("\nAll attendance-fee Phase 1 checks passed.");
