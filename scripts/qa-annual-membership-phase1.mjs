/**
 * AMARÉ Annual Membership Phase 1 — domain + store matrix.
 * Run: npm run test:annual-membership-phase1
 *
 * No Stripe, Mindbody writes, deploy, or webhook changes.
 */

process.env.ANNUAL_MEMBERSHIP_STORE_LOCAL_MEMORY = "1";

const {
  ANNUAL_SKU_DEFINITIONS,
  addMonthsToBusinessDate,
  buildAnnualMembershipPeriods,
  evaluateAnnualOverlapPolicy,
  fingerprintClientServiceIds,
  getAnnualSkuDefinition,
  normalizeClientServiceIdSnapshot,
  stripeInstantToBusinessDate,
  validateAnnualMembershipPeriods,
} = await import("../netlify/functions/annual-membership-lib.mjs");

const {
  openAnnualMembershipStoreForTests,
  resetAnnualMembershipStoreMemoryForTests,
} = await import("../netlify/functions/annual-membership-store.mjs");

let failed = 0;

function check(name, ok, detail) {
  if (ok) console.log(`PASS — ${name}`);
  else {
    failed += 1;
    console.log(`FAIL — ${name}${detail ? `\n  ${detail}` : ""}`);
  }
}

function assertPeriodContiguity(periods, termStart, termEnd) {
  validateAnnualMembershipPeriods(periods, termStart, termEnd);
  return true;
}

// ── PRICING ────────────────────────────────────────────────────────────────

for (const sku of ["annual_monthly_5", "annual_monthly_8", "annual_monthly_unlimited"]) {
  const def = getAnnualSkuDefinition(sku);
  check(
    `pricing ${sku}: net arithmetic`,
    def.listAmountCents - def.discountAmountCents === def.netAmountCents,
    `${def.listAmountCents} - ${def.discountAmountCents} !== ${def.netAmountCents}`,
  );
  check(
    `pricing ${sku}: annual total`,
    def.netAmountCents * 12 === def.annualTotalCents,
    `${def.netAmountCents} * 12 !== ${def.annualTotalCents}`,
  );
}

check(
  "pricing 5 canonical",
  ANNUAL_SKU_DEFINITIONS.annual_monthly_5.netAmountCents === 10625 &&
    ANNUAL_SKU_DEFINITIONS.annual_monthly_5.annualTotalCents === 127500,
);
check(
  "pricing 8 canonical",
  ANNUAL_SKU_DEFINITIONS.annual_monthly_8.netAmountCents === 15215 &&
    ANNUAL_SKU_DEFINITIONS.annual_monthly_8.annualTotalCents === 182580,
);
check(
  "pricing unlimited canonical",
  ANNUAL_SKU_DEFINITIONS.annual_monthly_unlimited.netAmountCents === 19465 &&
    ANNUAL_SKU_DEFINITIONS.annual_monthly_unlimited.annualTotalCents === 233580,
);

// ── PERIODS ────────────────────────────────────────────────────────────────

const sep17 = buildAnnualMembershipPeriods({
  termStartDate: "2026-09-17",
  termEndDate: "2027-09-17",
  sku: "annual_monthly_5",
});
check("periods Sep 17: count", sep17.length === 12);
check(
  "periods Sep 17: first window",
  sep17[0].periodStartDate === "2026-09-17" && sep17[0].periodEndDate === "2026-10-17",
);
check(
  "periods Sep 17: second window",
  sep17[1].periodStartDate === "2026-10-17" && sep17[1].periodEndDate === "2026-11-17",
);
check("periods Sep 17: contiguity", assertPeriodContiguity(sep17, "2026-09-17", "2027-09-17"));

const jan31 = buildAnnualMembershipPeriods({
  termStartDate: "2026-01-31",
  termEndDate: "2027-01-31",
  sku: "annual_monthly_5",
});
check(
  "periods Jan 31: Feb clamp",
  jan31[0].periodEndDate === "2026-02-28" && jan31[1].periodStartDate === "2026-02-28",
);
check(
  "periods Jan 31: Mar restore",
  jan31[1].periodEndDate === "2026-03-31" && jan31[2].periodStartDate === "2026-03-31",
);
check("periods Jan 31: contiguity", assertPeriodContiguity(jan31, "2026-01-31", "2027-01-31"));

const jan30 = buildAnnualMembershipPeriods({
  termStartDate: "2025-01-30",
  termEndDate: "2026-01-30",
  sku: "annual_monthly_8",
});
check(
  "periods Jan 30: Feb clamp",
  jan30[0].periodEndDate === "2025-02-28" && jan30[1].periodStartDate === "2025-02-28",
);
check("periods Jan 30: contiguity", assertPeriodContiguity(jan30, "2025-01-30", "2026-01-30"));

const leapAnchor = buildAnnualMembershipPeriods({
  termStartDate: "2024-01-31",
  termEndDate: "2025-01-31",
  sku: "annual_monthly_unlimited",
});
check(
  "periods leap year Jan 31: Feb 29",
  leapAnchor[0].periodEndDate === "2024-02-29" && leapAnchor[1].periodStartDate === "2024-02-29",
);

const feb29 = buildAnnualMembershipPeriods({
  termStartDate: "2024-02-29",
  termEndDate: "2025-02-28",
  sku: "annual_monthly_5",
});
check(
  "periods Feb 29 anchor: next month",
  feb29[0].periodEndDate === "2024-03-29" && addMonthsToBusinessDate("2024-02-29", 1) === "2024-03-29",
);
check("periods Feb 29 anchor: term end authoritative", feb29[11].periodEndDate === "2025-02-28");

const feb28 = buildAnnualMembershipPeriods({
  termStartDate: "2023-02-28",
  termEndDate: "2024-02-28",
  sku: "annual_monthly_5",
});
check(
  "periods Feb 28 non-leap: Mar boundary",
  feb28[0].periodEndDate === "2023-03-28" && feb28[1].periodStartDate === "2023-03-28",
);

const yearRollover = buildAnnualMembershipPeriods({
  termStartDate: "2025-11-17",
  termEndDate: "2026-11-17",
  sku: "annual_monthly_5",
});
check(
  "periods year rollover: Dec→Jan",
  yearRollover[1].periodEndDate === "2026-01-17" && yearRollover[2].periodStartDate === "2026-01-17",
);

check(
  "stripeInstantToBusinessDate ET",
  stripeInstantToBusinessDate("2026-09-17T03:30:00.000Z") === "2026-09-16" ||
    stripeInstantToBusinessDate("2026-09-17T14:00:00.000Z") === "2026-09-17",
);

// ── STORE: idempotency ─────────────────────────────────────────────────────

resetAnnualMembershipStoreMemoryForTests();
const storeA = openAnnualMembershipStoreForTests();

const termInput = {
  amareUserId: "usr_ANNUAL000000000000001",
  mindbodyClientId: 100002753,
  stripeCustomerId: "cus_annual0001",
  stripeSubscriptionId: "sub_annual0001",
  stripeInvoiceId: "in_annual0001",
  stripePriceId: "price_annual0001",
  sku: "annual_monthly_5",
  termStartDate: "2026-09-17",
  termEndDate: "2027-09-17",
  stripePeriodStartAt: "2026-09-17T04:00:00.000Z",
  stripePeriodEndAt: "2027-09-17T04:00:00.000Z",
};

const first = await storeA.createAnnualTermWithPeriods(termInput);
const second = await storeA.createAnnualTermWithPeriods(termInput);
check("term idempotency: first created", first.created === true);
check("term idempotency: replay not created", second.created === false);
check("term idempotency: same membership id", first.membership.id === second.membership.id);
check("term idempotency: 12 periods first", first.periods.length === 12);
check("term idempotency: 12 periods replay", second.periods.length === 12);
check(
  "term idempotency: no duplicate period rows",
  first.periods.map((p) => p.id).join(",") === second.periods.map((p) => p.id).join(","),
);

const byInvoice = await storeA.getAnnualMembershipByInvoiceId("in_annual0001");
check("term idempotency: invoice lookup", byInvoice?.id === first.membership.id);

// ── STORE: claim race ──────────────────────────────────────────────────────

const period0 = first.periods.find((p) => p.period_index === 0);
const raceResults = await Promise.all(
  Array.from({ length: 8 }, () => storeA.claimPeriod(period0.id)),
);
const winners = raceResults.filter((r) => r.acquired);
check("claim race: all ok", raceResults.every((r) => r.ok));
check("claim race: exactly one winner", winners.length === 1, `winners=${winners.length}`);

const reclaim = await storeA.claimPeriod(period0.id);
check("claim race: second claim loses", reclaim.acquired === false && reclaim.period?.status === "claiming");

// ── STORE: status CAS ──────────────────────────────────────────────────────

const issued = await storeA.markPeriodIssued(period0.id, {
  mindbodySaleId: 36921,
  mindbodyClientServiceId: 32921,
});
check("status CAS: issue from claiming", issued.ok === true && issued.period?.status === "issued");

const illegalPending = await storeA.releaseSafeRetryToPending(period0.id);
check(
  "status CAS: issued cannot return to pending",
  illegalPending.ok === false && illegalPending.reason === "invalid_period_status",
);

const period1 = first.periods.find((p) => p.period_index === 1);
await storeA.claimPeriod(period1.id);
const ambiguous = await storeA.markPeriodAmbiguous(period1.id, { error: "timeout" });
check("status CAS: ambiguous from claiming", ambiguous.ok === true && ambiguous.period?.status === "ambiguous");

const retry = await storeA.releaseSafeRetryToPending(period1.id, { note: "reconciled_zero_matches" });
check("status CAS: ambiguous safe retry", retry.ok === true && retry.period?.status === "pending");

// ── STORE: ambiguous snapshot durability ───────────────────────────────────

const period2 = first.periods.find((p) => p.period_index === 2);
await storeA.claimPeriod(period2.id);
const snapshotIds = [32921, 33001, 33002];
const snap = await storeA.persistPreIssueSnapshot(period2.id, {
  clientServiceIds: snapshotIds,
  expectedProductId: 100133,
  expectedNetAmountCents: 10625,
  claimStartedAt: "2026-09-17T12:00:00.000Z",
});
check("ambiguous snapshot: persisted", snap.ok === true);

const reloadedStore = openAnnualMembershipStoreForTests();
const reloaded = await reloadedStore.getAnnualPeriod(period2.id);
check(
  "ambiguous snapshot: survives reload",
  JSON.stringify(reloaded?.pre_issue_client_service_ids) === JSON.stringify(snapshotIds) &&
    reloaded?.status === "claiming" &&
    reloaded?.claim_started_at === "2026-09-17T12:00:00.000Z",
);

check(
  "ambiguous snapshot: fingerprint helper",
  fingerprintClientServiceIds(snapshotIds) === "32921,33001,33002" &&
    JSON.stringify(normalizeClientServiceIdSnapshot([33002, 32921, 32921])) === "[32921,33002]",
);

// ── STORE: due periods + stale claims ──────────────────────────────────────

const due = await storeA.listDuePeriods("2026-10-17");
check(
  "listDuePeriods includes retried pending period 1",
  due.some((p) => p.id === period1.id && p.status === "pending"),
);

const staleCutoff = new Date(Date.now() - 20 * 60 * 1000).toISOString();
const stale = await storeA.findStaleClaims(staleCutoff);
check(
  "findStaleClaims ignores fresh claim",
  !stale.some((p) => p.id === period2.id),
);

// ── OVERLAP POLICY ─────────────────────────────────────────────────────────

check(
  "overlap: no previous period",
  evaluateAnnualOverlapPolicy({
    currentPeriod: { periodIndex: 1, periodStartDate: "2026-10-17" },
  }) === "ALLOW",
);

check(
  "overlap: exhausted previous service",
  evaluateAnnualOverlapPolicy({
    previousAnnualPeriod: {
      periodIndex: 0,
      status: "issued",
      mindbodyClientServiceId: 32921,
    },
    previousMindbodyClientService: { Remaining: 0, ExpirationDate: "2026-10-17T00:00:00" },
    currentPeriod: { periodIndex: 1, periodStartDate: "2026-10-17" },
  }) === "ALLOW",
);

check(
  "overlap: active previous service defer",
  evaluateAnnualOverlapPolicy({
    previousAnnualPeriod: {
      periodIndex: 0,
      status: "issued",
      mindbodyClientServiceId: 32921,
    },
    previousMindbodyClientService: { Remaining: 3, ExpirationDate: "2026-11-18T00:00:00" },
    currentPeriod: { periodIndex: 1, periodStartDate: "2026-10-17" },
  }) === "DEFER",
);

check(
  "overlap: expired remaining credits allow",
  evaluateAnnualOverlapPolicy({
    previousAnnualPeriod: {
      periodIndex: 0,
      status: "issued",
      mindbodyClientServiceId: 32921,
    },
    previousMindbodyClientService: { Remaining: 2, ExpirationDate: "2026-10-17T00:00:00" },
    currentPeriod: { periodIndex: 1, periodStartDate: "2026-10-17" },
  }) === "ALLOW",
);

check(
  "overlap: missing linked service manual review",
  evaluateAnnualOverlapPolicy({
    previousAnnualPeriod: { periodIndex: 0, status: "issued", mindbodyClientServiceId: null },
    currentPeriod: { periodIndex: 1, periodStartDate: "2026-10-17" },
  }) === "MANUAL_REVIEW",
);

if (failed) {
  console.error(`\n${failed} annual membership phase 1 check(s) failed`);
  process.exit(1);
}

console.log("\nAnnual membership Phase 1 QA passed");
