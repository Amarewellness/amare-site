/**
 * V1 Test 18 — forge a `invoice.paid` webhook event for a NEW invoice that
 * "belongs" to a subscription we already canceled, and POST it to the local
 * webhook endpoint. The handler MUST refuse to call Mindbody and append a
 * `skipped_subscription_canceled` entry to `record.invoices[]`.
 *
 * This simulates the worst-case race: a real, paid Stripe invoice that wasn't
 * yet recorded locally, whose `invoice.paid` event arrives AFTER we've already
 * processed `customer.subscription.deleted`.
 *
 * Usage:
 *   node scripts/test18-forge-late-invoice-paid.mjs <stripeSubId> <fakeInvoiceId>
 */
import crypto from "node:crypto";
import process from "node:process";
import fs from "node:fs";
import path from "node:path";

/** Lightweight .env loader so we don't need `dotenv` for a single throwaway script. */
function loadDotEnv() {
  try {
    const envPath = path.resolve(process.cwd(), ".env");
    const raw = fs.readFileSync(envPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {
    /* ignore */
  }
}
loadDotEnv();

const stripeSubId = process.argv[2];
const fakeInvoiceId = process.argv[3] || `in_FAKE_TEST18_LATE_${Date.now()}`;
if (!stripeSubId) {
  console.error("usage: node scripts/test18-forge-late-invoice-paid.mjs <stripeSubId> [fakeInvoiceId]");
  process.exit(1);
}

const secret = process.env.STRIPE_WEBHOOK_SECRET;
if (!secret) {
  console.error("STRIPE_WEBHOOK_SECRET not set in environment.");
  process.exit(1);
}

const nowSec = Math.floor(Date.now() / 1000);
const nowMs = Date.now();

/**
 * Minimal but valid-shape `Stripe.Event` for `invoice.paid`. We include both the
 * legacy `invoice.subscription` field (for older API versions) AND the new
 * `invoice.parent.subscription_details.subscription` shape (Stripe 2026-04-22.dahlia)
 * so the `extractInvoiceSubscriptionId` helper resolves the sub regardless of which
 * shape the local code reads first.
 */
const payload = {
  id: `evt_FAKE_TEST18_${nowMs}`,
  object: "event",
  api_version: "2026-04-22.dahlia",
  created: nowSec,
  livemode: false,
  pending_webhooks: 1,
  type: "invoice.paid",
  data: {
    object: {
      id: fakeInvoiceId,
      object: "invoice",
      amount_due: 12500,
      amount_paid: 12500,
      amount_remaining: 0,
      currency: "usd",
      customer: "cus_UW3VQ3iwdC9ZQC",
      livemode: false,
      paid: true,
      status: "paid",
      subscription: stripeSubId,
      parent: {
        type: "subscription_details",
        subscription_details: {
          subscription: stripeSubId,
          metadata: {
            flow: "stripe_recurring_subscription",
            localSku: "monthly_5",
            mindbodyClientId: "100002749",
            mindbodyServiceId: "100133",
            source: "amare_membership_checkout",
          },
        },
      },
      payment_intent: `pi_FAKE_TEST18_${nowMs}`,
      status_transitions: { paid_at: nowSec },
    },
  },
};

const body = JSON.stringify(payload);
const signedPayload = `${nowSec}.${body}`;
const signature = crypto.createHmac("sha256", secret).update(signedPayload, "utf8").digest("hex");
const stripeSignatureHeader = `t=${nowSec},v1=${signature}`;

const url = "http://127.0.0.1:4321/api/stripe/webhook";
console.log(`POST ${url}`);
console.log(`  evt.id           = ${payload.id}`);
console.log(`  invoice.id       = ${fakeInvoiceId}`);
console.log(`  subscription     = ${stripeSubId}`);

const res = await fetch(url, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Stripe-Signature": stripeSignatureHeader,
  },
  body,
});

const text = await res.text();
console.log(`  → HTTP ${res.status}`);
console.log(`  body: ${text}`);
