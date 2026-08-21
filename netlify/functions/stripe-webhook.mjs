/**
 * POST /api/stripe/webhook
 *
 * Stripe webhook → fulfill Mindbody purchases. Handles BOTH product shapes:
 *
 *  • One-time Service purchases (NCS / drop-in / class packs). Source of truth for fulfillment
 *    (the success page never fulfills). Events handled:
 *      checkout.session.completed
 *      checkout.session.async_payment_succeeded
 *      checkout.session.async_payment_failed
 *      checkout.session.expired
 *      payment_intent.succeeded          (mobile PaymentSheet one-time only; fail-closed)
 *
 *  • Recurring monthly memberships (Option A — Stripe handles billing, Mindbody syncs as a
 *    Pricing Option add on every successful invoice). Events handled:
 *      checkout.session.completed         (mode:subscription) — bind subscription id to record
 *      invoice.paid                       — sync 1× Pricing Option to Mindbody (hybrid retry)
 *      invoice.payment_failed             — record skipped_payment_failed; status → past_due
 *      customer.subscription.updated      — refresh period dates / status / cancelAt
 *      customer.subscription.deleted      — final cancellation
 *      charge.refunded                    — log only in V1 (no auto credit removal)
 *
 * Idempotency:
 *  • One-time orders: atomic `claimOneTimeFulfillment(orderId)` BEFORE CheckoutShoppingCart
 *    (same pattern as `claimInvoiceSlot`). Status `mindbody_synced` alone is not enough —
 *    concurrent deliveries of the same paid order must not both send a cart. Uncertain
 *    post-request outcomes become `mindbody_sync_unknown` and never auto-retry the sale.
 *  • Recurring: per-invoice `claimInvoiceSlot` before Mindbody, plus `invoices[]` dedup.
 *
 * Failures (one-time):
 *  • Mindbody sync timeout / crash after the request may have been sent: `mindbody_sync_unknown`.
 *  • Mindbody sync rejected (business error, no sale): `paid_but_not_synced` (manual review).
 *  • Multiple email matches → `paid_but_not_synced` with reason `multiple_client_matches`.
 *  • NCS for known existing client (anonymous flow) → `paid_but_not_synced` with reason
 *    `ncs_for_existing_client`.
 *
 * Failures (recurring):
 *  • Hybrid retry on `invoice.paid`: 1 immediate + up to 2 in-webhook retries with short
 *    backoff. If still failing, invoice entry is marked `paid_but_not_synced` for admin retry.
 *  • Stripe's own smart retry handles dunning before declaring `customer.subscription.deleted`
 *    with reason `payment_failed` — we map that to `canceled_payment_failure`.
 *
 * For paid_but_not_synced cases we still return 200 to Stripe so it stops retrying — the money
 * is captured and the studio reconciles via admin (one-time) or admin-subscriptions (recurring)
 * endpoints. We DO return a non-2xx for transient errors so Stripe retries (with idempotency
 * guarantees protecting us).
 */

import Stripe from "stripe";

import {
  getMindbodyStaffAccessTokenCached,
  jsonResponse,
} from "./mindbody-consumer-lib.mjs";
import {
  mindbodyStaffApiHeaders,
  mindbodyStaffBearerHeaders,
} from "./mindbody-upstream.mjs";
import { getCatalogItem } from "./stripe-catalog-lib.mjs";
import { newOrderId, openOrderStore } from "./stripe-order-store.mjs";
import { fulfillOneTimeMindbodySale } from "./stripe-onetime-fulfillment.mjs";
import { consumeTopUpForPaidOrder, releaseTopUpForAbandonedOrder } from "./member-topup-lib.mjs";
import { readStripeSubscriptionPeriod } from "./stripe-subscription-period.mjs";
import {
  handleMobilePaymentIntentSucceeded,
  isMobilePaymentSheetOrder,
  PAYMENT_FLOW_MOBILE,
} from "./stripe-payment-flow.mjs";
import {
  fetchClientNcsHistory,
  resolveOrCreateMindbodyClient,
  sendNewClientPasswordSetupEmail,
  splitFullName,
  syncOneTimePurchaseToMindbody,
} from "./stripe-mindbody-sync-lib.mjs";
import { openSubscriptionStore } from "./stripe-subscription-store.mjs";
import {
  runClassesAutoBookAfterMindbodySync,
  runClassesAutoBookAfterMembershipFirstInvoiceSync,
  handleClassesAutoBookWebhookRedelivery,
  handleMembershipAutoBookWebhookRedelivery,
  notifyClassesPurchaseMindbodySyncFailure,
  notifyClassesMembershipMindbodySyncFailure,
} from "./classes-auto-book-lib.mjs";
import {
  expireEventDepositSession,
  fulfillEventDepositSession,
  isEventDepositSession,
} from "./event-reservation-fulfill.mjs";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** @param {unknown} event */
function rawBodyAndSignature(event) {
  if (!event || typeof event !== "object") return { raw: "", sig: "" };
  const e = /** @type {{ body?: unknown; isBase64Encoded?: boolean; headers?: Record<string, unknown> }} */ (event);
  const headers = e.headers || {};
  let sig = "";
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === "stripe-signature") {
      sig = String(headers[k] || "").trim();
      break;
    }
  }
  if (e.body == null) return { raw: "", sig };
  if (e.isBase64Encoded) {
    return { raw: Buffer.from(/** @type {string} */ (e.body), "base64").toString("utf8"), sig };
  }
  return { raw: typeof e.body === "string" ? e.body : String(e.body), sig };
}

function stripeSecret() {
  const k = (process.env.STRIPE_SECRET_KEY || "").trim();
  if (!k.startsWith("sk_")) return null;
  return k;
}

function webhookSecret() {
  const w = (process.env.STRIPE_WEBHOOK_SECRET || "").trim();
  if (!w.startsWith("whsec_")) return null;
  return w;
}

/**
 * Pull Stripe coupon details from a Checkout Session that may or may not have been retrieved
 * with `discounts.coupon` / `discounts.promotion_code` expanded.
 *
 * Returns the **first** discount on the session (Stripe Checkout supports at most one promo
 * code per session in `payment` mode, so this is sufficient for our flow). The fields are
 * read defensively because `discounts` is typed as `Array<Stripe.Checkout.Session.Discount>`
 * but each entry can be either a string id or the expanded object depending on the retrieve
 * options used. When the session has no discount → all return values are empty/null.
 *
 * `promotionCode` is the human-facing code the buyer typed (e.g. "WELCOME20"); `couponId`
 * is the underlying Stripe Coupon object id. Either or both may be missing — callers must
 * tolerate empty strings.
 *
 * @param {Stripe.Checkout.Session} session
 * @returns {{ promotionCode: string; couponId: string }}
 */
function extractStripeDiscountIdentity(session) {
  /** @type {unknown} */
  const raw = /** @type {{ discounts?: unknown }} */ (session).discounts;
  if (!Array.isArray(raw) || raw.length === 0) return { promotionCode: "", couponId: "" };
  const first = raw[0];
  if (!first || typeof first !== "object") return { promotionCode: "", couponId: "" };
  const o = /** @type {Record<string, unknown>} */ (first);

  /**
   * `couponId` lookup — three possible locations, in order of preference:
   *   1. `discounts[0].coupon` directly (only populated when the customer applied a Coupon
   *      via API/manual `discounts: [{coupon: ...}]` rather than a Promotion Code).
   *   2. `discounts[0].promotion_code.coupon` — the standard path when the customer typed
   *      a Promotion Code in Checkout. Stripe nests the underlying coupon here. Verified
   *      empirically on AMARE20 + WELCOME10 against the Sandbox: `discounts[0].coupon` is
   *      null, but `promotion_code.coupon` carries the coupon id (or the expanded object
   *      when `expand: ["discounts.promotion_code.coupon"]` was requested).
   *   3. Either form may be a string (raw id) or expanded object (`{id, ...}`).
   */
  /** @type {string} */
  let couponId = "";
  /** @param {unknown} v */
  function couponIdFrom(v) {
    if (typeof v === "string") return v;
    if (v && typeof v === "object") {
      const cid = /** @type {{ id?: unknown }} */ (v).id;
      if (typeof cid === "string") return cid;
    }
    return "";
  }
  couponId = couponIdFrom(o.coupon);
  /** @type {string} */
  let promotionCode = "";
  const p = o.promotion_code;
  if (p && typeof p === "object") {
    const pObj = /** @type {Record<string, unknown>} */ (p);
    const pc = pObj.code;
    if (typeof pc === "string") promotionCode = pc;
    if (!couponId) {
      couponId = couponIdFrom(pObj.coupon);
    }
  }
  return {
    promotionCode: promotionCode.trim().slice(0, 60),
    couponId: couponId.trim().slice(0, 60),
  };
}

/**
 * Build the structured "Stripe paid amount + discount" snapshot that we persist on the
 * order record and forward to Mindbody. Single source of truth so the webhook and any
 * future admin-retry path read the same fields. All amounts are in cents; `paidCents`
 * defaults to the catalog list price when Stripe didn't supply `amount_total` (very rare,
 * but defensive — keeps the no-coupon flow byte-identical to the pre-coupon shape).
 *
 * @param {Stripe.Checkout.Session} session
 * @param {{ amountCents: number }} order
 */
function extractStripeAmountSnapshot(session, order) {
  const fallbackList = Math.max(0, Math.round(order.amountCents || 0));
  const total = /** @type {{ amount_total?: unknown }} */ (session).amount_total;
  const subtotal = /** @type {{ amount_subtotal?: unknown }} */ (session).amount_subtotal;
  const td = /** @type {{ total_details?: unknown }} */ (session).total_details;
  /** @type {number} */
  let discountCents = 0;
  if (td && typeof td === "object") {
    const d = /** @type {{ amount_discount?: unknown }} */ (td).amount_discount;
    if (typeof d === "number" && Number.isFinite(d) && d >= 0) discountCents = Math.round(d);
  }
  const paidCents =
    typeof total === "number" && Number.isFinite(total) && total >= 0
      ? Math.round(total)
      : fallbackList;
  const subtotalCents =
    typeof subtotal === "number" && Number.isFinite(subtotal) && subtotal >= 0
      ? Math.round(subtotal)
      : fallbackList;
  const { promotionCode, couponId } = extractStripeDiscountIdentity(session);
  return {
    paidCents,
    subtotalCents,
    discountCents,
    promotionCode,
    couponId,
    hasDiscount: discountCents > 0,
  };
}

/**
 * Per-invoice equivalent of `extractStripeAmountSnapshot` — used by the recurring flow.
 * Reads the four amount fields directly from the Stripe Invoice object (cents):
 *
 *   • `subtotal`            — pre-discount, pre-tax (Mindbody "RegularPrice")
 *   • `total_discount_amounts[].amount` (sum) — discount applied to THIS invoice (Mindbody "DiscountAmount")
 *   • `tax`                 — Stripe-calculated tax on this invoice (always 0 in our setup, future-proof)
 *   • `amount_paid`         — what Stripe actually collected (Mindbody "AmountPaid")
 *
 * Math sanity:  `subtotal - discount + tax === amount_paid` (when fully paid).
 *
 * Coupon identity is read from `invoice.discounts[].coupon` and `…promotion_code` for audit.
 * Like the session-side helper, we accept either the string id or the expanded object form.
 *
 * IMPORTANT — `duration` semantics:
 *   • A `duration: once` coupon will produce `discountAmountCents > 0` ONLY on the first
 *     invoice. Renewals come back with `discountAmountCents: 0` and full `subtotalCents`.
 *   • A `duration: forever` / `repeating` coupon produces a discount on every (in-period)
 *     invoice. Each invoice is independent — we don't have to remember the coupon ourselves.
 *
 * Returning `paidCents === 0 && discountAmountCents > 0` means a 100%-off coupon was
 * applied. Per V1.5 operational rule (see § 9.15), this is NOT supported and the caller
 * must skip the Mindbody sync. Flag is exposed on the snapshot for guard logic.
 *
 * @param {Stripe.Invoice} invoice
 */
function extractInvoiceDiscountSnapshot(invoice) {
  const subtotalRaw = /** @type {{ subtotal?: unknown }} */ (invoice).subtotal;
  const subtotalCents =
    typeof subtotalRaw === "number" && Number.isFinite(subtotalRaw) && subtotalRaw >= 0
      ? Math.round(subtotalRaw)
      : 0;
  const taxRaw = /** @type {{ tax?: unknown }} */ (invoice).tax;
  const taxAmountCents =
    typeof taxRaw === "number" && Number.isFinite(taxRaw) && taxRaw >= 0
      ? Math.round(taxRaw)
      : 0;
  const paidRaw = /** @type {{ amount_paid?: unknown }} */ (invoice).amount_paid;
  const paidCents =
    typeof paidRaw === "number" && Number.isFinite(paidRaw) && paidRaw >= 0
      ? Math.round(paidRaw)
      : 0;

  /**
   * Sum every entry in `total_discount_amounts[]` rather than reading a single coupon's
   * effect, so that stacked discounts (rare but legal in Stripe) all flow through to the
   * Mindbody side. Each entry has `{ amount: cents, discount: id|expanded }`.
   */
  let discountAmountCents = 0;
  const tda = /** @type {{ total_discount_amounts?: unknown }} */ (invoice).total_discount_amounts;
  if (Array.isArray(tda)) {
    for (const e of tda) {
      if (!e || typeof e !== "object") continue;
      const amt = /** @type {{ amount?: unknown }} */ (e).amount;
      if (typeof amt === "number" && Number.isFinite(amt) && amt > 0) {
        discountAmountCents += Math.round(amt);
      }
    }
  }

  /**
   * Coupon identity for audit. Walk `invoice.discounts[]` (which Stripe expands when we
   * request `discounts.coupon` / `discounts.promotion_code.coupon`). Same lookup order as
   * the session helper: direct `coupon`, then `promotion_code.coupon`. We pick the FIRST
   * that yields an id; stacked coupons are recorded only by total amount above.
   */
  let couponId = "";
  let promotionCode = "";
  const discountsRaw = /** @type {{ discounts?: unknown }} */ (invoice).discounts;
  if (Array.isArray(discountsRaw) && discountsRaw.length > 0) {
    /** @param {unknown} v */
    function couponIdFrom(v) {
      if (typeof v === "string") return v;
      if (v && typeof v === "object") {
        const cid = /** @type {{ id?: unknown }} */ (v).id;
        if (typeof cid === "string") return cid;
      }
      return "";
    }
    for (const d of discountsRaw) {
      if (!d || typeof d !== "object") continue;
      const o = /** @type {Record<string, unknown>} */ (d);
      if (!couponId) couponId = couponIdFrom(o.coupon);
      const p = o.promotion_code;
      if (p && typeof p === "object") {
        const pObj = /** @type {Record<string, unknown>} */ (p);
        const pc = pObj.code;
        if (!promotionCode && typeof pc === "string") promotionCode = pc;
        if (!couponId) couponId = couponIdFrom(pObj.coupon);
      }
      if (couponId && promotionCode) break;
    }
  }

  /**
   * 100%-off detector. When the buyer's coupon zeros the invoice, Stripe sets
   * `amount_paid: 0` AND `discount > 0` AND `subtotal > 0`. Distinct from a $0 proration
   * credit (where `subtotal: 0`, `discount: 0`). We surface this so the caller can record
   * a clear `lastError: coupon_100_percent_off_unsupported` instead of the generic
   * `skipped_zero_amount`. Per V1.5 operational rule (§ 9.15), the studio does not issue
   * 100%-off coupons; this guard is defense-in-depth.
   */
  const isHundredPercentOffCoupon =
    paidCents === 0 && discountAmountCents > 0 && subtotalCents > 0;

  return {
    paidCents,
    subtotalCents,
    discountAmountCents,
    taxAmountCents,
    couponId,
    promotionCode,
    hasDiscount: discountAmountCents > 0,
    isHundredPercentOffCoupon,
  };
}

/**
 * Read `session.custom_fields[]` for the `first_name` + `last_name` text fields we register
 * in `stripe-create-checkout-session.mjs` for anonymous buyers (Option A — only when we
 * don't already have a clean Mindbody profile name). Returns trimmed values bounded at 80
 * chars (matches Mindbody's `addclient` field length we already enforce).
 *
 * @param {Stripe.Checkout.Session} session
 * @returns {{ firstName: string; lastName: string }}
 */
function extractCustomFieldNames(session) {
  /** @type {unknown} */
  const raw = /** @type {{ custom_fields?: unknown }} */ (session).custom_fields;
  if (!Array.isArray(raw)) return { firstName: "", lastName: "" };
  let firstName = "";
  let lastName = "";
  for (const f of raw) {
    if (!f || typeof f !== "object") continue;
    const o = /** @type {Record<string, unknown>} */ (f);
    const key = typeof o.key === "string" ? o.key : "";
    const t = /** @type {Record<string, unknown> | null} */ (
      o.text && typeof o.text === "object" ? o.text : null
    );
    const value = t && typeof t.value === "string" ? t.value.trim().slice(0, 80) : "";
    if (key === "first_name") firstName = value;
    else if (key === "last_name") lastName = value;
  }
  return { firstName, lastName };
}

/**
 * Resolve the buyer's email + display name + phone for downstream Mindbody calls.
 *
 * Name precedence (highest → lowest):
 *   1. `custom_fields[first_name]` + `custom_fields[last_name]` — collected when the buyer
 *      was anonymous (no Mindbody profile to pre-fill from). These are the cleanest
 *      because we asked explicitly with separate inputs, so Mindbody Identity can match
 *      first+last+email reliably on first sign-in.
 *   2. `customer_details.name` — single string from cardholder / Apple Pay / Link / wallet.
 *      Used for logged-in members (we already have first+last from Mindbody on the order
 *      record, so this name is informational) and as a fallback if custom_fields are
 *      absent for any reason.
 *
 * `firstName` / `lastName` are returned **only** when sourced from custom_fields; the
 * downstream caller decides whether to pass them as authoritative to
 * `resolveOrCreateMindbodyClient` or fall back to `splitFullName(name)`.
 *
 * @param {Stripe.Checkout.Session} session
 */
function checkoutPaymentIntentId(session) {
  const pi = session && session.payment_intent;
  if (typeof pi === "string" && pi) return pi;
  if (pi && typeof pi === "object" && typeof /** @type {{ id?: unknown }} */ (pi).id === "string") {
    return /** @type {{ id: string }} */ (pi).id;
  }
  return undefined;
}

function safeCustomerDetails(session) {
  const cd = session.customer_details ?? null;
  const { firstName, lastName } = extractCustomFieldNames(session);
  const composedName = `${firstName} ${lastName}`.trim();
  const fallbackName = (cd?.name || "").trim();
  return {
    email: (cd?.email || session.customer_email || "").trim().toLowerCase(),
    name: composedName || fallbackName,
    phone: (cd?.phone || "").trim(),
    firstName,
    lastName,
  };
}

/**
 * Decide what the webhook should do with a Stripe event based on Stripe's `livemode` flag and
 * the operator's `STRIPE_TEST_MODE_MINDBODY_BEHAVIOR` env preference.
 *
 * Default behavior is **the safest one**: a Stripe test-mode payment never touches Mindbody.
 * Operators can opt into pipeline rehearsal with `mindbody_test` (Mindbody's own dry-run mode),
 * or full live syncs for staging that uses Stripe test cards but a real Mindbody site (`live`).
 *
 * Defense-in-depth: we treat the event as live ONLY when both the event-level and
 * session-level `livemode` flags say true. Mismatched (Stripe should never produce these but
 * better safe) → treated as test.
 *
 * @param {Stripe.Event} evt
 * @param {Stripe.Checkout.Session | null} session
 * @returns {{ stripeLivemode: boolean; behavior: "skip" | "mindbody_test" | "live"; mindbodyTest: boolean }}
 */
function decideTestModeBehavior(evt, session) {
  const evtLive = evt.livemode === true;
  const sessLive = session && typeof session.livemode === "boolean" ? session.livemode : evtLive;
  const stripeLivemode = evtLive === true && sessLive === true;

  /** Pure live → always real sync. No env override here. */
  if (stripeLivemode) {
    return { stripeLivemode: true, behavior: "live", mindbodyTest: false };
  }

  /** Stripe test-mode event. Apply the operator preference. */
  const raw = (process.env.STRIPE_TEST_MODE_MINDBODY_BEHAVIOR || "skip").trim().toLowerCase();
  if (raw === "live") {
    return { stripeLivemode: false, behavior: "live", mindbodyTest: false };
  }
  if (raw === "mindbody_test" || raw === "mb_test" || raw === "test") {
    return { stripeLivemode: false, behavior: "mindbody_test", mindbodyTest: true };
  }
  return { stripeLivemode: false, behavior: "skip", mindbodyTest: false };
}

/* -------------------------------------------------------------------------- */
/* Fulfillment                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Idempotently fulfill one Stripe Checkout Session.
 *
 * @param {Stripe.Checkout.Session} session
 * @param {ReturnType<import("./stripe-order-store.mjs").openOrderStore>} store
 * @param {{ stripeLivemode: boolean; behavior: "skip" | "mindbody_test" | "live"; mindbodyTest: boolean }} testModeDecision
 * @param {{
 *   stripeEventId?: string;
 *   syncFn?: import("./stripe-mindbody-sync-lib.mjs").syncOneTimePurchaseToMindbody;
 *   resolveMindbodyClient?: (order: import("./stripe-order-store.mjs").OrderRecord) => Promise<{
 *     ok: boolean;
 *     clientId?: number;
 *     clientCreated?: boolean;
 *     email?: string;
 *     reason?: string;
 *     retryable?: boolean;
 *     message?: string;
 *     candidateCount?: number;
 *   }>;
 * }=} opts
 * @returns {Promise<{ ok: true; status: string; noop?: boolean } | { ok: false; status: string; reason: string; retryable?: boolean }>}
 */
async function fulfillSession(session, store, testModeDecision, opts) {
  const sessionId = session.id;
  const metadataOrderId = (session.metadata && typeof session.metadata === "object"
    ? /** @type {Record<string, string>} */ (session.metadata).orderId
    : "") || (typeof session.client_reference_id === "string" ? session.client_reference_id : "");
  const sessionPaymentFlow =
    session.metadata && typeof session.metadata === "object"
      ? /** @type {Record<string, string>} */ (session.metadata).amarePaymentFlow
      : "";
  if (sessionPaymentFlow === PAYMENT_FLOW_MOBILE) {
    console.log(
      JSON.stringify({
        event: "stripe_webhook_session_ignored_mobile_payment_sheet",
        sessionId,
        orderId: metadataOrderId || null,
        stripeEventId: opts?.stripeEventId || null,
      }),
    );
    return { ok: true, status: "ignored_mobile_payment_sheet", noop: true };
  }

  /** Resolve the order: by metadata first, then by session-index. */
  let order = null;
  if (metadataOrderId) {
    try {
      order = await store.get(metadataOrderId);
    } catch {
      order = null;
    }
  }
  if (!order) {
    order = await store.getByCheckoutSessionId(sessionId);
  }

  /**
   * Recovery path: webhook arrived but order record is missing (e.g., the create-session
   * function returned an error after the Stripe call succeeded, or somebody is replaying old
   * events). We can still try to fulfill from the session metadata — but only if metadata
   * carries enough to identify the SKU.
   */
  if (!order) {
    const sku = session.metadata && session.metadata.localSku;
    if (typeof sku !== "string" || !sku) {
      console.error(
        JSON.stringify({
          event: "stripe_webhook_no_order_no_metadata_sku",
          sessionId,
          paymentStatus: session.payment_status,
        }),
      );
      return { ok: false, status: "no_order", reason: "order_missing_and_no_sku_metadata" };
    }
    const item = getCatalogItem(sku);
    if (!item) {
      return { ok: false, status: "no_order", reason: "order_missing_unknown_sku" };
    }
    const recoveredId = metadataOrderId || newOrderId();
    /** @type {import("./stripe-order-store.mjs").OrderRecord} */
    const recovered = {
      orderId: recoveredId,
      localSku: item.localSku,
      amountCents: item.amountCents,
      currency: item.currency,
      stripeCheckoutSessionId: sessionId,
      stripePaymentIntentId: checkoutPaymentIntentId(session),
      mindbodySyncStatus: "checkout_created",
      mindbodyServiceId: item.mindbodyServiceId,
      flow: "stripe_to_mindbody_one_time",
      paymentFlow: "hosted_checkout",
      source: "amare_site_recovered_in_webhook",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await store.put(recovered, { onlyIfNew: true });
    await store.bindSession(sessionId, recoveredId);
    order = recovered;
  }

  if (isMobilePaymentSheetOrder(order)) {
    console.log(
      JSON.stringify({
        event: "stripe_webhook_session_ignored_mobile_payment_sheet",
        sessionId,
        orderId: order.orderId,
        stripeEventId: opts?.stripeEventId || null,
      }),
    );
    return { ok: true, status: "ignored_mobile_payment_sheet", noop: true };
  }

  /** Already synced / skipped — Stripe may be redelivering; deferred book may still be pending. */
  if (
    order.mindbodySyncStatus === "mindbody_synced" ||
    order.mindbodySyncStatus === "refunded" ||
    order.mindbodySyncStatus === "test_mode_no_sync"
  ) {
    const resolvedClientId =
      typeof order.resolvedMindbodyClientId === "number" && order.resolvedMindbodyClientId > 0
        ? order.resolvedMindbodyClientId
        : typeof order.knownMindbodyClientId === "number" && order.knownMindbodyClientId > 0
          ? order.knownMindbodyClientId
          : null;
    if (resolvedClientId != null) {
      await handleClassesAutoBookWebhookRedelivery(store, order.orderId, resolvedClientId);
    }
    return { ok: true, status: order.mindbodySyncStatus, noop: true };
  }

  /**
   * In-flight claim after CheckoutShoppingCart may have been sent, or uncertain
   * external side effect. Return 200 so Stripe stops overlapping deliveries.
   * A claim with no `fulfillmentRequestSentAt` is pre-cart and must stay retryable.
   */
  if (order.mindbodySyncStatus === "mindbody_sync_unknown") {
    console.log(
      JSON.stringify({
        event: "stripe_order_fulfillment_blocked",
        orderId: order.orderId,
        sessionId,
        status: order.mindbodySyncStatus,
        stripeEventId: opts?.stripeEventId || null,
      }),
    );
    return { ok: true, status: order.mindbodySyncStatus, noop: true };
  }
  if (order.mindbodySyncStatus === "mindbody_sync_claimed" && order.fulfillmentRequestSentAt) {
    console.log(
      JSON.stringify({
        event: "stripe_order_fulfillment_blocked",
        orderId: order.orderId,
        sessionId,
        status: order.mindbodySyncStatus,
        stripeEventId: opts?.stripeEventId || null,
      }),
    );
    return { ok: true, status: order.mindbodySyncStatus, noop: true };
  }

  /** Stripe says paid only if `payment_status === "paid"`. */
  if (session.payment_status !== "paid") {
    await store.patch(order.orderId, {
      stripePaymentStatus: session.payment_status,
      stripePaymentIntentId: checkoutPaymentIntentId(session) || order.stripePaymentIntentId,
    });
    return { ok: true, status: order.mindbodySyncStatus, noop: true };
  }

  const customer = safeCustomerDetails(session);
  /**
   * Single-source-of-truth read for the Stripe-side payment math. Every downstream caller
   * (Mindbody sync, PayNotes, admin retry) reads from `order.stripeAmount{Total,Subtotal,
   * Discount}Cents` + `stripePromotionCode` / `stripeCouponId`. We persist these BEFORE the
   * Mindbody sync so an unhandled exception during sync still leaves the order with the
   * correct paid-amount snapshot for manual reconciliation.
   */
  const stripeAmounts = extractStripeAmountSnapshot(session, order);

  await store.patch(order.orderId, {
    mindbodySyncStatus: "payment_completed",
    stripePaymentStatus: session.payment_status,
    stripePaymentIntentId:
      typeof session.payment_intent === "string" ? session.payment_intent : order.stripePaymentIntentId,
    stripeCustomerId: typeof session.customer === "string" ? session.customer : undefined,
    customerEmail: customer.email || order.customerEmail,
    customerName: customer.name || order.customerName,
    /**
     * Persist the explicit first/last from `custom_fields` so the admin retry path
     * (`stripe-admin-orders.mjs`) gets the same clean signal we used here. Without this,
     * a retry would have to fall back to `splitFullName(customerName)`, which mis-splits
     * multi-word first names like "Mary Jane".
     */
    customerFirstName: customer.firstName || order.customerFirstName,
    customerLastName: customer.lastName || order.customerLastName,
    customerPhone: customer.phone || order.customerPhone,
    stripeAmountTotalCents: stripeAmounts.paidCents,
    stripeAmountSubtotalCents: stripeAmounts.subtotalCents,
    stripeAmountDiscountCents: stripeAmounts.discountCents,
    stripePromotionCode: stripeAmounts.promotionCode || undefined,
    stripeCouponId: stripeAmounts.couponId || undefined,
    stripeLivemode: testModeDecision.stripeLivemode,
    mindbodyTestModeBehavior: testModeDecision.behavior,
    syncAttempts: (order.syncAttempts || 0),
  });

  /**
   * SAFETY GATE: Stripe test-mode payment + behavior=skip → never touch Mindbody.
   *
   * This prevents a Stripe test card from creating a real client + service sale on the
   * production Mindbody site. The order is recorded for accounting but no API call is
   * issued. Stripe gets 200 so it stops retrying. Default for `STRIPE_TEST_MODE_MINDBODY_BEHAVIOR`
   * is `skip` precisely so the safe path is opt-out, not opt-in.
   */
  if (!testModeDecision.stripeLivemode && testModeDecision.behavior === "skip") {
    await store.patch(order.orderId, {
      mindbodySyncStatus: "test_mode_no_sync",
      errorCode: "stripe_test_mode_skipped",
      errorMessageSafe:
        "Stripe test-mode payment received. Mindbody sync intentionally skipped (STRIPE_TEST_MODE_MINDBODY_BEHAVIOR=skip).",
      lastSyncAttemptAt: new Date().toISOString(),
    });
    console.log(
      JSON.stringify({
        event: "stripe_order_test_mode_skipped",
        orderId: order.orderId,
        sessionId,
        sku: order.localSku,
        amountCents: order.amountCents,
      }),
    );
    return { ok: true, status: "test_mode_no_sync", noop: false };
  }

  /** Status `paid_but_not_synced` means money in / no Mindbody sync. We still return 200. */
  /** @param {string} reason @param {string=} message */
  async function markPaidButNotSynced(reason, message) {
    /**
     * The Mindbody-supplied message is critical for diagnosing why a sync failed (e.g.
     * "MobilePhone is already in use", "ServiceId not sellable online"). Truncate to keep
     * logs bounded but never drop the field — without it the operator is flying blind.
     */
    const safeMessage = (message || "").slice(0, 480);
    await store.patch(order.orderId, {
      mindbodySyncStatus: "paid_but_not_synced",
      errorCode: reason,
      errorMessageSafe: safeMessage,
      lastSyncAttemptAt: new Date().toISOString(),
      syncAttempts: (order.syncAttempts || 0) + 1,
    });
    console.error(
      JSON.stringify({
        event: "stripe_order_paid_but_not_synced",
        orderId: order.orderId,
        sessionId,
        reason,
        mindbodyMessage: safeMessage || null,
        sku: order.localSku,
        amountCents: order.amountCents,
        mindbodyTestModeBehavior: testModeDecision.behavior,
      }),
    );
    await notifyClassesPurchaseMindbodySyncFailure(store, order.orderId, reason);
  }

  const item = getCatalogItem(order.localSku);
  if (!item) {
    await markPaidButNotSynced("catalog_sku_missing", "Order points at a SKU not in the catalog.");
    return { ok: true, status: "paid_but_not_synced", noop: false };
  }

  /* ---------------- Resolve Mindbody client ------------------------------- */
  await store.patch(order.orderId, { mindbodySyncStatus: "client_resolving" });

  /** @type {Record<string, string> | null} */
  let staffHeaders = null;
  if (!opts?.resolveMindbodyClient) {
    const staffUser = process.env.MINDBODY_STAFF_USERNAME?.trim();
    const staffPass = process.env.MINDBODY_STAFF_PASSWORD;
    if (staffUser && typeof staffPass === "string" && staffPass !== "") {
      const issued = await getMindbodyStaffAccessTokenCached();
      if (issued.ok) staffHeaders = mindbodyStaffBearerHeaders(issued.accessToken);
    } else {
      staffHeaders = mindbodyStaffApiHeaders();
    }
    if (!staffHeaders) {
      await markPaidButNotSynced(
        "staff_credentials_unavailable",
        "Mindbody staff token is not configured on the server.",
      );
      return { ok: true, status: "paid_but_not_synced", noop: false };
    }
  }

  /**
   * Pass `firstName` / `lastName` separately whenever we have a clean source for them.
   * Precedence:
   *   1. Stripe `custom_fields[first_name]/[last_name]` from this session (legacy buyers
   *      who still went through the old fallback).
   *   2. `order.customerFirstName/customerLastName` persisted at create-session time —
   *      sourced from the new pre-checkout dialog (anonymous) or from Mindbody contact
   *      (logged-in member). This is the path the unified Express dialog uses.
   *
   * Without (2), anonymous buyers who skipped `custom_fields` would degrade to
   * `splitFullName(customerName)`, which mis-splits multi-word first names ("Mary Jane")
   * and silently breaks the Mindbody Identity auto-link on first OAuth sign-in.
   *
   * `resolveOrCreateMindbodyClient` will prefer the explicit first/last over splitting
   * `fullName`. A clean exact first+last+email match is what allows Mindbody Identity to
   * auto-link the API-created Studio Client on the buyer's first OAuth sign-in (the
   * OAuth callback's auto-merge is the safety net when this still fails).
   */
  const trustedOrderClientId =
    typeof order.knownMindbodyClientId === "number" && order.knownMindbodyClientId > 0
      ? order.knownMindbodyClientId
      : null;
  const resolved = opts?.resolveMindbodyClient
    ? await opts.resolveMindbodyClient(order)
    : await resolveOrCreateMindbodyClient(
        {
          knownMindbodyClientId: trustedOrderClientId,
          trustKnownClientId: trustedOrderClientId != null,
          email: customer.email || order.customerEmail || "",
          fullName: customer.name || order.customerName || "",
          firstName: customer.firstName || order.customerFirstName || undefined,
          lastName: customer.lastName || order.customerLastName || undefined,
          phone: customer.phone || order.customerPhone || "",
          mindbodyTest: testModeDecision.mindbodyTest,
        },
        staffHeaders,
      );
  if (!resolved.ok) {
    if (resolved.reason === "multiple_client_matches") {
      await markPaidButNotSynced(
        "multiple_client_matches",
        `Multiple Mindbody clients match this email; staff must reconcile manually (${resolved.candidateCount} matches).`,
      );
      return { ok: true, status: "paid_but_not_synced", noop: false };
    }
    if (resolved.retryable) {
      await store.patch(order.orderId, {
        mindbodySyncStatus: "sync_failed_retryable",
        errorCode: resolved.reason,
        errorMessageSafe: resolved.message || "",
        lastSyncAttemptAt: new Date().toISOString(),
        syncAttempts: (order.syncAttempts || 0) + 1,
      });
      console.warn(
        JSON.stringify({
          event: "stripe_order_client_resolve_retryable",
          orderId: order.orderId,
          sessionId,
          reason: resolved.reason,
        }),
      );
      return { ok: false, status: "sync_failed_retryable", reason: resolved.reason, retryable: true };
    }
    /**
     * Mindbody quirk: `client/addclient` does NOT accept `Test: true` — it returns
     * "Test mode is not allowed for this endpoint." This means the `mindbody_test` behavior
     * only validates payloads end-to-end when the buyer is already a known Mindbody client
     * (knownMindbodyClientId path) and addclient is bypassed. For anonymous buyers in
     * `mindbody_test`, we treat this specific failure as `test_mode_no_sync` (same terminal
     * status as `skip` mode) so it does NOT pollute `paid_but_not_synced` dashboards. The
     * order is fully recoverable: re-running the test as a logged-in member, switching to
     * `live` behavior, or simply going to live Stripe keys will succeed.
     */
    const mbMsg = String(resolved.message || "").toLowerCase();
    const isMindbodyTestAddclientUnsupported =
      testModeDecision.mindbodyTest === true &&
      resolved.reason === "addclient_failed" &&
      /test\s+mode\s+is\s+not\s+allowed/.test(mbMsg);
    if (isMindbodyTestAddclientUnsupported) {
      await store.patch(order.orderId, {
        mindbodySyncStatus: "test_mode_no_sync",
        errorCode: "mindbody_test_addclient_unsupported",
        errorMessageSafe:
          "Mindbody does not support Test:true on /client/addclient. Use a logged-in buyer for mindbody_test mode, or switch to live Stripe + live Mindbody.",
        lastSyncAttemptAt: new Date().toISOString(),
        syncAttempts: (order.syncAttempts || 0) + 1,
      });
      console.warn(
        JSON.stringify({
          event: "stripe_order_mindbody_test_addclient_unsupported",
          orderId: order.orderId,
          sessionId,
          mindbodyMessage: resolved.message || null,
          hint: "Mindbody refuses Test:true on /client/addclient. Anonymous-buyer flows cannot be dry-run validated end-to-end. Switch buyer to logged-in member, or test with live Stripe keys.",
        }),
      );
      return { ok: true, status: "test_mode_no_sync", noop: false };
    }
    await markPaidButNotSynced(`client_resolve_failed:${resolved.reason}`, resolved.message);
    return { ok: true, status: "paid_but_not_synced", noop: false };
  }

  await store.patch(order.orderId, {
    mindbodySyncStatus: resolved.clientCreated ? "client_created" : "client_found",
    resolvedMindbodyClientId: resolved.clientId,
    customerEmail: resolved.email || order.customerEmail,
    clientWasNewlyCreated: Boolean(resolved.clientCreated),
  });

  /* ---------------- NCS duplicate check (anonymous flow) ------------------ */
  if (
    item.duplicatePolicy === "block_before_checkout_if_known" &&
    item.oneTimePerClient &&
    !resolved.clientCreated &&
    !order.knownMindbodyClientId
  ) {
    const history = await fetchClientNcsHistory(staffHeaders, resolved.clientId);
    if (history.ok && history.hadNcs) {
      await store.patch(order.orderId, {
        mindbodySyncStatus: "paid_but_not_synced",
        errorCode: "ncs_for_existing_client",
        errorMessageSafe:
          "Existing Mindbody client appears to have prior NCS history. Holding for manual review.",
        ncsEligibilityReason: history.evidence.join(" | ").slice(0, 240),
        lastSyncAttemptAt: new Date().toISOString(),
        syncAttempts: (order.syncAttempts || 0) + 1,
      });
      console.warn(
        JSON.stringify({
          event: "stripe_order_ncs_for_existing_client",
          orderId: order.orderId,
          sessionId,
          clientId: resolved.clientId,
        }),
      );
      return { ok: true, status: "paid_but_not_synced", noop: false };
    }
  }

  /* ---------------- Sync the package to Mindbody -------------------------- */
  /**
   * Top-Up cycle slot is consumed on paid, before Mindbody. A later sync failure
   * must not reopen the billing-cycle slot.
   */
  await consumeTopUpForPaidOrder(opts?.event, {
    ...order,
    resolvedMindbodyClientId: resolved.clientId,
  });

  /**
   * Claim the order BEFORE CheckoutShoppingCart. Concurrent deliveries of this
   * paid order (same or different Stripe event ids) lose the claim and must not
   * send a second cart. See `fulfillOneTimeMindbodySale`.
   */
  const sale = await fulfillOneTimeMindbodySale({
    store,
    orderId: order.orderId,
    stripeCheckoutSessionId: sessionId,
    localSku: order.localSku,
    clientId: resolved.clientId,
    amountCents: order.amountCents,
    paidAmountCents: stripeAmounts.paidCents,
    discountAmountCents: stripeAmounts.discountCents,
    promotionCode: stripeAmounts.promotionCode || undefined,
    couponId: stripeAmounts.couponId || undefined,
    currency: order.currency,
    mindbodyTest: testModeDecision.mindbodyTest,
    item,
    stripeEventId: opts?.stripeEventId,
    syncFn: opts?.syncFn,
  });

  if (sale.status === "mindbody_synced" && sale.noop) {
    const resolvedClientId = resolved.clientId;
    if (resolvedClientId != null) {
      await handleClassesAutoBookWebhookRedelivery(store, order.orderId, resolvedClientId);
    }
    return { ok: true, status: "mindbody_synced", noop: true };
  }

  if (sale.status === "mindbody_synced") {
    console.log(
      JSON.stringify({
        event: "stripe_order_synced_to_mindbody",
        orderId: order.orderId,
        sessionId,
        clientId: resolved.clientId,
        sku: order.localSku,
        mode: "custom",
        mbSaleId: sale.mindbodySaleId || null,
        listCents: order.amountCents,
        paidCents: stripeAmounts.paidCents,
        discountCents: stripeAmounts.discountCents,
        promo: stripeAmounts.promotionCode || null,
        couponId: stripeAmounts.couponId || null,
        attemptId: sale.attemptId || null,
      }),
    );

    /**
     * Anonymous-buyer onboarding — only fires when ALL of these are true:
     *   • A brand-new Mindbody client was created during this checkout (resolved.clientCreated)
     *   • Mindbody package sync just succeeded (we are inside `if (sync.ok)`)
     *   • This is NOT a Stripe-test → Mindbody-Test dry run (would email a real customer for nothing)
     *
     * We trigger Mindbody's own password-setup email so the customer can sign in to book classes.
     * Best-effort: a failure here MUST NOT roll the order back. We patch a structured flag so the
     * success page can fall back to "Use 'Forgot password?' on the sign-in screen" guidance.
     */
    if (resolved.clientCreated && !testModeDecision.mindbodyTest) {
      const sendWelcomePasswordEmail =
        (process.env.STRIPE_SEND_NEW_CLIENT_PASSWORD_EMAIL ?? "1").trim() !== "0";
      if (!sendWelcomePasswordEmail) {
        console.log(
          JSON.stringify({
            event: "stripe_order_welcome_email_skipped",
            orderId: order.orderId,
            clientId: resolved.clientId,
            reason: "kill_switch_off",
          }),
        );
      } else {
        const split = splitFullName(order.customerName || resolved.email || "");
        const emailRes = await sendNewClientPasswordSetupEmail(staffHeaders, {
          email: resolved.email || order.customerEmail || "",
          firstName: split.first || (order.customerEmail || "").split("@")[0] || "Member",
          lastName: split.last || "",
        });
        if (emailRes.ok) {
          await store.patch(order.orderId, {
            welcomeEmailSent: true,
            welcomeEmailError: null,
          });
          console.log(
            JSON.stringify({
              event: "stripe_order_welcome_email_sent",
              orderId: order.orderId,
              clientId: resolved.clientId,
            }),
          );
        } else {
          await store.patch(order.orderId, {
            welcomeEmailSent: false,
            welcomeEmailError: String(emailRes.error || "unknown").slice(0, 240),
          });
          console.warn(
            JSON.stringify({
              event: "stripe_order_welcome_email_failed",
              orderId: order.orderId,
              clientId: resolved.clientId,
              error: emailRes.error,
              status: "status" in emailRes ? emailRes.status : undefined,
            }),
          );
        }
      }
    }

    const resolvedClientId = resolved.clientId;
    if (resolvedClientId != null) {
      await runClassesAutoBookAfterMindbodySync(store, order.orderId, resolvedClientId);
    }

    return { ok: true, status: "mindbody_synced", noop: false };
  }

  if (sale.status === "sync_failed_retryable" || sale.retryable) {
    console.error(
      JSON.stringify({
        event: "stripe_order_sync_retryable",
        orderId: order.orderId,
        sessionId,
        reason: sale.reason || sale.status,
      }),
    );
    return {
      ok: false,
      status: sale.status,
      reason: sale.reason || sale.status,
      retryable: true,
    };
  }

  if (sale.status === "paid_but_not_synced") {
    await notifyClassesPurchaseMindbodySyncFailure(store, order.orderId, sale.reason || "mindbody_sync_rejected");
    return { ok: true, status: "paid_but_not_synced", noop: false };
  }

  return { ok: true, status: sale.status, noop: !!sale.noop };
}

/* -------------------------------------------------------------------------- */
/* Recurring membership handlers (Option A)                                   */
/* -------------------------------------------------------------------------- */

/**
 * Extract the Stripe Subscription id from an invoice object. Supports BOTH the legacy
 * top-level `invoice.subscription` shape (Stripe API ≤ `2025-…`) AND the relocated
 * `invoice.parent.subscription_details.subscription` shape introduced in API version
 * `2026-04-22.dahlia`.
 *
 * Why we need both: our Stripe SDK is pinned at `2025-08-27.basil` so OUR `invoices.retrieve(...)`
 * calls return the legacy shape. But the Stripe Dashboard webhook endpoint (where real
 * `invoice.paid` events arrive in production) sends payloads using the **endpoint's own
 * configured API version**, which today is `2026-04-22.dahlia` (Stripe's auto-pin for
 * new endpoints). The new shape has `invoice.subscription` undefined and the id under
 * `invoice.parent.subscription_details.subscription`.
 *
 * Returning empty string is the "no subscription association" signal — caller should
 * treat that as "noop, ack the webhook".
 *
 * @param {Stripe.Invoice | Record<string, unknown>} invoice
 * @returns {string}
 */
function extractInvoiceSubscriptionId(invoice) {
  if (!invoice || typeof invoice !== "object") return "";
  /** @type {unknown} */
  const legacy = /** @type {{ subscription?: unknown }} */ (invoice).subscription;
  if (typeof legacy === "string" && legacy) return legacy;
  if (legacy && typeof legacy === "object") {
    const id = /** @type {{ id?: string }} */ (legacy).id;
    if (typeof id === "string" && id) return id;
  }
  /** @type {unknown} */
  const parent = /** @type {{ parent?: unknown }} */ (invoice).parent;
  if (parent && typeof parent === "object") {
    const p = /** @type {{ type?: string; subscription_details?: unknown }} */ (parent);
    if (
      p.type === "subscription_details" &&
      p.subscription_details &&
      typeof p.subscription_details === "object"
    ) {
      const sd = /** @type {{ subscription?: unknown }} */ (p.subscription_details);
      if (typeof sd.subscription === "string" && sd.subscription) return sd.subscription;
      if (sd.subscription && typeof sd.subscription === "object") {
        const id = /** @type {{ id?: string }} */ (sd.subscription).id;
        if (typeof id === "string" && id) return id;
      }
    }
  }
  return "";
}

/**
 * Hybrid in-webhook retry budget for `invoice.paid` → Mindbody sync. Total attempts =
 * 1 + INVOICE_PAID_RETRY_BUDGET (so default 3 attempts: t0, t0+200ms, t0+1000ms).
 * Bounded between 0 and 4.
 */
function invoicePaidRetryBudget() {
  const raw = parseInt(process.env.STRIPE_INVOICE_PAID_RETRY_BUDGET || "2", 10);
  if (!Number.isFinite(raw)) return 2;
  return Math.min(Math.max(raw, 0), 4);
}

/**
 * Backoff schedule (ms) per retry index. Kept small so the webhook stays under Stripe's
 * 10-second budget. We never sleep on the FINAL attempt — caller already returns after.
 *
 * @param {number} retryIdx 0-based (0 = first retry after the initial attempt).
 */
function invoicePaidBackoffMs(retryIdx) {
  if (retryIdx <= 0) return 200;
  if (retryIdx === 1) return 800;
  return 1500;
}

/** @param {number} ms */
async function sleep(ms) {
  if (!(ms > 0)) return;
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Resolve a SubscriptionRecord from a Stripe object that references a subscription. Handles
 * the race condition where `invoice.paid` may arrive BEFORE `checkout.session.completed`,
 * leaving our record's `stripeSubscriptionId` still at its `pending_<id>` placeholder.
 *
 * Resolution order:
 *   1. `getByStripeSubscriptionId(stripeSubId)` — fastest path once binding has happened.
 *   2. Retrieve the live Stripe Subscription, read `metadata.subscriptionId`, and `get(id)` —
 *      relies on `subscription_data.metadata` we set at create-session time.
 *   3. Fall back to `getByCheckoutSessionId(...)` if the caller supplied a session id.
 *
 * Returns null when the record genuinely doesn't exist (typically a Stripe event for a
 * subscription created outside our app, e.g. via Dashboard); the caller should ack with 200
 * to stop retries.
 *
 * @param {Stripe} stripe
 * @param {ReturnType<typeof openSubscriptionStore>} subStore
 * @param {{ stripeSubId?: string | null; checkoutSessionId?: string | null; eventLabel: string }} input
 * @returns {Promise<{ record: import("./stripe-subscription-store.mjs").SubscriptionRecord | null; resolvedVia: "byStripeSub"|"byMetadata"|"bySession"|"none"; needsBindUpdate: boolean }>}
 */
async function resolveSubscriptionRecord(stripe, subStore, input) {
  const stripeSubId = (input.stripeSubId || "").trim();
  if (stripeSubId) {
    const r = await subStore.getByStripeSubscriptionId(stripeSubId);
    if (r) {
      /**
       * Auto-heal: the byStripe index points at this record, but the record's own
       * `stripeSubscriptionId` field may still be the `pending_<id>` placeholder
       * from create-session time (this happened for records written before the
       * `patch()` immutability bugfix in stripe-subscription-store.mjs). Patch the
       * record in place so admins always see the real Stripe id. The caller doesn't
       * need to handle this flag itself.
       */
      if (r.stripeSubscriptionId !== stripeSubId) {
        try {
          const healed = await subStore.patch(r.id, {
            stripeSubscriptionId: stripeSubId,
          });
          if (healed) {
            console.log(
              JSON.stringify({
                event: "stripe_subscription_auto_heal_stripeSubId",
                subscriptionId: r.id,
                from: r.stripeSubscriptionId,
                to: stripeSubId,
                eventLabel: input.eventLabel,
              }),
            );
            return { record: healed, resolvedVia: "byStripeSub", needsBindUpdate: false };
          }
        } catch (e) {
          console.warn(
            JSON.stringify({
              event: "stripe_subscription_auto_heal_failed",
              subscriptionId: r.id,
              detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 200),
              eventLabel: input.eventLabel,
            }),
          );
        }
      }
      return { record: r, resolvedVia: "byStripeSub", needsBindUpdate: false };
    }
    /** Try metadata fallback. */
    try {
      const sub = await stripe.subscriptions.retrieve(stripeSubId);
      const md = sub && sub.metadata ? sub.metadata : {};
      const ourId = typeof md.subscriptionId === "string" ? md.subscriptionId : "";
      if (ourId) {
        const r2 = await subStore.get(ourId);
        if (r2) return { record: r2, resolvedVia: "byMetadata", needsBindUpdate: true };
      }
    } catch (e) {
      console.warn(
        JSON.stringify({
          event: "stripe_subscription_resolve_retrieve_failed",
          eventLabel: input.eventLabel,
          stripeSubId,
          detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 200),
        }),
      );
    }
  }
  if (input.checkoutSessionId) {
    const r = await subStore.getByCheckoutSessionId(input.checkoutSessionId);
    if (r) return { record: r, resolvedVia: "bySession", needsBindUpdate: !stripeSubId ? false : true };
  }
  return { record: null, resolvedVia: "none", needsBindUpdate: false };
}

/**
 * Handle `checkout.session.completed` for `mode: subscription` sessions. Binds the
 * Stripe Subscription id to our record (so subsequent `invoice.paid`/`subscription.updated`
 * lookups are O(1)) and patches livemode.
 *
 * Eager first-invoice sync (defence in depth):
 *   The first invoice for a Checkout-created subscription is already paid by the time
 *   `checkout.session.completed` fires (Stripe charges the card during Checkout, then
 *   creates the subscription with the invoice already in `status: "paid"`). To avoid
 *   waiting for a separately-delivered `invoice.paid` event — which can be delayed,
 *   filtered out of a `stripe listen` pipe, or lost during a deploy — we fetch the
 *   `latest_invoice` here and immediately run the same Mindbody sync that
 *   `handleInvoicePaid` runs. Idempotency in `handleInvoicePaid` (dedup by `invoice.id`
 *   in `record.invoices[]`) guarantees that a subsequent webhook delivery of
 *   `invoice.paid` for the same invoice id is a no-op.
 *
 * @param {Stripe} stripe
 * @param {Stripe.Checkout.Session} session
 * @param {ReturnType<typeof openSubscriptionStore>} subStore
 * @param {ReturnType<typeof decideTestModeBehavior>} testModeDecision
 */
async function handleSubscriptionCheckoutCompleted(stripe, session, subStore, testModeDecision) {
  const sessionId = session.id;
  const stripeSubId = typeof session.subscription === "string" ? session.subscription : "";
  const stripeCustomerId = typeof session.customer === "string" ? session.customer : "";

  const record = await subStore.getByCheckoutSessionId(sessionId);
  if (!record) {
    /**
     * Recovery is not safe for subscriptions — the consent record + commitment dates were
     * computed at create-session time. If the SubscriptionRecord is missing here, our store
     * is broken and we MUST not silently start fulfilling. Return 200 so Stripe stops
     * retrying, but log loudly. Studio admin will see the orphan in Stripe Dashboard.
     */
    console.error(
      JSON.stringify({
        event: "stripe_webhook_subscription_session_no_record",
        sessionId,
        stripeSubId: stripeSubId || null,
        customer: stripeCustomerId || null,
      }),
    );
    return { ok: true, status: "noop_no_record", noop: true };
  }

  /** @type {Partial<import("./stripe-subscription-store.mjs").SubscriptionRecord>} */
  const patch = {};
  if (stripeSubId && record.stripeSubscriptionId !== stripeSubId) {
    patch.stripeSubscriptionId = stripeSubId;
  }
  if (stripeCustomerId && record.stripeCustomerId !== stripeCustomerId) {
    patch.stripeCustomerId = stripeCustomerId;
  }
  patch.stripeLivemode = testModeDecision.stripeLivemode;
  patch.mindbodyTestModeBehavior = testModeDecision.behavior;
  await subStore.patch(record.id, patch);
  if (stripeSubId) {
    try {
      await subStore.bindStripeSubscription(stripeSubId, record.id);
    } catch (e) {
      console.warn(
        JSON.stringify({
          event: "stripe_webhook_subscription_bind_failed",
          subscriptionId: record.id,
          stripeSubId,
          detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 200),
        }),
      );
    }
  }

  console.log(
    JSON.stringify({
      event: "stripe_webhook_subscription_session_completed",
      subscriptionId: record.id,
      sessionId,
      stripeSubId: stripeSubId || null,
      stripeLivemode: testModeDecision.stripeLivemode,
      mindbodyBehavior: testModeDecision.behavior,
      currentStatus: record.status,
    }),
  );

  /* ---------------- Eager first-invoice Mindbody sync --------------------- */
  if (!stripeSubId) return { ok: true, status: record.status, noop: false };
  /**
   * Resolve the latest invoice for this subscription. We fetch it FRESH via
   * `invoices.retrieve(...)` (rather than relying on the expanded copy on the parent
   * subscription) because Stripe sometimes omits the back-reference `subscription`
   * field on invoices that are returned through `subscription.retrieve(expand)` to
   * prevent recursive expansion. Without `invoice.subscription`, `handleInvoicePaid`
   * can't resolve our SubscriptionRecord and bails out with `noop_no_record`.
   *
   * @type {Stripe.Invoice | null}
   */
  let firstInvoice = null;
  try {
    const sub = await stripe.subscriptions.retrieve(stripeSubId);
    /** @type {string | null} */
    let invoiceId = null;
    if (typeof sub.latest_invoice === "string" && sub.latest_invoice) {
      invoiceId = sub.latest_invoice;
    } else if (sub.latest_invoice && typeof sub.latest_invoice === "object") {
      const idMaybe = /** @type {{ id?: string }} */ (sub.latest_invoice).id;
      if (typeof idMaybe === "string" && idMaybe) invoiceId = idMaybe;
    }
    if (invoiceId) {
      /**
       * Expand `discounts.*` so `extractInvoiceDiscountSnapshot` can populate audit
       * fields (`couponId`, `promotionCode`) on the FIRST invoice without a second
       * round-trip inside `handleInvoicePaid`. The amount-side fields (subtotal,
       * total_discount_amounts, tax, amount_paid) are top-level and do not require
       * expansion. When `ENABLE_STRIPE_RECURRING_COUPONS` is OFF this expansion is
       * essentially free (`discounts: []`).
       */
      firstInvoice = await stripe.invoices.retrieve(invoiceId, {
        expand: ["discounts.coupon", "discounts.promotion_code"],
      });
    }
  } catch (e) {
    console.warn(
      JSON.stringify({
        event: "stripe_webhook_subscription_first_invoice_fetch_failed",
        subscriptionId: record.id,
        stripeSubId,
        detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 200),
      }),
    );
  }

  if (firstInvoice && firstInvoice.status === "paid" && (firstInvoice.amount_paid || 0) > 0) {
    /**
     * Defensive: even after a fresh `invoices.retrieve(...)`, ensure the helper
     * `extractInvoiceSubscriptionId` returns a non-empty id when called from inside
     * `handleInvoicePaid`. We force-write the legacy `invoice.subscription` field as
     * a safety net — works for both API shapes since the helper checks legacy first.
     * Stripe SDK types treat `Invoice.subscription` as readonly in newer versions but
     * the runtime field is plain JSON — a safe write-through.
     */
    if (!extractInvoiceSubscriptionId(firstInvoice)) {
      /** @type {Record<string, unknown>} */ (firstInvoice).subscription = stripeSubId;
    }
    try {
      const eagerResult = await handleInvoicePaid(stripe, firstInvoice, subStore, testModeDecision);
      console.log(
        JSON.stringify({
          event: "stripe_webhook_subscription_eager_first_invoice_synced",
          subscriptionId: record.id,
          stripeSubId,
          invoiceId: firstInvoice.id,
          eagerStatus: eagerResult.status,
          eagerNoop: eagerResult.noop === true,
        }),
      );
    } catch (e) {
      console.error(
        JSON.stringify({
          event: "stripe_webhook_subscription_eager_first_invoice_threw",
          subscriptionId: record.id,
          stripeSubId,
          invoiceId: firstInvoice.id,
          detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 240),
        }),
      );
    }
  }

  return { ok: true, status: record.status, noop: false };
}

/**
 * Sync a single paid invoice → add a Mindbody Pricing Option to the client. Reuses the
 * existing one-time helper since the operation is identical: POST `/sale/checkoutshoppingcart`
 * with one Service line + Custom payment for the actual paid amount. PayNotes carry both
 * subscriptionId and invoiceId for staff visibility.
 *
 * Hybrid retry: caller controls the loop; this helper performs ONE attempt and returns the
 * structured result.
 *
 * @param {{
 *   record: import("./stripe-subscription-store.mjs").SubscriptionRecord;
 *   invoice: Stripe.Invoice;
 *   item: import("./stripe-catalog-lib.mjs").CatalogItem;
 *   mindbodyTest: boolean;
 * }} input
 */
async function syncOneInvoiceAttempt(input) {
  const { record, invoice, item } = input;
  const snapshot = extractInvoiceDiscountSnapshot(invoice);
  const currency = (invoice.currency || record.currency || "usd").toLowerCase();
  /**
   * Use a synthetic order id that's unique per invoice. The existing helper uses this
   * value only for PayNotes + idempotency keys, never for store writes — safe to coin.
   * Format mirrors Stripe's invoice id so staff can grep both ways.
   */
  const orderIdSurrogate = `${record.id}_${invoice.id}`;
  /**
   * Mindbody Sale arithmetic — verified against the one-time NCS coupon flow:
   *   • `amountCents` (Mindbody RegularPrice) = the catalog list price for this SKU. We
   *     intentionally do NOT use `invoice.subtotal` here because the catalog price is the
   *     authoritative "what the package normally costs", which is what the studio wants
   *     reflected on the Sale. For monthly memberships these are identical except for
   *     unusual proration scenarios; if Stripe ever applies a proration credit such that
   *     `subtotal < monthlyAmountCents` we still record the catalog price as RegularPrice
   *     and let the discount line absorb the difference, mirroring the NCS path.
   *   • `paidAmountCents` (Mindbody AmountPaid) = `invoice.amount_paid`. Falls back to
   *     `monthlyAmountCents` only when Stripe omits the field (extremely rare).
   *   • `discountAmountCents` (Mindbody DiscountAmount) = sum of `total_discount_amounts`.
   *     Zero when no coupon. Mindbody validates `RegularPrice - DiscountAmount == AmountPaid`
   *     so the math must be consistent — that's the case as long as we use these three
   *     values together.
   *   • `promotionCode` / `couponId` flow into PayNotes for staff visibility.
   */
  const paidAmountCents =
    snapshot.paidCents > 0 ? snapshot.paidCents : record.monthlyAmountCents;
  return await syncOneTimePurchaseToMindbody({
    orderId: orderIdSurrogate,
    stripeCheckoutSessionId: record.stripeCheckoutSessionId || `inv_${invoice.id}`,
    localSku: record.localSku,
    clientId: record.mindbodyClientId,
    amountCents: record.monthlyAmountCents,
    paidAmountCents,
    discountAmountCents: snapshot.discountAmountCents,
    promotionCode: snapshot.promotionCode || undefined,
    couponId: snapshot.couponId || undefined,
    currency,
    mindbodyTest: input.mindbodyTest,
    item,
  });
}

/**
 * Handle `invoice.paid` — the heart of the recurring flow. Adds a Mindbody Pricing Option
 * for the corresponding subscription on every successful Stripe invoice.
 *
 * Idempotency:
 *   • If `record.invoices[]` already has an entry for this `invoice.id` AND it is `synced`
 *     (or any terminal status), we noop. This is what prevents a Stripe redelivery from
 *     adding a second Pricing Option.
 *   • If the existing entry is `paid_but_not_synced` we still noop here — the admin retry
 *     endpoint is the path for those, NOT another webhook redelivery.
 *
 * Hybrid retry:
 *   • Attempt 0: immediate.
 *   • Attempt 1+: only if previous attempt was `retryable: true` (timeout / 5xx) AND we
 *     still have budget. After exhausting budget, mark `paid_but_not_synced`.
 *
 * Test-mode safety: when `STRIPE_TEST_MODE_MINDBODY_BEHAVIOR=skip` AND the event is not
 * livemode, we record the invoice with status `test_mode_no_sync` and never call Mindbody.
 *
 * @param {Stripe} stripe
 * @param {Stripe.Invoice} invoice
 * @param {ReturnType<typeof openSubscriptionStore>} subStore
 * @param {ReturnType<typeof decideTestModeBehavior>} testModeDecision
 */
async function handleInvoicePaid(stripe, invoice, subStore, testModeDecision) {
  const stripeSubId = extractInvoiceSubscriptionId(invoice);

  const resolved = await resolveSubscriptionRecord(stripe, subStore, {
    stripeSubId,
    checkoutSessionId: null,
    eventLabel: "invoice.paid",
  });
  if (!resolved.record) {
    console.warn(
      JSON.stringify({
        event: "stripe_webhook_invoice_paid_no_record",
        stripeSubId: stripeSubId || null,
        invoiceId: invoice.id,
      }),
    );
    /** Ack with 200 so Stripe stops retrying — this is a sub we don't manage. */
    return { ok: true, status: "noop_no_record", noop: true };
  }
  const record = resolved.record;
  if (resolved.needsBindUpdate && stripeSubId) {
    await subStore.patch(record.id, { stripeSubscriptionId: stripeSubId });
    try {
      await subStore.bindStripeSubscription(stripeSubId, record.id);
    } catch {
      /* best-effort */
    }
  }

  /**
   * First-pass dedup: if our record already has a sync entry for this invoice id, the
   * full pipeline (Mindbody call + entry append) has already run to completion. This
   * is the cheap path that covers the case "we are processing a duplicate redelivery
   * minutes after the original". It is NOT sufficient by itself to prevent races —
   * see `claimInvoiceSlot` below.
   */
  const existingEntry = (record.invoices || []).find((e) => e && e.invoiceId === invoice.id);
  if (existingEntry) {
    console.log(
      JSON.stringify({
        event: "stripe_webhook_invoice_paid_dedup",
        subscriptionId: record.id,
        invoiceId: invoice.id,
        existingStatus: existingEntry.status,
        dedupVia: "record_invoices_array",
      }),
    );
    const billingReason =
      typeof invoice.billing_reason === "string" ? invoice.billing_reason : null;
    if (existingEntry.status === "synced" && typeof record.mindbodyClientId === "number") {
      await handleMembershipAutoBookWebhookRedelivery(
        subStore,
        record.id,
        invoice.id,
        billingReason,
        record.mindbodyClientId,
        {
          mindbodySaleId: existingEntry.mindbodySaleId ?? null,
          mindbodySyncSucceeded: true,
        },
      );
    }
    return { ok: true, status: existingEntry.status, noop: true };
  }

  /**
   * Compute the per-invoice snapshot ONCE so every downstream branch (cancellation guard,
   * zero-amount skip, 100%-off guard, success path, paid_but_not_synced) records the same
   * audit fields. The cents math (subtotal/discount/tax/paid) is always reliable from the
   * webhook payload; coupon identity (`couponId` / `promotionCode`) needs `discounts.*`
   * expansion which webhooks don't include — we lazy-expand only when a coupon was
   * actually used to keep the no-coupon path zero-overhead.
   *
   * Lazy expansion fails safely: amount fields stay correct, audit fields stay empty.
   * That's strictly better than the pre-coupon shape (where they were always empty).
   */
  let snapshot = extractInvoiceDiscountSnapshot(invoice);
  const currency = (invoice.currency || record.currency || "usd").toLowerCase();
  const paidAtIso =
    typeof invoice.status_transitions?.paid_at === "number"
      ? new Date(invoice.status_transitions.paid_at * 1000).toISOString()
      : new Date().toISOString();
  if (snapshot.hasDiscount && (!snapshot.couponId || !snapshot.promotionCode)) {
    try {
      const expanded = await stripe.invoices.retrieve(invoice.id, {
        expand: ["discounts.coupon", "discounts.promotion_code"],
      });
      snapshot = extractInvoiceDiscountSnapshot(expanded);
    } catch (e) {
      console.warn(
        JSON.stringify({
          event: "stripe_webhook_invoice_paid_audit_expand_failed",
          subscriptionId: record.id,
          invoiceId: invoice.id,
          detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 200),
        }),
      );
    }
  }
  /**
   * Common audit fields applied to every InvoiceSyncEntry write below — even on skip
   * paths — so the admin "failures" view and customer-support "what did the buyer pay"
   * lookup have a complete record. Spread last so caller-specific fields (status, etc.)
   * win, but coupon audit is preserved.
   */
  const auditFields = {
    subtotalCents: snapshot.subtotalCents,
    discountAmountCents: snapshot.discountAmountCents,
    taxAmountCents: snapshot.taxAmountCents,
    couponId: snapshot.couponId || undefined,
    promotionCode: snapshot.promotionCode || undefined,
  };

  /**
   * Cancellation guard (V1 policy): if the subscription is already terminally canceled
   * we MUST NOT grant new Mindbody credits, even if Stripe is delivering a late
   * `invoice.paid` (e.g., a manually-paid stale invoice, or a delayed retry of an
   * event from before cancellation). Append a `skipped_subscription_canceled` entry
   * so the studio has a clear audit trail and the cheap dedup above will catch any
   * subsequent re-delivery of the same invoice id. We DO this before the atomic
   * claim because the claim is only meaningful when we intend to call Mindbody;
   * recording a "skipped" outcome doesn't need cross-container atomicity (the
   * append itself is idempotent under the cheap dedup).
   */
  if (
    record.status === "canceled_admin" ||
    record.status === "canceled_payment_failure"
  ) {
    await subStore.appendInvoiceSync(record.id, {
      invoiceId: invoice.id,
      stripePaymentIntentId:
        typeof invoice.payment_intent === "string" ? invoice.payment_intent : undefined,
      amountPaidCents: snapshot.paidCents,
      ...auditFields,
      currency,
      paidAt: paidAtIso,
      status: "skipped_subscription_canceled",
      mindbodySaleId: null,
      mindbodyTransactionId: null,
      retryCount: 0,
      firstAttemptAt: paidAtIso,
      lastAttemptAt: paidAtIso,
      lastError: "subscription_canceled",
      lastErrorMessage: `Subscription was already ${record.status} when this invoice arrived; Mindbody not called.`.slice(
        0,
        240,
      ),
    });
    console.log(
      JSON.stringify({
        event: "stripe_webhook_invoice_paid_skipped_canceled",
        subscriptionId: record.id,
        invoiceId: invoice.id,
        recordStatus: record.status,
        amountPaidCents: snapshot.paidCents,
      }),
    );
    return { ok: true, status: "skipped_subscription_canceled", noop: false };
  }

  /**
   * Race-safe dedup: atomically claim the per-invoice slot BEFORE doing any work that
   * could create a Mindbody Sale. Two parallel handlers (e.g. the eager first-invoice
   * sync from `checkout.session.completed` and the real `invoice.paid` webhook for the
   * same first invoice) will both pass the cheap dedup above (both see empty
   * `record.invoices[]`), but only one can acquire the claim — the loser dedups here.
   * Without this, we observed 3 concurrent syncs producing 3 duplicate Mindbody Sales
   * for a single invoice on 2026-05-14 (see § 9.12 in the doc).
   */
  const claim = await subStore.claimInvoiceSlot(record.id, invoice.id, {
    sourceEventId: undefined,
  });
  if (!claim.ok) {
    console.warn(
      JSON.stringify({
        event: "stripe_webhook_invoice_paid_claim_failed",
        subscriptionId: record.id,
        invoiceId: invoice.id,
        reason: claim.reason,
      }),
    );
    /** Fail closed — do not create another Sale. Stripe will retry the webhook. */
    return { ok: false, status: "claim_store_unavailable", retryable: true };
  }
  if (!claim.acquired) {
    console.log(
      JSON.stringify({
        event: "stripe_webhook_invoice_paid_dedup",
        subscriptionId: record.id,
        invoiceId: invoice.id,
        dedupVia: "claim",
      }),
    );
    const billingReason =
      typeof invoice.billing_reason === "string" ? invoice.billing_reason : null;
    const fresh = await subStore.get(record.id);
    const syncedEntry = (fresh?.invoices || []).find((e) => e && e.invoiceId === invoice.id);
    if (
      syncedEntry?.status === "synced" &&
      fresh &&
      typeof fresh.mindbodyClientId === "number"
    ) {
      await handleMembershipAutoBookWebhookRedelivery(
        subStore,
        record.id,
        invoice.id,
        billingReason,
        fresh.mindbodyClientId,
        {
          mindbodySaleId: syncedEntry.mindbodySaleId ?? null,
          mindbodySyncSucceeded: true,
        },
      );
    }
    return { ok: true, status: "dedup_via_claim", noop: true };
  }

  /**
   * 100%-off coupon guard (V1.5 operational rule, see § 9.15): when a buyer redeems a
   * coupon that fully zeros the invoice, Stripe sets `amount_paid: 0` AND
   * `discountAmount > 0` AND `subtotal > 0`. This shape is distinct from a regular $0
   * proration credit (which has subtotal: 0). V1.5 does NOT support 100%-off because:
   *   1. Mindbody Sale would record $0 paid against a $X RegularPrice — the studio uses
   *      this path for legitimate zero-rated catalog items only, and a coupon-driven $0
   *      Sale would dirty that signal.
   *   2. Free-trial-via-coupon mixes Stripe billing semantics with a "should still grant
   *      Mindbody credits" question that V1.5 explicitly defers (we will reconsider in V2
   *      with proper Stripe trial periods).
   *
   * Operational guard is in the studio: do not create 100%-off promotion codes in
   * Stripe Dashboard for monthly SKUs. Code-side this branch is defense in depth — if
   * one slips through, we record a clear `coupon_100_percent_off_unsupported` lastError
   * and skip Mindbody. The buyer has not been charged, so this is not a billing error;
   * it is a "credits not granted" outcome that the studio can resolve manually if needed.
   */
  if (snapshot.isHundredPercentOffCoupon) {
    await subStore.appendInvoiceSync(record.id, {
      invoiceId: invoice.id,
      stripePaymentIntentId:
        typeof invoice.payment_intent === "string" ? invoice.payment_intent : undefined,
      amountPaidCents: snapshot.paidCents,
      ...auditFields,
      currency,
      paidAt: paidAtIso,
      status: "skipped_zero_amount",
      mindbodySaleId: null,
      mindbodyTransactionId: null,
      retryCount: 0,
      firstAttemptAt: paidAtIso,
      lastAttemptAt: paidAtIso,
      lastError: "coupon_100_percent_off_unsupported",
      lastErrorMessage: `100% off coupon (${snapshot.promotionCode || snapshot.couponId || "unknown"}) zeroed invoice ${invoice.id}; Mindbody not called per V1.5 policy. Subtotal $${(snapshot.subtotalCents / 100).toFixed(2)}, Discount $${(snapshot.discountAmountCents / 100).toFixed(2)}.`.slice(
        0,
        480,
      ),
    });
    console.warn(
      JSON.stringify({
        event: "stripe_webhook_invoice_paid_skipped_full_coupon",
        subscriptionId: record.id,
        invoiceId: invoice.id,
        subtotalCents: snapshot.subtotalCents,
        discountAmountCents: snapshot.discountAmountCents,
        couponId: snapshot.couponId || null,
        promotionCode: snapshot.promotionCode || null,
      }),
    );
    return { ok: true, status: "skipped_zero_amount", noop: false };
  }

  /**
   * $0 invoice (proration credit etc.) — distinct from the 100%-off case above. Record
   * but don't touch Mindbody.
   */
  if (snapshot.paidCents <= 0) {
    await subStore.appendInvoiceSync(record.id, {
      invoiceId: invoice.id,
      stripePaymentIntentId:
        typeof invoice.payment_intent === "string" ? invoice.payment_intent : undefined,
      amountPaidCents: snapshot.paidCents,
      ...auditFields,
      currency,
      paidAt: paidAtIso,
      status: "skipped_zero_amount",
      mindbodySaleId: null,
      mindbodyTransactionId: null,
      retryCount: 0,
      firstAttemptAt: paidAtIso,
      lastAttemptAt: paidAtIso,
    });
    return { ok: true, status: "skipped_zero_amount", noop: false };
  }

  /**
   * Test-mode safety: never touch Mindbody for Stripe-test invoices unless explicitly
   * configured. Same posture as the one-time path.
   */
  if (!testModeDecision.stripeLivemode && testModeDecision.behavior === "skip") {
    await subStore.appendInvoiceSync(record.id, {
      invoiceId: invoice.id,
      stripePaymentIntentId:
        typeof invoice.payment_intent === "string" ? invoice.payment_intent : undefined,
      amountPaidCents: snapshot.paidCents,
      ...auditFields,
      currency,
      paidAt: paidAtIso,
      status: "test_mode_no_sync",
      mindbodySaleId: null,
      mindbodyTransactionId: null,
      retryCount: 0,
      firstAttemptAt: paidAtIso,
      lastAttemptAt: paidAtIso,
      lastError: "stripe_test_mode_skipped",
      lastErrorMessage:
        "Stripe test-mode invoice. Mindbody sync intentionally skipped (STRIPE_TEST_MODE_MINDBODY_BEHAVIOR=skip).",
    });
    return { ok: true, status: "test_mode_no_sync", noop: false };
  }

  /** Catalog item still needed for sync helper (carries serviceId, currency, type). */
  const item = getCatalogItem(record.localSku);
  if (!item) {
    await subStore.appendInvoiceSync(record.id, {
      invoiceId: invoice.id,
      amountPaidCents: snapshot.paidCents,
      ...auditFields,
      currency,
      paidAt: paidAtIso,
      status: "paid_but_not_synced",
      mindbodySaleId: null,
      mindbodyTransactionId: null,
      retryCount: 0,
      firstAttemptAt: paidAtIso,
      lastAttemptAt: paidAtIso,
      lastError: "catalog_sku_missing",
      lastErrorMessage: `Subscription points at SKU ${record.localSku} which is no longer in the catalog.`,
      adminRetryRequired: true,
    });
    return { ok: true, status: "paid_but_not_synced", noop: false };
  }

  /* ---------------- Hybrid retry loop ------------------------------------- */
  const budget = invoicePaidRetryBudget();
  /** @type {Awaited<ReturnType<typeof syncOneInvoiceAttempt>> | null} */
  let lastResult = null;
  let attempts = 0;
  for (let i = 0; i <= budget; i += 1) {
    if (i > 0) {
      await sleep(invoicePaidBackoffMs(i - 1));
    }
    attempts += 1;
    lastResult = await syncOneInvoiceAttempt({
      record,
      invoice,
      item,
      mindbodyTest: testModeDecision.mindbodyTest,
    });
    if (lastResult.ok) break;
    if (!lastResult.retryable) break;
  }

  const nowIso = new Date().toISOString();

  if (lastResult && lastResult.ok) {
    await subStore.appendInvoiceSync(record.id, {
      invoiceId: invoice.id,
      invoiceNumber: typeof invoice.number === "string" ? Number(invoice.number) : undefined,
      stripePaymentIntentId:
        typeof invoice.payment_intent === "string" ? invoice.payment_intent : undefined,
      amountPaidCents: snapshot.paidCents,
      ...auditFields,
      currency,
      paidAt: paidAtIso,
      status: "synced",
      mindbodySaleId: lastResult.mindbodySaleId,
      mindbodyTransactionId: lastResult.mindbodyTransactionId,
      retryCount: Math.max(0, attempts - 1),
      firstAttemptAt: paidAtIso,
      lastAttemptAt: nowIso,
    });
    /** Always promote `pending_first_invoice` / `past_due` → `active` on a successful sync. */
    if (record.status !== "active") {
      await subStore.patch(record.id, { status: "active" });
    }
    console.log(
      JSON.stringify({
        event: "stripe_webhook_invoice_synced_to_mindbody",
        subscriptionId: record.id,
        invoiceId: invoice.id,
        attempts,
        mbSaleId: lastResult.mindbodySaleId,
        discountAmountCents: snapshot.discountAmountCents,
        promotionCode: snapshot.promotionCode || null,
      }),
    );
    const billingReason =
      typeof invoice.billing_reason === "string" ? invoice.billing_reason : null;
    const freshRecord = await subStore.get(record.id);
    if (freshRecord && typeof freshRecord.mindbodyClientId === "number") {
      await runClassesAutoBookAfterMembershipFirstInvoiceSync(
        subStore,
        record.id,
        freshRecord.mindbodyClientId,
        invoice.id,
        billingReason,
        {
          mindbodySaleId: lastResult.mindbodySaleId ?? null,
          mindbodySyncSucceeded: true,
        },
      );
    }
    return { ok: true, status: "synced", noop: false };
  }

  /** Failed after all retries — record paid_but_not_synced. */
  const reason = lastResult ? lastResult.reason : "no_attempts";
  const message = lastResult && "message" in lastResult ? lastResult.message || "" : "";
  await subStore.appendInvoiceSync(record.id, {
    invoiceId: invoice.id,
    invoiceNumber: typeof invoice.number === "string" ? Number(invoice.number) : undefined,
    stripePaymentIntentId:
      typeof invoice.payment_intent === "string" ? invoice.payment_intent : undefined,
    amountPaidCents: snapshot.paidCents,
    ...auditFields,
    currency,
    paidAt: paidAtIso,
    status: "paid_but_not_synced",
    mindbodySaleId: null,
    mindbodyTransactionId: null,
    retryCount: Math.max(0, attempts - 1),
    firstAttemptAt: paidAtIso,
    lastAttemptAt: nowIso,
    lastError: reason,
    lastErrorMessage: String(message || "").slice(0, 480),
    adminRetryRequired: true,
  });
  console.error(
    JSON.stringify({
      event: "stripe_webhook_invoice_paid_but_not_synced",
      subscriptionId: record.id,
      invoiceId: invoice.id,
      attempts,
      reason,
      message: String(message || "").slice(0, 240),
    }),
  );
  const billingReason =
    typeof invoice.billing_reason === "string" ? invoice.billing_reason : null;
  if (billingReason === "subscription_create") {
    await notifyClassesMembershipMindbodySyncFailure(
      subStore,
      record.id,
      invoice.id,
      reason || "mindbody_sync_failed",
    );
  }
  return { ok: true, status: "paid_but_not_synced", noop: false };
}

/**
 * Handle `invoice.payment_failed`. Append a `skipped_payment_failed` entry, patch the
 * subscription status to `past_due` (Stripe smart-retry will keep trying). On the LAST
 * automatic dunning attempt Stripe fires `customer.subscription.deleted` separately.
 *
 * @param {Stripe} stripe
 * @param {Stripe.Invoice} invoice
 * @param {ReturnType<typeof openSubscriptionStore>} subStore
 */
async function handleInvoicePaymentFailed(stripe, invoice, subStore) {
  const stripeSubId = extractInvoiceSubscriptionId(invoice);
  const resolved = await resolveSubscriptionRecord(stripe, subStore, {
    stripeSubId,
    checkoutSessionId: null,
    eventLabel: "invoice.payment_failed",
  });
  if (!resolved.record) {
    return { ok: true, status: "noop_no_record", noop: true };
  }
  const record = resolved.record;
  const nowIso = new Date().toISOString();
  /** Idempotency: don't add the same failed-invoice entry twice. */
  const existing = (record.invoices || []).find((e) => e && e.invoiceId === invoice.id);
  if (!existing) {
    await subStore.appendInvoiceSync(record.id, {
      invoiceId: invoice.id,
      stripePaymentIntentId:
        typeof invoice.payment_intent === "string" ? invoice.payment_intent : undefined,
      amountPaidCents: 0,
      currency: (invoice.currency || record.currency || "usd").toLowerCase(),
      paidAt: nowIso,
      status: "skipped_payment_failed",
      mindbodySaleId: null,
      mindbodyTransactionId: null,
      retryCount: 0,
      firstAttemptAt: nowIso,
      lastAttemptAt: nowIso,
      lastError: "stripe_invoice_payment_failed",
      lastErrorMessage: `Stripe invoice ${invoice.id} could not be collected.`.slice(0, 240),
    });
  }
  if (record.status !== "past_due" && record.status !== "canceled_admin" && record.status !== "canceled_payment_failure") {
    await subStore.patch(record.id, { status: "past_due" });
  }
  console.log(
    JSON.stringify({
      event: "stripe_webhook_invoice_payment_failed",
      subscriptionId: record.id,
      invoiceId: invoice.id,
    }),
  );
  return { ok: true, status: "past_due", noop: false };
}

/**
 * Handle `customer.subscription.updated`. Refreshes period dates + status + scheduled
 * cancellation. We never write a status that doesn't pass `VALID_SUBSCRIPTION_STATUSES`,
 * so an unexpected Stripe status (e.g. `incomplete_expired`) is mapped to the closest
 * V1 terminal.
 *
 * @param {Stripe} stripe
 * @param {Stripe.Subscription} subscription
 * @param {ReturnType<typeof openSubscriptionStore>} subStore
 */
async function handleSubscriptionUpdated(stripe, subscription, subStore) {
  const resolved = await resolveSubscriptionRecord(stripe, subStore, {
    stripeSubId: subscription.id,
    checkoutSessionId: null,
    eventLabel: "customer.subscription.updated",
  });
  if (!resolved.record) {
    return { ok: true, status: "noop_no_record", noop: true };
  }
  const record = resolved.record;
  /** @type {Partial<import("./stripe-subscription-store.mjs").SubscriptionRecord>} */
  const patch = {};
  /**
   * `current_period_start/end` are unix-seconds in Stripe API responses. Translate to
   * ISO so admin UIs can render without re-parsing.
   */
  let period = readStripeSubscriptionPeriod(subscription);
  if (period.source === "missing") {
    try {
      const live = await stripe.subscriptions.retrieve(subscription.id, { expand: ["items.data"] });
      period = readStripeSubscriptionPeriod(live);
    } catch {
      /* keep missing — Top-Up falls back to ClientService dates */
    }
  }
  if (period.start) patch.currentPeriodStart = period.start;
  if (period.end) patch.currentPeriodEnd = period.end;
  if (typeof subscription.cancel_at === "number") {
    patch.cancelAt = new Date(subscription.cancel_at * 1000).toISOString();
  } else if (subscription.cancel_at == null) {
    patch.cancelAt = null;
  }
  if (typeof subscription.canceled_at === "number") {
    patch.canceledAt = new Date(subscription.canceled_at * 1000).toISOString();
  }
  /** Status mapping. Stripe → ours. */
  const stripeStatus = subscription.status || "";
  if (stripeStatus === "active" || stripeStatus === "trialing") {
    if (record.status !== "active" && record.status !== "canceled_admin" && record.status !== "canceled_payment_failure") {
      patch.status = "active";
    }
  } else if (stripeStatus === "past_due" || stripeStatus === "unpaid") {
    if (record.status !== "canceled_admin" && record.status !== "canceled_payment_failure") {
      patch.status = "past_due";
    }
  }
  /** `incomplete*` & `canceled` are handled by checkout.session.completed / subscription.deleted respectively. */
  if (Object.keys(patch).length > 0) {
    await subStore.patch(record.id, patch);
  }
  console.log(
    JSON.stringify({
      event: "stripe_webhook_subscription_updated",
      subscriptionId: record.id,
      stripeStatus,
      patchKeys: Object.keys(patch),
    }),
  );
  return { ok: true, status: patch.status || record.status, noop: false };
}

/**
 * Handle `customer.subscription.deleted`. Final cancellation. We map the reason field to
 * either `canceled_payment_failure` (Stripe gave up after dunning) or `canceled_admin`
 * (everything else — typically the studio canceled in Dashboard).
 *
 * @param {Stripe} stripe
 * @param {Stripe.Subscription} subscription
 * @param {ReturnType<typeof openSubscriptionStore>} subStore
 */
async function handleSubscriptionDeleted(stripe, subscription, subStore) {
  const resolved = await resolveSubscriptionRecord(stripe, subStore, {
    stripeSubId: subscription.id,
    checkoutSessionId: null,
    eventLabel: "customer.subscription.deleted",
  });
  if (!resolved.record) {
    return { ok: true, status: "noop_no_record", noop: true };
  }
  const record = resolved.record;
  /** @type {string} */
  const reason =
    (subscription.cancellation_details && subscription.cancellation_details.reason) ||
    /** @type {string} */ (/** @type {{ cancellation_reason?: string }} */ (subscription).cancellation_reason ||
      "");
  /** @type {"canceled_admin" | "canceled_payment_failure"} */
  const targetStatus =
    reason === "payment_failed" ? "canceled_payment_failure" : "canceled_admin";
  const canceledAtIso =
    typeof subscription.canceled_at === "number"
      ? new Date(subscription.canceled_at * 1000).toISOString()
      : new Date().toISOString();
  await subStore.patch(record.id, {
    status: targetStatus,
    canceledAt: canceledAtIso,
    cancellationReason: String(reason || "").slice(0, 240) || null,
  });
  console.log(
    JSON.stringify({
      event: "stripe_webhook_subscription_deleted",
      subscriptionId: record.id,
      stripeSubId: subscription.id,
      reason: reason || null,
      targetStatus,
    }),
  );
  return { ok: true, status: targetStatus, noop: false };
}

/* -------------------------------------------------------------------------- */
/* Handler                                                                    */
/* -------------------------------------------------------------------------- */

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: { "Cache-Control": "no-store" }, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" });
  }

  const sk = stripeSecret();
  const whSecret = webhookSecret();
  if (!sk || !whSecret) {
    console.error(
      JSON.stringify({
        event: "stripe_webhook_misconfigured",
        hasSk: !!sk,
        hasWhSecret: !!whSecret,
      }),
    );
    return jsonResponse(503, { ok: false, error: "stripe_webhook_misconfigured" });
  }

  const { raw, sig } = rawBodyAndSignature(event);
  if (!raw || !sig) {
    return jsonResponse(400, { ok: false, error: "missing_body_or_signature" });
  }

  const stripe = new Stripe(sk, {
    apiVersion: "2025-08-27.basil",
    appInfo: { name: "amare-stripe-mindbody-onetime", version: "0.1.0" },
  });

  /** @type {Stripe.Event} */
  let evt;
  try {
    evt = await stripe.webhooks.constructEventAsync(raw, sig, whSecret);
  } catch (e) {
    console.warn(
      JSON.stringify({
        event: "stripe_webhook_signature_failed",
        detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 200),
      }),
    );
    return jsonResponse(400, { ok: false, error: "signature_verification_failed" });
  }

  /**
   * Private-event deposits are not Mindbody orders. Handle them before opening
   * the class/membership stores so a Blobs blip there cannot block event fulfillment.
   */
  if (
    evt.type === "checkout.session.completed" ||
    evt.type === "checkout.session.async_payment_succeeded"
  ) {
    const sessionFromEvt = /** @type {Stripe.Checkout.Session} */ (evt.data.object);
    if (isEventDepositSession(sessionFromEvt)) {
      /** @type {Stripe.Checkout.Session} */
      let session = sessionFromEvt;
      try {
        session = await stripe.checkout.sessions.retrieve(sessionFromEvt.id, {
          expand: ["payment_intent", "customer_details"],
        });
      } catch {
        session = sessionFromEvt;
      }
      let outcome;
      try {
        outcome = await fulfillEventDepositSession(stripe, session, event);
      } catch (e) {
        console.error(
          JSON.stringify({
            event: "event_deposit_fulfill_threw",
            eventId: evt.id,
            sessionId: session.id,
            detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 240),
          }),
        );
        return jsonResponse(500, { ok: false, error: "event_deposit_exception" });
      }
      if (!outcome.ok && outcome.retryable) {
        return jsonResponse(503, { ok: false, error: outcome.error, retryable: true });
      }
      return jsonResponse(200, {
        received: true,
        type: evt.type,
        flow: "event_deposit",
        reservationId: outcome.id,
        status: outcome.status,
        noop: !!outcome.noop,
      });
    }
  }
  if (evt.type === "checkout.session.expired") {
    const sessionFromEvt = /** @type {Stripe.Checkout.Session} */ (evt.data.object);
    if (isEventDepositSession(sessionFromEvt)) {
      await expireEventDepositSession(sessionFromEvt, event);
      return jsonResponse(200, { received: true, type: evt.type, flow: "event_deposit" });
    }
  }

  const store = openOrderStore(event);
  const subStore = openSubscriptionStore(event);
  if (!store.available || !subStore.available) {
    /**
     * Without persistence we cannot fulfill safely. Return non-2xx so Stripe retries; if you
     * see this consistently the function is missing Blobs and you must enable it. Both
     * stores live on the same Blobs context, so they should be available or unavailable
     * together — surface the failure even if only one came back unavailable.
     */
    console.error(
      JSON.stringify({
        event: "stripe_webhook_store_unavailable",
        eventId: evt.id,
        type: evt.type,
        orderStore: store.available,
        subscriptionStore: subStore.available,
      }),
    );
    return jsonResponse(503, { ok: false, error: "store_unavailable" });
  }

  /** Most events are about Checkout Sessions. */
  if (
    evt.type === "checkout.session.completed" ||
    evt.type === "checkout.session.async_payment_succeeded"
  ) {
    /**
     * Re-fetch with expansions — the live session may have more details than the event
     * payload. We expand `discounts.coupon` and `discounts.promotion_code` so
     * `extractStripeDiscountIdentity` can read the buyer-typed code (e.g. "WELCOME20")
     * and the underlying coupon id from the promotion record. Without these expansions
     * the discount entries would be string ids only and PayNotes/audit fields would be
     * empty even when a coupon was used.
     */
    const sessionFromEvt = /** @type {Stripe.Checkout.Session} */ (evt.data.object);
    /** @type {Stripe.Checkout.Session} */
    let session;
    try {
      session = await stripe.checkout.sessions.retrieve(sessionFromEvt.id, {
        expand: [
          "payment_intent",
          "customer_details",
          "discounts.coupon",
          "discounts.promotion_code",
          /**
           * Promotion-Code-driven discounts have `discounts[].coupon === null` and the real
           * coupon nested under `discounts[].promotion_code.coupon`. Without this expansion
           * the nested coupon comes back as a string id only — which is fine for PayNotes
           * fallback, but expanding to the full object keeps the id stable across Stripe
           * API revisions and lets us read additional fields (e.g. `name`, `valid`) if we
           * ever need them downstream.
           */
          "discounts.promotion_code.coupon",
          "total_details",
          "total_details.breakdown",
        ],
      });
    } catch (e) {
      console.warn(
        JSON.stringify({
          event: "stripe_webhook_session_retrieve_failed",
          eventId: evt.id,
          sessionId: sessionFromEvt.id,
          detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 200),
        }),
      );
      session = sessionFromEvt;
    }

    const testModeDecision = decideTestModeBehavior(evt, session);
    /** Always log the decision so it shows up next to the event in your function logs. */
    console.log(
      JSON.stringify({
        event: "stripe_webhook_test_mode_decision",
        eventId: evt.id,
        sessionId: session.id,
        eventLivemode: evt.livemode === true,
        sessionLivemode: typeof session.livemode === "boolean" ? session.livemode : null,
        stripeLivemode: testModeDecision.stripeLivemode,
        behavior: testModeDecision.behavior,
        mindbodyTest: testModeDecision.mindbodyTest,
      }),
    );

    /**
     * Informational notice when `mindbody_test` is active. Mindbody's Test:true on
     * checkoutshoppingcart validates the payload without persisting (no Sale row, no Service
     * grant), but it does emit a receipt email at request time. We mitigate that with
     * `SendEmail: false` in the cart payload — but for any history before that fix landed,
     * customers may have received a real-looking receipt for a test-card payment.
     */
    if (testModeDecision.behavior === "mindbody_test") {
      console.log(
        JSON.stringify({
          event: "stripe_webhook_mindbody_test_active",
          eventId: evt.id,
          sessionId: session.id,
          note:
            "STRIPE_TEST_MODE_MINDBODY_BEHAVIOR=mindbody_test. Mindbody validates the cart payload but does NOT persist a Sale or grant Services. SendEmail is set to false on the cart, so no receipt email will be sent in this mode. Returns mock Sale ID; mbSaleId on the order record will be null.",
        }),
      );
    }

    /**
     * Subscription dispatch: when this Checkout Session was created in `mode: subscription`
     * (or its metadata says `orderType: monthly_membership`), route to the subscription
     * handler instead of `fulfillSession` (which is one-time-only). Both predicates are
     * checked so a metadata typo can't slip a subscription session into the one-time path.
     */
    const isSubscriptionSession =
      session.mode === "subscription" ||
      (session.metadata && session.metadata.orderType === "monthly_membership");
    if (isSubscriptionSession) {
      let subOutcome;
      try {
        subOutcome = await handleSubscriptionCheckoutCompleted(stripe, session, subStore, testModeDecision);
      } catch (e) {
        console.error(
          JSON.stringify({
            event: "stripe_webhook_subscription_session_threw",
            eventId: evt.id,
            sessionId: session.id,
            detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 240),
          }),
        );
        return jsonResponse(500, { ok: false, error: "subscription_session_exception" });
      }
      return jsonResponse(200, {
        received: true,
        type: evt.type,
        flow: "subscription",
        subscriptionStatus: subOutcome.status,
        noop: !!subOutcome.noop,
        stripeLivemode: testModeDecision.stripeLivemode,
        mindbodyBehavior: testModeDecision.behavior,
      });
    }

    let outcome;
    try {
      outcome = await fulfillSession(session, store, testModeDecision, {
        stripeEventId: evt.id,
        event,
      });
    } catch (e) {
      console.error(
        JSON.stringify({
          event: "stripe_webhook_fulfill_threw",
          eventId: evt.id,
          sessionId: session.id,
          detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 240),
        }),
      );
      return jsonResponse(500, { ok: false, error: "fulfill_exception" });
    }

    if (!outcome.ok && outcome.retryable) {
      return jsonResponse(503, {
        ok: false,
        error: outcome.status,
        reason: outcome.reason,
        retryable: true,
      });
    }
    return jsonResponse(200, {
      received: true,
      type: evt.type,
      orderStatus: outcome.status,
      noop: outcome.ok ? !!outcome.noop : false,
      stripeLivemode: testModeDecision.stripeLivemode,
      mindbodyBehavior: testModeDecision.behavior,
    });
  }

  if (evt.type === "checkout.session.async_payment_failed") {
    const session = /** @type {Stripe.Checkout.Session} */ (evt.data.object);
    const order = await store.getByCheckoutSessionId(session.id);
    if (order) {
      await store.patch(order.orderId, {
        stripePaymentStatus: session.payment_status || "failed",
        mindbodySyncStatus: "canceled",
        errorCode: "stripe_async_payment_failed",
      });
      await releaseTopUpForAbandonedOrder(event, order);
    }
    return jsonResponse(200, { received: true, type: evt.type });
  }

  if (evt.type === "checkout.session.expired") {
    const session = /** @type {Stripe.Checkout.Session} */ (evt.data.object);
    /**
     * One-time order branch — same as before.
     */
    const order = await store.getByCheckoutSessionId(session.id);
    if (order && order.mindbodySyncStatus === "checkout_created") {
      await store.patch(order.orderId, {
        mindbodySyncStatus: "canceled",
        errorCode: "stripe_session_expired",
      });
      console.log(
        JSON.stringify({
          event: "stripe_webhook_checkout_session_expired",
          orderId: order.orderId,
          sessionId: session.id,
          localSku: order.localSku,
          stripeCustomerId: typeof session.customer === "string" ? session.customer : null,
        }),
      );
      await releaseTopUpForAbandonedOrder(event, order);
    }
    /**
     * Subscription branch — we MUST clean up `pending_first_invoice` records whose Stripe
     * Checkout Session expired without payment, or `block_if_active_subscription` will
     * permanently lock the buyer out of any future monthly purchase. Stripe Checkout
     * Sessions for `mode: subscription` expire after 24h by default; once the session is
     * dead, the SubscriptionRecord can never reach `active` — it is a true orphan.
     *
     * Only transition records still at `pending_first_invoice` (no first invoice paid).
     * Already-active records remain untouched: an `expired` event on a session whose
     * subscription already paid would be a Stripe bug, not a buyer abandonment.
     */
    if (session.mode === "subscription") {
      const subStore = openSubscriptionStore(event);
      if (subStore.available) {
        try {
          const subRecord = await subStore.getByCheckoutSessionId(session.id);
          if (subRecord && subRecord.status === "pending_first_invoice") {
            await subStore.patch(subRecord.id, {
              status: "canceled_admin",
              canceledAt: new Date().toISOString(),
              cancelReason: "stripe_session_expired",
            });
            console.log(
              JSON.stringify({
                event: "stripe_webhook_subscription_session_expired_cleaned",
                subscriptionId: subRecord.id,
                stripeSessionId: session.id,
                mindbodyClientId: subRecord.mindbodyClientId,
              }),
            );
          }
        } catch (err) {
          console.warn(
            JSON.stringify({
              event: "stripe_webhook_subscription_session_expired_cleanup_failed",
              stripeSessionId: session.id,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      }
    }
    return jsonResponse(200, { received: true, type: evt.type });
  }

  /* ---------------- Recurring subscription events ------------------------- */
  /**
   * The events below ALWAYS resolve their Subscription record via Stripe metadata or our
   * local index — never via the one-time order store. They share the same `decideTestModeBehavior`
   * gate so a Stripe-test invoice can't accidentally credit a real Mindbody client.
   */
  if (
    evt.type === "invoice.paid" ||
    evt.type === "invoice.payment_succeeded" ||
    evt.type === "invoice.payment_failed" ||
    evt.type === "customer.subscription.updated" ||
    evt.type === "customer.subscription.deleted" ||
    evt.type === "charge.refunded"
  ) {
    /** Re-use the same test-mode decision shape the one-time path uses. No Session here. */
    const testModeDecision = decideTestModeBehavior(evt, null);
    console.log(
      JSON.stringify({
        event: "stripe_webhook_recurring_event_received",
        eventId: evt.id,
        type: evt.type,
        livemode: evt.livemode === true,
        stripeLivemode: testModeDecision.stripeLivemode,
        behavior: testModeDecision.behavior,
      }),
    );

    if (evt.type === "invoice.paid" || evt.type === "invoice.payment_succeeded") {
      const invoice = /** @type {Stripe.Invoice} */ (evt.data.object);
      let outcome;
      try {
        outcome = await handleInvoicePaid(stripe, invoice, subStore, testModeDecision);
      } catch (e) {
        console.error(
          JSON.stringify({
            event: "stripe_webhook_invoice_paid_threw",
            eventId: evt.id,
            invoiceId: invoice.id,
            detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 240),
          }),
        );
        return jsonResponse(500, { ok: false, error: "invoice_paid_exception" });
      }
      return jsonResponse(200, {
        received: true,
        type: evt.type,
        flow: "subscription",
        invoiceStatus: outcome.status,
        noop: !!outcome.noop,
      });
    }

    if (evt.type === "invoice.payment_failed") {
      const invoice = /** @type {Stripe.Invoice} */ (evt.data.object);
      let outcome;
      try {
        outcome = await handleInvoicePaymentFailed(stripe, invoice, subStore);
      } catch (e) {
        console.error(
          JSON.stringify({
            event: "stripe_webhook_invoice_payment_failed_threw",
            eventId: evt.id,
            invoiceId: invoice.id,
            detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 240),
          }),
        );
        return jsonResponse(500, { ok: false, error: "invoice_failed_exception" });
      }
      return jsonResponse(200, {
        received: true,
        type: evt.type,
        flow: "subscription",
        subscriptionStatus: outcome.status,
        noop: !!outcome.noop,
      });
    }

    if (evt.type === "customer.subscription.updated") {
      const subscription = /** @type {Stripe.Subscription} */ (evt.data.object);
      let outcome;
      try {
        outcome = await handleSubscriptionUpdated(stripe, subscription, subStore);
      } catch (e) {
        console.error(
          JSON.stringify({
            event: "stripe_webhook_subscription_updated_threw",
            eventId: evt.id,
            stripeSubId: subscription.id,
            detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 240),
          }),
        );
        return jsonResponse(500, { ok: false, error: "subscription_updated_exception" });
      }
      return jsonResponse(200, {
        received: true,
        type: evt.type,
        flow: "subscription",
        subscriptionStatus: outcome.status,
        noop: !!outcome.noop,
      });
    }

    if (evt.type === "customer.subscription.deleted") {
      const subscription = /** @type {Stripe.Subscription} */ (evt.data.object);
      let outcome;
      try {
        outcome = await handleSubscriptionDeleted(stripe, subscription, subStore);
      } catch (e) {
        console.error(
          JSON.stringify({
            event: "stripe_webhook_subscription_deleted_threw",
            eventId: evt.id,
            stripeSubId: subscription.id,
            detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 240),
          }),
        );
        return jsonResponse(500, { ok: false, error: "subscription_deleted_exception" });
      }
      return jsonResponse(200, {
        received: true,
        type: evt.type,
        flow: "subscription",
        subscriptionStatus: outcome.status,
        noop: !!outcome.noop,
      });
    }

    if (evt.type === "charge.refunded") {
      /**
       * V1: log refunds only. Studio admin handles credit removal manually in Mindbody —
       * automatic Service-credit revocation is intentionally out of scope per the V1
       * decision in docs/MEMBERSHIP-RECURRING-CHECKOUT.md.
       */
      const charge = /** @type {Stripe.Charge} */ (evt.data.object);
      console.log(
        JSON.stringify({
          event: "stripe_webhook_charge_refunded_logged_only",
          eventId: evt.id,
          chargeId: charge.id,
          paymentIntent:
            typeof charge.payment_intent === "string" ? charge.payment_intent : null,
          amountRefunded: charge.amount_refunded,
          note: "V1 logs refunds without removing Mindbody credits. Studio admin reconciles manually.",
        }),
      );
      return jsonResponse(200, { received: true, type: evt.type, flow: "log_only" });
    }
  }

  if (evt.type === "payment_intent.succeeded") {
    const paymentIntent = /** @type {Stripe.PaymentIntent} */ (evt.data.object);
    const testModeDecision = decideTestModeBehavior(evt, null);
    let outcome;
    try {
      outcome = await handleMobilePaymentIntentSucceeded(paymentIntent, store, {
        stripeEventId: evt.id,
        testModeDecision,
        event,
      });
    } catch (e) {
      console.error(
        JSON.stringify({
          event: "stripe_webhook_mobile_pi_threw",
          eventId: evt.id,
          paymentIntentId: paymentIntent.id,
          detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 240),
        }),
      );
      return jsonResponse(500, { ok: false, error: "mobile_pi_exception" });
    }
    return jsonResponse(200, {
      received: true,
      type: evt.type,
      flow: "mobile_payment_sheet",
      orderStatus: outcome.status,
      noop: !!outcome.noop,
      reason: outcome.reason || null,
      stripeLivemode: testModeDecision.stripeLivemode,
      mindbodyBehavior: testModeDecision.behavior,
    });
  }

  if (evt.type === "payment_intent.canceled" || evt.type === "payment_intent.payment_failed") {
    const paymentIntent = /** @type {Stripe.PaymentIntent} */ (evt.data.object);
    const md = paymentIntent.metadata && typeof paymentIntent.metadata === "object" ? paymentIntent.metadata : {};
    const orderId = typeof md.orderId === "string" ? md.orderId.trim() : "";
    if (orderId) {
      const order = await store.get(orderId);
      if (order) await releaseTopUpForAbandonedOrder(event, order);
    }
    return jsonResponse(200, { received: true, type: evt.type });
  }

  /** Unhandled types — ignore but acknowledge. */
  return jsonResponse(200, { received: true, ignored: true, type: evt.type });
}

export { fulfillSession };
