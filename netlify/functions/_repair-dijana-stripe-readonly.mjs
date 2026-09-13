import Stripe from "stripe";
import { extractAnnualTermFromInvoice } from "./annual-membership-webhook-lib.mjs";
import { getAnnualSkuDefinition } from "./annual-membership-lib.mjs";

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(body),
  };
}

function adminAuthorized(event) {
  const expected = (process.env.ADMIN_DEBUG_TOKEN || "").trim();
  if (!expected) return false;
  const headers = event.headers || {};
  const provided = String(headers["x-admin-token"] || headers["X-Admin-Token"] || "").trim();
  return provided === expected;
}

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: { "Cache-Control": "no-store" }, body: "" };
  }
  if (event.httpMethod !== "GET") {
    return json(405, { ok: false, error: "method_not_allowed" });
  }
  if (!adminAuthorized(event)) {
    return json(401, { ok: false, error: "unauthorized" });
  }

  const sk = (process.env.STRIPE_SECRET_KEY || "").trim();
  if (!sk.startsWith("sk_live_")) {
    return json(503, { ok: false, error: "missing_live_stripe_secret" });
  }

  const stripe = new Stripe(sk, { apiVersion: "2025-08-27.basil", timeout: 30000 });
  const PI = "pi_3UDlpIA47S4kb7VH16oaj5Hj";
  const CS = "cs_live_a1vKDWsY4B8V86x0E2RIh6UWqp6OaWDV5oF3fiqFkf0f69KFgeS3FwJGYy";
  const SUB = "sub_1UDlpMA47S4kb7VHDwUbR2Bb";
  const CUS = "cus_V6RX6IvJhHTZq7";

  const [pi, cs, sub] = await Promise.all([
    stripe.paymentIntents.retrieve(PI),
    stripe.checkout.sessions.retrieve(CS, { expand: ["line_items.data.price"] }),
    stripe.subscriptions.retrieve(SUB, { expand: ["latest_invoice.lines.data.price", "items.data.price"] }),
  ]);

  let invoice =
    typeof sub.latest_invoice === "object" && sub.latest_invoice ? sub.latest_invoice : null;
  if (!invoice) {
    const invoiceId = typeof sub.latest_invoice === "string" ? sub.latest_invoice : null;
    if (!invoiceId) return json(404, { ok: false, error: "missing_latest_invoice" });
    invoice = await stripe.invoices.retrieve(invoiceId, { expand: ["lines.data.price"] });
  }

  if (String(pi.customer) !== CUS || String(cs.customer) !== CUS) {
    return json(400, { ok: false, error: "customer_mismatch" });
  }
  if (invoice.status !== "paid") {
    return json(400, { ok: false, error: "invoice_not_paid", status: invoice.status });
  }

  const localSku =
    cs.metadata?.localSku ||
    sub.metadata?.localSku ||
    invoice.lines?.data?.[0]?.price?.metadata?.localSku ||
    null;
  if (localSku !== "annual_monthly_unlimited") {
    return json(400, { ok: false, error: "unexpected_sku", localSku });
  }

  const term = extractAnnualTermFromInvoice(invoice);
  const pricing = getAnnualSkuDefinition("annual_monthly_unlimited");

  return json(200, {
    ok: true,
    stripeSubscriptionId: sub.id,
    subscriptionStatus: sub.status,
    stripeInvoiceId: invoice.id,
    stripeCustomerId: CUS,
    stripePriceId: invoice.lines?.data?.[0]?.price?.id || sub.items?.data?.[0]?.price?.id || null,
    paymentIntentId: pi.id,
    checkoutSessionId: cs.id,
    localSku,
    annualAmountCents: pricing.annualTotalCents,
    amountPaidCents: invoice.amount_paid,
    termStartDate: term.termStartDate,
    termEndDate: term.termEndDate,
    stripePeriodStartAt: term.stripePeriodStartAt,
    stripePeriodEndAt: term.stripePeriodEndAt,
  });
}
