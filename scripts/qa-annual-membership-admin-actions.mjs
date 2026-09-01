/**
 * Annual membership admin actions — cancel renewal + revoke term + reconciler safety.
 * Run: node scripts/qa-annual-membership-admin-actions.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ANNUAL_ISSUANCE_ELIGIBLE_MEMBERSHIP_STATUSES,
  ANNUAL_REVOKE_SKIPPABLE_PERIOD_STATUSES,
} from "../netlify/functions/annual-membership-lib.mjs";
import {
  openAnnualMembershipStoreForTests,
  resetAnnualMembershipStoreMemoryForTests,
} from "../netlify/functions/annual-membership-store.mjs";
import { issueAnnualMembershipPeriod } from "../netlify/functions/annual-membership-issue.mjs";
import { runAnnualMembershipReconciliation } from "../netlify/functions/annual-membership-reconciler.mjs";
import { handler as adminHandler } from "../netlify/functions/annual-membership-admin.mjs";
import {
  adminCancelAnnualRenewal,
  adminRevokeAnnualTerm,
} from "../netlify/functions/annual-membership-admin-actions.mjs";

process.env.ANNUAL_MEMBERSHIP_STORE_LOCAL_MEMORY = "1";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;

function check(name, ok, detail) {
  if (ok) console.log(`PASS — ${name}`);
  else {
    failed += 1;
    console.log(`FAIL — ${name}${detail ? `\n  ${detail}` : ""}`);
  }
}

function applyRevokedMigrationSql() {
  const sqlPath = path.join(
    root,
    "netlify/database/migrations/20260901190000_annual_memberships_revoked_status.sql",
  );
  check("revoked migration file exists", fs.existsSync(sqlPath));
  check(
    "revoked in lib statuses",
    fs
      .readFileSync(path.join(root, "netlify/functions/annual-membership-lib.mjs"), "utf8")
      .includes('"revoked"'),
  );
}

applyRevokedMigrationSql();

resetAnnualMembershipStoreMemoryForTests();
const store = openAnnualMembershipStoreForTests();

async function seedTerm(sku = "annual_monthly_5") {
  const term = await store.createAnnualTermWithPeriods({
    sku,
    mindbodyClientId: 100002839,
    stripeSubscriptionId: `sub_test_${sku}_${Date.now()}`,
    stripeInvoiceId: `in_test_${sku}_${Date.now()}`,
    termStartDate: "2026-09-01",
    termEndDate: "2027-09-01",
    annualAmountCents: sku === "annual_monthly_8" ? 182580 : 127500,
  });
  return term;
}

async function issuePeriod0(term) {
  const p0 = term.periods.find((p) => p.period_index === 0);
  await store.claimPeriod(p0.id);
  await store.markPeriodIssued(p0.id, {
    mindbodySaleId: 90001,
    mindbodyClientServiceId: 90002,
  });
}

const termA = await seedTerm("annual_monthly_5");
const membershipId = termA.membership.id;
const period1 = termA.periods.find((p) => p.period_index === 1);

await issuePeriod0(termA);

const revoke1 = await adminRevokeAnnualTerm(membershipId, { confirmStop: "STOP" });
check("revoke term succeeds", revoke1.ok === true);
check("membership status revoked", revoke1.membership?.status === "revoked");
check(
  "future pending periods skipped",
  revoke1.futurePeriodsSkipped >= 10,
  String(revoke1.futurePeriodsSkipped),
);
check("issued period 0 preserved", revoke1.issuedPeriodsPreserved === 1);

const revoke2 = await adminRevokeAnnualTerm(membershipId, { confirmStop: "STOP" });
check("revoke twice idempotent", revoke2.ok === true && revoke2.idempotent === true);

const issueBlocked = await issueAnnualMembershipPeriod(period1.id, { store, businessDate: "2026-10-01" });
check(
  "issuer blocks revoked membership",
  issueBlocked.outcome === "MEMBERSHIP_NOT_ELIGIBLE" || issueBlocked.outcome === "PERIOD_NOT_ISSUABLE",
  String(issueBlocked.outcome),
);

const termB = await seedTerm("annual_monthly_8");
const racePeriod = termB.periods.find((p) => p.period_index === 0);
let syncCalled = false;
const raceResult = await issueAnnualMembershipPeriod(racePeriod.id, {
  store,
  businessDate: String(racePeriod.period_start_date),
  staffHeadersFn: async () => ({ ok: true, headers: { Authorization: "Bearer t" } }),
  fetchClientServicesFn: async () => {
    await store.setMembershipStatusForTests(termB.membership.id, "revoked");
    return { ok: true, services: [] };
  },
  syncFn: async () => {
    syncCalled = true;
    return { ok: true, mindbodySaleId: 1 };
  },
});
check(
  "claim/revoke race: no sync when membership revoked before Mindbody POST",
  !syncCalled && raceResult.outcome === "MEMBERSHIP_REVOKED_BEFORE_SYNC",
  `${raceResult.outcome} syncCalled=${syncCalled}`,
);

const ambiguousTerm = await seedTerm("annual_monthly_5");
const ambPeriod = ambiguousTerm.periods.find((p) => p.period_index === 3);
await store.claimPeriod(ambPeriod.id);
await store.markPeriodAmbiguous(ambPeriod.id, { error: "simulated" });
const revokeAmb = await adminRevokeAnnualTerm(ambiguousTerm.membership.id, { confirmStop: "STOP" });
check(
  "ambiguous period blocks revoke",
  revokeAmb.ok === false && revokeAmb.error === "ambiguous_periods_must_be_reconciled_first",
);

/* A — manual_review with possible committed allocation blocks revoke */
const termMr = await seedTerm("annual_monthly_5");
await issuePeriod0(termMr);
const mrPeriod = termMr.periods.find((p) => p.period_index === 2);
await store.claimPeriod(mrPeriod.id);
await store.persistPreIssueSnapshot(mrPeriod.id, {
  clientServiceIds: [88001],
  claimStartedAt: new Date().toISOString(),
});
await store.markPeriodManualReview(mrPeriod.id, {
  error: "ambiguous_multiple_candidates:2",
});
let mrSyncCalled = false;
const revokeMr = await adminRevokeAnnualTerm(termMr.membership.id, { confirmStop: "STOP" });
const mrMemAfter = await store.getAnnualMembership(termMr.membership.id);
const mrPeriodAfter = await store.getAnnualPeriod(mrPeriod.id);
check(
  "A manual_review with possible committed allocation blocks revoke",
  revokeMr.ok === false && revokeMr.error === "manual_review_requires_resolution",
);
check(
  "A period remains manual_review when revoke blocked",
  mrPeriodAfter?.status === "manual_review",
);
check(
  "A parent membership NOT revoked when manual_review blocks",
  mrMemAfter?.status === "active",
);
check(
  "A zero Mindbody writes during blocked revoke",
  mrSyncCalled === false,
);

/* B — failed with confirmed pre-write failure may be skipped on revoke */
const termFailSafe = await seedTerm("annual_monthly_8");
await issuePeriod0(termFailSafe);
const safeFailPeriod = termFailSafe.periods.find((p) => p.period_index === 1);
await store.claimPeriod(safeFailPeriod.id);
await store.markPeriodFailed(safeFailPeriod.id, { error: "snapshot_persist_failed" });
const revokeFailSafe = await adminRevokeAnnualTerm(termFailSafe.membership.id, { confirmStop: "STOP" });
const safeFailAfter = await store.getAnnualPeriod(safeFailPeriod.id);
check(
  "B failed pre-write failure allows revoke",
  revokeFailSafe.ok === true,
);
check(
  "B pre-write failed period becomes skipped on revoke",
  safeFailAfter?.status === "skipped",
);

/* C — failed with possible committed-write semantics blocks revoke */
const termFailUnsafe = await seedTerm("annual_monthly_5");
await issuePeriod0(termFailUnsafe);
const unsafeFailPeriod = termFailUnsafe.periods.find((p) => p.period_index === 2);
await store.claimPeriod(unsafeFailPeriod.id);
await store.persistPreIssueSnapshot(unsafeFailPeriod.id, {
  clientServiceIds: [88002],
  claimStartedAt: new Date().toISOString(),
});
await store.markPeriodFailed(unsafeFailPeriod.id, { error: "mindbody_cart_item_failed" });
const revokeFailUnsafe = await adminRevokeAnnualTerm(termFailUnsafe.membership.id, { confirmStop: "STOP" });
const unsafeMemAfter = await store.getAnnualMembership(termFailUnsafe.membership.id);
const unsafeFailAfter = await store.getAnnualPeriod(unsafeFailPeriod.id);
check(
  "C failed with possible committed write blocks revoke",
  revokeFailUnsafe.ok === false && revokeFailUnsafe.error === "failed_may_have_committed_write",
);
check(
  "C failed period unchanged when revoke blocked",
  unsafeFailAfter?.status === "failed",
);
check(
  "C parent membership NOT revoked when unsafe failed blocks",
  unsafeMemAfter?.status === "active",
);

const dueBefore = await store.listDuePeriods("2099-01-01", { statuses: ["pending", "failed"] });
const revokedDue = dueBefore.filter((p) => p.annual_membership_id === membershipId);
check("listDuePeriods excludes revoked parent", revokedDue.length === 0, String(revokedDue.length));

const rec = await runAnnualMembershipReconciliation({
  store,
  businessDate: "2099-01-01",
  issueFn: async (periodId) => {
    const period = await store.getAnnualPeriod(periodId);
    const mem = await store.getAnnualMembership(period?.annual_membership_id ?? "");
    if (mem?.status === "revoked") {
      throw new Error("reconciler_must_not_issue_revoked");
    }
    return { ok: false, outcome: "TEST_SKIP" };
  },
});
const revokedIssued = rec.issued.filter((row) => row.annual_membership_id === membershipId);
check("reconciler blocks revoked membership", revokedIssued.length === 0);

const cancelTerm = await seedTerm("annual_monthly_8");
const pendingBeforeCancel = (await store.listPeriodsForMembership(cancelTerm.membership.id)).filter(
  (p) => p.status === "pending",
).length;
const cancelResult = await adminCancelAnnualRenewal(cancelTerm.membership.id);
check(
  "cancel renewal without stripe config fails closed",
  cancelResult.ok === false && cancelResult.error === "stripe_not_configured",
);
const afterCancelMem = await store.getAnnualMembership(cancelTerm.membership.id);
check("cancel renewal preserves active membership in Postgres", afterCancelMem?.status === "active");
const pendingAfterCancel = (await store.listPeriodsForMembership(cancelTerm.membership.id)).filter(
  (p) => p.status === "pending",
).length;
check(
  "cancel renewal leaves current-term pending periods unchanged",
  pendingBeforeCancel === pendingAfterCancel && pendingAfterCancel > 0,
  `${pendingBeforeCancel} → ${pendingAfterCancel}`,
);

/* D/E — cancel renewal stripe subscription guards */
const pendingCancelTerm = await store.createAnnualTermWithPeriods({
  sku: "annual_monthly_5",
  mindbodyClientId: 100002839,
  stripeSubscriptionId: "pending_sub_amare_cancel_test",
  stripeInvoiceId: `in_pending_cancel_${Date.now()}`,
  termStartDate: "2026-09-01",
  termEndDate: "2027-09-01",
  annualAmountCents: 127500,
});
let stripeMutatedOnPending = false;
process.env.STRIPE_SECRET_KEY = "sk_test_fake_for_cancel_guard";
const pendingCancel = await adminCancelAnnualRenewal(pendingCancelTerm.membership.id, {
  stripe: {
    subscriptions: {
      retrieve: async () => {
        stripeMutatedOnPending = true;
        return {};
      },
      update: async () => {
        stripeMutatedOnPending = true;
        return {};
      },
    },
  },
});
check(
  "E cancel renewal blocks pending_sub_amare_*",
  pendingCancel.ok === false &&
    pendingCancel.error === "REAL_STRIPE_SUBSCRIPTION_ID_MISSING" &&
    stripeMutatedOnPending === false,
);

const realCancelTerm = await store.createAnnualTermWithPeriods({
  sku: "annual_monthly_8",
  mindbodyClientId: 100002839,
  stripeSubscriptionId: "sub_cancel_renewal_test",
  stripeInvoiceId: `in_real_cancel_${Date.now()}`,
  termStartDate: "2026-09-01",
  termEndDate: "2027-09-01",
  annualAmountCents: 182580,
});
let stripeUpdateCalled = false;
const realCancel = await adminCancelAnnualRenewal(realCancelTerm.membership.id, {
  stripe: {
    subscriptions: {
      retrieve: async (id) => ({
        id,
        cancel_at_period_end: false,
        status: "active",
        current_period_end: 123,
        cancel_at: null,
      }),
      update: async (id, patch) => {
        stripeUpdateCalled = patch.cancel_at_period_end === true;
        return {
          id,
          cancel_at_period_end: true,
          status: "active",
          current_period_end: 123,
          cancel_at: null,
        };
      },
    },
  },
});
check("D cancel renewal accepts real sub_*", realCancel.ok === true && stripeUpdateCalled === true);

const { formatAnnualBusinessDate } = await import("../netlify/functions/annual-membership-lib.mjs");
check(
  "F SQL DATE serializes as 2026-09-01",
  formatAnnualBusinessDate(new Date("2026-09-01T00:00:00.000Z")) === "2026-09-01",
);
check(
  "G SQL DATE 2026-11-01 across DST",
  formatAnnualBusinessDate(new Date("2026-11-01T00:00:00.000Z")) === "2026-11-01",
);

process.env.ADMIN_DEBUG_TOKEN = "phase4-admin-token-32chars-min";
const noAuth = await adminHandler({
  httpMethod: "POST",
  headers: {},
  body: JSON.stringify({ action: "revoke_term", annualMembershipId: membershipId, confirmStop: "STOP" }),
});
check("admin POST rejects missing token", noAuth.statusCode === 401);
const badAuth = await adminHandler({
  httpMethod: "POST",
  headers: { "x-admin-token": "wrong-token-value-here" },
  body: JSON.stringify({ action: "revoke_term", annualMembershipId: membershipId, confirmStop: "STOP" }),
});
check("admin POST rejects wrong token", badAuth.statusCode === 401);
const noConfirm = await adminHandler({
  httpMethod: "POST",
  headers: { "x-admin-token": process.env.ADMIN_DEBUG_TOKEN },
  body: JSON.stringify({ action: "revoke_term", annualMembershipId: membershipId }),
});
check("admin POST revoke requires STOP", noConfirm.statusCode === 400);
const validAuth = await adminHandler({
  httpMethod: "POST",
  headers: { "x-admin-token": process.env.ADMIN_DEBUG_TOKEN },
  body: JSON.stringify({
    action: "revoke_term",
    annualMembershipId: membershipId,
    confirmStop: "STOP",
  }),
});
check("admin POST revoke allowed with valid token", validAuth.statusCode === 200);

check(
  "revoke skippable statuses are pending-only at status level",
  ANNUAL_REVOKE_SKIPPABLE_PERIOD_STATUSES.length === 1 &&
    ANNUAL_REVOKE_SKIPPABLE_PERIOD_STATUSES.includes("pending") &&
    !ANNUAL_REVOKE_SKIPPABLE_PERIOD_STATUSES.includes("manual_review"),
);
check(
  "revoked not issuance eligible",
  !ANNUAL_ISSUANCE_ELIGIBLE_MEMBERSHIP_STATUSES.includes("revoked"),
);

/* Revoke invariant audit — safely-unissued current Period 0 must be skipped */
async function seedRevokeTerm(s, sku = "annual_monthly_5") {
  return s.createAnnualTermWithPeriods({
    sku,
    mindbodyClientId: 100002839,
    stripeSubscriptionId: `sub_revoke_${sku}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    stripeInvoiceId: `in_revoke_${sku}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    termStartDate: "2026-09-01",
    termEndDate: "2027-09-01",
    annualAmountCents: sku === "annual_monthly_8" ? 182580 : 127500,
  });
}

async function periodCounts(s, membershipId) {
  const periods = await s.listPeriodsForMembership(membershipId);
  return {
    pending: periods.filter((p) => p.status === "pending").length,
    skipped: periods.filter((p) => p.status === "skipped").length,
    issued: periods.filter((p) => p.status === "issued").length,
  };
}

/* RevokeInv-A — all pending, no Mindbody attempt → all 12 skipped including P0 */
resetAnnualMembershipStoreMemoryForTests();
const storeInvA = openAnnualMembershipStoreForTests();
const termAllPending = await seedRevokeTerm(storeInvA);
const revokeAllPending = await adminRevokeAnnualTerm(termAllPending.membership.id, {
  confirmStop: "STOP",
});
const countsInvA = await periodCounts(storeInvA, termAllPending.membership.id);
check(
  "RevokeInv-A all-pending revoke succeeds",
  revokeAllPending.ok === true && revokeAllPending.membership?.status === "revoked",
);
check(
  "RevokeInv-A all 12 periods skipped including P0",
  countsInvA.skipped === 12 && countsInvA.pending === 0 && countsInvA.issued === 0,
  JSON.stringify(countsInvA),
);

/* RevokeInv-B — P0 issued + P1–11 pending → P0 issued preserved */
resetAnnualMembershipStoreMemoryForTests();
const storeInvB = openAnnualMembershipStoreForTests();
const termIssuedP0 = await seedRevokeTerm(storeInvB);
const p0b = termIssuedP0.periods.find((p) => p.period_index === 0);
const claimB = await storeInvB.claimPeriod(p0b.id);
const issuedB = await storeInvB.markPeriodIssued(p0b.id, {
  mindbodySaleId: 91001,
  mindbodyClientServiceId: 91002,
});
const p0BeforeRevokeB = await storeInvB.getAnnualPeriod(p0b.id);
check("RevokeInv-B P0 issued before revoke", p0BeforeRevokeB?.status === "issued", String(p0BeforeRevokeB?.status));
check("RevokeInv-B claim acquired", claimB.acquired === true, JSON.stringify(claimB));
check("RevokeInv-B mark issued ok", issuedB.ok === true, JSON.stringify(issuedB));
const revokeIssuedP0 = await adminRevokeAnnualTerm(termIssuedP0.membership.id, {
  confirmStop: "STOP",
});
const countsInvB = await periodCounts(storeInvB, termIssuedP0.membership.id);
const p0AfterB = await storeInvB.getAnnualPeriodByMembershipIndex(termIssuedP0.membership.id, 0);
check(
  "RevokeInv-B P0 issued preserved on revoke",
  revokeIssuedP0.ok === true && p0AfterB?.status === "issued" && countsInvB.issued === 1,
);
check(
  "RevokeInv-B P1–11 skipped",
  countsInvB.skipped === 11 && countsInvB.pending === 0,
  JSON.stringify(countsInvB),
);

/* RevokeInv-C — P0 ambiguous blocks store revoke (authoritative guard) */
resetAnnualMembershipStoreMemoryForTests();
const storeInvC = openAnnualMembershipStoreForTests();
const termAmbP0 = await seedRevokeTerm(storeInvC);
const p0c = termAmbP0.periods.find((p) => p.period_index === 0);
await storeInvC.claimPeriod(p0c.id);
await storeInvC.markPeriodAmbiguous(p0c.id, { error: "simulated" });
const storeRevokeAmbP0 = await storeInvC.revokeAnnualMembershipTerm(termAmbP0.membership.id, {
  reason: "test",
});
check(
  "RevokeInv-C P0 ambiguous blocks revoke",
  storeRevokeAmbP0.ok === false &&
    storeRevokeAmbP0.reason === "ambiguous_periods_must_be_reconciled_first",
);

/* RevokeInv-D — P0 unsafe manual_review blocks revoke */
resetAnnualMembershipStoreMemoryForTests();
const storeInvD = openAnnualMembershipStoreForTests();
const termMrP0 = await seedRevokeTerm(storeInvD);
const p0d = termMrP0.periods.find((p) => p.period_index === 0);
await storeInvD.claimPeriod(p0d.id);
await storeInvD.persistPreIssueSnapshot(p0d.id, {
  clientServiceIds: [88003],
  claimStartedAt: new Date().toISOString(),
});
await storeInvD.markPeriodManualReview(p0d.id, { error: "ambiguous_multiple_candidates:2" });
const revokeMrP0 = await adminRevokeAnnualTerm(termMrP0.membership.id, { confirmStop: "STOP" });
check(
  "RevokeInv-D P0 unsafe manual_review blocks revoke",
  revokeMrP0.ok === false && revokeMrP0.error === "manual_review_requires_resolution",
);

/* RevokeInv-E — reconciler on one revoked term → zero writes */
resetAnnualMembershipStoreMemoryForTests();
const storeInvE = openAnnualMembershipStoreForTests();
const termRec = await seedRevokeTerm(storeInvE);
await adminRevokeAnnualTerm(termRec.membership.id, { confirmStop: "STOP" });
let recWrites = 0;
const recOnRevoked = await runAnnualMembershipReconciliation({
  store: storeInvE,
  businessDate: "2099-01-01",
  issueFn: async (periodId) => {
    const period = await storeInvE.getAnnualPeriod(periodId);
    if (String(period?.annual_membership_id) !== String(termRec.membership.id)) {
      return { ok: false, outcome: "OTHER_TERM" };
    }
    recWrites += 1;
    return { ok: false, outcome: "TEST_SKIP" };
  },
});
check(
  "RevokeInv-E reconciler zero writes on revoked term",
  recWrites === 0 && recOnRevoked.issued.length === 0,
  `writes=${recWrites} issued=${recOnRevoked.issued.length}`,
);

/* RevokeInv-F — idempotent revoke heals leftover pending on revoked membership */
resetAnnualMembershipStoreMemoryForTests();
const storeInvF = openAnnualMembershipStoreForTests();
const termHeal = await seedRevokeTerm(storeInvF);
const p0Heal = termHeal.periods.find((p) => p.period_index === 0);
await storeInvF.revokeAnnualMembershipTerm(termHeal.membership.id, { reason: "first_revoke" });
await storeInvF.setPeriodStatusForTests(p0Heal.id, "pending");
const healRevoke = await storeInvF.revokeAnnualMembershipTerm(termHeal.membership.id, {
  reason: "heal_pending",
});
const countsInvF = await periodCounts(storeInvF, termHeal.membership.id);
check(
  "RevokeInv-F idempotent revoke heals leftover pending P0",
  healRevoke.ok === true &&
    healRevoke.idempotent === true &&
    (healRevoke.healedCount ?? 0) >= 1 &&
    countsInvF.pending === 0 &&
    countsInvF.skipped === 12,
  JSON.stringify({ healRevoke, countsInvF }),
);

console.log("");
if (failed) {
  console.error(`${failed} failure(s)`);
  process.exit(1);
}
console.log("Annual membership admin actions QA passed.");
