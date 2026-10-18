/**
 * Phase 1 monthly renewal: one CheckoutShoppingCart after a later-paid invoice.
 * Local memory store only. No Stripe, Mindbody, or blob writes.
 * Run: node scripts/qa-monthly-renewal-period-sync.mjs
 */
process.env.NETLIFY = "";
process.env.STRIPE_SUBSCRIPTION_STORE_LOCAL_MEMORY = "1";
process.env.MONTHLY_RENEWAL_SYNC_TEST = "1";
process.env.NODE_ENV = "test";
process.env.ADMIN_DEBUG_TOKEN = "local-monthly-renewal-test-token-32chars";

import fs from "node:fs";
import { getCatalogItem, isAnnualMembershipCatalogItem } from "../netlify/functions/stripe-catalog-lib.mjs";
import { selectCurrentMonthlyCycleRow } from "../netlify/functions/member-topup-lib.mjs";
import { resolveIntendedBookClientServiceId } from "../netlify/functions/unlimited-daily-limit-lib.mjs";
import {
  openSubscriptionStore,
  resetSubscriptionStoreMemoryForTests,
} from "../netlify/functions/stripe-subscription-store.mjs";
import { handler as adminHandler } from "../netlify/functions/stripe-admin-subscriptions.mjs";
import {
  buildMonthlyReconcileReport,
  executeMonthlyRenewalSync,
  monthlyInvoicePaidAction,
} from "../netlify/functions/stripe-monthly-period-sync.mjs";

let failed = 0;
function check(name, ok, detail) {
  if (ok) console.log(`PASS — ${name}`);
  else {
    failed += 1;
    console.error(`FAIL — ${name}${detail ? ` (${detail})` : ""}`);
  }
}

function paidInvoice(overrides = {}) {
  return {
    id: "in_1UKFqXA47S4kb7VHieCxhwV6",
    status: "paid",
    amount_paid: 12500,
    currency: "usd",
    billing_reason: "subscription_cycle",
    status_transitions: { paid_at: Math.floor(Date.parse("2026-10-02T18:03:45Z") / 1000) },
    ...overrides,
  };
}

function baseRecord(invoices) {
  return {
    id: "sub_amare_BRITTESTMONTHLY01",
    status: "past_due",
    localSku: "monthly_5",
    displayName: "Monthly 5 Classes",
    monthlyAmountCents: 12500,
    currency: "usd",
    mindbodyClientId: 100003846,
    stripeSubscriptionId: "sub_1U914WA47S4kb7VHwdu6KA1B",
    stripeCustomerId: "cus_test",
    stripeCheckoutSessionId: "cs_test_brittany",
    invoices,
    createdAt: "2026-08-27T05:03:53.145Z",
    updatedAt: "2026-09-27T12:03:37.569Z",
  };
}

function failedEntry() {
  return {
    invoiceId: "in_1UKFqXA47S4kb7VHieCxhwV6",
    amountPaidCents: 0,
    currency: "usd",
    paidAt: "2026-09-27T12:03:37.569Z",
    status: "skipped_payment_failed",
    mindbodySaleId: null,
    mindbodyTransactionId: null,
    retryCount: 0,
    firstAttemptAt: "2026-09-27T12:03:37.569Z",
    lastAttemptAt: "2026-09-27T12:03:37.569Z",
    lastError: "stripe_invoice_payment_failed",
  };
}

function memoryStore() {
  resetSubscriptionStoreMemoryForTests();
  return openSubscriptionStore();
}

async function runSync(store, record, entry, syncFn, extras = {}) {
  return executeMonthlyRenewalSync({
    subStore: store,
    record,
    invoice: { id: "in_1UKFqXA47S4kb7VHieCxhwV6", currency: "usd" },
    existingEntry: entry,
    item: { localSku: "monthly_5" },
    retrieveInvoice: async () => extras.live ?? paidInvoice(),
    syncFn,
    claimAlreadyAcquired: extras.claimAlreadyAcquired === true,
    lostClaim: extras.lostClaim === true,
    nowMs: extras.nowMs,
    confirmNoMindbodySale: extras.confirmNoMindbodySale === true,
  });
}

check("failed then paid is retryable", monthlyInvoicePaidAction(failedEntry()) === "verify_paid_then_sync");
check("synced is a no-op", monthlyInvoicePaidAction({ status: "synced" }) === "noop_synced");
check("uncertain does not check out again", monthlyInvoicePaidAction({ status: "mindbody_sale_uncertain" }) === "resume_without_checkout");

{
  const report = buildMonthlyReconcileReport({ entry: failedEntry(), liveInvoice: paidInvoice() });
  check("dry run plans one checkout", report.plan === "checkout_once" && report.wouldCheckout === true);
  check("dry run does not charge or backdate", report.wouldChargeAgain === false && report.wouldBackdate === false && report.wouldCallUpdateClientService === false);
  check("dry run lets Mindbody date the sale", report.mindbodyAssignsDatesFromSale === true && report.overlappingPackagesAllowed === true);
}

{
  const store = memoryStore();
  await store.put(baseRecord([failedEntry()]));
  let carts = 0;
  const outcome = await runSync(store, baseRecord([failedEntry()]), failedEntry(), async () => {
    carts += 1;
    return { ok: true, mindbodySaleId: "40001", mindbodyClientServiceId: "50001" };
  }, { claimAlreadyAcquired: true, nowMs: Date.parse("2026-10-19T12:00:00Z") });
  const saved = await store.get("sub_amare_BRITTESTMONTHLY01");
  const row = saved.invoices.find((e) => e.invoiceId === "in_1UKFqXA47S4kb7VHieCxhwV6");
  check("delayed payment issues one sale", outcome.status === "synced" && carts === 1 && row.mindbodySaleId === "40001");
  check("delayed payment stores the paid amount", row.amountPaidCents === 12500 && row.status === "synced");
  check("delayed payment does not store a backdated window", !row.serviceActiveDate && !row.serviceExpirationDate);
}

{
  const store = memoryStore();
  const synced = { ...failedEntry(), status: "synced", amountPaidCents: 12500, mindbodySaleId: "36586" };
  await store.put(baseRecord([synced]));
  let carts = 0;
  const outcome = await runSync(store, baseRecord([synced]), synced, async () => {
    carts += 1;
    return { ok: true, mindbodySaleId: "99999" };
  });
  check("duplicate webhook does not sell again", outcome.noop === true && carts === 0);
}

{
  const store = memoryStore();
  await store.put(baseRecord([failedEntry()]));
  let carts = 0;
  const first = await runSync(store, baseRecord([failedEntry()]), failedEntry(), async () => {
    carts += 1;
    return { ok: false, reason: "mindbody_sync_timeout" };
  }, { claimAlreadyAcquired: true });
  const after = await store.get("sub_amare_BRITTESTMONTHLY01");
  const uncertain = after.invoices.find((e) => e.invoiceId === "in_1UKFqXA47S4kb7VHieCxhwV6");
  const second = await runSync(store, after, uncertain, async () => {
    carts += 1;
    return { ok: true, mindbodySaleId: "should-not-sell" };
  }, { claimAlreadyAcquired: true });
  check("timeout stays uncertain", first.status === "mindbody_sale_uncertain" && uncertain.checkoutRequestSentAt);
  check("uncertain recovery does not check out again", second.status === "mindbody_sale_uncertain" && carts === 1);
}

{
  const store = memoryStore();
  await store.put(baseRecord([failedEntry()]));
  let carts = 0;
  const first = await runSync(store, baseRecord([failedEntry()]), failedEntry(), async () => {
    carts += 1;
    return { ok: true, mindbodySaleId: null };
  }, { claimAlreadyAcquired: true });
  const after = await store.get("sub_amare_BRITTESTMONTHLY01");
  const row = after.invoices.find((e) => e.invoiceId === "in_1UKFqXA47S4kb7VHieCxhwV6");
  const second = await runSync(store, after, row, async () => {
    carts += 1;
    return { ok: true, mindbodySaleId: "second" };
  }, { claimAlreadyAcquired: true });
  check("missing sale id blocks a second cart", first.status === "mindbody_sale_uncertain" && second.status === "mindbody_sale_uncertain" && carts === 1);
}

{
  const store = memoryStore();
  const withSale = { ...failedEntry(), status: "mindbody_sale_uncertain", mindbodySaleId: "40002", amountPaidCents: 12500 };
  await store.put(baseRecord([withSale]));
  let carts = 0;
  const outcome = await runSync(store, baseRecord([withSale]), withSale, async () => {
    carts += 1;
    return { ok: true, mindbodySaleId: "nope" };
  }, { claimAlreadyAcquired: true });
  const saved = await store.get("sub_amare_BRITTESTMONTHLY01");
  const row = saved.invoices.find((e) => e.invoiceId === "in_1UKFqXA47S4kb7VHieCxhwV6");
  check("known sale completes without another cart", outcome.status === "synced" && outcome.linkedExisting === true && carts === 0 && row.mindbodySaleId === "40002");
}

{
  const store = memoryStore();
  await store.put(baseRecord([]));
  let carts = 0;
  const [a, b] = await Promise.all([
    runSync(store, baseRecord([]), null, async () => {
      carts += 1;
      return { ok: true, mindbodySaleId: "race" };
    }),
    runSync(store, baseRecord([]), null, async () => {
      carts += 1;
      return { ok: true, mindbodySaleId: "race-2" };
    }),
  ]);
  const saved = await store.get("sub_amare_BRITTESTMONTHLY01");
  const sales = (saved.invoices || []).filter((e) => e.mindbodySaleId);
  check("concurrent webhooks check out once", carts === 1 && sales.length === 1 && [a.status, b.status].includes("synced"));
}

{
  const store = memoryStore();
  await store.put(baseRecord([failedEntry()]));
  let carts = 0;
  const outcome = await runSync(store, baseRecord([failedEntry()]), failedEntry(), async () => {
    carts += 1;
    return { ok: true, mindbodySaleId: "should-not" };
  }, { live: paidInvoice({ status: "open", amount_paid: 0 }), claimAlreadyAcquired: true });
  check("unpaid invoice does not sell", outcome.noop === true && carts === 0 && outcome.reason === "stripe_invoice_not_paid");
}

{
  const store = memoryStore();
  await store.put(baseRecord([failedEntry()]));
  let carts = 0;
  const outcome = await runSync(store, baseRecord([failedEntry()]), failedEntry(), async () => {
    carts += 1;
    return { ok: false, reason: "staff_headers_unavailable" };
  }, { claimAlreadyAcquired: true });
  const saved = await store.get("sub_amare_BRITTESTMONTHLY01");
  const row = saved.invoices.find((e) => e.invoiceId === "in_1UKFqXA47S4kb7VHieCxhwV6");
  check("pre-request failure releases the retry", outcome.retryable === true && carts === 1 && row.status === "skipped_payment_failed" && !row.checkoutRequestSentAt);
}

{
  const store = memoryStore();
  await store.put(baseRecord([]));
  let carts = 0;
  const outcome = await runSync(store, baseRecord([]), null, async () => {
    carts += 1;
    return { ok: true, mindbodySaleId: "normal" };
  }, { claimAlreadyAcquired: true });
  check("normal renewal checks out once", outcome.status === "synced" && carts === 1 && outcome.mindbodySaleId === "normal");
}

{
  const store = memoryStore();
  await store.put(baseRecord([failedEntry()]));
  let carts = 0;
  const outcome = await runSync(store, baseRecord([failedEntry()]), failedEntry(), async () => {
    carts += 1;
    return { ok: true, mindbodySaleId: "overlap-ok" };
  }, { claimAlreadyAcquired: true });
  check("an existing package does not block the new sale", outcome.status === "synced" && carts === 1);
}

{
  const webhook = fs.readFileSync(new URL("../netlify/functions/stripe-webhook.mjs", import.meta.url), "utf8");
  const paid = webhook.slice(webhook.indexOf("async function handleInvoicePaid"));
  check(
    "annual invoice.paid stays ahead of monthly",
    paid.indexOf("handleAnnualInvoicePaid") >= 0 && paid.indexOf("handleAnnualInvoicePaid") < paid.indexOf("runMonthlyPeriodSync"),
  );
  const annualItem = getCatalogItem("annual_monthly_5");
  check("annual catalog is not a monthly sku", annualItem && isAnnualMembershipCatalogItem(annualItem));
  const onetime = fs.readFileSync(new URL("../netlify/functions/stripe-onetime-fulfillment.mjs", import.meta.url), "utf8");
  check("one-time packs do not call monthly renewal sync", !onetime.includes("executeMonthlyRenewalSync"));
  const monthlySrc = fs.readFileSync(new URL("../netlify/functions/stripe-monthly-period-sync.mjs", import.meta.url), "utf8");
  check("phase 1 does not post a service-date update", !monthlySrc.includes("/client/updateclientservice"));
}

{
  const bookSrc = fs.readFileSync(new URL("../netlify/functions/mindbody-class-book-lib.mjs", import.meta.url), "utf8");
  const listFn = bookSrc.slice(bookSrc.indexOf("export async function listActiveClientServiceIds"), bookSrc.indexOf("export async function listBookableClientServiceIds"));
  check("booking still sorts by highest remaining", listFn.includes("out.sort((a, b) => b.remaining - a.remaining)"));
  check("booking list does not sort by expiration", !listFn.includes("ExpirationDate") || !listFn.includes(".sort(") || listFn.indexOf(".sort(") > listFn.lastIndexOf("ExpirationDate"));

  const older = { id: 32666, remaining: 2, expiration: "2026-10-27" };
  const newer = { id: 50001, remaining: 5, expiration: "2026-11-19" };
  const currentOrder = [older, newer].slice().sort((a, b) => b.remaining - a.remaining).map((row) => row.id);
  const proposedOrder = [older, newer].slice().sort((a, b) => a.expiration.localeCompare(b.expiration)).map((row) => row.id);
  check("current order spends the fuller package first", currentOrder[0] === 50001);
  check("expire-first would spend the older package first", proposedOrder[0] === 32666 && proposedOrder[0] !== currentOrder[0]);

  const picked = resolveIntendedBookClientServiceId(null, currentOrder, new Set(), { unlimitedQuotaConsumed: 0 });
  check("staff auto-pick follows that same order", picked === 50001);
  const explicit = resolveIntendedBookClientServiceId(32666, currentOrder, new Set(), { unlimitedQuotaConsumed: 0 });
  check("an explicit service id still wins", explicit === 32666);

  const cycle = selectCurrentMonthlyCycleRow(
    [
      { Id: 32666, ProductId: 100133, ActiveDate: "2026-10-02T00:00:00", ExpirationDate: "2026-11-02T00:00:00", Remaining: 2 },
      { Id: 50001, ProductId: 100133, ActiveDate: "2026-10-19T00:00:00", ExpirationDate: "2026-11-19T00:00:00", Remaining: 5 },
    ],
    "2026-10-20",
  );
  check("top-up cycle still prefers the later expiration", cycle && Number(cycle.Id) === 50001);
}

{
  const store = memoryStore();
  await store.put(baseRecord([failedEntry()]));
  const denied = await adminHandler({
    httpMethod: "POST",
    path: "/api/stripe/admin/subscriptions/retry-sync",
    headers: {},
    body: JSON.stringify({ subscriptionId: "sub_amare_BRITTESTMONTHLY01", invoiceId: "in_1UKFqXA47S4kb7VHieCxhwV6" }),
  });
  check("admin retry without token is 401", denied.statusCode === 401);

  const dry = await adminHandler({
    httpMethod: "POST",
    path: "/api/stripe/admin/subscriptions/reconcile",
    headers: { "x-admin-token": process.env.ADMIN_DEBUG_TOKEN },
    body: JSON.stringify({
      subscriptionId: "sub_amare_BRITTESTMONTHLY01",
      invoiceId: "in_1UKFqXA47S4kb7VHieCxhwV6",
      liveInvoice: paidInvoice(),
    }),
  });
  const dryBody = JSON.parse(dry.body);
  check("admin reconcile writes nothing", dry.statusCode === 200 && dryBody.writes === 0 && dryBody.report.wouldCheckout === true && dryBody.report.wouldCallUpdateClientService === false);

  const paidBody = {
    subscriptionId: "sub_amare_BRITTESTMONTHLY01",
    invoiceId: "in_1UKFqXA47S4kb7VHieCxhwV6",
    liveInvoice: paidInvoice(),
    simulatedCheckout: { ok: true, mindbodySaleId: "40010", mindbodyClientServiceId: "50010" },
  };
  const retried = await adminHandler({
    httpMethod: "POST",
    path: "/api/stripe/admin/subscriptions/retry-sync",
    headers: { "x-admin-token": process.env.ADMIN_DEBUG_TOKEN },
    body: JSON.stringify(paidBody),
  });
  const retriedBody = JSON.parse(retried.body);
  const afterRetry = await store.get("sub_amare_BRITTESTMONTHLY01");
  const syncedRow = afterRetry.invoices.find((e) => e.invoiceId === "in_1UKFqXA47S4kb7VHieCxhwV6");
  check(
    "admin retry recovers skipped_payment_failed after paid verification",
    retried.statusCode === 200 && retriedBody.status === "synced" && retriedBody.mbSaleId === "40010" && syncedRow.status === "synced" && syncedRow.amountPaidCents === 12500,
  );
  check("admin retry marks the subscription active", afterRetry.status === "active");

  const again = await adminHandler({
    httpMethod: "POST",
    path: "/api/stripe/admin/subscriptions/retry-sync",
    headers: { "x-admin-token": process.env.ADMIN_DEBUG_TOKEN },
    body: JSON.stringify(paidBody),
  });
  const againBody = JSON.parse(again.body);
  const afterAgain = await store.get("sub_amare_BRITTESTMONTHLY01");
  const still = afterAgain.invoices.find((e) => e.invoiceId === "in_1UKFqXA47S4kb7VHieCxhwV6");
  check("second admin retry does not sell again", again.statusCode === 409 && againBody.error === "already_synced" && still.mindbodySaleId === "40010");

  const unpaidStore = memoryStore();
  await unpaidStore.put(baseRecord([failedEntry()]));
  const unpaid = await adminHandler({
    httpMethod: "POST",
    path: "/api/stripe/admin/subscriptions/retry-sync",
    headers: { "x-admin-token": process.env.ADMIN_DEBUG_TOKEN },
    body: JSON.stringify({
      subscriptionId: "sub_amare_BRITTESTMONTHLY01",
      invoiceId: "in_1UKFqXA47S4kb7VHieCxhwV6",
      liveInvoice: paidInvoice({ status: "open", amount_paid: 0 }),
      simulatedCheckout: { ok: true, mindbodySaleId: "should-not" },
    }),
  });
  const unpaidBody = JSON.parse(unpaid.body);
  const unpaidRow = (await unpaidStore.get("sub_amare_BRITTESTMONTHLY01")).invoices[0];
  check(
    "admin retry refuses an unpaid invoice",
    unpaid.statusCode === 409 && unpaidBody.status !== "synced" && unpaidRow.status === "skipped_payment_failed" && !unpaidRow.mindbodySaleId,
  );

  const uncertainStore = memoryStore();
  await uncertainStore.put(baseRecord([failedEntry()]));
  const timedOut = await adminHandler({
    httpMethod: "POST",
    path: "/api/stripe/admin/subscriptions/retry-sync",
    headers: { "x-admin-token": process.env.ADMIN_DEBUG_TOKEN },
    body: JSON.stringify({
      subscriptionId: "sub_amare_BRITTESTMONTHLY01",
      invoiceId: "in_1UKFqXA47S4kb7VHieCxhwV6",
      liveInvoice: paidInvoice(),
      simulatedCheckout: { ok: false, reason: "mindbody_sync_timeout" },
    }),
  });
  const secondSale = await adminHandler({
    httpMethod: "POST",
    path: "/api/stripe/admin/subscriptions/retry-sync",
    headers: { "x-admin-token": process.env.ADMIN_DEBUG_TOKEN },
    body: JSON.stringify({
      subscriptionId: "sub_amare_BRITTESTMONTHLY01",
      invoiceId: "in_1UKFqXA47S4kb7VHieCxhwV6",
      liveInvoice: paidInvoice(),
      simulatedCheckout: { ok: true, mindbodySaleId: "second-sale" },
    }),
  });
  const uncertainRow = (await uncertainStore.get("sub_amare_BRITTESTMONTHLY01")).invoices[0];
  check(
    "admin retry after an uncertain checkout does not sell again",
    timedOut.statusCode === 409 && secondSale.statusCode === 409 && uncertainRow.status === "mindbody_sale_uncertain" && !uncertainRow.mindbodySaleId,
  );
}

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nMonthly renewal phase 1 checks passed");
