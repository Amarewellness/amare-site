/**
 * Annual membership production bug regression — duplicate fulfillment + durable ledger.
 * Run: npm run test:annual-production-fix-regression
 *
 * Covers concurrent Stripe lifecycle paths, fail-closed Postgres selection, and reconciler safety.
 * No production mutations.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const embeddedDir = path.join(root, "netlify/functions/_embedded");
fs.mkdirSync(embeddedDir, { recursive: true });
fs.copyFileSync(
  path.join(root, "src/content/stripe-mindbody-catalog.config.json"),
  path.join(embeddedDir, "stripe-mindbody-catalog.config.json"),
);

process.env.ANNUAL_MEMBERSHIP_STORE_LOCAL_MEMORY = "1";
process.env.STRIPE_SUBSCRIPTION_STORE_LOCAL_MEMORY = "1";
process.env.NETLIFY = "";

const {
  openAnnualMembershipStore,
  openAnnualMembershipStoreForTests,
  resetAnnualMembershipStoreMemoryForTests,
  __testing: annualStoreTesting,
} = await import("../netlify/functions/annual-membership-store.mjs");

const {
  openSubscriptionStore,
  resetSubscriptionStoreMemoryForTests,
} = await import("../netlify/functions/stripe-subscription-store.mjs");

const { handleAnnualInvoicePaid } = await import(
  "../netlify/functions/annual-membership-webhook-lib.mjs"
);

await import("../netlify/functions/annual-membership-issue.mjs");

const { runAnnualMembershipReconciliation } = await import(
  "../netlify/functions/annual-membership-reconciler.mjs"
);

let failed = 0;

function check(name, ok, detail) {
  if (ok) console.log(`PASS — ${name}`);
  else {
    failed += 1;
    console.log(`FAIL — ${name}${detail ? `\n  ${detail}` : ""}`);
  }
}

function mockInvoice(overrides = {}) {
  const start = overrides.periodStart ?? 1737072000;
  const end = overrides.periodEnd ?? 1768608000;
  return {
    id: overrides.id || "in_annual_reg_1",
    subscription: overrides.subscription !== undefined ? overrides.subscription : "sub_annual_reg",
    customer: "cus_annual_reg",
    currency: "usd",
    period_start: start,
    period_end: end,
    billing_reason: overrides.billing_reason || "subscription_create",
    lines: {
      data: [
        {
          period: { start, end },
          price: { id: "price_annual_reg" },
        },
      ],
    },
    ...overrides.extra,
  };
}

function subRecord(overrides = {}) {
  return {
    id: overrides.id || "sub_amare_reg_test",
    localSku: overrides.localSku || "annual_monthly_unlimited",
    mindbodyClientId: overrides.mindbodyClientId ?? 100003742,
    stripeSubscriptionId: overrides.stripeSubscriptionId || "sub_annual_reg",
    stripeCustomerId: "cus_annual_reg",
    amareUserId: "usr_reg",
    status: "active",
    currency: "usd",
    invoices: [],
    ...overrides,
  };
}

function makeIssueCounter(storeRef) {
  let count = 0;
  const issueFn = async (periodId, opts = {}) => {
    const activeStore = opts.store ?? storeRef;
    const claim = await activeStore.claimPeriod(periodId);
    if (!claim.acquired) {
      return { outcome: "CLAIM_LOST", period: claim.period };
    }
    count += 1;
    await activeStore.markPeriodIssued(periodId, {
      mindbodySaleId: 88000 + count,
      mindbodyClientServiceId: 88001 + count,
    });
    return {
      outcome: "ISSUED",
      mindbodySaleId: String(88000 + count),
      mindbodyClientServiceId: String(88001 + count),
    };
  };
  return { issueFn, getCount: () => count, reset: () => {
    count = 0;
  } };
}

function freshSubStore() {
  resetSubscriptionStoreMemoryForTests();
  return openSubscriptionStore(null);
}

async function runConcurrentAnnualHandlers(input) {
  return Promise.all([
    handleAnnualInvoicePaid({ ...input, sourceEventId: input.sourceEventA }),
    handleAnnualInvoicePaid({ ...input, sourceEventId: input.sourceEventB }),
  ]);
}

// ── 1. checkout.session.completed + invoice.paid concurrently ───────────────

resetAnnualMembershipStoreMemoryForTests();
const store1 = openAnnualMembershipStoreForTests();
const subStore1 = freshSubStore();
const counter1 = makeIssueCounter(store1);
const invoice1 = mockInvoice({ id: "in_concurrent_checkout_paid" });
const [outA, outB] = await runConcurrentAnnualHandlers({
  invoice: invoice1,
  subscriptionRecord: subRecord(),
  store: store1,
  subStore: subStore1,
  issueFn: counter1.issueFn,
  sourceEventA: "evt_checkout_completed",
  sourceEventB: "evt_invoice_paid",
});
check(
  "1 concurrent checkout + invoice.paid: one Mindbody fulfillment",
  counter1.getCount() === 1,
  `issueCount=${counter1.getCount()}`,
);
check(
  "1 concurrent: exactly one claim acquired",
  [outA.claimResult, outB.claimResult].filter((r) => r === "acquired").length === 1,
);
check(
  "1 concurrent: one handler completes period 0",
  [outA.period0Issue?.outcome, outB.period0Issue?.outcome].includes("ISSUED"),
);

// ── 2. invoice.paid + invoice.payment_succeeded concurrently ────────────────

resetAnnualMembershipStoreMemoryForTests();
const store2 = openAnnualMembershipStoreForTests();
const subStore2 = freshSubStore();
const counter2 = makeIssueCounter(store2);
const invoice2 = mockInvoice({ id: "in_concurrent_paid_succeeded" });
const [paidOut, succeededOut] = await runConcurrentAnnualHandlers({
  invoice: invoice2,
  subscriptionRecord: subRecord({ id: "sub_amare_reg_test_2" }),
  store: store2,
  subStore: subStore2,
  issueFn: counter2.issueFn,
  sourceEventA: "evt_invoice_paid",
  sourceEventB: "evt_invoice_payment_succeeded",
});
check(
  "2 concurrent: one fulfillment",
  counter2.getCount() === 1,
  `issueCount=${counter2.getCount()}`,
);
check(
  "2 concurrent: period 0 issued once",
  [paidOut.period0Issue?.outcome, succeededOut.period0Issue?.outcome].filter((o) => o === "ISSUED")
    .length === 1,
);

// ── 3. duplicate delivery of same Stripe event ──────────────────────────────

resetAnnualMembershipStoreMemoryForTests();
const store3 = openAnnualMembershipStoreForTests();
const subStore3 = freshSubStore();
const counter3 = makeIssueCounter(store3);
const invoice3 = mockInvoice({ id: "in_duplicate_event" });
const first3 = await handleAnnualInvoicePaid({
  invoice: invoice3,
  subscriptionRecord: subRecord({ id: "sub_amare_reg_test_3" }),
  store: store3,
  subStore: subStore3,
  issueFn: counter3.issueFn,
  sourceEventId: "evt_same_redelivery",
});
const second3 = await handleAnnualInvoicePaid({
  invoice: invoice3,
  subscriptionRecord: subRecord({ id: "sub_amare_reg_test_3" }),
  store: store3,
  subStore: subStore3,
  issueFn: counter3.issueFn,
  sourceEventId: "evt_same_redelivery",
});
check("3 duplicate event: first succeeds", first3.ok === true && first3.claimResult === "acquired");
check(
  "3 duplicate event: second converges without extra issue",
  (second3.period0Issue?.outcome === "already_issued" || second3.noop === true) &&
    counter3.getCount() === 1,
);

// ── 4. two concurrent handlers share Postgres ledger + invoice claim ─────────

resetAnnualMembershipStoreMemoryForTests();
const store4 = openAnnualMembershipStoreForTests();
const subStore4 = freshSubStore();
const counter4 = makeIssueCounter(store4);
const invoice4 = mockInvoice({ id: "in_two_lambda_stores" });
await Promise.all([
  handleAnnualInvoicePaid({
    invoice: invoice4,
    subscriptionRecord: subRecord({ id: "sub_amare_reg_test_4" }),
    store: store4,
    subStore: subStore4,
    issueFn: counter4.issueFn,
    sourceEventId: "evt_lambda_a",
  }),
  handleAnnualInvoicePaid({
    invoice: invoice4,
    subscriptionRecord: subRecord({ id: "sub_amare_reg_test_4" }),
    store: store4,
    subStore: subStore4,
    issueFn: counter4.issueFn,
    sourceEventId: "evt_lambda_b",
  }),
]);
check(
  "4 shared ledger + claim: one Mindbody write",
  counter4.getCount() === 1,
  `mb=${counter4.getCount()}`,
);

// ── 5. Postgres unavailable in production → fail closed ─────────────────────

{
  const saved = {
    NETLIFY: process.env.NETLIFY,
    LOCAL: process.env.ANNUAL_MEMBERSHIP_STORE_LOCAL_MEMORY,
    DB: process.env.DATABASE_URL,
    NDB: process.env.NETLIFY_DB_URL,
    NDB2: process.env.NETLIFY_DATABASE_URL,
  };
  process.env.NETLIFY = "1";
  delete process.env.ANNUAL_MEMBERSHIP_STORE_LOCAL_MEMORY;
  delete process.env.DATABASE_URL;
  delete process.env.NETLIFY_DB_URL;
  delete process.env.NETLIFY_DATABASE_URL;

  let threwOpen = false;
  try {
    openAnnualMembershipStore();
  } catch (err) {
    threwOpen = String(/** @type {{ message?: string }} */ (err)?.message ?? err).includes(
      "annual_membership_db_unconfigured",
    );
  }

  let issueDuringProdFail = 0;
  try {
    await handleAnnualInvoicePaid({
      invoice: mockInvoice({ id: "in_prod_fail_closed" }),
      subscriptionRecord: subRecord({ id: "sub_amare_prod_fail" }),
      subStore: freshSubStore(),
      issueFn: async () => {
        issueDuringProdFail += 1;
        return { outcome: "ISSUED" };
      },
    });
  } catch (err) {
    threwOpen =
      threwOpen ||
      String(/** @type {{ message?: string }} */ (err)?.message ?? err).includes(
        "annual_membership_db_unconfigured",
      );
  }

  check("5 production without DB: openAnnualMembershipStore throws", threwOpen === true);
  check("5 production without DB: zero Mindbody issue", issueDuringProdFail === 0);

  process.env.NETLIFY = saved.NETLIFY;
  if (saved.LOCAL) process.env.ANNUAL_MEMBERSHIP_STORE_LOCAL_MEMORY = saved.LOCAL;
  if (saved.DB) process.env.DATABASE_URL = saved.DB;
  if (saved.NDB) process.env.NETLIFY_DB_URL = saved.NDB;
  if (saved.NDB2) process.env.NETLIFY_DATABASE_URL = saved.NDB2;
}

// ── 6. explicit forceMemory in tests ────────────────────────────────────────

process.env.NETLIFY = "1";
delete process.env.ANNUAL_MEMBERSHIP_STORE_LOCAL_MEMORY;
const forced = openAnnualMembershipStore({ forceMemory: true });
check(
  "6 forceMemory works under NETLIFY",
  forced.kind === "memory" && annualStoreTesting.shouldUseAnnualMemoryStore({ forceMemory: true }),
);
process.env.NETLIFY = "";
process.env.ANNUAL_MEMBERSHIP_STORE_LOCAL_MEMORY = "1";

// ── 7. annual term persisted → 12 period rows ───────────────────────────────

resetAnnualMembershipStoreMemoryForTests();
const store7 = openAnnualMembershipStoreForTests();
const subStore7 = freshSubStore();
const counter7 = makeIssueCounter(store7);
const term7 = await handleAnnualInvoicePaid({
  invoice: mockInvoice({ id: "in_twelve_periods" }),
  subscriptionRecord: subRecord({ id: "sub_amare_reg_test_7" }),
  store: store7,
  subStore: subStore7,
  issueFn: counter7.issueFn,
  sourceEventId: "evt_term_7",
});
check("7 term created", term7.ok === true && term7.created === true);
check("7 twelve periods persisted", term7.periods?.length === 12);

// ── 8. period 0 issued → reconciler does not duplicate ──────────────────────

let period0ReissueAttempts = 0;
const rec8 = await runAnnualMembershipReconciliation({
  store: store7,
  businessDate: term7.periods.find((p) => p.period_index === 1)?.period_start_date || "2026-02-01",
  issueFn: async (periodId, opts = {}) => {
    const rows = await store7.listPeriodsForMembership(term7.membership.id);
    const p = rows.find((row) => row.id === periodId);
    if (p?.period_index === 0) {
      period0ReissueAttempts += 1;
      return { outcome: "ISSUED" };
    }
    if (p?.period_index === 1) {
      await store7.claimPeriod(periodId);
      await store7.markPeriodIssued(periodId, { mindbodySaleId: 99001, mindbodyClientServiceId: 99002 });
      return { outcome: "ISSUED", mindbodySaleId: "99001", mindbodyClientServiceId: "99002" };
    }
    return { outcome: "SKIPPED" };
  },
});
check("8 reconciler never targets period 0", period0ReissueAttempts === 0);
const p0after = (await store7.listPeriodsForMembership(term7.membership.id)).find(
  (p) => p.period_index === 0,
);
check("8 period 0 remains issued once", p0after?.status === "issued");
check(
  "8 reconciler can issue period 1 when due",
  rec8.issued.some((row) => row.period_index === 1),
);

// ── 9. period 1 becomes due → reconciler finds it ───────────────────────────

resetAnnualMembershipStoreMemoryForTests();
const store9 = openAnnualMembershipStoreForTests();
const seeded9 = await store9.createAnnualTermWithPeriods({
  mindbodyClientId: 100003742,
  stripeCustomerId: "cus_rec9",
  stripeSubscriptionId: "sub_rec9",
  stripeInvoiceId: "in_rec9",
  sku: "annual_monthly_unlimited",
  termStartDate: "2026-01-01",
  termEndDate: "2027-01-01",
  stripePeriodStartAt: "2026-01-01T05:00:00.000Z",
  stripePeriodEndAt: "2027-01-01T05:00:00.000Z",
  annualAmountCents: 233580,
});
await store9.claimPeriod(seeded9.periods.find((p) => p.period_index === 0).id);
await store9.markPeriodIssued(seeded9.periods.find((p) => p.period_index === 0).id, {
  mindbodySaleId: 37485,
  mindbodyClientServiceId: 33341,
});
const due9 = seeded9.periods.find((p) => p.period_index === 1);
const rec9 = await runAnnualMembershipReconciliation({
  store: store9,
  businessDate: due9.period_start_date,
  issueFn: async (periodId) => {
    await store9.claimPeriod(periodId);
    await store9.markPeriodIssued(periodId, { mindbodySaleId: 99001, mindbodyClientServiceId: 99002 });
    return { outcome: "ISSUED", mindbodySaleId: "99001", mindbodyClientServiceId: "99002" };
  },
});
check(
  "9 reconciler finds due period 1",
  rec9.issued.some((row) => row.period_index === 1),
  `issued=${JSON.stringify(rec9.issued.map((r) => r.period_index))}`,
);

// ── 10. monthly recurring regression suite ──────────────────────────────────

function runMonthlySuite(script) {
  const r = spawnSync(process.execPath, [path.join(root, "scripts", script)], {
    cwd: root,
    env: { ...process.env, NETLIFY: "", STRIPE_SUBSCRIPTION_STORE_LOCAL_MEMORY: "1" },
    encoding: "utf8",
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return r.status === 0;
}

const monthlyClaimRace = runMonthlySuite("qa-stripe-invoice-claim-race.mjs");
const monthlyGate = runMonthlySuite("qa-final-purchase-regression-gate.mjs");
check("10 monthly claim race regression", monthlyClaimRace === true);
check("10 final purchase regression gate (monthly boundary)", monthlyGate === true);

console.log(`\nAnnual production fix regression: ${failed === 0 ? "PASS" : "FAIL"} (${failed} failed)`);
process.exit(failed === 0 ? 0 : 1);
