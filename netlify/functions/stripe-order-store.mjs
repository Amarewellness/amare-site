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
 *     → mindbody_checkout_started → mindbody_synced
 *   Failure terminals: paid_but_not_synced, sync_failed_retryable, sync_failed_manual_review
 *   Other: refunded, canceled
 */

import { connectLambda, getStore } from "@netlify/blobs";

import { atomicCreateJSON } from "./blobs-conditional-create.mjs";

const ORDERS_STORE_NAME = "stripe-mindbody-orders";
const SESSION_INDEX_STORE_NAME = "stripe-mindbody-orders-by-session";

/**
 * In-memory fallback for `npm run dev` (no Netlify Blobs context). Activated ONLY when
 * `STRIPE_ORDER_STORE_LOCAL_MEMORY=1` AND we are not running on Netlify (no `NETLIFY` env var).
 * Lives at module scope so create-session and the webhook (in the same Node process) share state.
 *
 * NEVER activates in production: the explicit env flag plus the Netlify-context guard make it
 * impossible to enable accidentally on a deploy.
 *
 * @type {{ orders: Map<string, unknown>; sessionIndex: Map<string, unknown> } | null}
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
  return /** @type {import("@netlify/blobs").Store} */ (
    /** @type {unknown} */ ({
      /** @param {string} key */
      async get(key) {
        const v = backing.get(key);
        return v == null ? null : JSON.parse(JSON.stringify(v));
      },
      /** @param {string} key @param {unknown} value @param {{ onlyIfNew?: boolean }} [opts] */
      async setJSON(key, value, opts) {
        if (opts?.onlyIfNew && backing.has(key)) {
          return /** @type {{ modified: boolean }} */ ({ modified: false });
        }
        backing.set(key, JSON.parse(JSON.stringify(value)));
        return /** @type {{ modified: boolean }} */ ({ modified: true });
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

/** @returns {{ orders: import("@netlify/blobs").Store; sessionIndex: import("@netlify/blobs").Store } | null} */
function openMemoryStores() {
  if (!shouldUseLocalMemoryFallback()) return null;
  if (!memoryStoresSingleton) {
    memoryStoresSingleton = {
      orders: new Map(),
      sessionIndex: new Map(),
    };
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
  };
}

const VALID_STATUSES = new Set([
  "checkout_created",
  "payment_completed",
  "client_resolving",
  "client_created",
  "client_found",
  "mindbody_checkout_started",
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
 * @property {number | null=} resolvedMindbodyClientId
 * @property {string} mindbodySyncStatus
 * @property {string | null=} mindbodySaleId
 * @property {string | null=} mindbodyTransactionId
 * @property {string | null=} mindbodyResponseSummary
 * @property {number | null=} mindbodyServiceId
 * @property {string | null=} ctaLocation
 * @property {string | null=} pageLocation
 * @property {string=} flow
 * @property {string=} source
 * @property {string=} idempotencyKey
 * @property {string=} createSessionIdempotencyKey
 * @property {string=} errorCode
 * @property {string=} errorMessageSafe
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {string | null=} lastSyncAttemptAt
 * @property {number=} syncAttempts
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
 */

/** @returns {boolean} */
function blobsConfigured() {
  return Boolean(
    (process.env.NETLIFY_BLOBS_CONTEXT || process.env.BLOBS_CONTEXT || process.env.NETLIFY || "").trim(),
  );
}

/**
 * @param {{ blobs?: string } | unknown} [event]
 * @returns {{ orders: import("@netlify/blobs").Store; sessionIndex: import("@netlify/blobs").Store } | null}
 */
function openStores(event) {
  try {
    if (
      event &&
      typeof event === "object" &&
      typeof /** @type {{ blobs?: string }} */ (event).blobs === "string"
    ) {
      connectLambda(/** @type {{ blobs: string }} */ (event));
    }
    const orders = getStore({ name: ORDERS_STORE_NAME });
    const sessionIndex = getStore({ name: SESSION_INDEX_STORE_NAME });
    return { orders, sessionIndex };
  } catch (e) {
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
 * @param {{ blobs?: string } | unknown} [event]
 * @returns {{
 *   get: (orderId: string) => Promise<OrderRecord | null>,
 *   put: (record: OrderRecord, opts?: { onlyIfNew?: boolean }) => Promise<{ ok: true; created: boolean } | { ok: false; reason: string }>,
 *   patch: (orderId: string, partial: Partial<OrderRecord> & { mindbodySyncStatus?: string }) => Promise<OrderRecord | null>,
 *   listByStatus: (status: string, opts?: { limit?: number }) => Promise<OrderRecord[]>,
 *   getByCheckoutSessionId: (sessionId: string) => Promise<OrderRecord | null>,
 *   bindSession: (sessionId: string, orderId: string) => Promise<void>,
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
    const cur = await stores.orders.get(key, { type: "json" });
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
    const key = orderKey(id);
    /** @type {unknown} */
    const cur = await stores.orders.get(key, { type: "json" });
    if (!cur || typeof cur !== "object") return null;
    const before = /** @type {OrderRecord} */ (cur);
    if (
      partial.mindbodySyncStatus &&
      !isValidOrderStatus(partial.mindbodySyncStatus)
    ) {
      throw new Error(`invalid_status_in_patch: ${partial.mindbodySyncStatus}`);
    }
    /** @type {OrderRecord} */
    const next = {
      ...before,
      ...partial,
      orderId: before.orderId,
      createdAt: before.createdAt,
      updatedAt: new Date().toISOString(),
    };
    await stores.orders.setJSON(key, next);
    return next;
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
        const cur = await stores.orders.get(key, { type: "json" });
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

  return { get, put, patch, listByStatus, getByCheckoutSessionId, bindSession, available };
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

export const __testing = {
  ORDERS_STORE_NAME,
  SESSION_INDEX_STORE_NAME,
  VALID_STATUSES,
  blobsConfigured,
};
