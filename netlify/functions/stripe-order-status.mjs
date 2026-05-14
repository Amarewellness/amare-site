/**
 * GET /api/stripe/order-status?orderId=…  (or ?session_id=…)
 *
 * Read-only safe summary of an order for the customer-facing /checkout/success page.
 * Never fulfills, never exposes secrets, never reveals more than the customer needs.
 *
 * Handles both:
 *   • One-time purchases — looked up in the OrderRecord store.
 *   • Recurring memberships (Stripe Subscription) — looked up in the SubscriptionRecord
 *     store when the orderId is not found AND the session_id matches a subscription
 *     checkout. Returns `kind: "subscription"` so the success page renders membership
 *     copy and waits for `invoice.paid` → Mindbody sync to flip the status to active.
 */

import { jsonResponse } from "./mindbody-consumer-lib.mjs";
import { getCatalogItem } from "./stripe-catalog-lib.mjs";
import { openOrderStore } from "./stripe-order-store.mjs";
import { openSubscriptionStore } from "./stripe-subscription-store.mjs";

const TERMINAL_OK = new Set(["mindbody_synced"]);
const TERMINAL_PENDING = new Set([
  "checkout_created",
  "payment_completed",
  "client_resolving",
  "client_created",
  "client_found",
  "mindbody_checkout_started",
  "sync_failed_retryable",
]);
const TERMINAL_MANUAL = new Set([
  "paid_but_not_synced",
  "sync_failed_manual_review",
  "manual_review",
]);
const TERMINAL_CANCELED = new Set(["canceled"]);
const TERMINAL_TEST_MODE = new Set(["test_mode_no_sync"]);

/**
 * Mask an email address for display on the customer-facing success page. The buyer just typed
 * their address into Stripe, so it's "their own" address — not a privacy leak per se — but we
 * mask it anyway so a screenshot or shared screen doesn't leak the full address. Two real
 * characters of the local-part stay visible so the customer recognises which inbox to check.
 *
 * Examples:
 *   "snir@example.com"      → "sn**@example.com"
 *   "a@example.com"         → "a***@example.com"
 *   "verylongname@host.io"  → "ve**********@host.io"
 *   not-an-email            → ""  (defensive — never echo random user input back unchecked)
 *
 * Domain is preserved so users can sanity-check they typed it correctly.
 *
 * @param {unknown} email
 * @returns {string}
 */
function maskEmailForUi(email) {
  if (typeof email !== "string") return "";
  const trimmed = email.trim();
  const at = trimmed.lastIndexOf("@");
  if (at < 1 || at >= trimmed.length - 3) return "";
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  if (!/^[A-Za-z0-9.+_-]+$/.test(local) || !/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(domain)) {
    return "";
  }
  if (local.length <= 1) return `${local}***@${domain}`;
  if (local.length <= 3) return `${local.slice(0, 1)}${"*".repeat(local.length - 1)}@${domain}`;
  return `${local.slice(0, 2)}${"*".repeat(local.length - 2)}@${domain}`;
}

/**
 * @param {import("./stripe-order-store.mjs").OrderRecord} order
 */
function publicSummary(order) {
  /** @type {"synced"|"pending"|"manual_review"|"canceled"|"test_mode"|"unknown"} */
  let bucket = "unknown";
  if (TERMINAL_OK.has(order.mindbodySyncStatus)) bucket = "synced";
  else if (TERMINAL_PENDING.has(order.mindbodySyncStatus)) bucket = "pending";
  else if (TERMINAL_MANUAL.has(order.mindbodySyncStatus)) bucket = "manual_review";
  else if (TERMINAL_CANCELED.has(order.mindbodySyncStatus)) bucket = "canceled";
  else if (TERMINAL_TEST_MODE.has(order.mindbodySyncStatus)) bucket = "test_mode";

  /** @type {Record<string, string>} */
  const messageByBucket = {
    synced: "Your package is ready in Mindbody. You can book classes now.",
    pending: "Payment received. We're finishing your package setup; this usually takes a few seconds.",
    manual_review:
      "Payment received. Our team is finalizing your package — if it doesn't appear in Mindbody shortly, please contact the studio.",
    canceled: "This checkout was canceled. You were not charged.",
    test_mode:
      "Stripe test-mode payment received. No package was created in Mindbody (test environment).",
    unknown: "We're confirming your payment.",
  };

  /**
   * Look up the catalog row to surface a clean human-readable `displayName` for the
   * GA4 ecommerce `purchase` event on /checkout/success. Server-side lookup keeps the
   * frontend free of catalog wiring; falls back to the SKU itself when missing so the
   * event still fires (with a slightly less pretty `item_name`).
   */
  const catalogItem = getCatalogItem(order.localSku);

  return {
    orderId: order.orderId,
    localSku: order.localSku,
    /**
     * Human-readable name for GA4 ecommerce `item_name` (e.g., "New Client Special — 3 Classes").
     */
    displayName: catalogItem?.displayName || order.localSku,
    /**
     * Source of the CTA that started this checkout, e.g. `home_new_client_special`,
     * `first_visit_new_client_special`, `pricing_static_new_client`,
     * `pricing_api_modal_express`, `pricing_api_soft_gate`. Used by /checkout/success to
     * fire a `new_client_special_purchase` GA4 event with proper attribution back to
     * the source page (NCS appears on Home, First Visit, and Pricing).
     */
    ctaLocation: typeof order.ctaLocation === "string" && order.ctaLocation ? order.ctaLocation : null,
    amountCents: order.amountCents,
    currency: order.currency,
    paymentStatus: order.stripePaymentStatus || null,
    mindbodySyncStatus: order.mindbodySyncStatus,
    bucket,
    message: messageByBucket[bucket],
    /**
     * Email returned in two forms:
     *  • customerEmail        — full address. Safe to expose on /checkout/success because the URL
     *    contains an unguessable Stripe session_id / orderId, so only the buyer reaches this page.
     *    Lets the buyer confirm they typed the right inbox before signing in to Mindbody.
     *  • customerEmailMasked  — kept for any future consumer / fallback that prefers a masked form.
     */
    customerEmail: typeof order.customerEmail === "string" ? order.customerEmail : "",
    customerEmailMasked: maskEmailForUi(order.customerEmail),
    /** Surface to UI so the success page can show a discreet "Test mode" badge if true. */
    stripeLivemode: order.stripeLivemode === true,
    /**
     * Onboarding signals — drive the success-page CTA copy.
     *  • clientWasNewlyCreated → buyer is a brand-new Mindbody client. They cannot sign in until
     *    they set a password via the welcome email.
     *  • welcomeEmailSent → Mindbody confirmed the password-setup email was queued. UI can say
     *    "Check your email". When false (and clientWasNewlyCreated true), UI should fall back to
     *    "Use 'Forgot password?' on the sign-in screen".
     */
    clientWasNewlyCreated: order.clientWasNewlyCreated === true,
    welcomeEmailSent: order.welcomeEmailSent === true,
    updatedAt: order.updatedAt,
  };
}

/**
 * Subscription bucket — the same `bucket` vocabulary as one-time orders, derived from
 * `SubscriptionRecord.status` + the most recent `InvoiceSyncEntry.status` so the success
 * page can use a single rendering pipeline. We intentionally do NOT expose Stripe ids,
 * customer ids, or invoice metadata other than the most recent sync status.
 *
 * @param {import("./stripe-subscription-store.mjs").SubscriptionRecord} sub
 */
function publicSubscriptionSummary(sub) {
  /** @type {import("./stripe-subscription-store.mjs").InvoiceSyncEntry | null} */
  const lastInvoice =
    Array.isArray(sub.invoices) && sub.invoices.length > 0
      ? sub.invoices[sub.invoices.length - 1]
      : null;

  /**
   * Bucket precedence:
   *   1. canceled                         → final state
   *   2. paid_but_not_synced              → manual_review
   *   3. invoice synced + status=active   → synced
   *   4. status=pending_first_invoice OR no invoice yet → pending
   *   5. status=past_due                  → manual_review (admin attention)
   */
  /** @type {"synced"|"pending"|"manual_review"|"canceled"|"test_mode"|"unknown"} */
  let bucket = "pending";
  if (sub.status === "canceled_admin" || sub.status === "canceled_payment_failure") {
    bucket = "canceled";
  } else if (lastInvoice && lastInvoice.status === "paid_but_not_synced") {
    bucket = "manual_review";
  } else if (lastInvoice && lastInvoice.status === "test_mode_no_sync") {
    bucket = "test_mode";
  } else if (sub.status === "active") {
    bucket = "synced";
  } else if (sub.status === "past_due") {
    bucket = "manual_review";
  } else if (sub.status === "pending_first_invoice") {
    bucket = "pending";
  }

  /** @type {Record<string, string>} */
  const messageByBucket = {
    synced: "Your monthly membership is active. You can book classes now.",
    pending:
      "Payment received. We're activating your membership; this usually takes a few seconds.",
    manual_review:
      "Payment received. Our team is finalizing your membership — if it doesn't appear in Mindbody shortly, please contact the studio.",
    canceled: "This subscription was canceled.",
    test_mode:
      "Stripe test-mode payment received. No Mindbody credits were granted (test environment).",
    unknown: "We're confirming your subscription.",
  };

  const catalogItem = getCatalogItem(sub.localSku);

  return {
    kind: /** @type {const} */ ("subscription"),
    /** Reuse `orderId` for the success-page UI label — buyer doesn't need to see "subscriptionId". */
    orderId: sub.id,
    localSku: sub.localSku,
    displayName: catalogItem?.displayName || sub.localSku,
    ctaLocation: typeof sub.ctaLocation === "string" && sub.ctaLocation ? sub.ctaLocation : null,
    amountCents: sub.monthlyAmountCents,
    currency: sub.currency,
    paymentStatus: lastInvoice && lastInvoice.amountCents > 0 ? "paid" : "pending",
    /** Mirror one-time `mindbodySyncStatus` for the same UI pipeline. */
    mindbodySyncStatus: lastInvoice ? lastInvoice.status : sub.status,
    bucket,
    message: messageByBucket[bucket],
    customerEmail: typeof sub.customerEmail === "string" ? sub.customerEmail : "",
    customerEmailMasked: maskEmailForUi(sub.customerEmail),
    stripeLivemode: sub.stripeLivemode === true,
    /**
     * Membership-specific extras the success page can render to reassure the buyer:
     *   • commitmentMonths — minimum commitment they just agreed to.
     *   • currentPeriodEnd — when the next monthly charge will run.
     */
    minimumCommitmentMonths: sub.minimumCommitmentMonths ?? null,
    commitmentEndDate: sub.commitmentEndDate ?? null,
    currentPeriodEnd: sub.currentPeriodEnd ?? null,
    /**
     * Subscriptions never go through the new-client onboarding banner — buyers must already
     * be a Mindbody member to subscribe (the dialog enforces sign-in). Hard-code `false`
     * here so the success page does not flash the welcome-email copy by mistake.
     */
    clientWasNewlyCreated: false,
    welcomeEmailSent: false,
    updatedAt: sub.updatedAt,
  };
}

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: { "Cache-Control": "no-store" },
      body: "",
    };
  }
  if (event.httpMethod !== "GET") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" });
  }

  const q = event.queryStringParameters || {};
  const orderIdRaw = typeof q.orderId === "string" ? q.orderId.trim() : "";
  const sessionIdRaw = typeof q.session_id === "string" ? q.session_id.trim() : "";

  const store = openOrderStore(event);
  if (!store.available) {
    return jsonResponse(503, { ok: false, error: "order_store_unavailable" });
  }

  /** @type {import("./stripe-order-store.mjs").OrderRecord | null} */
  let order = null;
  if (/^ord_[A-Z0-9]{8,40}$/.test(orderIdRaw)) {
    try {
      order = await store.get(orderIdRaw);
    } catch {
      order = null;
    }
  }
  if (!order && /^cs_[A-Za-z0-9_-]{4,200}$/.test(sessionIdRaw)) {
    order = await store.getByCheckoutSessionId(sessionIdRaw);
  }
  if (order) {
    return jsonResponse(200, { ok: true, kind: "order", order: publicSummary(order) });
  }

  /**
   * Fall back to the subscription store. We do this AFTER the one-time order lookup so that
   * a one-time orderId or session_id never accidentally matches a subscription record (the
   * orderId regex `^ord_…` and the subscriptionId prefix `sub_amare_…` are disjoint, but the
   * session_id format is shared, so the order store still wins by ordering).
   */
  const subStore = openSubscriptionStore(event);
  if (subStore.available) {
    /** @type {import("./stripe-subscription-store.mjs").SubscriptionRecord | null} */
    let sub = null;
    if (/^sub_amare_[A-Z0-9]{8,40}$/.test(orderIdRaw)) {
      try {
        sub = await subStore.get(orderIdRaw);
      } catch {
        sub = null;
      }
    }
    if (!sub && /^cs_[A-Za-z0-9_-]{4,200}$/.test(sessionIdRaw)) {
      sub = await subStore.getByCheckoutSessionId(sessionIdRaw);
    }
    if (sub) {
      return jsonResponse(200, { ok: true, kind: "subscription", order: publicSubscriptionSummary(sub) });
    }
  }

  return jsonResponse(404, { ok: false, error: "order_not_found" });
}
