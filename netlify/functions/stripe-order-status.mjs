/**
 * GET /api/stripe/order-status?orderId=…  (or ?session_id=…)
 *
 * Read-only safe summary of an order for the customer-facing /checkout/success page.
 * Never fulfills, never exposes secrets, never reveals more than the customer needs.
 */

import { jsonResponse } from "./mindbody-consumer-lib.mjs";
import { getCatalogItem } from "./stripe-catalog-lib.mjs";
import { openOrderStore } from "./stripe-order-store.mjs";

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
  if (!order) {
    return jsonResponse(404, { ok: false, error: "order_not_found" });
  }
  return jsonResponse(200, { ok: true, order: publicSummary(order) });
}
