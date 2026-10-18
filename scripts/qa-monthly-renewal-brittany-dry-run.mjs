/**
 * READ-ONLY recovery plan for Brittany Chirinos.
 * Does not call Mindbody, Stripe, or write blobs.
 *
 * node scripts/qa-monthly-renewal-brittany-dry-run.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getStore } from "@netlify/blobs";
import { buildMonthlyReconcileReport } from "../netlify/functions/stripe-monthly-period-sync.mjs";

const SITE_ID = "f315d80d-f61e-4fef-9a06-68bb09192d56";
const SUBSCRIPTION_ID = "sub_amare_D6PXHGVY8P0JFBZ1";
const INVOICE_ID = "in_1UKFqXA47S4kb7VHieCxhwV6";
function netlifyToken() {
  const configPath = path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "netlify", "Config", "config.json");
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    for (const user of Object.values(cfg.users || {})) {
      const token = String(user?.auth?.token || "").trim();
      if (token) return token;
    }
  } catch {
    return "";
  }
  return "";
}

const knownEntry = {
  invoiceId: INVOICE_ID,
  status: "skipped_payment_failed",
  amountPaidCents: 0,
  currency: "usd",
  paidAt: "2026-09-27T12:03:37.569Z",
  mindbodySaleId: null,
  mindbodyClientServiceId: null,
  checkoutRequestSentAt: null,
  lastError: "stripe_invoice_payment_failed",
};

let entry = knownEntry;
let recordSource = "investigation snapshot 2026-10-18";
const token = netlifyToken();
if (token) {
  try {
    const store = getStore({
      name: "stripe-mindbody-subscriptions",
      siteID: SITE_ID,
      token,
      consistency: "strong",
    });
    const rec = await store.get(`v1/${SUBSCRIPTION_ID}`, { type: "json" });
    const live = (rec?.invoices || []).find((row) => row && row.invoiceId === INVOICE_ID);
    if (live) {
      entry = live;
      recordSource = "production blob read";
    }
  } catch (err) {
    recordSource = `investigation snapshot; blob read failed: ${String(err?.message || err).slice(0, 120)}`;
  }
}

/**
 * Not a live Stripe retrieve. Production env:get masks the secret key.
 * Paid status here matches the dashboard screenshot from 2026-10-18:
 * invoice AX5FJV35-0002, $125, PaymentIntent pi_3UKGnjA47S4kb7VH16bk5wwE, paid 2026-10-02.
 */
const liveInvoice = {
  id: INVOICE_ID,
  number: "AX5FJV35-0002",
  status: "paid",
  amount_paid: 12500,
  currency: "usd",
  billing_reason: "subscription_cycle",
  status_transitions: { paid_at: Math.floor(Date.parse("2026-10-02T18:03:45Z") / 1000) },
};

const report = buildMonthlyReconcileReport({
  entry,
  liveInvoice,
  claimHeldWithoutOwner: false,
});

console.log(
  JSON.stringify(
    {
      dryRun: true,
      writes: 0,
      clientId: 100003846,
      subscriptionId: SUBSCRIPTION_ID,
      stripeSubscriptionId: "sub_1U914WA47S4kb7VHwdu6KA1B",
      invoiceId: INVOICE_ID,
      paymentIntentId: "pi_3UKGnjA47S4kb7VH16bk5wwE",
      recordSource,
      storedInvoiceStatus: entry.status,
      storedAmountPaidCents: entry.amountPaidCents,
      storedSaleId: entry.mindbodySaleId || null,
      checkoutRequestSentAt: entry.checkoutRequestSentAt || null,
      stripePaidConfirmedByApi: false,
      stripePaidSource: "dashboard screenshot, not invoices.retrieve",
      existingPackage: {
        saleId: 36586,
        clientServiceId: 32666,
        productId: 100133,
        activeDate: "2026-08-27",
        expirationDate: "2026-09-27",
        remaining: 0,
        usableNow: false,
      },
      report,
      steps: [
        "Before any sale, retrieve Stripe invoice in_1UKFqXA47S4kb7VHieCxhwV6 and require status paid and amount_paid 12500. This dry run did not do that retrieve.",
        "Leave the Stripe subscription on its current cycle. Do not create an invoice and do not charge again.",
        "If a Mindbody sale already exists for order id sub_amare_D6PXHGVY8P0JFBZ1_in_1UKFqXA47S4kb7VHieCxhwV6, attach that sale id and stop.",
        "Otherwise one CheckoutShoppingCart for product 100133, $125 already paid, using the existing cart. Mindbody sets activation and expiration from the sale date.",
        "Store the sale id and mark the invoice synced. If the checkout result is uncertain, do not post a second cart.",
      ],
      booking: {
        changed: false,
        brittanyOverlap: "August service 32666 expired 2026-09-27 with 0 remaining. A sale now does not overlap a usable package for this client.",
        generalRisk: "If two monthly packages are both eligible, class booking tries the one with more visits left first. The earlier package can expire with credits unused. Proposed later: among services valid for the class date, try the soonest expiration first. Not applied.",
      },
      doNot: [
        "Do not execute this plan.",
        "Do not refund pi_3UKGnjA47S4kb7VH16bk5wwE.",
        "Do not alter sale 36586 or service 32666.",
        "Do not call updateclientservice.",
      ],
    },
    null,
    2,
  ),
);
