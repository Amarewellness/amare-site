/**
 * Recurring claimInvoiceSlot concurrency regression.
 * Run: node scripts/qa-stripe-invoice-claim-race.mjs
 *
 * The 2026-08-17 QA Drop-In double was one-time only. invoice.paid was already
 * protected by this claim. This test must stay PASS.
 */
process.env.NETLIFY = "";
process.env.STRIPE_SUBSCRIPTION_STORE_LOCAL_MEMORY = "1";

const {
  openSubscriptionStore,
  resetSubscriptionStoreMemoryForTests,
} = await import("../netlify/functions/stripe-subscription-store.mjs");

let failed = 0;
function check(name, ok, detail) {
  if (ok) console.log(`PASS — ${name}`);
  else {
    failed += 1;
    console.error(`FAIL — ${name}${detail ? ` (${detail})` : ""}`);
  }
}

resetSubscriptionStoreMemoryForTests();
const store = openSubscriptionStore();
const subscriptionId = "sub_amare_CLAIMRACE0000000001";
const invoiceId = "in_claimrace0001";

const results = await Promise.all(
  Array.from({ length: 8 }, () => store.claimInvoiceSlot(subscriptionId, invoiceId, { sourceEventId: "evt_invoice_paid" })),
);

const acquired = results.filter((r) => r.ok && r.acquired === true);
const lost = results.filter((r) => r.ok && r.acquired === false);
check("claimInvoiceSlot: all calls ok", results.every((r) => r.ok === true));
check("claimInvoiceSlot: exactly one winner", acquired.length === 1, `winners=${acquired.length}`);
check("claimInvoiceSlot: losers dedup", lost.length === 7, `lost=${lost.length}`);

const again = await store.claimInvoiceSlot(subscriptionId, invoiceId, { sourceEventId: "evt_invoice_paid_redeliver" });
check("claimInvoiceSlot: redelivery does not re-acquire", again.ok === true && again.acquired === false);

const otherInvoice = await store.claimInvoiceSlot(subscriptionId, "in_claimrace0002", {});
check("claimInvoiceSlot: different invoice can claim", otherInvoice.ok === true && otherInvoice.acquired === true);

if (failed) {
  console.error(`\n${failed} invoice claim race check(s) failed`);
  process.exit(1);
}
console.log("\nRecurring claimInvoiceSlot race QA passed");
