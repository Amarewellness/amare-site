/**
 * Forge a synthetic `invoice.paid` webhook event for an existing **active** subscription
 * to simulate Stripe's monthly renewal billing — without waiting an actual month.
 *
 * Two coupon scenarios:
 *   • No flags                                   → full-price renewal (good for verifying
 *                                                  `duration: once` coupons drop off on
 *                                                  the second invoice).
 *   • --discount=<cents> [--coupon=<id>] [--code=<promotion_code>] → renewal with discount
 *                                                  (verifies `duration: forever` coupons
 *                                                  keep applying on every invoice).
 *
 * The forged invoice carries the SAME `subtotal` as the catalog price ($125 = 12500),
 * `total_discount_amounts` populated when --discount is given, and a `discounts[]` array
 * with the expanded coupon/promotion_code so `extractInvoiceDiscountSnapshot` can pick
 * up the audit identity without an extra round-trip.
 *
 * Usage:
 *   node scripts/test-forge-renewal-invoice.mjs --stripeSub=sub_... --customer=cus_... \
 *        [--mindbodyClientId=100002749] [--sku=monthly_5] [--invoice=in_RENEWAL_<n>] \
 *        [--discount=2000 --coupon=SAVE20MO --code=SAVE20MO]
 *
 * Both forms expect the local subscription to be `active` and webhook secret to match
 * the dev server's STRIPE_WEBHOOK_SECRET (the unsigned ngrok endpoint will refuse).
 */
import crypto from "node:crypto";
import process from "node:process";
import fs from "node:fs";
import path from "node:path";

/** Lightweight .env loader (avoid dotenv dependency for a one-shot script). */
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

/**
 * Tiny `--key=value` parser. We don't want yargs/commander for a single throwaway script
 * and we keep argv parsing visible at the top of the file so the failure modes are obvious
 * (typo in flag name → undefined → falls back to default).
 */
function parseArgs() {
  /** @type {Record<string, string>} */
  const out = {};
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
const args = parseArgs();

const stripeSubId = args.stripeSub || "";
const customerId = args.customer || "";
const mindbodyClientId = args.mindbodyClientId || "100002749";
const localSku = args.sku || "monthly_5";
const mindbodyServiceId =
  localSku === "monthly_5" ? "100133" : localSku === "monthly_8" ? "100134" : "100135";
const subtotalCents = Number(args.subtotal || "12500");
const discountCents = Number(args.discount || "0");
const couponId = args.coupon || "";
const promotionCodeText = args.code || "";
const fakeInvoiceId = args.invoice || `in_RENEWAL_FAKE_${Date.now()}`;

if (!stripeSubId || !customerId) {
  console.error(
    "usage: node scripts/test-forge-renewal-invoice.mjs --stripeSub=sub_... --customer=cus_... [--discount=cents --coupon=ID --code=CODE]",
  );
  process.exit(1);
}

const secret = process.env.STRIPE_WEBHOOK_SECRET;
if (!secret) {
  console.error("STRIPE_WEBHOOK_SECRET not set in environment.");
  process.exit(1);
}

const nowSec = Math.floor(Date.now() / 1000);
const nowMs = Date.now();
const amountPaidCents = Math.max(0, subtotalCents - discountCents);

/**
 * Build the `discounts[]` and `total_discount_amounts[]` arrays only when a discount was
 * requested. Empty arrays for the no-discount renewal — exactly what Stripe sends when a
 * `duration: once` coupon expired after the first invoice.
 */
const totalDiscountAmounts = discountCents > 0 ? [{ amount: discountCents, discount: "di_FORGED" }] : [];
const discountsArr =
  discountCents > 0
    ? [
        {
          id: "di_FORGED",
          object: "discount",
          coupon: couponId
            ? {
                id: couponId,
                object: "coupon",
                valid: true,
                duration: "forever",
              }
            : null,
          promotion_code: promotionCodeText
            ? {
                id: `promo_FORGED_${nowMs}`,
                object: "promotion_code",
                code: promotionCodeText,
                coupon: couponId
                  ? { id: couponId, object: "coupon", valid: true, duration: "forever" }
                  : null,
              }
            : null,
        },
      ]
    : [];

const payload = {
  id: `evt_FORGED_RENEWAL_${nowMs}`,
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
      amount_due: amountPaidCents,
      amount_paid: amountPaidCents,
      amount_remaining: 0,
      subtotal: subtotalCents,
      tax: 0,
      total: amountPaidCents,
      currency: "usd",
      customer: customerId,
      livemode: false,
      paid: true,
      status: "paid",
      /** Both shapes (legacy + dahlia) so `extractInvoiceSubscriptionId` always resolves. */
      subscription: stripeSubId,
      parent: {
        type: "subscription_details",
        subscription_details: {
          subscription: stripeSubId,
          metadata: {
            flow: "stripe_recurring_subscription",
            localSku,
            mindbodyClientId,
            mindbodyServiceId,
            source: "amare_membership_checkout",
          },
        },
      },
      payment_intent: `pi_FORGED_${nowMs}`,
      status_transitions: { paid_at: nowSec },
      total_discount_amounts: totalDiscountAmounts,
      discounts: discountsArr,
    },
  },
};

const body = JSON.stringify(payload);
const signedPayload = `${nowSec}.${body}`;
const signature = crypto.createHmac("sha256", secret).update(signedPayload, "utf8").digest("hex");
const stripeSignatureHeader = `t=${nowSec},v1=${signature}`;

const url = "http://127.0.0.1:4321/api/stripe/webhook";
console.log(`POST ${url}`);
console.log(`  evt.id            = ${payload.id}`);
console.log(`  invoice.id        = ${fakeInvoiceId}`);
console.log(`  subscription      = ${stripeSubId}`);
console.log(`  customer          = ${customerId}`);
console.log(`  subtotalCents     = ${subtotalCents}`);
console.log(`  discountCents     = ${discountCents}${couponId ? ` (${promotionCodeText || couponId})` : ""}`);
console.log(`  amountPaidCents   = ${amountPaidCents}`);

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
