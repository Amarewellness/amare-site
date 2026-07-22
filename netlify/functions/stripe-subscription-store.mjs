/**
 * Subscription store for the Stripe Recurring Membership feature (Option A).
 *
 * Mirrors the design of `stripe-order-store.mjs` (Netlify Blobs adapter, identical
 * patterns) so swapping the backing store later (Supabase / Postgres) only touches
 * this file. Webhook + create-session callers ONLY ever go through `SubscriptionStore`.
 *
 * Backing stores (all gitignored at the Blobs layer; this module owns the names):
 *   • `stripe-mindbody-subscriptions`              — keyed by our internal subscription id (`sub_amare_…`).
 *   • `stripe-mindbody-subscriptions-by-stripe`    — keyed by Stripe `sub_…` id, value `{ subscriptionId }`.
 *   • `stripe-mindbody-subscriptions-by-session`   — keyed by Stripe Checkout Session id (`cs_…`), value `{ subscriptionId }`.
 *
 * Status machine (must match `VALID_SUBSCRIPTION_STATUSES`):
 *   pending_first_invoice → active → (past_due) → active
 *   Cancellation terminals: canceled_admin, canceled_payment_failure
 *
 * Idempotency: per-invoice sync state lives inside the SubscriptionRecord's `invoices[]`
 * array (keyed by Stripe `invoice.id`). Webhook delivery retries are safe — `appendInvoiceSync`
 * refuses to add a duplicate `invoiceId`, and `markInvoiceSyncResult` operates by `invoiceId`.
 *
 * V1 explicitly does NOT track plan-change history — the studio cancels + the customer
 * re-subscribes through a fresh Checkout Session.
 *
 * See `docs/MEMBERSHIP-RECURRING-CHECKOUT.md` §4.1 for the source design.
 */

import { connectLambda, getStore } from "@netlify/blobs";

import { atomicCreateJSON, atomicUpdateJSON } from "./blobs-conditional-create.mjs";

const SUBSCRIPTIONS_STORE_NAME = "stripe-mindbody-subscriptions";
const STRIPE_INDEX_STORE_NAME = "stripe-mindbody-subscriptions-by-stripe";
const SESSION_INDEX_STORE_NAME = "stripe-mindbody-subscriptions-by-session";
/**
 * Per-invoice claim namespace. One key per `(subscriptionId, invoiceId)` pair, used as
 * a CROSS-CONTAINER mutex so concurrent `invoice.paid` deliveries (or `invoice.paid` +
 * the eager first-invoice sync from `checkout.session.completed`) cannot both call
 * Mindbody and create duplicate Sales. See `claimInvoiceSlot()` below.
 */
const INVOICE_CLAIMS_STORE_NAME = "stripe-mindbody-invoice-claims";

/* -------------------------------------------------------------------------- */
/* Local-dev memory fallback (mirrors stripe-order-store.mjs)                 */
/* -------------------------------------------------------------------------- */

/**
 * Activated ONLY when `STRIPE_SUBSCRIPTION_STORE_LOCAL_MEMORY=1` AND `NETLIFY` is unset.
 * Lives at module scope so create-session and the webhook (same Node process in `npm run dev`)
 * see the same state. Never activates in production.
 *
 * @type {{ subs: Map<string, unknown>; byStripe: Map<string, unknown>; bySession: Map<string, unknown>; claims: Map<string, unknown> } | null}
 */
let memoryStoresSingleton = null;

function shouldUseLocalMemoryFallback() {
  if ((process.env.NETLIFY || "").trim()) return false;
  return (process.env.STRIPE_SUBSCRIPTION_STORE_LOCAL_MEMORY || "").trim() === "1";
}

/**
 * Per-shim ETag counter. Bumped on every successful write so CAS callers
 * (`atomicUpdateJSON`) can detect concurrent mutations even in the in-memory
 * shim — otherwise the local race tests would silently pass on logic that
 * still races in production. Etag values are opaque strings; `Store.set()`
 * with `onlyIfMatch` compares them as exact equality.
 *
 * @type {WeakMap<Map<string, unknown>, Map<string, string>>}
 */
const memoryEtagsByBacking = new WeakMap();

/** @param {Map<string, unknown>} backing */
function getEtagMap(backing) {
  let m = memoryEtagsByBacking.get(backing);
  if (!m) {
    m = new Map();
    memoryEtagsByBacking.set(backing, m);
  }
  return m;
}

/** @param {Map<string, unknown>} backing @param {string} key */
function bumpEtag(backing, key) {
  const m = getEtagMap(backing);
  const next = `mem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  m.set(key, next);
  return next;
}

/**
 * @param {Map<string, unknown>} backing
 */
function makeMemoryStoreShim(backing) {
  const etags = getEtagMap(backing);
  return /** @type {import("@netlify/blobs").Store} */ (
    /** @type {unknown} */ ({
      /** @param {string} key */
      async get(key) {
        const v = backing.get(key);
        return v == null ? null : JSON.parse(JSON.stringify(v));
      },
      /**
       * Returns `{ data, etag }` so `atomicUpdateJSON` can do CAS writes
       * (§ 9.17). Mirrors the real Netlify Blobs `Store.getWithMetadata`
       * shape: `null` when the key does not exist, `{ data, etag }`
       * otherwise. The etag is an opaque string — see `bumpEtag`.
       *
       * @param {string} key
       */
      async getWithMetadata(key) {
        if (!backing.has(key)) return null;
        const v = backing.get(key);
        return {
          data: v == null ? null : JSON.parse(JSON.stringify(v)),
          etag: etags.get(key) ?? "",
        };
      },
      /**
       * Real Netlify Blobs `Store.set()` accepts `{ onlyIfNew, onlyIfMatch }`.
       * The shim must support both so the same call sites work locally.
       * `body` is a JSON string (matching how `atomicCreateJSON` and
       * `atomicUpdateJSON` encode their payloads).
       *
       * @param {string} key
       * @param {string} body
       * @param {{ onlyIfNew?: boolean; onlyIfMatch?: string }} [opts]
       */
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
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          parsed = body;
        }
        backing.set(key, parsed);
        const newEtag = bumpEtag(backing, key);
        return /** @type {{ modified: boolean; etag: string }} */ ({
          modified: true,
          etag: newEtag,
        });
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
        backing.set(key, JSON.parse(JSON.stringify(value)));
        const newEtag = bumpEtag(backing, key);
        return /** @type {{ modified: boolean; etag: string }} */ ({
          modified: true,
          etag: newEtag,
        });
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

/** @returns {{ subs: import("@netlify/blobs").Store; byStripe: import("@netlify/blobs").Store; bySession: import("@netlify/blobs").Store } | null} */
function openMemoryStores() {
  if (!shouldUseLocalMemoryFallback()) return null;
  if (!memoryStoresSingleton) {
    memoryStoresSingleton = {
      subs: new Map(),
      byStripe: new Map(),
      bySession: new Map(),
      claims: new Map(),
    };
    console.warn(
      JSON.stringify({
        event: "stripe_subscription_store_memory_fallback_active",
        detail:
          "Using in-memory subscription store for local dev. NEVER use this in production. Disable by unsetting STRIPE_SUBSCRIPTION_STORE_LOCAL_MEMORY.",
      }),
    );
  }
  return {
    subs: makeMemoryStoreShim(memoryStoresSingleton.subs),
    byStripe: makeMemoryStoreShim(memoryStoresSingleton.byStripe),
    bySession: makeMemoryStoreShim(memoryStoresSingleton.bySession),
    claims: makeMemoryStoreShim(memoryStoresSingleton.claims),
  };
}

/* -------------------------------------------------------------------------- */
/* Status & schema                                                            */
/* -------------------------------------------------------------------------- */

const VALID_SUBSCRIPTION_STATUSES = new Set([
  /** Checkout completed; first invoice has not landed yet. */
  "pending_first_invoice",
  /** At least one invoice.paid → Mindbody sync succeeded. */
  "active",
  /** Most recent invoice attempt failed; Stripe smart retries are running. */
  "past_due",
  /** Studio canceled in Stripe Dashboard (clean cancellation). */
  "canceled_admin",
  /** Stripe gave up after smart retries — subscription auto-canceled by Stripe. */
  "canceled_payment_failure",
]);

const VALID_INVOICE_SYNC_STATUSES = new Set([
  /** Mindbody Service granted; client has the credits. */
  "synced",
  /** Stripe charged but Mindbody sync failed even after auto-retries; admin must intervene. */
  "paid_but_not_synced",
  /** Invoice failed payment; deliberately did not call Mindbody. */
  "skipped_payment_failed",
  /** Invoice was for $0 (e.g., proration credit) — no Mindbody add needed. */
  "skipped_zero_amount",
  /**
   * Subscription is already canceled (`canceled_admin` / `canceled_payment_failure`)
   * but a late `invoice.paid` event arrived (e.g., Stripe re-delivered an event for an
   * invoice paid before cancellation, or a manually-paid late invoice). We deliberately
   * do NOT call Mindbody — V1 policy: canceled subscriptions never receive new credits.
   */
  "skipped_subscription_canceled",
  /**
   * Stripe **test-mode** invoice arrived and `STRIPE_TEST_MODE_MINDBODY_BEHAVIOR=skip`.
   * Recorded for accounting; no Mindbody Service was granted.
   */
  "test_mode_no_sync",
]);

/**
 * @typedef {Object} InvoiceSyncEntry
 * @property {string} invoiceId Stripe `invoice.id` — primary idempotency key.
 * @property {number=} invoiceNumber Optional Stripe-assigned human-readable number.
 * @property {string=} stripePaymentIntentId
 * @property {number} amountPaidCents `invoice.amount_paid`. Final amount the buyer paid
 *   (post-discount, post-tax). For coupon audit reconstruct the math via subtotalCents,
 *   discountAmountCents, taxAmountCents.
 * @property {number=} subtotalCents `invoice.subtotal` — pre-discount, pre-tax amount in cents.
 *   Equal to `monthlyAmountCents` when no coupon was applied. Used as Mindbody Sale "RegularPrice".
 * @property {number=} discountAmountCents Sum of `invoice.total_discount_amounts[].amount` in
 *   cents. The dollar value of the coupon as applied to THIS specific invoice (so a
 *   `duration: once` coupon will be > 0 only on the first invoice). Used as Mindbody Sale
 *   "DiscountAmount".
 * @property {number=} taxAmountCents `invoice.tax` in cents. We do not currently use Stripe
 *   automatic tax, so this is normally 0; stored for future-proof audit.
 * @property {string=} couponId Stripe Coupon id (`coupon_…`) applied to this invoice, if any.
 *   When the buyer redeemed a Promotion Code, this is the underlying coupon id; the typed
 *   code itself is in `promotionCode`.
 * @property {string=} promotionCode The exact text the buyer typed in Checkout (e.g. "WELCOME10"),
 *   if any. Different from `couponId` because one Stripe Coupon can have many Promotion Codes.
 * @property {string} currency
 * @property {string} paidAt ISO8601.
 * @property {string} status One of `VALID_INVOICE_SYNC_STATUSES`.
 * @property {string | null} mindbodySaleId
 * @property {string | null} mindbodyTransactionId
 * @property {number} retryCount Hybrid in-webhook retry attempts (0 → 1 → 2).
 * @property {string=} lastError
 * @property {string=} lastErrorMessage
 * @property {string} firstAttemptAt ISO8601.
 * @property {string} lastAttemptAt ISO8601.
 * @property {boolean=} adminRetryRequired Set when status is `paid_but_not_synced`.
 * @property {number=} adminRetryCount Manual admin-triggered retries (separate counter).
 * @property {string=} adminLastRetryAt
 */

/**
 * @typedef {Object} SubscriptionRecord
 * @property {string} id Our internal id (`sub_amare_<26 chars>`).
 * @property {string} stripeSubscriptionId Stripe `sub_…` id.
 * @property {string} stripeCustomerId
 * @property {string} stripeCheckoutSessionId
 * @property {string} localSku
 * @property {string} displayName Snapshotted at create-session time for admin display.
 * @property {number} monthlyAmountCents Catalog list price at create-session time. Subsequent
 *   `invoice.amount_paid` may differ if Stripe ever applies a coupon — that's the source of
 *   truth for what was actually paid; this field is for cohort/SKU reporting only.
 * @property {string} currency
 * @property {number} mindbodyClientId Resolved or created at create-session time. Used for
 *   every renewal sync.
 * @property {number} mindbodyServiceId Pinned at create-session — never re-resolved at runtime
 *   to prevent drift if the studio renames a Pricing Option mid-subscription.
 * @property {string} mindbodyContractProductId Links to membership terms bundle for admin display.
 * @property {number | null} minimumCommitmentMonths Snapshotted from catalog.
 * @property {number | null} earlyCancellationFeePercent Snapshotted from catalog.
 * @property {string | null} commitmentStartDate ISO date at create-session time.
 * @property {string | null} commitmentEndDate ISO date = start + minimumCommitmentMonths.
 * @property {number | null} earlyCancellationFeeCents Pre-computed: `monthlyAmountCents * fee% / 100`.
 *   Stored for admin reference; not auto-collected in V1.
 * @property {string} membershipConsentId Pointer key into the `mindbody-membership-consents` blob store.
 * @property {string} agreementVersion `contractVersion` from `mb-contract-terms.config.json` at acceptance time.
 * @property {string} agreementTextHash sha256 hex of the sanitized HTML the customer saw.
 * @property {string} agreementAcceptedAt ISO8601.
 * @property {string} legalNameTyped Pruned to 120 chars; same value persisted in the consent record.
 * @property {string} clientIp
 * @property {string} userAgent
 * @property {"pending_first_invoice"|"active"|"past_due"|"canceled_admin"|"canceled_payment_failure"} status
 * @property {string | null} currentPeriodStart ISO8601 from latest Stripe subscription event.
 * @property {string | null} currentPeriodEnd ISO8601.
 * @property {string | null} cancelAt ISO8601 — set by Stripe when admin schedules cancellation at period end.
 * @property {string | null} canceledAt ISO8601 — finalized cancellation time.
 * @property {string | null} cancellationReason Free-form reason (Stripe's `cancellation_details.reason`).
 * @property {InvoiceSyncEntry[]} invoices Append-only list, keyed internally by `invoiceId`.
 * @property {string=} customerEmail
 * @property {string=} customerName
 * @property {string=} customerPhone
 * @property {string} createdAt ISO8601 (set on first put).
 * @property {string} updatedAt ISO8601 (refreshed on every patch).
 * @property {boolean} stripeLivemode True iff Stripe `event.livemode` was true at create-session.
 * @property {"skip"|"mindbody_test"|"live"=} mindbodyTestModeBehavior Captured at first webhook to ease debugging.
 * @property {string=} ctaLocation
 * @property {string=} pageLocation
 * @property {"classes"|"pricing"|"unknown"=} purchaseSource
 * @property {{
 *   classId: number;
 *   reportedClassStartIso?: string | null;
 *   className?: string | null;
 *   instructorName?: string | null;
 *   selectedDayKey?: string | null;
 *   capturedAt: string;
 * }=} selectedClassContext
 * @property {{
 *   status: "pending"|"processing"|"booked"|"already_enrolled"|"failed";
 *   attemptedAt?: string | null;
 *   completedAt?: string | null;
 *   result?: string | null;
 *   reason?: string | null;
 *   firstInvoiceId?: string | null;
 * }=} classesAutoBook
 * @property {boolean=} initialAutoBookProcessed
 * @property {string=} initialAutoBookProcessedAt
 * @property {string=} initialAutoBookResult
 * @property {{
 *   status: "not_sent"|"sending"|"sent"|"failed";
 *   attemptedAt?: string | null;
 *   sentAt?: string | null;
 *   reason?: string | null;
 *   lastError?: string | null;
 *   checkoutSessionId?: string | null;
 *   firstInvoiceId?: string | null;
 * }=} bookingFailureAdminEmail
 */

/* -------------------------------------------------------------------------- */
/* Store handles                                                              */
/* -------------------------------------------------------------------------- */

/**
 * @param {{ blobs?: string } | unknown} [event]
 * @returns {{ subs: import("@netlify/blobs").Store; byStripe: import("@netlify/blobs").Store; bySession: import("@netlify/blobs").Store; claims: import("@netlify/blobs").Store } | null}
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
    const subs = getStore({ name: SUBSCRIPTIONS_STORE_NAME });
    const byStripe = getStore({ name: STRIPE_INDEX_STORE_NAME });
    const bySession = getStore({ name: SESSION_INDEX_STORE_NAME });
    const claims = getStore({ name: INVOICE_CLAIMS_STORE_NAME });
    return { subs, byStripe, bySession, claims };
  } catch (e) {
    const memFallback = openMemoryStores();
    if (memFallback) return memFallback;
    console.warn(
      JSON.stringify({
        event: "stripe_subscription_store_unavailable",
        detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 240),
        hint:
          shouldUseLocalMemoryFallback()
            ? undefined
            : "Set STRIPE_SUBSCRIPTION_STORE_LOCAL_MEMORY=1 in .env for local dev only (never in production).",
      }),
    );
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Key helpers                                                                */
/* -------------------------------------------------------------------------- */

/** @param {string} subscriptionId */
function subscriptionKey(subscriptionId) {
  if (typeof subscriptionId !== "string" || !/^sub_amare_[A-Z0-9]{8,40}$/.test(subscriptionId)) {
    throw new Error(`invalid_subscriptionId: ${String(subscriptionId).slice(0, 40)}`);
  }
  return `v1/${subscriptionId}`;
}

/** @param {string} stripeSubId */
function stripeSubIndexKey(stripeSubId) {
  if (typeof stripeSubId !== "string" || !/^sub_[A-Za-z0-9_-]{4,200}$/.test(stripeSubId)) {
    throw new Error(`invalid_stripe_subscription_id: ${String(stripeSubId).slice(0, 40)}`);
  }
  return `v1/${stripeSubId}`;
}

/** @param {string} sessionId */
function sessionIndexKey(sessionId) {
  if (typeof sessionId !== "string" || !/^cs_[A-Za-z0-9_-]{4,200}$/.test(sessionId)) {
    throw new Error(`invalid_checkout_session_id: ${String(sessionId).slice(0, 40)}`);
  }
  return `v1/${sessionId}`;
}

/** @param {string} status */
export function isValidSubscriptionStatus(status) {
  return VALID_SUBSCRIPTION_STATUSES.has(String(status));
}

/** @param {string} status */
export function isValidInvoiceSyncStatus(status) {
  return VALID_INVOICE_SYNC_STATUSES.has(String(status));
}

/* -------------------------------------------------------------------------- */
/* Public adapter                                                             */
/* -------------------------------------------------------------------------- */

/**
 * @param {{ blobs?: string } | unknown} [event]
 * @returns {{
 *   get: (subscriptionId: string) => Promise<SubscriptionRecord | null>,
 *   getByStripeSubscriptionId: (stripeSubId: string) => Promise<SubscriptionRecord | null>,
 *   getByCheckoutSessionId: (sessionId: string) => Promise<SubscriptionRecord | null>,
 *   put: (record: SubscriptionRecord, opts?: { onlyIfNew?: boolean }) => Promise<{ ok: true; created: boolean } | { ok: false; reason: string }>,
 *   patch: (subscriptionId: string, partial: Partial<SubscriptionRecord>) => Promise<SubscriptionRecord | null>,
 *   mutate: (
 *     subscriptionId: string,
 *     fn: (current: SubscriptionRecord) => SubscriptionRecord | null | Promise<SubscriptionRecord | null>,
 *   ) => Promise<{ ok: true; record: SubscriptionRecord; modified: boolean } | { ok: false; reason: string }>,
 *   bindStripeSubscription: (stripeSubId: string, subscriptionId: string) => Promise<void>,
 *   bindCheckoutSession: (sessionId: string, subscriptionId: string) => Promise<void>,
 *   claimInvoiceSlot: (subscriptionId: string, invoiceId: string, meta?: { sourceEventId?: string }) => Promise<{ ok: true; acquired: boolean } | { ok: false; reason: string }>,
 *   releaseInvoiceClaim: (subscriptionId: string, invoiceId: string) => Promise<{ ok: true } | { ok: false; reason: string }>,
 *   appendInvoiceSync: (subscriptionId: string, entry: InvoiceSyncEntry) => Promise<{ ok: true; record: SubscriptionRecord; created: boolean } | { ok: false; reason: string }>,
 *   updateInvoiceSync: (subscriptionId: string, invoiceId: string, partial: Partial<InvoiceSyncEntry>) => Promise<{ ok: true; record: SubscriptionRecord; entry: InvoiceSyncEntry } | { ok: false; reason: string }>,
 *   listByStatus: (status: string, opts?: { limit?: number }) => Promise<SubscriptionRecord[]>,
 *   listInvoiceSyncFailures: (opts?: { limit?: number }) => Promise<{ subscription: SubscriptionRecord; entry: InvoiceSyncEntry }[]>,
 *   available: boolean,
 * }}
 */
export function openSubscriptionStore(event) {
  const stores = openStores(event);
  /** @type {boolean} */
  const available = !!stores;

  /** @param {string} id */
  async function get(id) {
    if (!stores) return null;
    let key;
    try {
      key = subscriptionKey(id);
    } catch {
      return null;
    }
    /** @type {unknown} */
    const cur = await stores.subs.get(key, { type: "json" });
    if (!cur || typeof cur !== "object") return null;
    return /** @type {SubscriptionRecord} */ (cur);
  }

  /** @param {string} stripeSubId */
  async function getByStripeSubscriptionId(stripeSubId) {
    if (!stores) return null;
    let key;
    try {
      key = stripeSubIndexKey(stripeSubId);
    } catch {
      return null;
    }
    /** @type {unknown} */
    const idx = await stores.byStripe.get(key, { type: "json" });
    if (!idx || typeof idx !== "object") return null;
    const id = /** @type {{ subscriptionId?: unknown }} */ (idx).subscriptionId;
    if (typeof id !== "string" || !id) return null;
    return get(id);
  }

  /** @param {string} sessionId */
  async function getByCheckoutSessionId(sessionId) {
    if (!stores) return null;
    let key;
    try {
      key = sessionIndexKey(sessionId);
    } catch {
      return null;
    }
    /** @type {unknown} */
    const idx = await stores.bySession.get(key, { type: "json" });
    if (!idx || typeof idx !== "object") return null;
    const id = /** @type {{ subscriptionId?: unknown }} */ (idx).subscriptionId;
    if (typeof id !== "string" || !id) return null;
    return get(id);
  }

  /**
   * @param {SubscriptionRecord} record
   * @param {{ onlyIfNew?: boolean }} [opts]
   */
  async function put(record, opts) {
    if (!stores) return { ok: false, reason: "store_unavailable" };
    if (!record || typeof record !== "object") return { ok: false, reason: "invalid_record" };
    if (!record.id) return { ok: false, reason: "missing_id" };
    if (!record.status || !VALID_SUBSCRIPTION_STATUSES.has(record.status)) {
      return { ok: false, reason: "invalid_status" };
    }
    /**
     * Validate every nested invoice sync entry too — patches can otherwise sneak in
     * a typo and we won't catch it until an admin queries the failures view.
     */
    if (Array.isArray(record.invoices)) {
      for (const inv of record.invoices) {
        if (!inv || typeof inv !== "object") return { ok: false, reason: "invalid_invoice_entry" };
        if (!VALID_INVOICE_SYNC_STATUSES.has(inv.status)) {
          return { ok: false, reason: `invalid_invoice_status:${inv.status}` };
        }
      }
    }
    let key;
    try {
      key = subscriptionKey(record.id);
    } catch (e) {
      return { ok: false, reason: String(/** @type {{ message?: string }} */ (e)?.message ?? "invalid_id") };
    }
    const now = new Date().toISOString();
    /** @type {SubscriptionRecord} */
    const toWrite = {
      ...record,
      invoices: Array.isArray(record.invoices) ? record.invoices : [],
      createdAt: record.createdAt || now,
      updatedAt: now,
    };
    if (opts?.onlyIfNew) {
      /**
       * MUST go through `atomicCreateJSON` — `setJSON(..., { onlyIfNew: true })`
       * is silently broken in @netlify/blobs (see `blobs-conditional-create.mjs`).
       */
      const wr = await atomicCreateJSON(stores.subs, key, toWrite);
      if (!wr.modified) return { ok: false, reason: "exists" };
      return { ok: true, created: true };
    }
    await stores.subs.setJSON(key, toWrite);
    return { ok: true, created: true };
  }

  /**
   * @param {string} id
   * @param {Partial<SubscriptionRecord>} partial
   */
  async function patch(id, partial) {
    if (!stores) return null;
    let key;
    try {
      key = subscriptionKey(id);
    } catch {
      return null;
    }
    /**
     * Validate `partial.status` once outside the CAS loop — it does not
     * depend on `current` and we want to fail fast on invalid input.
     */
    if (
      partial.status &&
      !VALID_SUBSCRIPTION_STATUSES.has(partial.status)
    ) {
      throw new Error(`invalid_status_in_patch: ${partial.status}`);
    }

    /**
     * § 9.17 — CAS-protected patch. Historically this was a non-atomic
     * read-modify-write that could lose `invoices[]` mutations made by a
     * concurrent `appendInvoiceSync` (eager first-invoice sync racing
     * `customer.subscription.created`), causing the success-page amount
     * flicker. The mutator below is a pure function over `current` and is
     * safe to retry under contention.
     */
    const result = await atomicUpdateJSON(
      stores.subs,
      key,
      /** @param {SubscriptionRecord} before */
      (before) => {
        /**
         * `stripeSubscriptionId` is normally immutable, but we MUST allow the one-time
         * transition from the `pending_<id>` placeholder (set at create-session) to the
         * real Stripe `sub_<id>` once `checkout.session.completed` fires. We disallow:
         *   - regression `sub_…` → `pending_…`
         *   - rebinding from one `sub_…` to a different `sub_…` (would silently steal a
         *     different customer's subscription)
         *   - empty / non-string overrides
         * If the partial does not carry `stripeSubscriptionId`, the existing value is kept.
         */
        const incomingSubId =
          typeof /** @type {{ stripeSubscriptionId?: unknown }} */ (partial).stripeSubscriptionId === "string"
            ? /** @type {string} */ (
                /** @type {{ stripeSubscriptionId: string }} */ (partial).stripeSubscriptionId
              ).trim()
            : "";
        const incomingIsRealStripeId = /^sub_[A-Za-z0-9]+$/.test(incomingSubId);
        const currentLooksPending =
          !before.stripeSubscriptionId ||
          /^pending_/.test(before.stripeSubscriptionId) ||
          !/^sub_[A-Za-z0-9]+$/.test(before.stripeSubscriptionId);
        const allowSubIdTransition = incomingIsRealStripeId && currentLooksPending;
        if (incomingSubId && !incomingIsRealStripeId) {
          console.warn(
            JSON.stringify({
              event: "stripe_subscription_patch_rejected_invalid_sub_id",
              subscriptionId: before.id,
              incomingSubId,
              beforeStripeSubId: before.stripeSubscriptionId,
            }),
          );
        }
        if (
          incomingIsRealStripeId &&
          !currentLooksPending &&
          incomingSubId !== before.stripeSubscriptionId
        ) {
          console.warn(
            JSON.stringify({
              event: "stripe_subscription_patch_rejected_rebind_attempt",
              subscriptionId: before.id,
              incomingSubId,
              beforeStripeSubId: before.stripeSubscriptionId,
            }),
          );
        }
        /** @type {SubscriptionRecord} */
        const next = {
          ...before,
          ...partial,
          id: before.id,
          stripeSubscriptionId: allowSubIdTransition ? incomingSubId : before.stripeSubscriptionId,
          createdAt: before.createdAt,
          invoices: Array.isArray(partial.invoices) ? partial.invoices : before.invoices,
          updatedAt: new Date().toISOString(),
        };
        return next;
      },
    );
    if (!result.ok) {
      if (result.reason === "not_found") return null;
      console.warn(
        JSON.stringify({
          event: "stripe_subscription_patch_cas_failed",
          subscriptionId: id,
          reason: result.reason,
          attempts: result.attempts,
        }),
      );
      return null;
    }
    return result.record;
  }

  /**
   * @param {string} id
   * @param {(current: SubscriptionRecord) => SubscriptionRecord | null | Promise<SubscriptionRecord | null>} fn
   */
  async function mutate(id, fn) {
    if (!stores) return { ok: false, reason: "store_unavailable" };
    let key;
    try {
      key = subscriptionKey(id);
    } catch {
      return { ok: false, reason: "invalid_subscriptionId" };
    }
    const result = await atomicUpdateJSON(stores.subs, key, fn);
    if (!result.ok) {
      return { ok: false, reason: result.reason };
    }
    return { ok: true, record: result.record, modified: result.modified };
  }

  /**
   * @param {string} stripeSubId
   * @param {string} id
   */
  async function bindStripeSubscription(stripeSubId, id) {
    if (!stores) return;
    const key = stripeSubIndexKey(stripeSubId);
    await stores.byStripe.setJSON(key, {
      subscriptionId: id,
      boundAt: new Date().toISOString(),
    });
  }

  /**
   * @param {string} sessionId
   * @param {string} id
   */
  async function bindCheckoutSession(sessionId, id) {
    if (!stores) return;
    const key = sessionIndexKey(sessionId);
    await stores.bySession.setJSON(key, {
      subscriptionId: id,
      boundAt: new Date().toISOString(),
    });
  }

  /**
   * Atomic per-invoice claim. Returns `{ acquired: true }` exactly once for a given
   * `(subscriptionId, invoiceId)` pair across all containers/processes — uses
   * `setJSON(..., { onlyIfNew: true })` which translates to a Netlify Blobs conditional
   * write at the store level (or to `Map.has()` short-circuit in the in-memory shim).
   *
   * Subsequent callers receive `{ acquired: false }` and MUST short-circuit (i.e. dedup)
   * — this is the ONLY safe way to prevent the eager first-invoice sync from racing the
   * real `invoice.paid` webhook (different events, possibly different Lambda containers,
   * same invoiceId). The previous "check `record.invoices[]` for existing entry"
   * dedup-by-find pattern is racy because two parallel handlers can both observe an
   * empty array and both proceed to call Mindbody.
   *
   * Lifecycle:
   *   1. `handleInvoicePaid` calls `claimInvoiceSlot` BEFORE any Mindbody work.
   *   2. On success path, the InvoiceSyncEntry is appended (status = `synced` etc).
   *   3. The claim itself is left in place — it acts as a permanent receipt; future
   *      retries (admin or webhook redelivery) will see `acquired: false` and
   *      route through the existing record-based dedup.
   *
   * If the worker crashes after the claim but before append, the invoice ends up in
   * a "claimed but not recorded" state. Recovery: admin must clear the claim manually
   * (via `releaseInvoiceClaim`) before redelivering the webhook. We deliberately do NOT
   * implement TTL-based auto-expiry in V1 because that re-opens the duplicate-Sale risk.
   *
   * @param {string} subscriptionId Our internal `sub_amare_<id>`.
   * @param {string} invoiceId Stripe `in_<id>`.
   * @param {{ sourceEventId?: string }} [meta] Optional Stripe webhook event id for traceability.
   * @returns {Promise<{ ok: true; acquired: boolean } | { ok: false; reason: string }>}
   */
  async function claimInvoiceSlot(subscriptionId, invoiceId, meta) {
    if (!stores) return { ok: false, reason: "store_unavailable" };
    if (typeof subscriptionId !== "string" || !subscriptionId) {
      return { ok: false, reason: "invalid_subscriptionId" };
    }
    if (
      typeof invoiceId !== "string" ||
      !/^in_[A-Za-z0-9_]{4,200}$/.test(invoiceId)
    ) {
      return { ok: false, reason: "invalid_invoiceId" };
    }
    const key = `claim/${subscriptionId}/${invoiceId}`;
    /**
     * MUST go through `atomicCreateJSON` — `setJSON(..., { onlyIfNew: true })`
     * is silently broken in @netlify/blobs and BOTH parallel writers receive
     * `{ modified: true }`. That bug caused 2 duplicate Mindbody Sales for one
     * Stripe charge in production on 2026-05-15. See
     * `blobs-conditional-create.mjs` for the SDK analysis.
     */
    const wr = await atomicCreateJSON(stores.claims, key, {
      subscriptionId,
      invoiceId,
      acquiredAt: new Date().toISOString(),
      sourceEventId: (meta && meta.sourceEventId) || null,
    });
    return { ok: true, acquired: wr.modified === true };
  }

  /**
   * Release a claim. Used ONLY by admin-driven recovery flows (e.g. when an invoice
   * was claimed but the Mindbody sync was never recorded due to a crash, and the
   * studio wants to re-attempt by redelivering the webhook). Not called automatically.
   *
   * @param {string} subscriptionId
   * @param {string} invoiceId
   */
  async function releaseInvoiceClaim(subscriptionId, invoiceId) {
    if (!stores) return { ok: false, reason: "store_unavailable" };
    const key = `claim/${subscriptionId}/${invoiceId}`;
    /** @type {{ delete?: (key: string) => Promise<unknown> }} */
    const claimsStore = /** @type {unknown} */ (stores.claims);
    if (typeof claimsStore.delete === "function") {
      await claimsStore.delete(key);
    } else {
      /** @type {{ setJSON: (k: string, v: unknown) => Promise<unknown> }} */ (
        /** @type {unknown} */ (stores.claims)
      ).setJSON(key, null);
    }
    return { ok: true };
  }

  /**
   * Append an invoice sync entry idempotently. If an entry with the same `invoiceId`
   * already exists we return `{ ok: true, created: false, record }` — the caller can
   * inspect the existing entry to decide whether to call `updateInvoiceSync` or noop.
   *
   * @param {string} id
   * @param {InvoiceSyncEntry} entry
   */
  async function appendInvoiceSync(id, entry) {
    if (!stores) return { ok: false, reason: "store_unavailable" };
    if (!entry || typeof entry !== "object") return { ok: false, reason: "invalid_entry" };
    if (typeof entry.invoiceId !== "string" || !/^in_[A-Za-z0-9_]{4,200}$/.test(entry.invoiceId)) {
      return { ok: false, reason: "invalid_invoiceId" };
    }
    if (!VALID_INVOICE_SYNC_STATUSES.has(entry.status)) {
      return { ok: false, reason: `invalid_invoice_status:${entry.status}` };
    }
    let key;
    try {
      key = subscriptionKey(id);
    } catch {
      return { ok: false, reason: "invalid_subscriptionId" };
    }
    /**
     * § 9.17 — CAS-protected append. Returning `null` from the mutator
     * means "entry already present, no write needed" — the helper short-
     * circuits with `modified: false` and we report `created: false` to
     * the caller (matching the legacy contract). For new entries the
     * mutator returns `next` and the helper writes with `onlyIfMatch`.
     */
    let alreadyPresent = false;
    const result = await atomicUpdateJSON(
      stores.subs,
      key,
      /** @param {SubscriptionRecord} before */
      (before) => {
        const existing = (before.invoices || []).find(
          (e) => e && e.invoiceId === entry.invoiceId,
        );
        if (existing) {
          alreadyPresent = true;
          return null;
        }
        alreadyPresent = false;
        /** @type {SubscriptionRecord} */
        const next = {
          ...before,
          invoices: [...(before.invoices || []), entry],
          updatedAt: new Date().toISOString(),
        };
        return next;
      },
    );
    if (!result.ok) {
      if (result.reason === "not_found") {
        return { ok: false, reason: "subscription_not_found" };
      }
      console.warn(
        JSON.stringify({
          event: "stripe_subscription_append_invoice_cas_failed",
          subscriptionId: id,
          invoiceId: entry.invoiceId,
          reason: result.reason,
          attempts: result.attempts,
        }),
      );
      return { ok: false, reason: result.reason };
    }
    return { ok: true, created: !alreadyPresent, record: result.record };
  }

  /**
   * Patch a single invoice sync entry by `invoiceId`. Used by the hybrid-retry path
   * (status change synced/paid_but_not_synced) AND by admin retry.
   *
   * @param {string} id
   * @param {string} invoiceId
   * @param {Partial<InvoiceSyncEntry>} partial
   */
  async function updateInvoiceSync(id, invoiceId, partial) {
    if (!stores) return { ok: false, reason: "store_unavailable" };
    let key;
    try {
      key = subscriptionKey(id);
    } catch {
      return { ok: false, reason: "invalid_subscriptionId" };
    }
    /**
     * Validate `partial.status` once outside the CAS loop — it is independent
     * of `current` and we want to fail fast on invalid input.
     */
    if (partial.status && !VALID_INVOICE_SYNC_STATUSES.has(partial.status)) {
      return { ok: false, reason: `invalid_invoice_status:${partial.status}` };
    }

    /**
     * § 9.17 — CAS-protected update. The mutator throws via a tagged sentinel
     * if the targeted invoice entry is missing from the latest read; we map
     * that back to the legacy `invoice_entry_not_found` reason after the
     * helper resolves.
     */
    let entryMissing = false;
    /** @type {InvoiceSyncEntry | null} */
    let mergedOut = null;
    const result = await atomicUpdateJSON(
      stores.subs,
      key,
      /** @param {SubscriptionRecord} before */
      (before) => {
        const idx = (before.invoices || []).findIndex(
          (e) => e && e.invoiceId === invoiceId,
        );
        if (idx === -1) {
          entryMissing = true;
          return null;
        }
        entryMissing = false;
        /** @type {InvoiceSyncEntry} */
        const merged = {
          ...before.invoices[idx],
          ...partial,
          invoiceId,
          lastAttemptAt: new Date().toISOString(),
        };
        const nextInvoices = [...before.invoices];
        nextInvoices[idx] = merged;
        mergedOut = merged;
        /** @type {SubscriptionRecord} */
        const next = {
          ...before,
          invoices: nextInvoices,
          updatedAt: new Date().toISOString(),
        };
        return next;
      },
    );
    if (!result.ok) {
      if (result.reason === "not_found") return { ok: false, reason: "subscription_not_found" };
      console.warn(
        JSON.stringify({
          event: "stripe_subscription_update_invoice_cas_failed",
          subscriptionId: id,
          invoiceId,
          reason: result.reason,
          attempts: result.attempts,
        }),
      );
      return { ok: false, reason: result.reason };
    }
    if (entryMissing) {
      return { ok: false, reason: "invoice_entry_not_found" };
    }
    return { ok: true, record: result.record, entry: /** @type {InvoiceSyncEntry} */ (mergedOut) };
  }

  /**
   * Scan the subscription store and return records whose top-level status matches.
   * Bounded to a hard cap (5000 scanned, default 50 returned) — same shape as the
   * one-time order store. Uses Netlify Blobs `list({ paginate: true })`.
   *
   * @param {string} status
   * @param {{ limit?: number }} [opts]
   */
  async function listByStatus(status, opts) {
    if (!stores) return [];
    if (!VALID_SUBSCRIPTION_STATUSES.has(status)) return [];
    const limit = Math.min(Math.max(Number(opts?.limit) || 50, 1), 500);
    /** @type {SubscriptionRecord[]} */
    const out = [];
    const pages = stores.subs.list({ paginate: true });
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
        const cur = await stores.subs.get(key, { type: "json" });
        if (cur && typeof cur === "object") {
          const r = /** @type {SubscriptionRecord} */ (cur);
          if (r.status === status) out.push(r);
        }
      }
      if (out.length >= limit || scanned > SCAN_CAP) break;
    }
    /** Newest first by updatedAt. */
    out.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    return out;
  }

  /**
   * Return SubscriptionRecords for a Mindbody client whose status is still
   * "non-terminal" — i.e. the buyer is still inside an active commitment
   * window or pending first invoice. Cancelled records (`canceled_admin`,
   * `canceled_payment_failure`) are excluded.
   *
   * Used by `/api/mindbody/member/summary` (§ 9.18) to overlay our
   * `commitmentEndDate` on top of the Mindbody Memberships table — Mindbody
   * has no concept of our 3-month minimum commitment because V1 deliberately
   * does not use Mindbody Contracts (see § 1).
   *
   * @param {number} mindbodyClientId
   * @param {{ limit?: number }} [opts]
   * @returns {Promise<SubscriptionRecord[]>}
   */
  async function listActiveByMindbodyClientId(mindbodyClientId, opts) {
    if (!stores) return [];
    if (!Number.isFinite(mindbodyClientId) || mindbodyClientId <= 0) return [];
    const limit = Math.min(Math.max(Number(opts?.limit) || 20, 1), 100);
    /** @type {SubscriptionRecord[]} */
    const out = [];
    const pages = stores.subs.list({ paginate: true });
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
        const cur = await stores.subs.get(key, { type: "json" });
        if (!cur || typeof cur !== "object") continue;
        const r = /** @type {SubscriptionRecord} */ (cur);
        if (r.mindbodyClientId !== mindbodyClientId) continue;
        if (r.status === "canceled_admin" || r.status === "canceled_payment_failure") continue;
        out.push(r);
      }
      if (out.length >= limit || scanned > SCAN_CAP) break;
    }
    out.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    return out;
  }

  /**
   * Scan all subscriptions and return invoice entries whose status is `paid_but_not_synced`
   * (the admin retry queue). Includes the parent SubscriptionRecord per entry so the
   * admin endpoint can render context without a second lookup.
   *
   * @param {{ limit?: number }} [opts]
   */
  async function listInvoiceSyncFailures(opts) {
    if (!stores) return [];
    const limit = Math.min(Math.max(Number(opts?.limit) || 50, 1), 500);
    /** @type {{ subscription: SubscriptionRecord; entry: InvoiceSyncEntry }[]} */
    const out = [];
    const pages = stores.subs.list({ paginate: true });
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
        const cur = await stores.subs.get(key, { type: "json" });
        if (!cur || typeof cur !== "object") continue;
        const r = /** @type {SubscriptionRecord} */ (cur);
        for (const inv of r.invoices || []) {
          if (inv && inv.status === "paid_but_not_synced") {
            out.push({ subscription: r, entry: inv });
            if (out.length >= limit) break;
          }
        }
      }
      if (out.length >= limit || scanned > SCAN_CAP) break;
    }
    out.sort(
      (a, b) =>
        String(b.entry.lastAttemptAt || "").localeCompare(String(a.entry.lastAttemptAt || "")),
    );
    return out;
  }

  return {
    get,
    getByStripeSubscriptionId,
    getByCheckoutSessionId,
    put,
    patch,
    mutate,
    bindStripeSubscription,
    bindCheckoutSession,
    claimInvoiceSlot,
    releaseInvoiceClaim,
    appendInvoiceSync,
    updateInvoiceSync,
    listByStatus,
    listActiveByMindbodyClientId,
    listInvoiceSyncFailures,
    available,
  };
}

/* -------------------------------------------------------------------------- */
/* Id generators                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Generate a fresh subscription id. Format: `sub_amare_<26 chars>` — Crockford-friendly base32
 * to mirror `newOrderId()` in the one-time order store. Distinct prefix prevents accidental
 * cross-store key collisions.
 */
export function newSubscriptionId() {
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
  return `sub_amare_${out}`;
}

export const __testing = {
  SUBSCRIPTIONS_STORE_NAME,
  STRIPE_INDEX_STORE_NAME,
  SESSION_INDEX_STORE_NAME,
  INVOICE_CLAIMS_STORE_NAME,
  VALID_SUBSCRIPTION_STATUSES,
  VALID_INVOICE_SYNC_STATUSES,
  subscriptionKey,
  stripeSubIndexKey,
  sessionIndexKey,
};
