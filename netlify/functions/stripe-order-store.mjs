/**
 * Order store adapter for Stripe → Mindbody one-time checkout.
 *
 * Decision: Q2 = "C — Netlify Blobs now, adapter seam for later". Webhook + sync logic only ever
 * call `OrderStore.*`, so we can swap the backing store to Supabase / Postgres later without
 * touching `stripe-webhook.mjs` or `stripe-mindbody-sync-lib.mjs`.
 *
 * Two stores:
 *  • `stripe-mindbody-orders`           — keyed by orderId. Source of truth.
 *  • `stripe-mindbody-orders-by-session` — keyed by Stripe Checkout Session ID. Stores the
 *    orderId only (we re-read from the orders store) so the webhook can look up an order by
 *    session id without scanning.
 *
 * Status machine — values must match the names listed in the spec:
 *   checkout_created → payment_completed → client_resolving → (client_created|client_found)
 *     → mindbody_sync_claimed → mindbody_synced
 *   After CheckoutShoppingCart may have been sent, uncertain outcomes go to
 *   `mindbody_sync_unknown` (no automatic second cart). `mindbody_checkout_started`
 *   remains valid for historical rows.
 *   Failure terminals: paid_but_not_synced, sync_failed_retryable, sync_failed_manual_review
 *   Other: refunded, canceled
 *
 * One-time Mindbody side effect: at most one CheckoutShoppingCart per paid order.
 * `mindbody_synced` alone is not idempotency — concurrent webhook deliveries both
 * used to pass that check. Fulfillment is atomically claimed (same pattern as
 * `claimInvoiceSlot`) BEFORE the Mindbody request.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectLambda, getStore } from "@netlify/blobs";

import { atomicCreateJSON, atomicUpdateJSON } from "./blobs-conditional-create.mjs";

const ORDERS_STORE_NAME = "stripe-mindbody-orders";
const SESSION_INDEX_STORE_NAME = "stripe-mindbody-orders-by-session";
const PURCHASE_ATTEMPT_INDEX_STORE_NAME = "stripe-mindbody-orders-by-purchase-attempt";
/**
 * Per-order fulfillment claim namespace. One key per `orderId`, used as a
 * cross-container mutex so concurrent `checkout.session.completed` deliveries
 * cannot both call CheckoutShoppingCart. Mirrors `stripe-mindbody-invoice-claims`.
 */
const FULFILLMENT_CLAIMS_STORE_NAME = "stripe-mindbody-order-fulfillment-claims";
const BLOBS_STRONG = /** @type {const} */ ("strong");
const BLOBS_EVENTUAL = /** @type {const} */ ("eventual");

function blobsQaMode() {
  return (process.env.STRIPE_ORDER_STORE_BLOBS_QA || "").trim() === "1";
}

function ordersStoreName() {
  return blobsQaMode() ? `${ORDERS_STORE_NAME}-qa` : ORDERS_STORE_NAME;
}
function sessionIndexStoreName() {
  return blobsQaMode() ? `${SESSION_INDEX_STORE_NAME}-qa` : SESSION_INDEX_STORE_NAME;
}
function purchaseAttemptIndexStoreName() {
  return blobsQaMode()
    ? `${PURCHASE_ATTEMPT_INDEX_STORE_NAME}-qa`
    : PURCHASE_ATTEMPT_INDEX_STORE_NAME;
}
function fulfillmentClaimsStoreName() {
  return blobsQaMode() ? `${FULFILLMENT_CLAIMS_STORE_NAME}-qa` : FULFILLMENT_CLAIMS_STORE_NAME;
}

function netlifyCliAuthToken() {
  const configPath =
    process.platform === "win32"
      ? path.join(
          process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
          "netlify",
          "Config",
          "config.json",
        )
      : path.join(os.homedir(), ".config", "netlify", "config.json");
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    for (const user of Object.values(cfg?.users || {})) {
      const token = String(/** @type {{ auth?: { token?: string } }} */ (user)?.auth?.token || "").trim();
      if (token) return token;
    }
  } catch {
    /* ignore */
  }
  return "";
}

function linkedSiteId() {
  const fromEnv = (process.env.NETLIFY_SITE_ID || process.env.SITE_ID || "").trim();
  if (fromEnv) return fromEnv;
  try {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    const state = JSON.parse(fs.readFileSync(path.join(root, ".netlify", "state.json"), "utf8"));
    return String(state.siteId || "").trim();
  } catch {
    return "";
  }
}

/**
 * In-memory fallback for `npm run dev` (no Netlify Blobs context). Activated ONLY when
 * `STRIPE_ORDER_STORE_LOCAL_MEMORY=1` AND we are not running on Netlify (no `NETLIFY` env var).
 * Lives at module scope so create-session and the webhook (in the same Node process) share state.
 *
 * NEVER activates in production: the explicit env flag plus the Netlify-context guard make it
 * impossible to enable accidentally on a deploy.
 *
 * @type {{
 *   orders: Map<string, unknown>;
 *   sessionIndex: Map<string, unknown>;
 *   fulfillmentClaims: Map<string, unknown>;
 *   purchaseAttemptIndex: Map<string, unknown>;
 * } | null}
 */
let memoryStoresSingleton = null;

function shouldUseLocalMemoryFallback() {
  if ((process.env.NETLIFY || "").trim()) return false;
  return (process.env.STRIPE_ORDER_STORE_LOCAL_MEMORY || "").trim() === "1";
}

/**
 * Build a minimal shim that matches the subset of `@netlify/blobs` Store API we actually use:
 * `get(key, { type:"json" })`, `setJSON(key, value)`, `setJSON(key, value, { onlyIfNew })`,
 * `list({ paginate: true })`. Anything else throws.
 *
 * @param {Map<string, unknown>} backing
 */
function makeMemoryStoreShim(backing) {
  /** @type {Map<string, string>} */
  const etags = new Map();
  /** One-version-behind snapshots for `STRIPE_ORDER_STORE_STALE_GET=1` (claim CAS QA). */
  /** @type {Map<string, { data: unknown; etag: string }>} */
  const lag = new Map();
  const staleGets = (process.env.STRIPE_ORDER_STORE_STALE_GET || "").trim() === "1";
  /** @param {Map<string, unknown>} map @param {string} key */
  function bumpEtag(map, key) {
    const etag = `mem-${map.size}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    etags.set(key, etag);
    return etag;
  }
  /** @param {string} key */
  function snapshot(key) {
    const v = backing.get(key);
    const etag = etags.get(key);
    if (v == null || !etag) return null;
    return { data: JSON.parse(JSON.stringify(v)), etag };
  }
  return /** @type {import("@netlify/blobs").Store} */ (
    /** @type {unknown} */ ({
      /** @param {string} key */
      async get(key, opts) {
        const stale = staleGets ? lag.get(key) : null;
        const v = stale ? stale.data : backing.get(key);
        if (v == null) return null;
        const clone = JSON.parse(JSON.stringify(v));
        if (opts?.type === "json") return clone;
        return clone;
      },
      /** @param {string} key @param {{ type?: string }} [opts] */
      async getWithMetadata(key, opts) {
        const stale = staleGets ? lag.get(key) : null;
        if (stale) {
          const clone = JSON.parse(JSON.stringify(stale.data));
          if (opts?.type === "json") return { data: clone, etag: stale.etag };
          return { data: clone, etag: stale.etag };
        }
        const v = backing.get(key);
        if (v == null) return null;
        const etag = etags.get(key) || bumpEtag(backing, key);
        const clone = JSON.parse(JSON.stringify(v));
        if (opts?.type === "json") return { data: clone, etag };
        return { data: clone, etag };
      },
      /** @param {string} key @param {string} body @param {{ onlyIfNew?: boolean; onlyIfMatch?: string }} [opts] */
      async set(key, body, opts) {
        if (opts?.onlyIfNew && backing.has(key)) {
          return /** @type {{ modified: boolean }} */ ({ modified: false });
        }
        if (opts?.onlyIfMatch != null) {
          const cur = etags.get(key);
          if (cur !== opts.onlyIfMatch) {
            return /** @type {{ modified: boolean }} */ ({ modified: false });
          }
        }
        const prev = snapshot(key);
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          parsed = body;
        }
        backing.set(key, parsed);
        const etag = bumpEtag(backing, key);
        if (staleGets && prev) lag.set(key, prev);
        else lag.delete(key);
        return { modified: true, etag };
      },
      /** @param {string} key @param {unknown} value @param {{ onlyIfNew?: boolean; onlyIfMatch?: string }} [opts] */
      async setJSON(key, value, opts) {
        if (opts?.onlyIfNew && backing.has(key)) {
          return /** @type {{ modified: boolean }} */ ({ modified: false });
        }
        if (opts?.onlyIfMatch != null) {
          const cur = etags.get(key);
          if (cur !== opts.onlyIfMatch) {
            return /** @type {{ modified: boolean }} */ ({ modified: false });
          }
        }
        const prev = snapshot(key);
        backing.set(key, JSON.parse(JSON.stringify(value)));
        const etag = bumpEtag(backing, key);
        if (staleGets && prev) lag.set(key, prev);
        else lag.delete(key);
        return { modified: true, etag };
      },
      /** @param {string} key */
      async delete(key) {
        backing.delete(key);
        etags.delete(key);
        lag.delete(key);
      },
      /** @param {{ paginate?: boolean }} [_opts] */
      list(_opts) {
        const keys = Array.from(backing.keys());
        return /** @type {AsyncIterable<{ blobs: { key: string }[] }>} */ ({
          [Symbol.asyncIterator]() {
            let yielded = false;
            return {
              async next() {
                if (yielded) return { done: true, value: undefined };
                yielded = true;
                return { done: false, value: { blobs: keys.map((key) => ({ key })) } };
              },
            };
          },
        });
      },
    })
  );
}

/** @returns {{
 *   orders: import("@netlify/blobs").Store;
 *   sessionIndex: import("@netlify/blobs").Store;
 *   fulfillmentClaims: import("@netlify/blobs").Store;
 *   purchaseAttemptIndex: import("@netlify/blobs").Store;
 *   readConsistency: "eventual";
 * } | null} */
function openMemoryStores() {
  if (!shouldUseLocalMemoryFallback()) return null;
  if (!memoryStoresSingleton) {
    memoryStoresSingleton = {
      orders: new Map(),
      sessionIndex: new Map(),
      fulfillmentClaims: new Map(),
      purchaseAttemptIndex: new Map(),
    };
  } else if (!memoryStoresSingleton.purchaseAttemptIndex) {
    memoryStoresSingleton.purchaseAttemptIndex = new Map();
    console.warn(
      JSON.stringify({
        event: "stripe_order_store_memory_fallback_active",
        detail:
          "Using in-memory order store for local dev. NEVER use this in production. Disable by unsetting STRIPE_ORDER_STORE_LOCAL_MEMORY.",
      }),
    );
  }
  return {
    orders: makeMemoryStoreShim(memoryStoresSingleton.orders),
    sessionIndex: makeMemoryStoreShim(memoryStoresSingleton.sessionIndex),
    fulfillmentClaims: makeMemoryStoreShim(memoryStoresSingleton.fulfillmentClaims),
    purchaseAttemptIndex: makeMemoryStoreShim(memoryStoresSingleton.purchaseAttemptIndex),
    readConsistency: BLOBS_EVENTUAL,
  };
}

const VALID_STATUSES = new Set([
  "checkout_created",
  "payment_completed",
  "client_resolving",
  "client_created",
  "client_found",
  "mindbody_checkout_started",
  /**
   * Atomic fulfillment claim acquired. This handler may call CheckoutShoppingCart.
   * Concurrent losers must not. Not a customer-facing state.
   */
  "mindbody_sync_claimed",
  /**
   * CheckoutShoppingCart may already have been sent; local commit did not finish
   * (timeout / crash / uncertain response). Do NOT automatically send another cart.
   * Admin reconciles. Not a customer-facing state.
   */
  "mindbody_sync_unknown",
  "mindbody_synced",
  "paid_but_not_synced",
  "sync_failed_retryable",
  "sync_failed_manual_review",
  "manual_review",
  "refunded",
  "canceled",
  /**
   * Stripe **test-mode** event arrived and `STRIPE_TEST_MODE_MINDBODY_BEHAVIOR=skip` (the
   * default). The order is recorded for accounting but no Mindbody client/service is
   * created. Webhook returns 200 so Stripe stops retrying. See `stripe-webhook.mjs`.
   */
  "test_mode_no_sync",
]);

/**
 * @typedef {Object} OrderRecord
 * @property {string} orderId
 * @property {string} localSku
 * @property {number} amountCents Catalog **list price** in cents at time of create-session.
 *   Source of truth: `stripe-mindbody-catalog.config.json`. This value stays the list price
 *   even when a Stripe coupon discounts the actual charge — the real paid amount is in
 *   `stripeAmountTotalCents`. The Mindbody Service line item is recorded against this list
 *   price; the Stripe-side discount is propagated to Mindbody via `Items[].DiscountAmount`,
 *   and the Custom payment row carries `stripeAmountTotalCents` (so cart total = paid total
 *   and Mindbody does not raise a "calculated total mismatch").
 * @property {string} currency
 * @property {string=} stripeCheckoutSessionId
 * @property {string=} stripePaymentIntentId
 * @property {string=} stripeCustomerId
 * @property {string=} stripePaymentStatus
 * @property {number=} stripeAmountTotalCents Stripe `session.amount_total` — what Stripe
 *   actually charged the buyer in cents (after coupon, after tax). Captured at webhook time
 *   from the live `checkout.sessions.retrieve(...)`. THIS is the value that gets sent to
 *   Mindbody as `Payments[0].Amount` / `AmountPaid`. Always equals `amountCents` when no
 *   discount was applied.
 * @property {number=} stripeAmountSubtotalCents Stripe `session.amount_subtotal` — pre-tax,
 *   pre-discount line-item total in cents. For our flow (single line, no tax) this should
 *   equal `amountCents`. Stored only for reconciliation/audit; not sent to Mindbody.
 * @property {number=} stripeAmountDiscountCents Stripe `session.total_details.amount_discount`
 *   — total coupon discount on the session in cents. Drives `Items[0].DiscountAmount` on the
 *   Mindbody cart item when > 0 (Mindbody Public API: `CheckoutItemWrapper.DiscountAmount`,
 *   ignored only for `Type:"Package"`; our SKUs are all `Type:"Service"`).
 * @property {string=} stripePromotionCode Human-facing promotion code the buyer typed in
 *   Stripe Checkout (e.g., "WELCOME20"), captured from the expanded `discounts[].promotion_code`
 *   on the session. Surfaced in Mindbody PayNotes for staff visibility — not used for any
 *   pricing logic on our side (Stripe already discounted the cart).
 * @property {string=} stripeCouponId Stripe coupon object id referenced by the promotion
 *   code (e.g., "abc123"). Stored alongside `stripePromotionCode` for full audit trail.
 * @property {string=} customerEmail
 * @property {string=} customerName
 * @property {string=} customerFirstName Authoritative first name. Sources, in
 *   precedence order: pre-checkout dialog (anonymous), Mindbody contact (logged-in
 *   member), or Stripe Checkout `custom_fields[first_name]` (legacy fallback). When
 *   present, takes precedence over `splitFullName(customerName)` for the Mindbody
 *   `addclient` payload — both at webhook-time and at admin retry.
 * @property {string=} customerLastName Authoritative last name. See `customerFirstName`
 *   for source precedence.
 * @property {string=} customerPhone
 * @property {number | null=} knownMindbodyClientId
 * @property {string=} amareUserId Server-resolved AMARÉ user id. Reconciliation only — not auth authority.
 * @property {string=} commerceAuthSource
 * @property {string=} commerceState
 * @property {number | null=} resolvedMindbodyClientId
 * @property {string} mindbodySyncStatus
 * @property {string | null=} mindbodySaleId
 * @property {string | null=} mindbodyTransactionId
 * @property {string | null=} mindbodyResponseSummary
 * @property {number | null=} mindbodyServiceId
 * @property {string | null=} ctaLocation
 * @property {string | null=} pageLocation
 * @property {string=} flow Product path. Existing: `stripe_to_mindbody_one_time`. Do not overload for UI.
 * @property {"hosted_checkout"|"mobile_payment_sheet"=} paymentFlow Who collected the card.
 *   Missing = legacy Hosted Checkout.
 * @property {string=} purchaseAttemptId Client-generated mobile prepare token. Not price authority.
 * @property {"creating_payment_intent"|"ready"=} prepareStatus Mobile PaymentIntent prepare state.
 * @property {string=} source
 * @property {string=} idempotencyKey
 * @property {string=} createSessionIdempotencyKey
 * @property {string=} errorCode
 * @property {string=} errorMessageSafe
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {string | null=} lastSyncAttemptAt
 * @property {number=} syncAttempts
 * @property {string | null=} fulfillmentClaimId Owner of the in-flight / completed Mindbody claim.
 * @property {string | null=} fulfillmentClaimedAt
 * @property {string | null=} fulfillmentClaimEventId Stripe event id that won the claim (observability only).
 * @property {string | null=} fulfillmentRequestSentAt Set immediately before CheckoutShoppingCart.
 * @property {string | null=} fulfillmentSyncedAt
 * @property {string | null=} ncsEligibilityReason
 * @property {boolean=} expressCheckoutEligible
 * @property {string | null=} mindbodyPaymentMode
 * @property {string | null=} testMode
 * @property {boolean=} stripeLivemode True iff Stripe `event.livemode` was true. Distinguishes
 *   real test-card payments from production card payments at the webhook layer.
 * @property {"skip" | "mindbody_test" | "live"=} mindbodyTestModeBehavior The decision the
 *   webhook applied for THIS order, derived from `STRIPE_TEST_MODE_MINDBODY_BEHAVIOR` and the
 *   Stripe livemode flag.
 * @property {boolean=} clientWasNewlyCreated True iff `resolveOrCreateMindbodyClient` actually
 *   created a NEW Mindbody client for this order (vs. resolving to an existing one). Drives the
 *   "Check email + set password" UX on the success page.
 * @property {boolean=} welcomeEmailSent True iff Mindbody accepted our
 *   POST /client/sendpasswordresetemail call after a brand-new client was created. Best-effort —
 *   `false` does NOT roll back the order; staff can re-trigger from the admin endpoint.
 * @property {string | null=} welcomeEmailError When `welcomeEmailSent` is false, a short safe
 *   error code/message for ops dashboards. Never surfaced raw to customers.
 * @property {{
 *   classId: number;
 *   classStartIso: string;
 *   className?: string;
 *   selectedDayKey?: string;
 *   source: "book";
 *   waitlist: false;
 *   capturedAt: string;
 *   expiresAt: string;
 * }=} pendingBook Phase 1 deferred book — only when checkout originated from
 *   `classes_booking_fail_packages` with a validated `402 no_bookable_credits` intent cookie.
 * @property {{
 *   status: "pending"|"attempting"|"booked"|"class_full"|"class_past"|"no_credits_yet"|"failed"|"payment_not_applied"|"skipped";
 *   visitId?: number;
 *   usedClientServiceId?: number;
 *   paymentVerified?: boolean;
 *   attemptCount: number;
 *   lastAttemptAt?: string;
 *   firstAttemptAt?: string;
 *   lastError?: string;
 *   lastErrorMessage?: string;
 *   lastAttemptId?: string;
 *   mindbodySaleIdAtAttempt?: string | null;
 *   mindbodyConfirmationEmailSent?: boolean;
 *   confirmationEmailPending?: boolean;
 * }=} deferredBook Tracked separately from `mindbodySyncStatus` so webhook idempotency
 *   does not skip a pending auto-book after sync completes.
 * @property {string=} deferredBookConsumerAuthSealed Sealed Mindbody refresh token from
 *   checkout `mb_sess` for consumer-token reservation confirmation emails.
 * @property {"classes"|"pricing"|"unknown"=} purchaseSource Server-normalized checkout origin.
 * @property {{
 *   classId: number;
 *   reportedClassStartIso?: string | null;
 *   className?: string | null;
 *   instructorName?: string | null;
 *   selectedDayKey?: string | null;
 *   capturedAt: string;
 * }=} selectedClassContext Raw class context from /classes (not trusted for booking decisions).
 * @property {{
 *   status: "pending"|"processing"|"booked"|"already_enrolled"|"failed";
 *   attemptedAt?: string | null;
 *   completedAt?: string | null;
 *   result?: string | null;
 *   reason?: string | null;
 * }=} classesAutoBook Auto-book attempt lifecycle for /classes purchases.
 * @property {{
 *   status: "not_sent"|"sending"|"sent"|"failed";
 *   attemptedAt?: string | null;
 *   sentAt?: string | null;
 *   reason?: string | null;
 *   lastError?: string | null;
 *   checkoutSessionId?: string | null;
 *   firstInvoiceId?: string | null;
 * }=} bookingFailureAdminEmail Admin alert dedup for this purchase only.
 */

/** @returns {boolean} */
function blobsConfigured() {
  return Boolean(
    (process.env.NETLIFY_BLOBS_CONTEXT || process.env.BLOBS_CONTEXT || process.env.NETLIFY || "").trim(),
  );
}

/**
 * @param {{ blobs?: string } | unknown} [event]
 * @returns {{
 *   orders: import("@netlify/blobs").Store;
 *   sessionIndex: import("@netlify/blobs").Store;
 *   fulfillmentClaims: import("@netlify/blobs").Store;
 *   purchaseAttemptIndex: import("@netlify/blobs").Store;
 *   readConsistency: "strong";
 * } | null}
 */
function tryOpenApiOrderStores() {
  if ((process.env.NETLIFY || "").trim()) return null;
  if (!blobsQaMode()) return null;
  const siteID = linkedSiteId();
  const token = (process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_PAT || netlifyCliAuthToken()).trim();
  if (!siteID || !token) return null;
  try {
    return {
      orders: getStore({ name: ordersStoreName(), siteID, token, consistency: BLOBS_STRONG }),
      sessionIndex: getStore({ name: sessionIndexStoreName(), siteID, token, consistency: BLOBS_STRONG }),
      fulfillmentClaims: getStore({
        name: fulfillmentClaimsStoreName(),
        siteID,
        token,
        consistency: BLOBS_STRONG,
      }),
      purchaseAttemptIndex: getStore({
        name: purchaseAttemptIndexStoreName(),
        siteID,
        token,
        consistency: BLOBS_STRONG,
      }),
      readConsistency: BLOBS_STRONG,
    };
  } catch {
    return null;
  }
}

function openStores(event) {
  try {
    const api = tryOpenApiOrderStores();
    if (api) return api;
    if (
      event &&
      typeof event === "object" &&
      typeof /** @type {{ blobs?: string }} */ (event).blobs === "string"
    ) {
      connectLambda(/** @type {{ blobs: string }} */ (event));
    }
    // The implicit Function transport is edge-backed and has no uncached edge
    // endpoint. Its supported read mode is eventual; conditional writes below
    // remain authoritative through onlyIfNew / onlyIfMatch.
    const orders = getStore({ name: ordersStoreName(), consistency: BLOBS_EVENTUAL });
    const sessionIndex = getStore({ name: sessionIndexStoreName(), consistency: BLOBS_EVENTUAL });
    const fulfillmentClaims = getStore({
      name: fulfillmentClaimsStoreName(),
      consistency: BLOBS_EVENTUAL,
    });
    const purchaseAttemptIndex = getStore({
      name: purchaseAttemptIndexStoreName(),
      consistency: BLOBS_EVENTUAL,
    });
    return {
      orders,
      sessionIndex,
      fulfillmentClaims,
      purchaseAttemptIndex,
      readConsistency: BLOBS_EVENTUAL,
    };
  } catch (e) {
    if (blobsQaMode()) {
      console.warn(
        JSON.stringify({
          event: "stripe_order_store_blobs_qa_unavailable",
          detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 240),
        }),
      );
      return null;
    }
    const memFallback = openMemoryStores();
    if (memFallback) return memFallback;
    console.warn(
      JSON.stringify({
        event: "stripe_order_store_unavailable",
        detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 240),
        hint:
          shouldUseLocalMemoryFallback()
            ? undefined
            : "Set STRIPE_ORDER_STORE_LOCAL_MEMORY=1 in .env for local dev only (never in production).",
      }),
    );
    return null;
  }
}

/** @param {string} status */
export function isValidOrderStatus(status) {
  return VALID_STATUSES.has(String(status));
}

/** @param {string} orderId */
function orderKey(orderId) {
  if (typeof orderId !== "string" || !/^[A-Za-z0-9_-]{6,80}$/.test(orderId)) {
    throw new Error(`invalid_orderId: ${String(orderId).slice(0, 40)}`);
  }
  return `v1/${orderId}`;
}

/** @param {string} sessionId */
function sessionKey(sessionId) {
  if (typeof sessionId !== "string" || !/^cs_[A-Za-z0-9_-]{4,200}$/.test(sessionId)) {
    throw new Error(`invalid_checkout_session_id: ${String(sessionId).slice(0, 40)}`);
  }
  return `v1/${sessionId}`;
}

/**
 * @param {string} amareUserId
 * @param {string} sku
 * @param {string} purchaseAttemptId
 */
export function purchaseAttemptKey(amareUserId, sku, purchaseAttemptId) {
  const user = String(amareUserId || "");
  const localSku = String(sku || "");
  const attempt = String(purchaseAttemptId || "");
  if (!/^usr_[A-Za-z0-9_-]{6,80}$/.test(user)) {
    throw new Error(`invalid_amare_user_id: ${user.slice(0, 40)}`);
  }
  if (!/^[a-z0-9_]{6,80}$/.test(localSku)) {
    throw new Error(`invalid_sku: ${localSku.slice(0, 40)}`);
  }
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(attempt)) {
    throw new Error(`invalid_purchaseAttemptId: ${attempt.slice(0, 40)}`);
  }
  return `v1/${user}/${localSku}/${attempt}`;
}

/** Discovery pointer only. OrderRecord remains fulfillment authority. */
export function mobilePendingUserKey(amareUserId) {
  const user = String(amareUserId || "");
  if (!/^usr_[A-Za-z0-9_-]{6,80}$/.test(user)) {
    throw new Error(`invalid_amare_user_id: ${user.slice(0, 40)}`);
  }
  return `pending-user/v1/${user}`;
}

/** @param {string} orderId */
function fulfillmentClaimKey(orderId) {
  return `claim/${orderKey(orderId)}`;
}

export function newFulfillmentAttemptId() {
  const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const bytes = new Uint8Array(10);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return `ful_${out}`;
}

const FULFILLMENT_LOCK_STATUSES = new Set([
  "mindbody_synced",
  "mindbody_sync_unknown",
  "mindbody_sync_claimed",
  "refunded",
  "test_mode_no_sync",
]);

const FULFILLMENT_NOT_ELIGIBLE = new Set(["refunded", "test_mode_no_sync", "canceled"]);

/**
 * @typedef {"CLAIMED" | "ALREADY_SYNCED" | "IN_PROGRESS" | "UNKNOWN" | "NOT_ELIGIBLE"} OneTimeClaimOutcome
 */

/**
 * Losing writers must not clobber fulfillment authority.
 * Welcome-email / auto-book patches may still land on a synced order.
 *
 * @param {OrderRecord} before
 * @param {Partial<OrderRecord>} partial
 * @returns {OrderRecord}
 */
function mergeOrderPatch(before, partial) {
  const now = new Date().toISOString();
  /** @type {OrderRecord} */
  const next = {
    ...before,
    ...partial,
    orderId: before.orderId,
    createdAt: before.createdAt,
    updatedAt: now,
  };

  if (FULFILLMENT_LOCK_STATUSES.has(before.mindbodySyncStatus)) {
    next.mindbodySyncStatus = before.mindbodySyncStatus;
    if (before.mindbodySaleId) next.mindbodySaleId = before.mindbodySaleId;
    if (before.fulfillmentClaimId) next.fulfillmentClaimId = before.fulfillmentClaimId;
    next.syncAttempts = before.syncAttempts || 0;
    if (before.fulfillmentClaimedAt) next.fulfillmentClaimedAt = before.fulfillmentClaimedAt;
    if (before.fulfillmentSyncedAt) next.fulfillmentSyncedAt = before.fulfillmentSyncedAt;
  }

  if (
    before.mindbodySaleId &&
    partial.mindbodySaleId &&
    String(partial.mindbodySaleId) !== String(before.mindbodySaleId)
  ) {
    next.mindbodySaleId = before.mindbodySaleId;
  }

  const beforeAttempts = Number(before.syncAttempts) || 0;
  const requestedAttempts = Number(partial.syncAttempts);
  next.syncAttempts = Number.isFinite(requestedAttempts)
    ? Math.max(beforeAttempts, requestedAttempts)
    : beforeAttempts;

  if (
    before.fulfillmentClaimId &&
    partial.fulfillmentClaimId &&
    partial.fulfillmentClaimId !== before.fulfillmentClaimId
  ) {
    next.fulfillmentClaimId = before.fulfillmentClaimId;
  }

  return next;
}

/**
 * @param {OrderRecord | null} order
 * @returns {OneTimeClaimOutcome | null}
 */
function classifyExistingFulfillment(order) {
  if (!order) return "NOT_ELIGIBLE";
  if (order.mindbodySyncStatus === "mindbody_synced") return "ALREADY_SYNCED";
  if (order.mindbodySyncStatus === "mindbody_sync_unknown") return "UNKNOWN";
  if (FULFILLMENT_NOT_ELIGIBLE.has(order.mindbodySyncStatus)) return "NOT_ELIGIBLE";
  if (order.mindbodySyncStatus === "mindbody_sync_claimed") return "IN_PROGRESS";
  if (order.mindbodySyncStatus === "mindbody_checkout_started") return "IN_PROGRESS";
  return null;
}

/**
 * @param {{ blobs?: string } | unknown} [event]
 * @returns {{
 *   get: (orderId: string) => Promise<OrderRecord | null>,
 *   put: (record: OrderRecord, opts?: { onlyIfNew?: boolean }) => Promise<{ ok: true; created: boolean } | { ok: false; reason: string }>,
 *   patch: (orderId: string, partial: Partial<OrderRecord> & { mindbodySyncStatus?: string }) => Promise<OrderRecord | null>,
 *   mutate: (
 *     orderId: string,
 *     fn: (current: OrderRecord) => OrderRecord | null | Promise<OrderRecord | null>,
 *   ) => Promise<{ ok: true; record: OrderRecord; modified: boolean } | { ok: false; reason: string }>,
 *   listByStatus: (status: string, opts?: { limit?: number }) => Promise<OrderRecord[]>,
 *   getByCheckoutSessionId: (sessionId: string) => Promise<OrderRecord | null>,
 *   bindSession: (sessionId: string, orderId: string) => Promise<void>,
 *   bindPurchaseAttempt: (
 *     amareUserId: string,
 *     sku: string,
 *     purchaseAttemptId: string,
 *     orderId: string,
 *   ) => Promise<{ created: boolean; orderId: string | null }>,
 *   getByPurchaseAttempt: (
 *     amareUserId: string,
 *     sku: string,
 *     purchaseAttemptId: string,
 *   ) => Promise<OrderRecord | null>,
   *   claimOneTimeFulfillment: (
   *     orderId: string,
   *     meta?: { stripeEventId?: string; attemptId?: string },
   *   ) => Promise<
   *     | { ok: true; outcome: "CLAIMED"; attemptId: string; record: OrderRecord; etag?: string }
   *     | { ok: true; outcome: Exclude<OneTimeClaimOutcome, "CLAIMED">; attemptId?: string; record: OrderRecord | null }
   *     | { ok: false; reason: string }
   *   >,
   *   releaseOneTimeFulfillmentClaim: (
   *     orderId: string,
   *     attemptId: string,
   *     nextStatus: string,
   *     extra?: Partial<OrderRecord>,
   *     expected?: { record: OrderRecord; etag: string },
   *   ) => Promise<{ ok: true; record: OrderRecord; outcome: "RELEASED" } | { ok: false; reason: string; record?: OrderRecord | null }>,
   *   markOneTimeFulfillmentRequestSent: (
   *     orderId: string,
   *     attemptId: string,
   *     expected?: { record: OrderRecord; etag: string },
   *   ) => Promise<{ ok: true; record: OrderRecord; etag?: string } | { ok: false; reason: string }>,
 *   completeOneTimeFulfillment: (
 *     orderId: string,
 *     attemptId: string,
 *     result: {
 *       mindbodySaleId?: string | null;
 *       mindbodyTransactionId?: string | null;
 *       mindbodyResponseSummary?: string | null;
 *       mindbodyPaymentMode?: string | null;
 *       resolvedMindbodyClientId?: number | null;
 *     },
 *     expected?: { record: OrderRecord; etag: string },
   *   ) => Promise<{ ok: true; record: OrderRecord; outcome: "COMPLETED"|"ALREADY_SYNCED" } | { ok: false; reason: string; record?: OrderRecord | null }>,
 *   markOneTimeFulfillmentUnknown: (
 *     orderId: string,
 *     attemptId: string,
 *     reason: string,
 *     message?: string,
 *     expected?: { record: OrderRecord; etag: string },
   *   ) => Promise<{ ok: true; record: OrderRecord; outcome: "MARKED_UNKNOWN"|"ALREADY_UNKNOWN"|"ALREADY_SYNCED" } | { ok: false; reason: string; record?: OrderRecord | null }>,
 *   reconcileOneTimeFulfillment: (
 *     orderId: string,
 *     result: { mindbodySaleId: string; note?: string },
 *   ) => Promise<{ ok: true; record: OrderRecord } | { ok: false; reason: string }>,
 *   available: boolean,
 * }}
 */
export function openOrderStore(event) {
  const stores = openStores(event);
  /** @type {boolean} */
  const available = !!stores;

  /** @param {string} id */
  async function get(id) {
    if (!stores) return null;
    const key = orderKey(id);
    /** @type {unknown} */
    const cur = await stores.orders.get(key, {
      type: "json",
      consistency: stores.readConsistency,
    });
    if (!cur || typeof cur !== "object") return null;
    return /** @type {OrderRecord} */ (cur);
  }

  /**
   * @param {OrderRecord} record
   * @param {{ onlyIfNew?: boolean }} [opts]
   */
  async function put(record, opts) {
    if (!stores) return { ok: false, reason: "store_unavailable" };
    if (!record || typeof record !== "object") return { ok: false, reason: "invalid_record" };
    if (!record.orderId) return { ok: false, reason: "missing_orderId" };
    if (!record.mindbodySyncStatus || !isValidOrderStatus(record.mindbodySyncStatus)) {
      return { ok: false, reason: "invalid_status" };
    }
    const key = orderKey(record.orderId);
    const now = new Date().toISOString();
    /** @type {OrderRecord} */
    const toWrite = {
      ...record,
      createdAt: record.createdAt || now,
      updatedAt: now,
    };
    if (opts?.onlyIfNew) {
      /**
       * MUST go through `atomicCreateJSON` — `setJSON(..., { onlyIfNew: true })`
       * is silently broken in @netlify/blobs (see `blobs-conditional-create.mjs`).
       */
      const wr = await atomicCreateJSON(stores.orders, key, toWrite);
      if (!wr.modified) return { ok: false, reason: "exists" };
      return { ok: true, created: true };
    }
    await stores.orders.setJSON(key, toWrite);
    return { ok: true, created: true };
  }

  /**
   * @param {string} id
   * @param {Partial<OrderRecord>} partial
   * @returns {Promise<OrderRecord | null>}
   */
  async function patch(id, partial) {
    if (!stores) return null;
    if (
      partial.mindbodySyncStatus &&
      !isValidOrderStatus(partial.mindbodySyncStatus)
    ) {
      throw new Error(`invalid_status_in_patch: ${partial.mindbodySyncStatus}`);
    }
    const key = orderKey(id);
    const result = await atomicUpdateJSON(
      stores.orders,
      key,
      /** @param {OrderRecord} before */
      (before) => mergeOrderPatch(before, partial),
      { readConsistency: stores.readConsistency },
    );
    if (!result.ok) {
      if (result.reason === "not_found") return null;
      console.warn(
        JSON.stringify({
          event: "stripe_order_patch_cas_failed",
          orderId: id,
          reason: result.reason,
        }),
      );
      return null;
    }
    return result.record;
  }

  /**
   * CAS mutate for idempotent auto-book / admin-email guards.
   *
   * @param {string} id
   * @param {(current: OrderRecord) => OrderRecord | null | Promise<OrderRecord | null>} fn
   */
  async function mutate(id, fn) {
    if (!stores) return { ok: false, reason: "store_unavailable" };
    const key = orderKey(id);
    const result = await atomicUpdateJSON(stores.orders, key, fn, {
      readConsistency: stores.readConsistency,
    });
    if (!result.ok) {
      return { ok: false, reason: result.reason };
    }
    return { ok: true, record: result.record, modified: result.modified };
  }

  /**
   * @param {string} status
   * @param {{ limit?: number }} [opts]
   * @returns {Promise<OrderRecord[]>}
   */
  async function listByStatus(status, opts) {
    if (!stores) return [];
    if (!isValidOrderStatus(status)) return [];
    const limit = Math.min(Math.max(Number(opts?.limit) || 50, 1), 500);
    /** @type {OrderRecord[]} */
    const out = [];
    /** Netlify Blobs `list({ paginate: true })` returns an async iterable of pages. */
    const pages = stores.orders.list({ paginate: true });
    let scanned = 0;
    const SCAN_CAP = 5000;
    for await (const page of pages) {
      const blobs = page?.blobs ?? [];
      for (const b of blobs) {
        if (out.length >= limit) break;
        scanned += 1;
        if (scanned > SCAN_CAP) break;
        const key = b?.key;
        if (typeof key !== "string") continue;
        /** @type {unknown} */
        const cur = await stores.orders.get(key, {
          type: "json",
          consistency: stores.readConsistency,
        });
        if (cur && typeof cur === "object") {
          const o = /** @type {OrderRecord} */ (cur);
          if (o.mindbodySyncStatus === status) out.push(o);
        }
      }
      if (out.length >= limit || scanned > SCAN_CAP) break;
    }
    /** Newest first by updatedAt. */
    out.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    return out;
  }

  /** @param {string} sessionId */
  async function getByCheckoutSessionId(sessionId) {
    if (!stores) return null;
    let key;
    try {
      key = sessionKey(sessionId);
    } catch {
      return null;
    }
    /** @type {unknown} */
    const idx = await stores.sessionIndex.get(key, { type: "json" });
    if (!idx || typeof idx !== "object") return null;
    const orderId = /** @type {{ orderId?: unknown }} */ (idx).orderId;
    if (typeof orderId !== "string" || !orderId) return null;
    return get(orderId);
  }

  /**
   * @param {string} sessionId
   * @param {string} id
   */
  async function bindSession(sessionId, id) {
    if (!stores) return;
    const key = sessionKey(sessionId);
    await stores.sessionIndex.setJSON(key, {
      orderId: id,
      boundAt: new Date().toISOString(),
    });
  }

  /**
   * Atomically bind amare_user_id + sku + purchaseAttemptId to one orderId.
   * Concurrent prepares must share that orderId.
   *
   * @param {string} amareUserId
   * @param {string} sku
   * @param {string} purchaseAttemptId
   * @param {string} orderId
   */
  async function bindPurchaseAttempt(amareUserId, sku, purchaseAttemptId, orderId) {
    if (!stores) return { created: false, orderId: null };
    let key;
    try {
      key = purchaseAttemptKey(amareUserId, sku, purchaseAttemptId);
    } catch {
      return { created: false, orderId: null };
    }
    const wr = await atomicCreateJSON(stores.purchaseAttemptIndex, key, {
      orderId,
      boundAt: new Date().toISOString(),
    });
    if (wr.modified) return { created: true, orderId };
    /** @type {unknown} */
    const idx = await stores.purchaseAttemptIndex.get(key, { type: "json" });
    const existing =
      idx && typeof idx === "object" ? /** @type {{ orderId?: unknown }} */ (idx).orderId : null;
    return {
      created: false,
      orderId: typeof existing === "string" && existing ? existing : null,
    };
  }

  /**
   * @param {string} amareUserId
   * @param {string} sku
   * @param {string} purchaseAttemptId
   */
  async function getByPurchaseAttempt(amareUserId, sku, purchaseAttemptId) {
    if (!stores) return null;
    let key;
    try {
      key = purchaseAttemptKey(amareUserId, sku, purchaseAttemptId);
    } catch {
      return null;
    }
    /** @type {unknown} */
    const idx = await stores.purchaseAttemptIndex.get(key, { type: "json" });
    if (!idx || typeof idx !== "object") return null;
    const boundId = /** @type {{ orderId?: unknown }} */ (idx).orderId;
    if (typeof boundId !== "string" || !boundId) return null;
    return get(boundId);
  }

  /**
   * @param {string} amareUserId
   * @param {{ orderId: string; sku: string; purchaseAttemptId: string; createdAt?: string }} entry
   */
  async function upsertMobilePending(amareUserId, entry) {
    if (!stores) return;
    let key;
    try {
      key = mobilePendingUserKey(amareUserId);
    } catch {
      return;
    }
    const sku = String(entry?.sku || "").trim();
    const orderId = String(entry?.orderId || "").trim();
    const purchaseAttemptId = String(entry?.purchaseAttemptId || "").trim();
    if (!sku || !orderId || !purchaseAttemptId) return;
    /** @type {unknown} */
    const cur = await stores.purchaseAttemptIndex.get(key, { type: "json" });
    const items = Array.isArray(/** @type {{ items?: unknown }} */ (cur || {}).items)
      ? /** @type {{ items: unknown[] }} */ (cur).items.filter((row) => {
          return row && typeof row === "object" && /** @type {{ sku?: unknown }} */ (row).sku !== sku;
        })
      : [];
    items.push({
      orderId,
      sku,
      purchaseAttemptId,
      createdAt: entry.createdAt || new Date().toISOString(),
    });
    await stores.purchaseAttemptIndex.setJSON(key, { items: items.slice(-10) });
  }

  /** @param {string} amareUserId */
  async function listMobilePending(amareUserId) {
    if (!stores) return [];
    let key;
    try {
      key = mobilePendingUserKey(amareUserId);
    } catch {
      return [];
    }
    /** @type {unknown} */
    const cur = await stores.purchaseAttemptIndex.get(key, { type: "json" });
    const items = Array.isArray(/** @type {{ items?: unknown }} */ (cur || {}).items)
      ? /** @type {{ items: unknown[] }} */ (cur).items
      : [];
    return items.filter((row) => row && typeof row === "object");
  }

  /**
   * @param {string} orderId
   */
  async function deleteFulfillmentClaim(orderId) {
    if (!stores) return;
    const key = fulfillmentClaimKey(orderId);
    /** @type {{ delete?: (key: string) => Promise<unknown> }} */
    const claimsStore = /** @type {unknown} */ (stores.fulfillmentClaims);
    if (typeof claimsStore.delete === "function") {
      await claimsStore.delete(key);
    }
  }

  /**
   * Atomic per-order claim. ORDER-scoped (not Stripe event id). Only one caller
   * receives CLAIMED and may send CheckoutShoppingCart.
   *
   * @param {string} orderId
   * @param {{ stripeEventId?: string; attemptId?: string }} [meta]
   */
  async function claimOneTimeFulfillment(orderId, meta) {
    if (!stores) return { ok: false, reason: "store_unavailable" };
    let current;
    try {
      current = await get(orderId);
    } catch {
      return { ok: false, reason: "invalid_orderId" };
    }
    if (!current) {
      // A newly-created Blob should be immediately visible, but a transient
      // read miss must never become a permanent NOT_ELIGIBLE acknowledgment.
      return { ok: false, reason: "order_not_found" };
    }
    const existing = classifyExistingFulfillment(current);
    if (existing) {
      return { ok: true, outcome: existing, record: current };
    }

    const attemptId =
      typeof meta?.attemptId === "string" && meta.attemptId.startsWith("ful_")
        ? meta.attemptId
        : newFulfillmentAttemptId();
    const stripeEventId =
      typeof meta?.stripeEventId === "string" && meta.stripeEventId
        ? meta.stripeEventId.slice(0, 200)
        : null;
    const claimedAt = new Date().toISOString();
    const wr = await atomicCreateJSON(stores.fulfillmentClaims, fulfillmentClaimKey(orderId), {
      orderId,
      attemptId,
      stripeEventId,
      claimedAt,
    });
    if (!wr.modified) {
      const latest = await get(orderId);
      const loser = classifyExistingFulfillment(latest) || "IN_PROGRESS";
      return { ok: true, outcome: loser, record: latest };
    }

    const cas = await atomicUpdateJSON(
      stores.orders,
      orderKey(orderId),
      /** @param {OrderRecord} before */
      (before) => {
        const blocked = classifyExistingFulfillment(before);
        if (blocked) return null;
        return {
          ...before,
          mindbodySyncStatus: "mindbody_sync_claimed",
          fulfillmentClaimId: attemptId,
          fulfillmentClaimedAt: claimedAt,
          fulfillmentClaimEventId: stripeEventId,
          fulfillmentRequestSentAt: null,
          lastSyncAttemptAt: claimedAt,
          syncAttempts: (before.syncAttempts || 0) + 1,
          errorCode: undefined,
          errorMessageSafe: undefined,
          updatedAt: claimedAt,
        };
      },
      { readConsistency: stores.readConsistency },
    );
    if (!cas.ok) {
      if (cas.reason === "no_op" || cas.reason === "not_found") {
        const latest = await get(orderId);
        const blocked = classifyExistingFulfillment(latest) || "IN_PROGRESS";
        return { ok: true, outcome: blocked, record: latest };
      }
      return { ok: false, reason: cas.reason };
    }
    if (!cas.modified) {
      const latest = cas.record || (await get(orderId));
      const blocked = classifyExistingFulfillment(latest) || "IN_PROGRESS";
      return { ok: true, outcome: blocked, record: latest };
    }
    return { ok: true, outcome: "CLAIMED", attemptId, record: cas.record, etag: cas.etag };
  }

  /**
   * Release a claim after a failure that happened BEFORE CheckoutShoppingCart
   * was sent. Lets Stripe/admin retry. Never call this after the request may
   * have reached Mindbody.
   *
   * @param {string} orderId
   * @param {string} attemptId
   * @param {string} nextStatus
   * @param {Partial<OrderRecord>} [extra]
   * @param {{ record: OrderRecord; etag: string }} [expected]
   */
  async function releaseOneTimeFulfillmentClaim(orderId, attemptId, nextStatus, extra, expected) {
    if (!stores) return { ok: false, reason: "store_unavailable" };
    if (!isValidOrderStatus(nextStatus)) return { ok: false, reason: "invalid_status" };
    if (nextStatus === "mindbody_synced") return { ok: false, reason: "cannot_release_to_synced" };
    const cas = await atomicUpdateJSON(
      stores.orders,
      orderKey(orderId),
      /** @param {OrderRecord} before */
      (before) => {
        if (before.mindbodySyncStatus === "mindbody_synced") return null;
        if (before.mindbodySyncStatus === "mindbody_sync_unknown") return null;
        if (before.mindbodySyncStatus !== "mindbody_sync_claimed") return null;
        if (before.fulfillmentClaimId !== attemptId) return null;
        return {
          ...before,
          ...(extra || {}),
          mindbodySyncStatus: nextStatus,
          fulfillmentClaimId: null,
          fulfillmentRequestSentAt: null,
          lastSyncAttemptAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      },
      {
        ...(expected && expected.etag ? { expected } : {}),
        readConsistency: stores.readConsistency,
      },
    );
    if (!cas.ok) return { ok: false, reason: cas.reason };
    if (!cas.modified) {
      const latest = cas.record;
      if (latest?.mindbodySyncStatus === "mindbody_synced") {
        return { ok: false, reason: "already_synced", record: latest };
      }
      if (latest?.mindbodySyncStatus === "mindbody_sync_unknown") {
        return { ok: false, reason: "unknown", record: latest };
      }
      if (latest?.fulfillmentClaimId !== attemptId) {
        return { ok: false, reason: "not_claim_owner", record: latest };
      }
      return { ok: false, reason: "not_claimed", record: latest };
    }
    // The order CAS proves this exact attempt owned and released the claim.
    // Never delete the mutex on any no-op or ownership-failure path.
    await deleteFulfillmentClaim(orderId);
    return { ok: true, record: cas.record, outcome: "RELEASED" };
  }

  /**
   * @param {string} orderId
   * @param {string} attemptId
   * @param {{ record: OrderRecord; etag: string }} [expected]
   */
  async function markOneTimeFulfillmentRequestSent(orderId, attemptId, expected) {
    if (!stores) return { ok: false, reason: "store_unavailable" };
    const sentAt = new Date().toISOString();
    const cas = await atomicUpdateJSON(
      stores.orders,
      orderKey(orderId),
      /** @param {OrderRecord} before */
      (before) => {
        if (before.mindbodySyncStatus === "mindbody_synced") return null;
        if (before.mindbodySyncStatus === "mindbody_sync_unknown") return null;
        if (before.fulfillmentClaimId !== attemptId) return null;
        return {
          ...before,
          fulfillmentRequestSentAt: sentAt,
          lastSyncAttemptAt: sentAt,
          updatedAt: sentAt,
        };
      },
      {
        ...(expected && expected.etag ? { expected } : {}),
        readConsistency: stores.readConsistency,
      },
    );
    if (!cas.ok) return { ok: false, reason: cas.reason };
    if (!cas.modified) {
      const latest = cas.record;
      if (latest?.mindbodySyncStatus === "mindbody_synced") {
        return { ok: false, reason: "already_synced" };
      }
      if (latest?.mindbodySyncStatus === "mindbody_sync_unknown") {
        return { ok: false, reason: "unknown" };
      }
      return { ok: false, reason: "not_claim_owner" };
    }
    return { ok: true, record: cas.record, etag: cas.etag };
  }

  /**
   * @param {string} orderId
   * @param {string} attemptId
   * @param {{
   *   mindbodySaleId?: string | null;
   *   mindbodyTransactionId?: string | null;
   *   mindbodyResponseSummary?: string | null;
   *   mindbodyPaymentMode?: string | null;
   *   resolvedMindbodyClientId?: number | null;
   * }} result
   * @param {{ record: OrderRecord; etag: string }} [expected]
   */
  async function completeOneTimeFulfillment(orderId, attemptId, result, expected) {
    if (!stores) return { ok: false, reason: "store_unavailable" };
    const syncedAt = new Date().toISOString();
    const cas = await atomicUpdateJSON(
      stores.orders,
      orderKey(orderId),
      /** @param {OrderRecord} before */
      (before) => {
        if (before.mindbodySyncStatus === "mindbody_synced") return null;
        if (before.mindbodySyncStatus !== "mindbody_sync_claimed") return null;
        if (before.fulfillmentClaimId !== attemptId) return null;
        return {
          ...before,
          mindbodySyncStatus: "mindbody_synced",
          mindbodySaleId: result.mindbodySaleId ?? before.mindbodySaleId ?? null,
          mindbodyTransactionId: result.mindbodyTransactionId ?? before.mindbodyTransactionId ?? null,
          mindbodyResponseSummary: result.mindbodyResponseSummary ?? before.mindbodyResponseSummary ?? null,
          mindbodyPaymentMode: result.mindbodyPaymentMode ?? before.mindbodyPaymentMode ?? null,
          resolvedMindbodyClientId:
            result.resolvedMindbodyClientId ?? before.resolvedMindbodyClientId ?? null,
          fulfillmentSyncedAt: syncedAt,
          lastSyncAttemptAt: syncedAt,
          errorCode: undefined,
          errorMessageSafe: undefined,
          updatedAt: syncedAt,
        };
      },
      {
        ...(expected && expected.etag ? { expected } : {}),
        readConsistency: stores.readConsistency,
      },
    );
    if (!cas.ok) return { ok: false, reason: cas.reason };
    if (!cas.modified) {
      if (cas.record?.mindbodySyncStatus === "mindbody_synced") {
        return { ok: true, record: cas.record, outcome: "ALREADY_SYNCED" };
      }
      if (cas.record?.fulfillmentClaimId !== attemptId) {
        return { ok: false, reason: "not_claim_owner", record: cas.record };
      }
      return { ok: false, reason: "not_claimed", record: cas.record };
    }
    return { ok: true, record: cas.record, outcome: "COMPLETED" };
  }

  /**
   * @param {string} orderId
   * @param {string} attemptId
   * @param {string} reason
   * @param {string} [message]
   * @param {{ record: OrderRecord; etag: string }} [expected]
   */
  async function markOneTimeFulfillmentUnknown(orderId, attemptId, reason, message, expected) {
    if (!stores) return { ok: false, reason: "store_unavailable" };
    const now = new Date().toISOString();
    const cas = await atomicUpdateJSON(
      stores.orders,
      orderKey(orderId),
      /** @param {OrderRecord} before */
      (before) => {
        if (before.mindbodySyncStatus === "mindbody_synced") return null;
        if (before.mindbodySyncStatus === "mindbody_sync_unknown") return null;
        if (before.mindbodySyncStatus !== "mindbody_sync_claimed") return null;
        if (before.fulfillmentClaimId !== attemptId) return null;
        return {
          ...before,
          mindbodySyncStatus: "mindbody_sync_unknown",
          errorCode: reason,
          errorMessageSafe: (message || reason).slice(0, 480),
          lastSyncAttemptAt: now,
          updatedAt: now,
        };
      },
      {
        ...(expected && expected.etag ? { expected } : {}),
        readConsistency: stores.readConsistency,
      },
    );
    if (!cas.ok) return { ok: false, reason: cas.reason };
    if (!cas.modified) {
      if (cas.record?.mindbodySyncStatus === "mindbody_synced") {
        return { ok: true, record: cas.record, outcome: "ALREADY_SYNCED" };
      }
      if (cas.record?.mindbodySyncStatus === "mindbody_sync_unknown") {
        if (cas.record.fulfillmentClaimId === attemptId) {
          return { ok: true, record: cas.record, outcome: "ALREADY_UNKNOWN" };
        }
        return { ok: false, reason: "not_claim_owner", record: cas.record };
      }
      if (cas.record?.fulfillmentClaimId !== attemptId) {
        return { ok: false, reason: "not_claim_owner", record: cas.record };
      }
      return { ok: false, reason: "not_claimed", record: cas.record };
    }
    return { ok: true, record: cas.record, outcome: "MARKED_UNKNOWN" };
  }

  /**
   * Atomically age out a post-request claim. The mutex is intentionally retained:
   * `fulfillmentRequestSentAt` means CheckoutShoppingCart may have happened, so this
   * order must never become automatically claimable again.
   *
   * @param {string} orderId
   * @param {string} attemptId
   * @param {{ nowMs: number; graceMs: number }} timing
   */
  async function markOneTimeFulfillmentUnknownIfStale(orderId, attemptId, timing) {
    if (!stores) return { ok: false, reason: "store_unavailable" };
    const nowMs = Number(timing?.nowMs);
    const graceMs = Number(timing?.graceMs);
    if (!Number.isFinite(nowMs) || !Number.isFinite(graceMs) || graceMs <= 0) {
      return { ok: false, reason: "invalid_timing" };
    }
    const now = new Date(nowMs).toISOString();
    const cas = await atomicUpdateJSON(
      stores.orders,
      orderKey(orderId),
      /** @param {OrderRecord} before */
      (before) => {
        if (before.mindbodySyncStatus === "mindbody_synced") return null;
        if (before.mindbodySyncStatus === "mindbody_sync_unknown") return null;
        if (before.mindbodySyncStatus !== "mindbody_sync_claimed") return null;
        if (before.fulfillmentClaimId !== attemptId) return null;
        const sentMs = Date.parse(String(before.fulfillmentRequestSentAt || ""));
        if (!Number.isFinite(sentMs) || nowMs - sentMs < graceMs) return null;
        return {
          ...before,
          mindbodySyncStatus: "mindbody_sync_unknown",
          errorCode: "fulfillment_worker_timeout_unknown",
          errorMessageSafe:
            "The fulfillment worker ended after the Mindbody request may have been sent. Reconcile manually; do not resend CheckoutShoppingCart.",
          lastSyncAttemptAt: now,
          updatedAt: now,
        };
      },
      { readConsistency: stores.readConsistency },
    );
    if (!cas.ok) return { ok: false, reason: cas.reason };
    if (cas.modified) return { ok: true, record: cas.record, outcome: "MARKED_UNKNOWN" };
    const latest = cas.record;
    if (latest?.mindbodySyncStatus === "mindbody_synced") {
      return { ok: true, record: latest, outcome: "ALREADY_SYNCED" };
    }
    if (latest?.mindbodySyncStatus === "mindbody_sync_unknown") {
      return latest.fulfillmentClaimId === attemptId
        ? { ok: true, record: latest, outcome: "ALREADY_UNKNOWN" }
        : { ok: false, reason: "not_claim_owner", record: latest };
    }
    if (latest?.fulfillmentClaimId !== attemptId) {
      return { ok: false, reason: "not_claim_owner", record: latest };
    }
    const sentMs = Date.parse(String(latest?.fulfillmentRequestSentAt || ""));
    if (!Number.isFinite(sentMs)) return { ok: false, reason: "request_not_marked_sent", record: latest };
    if (nowMs - sentMs < graceMs) return { ok: false, reason: "within_grace", record: latest };
    return { ok: false, reason: "not_claimed", record: latest };
  }

  /**
   * Admin-only: attach a known Mindbody sale id to an UNKNOWN / unpaid-sync order
   * without sending another CheckoutShoppingCart.
   *
   * @param {string} orderId
   * @param {{ mindbodySaleId: string; note?: string }} result
   */
  async function reconcileOneTimeFulfillment(orderId, result) {
    if (!stores) return { ok: false, reason: "store_unavailable" };
    if (!/^\d{1,18}$/.test(result.mindbodySaleId)) {
      return { ok: false, reason: "invalid_sale_id" };
    }
    const syncedAt = new Date().toISOString();
    const cas = await atomicUpdateJSON(
      stores.orders,
      orderKey(orderId),
      /** @param {OrderRecord} before */
      (before) => {
        if (before.mindbodySyncStatus === "mindbody_synced") return null;
        return {
          ...before,
          mindbodySyncStatus: "mindbody_synced",
          mindbodySaleId: result.mindbodySaleId,
          fulfillmentSyncedAt: syncedAt,
          lastSyncAttemptAt: syncedAt,
          errorCode: undefined,
          errorMessageSafe: result.note ? result.note.slice(0, 240) : undefined,
          updatedAt: syncedAt,
        };
      },
      { readConsistency: stores.readConsistency },
    );
    if (!cas.ok) return { ok: false, reason: cas.reason };
    return { ok: true, record: cas.record };
  }

  return {
    get,
    put,
    patch,
    mutate,
    listByStatus,
    getByCheckoutSessionId,
    bindSession,
    bindPurchaseAttempt,
    getByPurchaseAttempt,
    upsertMobilePending,
    listMobilePending,
    claimOneTimeFulfillment,
    releaseOneTimeFulfillmentClaim,
    markOneTimeFulfillmentRequestSent,
    completeOneTimeFulfillment,
    markOneTimeFulfillmentUnknown,
    markOneTimeFulfillmentUnknownIfStale,
    reconcileOneTimeFulfillment,
    available,
  };
}

/**
 * Generate a fresh orderId. Format: `ord_<26 chars>` — URL-safe base32-ish (Crockford-friendly)
 * with low collision risk per request.
 */
export function newOrderId() {
  const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return `ord_${out}`;
}

export function resetOrderStoreMemoryForTests() {
  memoryStoresSingleton = null;
}

export const __testing = {
  ORDERS_STORE_NAME,
  SESSION_INDEX_STORE_NAME,
  PURCHASE_ATTEMPT_INDEX_STORE_NAME,
  FULFILLMENT_CLAIMS_STORE_NAME,
  VALID_STATUSES,
  blobsConfigured,
  mergeOrderPatch,
  classifyExistingFulfillment,
};
