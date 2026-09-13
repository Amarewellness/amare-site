/**
 * Annual invoice claim lifecycle — recovery after ledger-first redesign.
 * Run: node scripts/qa-annual-invoice-claim-lifecycle.mjs
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
  resetAnnualMembershipStoreMemoryForTests,
  openAnnualMembershipStoreForTests,
  openAnnualMembershipStore,
} = await import("../netlify/functions/annual-membership-store.mjs");

const {
  resetSubscriptionStoreMemoryForTests,
  openSubscriptionStore,
} = await import("../netlify/functions/stripe-subscription-store.mjs");

const { handleAnnualInvoicePaid } = await import(
  "../netlify/functions/annual-membership-webhook-lib.mjs"
);

const {
  issueAnnualMembershipPeriod,
  recoverStaleAnnualClaims,
} = await import("../netlify/functions/annual-membership-issue.mjs");

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

function mockInvoice(id) {
  const start = 1737072000;
  const end = 1768608000;
  return {
    id,
    subscription: "sub_lifecycle_test",
    customer: "cus_lifecycle",
    currency: "usd",
    period_start: start,
    period_end: end,
    billing_reason: "subscription_create",
    lines: { data: [{ period: { start, end }, price: { id: "price_lifecycle" } }] },
  };
}

function subRecord(id = "sub_amare_lifecycle") {
  return {
    id,
    localSku: "annual_monthly_unlimited",
    mindbodyClientId: 100003742,
    stripeSubscriptionId: "sub_lifecycle_test",
    stripeCustomerId: "cus_lifecycle",
    status: "active",
    currency: "usd",
    invoices: [],
  };
}

function freshStores() {
  resetSubscriptionStoreMemoryForTests();
  resetAnnualMembershipStoreMemoryForTests();
  return {
    annual: openAnnualMembershipStoreForTests(),
    sub: openSubscriptionStore(null),
  };
}

function successIssueFn(store) {
  return async (periodId, opts = {}) => {
    const activeStore = opts.store ?? store;
    const claim = await activeStore.claimPeriod(periodId);
    if (!claim.acquired) {
      return { outcome: "CLAIM_LOST", period: claim.period };
    }
    await activeStore.markPeriodIssued(periodId, {
      mindbodySaleId: 99001,
      mindbodyClientServiceId: 99002,
    });
    return {
      outcome: "ISSUED",
      mindbodySaleId: "99001",
      mindbodyClientServiceId: "99002",
    };
  };
}

// ── 1. Ledger + claim + crash before Mindbody; retry completes ───────────────

{
  let mbCalls = 0;
  const { annual, sub } = freshStores();
  const invoice = mockInvoice("in_lc_1");
  const record = subRecord("sub_lc_1");
  let calls = 0;

  try {
    await handleAnnualInvoicePaid({
      invoice,
      subscriptionRecord: record,
      store: annual,
      subStore: sub,
      sourceEventId: "evt_1a",
      issueFn: async (periodId, opts = {}) => {
        calls += 1;
        mbCalls += 1;
        throw new Error("simulated_crash_before_mindbody_complete");
      },
    });
  } catch {
    /* expected */
  }

  const term = await annual.getAnnualMembershipByInvoiceId(invoice.id);
  check("1 ledger exists after crash", !!term);
  check("1 handler A reached Mindbody path", mbCalls === 1);

  mbCalls = 0;
  const retry = await handleAnnualInvoicePaid({
    invoice,
    subscriptionRecord: record,
    store: annual,
    subStore: sub,
    sourceEventId: "evt_1b",
    issueFn: async (periodId, opts = {}) => {
      mbCalls += 1;
      return successIssueFn(opts.store ?? annual)(periodId, opts);
    },
  });
  const periods = await annual.listPeriodsForMembership(term.id);
  const p0 = periods.find((p) => p.period_index === 0);
  check("1 retry completes fulfillment", retry.ok === true && p0?.status === "issued");
  check("1 exactly one Mindbody fulfillment", mbCalls === 1);
  check("1 twelve periods", periods.length === 12);
}

// ── 2. Definite Mindbody failure then retry completes once ───────────────────

{
  let mbCalls = 0;
  const { annual, sub } = freshStores();
  const invoice = mockInvoice("in_lc_2");
  const record = subRecord("sub_lc_2");

  await handleAnnualInvoicePaid({
    invoice,
    subscriptionRecord: record,
    store: annual,
    subStore: sub,
    sourceEventId: "evt_2a",
    issueFn: async (periodId, opts = {}) => {
      mbCalls += 1;
      const activeStore = opts.store ?? annual;
      await activeStore.claimPeriod(periodId);
      await activeStore.markPeriodFailed(periodId, { error: "mindbody_sync_rejected" });
      return { outcome: "FAILED", reason: "mindbody_sync_rejected", period: await activeStore.getAnnualPeriod(periodId) };
    },
  });

  mbCalls = 0;
  const retry = await handleAnnualInvoicePaid({
    invoice,
    subscriptionRecord: record,
    store: annual,
    subStore: sub,
    sourceEventId: "evt_2b",
    issueFn: async (periodId, opts = {}) => {
      mbCalls += 1;
      return successIssueFn(opts.store ?? annual)(periodId, opts);
    },
  });
  const term = await annual.getAnnualMembershipByInvoiceId(invoice.id);
  const p0 = (await annual.listPeriodsForMembership(term.id)).find((p) => p.period_index === 0);
  check("2 retry after definite failure issues once", retry.ok && p0?.status === "issued");
  check("2 one Mindbody on retry", mbCalls === 1);
}

// ── 3. Ambiguous outcome does not duplicate Mindbody ───────────────────────────

{
  let mbCalls = 0;
  const { annual, sub } = freshStores();
  const invoice = mockInvoice("in_lc_3");
  const record = subRecord("sub_lc_3");

  await handleAnnualInvoicePaid({
    invoice,
    subscriptionRecord: record,
    store: annual,
    subStore: sub,
    sourceEventId: "evt_3a",
    issueFn: async (periodId, opts = {}) => {
      mbCalls += 1;
      const activeStore = opts.store ?? annual;
      await activeStore.claimPeriod(periodId);
      await activeStore.markPeriodAmbiguous(periodId, { error: "mindbody_sync_timeout" });
      return {
        outcome: "AMBIGUOUS",
        reason: "mindbody_sync_timeout",
        period: await activeStore.getAnnualPeriod(periodId),
      };
    },
  });

  mbCalls = 0;
  const retry = await handleAnnualInvoicePaid({
    invoice,
    subscriptionRecord: record,
    store: annual,
    subStore: sub,
    sourceEventId: "evt_3b",
    issueFn: async () => {
      mbCalls += 1;
      return { outcome: "ISSUED" };
    },
  });
  check("3 ambiguous retry does not blindly POST again", mbCalls === 0);
  check(
    "3 ambiguous retry awaits reconciliation",
    retry.status === "annual_awaiting_reconciliation" || retry.period0Issue?.outcome === "no_blind_retry",
  );
}

// ── 4. Mindbody success + crash before issued; stale recovery attaches ───────

{
  let mbCalls = 0;
  const { annual, sub } = freshStores();
  const invoice = mockInvoice("in_lc_4");
  const record = subRecord("sub_lc_4");

  try {
    await handleAnnualInvoicePaid({
      invoice,
      subscriptionRecord: record,
      store: annual,
      subStore: sub,
      sourceEventId: "evt_4a",
      issueFn: async (periodId, opts = {}) => {
        mbCalls += 1;
        const activeStore = opts.store ?? annual;
        await activeStore.claimPeriod(periodId);
        throw new Error("simulated_crash_after_mindbody_before_mark");
      },
    });
  } catch {
    /* expected */
  }

  const term = await annual.getAnnualMembershipByInvoiceId(invoice.id);
  const p0 = (await annual.listPeriodsForMembership(term.id)).find((p) => p.period_index === 0);
  await annual.persistPreIssueSnapshot(p0.id, {
    clientServiceIds: [88001],
    claimStartedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
  });

  mbCalls = 0;
  const staleRec = await recoverStaleAnnualClaims({
    store: annual,
    headers: { Authorization: "Bearer test" },
    fetchMbFn: async (_method, p) => {
      if (p.includes("clientservices")) {
        return {
          ok: true,
          status: 200,
          data: {
            ClientServices: [
              { Id: 88001, ProductId: 100135 },
              { Id: 99002, ProductId: 100135 },
            ],
          },
        };
      }
      if (p.includes("clientpurchases")) {
        return {
          ok: true,
          status: 200,
          data: {
            Purchases: [
              {
                Sale: {
                  Id: 99001,
                  PurchasedItems: [{ Id: 100135, TotalAmount: 194.65, PaymentRefId: 99002 }],
                  Payments: [{ Method: 17 }],
                },
              },
            ],
          },
        };
      }
      return { ok: false, status: 404, data: {} };
    },
  });
  const p0after = (await annual.listPeriodsForMembership(term.id)).find((p) => p.period_index === 0);
  check("4 stale recovery runs", staleRec.reconciled.length >= 1);
  check("4 period issued without duplicate POST", p0after?.status === "issued");
  check("4 no extra Mindbody POST on recovery", mbCalls === 0);
}

// ── 5 + 6. Concurrent lifecycle paths ────────────────────────────────────────

async function runConcurrentAnnual(input) {
  let totalMb = 0;
  const issueFn = async (periodId, opts = {}) => {
    const result = await successIssueFn(opts.store ?? input.store)(periodId, opts);
    if (result.outcome === "ISSUED") totalMb += 1;
    return result;
  };
  const [a, b] = await Promise.all([
    handleAnnualInvoicePaid({ ...input, issueFn, sourceEventId: input.eventA }),
    handleAnnualInvoicePaid({ ...input, issueFn, sourceEventId: input.eventB }),
  ]);
  return { a, b, totalMb };
}

{
  const { annual, sub } = freshStores();
  const invoice = mockInvoice("in_lc_5");
  const out = await runConcurrentAnnual({
    invoice,
    subscriptionRecord: subRecord("sub_lc_5"),
    store: annual,
    subStore: sub,
    eventA: "evt_checkout_completed",
    eventB: "evt_invoice_paid",
  });
  const term = await annual.getAnnualMembershipByInvoiceId(invoice.id);
  const periods = await annual.listPeriodsForMembership(term.id);
  const p0 = periods.find((p) => p.period_index === 0);
  check("5 concurrent checkout+paid: one Mindbody", out.totalMb === 1);
  check("5 one term twelve periods", !!term && periods.length === 12);
  check("5 period 0 issued", p0?.status === "issued");
}

{
  const { annual, sub } = freshStores();
  const invoice = mockInvoice("in_lc_6");
  const out = await runConcurrentAnnual({
    invoice,
    subscriptionRecord: subRecord("sub_lc_6"),
    store: annual,
    subStore: sub,
    eventA: "evt_invoice_paid",
    eventB: "evt_invoice_payment_succeeded",
  });
  const term = await annual.getAnnualMembershipByInvoiceId(invoice.id);
  const periods = await annual.listPeriodsForMembership(term.id);
  check("6 concurrent paid+succeeded: one Mindbody", out.totalMb === 1);
  check("6 twelve periods", periods.length === 12);
}

// ── 7. Production DB unavailable fail closed ───────────────────────────────────

{
  const saved = {
    NETLIFY: process.env.NETLIFY,
    LOCAL: process.env.ANNUAL_MEMBERSHIP_STORE_LOCAL_MEMORY,
  };
  process.env.NETLIFY = "1";
  delete process.env.ANNUAL_MEMBERSHIP_STORE_LOCAL_MEMORY;

  let threw = false;
  let mbCalls = 0;
  try {
    await handleAnnualInvoicePaid({
      invoice: mockInvoice("in_lc_7"),
      subscriptionRecord: subRecord("sub_lc_7"),
      subStore: freshStores().sub,
      issueFn: async () => {
        mbCalls += 1;
        return { outcome: "ISSUED" };
      },
    });
  } catch (err) {
    threw = String(/** @type {{ message?: string }} */ (err)?.message ?? err).includes(
      "annual_membership_db_unconfigured",
    );
  }
  try {
    openAnnualMembershipStore();
  } catch (err) {
    threw =
      threw ||
      String(/** @type {{ message?: string }} */ (err)?.message ?? err).includes(
        "annual_membership_db_unconfigured",
      );
  }
  check("7 production without DB fail closed", threw === true);
  check("7 zero Mindbody writes", mbCalls === 0);

  process.env.NETLIFY = saved.NETLIFY;
  if (saved.LOCAL) process.env.ANNUAL_MEMBERSHIP_STORE_LOCAL_MEMORY = saved.LOCAL;
}

function runScript(script) {
  const r = spawnSync(process.execPath, [path.join(root, "scripts", script)], {
    cwd: root,
    env: { ...process.env, NETLIFY: "", STRIPE_SUBSCRIPTION_STORE_LOCAL_MEMORY: "1", ANNUAL_MEMBERSHIP_STORE_LOCAL_MEMORY: "1" },
    encoding: "utf8",
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return r.status === 0;
}

check("monthly claim race regression", runScript("qa-stripe-invoice-claim-race.mjs"));
check("final purchase regression gate", runScript("qa-final-purchase-regression-gate.mjs"));
check("annual phase3 regression", runScript("qa-annual-membership-phase3.mjs"));

console.log(`\nAnnual invoice claim lifecycle QA: ${failed === 0 ? "PASS" : "FAIL"} (${failed} failed)`);
process.exit(failed === 0 ? 0 : 1);
