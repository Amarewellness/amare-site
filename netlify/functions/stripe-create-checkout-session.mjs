/**
 * POST /api/stripe/checkout/create-session
 *
 * Creates a Stripe Checkout Session for an AMARÉ Mindbody product. Two modes share the
 * single endpoint, dispatched by the catalog item's `stripeMode`:
 *
 *  • `mode: "payment"` (default — one-time NCS / drop-in / 5/10/20 class packs).
 *    Gated by `ENABLE_STRIPE_ONE_TIME_CHECKOUT=1`. Order persisted in `stripe-mindbody-orders`.
 *
 *  • `mode: "subscription"` (`kind: "monthlyMembership"` — Monthly 5 / 8 / Unlimited).
 *    Gated by `ENABLE_STRIPE_RECURRING_CHECKOUT=1`. Subscription persisted in
 *    `stripe-mindbody-subscriptions`. Mindbody is NOT touched here — every successful
 *    `invoice.paid` webhook adds the matching Pricing Option to the client (Option A,
 *    see `docs/MEMBERSHIP-RECURRING-CHECKOUT.md`).
 *
 * Decisions: docs/STRIPE-MINDBODY-QUESTIONS.md and docs/MEMBERSHIP-RECURRING-CHECKOUT.md.
 * Inspection: both one-time packages and monthly memberships are `Type: "Service"` in
 * Mindbody (see `mindbody-sale-checkout.mjs` and `scripts/mindbody-membership-service-probe.mjs`).
 *
 * Server-side validation (never trust client):
 *  • Look up `localSku` in the catalog config; reject if disabled or unknown.
 *  • Reject anything that isn't `mindbodyItemType === "Service"`.
 *  • Use server-side amount; ignore any `amount` from the request body.
 *  • Block NCS for already-known logged-in clients per Q3 (`block_before_checkout_if_known`).
 *  • Reject membership checkout if buyer already has any active SubscriptionRecord per
 *    `block_if_active_subscription` (the studio handles plan changes manually in V1).
 *
 * Persistence is created BEFORE redirecting to Stripe so the webhook can find the record
 * even on race conditions (Stripe sometimes fires `invoice.paid` before
 * `checkout.session.completed`).
 */

import { createHash, randomUUID } from "node:crypto";
import Stripe from "stripe";
import { withLambda } from "@netlify/aws-lambda-compat";
import { withMobileCorsHandler } from "./mobile-api-cors.mjs";

import {
  getMindbodyStaffAccessTokenCached,
  jsonResponse,
} from "./mindbody-consumer-lib.mjs";
import {
  membershipConsentBlobKey,
  membershipConsentBlobsEnabled,
  tryOpenMembershipConsentBlobStore,
} from "./membership-consent-blobs.mjs";
import { validateMembershipElectronicConsent } from "./mindbody-membership-electronic-consent.mjs";
import {
  normalizeUsMobilePhone,
  parseCookies,
  sessionSecret,
  unsealCookiePayload,
} from "./oauth-lib.mjs";
import {
  mindbodyStaffApiHeaders,
  mindbodyStaffBearerHeaders,
} from "./mindbody-upstream.mjs";
import { getCatalogItem } from "./stripe-catalog-lib.mjs";
import { newOrderId, openOrderStore } from "./stripe-order-store.mjs";
import {
  parseSelectedClassFromBody,
  buildSelectedClassContext,
  derivePurchaseSource,
} from "./classes-auto-book-lib.mjs";
import {
  readBookFailIntentFromEvent,
  readAnonymousBookIntentFromEvent,
  validatePendingBookForCheckout,
  validateAnonymousPendingBookForCheckout,
  isDeferredBookEligibleCta,
  isDeferredBookEligibleSku,
  bookFailIntentClearCookieHeader,
  anonymousBookIntentClearCookieHeader,
  DEFERRED_BOOK_ANONYMOUS_CTA,
  sealDeferredBookConsumerAuth,
} from "./mindbody-pending-book-intent-lib.mjs";
import {
  fetchClientIdByEmail,
  fetchMindbodyClientContact,
  ncsDuplicateDryRun,
  resolveOrCreateMindbodyClient,
} from "./stripe-mindbody-sync-lib.mjs";
import { amareSiteId } from "./amare-auth-lib.mjs";
import { displayEmailFromIdentities } from "./amare-auth-member-access.mjs";
import {
  bodyHasBrowserClientId,
  commerceCheckoutRejectResponse,
  isPurchaseLinkedState,
  pickStripeCustomerFromCandidates,
  resolveCommerceCustomer,
} from "./amare-commerce-lib.mjs";
import {
  newSubscriptionId,
  openSubscriptionStore,
} from "./stripe-subscription-store.mjs";
import { memberTopUpEnabled } from "./member-topup-blobs.mjs";
import {
  isMemberTopUpItem,
  prepareTopUpForPurchase,
  releaseTopUpForAbandonedOrder,
} from "./member-topup-lib.mjs";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function featureEnabled() {
  return (process.env.ENABLE_STRIPE_ONE_TIME_CHECKOUT || "").trim() === "1";
}

/** Emergency containment: block public one-time Hosted Checkout without touching recurring. */
function oneTimeHostedCheckoutBlocked() {
  return (process.env.STRIPE_BLOCK_ONE_TIME_HOSTED_CHECKOUT || "").trim() === "1";
}

/** Staff-only bypass while public one-time Hosted Checkout is blocked. */
function adminDebugAuthorized(event) {
  const expected = (process.env.ADMIN_DEBUG_TOKEN || "").trim();
  if (!expected || expected.length < 16) return false;
  if (!event || typeof event !== "object") return false;
  const headers = /** @type {{ headers?: Record<string, string | undefined> }} */ (event).headers || {};
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() !== "x-admin-token") continue;
    const got = String(headers[k] || "").trim();
    if (got.length !== expected.length) return false;
    let mismatch = 0;
    for (let i = 0; i < got.length; i += 1) {
      mismatch |= got.charCodeAt(i) ^ expected.charCodeAt(i);
    }
    return mismatch === 0;
  }
  return false;
}

/**
 * Master kill switch for the Stripe Recurring Membership flow (Option A). Defaults to OFF.
 * The frontend has its own build-time flag `ENABLE_STRIPE_RECURRING_CHECKOUT_FRONTEND` that
 * controls whether `pricing-api.js` even calls this endpoint with a monthlyMembership SKU —
 * the server-side flag here is the actual gate. Both must be ON in production for memberships
 * to flow through Stripe; either OFF and we fall back to the existing Mindbody Classic flow.
 *
 * See docs/MEMBERSHIP-RECURRING-CHECKOUT.md.
 */
function recurringFeatureEnabled() {
  return (process.env.ENABLE_STRIPE_RECURRING_CHECKOUT || "").trim() === "1";
}

/**
 * Stripe Checkout promotion-code field. Disabled by default. Flip
 * `ENABLE_STRIPE_PROMOTION_CODES=1` in Netlify env vars **only after** the full
 * Mindbody-side verification cycle has passed:
 *
 *   1. No-coupon order            → Mindbody sale recorded at list price (existing behaviour).
 *   2. Percentage-off coupon order → Mindbody Item shows DiscountAmount, Service granted,
 *                                    Custom payment row matches Stripe `amount_total`,
 *                                    no calculated-total mismatch, no `Action: "Failed"`.
 *   3. Fixed-amount-off coupon    → Same as (2). Verifies cents-rounding edge cases.
 *
 * Until those three pass on a real Mindbody Test:true cart against a test client, this flag
 * stays OFF in production — the create-session endpoint will not even advertise the field
 * to the buyer. The webhook + sync code paths are already discount-aware (zero discount =
 * byte-identical pre-coupon payload) so flipping the flag is a single env-var change.
 */
function promotionCodesEnabled() {
  const v = (process.env.ENABLE_STRIPE_PROMOTION_CODES || "").trim();
  return v === "1" || v.toLowerCase() === "true";
}

/** One-time Drop-In Single Class — only SKU that uses a stable Stripe Product for coupon `applies_to`. */
const DROP_IN_SINGLE_CLASS_SKU = "drop_in_single_class";

/**
 * Stable Stripe Product id for `drop_in_single_class` Checkout line items.
 * Required so a Coupon can use `applies_to.products` without migrating other SKUs off
 * inline `product_data`. Returns null when unset or not a `prod_…` id — callers must
 * fail-fast for this SKU (no silent fallback to `product_data`).
 *
 * @returns {string | null}
 */
function dropInSingleProductId() {
  const v = (process.env.STRIPE_DROPIN_SINGLE_PRODUCT_ID || "").trim();
  if (!v) return null;
  if (!/^prod_[A-Za-z0-9]+$/.test(v)) return null;
  return v;
}

/**
 * Promotion-code field for **monthly subscriptions** (separate flag from one-time NCS,
 * because Stripe Subscription coupon math has its own surface area — `duration: once`
 * vs `forever` vs `repeating` — and Mindbody-side renewal sync behavior had to be
 * verified independently from the one-time NCS verification matrix).
 *
 * Default OFF. Flip `ENABLE_STRIPE_RECURRING_COUPONS=1` in Netlify env vars only after:
 *
 *   1. Regression: subscription without coupon → Mindbody Sale unchanged byte-for-byte.
 *   2. `duration: once` coupon → first invoice has discount; renewal at full price.
 *   3. `duration: forever` coupon → every invoice carries the discount.
 *   4. Fixed-amount-off coupon (e.g. $20 off) → cents math verified end-to-end.
 *
 * 100%-off coupons are explicitly NOT supported in V1.5 (see § 9.15 in the doc); the
 * `stripe-webhook.mjs::handleInvoicePaid` 100%-off guard records a clear
 * `coupon_100_percent_off_unsupported` `lastError`. Operationally, the studio simply
 * does not create 100%-off promotion codes for monthly SKUs.
 */
function recurringCouponsEnabled() {
  const v = (process.env.ENABLE_STRIPE_RECURRING_COUPONS || "").trim();
  return v === "1" || v.toLowerCase() === "true";
}

/**
 * Kill switch for the Mindbody-driven Contact information prefill on Stripe Checkout.
 * Default ON. Set `STRIPE_CHECKOUT_PREFILL_FROM_MINDBODY=0` in Netlify env vars to disable
 * without a redeploy if Mindbody latency or downtime starts hurting checkout.
 */
function prefillFromMindbodyEnabled() {
  const v = (process.env.STRIPE_CHECKOUT_PREFILL_FROM_MINDBODY ?? "1").trim();
  return v !== "0" && v.toLowerCase() !== "false" && v.toLowerCase() !== "off";
}

/**
 * Per-call timeout for the prefill Mindbody round-trips (clientId-by-email + contact lookup).
 * Bounded between 2s and 10s. Default 5s. Anything slower than this falls back to anonymous
 * checkout silently — the customer should never wait longer than this for prefill.
 */
function prefillTimeoutMs() {
  const raw = parseInt(process.env.STRIPE_CHECKOUT_PREFILL_TIMEOUT_MS || "5000", 10);
  if (!Number.isFinite(raw)) return 5000;
  return Math.min(Math.max(raw, 2000), 10000);
}

function stripeSecret() {
  const k = (process.env.STRIPE_SECRET_KEY || "").trim();
  if (!k.startsWith("sk_")) return null;
  return k;
}

/** @param {unknown} event */
function parseJsonBody(event) {
  if (!event || typeof event !== "object") return {};
  const e = /** @type {{ body?: unknown; isBase64Encoded?: boolean }} */ (event);
  if (e.body == null || e.body === "") return {};
  const raw = e.isBase64Encoded
    ? Buffer.from(/** @type {string} */ (e.body), "base64").toString("utf8")
    : /** @type {string} */ (e.body);
  if (typeof raw === "string" && !raw.trim()) return {};
  try {
    return JSON.parse(typeof raw === "string" ? raw.trim() : String(raw));
  } catch {
    return null;
  }
}

/** @param {unknown} event */
function originFromEvent(event) {
  if (!event || typeof event !== "object") return "";
  const headers = /** @type {{ headers?: Record<string, string | undefined> }} */ (event).headers || {};
  const o = String(headers.origin ?? headers.Origin ?? "").trim();
  if (o) return o.replace(/\/$/, "");
  const proto = String(headers["x-forwarded-proto"] ?? "https");
  const host = String(headers.host ?? headers.Host ?? "").trim();
  if (host) return `${proto}://${host}`.replace(/\/$/, "");
  const env = (process.env.SITE_URL || "").trim().replace(/\/$/, "");
  return env;
}

function isAppOrLoopbackOrigin(origin) {
  try {
    const host = new URL(origin).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host.endsWith(".local");
  } catch {
    return false;
  }
}

/**
 * Website Checkout keeps using the page Origin.
 * Capacitor / Vite app Origins (https://localhost, http://127.0.0.1:5178) do not
 * host /checkout/success — send those buyers back to the site origin instead.
 * Does not change fulfillment.
 */
function hostedCheckoutReturnOrigin(event) {
  const requestOrigin = originFromEvent(event);
  if (requestOrigin && !isAppOrLoopbackOrigin(requestOrigin)) return requestOrigin;
  const site = (
    (process.env.URL || "").trim() ||
    (process.env.SITE_URL || "").trim() ||
    (process.env.DEPLOY_PRIME_URL || "").trim()
  ).replace(/\/$/, "");
  if (site && !isAppOrLoopbackOrigin(site)) return site;
  if (!event || typeof event !== "object") return site || requestOrigin;
  const headers = /** @type {{ headers?: Record<string, string | undefined> }} */ (event).headers || {};
  const proto = String(headers["x-forwarded-proto"] ?? headers["X-Forwarded-Proto"] ?? "https")
    .split(",")[0]
    .trim();
  const host = String(
    headers["x-forwarded-host"] ?? headers["X-Forwarded-Host"] ?? headers.host ?? headers.Host ?? "",
  )
    .split(",")[0]
    .trim();
  if (host && !isAppOrLoopbackOrigin(`${proto}://${host}`)) {
    return `${proto}://${host}`.replace(/\/$/, "");
  }
  return site || requestOrigin;
}

/** @param {unknown} v @param {number} max */
/**
 * Stripe Customer.phone must be E.164 for Checkout to prefill the phone field reliably.
 * Raw 10-digit US numbers (e.g. `7865031414`) prefill email via Customer but leave phone blank.
 * @param {unknown} raw
 * @returns {string}
 */
function formatStripeCustomerPhoneE164(raw) {
  const norm = normalizeUsMobilePhone(raw);
  if (norm) return `+1${norm}`;
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return "";
  const compact = trimmed.replace(/[\s().-]/g, "");
  if (/^\+[1-9]\d{6,14}$/.test(compact)) return compact;
  return trimmed.slice(0, 32);
}

function safeStr(v, max) {
  if (typeof v !== "string") return "";
  return v.trim().slice(0, max);
}

/** @param {string} email */
function isReasonableEmail(email) {
  if (!email || email.length > 254) return false;
  return /^[^\s@]{1,200}@[^\s@]{1,64}\.[A-Za-z0-9.-]{2,24}$/.test(email);
}

/**
 * Structured logs for NCS `block_before_checkout_if_known` pre-check (no PII).
 * Grep Netlify for `stripe_checkout_ncs_precheck_`.
 *
 * @param {"stripe_checkout_ncs_precheck_start"|"stripe_checkout_ncs_precheck_result"|"stripe_checkout_ncs_precheck_blocked"|"stripe_checkout_ncs_precheck_skipped"} event
 * @param {Record<string, unknown>} fields
 */
function logNcsPrecheck(event, fields) {
  const line = JSON.stringify({ event, ...fields });
  if (event === "stripe_checkout_ncs_precheck_skipped") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

/** Header reader: tolerate Netlify casing inconsistencies. @param {unknown} event @param {string} name */
function header(event, name) {
  if (!event || typeof event !== "object") return "";
  const headers = /** @type {{ headers?: Record<string, string | undefined> }} */ (event).headers || {};
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) return String(headers[k] || "").trim();
  }
  return "";
}

/**
 * Idempotently bind a Stripe Customer to a logged-in Mindbody member so that Stripe Checkout
 * can pre-fill Contact information (email, name, phone) instead of asking returning members
 * to retype it. Behaviour:
 *   1. Try `customers.list({ email, limit: 100 })`. We do NOT use `customers.search` here —
 *      Stripe search is eventually consistent and could miss a Customer we just created seconds
 *      ago in another webhook run.
 *   2. If a Customer with `metadata.mindbodyClientId === clientId` exists, reuse it.
 *   3. Else if a Customer with the same email exists (any source), patch its name/phone/metadata
 *      to mark it as our Mindbody-tied Customer and reuse it. This avoids duplicate customers
 *      when the same person previously paid as a guest.
 *   4. Else create a new Customer with email + name + phone + metadata.
 *
 * Returns null on any failure — callers fall back to `customer_email` so checkout still works
 * (just without phone/name prefill).
 *
 * @param {Stripe} stripe
 * @param {{ email: string; fullName: string; phone: string; mindbodyClientId: number; amareUserId?: string | null }} input
 * @param {string} idemBase Idempotency key root tied to the order being created
 * @returns {Promise<string | null>}
 */
async function findOrCreateStripeCustomerForMindbodyMember(stripe, input, idemBase) {
  const email = (input.email || "").trim().toLowerCase();
  const fullName = (input.fullName || "").trim().slice(0, 160);
  const phone = formatStripeCustomerPhoneE164(input.phone);
  const clientId = String(input.mindbodyClientId);
  const amareUserId = typeof input.amareUserId === "string" && input.amareUserId.startsWith("usr_")
    ? input.amareUserId
    : "";
  if (!email && !clientId) return null;
  return await findOrCreateStripeCustomerInternal(stripe, {
    email,
    fullName,
    phone,
    clientId,
    idemBase,
    amareUserId,
  });
}

/**
 * Same as `findOrCreateStripeCustomerForMindbodyMember` but for **anonymous** buyers — no
 * known Mindbody clientId yet. Used when the new pre-checkout dialog collects email + names +
 * phone from a brand-new visitor: we still bind the Stripe Customer up-front so Checkout shows
 * email/name/phone pre-filled and the buyer only sees "Pay" instead of a blank Contact form.
 *
 * The `clientId` field is left empty in metadata; it will be patched on the Stripe Customer at
 * webhook time (via `customer.update` inside `resolveOrCreateMindbodyClient`'s downstream path)
 * once the real Studio Client is created/matched.
 *
 * @param {Stripe} stripe
 * @param {{ email: string; fullName: string; phone: string }} input
 * @param {string} idemBase
 * @returns {Promise<string | null>}
 */
async function findOrCreateStripeCustomerForAnonymousBuyer(stripe, input, idemBase) {
  const email = (input.email || "").trim().toLowerCase();
  if (!email) return null;
  const fullName = (input.fullName || "").trim().slice(0, 160);
  const phone = formatStripeCustomerPhoneE164(input.phone);
  return await findOrCreateStripeCustomerInternal(stripe, {
    email,
    fullName,
    phone,
    clientId: "",
    idemBase,
    anonymous: true,
  });
}

/**
 * Shared list-then-bind logic for both member and anonymous Stripe Customer prefill.
 * Returns null on any Stripe API failure so callers fall back to `customer_email` only.
 *
/**
 * Conservative Stripe Customer backfill. Fills blanks and refreshes Studio metadata.
 * Never overwrites an existing name. Does not merge/delete customers.
 *
 * @param {Stripe} stripe
 * @param {Stripe.Customer} c
 * @param {{
 *   email: string;
 *   fullName: string;
 *   phone: string;
 *   clientId: string;
 *   idemBase: string;
 *   anonymous: boolean;
 *   amareUserId?: string;
 * }} input
 */
async function backfillStripeCustomerContact(stripe, c, input) {
  /** @type {Stripe.CustomerUpdateParams} */
  const patch = {};
  let needs = false;
  const md = c.metadata || {};
  /** @type {Record<string, string>} */
  const nextMd = { ...md };
  if (!input.anonymous && input.clientId && md.mindbodyClientId !== input.clientId) {
    nextMd.mindbodyClientId = input.clientId;
    nextMd.source = md.source || "amare_site";
    needs = true;
  }
  if (input.amareUserId && md.amareUserId !== input.amareUserId) {
    nextMd.amareUserId = input.amareUserId;
    needs = true;
  }
  if (needs) patch.metadata = nextMd;
  if (!c.name && input.fullName) {
    patch.name = input.fullName;
    needs = true;
  }
  if (input.phone && (!c.phone || (input.anonymous && c.phone !== input.phone))) {
    patch.phone = input.phone;
    needs = true;
  }
  if (!needs) return;
  try {
    await stripe.customers.update(c.id, patch, {
      idempotencyKey: `cust-update_${input.idemBase}_${c.id}`,
    });
  } catch (e) {
    console.error(
      JSON.stringify({
        event: "stripe_customer_update_failed",
        customerId: c.id,
        detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 200),
      }),
    );
  }
}

/**
 * @param {Stripe} stripe
 * @param {{ email: string; fullName: string; phone: string; clientId: string; idemBase: string; anonymous?: boolean; amareUserId?: string }} input
 * @returns {Promise<string | null>}
 */
async function findOrCreateStripeCustomerInternal(stripe, input) {
  const { email, fullName, phone, clientId, idemBase } = input;
  const anonymous = input.anonymous === true;
  const amareUserId = typeof input.amareUserId === "string" && input.amareUserId.startsWith("usr_")
    ? input.amareUserId
    : "";

  /**
   * Strongest commercial key for a linked Studio customer is mindbodyClientId.
   * Search first so Email OTP vs legacy Mindbody casing does not create a second Customer.
   */
  if (!anonymous && clientId) {
    try {
      const found = await stripe.customers.search({
        query: `metadata['mindbodyClientId']:'${clientId}'`,
        limit: 20,
      });
      /** @type {Array<Stripe.Customer & { hasActiveSubscription?: boolean }>} */
      const hits = (found.data || []).filter((c) => c && !c.deleted);
      if (hits.length > 1) {
        for (const c of hits) {
          try {
            const subs = await stripe.subscriptions.list({ customer: c.id, status: "active", limit: 1 });
            c.hasActiveSubscription = (subs.data || []).length > 0;
          } catch {
            c.hasActiveSubscription = false;
          }
        }
      }
      const picked = pickStripeCustomerFromCandidates(hits, clientId);
      if (picked.duplicates) {
        console.warn(
          JSON.stringify({
            event: "stripe_customer_duplicates_for_client",
            mindbodyClientId: clientId,
            count: hits.length,
            picked: picked.customer?.id || null,
            reason: picked.reason,
          }),
        );
      }
      if (picked.customer?.id) {
        await backfillStripeCustomerContact(stripe, picked.customer, {
          email,
          fullName,
          phone,
          clientId,
          idemBase,
          anonymous: false,
          amareUserId,
        });
        return picked.customer.id;
      }
    } catch (e) {
      console.warn(
        JSON.stringify({
          event: "stripe_customer_search_by_client_failed",
          mindbodyClientId: clientId,
          detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 200),
        }),
      );
    }
  }

  if (!email) return null;

  /** @type {Stripe.Customer[]} */
  let existing = [];
  try {
    const list = await stripe.customers.list({ email, limit: 100 });
    existing = list.data || [];
  } catch (e) {
    console.error(
      JSON.stringify({
        event: "stripe_customer_list_failed",
        detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 200),
      }),
    );
    return null;
  }

  const backfillArgs = {
    email,
    fullName,
    phone,
    clientId,
    idemBase,
    anonymous,
    amareUserId,
  };

  /**
   * Member path: prefer Customer already tagged with this Mindbody clientId. Anonymous path:
   * skip clientId match (we don't have one) and go straight to email match.
   */
  if (!anonymous) {
    const byMindbodyId = existing.find(
      (c) => c && c.metadata && c.metadata.mindbodyClientId === clientId,
    );
    if (byMindbodyId && byMindbodyId.id) {
      await backfillStripeCustomerContact(stripe, byMindbodyId, backfillArgs);
      return byMindbodyId.id;
    }
  }

  /**
   * Email fallback: reuse only when the Customer is untagged or already belongs to
   * this Studio client. A different mindbodyClientId means a different person.
   */
  const byEmail = existing.find((c) => {
    if (!c || !c.id || c.deleted) return false;
    const tagged = c.metadata && String(c.metadata.mindbodyClientId || "");
    if (!anonymous && clientId && tagged && tagged !== clientId) return false;
    return true;
  });
  if (byEmail && byEmail.id) {
    await backfillStripeCustomerContact(stripe, byEmail, backfillArgs);
    return byEmail.id;
  }

  try {
    /**
     * Idempotency key includes a stable suffix per call: `clientId` for known members
     * (deduplicates retries for the same buyer), `email` for anonymous (deduplicates retries
     * for the same anonymous buyer in the same order). Never combine member+anon under the
     * same idempotency key — they have semantically different metadata payloads.
     */
    const createSuffix = anonymous ? `anon_${email}` : clientId;
    /** @type {Record<string, string>} */
    const metadata = {
      source: "amare_site",
      flow: "stripe_to_mindbody_one_time",
    };
    if (!anonymous) metadata.mindbodyClientId = clientId;
    if (amareUserId) metadata.amareUserId = amareUserId;
    const created = await stripe.customers.create(
      {
        email,
        name: fullName || undefined,
        phone: phone || undefined,
        metadata,
      },
      { idempotencyKey: `cust-create_${idemBase}_${createSuffix}` },
    );
    return created?.id || null;
  } catch (e) {
    console.error(
      JSON.stringify({
        event: "stripe_customer_create_failed",
        clientId: clientId || null,
        anonymous,
        detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 200),
      }),
    );
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Subscription helpers (Stripe Recurring Membership — Option A)              */
/* -------------------------------------------------------------------------- */

/**
 * Resolve / create a Stripe Customer for a recurring subscription.
 *
 * Lookup priority (per docs/MEMBERSHIP-RECURRING-CHECKOUT.md §4.2):
 *   1. Existing SubscriptionRecord by Mindbody clientId — even if canceled, we reuse the
 *      Customer so admin tooling sees one record per buyer across re-subscribe cycles.
 *   2. Existing OrderRecord by email — same buyer paid for a one-time package previously.
 *      Reusing avoids creating duplicate Customers in Stripe Dashboard.
 *   3. `customers.search` by email/metadata — broader catch (eventually consistent on Stripe).
 *   4. `customers.create` with the full metadata payload.
 *
 * Always patches `metadata.mindbodyClientId`, `metadata.email`, and `metadata.source`
 * on the resolved Customer so future webhook lookups can map either direction. Backfills
 * `name` / `phone` only when the Customer record is missing them (conservative — never
 * overwrites a value the buyer typed in another flow).
 *
 * Failures here are NOT silent — a Stripe Customer is mandatory for `mode: subscription`,
 * so we throw rather than return null. The handler converts to a 502.
 *
 * @param {Stripe} stripe
 * @param {{
 *   email: string;
 *   fullName: string;
 *   phone: string;
 *   mindbodyClientId: number;
 *   amareUserId?: string | null;
 *   subscriptionId: string;
 *   subscriptionStore: ReturnType<typeof openSubscriptionStore>;
 *   orderStore: ReturnType<typeof openOrderStore>;
 * }} input
 * @returns {Promise<string>}
 */
async function resolveOrCreateStripeCustomerForSubscription(stripe, input) {
  const email = (input.email || "").trim().toLowerCase();
  const fullName = (input.fullName || "").trim().slice(0, 160);
  const phone = formatStripeCustomerPhoneE164(input.phone);
  const clientIdStr = String(input.mindbodyClientId);
  const amareUserId =
    typeof input.amareUserId === "string" && input.amareUserId.startsWith("usr_")
      ? input.amareUserId
      : "";

  if (!email && !clientIdStr) {
    throw new Error("subscription_customer_email_required");
  }

  /**
   * Strategy 1: scan existing SubscriptionRecords for the same Mindbody client. We check
   * the three "active-ish" statuses + the canceled terminals so an admin who re-enrolls
   * a previously-canceled member reuses the same Stripe Customer (single-record-per-buyer
   * audit trail). Bounded scan via the store's listByStatus helper.
   */
  /** @type {string | null} */
  let foundCustomerId = null;
  if (input.subscriptionStore?.available) {
    /** @type {Array<"pending_first_invoice" | "active" | "past_due" | "canceled_admin" | "canceled_payment_failure">} */
    const statuses = [
      "active",
      "pending_first_invoice",
      "past_due",
      "canceled_admin",
      "canceled_payment_failure",
    ];
    for (const s of statuses) {
      const list = await input.subscriptionStore.listByStatus(s, { limit: 200 });
      const match = list.find(
        (r) => r && r.mindbodyClientId === input.mindbodyClientId && r.stripeCustomerId,
      );
      if (match && match.stripeCustomerId) {
        foundCustomerId = match.stripeCustomerId;
        break;
      }
    }
  }

  /**
   * Strategy 2: look at the one-time order store. Logged-in members who bought NCS or a
   * pack via Stripe already have a Stripe Customer with `metadata.mindbodyClientId` set —
   * reuse it for the new subscription instead of creating a duplicate.
   *
   * We don't have a direct "by email" index on orders, so we lean on the (already-existing)
   * paid-but-not-synced status + a broad scan via the membership listByStatus equivalent —
   * actually, simpler: we just call `stripe.customers.list({ email })` next, which Stripe
   * indexes properly. Skip the O(N) order-store scan in V1.
   */

  /** Strategy 3a: Stripe metadata search by Studio clientId (email-independent). */
  if (!foundCustomerId && clientIdStr) {
    try {
      const found = await stripe.customers.search({
        query: `metadata['mindbodyClientId']:'${clientIdStr}'`,
        limit: 20,
      });
      /** @type {Array<Stripe.Customer & { hasActiveSubscription?: boolean }>} */
      const hits = (found.data || []).filter((c) => c && !c.deleted);
      if (hits.length > 1) {
        for (const c of hits) {
          try {
            const subs = await stripe.subscriptions.list({ customer: c.id, status: "active", limit: 1 });
            c.hasActiveSubscription = (subs.data || []).length > 0;
          } catch {
            c.hasActiveSubscription = false;
          }
        }
      }
      const picked = pickStripeCustomerFromCandidates(hits, clientIdStr);
      if (picked.duplicates) {
        console.warn(
          JSON.stringify({
            event: "stripe_customer_duplicates_for_client",
            mindbodyClientId: clientIdStr,
            count: hits.length,
            picked: picked.customer?.id || null,
            reason: picked.reason,
            flow: "subscription",
          }),
        );
      }
      if (picked.customer?.id) foundCustomerId = picked.customer.id;
    } catch (e) {
      console.warn(
        JSON.stringify({
          event: "stripe_subscription_customer_search_failed",
          detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 200),
        }),
      );
    }
  }

  /** Strategy 3b: Stripe-side lookup by email. Prefer exact Studio metadata; skip foreign clientIds. */
  if (!foundCustomerId && email) {
    try {
      const list = await stripe.customers.list({ email, limit: 100 });
      const candidates = list.data || [];
      const tagged = candidates.find(
        (c) => c && c.metadata && c.metadata.mindbodyClientId === clientIdStr,
      );
      if (tagged && tagged.id) foundCustomerId = tagged.id;
      else {
        const safe = candidates.find((c) => {
          if (!c || !c.id || c.deleted) return false;
          const taggedId = c.metadata && String(c.metadata.mindbodyClientId || "");
          return !taggedId || taggedId === clientIdStr;
        });
        if (safe && safe.id) foundCustomerId = safe.id;
      }
    } catch (e) {
      console.warn(
        JSON.stringify({
          event: "stripe_subscription_customer_list_failed",
          detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 200),
        }),
      );
      /* fall through to create */
    }
  }

  /** Strategy 4: create a fresh Customer. */
  if (!foundCustomerId) {
    if (!email) {
      throw new Error("subscription_customer_email_required");
    }
    /** @type {Record<string, string>} */
    const metadata = {
      mindbodyClientId: clientIdStr,
      email,
      source: "amare_membership_checkout",
      flow: "stripe_recurring_subscription",
    };
    if (amareUserId) metadata.amareUserId = amareUserId;
    const created = await stripe.customers.create(
      {
        email,
        name: fullName || undefined,
        phone: phone || undefined,
        metadata,
      },
      { idempotencyKey: `sub-cust-create_${input.subscriptionId}` },
    );
    if (!created?.id) {
      throw new Error("stripe_customer_create_returned_no_id");
    }
    return created.id;
  }

  /**
   * Existing Customer found — patch metadata so future webhook lookups can map either
   * direction. Conservatively backfill name/phone only if missing (don't overwrite values
   * the buyer chose in a different flow).
   */
  try {
    /** @type {Stripe.Customer | null} */
    const existing = await stripe.customers.retrieve(foundCustomerId).then(
      (c) => /** @type {Stripe.Customer} */ (c),
      () => null,
    );
    /** @type {Stripe.CustomerUpdateParams} */
    const patch = {};
    let needsUpdate = false;
    const md = (existing && existing.metadata) || {};
    /** @type {Record<string, string>} */
    const nextMd = { ...md };
    if (md.mindbodyClientId !== clientIdStr) {
      nextMd.mindbodyClientId = clientIdStr;
      needsUpdate = true;
    }
    if (!md.source) {
      nextMd.source = "amare_membership_checkout";
      needsUpdate = true;
    } else if (md.source !== "amare_membership_checkout") {
      /** Annotate that this customer now also has a recurring relationship; don't clobber the original source. */
      nextMd.recurringMembership = "1";
      needsUpdate = true;
    }
    if (email && md.email !== email) {
      nextMd.email = email;
      needsUpdate = true;
    }
    if (amareUserId && md.amareUserId !== amareUserId) {
      nextMd.amareUserId = amareUserId;
      needsUpdate = true;
    }
    if (needsUpdate) patch.metadata = nextMd;
    if (existing && !existing.name && fullName) {
      patch.name = fullName;
      needsUpdate = true;
    }
    if (existing && !existing.phone && phone) {
      patch.phone = phone;
      needsUpdate = true;
    }
    if (needsUpdate) {
      await stripe.customers.update(foundCustomerId, patch, {
        idempotencyKey: `sub-cust-update_${input.subscriptionId}_${foundCustomerId}`,
      });
    }
  } catch (e) {
    console.warn(
      JSON.stringify({
        event: "stripe_subscription_customer_update_failed",
        customerId: foundCustomerId,
        detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 200),
      }),
    );
    /** Even if patch failed we can still proceed — the Customer is valid. */
  }
  return foundCustomerId;
}

/**
 * Add `n` calendar months to an ISO timestamp, clamping the day-of-month to the last
 * valid day if the target month is shorter (e.g., Jan 31 + 1 month → Feb 28/29).
 *
 * Used to compute `commitmentEndDate = commitmentStartDate + minimumCommitmentMonths`.
 *
 * @param {Date} from
 * @param {number} months
 */
function addMonthsClamped(from, months) {
  const d = new Date(from.getTime());
  const targetMonth = d.getUTCMonth() + months;
  const targetYear = d.getUTCFullYear() + Math.floor(targetMonth / 12);
  const normalizedMonth = ((targetMonth % 12) + 12) % 12;
  const desiredDay = d.getUTCDate();
  /** Last day of the target month, in UTC. */
  const lastDayOfTargetMonth = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
  const day = Math.min(desiredDay, lastDayOfTargetMonth);
  return new Date(Date.UTC(targetYear, normalizedMonth, day, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()));
}

/**
 * Find any active-ish SubscriptionRecord for the given Mindbody client. Used to enforce
 * `block_if_active_subscription` — V1 does not support plan changes from inside the
 * customer-facing flow, so any pre-existing active sub blocks a new one.
 *
 * @param {ReturnType<typeof openSubscriptionStore>} store
 * @param {number} mindbodyClientId
 */
async function findActiveSubscriptionForClient(store, mindbodyClientId) {
  if (!store.available) return null;
  /**
   * `pending_first_invoice` records that were created but the buyer never paid become
   * orphans the moment their Stripe Checkout Session expires (~24h default). Without
   * this guard, every aborted Subscribe flow permanently blocks the buyer from any
   * future monthly purchase — see `docs/MEMBERSHIP-RECURRING-CHECKOUT.md` §9.14.
   *
   * We skip pending records that:
   *   • carry a placeholder `pending_<id>` `stripeSubscriptionId` (real id never bound)
   *     AND were created more than 30 minutes ago — well beyond a reasonable in-flight
   *     checkout, well within Stripe's session TTL so unpaid sessions are effectively dead.
   * `checkout.session.expired` will eventually patch the record to `canceled_admin` via
   * `stripe-webhook.mjs`, but webhook delivery can lag ~hours; this client-side cutoff
   * unblocks honest retries immediately.
   */
  const PENDING_ORPHAN_AGE_MS = 30 * 60 * 1000;
  const nowMs = Date.now();
  for (const s of /** @type {const} */ (["active", "pending_first_invoice", "past_due"])) {
    const list = await store.listByStatus(s, { limit: 200 });
    const match = list.find((r) => {
      if (!r || r.mindbodyClientId !== mindbodyClientId) return false;
      if (r.status === "pending_first_invoice") {
        const subId = String(r.stripeSubscriptionId || "");
        const looksOrphan = !subId || subId.startsWith("pending_");
        if (!looksOrphan) return true;
        const createdMs = Date.parse(r.createdAt || "") || 0;
        if (createdMs && nowMs - createdMs > PENDING_ORPHAN_AGE_MS) return false;
      }
      return true;
    });
    if (match) return match;
  }
  return null;
}

/**
 * Subscription branch dispatched from the main handler when the catalog item is a
 * monthlyMembership / `stripeMode === "subscription"`. Returns a fully-formed handler
 * response (statusCode + body) — caller just `return`s it.
 *
 * Idempotency: the handler is safe to call multiple times for the same `idempotencyKey`
 * because (a) Stripe's own idempotency-key-on-create-session prevents duplicate sessions,
 * and (b) our subscription store's onlyIfNew put refuses to overwrite an existing record.
 *
 * @param {{
 *   stripe: Stripe;
 *   item: ReturnType<typeof getCatalogItem>;
 *   body: Record<string, unknown>;
 *   event: unknown;
 *   knownMindbodyClientId: number | null;
 *   trustKnownClientId?: boolean;
 *   amareUserId?: string | null;
 *   commerceAuthSource?: string | null;
 *   getStaffHeaders: () => Promise<Record<string, string> | null | undefined>;
 *   memberSessionEmail: string | null;
 *   customerEmail: string;
 *   customerName: string;
 *   customerFirstName: string;
 *   customerLastName: string;
 *   customerPhone: string;
 *   ctaLocation: string | null;
 *   pageLocation: string | null;
 *   createIdempotencyKey: string | null;
 *   originUrl: string;
 *   eventClientIp: string;
 *   eventUserAgent: string;
 * }} ctx
 */
async function handleMembershipSubscription(ctx) {
  const { stripe, item, body, event } = ctx;
  if (!item) {
    return jsonResponse(500, { ok: false, error: "internal_no_item" });
  }
  if (!recurringFeatureEnabled()) {
    return jsonResponse(503, {
      ok: false,
      error: "stripe_recurring_checkout_disabled",
      message:
        "Stripe recurring membership checkout is not enabled on this server. Set ENABLE_STRIPE_RECURRING_CHECKOUT=1 after sandbox testing.",
    });
  }
  if (!item.enabled) return jsonResponse(403, { ok: false, error: "sku_disabled" });
  if (item.stripeMode !== "subscription" || item.kind !== "monthlyMembership") {
    return jsonResponse(400, { ok: false, error: "sku_not_a_subscription" });
  }
  if (item.mindbodyServiceId == null) {
    return jsonResponse(500, { ok: false, error: "subscription_sku_missing_mindbodyServiceId" });
  }
  if (!item.mindbodyContractProductId) {
    return jsonResponse(500, {
      ok: false,
      error: "subscription_sku_missing_mindbodyContractProductId",
    });
  }
  if (item.recurringInterval !== "month") {
    return jsonResponse(500, { ok: false, error: "subscription_sku_unsupported_interval" });
  }

  const subStore = openSubscriptionStore(event);
  if (!subStore.available) {
    return jsonResponse(503, {
      ok: false,
      error: "subscription_store_unavailable",
    });
  }

  const purchaseSource = derivePurchaseSource(body, ctx.ctaLocation);
  const selectedClassParsed = parseSelectedClassFromBody(body);
  const subCapturedAt = new Date().toISOString();
  /** @type {import("./stripe-subscription-store.mjs").SubscriptionRecord["selectedClassContext"]=} */
  const selectedClassContext =
    purchaseSource === "classes" && selectedClassParsed
      ? buildSelectedClassContext(selectedClassParsed, subCapturedAt)
      : undefined;

  /* ---------------- Validate consent fields ------------------------------- */
  /**
   * The subscription branch ALWAYS requires a fresh consent submission — there is no
   * legacy "no-consent membership purchase" path to maintain. We force `requiresMembershipAgreement`
   * to true regardless of the body (defense against a buggy frontend dropping the flag).
   */
  const bodyForConsent = /** @type {Record<string, unknown>} */ ({
    ...body,
    requiresMembershipAgreement: true,
  });
  const subscriptionId = newSubscriptionId();
  const attemptId = randomUUID();
  const idemKey = ctx.createIdempotencyKey || `sub-create_${subscriptionId}`;
  const consentResult = validateMembershipElectronicConsent(
    bodyForConsent,
    item.mindbodyServiceId,
    attemptId,
    idemKey,
  );
  if (!consentResult.ok) return consentResult.response;
  const consent = /** @type {NonNullable<typeof consentResult.data>} */ (consentResult.data);
  if (!consent) {
    return jsonResponse(400, {
      ok: false,
      error: "membership_consent_required",
      message: "Membership agreement and billing authorization must be submitted with the request.",
    });
  }

  /* ---------------- Resolve / create Mindbody client ---------------------- */
  /**
   * We need the Mindbody clientId BEFORE creating the Stripe Subscription so that:
   *   • The `block_if_active_subscription` check has a stable identity to look up.
   *   • Stripe Customer metadata can carry `mindbodyClientId` on first creation.
   *   • The webhook can short-circuit and not have to resolve clientId on every renewal.
   *
   * Failures here surface as 502 — unlike the one-time path, we cannot fulfill the
   * subscription later if Mindbody doesn't know the buyer.
   */
  const staffHeaders = await ctx.getStaffHeaders();
  if (!staffHeaders) {
    return jsonResponse(503, {
      ok: false,
      error: "staff_credentials_unavailable",
      message:
        "Mindbody staff token is not configured on the server. Subscription cannot be started until it is.",
    });
  }
  if (ctx.trustKnownClientId === true && !(Number(ctx.knownMindbodyClientId) > 0)) {
    return jsonResponse(409, {
      ok: false,
      error: "commerce_client_unresolved",
      message: "Your studio account could not be resolved for this purchase. Sign out and try again.",
    });
  }
  const resolved = await resolveOrCreateMindbodyClient(
    {
      knownMindbodyClientId: ctx.knownMindbodyClientId,
      trustKnownClientId: ctx.trustKnownClientId === true,
      email: ctx.customerEmail || ctx.memberSessionEmail || "",
      fullName:
        [ctx.customerFirstName, ctx.customerLastName].filter(Boolean).join(" ").trim() ||
        ctx.customerName,
      firstName: ctx.customerFirstName || undefined,
      lastName: ctx.customerLastName || undefined,
      phone: ctx.customerPhone || "",
    },
    staffHeaders,
  );
  if (!resolved.ok) {
    if (resolved.reason === "multiple_client_matches") {
      return jsonResponse(409, {
        ok: false,
        error: "multiple_client_matches",
        message:
          "Your email matches multiple Mindbody profiles — please contact us to merge them before starting a membership.",
        candidateCount: resolved.candidateCount,
      });
    }
    return jsonResponse(502, {
      ok: false,
      error: "client_resolve_failed",
      reason: resolved.reason,
      message: resolved.message || "",
    });
  }

  /* ---------------- Duplicate-subscription check -------------------------- */
  if (!subStore.available) {
    return jsonResponse(503, {
      ok: false,
      error: "subscription_store_unavailable",
      message:
        "Subscription persistence (Netlify Blobs) is not available on this Function. Configure Blobs and redeploy.",
    });
  }
  if (item.duplicatePolicy === "block_if_active_subscription") {
    const existing = await findActiveSubscriptionForClient(subStore, resolved.clientId);
    if (existing) {
      console.warn(
        JSON.stringify({
          event: "stripe_subscription_blocked_active_duplicate",
          existingSubscriptionId: existing.id,
          existingSku: existing.localSku,
          existingStatus: existing.status,
          requestedSku: item.localSku,
          mindbodyClientId: resolved.clientId,
        }),
      );
      return jsonResponse(409, {
        ok: false,
        error: "subscription_already_active",
        message:
          "You already have an active Amaré monthly membership. Please contact us to change plans.",
        existingSku: existing.localSku,
        existingStatus: existing.status,
      });
    }
  }

  /* ---------------- Persist consent record (audit) ------------------------ */
  /**
   * The membership-consent blob store is the canonical legal audit trail. We persist
   * BEFORE creating the Stripe Subscription so that even if Stripe fails afterwards we
   * have a record of what the customer agreed to. The SubscriptionRecord then references
   * this blob via `membershipConsentId`.
   */
  const consentBlobStore = tryOpenMembershipConsentBlobStore(event);
  /** @type {string} */
  const consentId = `${subscriptionId}_${attemptId.replace(/-/g, "").slice(0, 12)}`;
  if (consentBlobStore) {
    try {
      const nowIso = new Date().toISOString();
      const consentRecord = {
        consentId,
        subscriptionId,
        flow: "stripe_recurring_subscription",
        localSku: item.localSku,
        mindbodyClientId: resolved.clientId,
        mindbodyServiceId: item.mindbodyServiceId,
        mindbodyContractProductId: item.mindbodyContractProductId,
        contractVersion: consent.contractVersion,
        contractProductKey: consent.contractProductId,
        contractName: consent.contractName,
        agreementAccepted: consent.membershipAgreementAccepted,
        billingAuthorized: consent.membershipBillingAuthorized,
        legalNameTyped: consent.fullNameTyped,
        agreementTextHash: consent.termsTextHash,
        agreementTextSnapshot: consent.termsSanitized,
        clientIp: ctx.eventClientIp,
        userAgent: ctx.eventUserAgent,
        acceptedAt: nowIso,
        auditCreatedAt: nowIso,
        auditUpdatedAt: nowIso,
      };
      await consentBlobStore.setJSON(membershipConsentBlobKey(consentId), consentRecord);
    } catch (e) {
      console.error(
        JSON.stringify({
          event: "stripe_subscription_consent_persist_failed",
          subscriptionId,
          detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 240),
        }),
      );
      return jsonResponse(503, {
        ok: false,
        error: "membership_consent_storage_unavailable",
        message:
          "Could not persist the membership consent record. Please try again — your card has not been charged.",
      });
    }
  } else if (membershipConsentBlobsEnabled()) {
    /** Operator turned the flag on but the store init failed — surface clearly. */
    return jsonResponse(503, {
      ok: false,
      error: "membership_consent_storage_unavailable",
      message:
        "Membership consent persistence is enabled but unavailable. Please try again shortly.",
    });
  }

  /* ---------------- Resolve / create Stripe Customer --------------------- */
  /** @type {string} */
  let stripeCustomerId;
  try {
    stripeCustomerId = await resolveOrCreateStripeCustomerForSubscription(stripe, {
      email: ctx.customerEmail || resolved.email || "",
      fullName:
        [ctx.customerFirstName, ctx.customerLastName].filter(Boolean).join(" ").trim() ||
        ctx.customerName ||
        "",
      phone: ctx.customerPhone || "",
      mindbodyClientId: resolved.clientId,
      amareUserId: ctx.amareUserId || null,
      subscriptionId,
      subscriptionStore: subStore,
      orderStore: openOrderStore(event),
    });
  } catch (e) {
    console.error(
      JSON.stringify({
        event: "stripe_subscription_customer_resolve_failed",
        subscriptionId,
        detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 240),
      }),
    );
    return jsonResponse(502, {
      ok: false,
      error: "stripe_customer_unavailable",
      message: "Could not prepare a Stripe Customer for this subscription. Please try again.",
    });
  }

  /* ---------------- Persist SubscriptionRecord (pre-Stripe) -------------- */
  const now = new Date();
  const commitmentMonths =
    typeof item.minimumCommitmentMonths === "number" && item.minimumCommitmentMonths > 0
      ? item.minimumCommitmentMonths
      : 0;
  const commitmentStartDate = now.toISOString();
  const commitmentEndDate =
    commitmentMonths > 0 ? addMonthsClamped(now, commitmentMonths).toISOString() : null;
  /** @type {number | null} */
  const earlyCancellationFeeCents =
    typeof item.earlyCancellationFeePercent === "number" && item.earlyCancellationFeePercent > 0
      ? Math.round((item.amountCents * item.earlyCancellationFeePercent) / 100)
      : null;

  /**
   * `stripeSubscriptionId` is intentionally a placeholder until the Stripe API call
   * returns one. We patch it after `stripe.checkout.sessions.create` resolves. The
   * format `pending_<subscriptionId>` keeps the index key valid (regex tolerant) without
   * pretending to be a real Stripe id.
   */
  /** @type {import("./stripe-subscription-store.mjs").SubscriptionRecord} */
  const initialRecord = {
    id: subscriptionId,
    stripeSubscriptionId: `pending_${subscriptionId}`,
    stripeCustomerId,
    stripeCheckoutSessionId: "",
    localSku: item.localSku,
    displayName: item.displayName,
    monthlyAmountCents: item.amountCents,
    currency: item.currency,
    mindbodyClientId: resolved.clientId,
    mindbodyServiceId: item.mindbodyServiceId,
    mindbodyContractProductId: item.mindbodyContractProductId,
    minimumCommitmentMonths: item.minimumCommitmentMonths,
    earlyCancellationFeePercent: item.earlyCancellationFeePercent,
    commitmentStartDate,
    commitmentEndDate,
    earlyCancellationFeeCents,
    membershipConsentId: consentId,
    agreementVersion: consent.contractVersion,
    agreementTextHash: consent.termsTextHash,
    agreementAcceptedAt: commitmentStartDate,
    legalNameTyped: consent.fullNameTyped,
    clientIp: ctx.eventClientIp,
    userAgent: ctx.eventUserAgent,
    status: "pending_first_invoice",
    currentPeriodStart: null,
    currentPeriodEnd: null,
    cancelAt: null,
    canceledAt: null,
    cancellationReason: null,
    invoices: [],
    customerEmail: ctx.customerEmail || resolved.email || undefined,
    customerName:
      [ctx.customerFirstName, ctx.customerLastName].filter(Boolean).join(" ").trim() ||
      ctx.customerName ||
      undefined,
    customerPhone: ctx.customerPhone || undefined,
    createdAt: commitmentStartDate,
    updatedAt: commitmentStartDate,
    stripeLivemode: false,
    ctaLocation: ctx.ctaLocation || undefined,
    pageLocation: ctx.pageLocation || undefined,
    purchaseSource: purchaseSource === "classes" ? "classes" : purchaseSource === "pricing" ? "pricing" : undefined,
    selectedClassContext,
    classesAutoBook: selectedClassContext
      ? {
          status: /** @type {const} */ ("pending"),
          attemptedAt: null,
          completedAt: null,
          result: null,
          reason: null,
        }
      : undefined,
    bookingFailureAdminEmail: selectedClassContext
      ? {
          status: /** @type {const} */ ("not_sent"),
          attemptedAt: null,
          sentAt: null,
          reason: null,
          lastError: null,
          checkoutSessionId: null,
          firstInvoiceId: null,
        }
      : undefined,
  };
  const putRes = await subStore.put(initialRecord, { onlyIfNew: true });
  if (!putRes.ok) {
    console.error(
      JSON.stringify({
        event: "stripe_subscription_put_failed",
        subscriptionId,
        reason: putRes.reason,
      }),
    );
    return jsonResponse(500, {
      ok: false,
      error: "subscription_persist_failed",
      detail: putRes.reason,
    });
  }

  /* ---------------- Create Stripe Checkout Session ----------------------- */
  const successUrl =
    (process.env.STRIPE_SUCCESS_URL_MEMBERSHIP || "").trim() ||
    `${ctx.originUrl}/checkout/success?session_id={CHECKOUT_SESSION_ID}&kind=membership&subscriptionId=${encodeURIComponent(subscriptionId)}`;
  const cancelUrl =
    (process.env.STRIPE_CANCEL_URL_MEMBERSHIP || "").trim() ||
    `${ctx.originUrl}/checkout/cancel?kind=membership&subscriptionId=${encodeURIComponent(subscriptionId)}`;

  /** @type {Record<string, string>} */
  const sessionMetadata = {
    orderType: "monthly_membership",
    subscriptionId,
    localSku: item.localSku,
    mindbodyClientId: String(resolved.clientId),
    mindbodyServiceId: String(item.mindbodyServiceId),
    mindbodyContractProductId: String(item.mindbodyContractProductId),
    membershipConsentId: consentId,
    agreementVersion: consent.contractVersion,
    agreementTextHash: consent.termsTextHash,
    flow: "stripe_recurring_subscription",
    amarePaymentFlow: "hosted_checkout",
    source: "amare_membership_checkout",
    siteId: amareSiteId(),
  };
  if (ctx.amareUserId) sessionMetadata.amareUserId = ctx.amareUserId;
  if (ctx.commerceAuthSource) sessionMetadata.commerceAuthSource = ctx.commerceAuthSource;

  /** @type {Stripe.Checkout.SessionCreateParams} */
  const params = {
    mode: "subscription",
    customer: stripeCustomerId,
    customer_update: { address: "auto", name: "auto" },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: item.currency,
          unit_amount: item.amountCents,
          recurring: { interval: "month" },
          product_data: {
            name: item.displayName,
            description: item.description || undefined,
            metadata: {
              localSku: item.localSku,
              mindbodyServiceId: String(item.mindbodyServiceId),
              kind: item.kind,
            },
          },
        },
      },
    ],
    /**
     * Promotion-code field is gated by `ENABLE_STRIPE_RECURRING_COUPONS`. With the flag
     * OFF (default) the field is not rendered — the membership flow stays exactly as
     * V1 shipped. With the flag ON, Stripe handles validation/application/arithmetic and
     * the per-invoice discount math flows into `stripe-webhook.mjs::handleInvoicePaid`'s
     * `extractInvoiceDiscountSnapshot`, then into Mindbody Sale `Items[0].DiscountAmount`.
     *
     * `duration` semantics (once / forever / repeating) are handled implicitly: the
     * webhook reads each invoice's `total_discount_amounts` independently, so a
     * `duration: once` coupon naturally becomes "first invoice discounted, renewals at
     * full price". No state machine on our side.
     */
    allow_promotion_codes: recurringCouponsEnabled(),
    /**
     * V1 contract: studio handles all post-signup actions manually. We deliberately do
     * NOT pass `billing_address_collection: "required"` (Stripe handles per-payment-method
     * defaults) and we never expose any Customer Portal entry point. See V1 decision in
     * `docs/MEMBERSHIP-RECURRING-CHECKOUT.md`.
     */
    payment_method_collection: "always",
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: subscriptionId,
    metadata: sessionMetadata,
    subscription_data: {
      /**
       * Same metadata is propagated onto the Subscription object itself so the
       * `invoice.paid` webhook can short-circuit lookup via `invoice.subscription` →
       * `subscription.metadata.subscriptionId` even if our by-checkout-session index
       * has not been written yet (race condition mitigation).
       */
      metadata: sessionMetadata,
    },
  };

  /** @type {Stripe.Checkout.Session} */
  let session;
  try {
    session = await stripe.checkout.sessions.create(params, {
      idempotencyKey: ctx.createIdempotencyKey ?? `sub-create-session_${subscriptionId}`,
    });
  } catch (e) {
    const detail = String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 240);
    const code = String(/** @type {{ code?: string }} */ (e)?.code ?? "");
    console.error(
      JSON.stringify({
        event: "stripe_subscription_create_session_failed",
        subscriptionId,
        localSku: item.localSku,
        code: code || undefined,
        detail,
      }),
    );
    /** Mark the SubscriptionRecord as terminally failed so admin can see why. */
    try {
      await subStore.patch(subscriptionId, {
        status: "canceled_payment_failure",
        cancellationReason: `stripe_create_session_failed:${code || "unknown"}`,
        canceledAt: new Date().toISOString(),
      });
    } catch {
      /* best-effort */
    }
    return jsonResponse(502, {
      ok: false,
      error: "stripe_create_session_failed",
      message: detail || "Stripe rejected the subscription session creation request.",
    });
  }

  /* ---------------- Patch SubscriptionRecord with session id ------------- */
  const subUpdate = await subStore.patch(subscriptionId, {
    stripeCheckoutSessionId: session.id,
    stripeLivemode: session.livemode === true,
    ...(selectedClassContext
      ? {
          bookingFailureAdminEmail: {
            status: /** @type {const} */ ("not_sent"),
            attemptedAt: null,
            sentAt: null,
            reason: null,
            lastError: null,
            checkoutSessionId: session.id,
            firstInvoiceId: null,
          },
        }
      : {}),
  });
  if (!subUpdate) {
    console.warn(
      JSON.stringify({
        event: "stripe_subscription_record_patch_session_failed",
        subscriptionId,
        sessionId: session.id,
      }),
    );
  }
  try {
    await subStore.bindCheckoutSession(session.id, subscriptionId);
  } catch (e) {
    console.warn(
      JSON.stringify({
        event: "stripe_subscription_session_bind_failed",
        subscriptionId,
        sessionId: session.id,
        detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 200),
      }),
    );
  }

  console.log(
    JSON.stringify({
      event: "stripe_subscription_session_created",
      subscriptionId,
      sessionId: session.id,
      localSku: item.localSku,
      monthlyAmountCents: item.amountCents,
      mindbodyClientId: resolved.clientId,
      mindbodyServiceId: item.mindbodyServiceId,
      stripeCustomerId,
      commitmentMonths,
    }),
  );

  return jsonResponse(200, {
    ok: true,
    subscriptionId,
    sessionId: session.id,
    url: session.url,
    expiresAt: session.expires_at,
    localSku: item.localSku,
    displayName: item.displayName,
    monthlyAmountCents: item.amountCents,
    commitmentMonths,
    commitmentEndDate,
    earlyCancellationFeeCents,
  });
}

/* -------------------------------------------------------------------------- */
/* Handler                                                                    */
/* -------------------------------------------------------------------------- */

async function createCheckoutSessionHandler(event) {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": header(event, "origin") || "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, ngrok-skip-browser-warning",
      },
      body: "",
    };
  }
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" });
  }

  /**
   * Both flows (one-time + recurring) need a valid Stripe key, so this gate is shared.
   * Per-flow feature flags are enforced AFTER we resolve the SKU, so a recurring
   * request never trips on `ENABLE_STRIPE_ONE_TIME_CHECKOUT` and vice versa.
   */
  const sk = stripeSecret();
  if (!sk) {
    return jsonResponse(503, {
      ok: false,
      error: "stripe_not_configured",
      message: "STRIPE_SECRET_KEY is missing or malformed on the server.",
    });
  }

  const body = parseJsonBody(event);
  if (body === null) return jsonResponse(400, { ok: false, error: "invalid_json" });
  if (!body || typeof body !== "object") return jsonResponse(400, { ok: false, error: "invalid_body" });

  const localSku = safeStr(/** @type {{ localSku?: unknown }} */ (body).localSku, 64);
  if (!/^[a-z0-9_]{3,64}$/.test(localSku)) {
    return jsonResponse(400, { ok: false, error: "invalid_localSku" });
  }
  /** @type {ReturnType<typeof getCatalogItem>} */
  let item;
  try {
    item = getCatalogItem(localSku);
  } catch (e) {
    console.error(
      JSON.stringify({
        event: "stripe_catalog_load_failed",
        detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 240),
      }),
    );
    return jsonResponse(500, { ok: false, error: "catalog_unavailable" });
  }
  if (!item) return jsonResponse(404, { ok: false, error: "unknown_sku" });
  if (!item.enabled) return jsonResponse(403, { ok: false, error: "sku_disabled" });
  /**
   * `mindbodyItemType !== "Service"` is shared across one-time and recurring — the
   * `CheckoutShoppingCart` endpoint we use for both expects Type:Service. Recurring SKUs
   * inherit the same rule (verified in `scripts/mindbody-membership-service-probe.mjs`).
   */
  if (item.mindbodyItemType !== "Service") {
    return jsonResponse(400, {
      ok: false,
      error: "non_service_item_blocked",
      message: "Only Mindbody Service (Pricing Option) SKUs are eligible for Stripe checkout.",
    });
  }
  /**
   * `enabledForExpressCheckout` is one-time-only by design — recurring memberships go
   * through the consent dialog, not the express checkout CTAs. We re-check this gate
   * AFTER the subscription dispatch below, inside the one-time branch only.
   */

  /**
   * Per-flow feature gate (one-time only). Subscription requests skip this and hit
   * `recurringFeatureEnabled()` later inside `handleMembershipSubscription`. Doing it here
   * means a one-time request with the flag off short-circuits BEFORE we make any Mindbody
   * cookie/staff API calls — same posture as the original early gate.
   */
  if (item.kind !== "monthlyMembership" && item.stripeMode !== "subscription") {
    if (isMemberTopUpItem(item) && !memberTopUpEnabled()) {
      return jsonResponse(503, {
        ok: false,
        error: "topup_disabled",
        message: "Member top-up is not enabled on this server.",
      });
    }
    if (!featureEnabled()) {
      return jsonResponse(503, {
        ok: false,
        error: "stripe_one_time_checkout_disabled",
        message:
          "Stripe one-time checkout is not enabled on this server. Set ENABLE_STRIPE_ONE_TIME_CHECKOUT=1 (after Stripe envs are configured).",
      });
    }
    if (oneTimeHostedCheckoutBlocked() && !adminDebugAuthorized(event) && !isMemberTopUpItem(item)) {
      return jsonResponse(503, {
        ok: false,
        error: "stripe_one_time_checkout_disabled",
        message: "One-time Hosted Checkout is temporarily unavailable. Monthly membership checkout is unchanged.",
      });
    }
  }

  /** Optional inputs (server still owns the truth). */
  const ctaLocation = safeStr(/** @type {{ ctaLocation?: unknown }} */ (body).ctaLocation, 80) || null;
  const pageLocation = safeStr(/** @type {{ pageLocation?: unknown }} */ (body).pageLocation, 200) || null;
  const purchaseSource = derivePurchaseSource(body, ctaLocation);
  const selectedClassParsed = parseSelectedClassFromBody(body);
  const capturedAtIso = new Date().toISOString();
  /** @type {import("./stripe-order-store.mjs").OrderRecord["selectedClassContext"]=} */
  const selectedClassContext =
    purchaseSource === "classes" && selectedClassParsed
      ? buildSelectedClassContext(selectedClassParsed, capturedAtIso)
      : undefined;
  const pendingBookBody =
    /** @type {{ pendingBook?: unknown; pending_book?: unknown }} */ (body).pendingBook ??
    /** @type {{ pending_book?: unknown }} */ (body).pending_book ??
    null;
  /**
   * Compatibility:
   *   Browser knownMindbodyClientId / clientId / client_id are never ownership.
   *   They may arrive as legacy hints and are ignored.
   *   Authenticated clientId comes only from resolveCommerceCustomer
   *   (amare_sess linked association and/or mb_sess cookie).
   *   ENABLE_AMARE_COMMERCE=0 still preserves that ownership — a linked
   *   AMARÉ session is never treated as an anonymous guest.
   *   Unsigned browsers use the genuine anonymous path.
   */
  /** @type {number | null} */
  let knownMindbodyClientId = null;
  if (bodyHasBrowserClientId(/** @type {Record<string, unknown>} */ (body))) {
    console.log(
      JSON.stringify({
        event: "stripe_checkout_ignored_browser_client_id",
        compatibility: "browser_client_id_never_ownership",
      }),
    );
  }

  const customerEmailRaw = safeStr(/** @type {{ email?: unknown }} */ (body).email, 254).toLowerCase();
  let customerEmail = isReasonableEmail(customerEmailRaw) ? customerEmailRaw : "";
  /**
   * `name` is the legacy single-string field; preserved for backward compatibility with any
   * caller that still posts it. The new pre-checkout dialog posts `firstName` + `lastName`
   * separately (cleanest signal — Mindbody Identity auto-link needs exact first+last+email
   * match against the addclient row). When both are present, prefer them and synthesize the
   * full name; otherwise fall back to the legacy single-string `name` and split downstream.
   */
  let customerName = safeStr(/** @type {{ name?: unknown }} */ (body).name, 160);
  let customerFirstNameRaw = safeStr(/** @type {{ firstName?: unknown }} */ (body).firstName, 80);
  let customerLastNameRaw = safeStr(/** @type {{ lastName?: unknown }} */ (body).lastName, 80);
  let customerPhone = safeStr(/** @type {{ phone?: unknown }} */ (body).phone, 32);

  /** Synthesised full name for Stripe Customer prefill + OrderRecord storage. */
  const dialogFullName = [customerFirstNameRaw, customerLastNameRaw]
    .map((s) => s.trim())
    .filter(Boolean)
    .join(" ")
    .slice(0, 160);
  const haveDialogNames = customerFirstNameRaw.length > 0 && customerLastNameRaw.length > 0;

  /** Optional client-supplied idempotency key — bounded format like the existing checkout fn. */
  const rawIdem = safeStr(/** @type {{ idempotencyKey?: unknown }} */ (body).idempotencyKey, 160);
  const createIdempotencyKey = /^[A-Za-z0-9_-]{8,160}$/.test(rawIdem) ? rawIdem : null;

  /* ---------------- Session-cookie email (no Mindbody refresh) ------------ */
  /**
   * The browser-side button calls `readKnownMindbodyClientIdSafely()` in pricing-api.js,
   * which reads `/api/mindbody/oauth/session`. That endpoint only exposes the sealed
   * cookie (email/name/sub) — the numeric `clientId` is not round-tripped on every refresh,
   * so for most logged-in members the frontend posts `knownMindbodyClientId = null`.
   *
   * To still drive Stripe Checkout prefill for those members we unseal `mb_sess` here
   * (cheap, just crypto — NO Mindbody token refresh) and read the email. Later we use
   * the staff headers we already need for NCS/contact lookup to find the matching
   * `clientId` via email search. Failures are silent: anonymous fallback still works.
   *
   * The `STRIPE_CHECKOUT_PREFILL_FROM_MINDBODY` env var lets ops disable this entirely
   * without a redeploy if Mindbody latency or downtime starts hurting checkout. When OFF,
   * we behave exactly like the pre-prefill code path (anonymous-style flow even for
   * logged-in members).
   */
  const prefillEnabled = prefillFromMindbodyEnabled();
  const prefillBudgetMs = prefillTimeoutMs();
  /** @type {string | null} */
  let memberSessionEmail = null;
  if (prefillEnabled && knownMindbodyClientId == null) {
    try {
      const cookieHeader =
        (header(event, "cookie") || header(event, "Cookie") || "").trim();
      if (cookieHeader) {
        const raw = parseCookies(cookieHeader).mb_sess;
        if (raw) {
          const data = unsealCookiePayload(raw, sessionSecret());
          const e = typeof data?.email === "string" ? data.email.trim().toLowerCase() : "";
          if (e && isReasonableEmail(e)) memberSessionEmail = e;
        }
      }
    } catch {
      /** Cookie missing/expired/tampered — anonymous flow. */
    }
  }

  /* ---------------- Lazy Mindbody staff headers --------------------------- */
  /**
   * Both the NCS duplicate check AND the Stripe Customer prefill need staff-scoped Mindbody
   * headers. We resolve them once and cache for the rest of the request. `null` means we
   * decided we couldn't get headers (no creds configured, refresh failed, etc.) — callers
   * should silently skip whichever lookup needed them.
   *
   * @type {Record<string, string> | null | undefined}
   */
  let staffHeadersCache;
  async function getStaffHeaders() {
    if (staffHeadersCache !== undefined) return staffHeadersCache;
    const staffUser = process.env.MINDBODY_STAFF_USERNAME?.trim();
    const staffPass = process.env.MINDBODY_STAFF_PASSWORD;
    if (staffUser && typeof staffPass === "string" && staffPass !== "") {
      const issued = await getMindbodyStaffAccessTokenCached();
      staffHeadersCache = issued.ok ? mindbodyStaffBearerHeaders(issued.accessToken) : null;
    } else {
      staffHeadersCache = mindbodyStaffApiHeaders();
    }
    return staffHeadersCache;
  }

  /* ---------------- Resolve clientId from cookie email (if unknown) ------- */
  /**
   * Done before the NCS duplicate check so an existing studio member who is logged in
   * can't slip past `block_before_checkout_if_known` just because the browser-side cookie
   * doesn't carry their numeric Mindbody clientId.
   *
   * Hard timeout (`prefillBudgetMs`) — if Mindbody is slow we silently fall back rather
   * than make the customer wait. NCS duplicate check then runs only if we got a clientId.
   */
  /** @type {{ ms: number; ok: boolean } | null} */
  let clientIdResolveTiming = null;
  if (prefillEnabled && knownMindbodyClientId == null && memberSessionEmail) {
    const t0 = Date.now();
    try {
      const staffHeaders = await getStaffHeaders();
      if (staffHeaders) {
        const found = await fetchClientIdByEmail(staffHeaders, memberSessionEmail, {
          timeoutMs: prefillBudgetMs,
        });
        if (found != null) knownMindbodyClientId = found;
      }
      clientIdResolveTiming = { ms: Date.now() - t0, ok: knownMindbodyClientId != null };
    } catch (e) {
      clientIdResolveTiming = { ms: Date.now() - t0, ok: false };
      console.error(
        JSON.stringify({
          event: "stripe_prefill_clientid_resolve_failed",
          elapsedMs: Date.now() - t0,
          detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 200),
        }),
      );
    }
  }

  /**
   * Resolve the purchaser from cookies on every request, including when
   * ENABLE_AMARE_COMMERCE=0. Browser clientId is never ownership.
   * Linked / recovery AMARÉ states never fall through to anonymous AddClient.
   */
  /** @type {Awaited<ReturnType<typeof resolveCommerceCustomer>> | null} */
  let commerceCustomer = null;
  {
    const t0 = Date.now();
    try {
      commerceCustomer = await resolveCommerceCustomer(event);
      const blocked = commerceCheckoutRejectResponse(commerceCustomer);
      if (blocked) return blocked;
      if (commerceCustomer.clientId != null && Number(commerceCustomer.clientId) > 0) {
        knownMindbodyClientId = Number(commerceCustomer.clientId);
        clientIdResolveTiming = { ms: Date.now() - t0, ok: true };
      }
      if (isPurchaseLinkedState(commerceCustomer.state)) {
        customerEmail = "";
        customerName = "";
        customerFirstNameRaw = "";
        customerLastNameRaw = "";
        customerPhone = "";
      }
      if (commerceCustomer.amareUserId) {
        const { listIdentities } = await import("./amare-identity-store.mjs");
        const amareEmail = displayEmailFromIdentities(await listIdentities(commerceCustomer.amareUserId));
        if (amareEmail && isReasonableEmail(amareEmail)) customerEmail = amareEmail;
      } else if (!customerEmail && commerceCustomer.mbEmail && isReasonableEmail(commerceCustomer.mbEmail)) {
        customerEmail = commerceCustomer.mbEmail;
      }
    } catch (e) {
      console.error(
        JSON.stringify({
          event: "stripe_commerce_resolve_failed",
          elapsedMs: Date.now() - t0,
          detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 200),
        }),
      );
      return jsonResponse(502, {
        ok: false,
        error: "commerce_resolve_failed",
        message: "Could not resolve your studio account for this purchase. Please try again.",
      });
    }
  }

  /**
   * Linked commerce: load Studio contact before membership dispatch so Stripe
   * subscription checkout is prefilled from the server, not the browser form.
   */
  if (
    commerceCustomer &&
    isPurchaseLinkedState(commerceCustomer.state) &&
    knownMindbodyClientId != null &&
    prefillEnabled
  ) {
    try {
      const staffHeaders = await getStaffHeaders();
      if (staffHeaders) {
        const contact = await fetchMindbodyClientContact(staffHeaders, knownMindbodyClientId, {
          timeoutMs: prefillBudgetMs,
        });
        if (contact) {
          if (contact.email && isReasonableEmail(contact.email)) customerEmail = contact.email;
          if (contact.firstName) customerFirstNameRaw = contact.firstName;
          if (contact.lastName) customerLastNameRaw = contact.lastName;
          if (contact.fullName) customerName = contact.fullName;
          if (contact.phone) customerPhone = contact.phone;
        }
      }
    } catch (e) {
      console.error(
        JSON.stringify({
          event: "stripe_commerce_contact_lookup_failed",
          clientId: knownMindbodyClientId,
          detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 200),
        }),
      );
    }
  }

  if (isMemberTopUpItem(item)) {
    if (!commerceCustomer || !isPurchaseLinkedState(commerceCustomer.state) || knownMindbodyClientId == null) {
      return jsonResponse(401, {
        ok: false,
        error: "signed_out",
        message: "Sign in with your linked AMARÉ account to buy a member top-up.",
      });
    }
  }

  /* ---------------- Recurring membership dispatch ------------------------- */
  /**
   * Branch on `kind === "monthlyMembership"` BEFORE the one-time-only gates below
   * (featureEnabled / enabledForExpressCheckout / NCS dedup). All shared context the
   * subscription helper needs is already populated at this point — `knownMindbodyClientId`,
   * `getStaffHeaders`, `customerEmail`, names, phone, idempotencyKey, etc.
   *
   * The helper handles its own gates (`recurringFeatureEnabled()`, consent validation,
   * subscription-store availability, and `block_if_active_subscription` enforcement)
   * and returns a fully-formed handler response.
   */
  if (item.kind === "monthlyMembership" || item.stripeMode === "subscription") {
    const stripeForSub = new Stripe(sk, {
      apiVersion: "2025-08-27.basil",
      appInfo: { name: "amare-stripe-mindbody-recurring", version: "0.1.0" },
    });
    return await handleMembershipSubscription({
      stripe: stripeForSub,
      item,
      body: /** @type {Record<string, unknown>} */ (body),
      event,
      knownMindbodyClientId,
      trustKnownClientId:
        commerceCustomer &&
        isPurchaseLinkedState(commerceCustomer.state) &&
        knownMindbodyClientId != null,
      amareUserId: commerceCustomer?.amareUserId || null,
      commerceAuthSource: commerceCustomer?.authSource || null,
      getStaffHeaders,
      memberSessionEmail,
      customerEmail,
      customerName,
      customerFirstName: customerFirstNameRaw,
      customerLastName: customerLastNameRaw,
      customerPhone,
      ctaLocation,
      pageLocation,
      createIdempotencyKey,
      originUrl: hostedCheckoutReturnOrigin(event),
      eventClientIp:
        (header(event, "x-nf-client-connection-ip") ||
          header(event, "x-forwarded-for") ||
          header(event, "client-ip") ||
          "")
          .split(",")[0]
          .trim()
          .slice(0, 64),
      eventUserAgent: (header(event, "user-agent") || "").slice(0, 240),
    });
  }

  /* ---------------- One-time-only gates ----------------------------------- */
  /**
   * From this point on the handler serves only the one-time SKUs (NCS / drop-in / packs).
   * `featureEnabled()` was already enforced earlier (right after `getCatalogItem`), so we
   * only need the Express-CTA eligibility check here.
   */
  if (!item.enabledForExpressCheckout && !isMemberTopUpItem(item)) {
    return jsonResponse(403, {
      ok: false,
      error: "sku_not_enabled_for_express_checkout",
      message:
        "This SKU is in the catalog but Express Checkout is not enabled for it yet. Use Mindbody classic checkout.",
    });
  }

  /* ---------------- NCS block_before_checkout_if_known eligibility -------- */
  /**
   * Authoritative duplicate guard for one-time-per-client items (NCS). For a KNOWN client we
   * ask Mindbody itself — via a `Test:true` CheckoutShoppingCart dry-run — whether this exact
   * purchase would be accepted. Mindbody applies its real intro-series purchase-count limit,
   * so a returning client who already used the NCS is caught BEFORE Stripe charges, and we
   * return 409 `ncs_already_used`. Nothing is persisted and no one is charged by the dry-run.
   *
   * This replaces the old keyword/date `fetchClientNcsHistory` heuristic, which queried
   * Mindbody without a date range and therefore only ever saw "today" — missing every
   * historical NCS purchase (the exact reason a returning client slipped through to Stripe).
   *
   * Anonymous buyers are intentionally sent straight to checkout (kept fast — the vast
   * majority are genuine new clients, which is the NCS target audience, and there is no
   * resolvable Mindbody client to dry-run against). The webhook remains the backstop for the
   * rare returning client who checks out anonymously.
   *
   * Fail-open: any non-definitive dry-run outcome (`unknown` — timeout/auth/config/network)
   * proceeds to checkout. We never block a paying customer because the pre-check could not get
   * a definitive answer from Mindbody.
   */
  if (item.duplicatePolicy === "block_before_checkout_if_known" && item.oneTimePerClient) {
    if (knownMindbodyClientId != null) {
      logNcsPrecheck("stripe_checkout_ncs_precheck_start", {
        sku: item.localSku,
        path: "known_client_id",
        clientId: knownMindbodyClientId,
      });
      const dry = await ncsDuplicateDryRun({
        clientId: knownMindbodyClientId,
        amountCents: item.amountCents,
        item,
      });
      logNcsPrecheck("stripe_checkout_ncs_precheck_result", {
        sku: item.localSku,
        path: "known_client_id",
        clientId: knownMindbodyClientId,
        decision: dry.decision,
        elapsedMs: dry.elapsedMs,
        detail: dry.detail ? String(dry.detail).slice(0, 160) : undefined,
      });
      if (dry.decision === "blocked") {
        logNcsPrecheck("stripe_checkout_ncs_precheck_blocked", {
          sku: item.localSku,
          path: "known_client_id",
          clientId: knownMindbodyClientId,
        });
        return jsonResponse(409, {
          ok: false,
          error: "ncs_already_used",
          message:
            "This studio account already has a New Client Special on file. Please choose a different package.",
        });
      }
    } else {
      logNcsPrecheck("stripe_checkout_ncs_precheck_skipped", {
        sku: item.localSku,
        reason: "anonymous_no_check",
      });
    }
  }

  /* ---------------- Build the Stripe Checkout Session --------------------- */
  const orderId = newOrderId();
  /** @type {{ cycleStartDay?: string; cycleStart?: string | null; cycleEnd?: string | null } | null} */
  let topUpCycle = null;
  if (isMemberTopUpItem(item)) {
    const reserved = await prepareTopUpForPurchase({
      event,
      clientId: Number(knownMindbodyClientId),
      orderId,
    });
    if (!reserved.ok) {
      const code = reserved.reason || "ineligible";
      return jsonResponse(code === "store_unavailable" || code === "topup_disabled" ? 503 : 409, {
        ok: false,
        error: code,
        message:
          code === "other_usable_credits"
            ? "Use your remaining class credits first."
            : code === "monthly_credits_remain"
              ? "You still have monthly class credits remaining."
              : code === "topup_reserved" || code === "topup_purchased"
                ? "You already have a member top-up for this billing cycle."
                : "This member top-up is not available right now.",
      });
    }
    topUpCycle = {
      cycleStartDay: reserved.ctx.cycle.cycleStartDay,
      cycleStart: reserved.ctx.cycle.cycleStart,
      cycleEnd: reserved.ctx.cycle.cycleEnd,
    };
  }
  const stripe = new Stripe(sk, {
    apiVersion: "2025-08-27.basil",
    appInfo: { name: "amare-stripe-mindbody-onetime", version: "0.1.0" },
  });

  /* ---------------- Mindbody → Stripe Customer prefill -------------------- */
  /**
   * For logged-in members we look up Mindbody contact details (email + first/last name +
   * MobilePhone) and bind them to a Stripe Customer. Stripe Checkout will then prefill the
   * Contact information section so returning members don't retype anything.
   *
   * Anonymous buyers fall through to `customer_email` (or to a fully empty form when even
   * that isn't available) — same UX as before this change.
   *
   * Failures here NEVER block checkout. If anything goes wrong we just skip prefill.
   */
  /** @type {string | null} */
  let stripeCustomerId = null;
  /** @type {{ email: string; firstName: string; lastName: string; phone: string; fullName: string } | null} */
  let mindbodyContact = null;
  let prefillSource = "none";
  /** @type {{ ms: number; ok: boolean } | null} */
  let contactLookupTiming = null;
  /** @type {{ ms: number; ok: boolean } | null} */
  let stripeCustomerTiming = null;
  if (prefillEnabled && knownMindbodyClientId != null) {
    const t0 = Date.now();
    try {
      const staffHeaders = await getStaffHeaders();
      if (staffHeaders) {
        mindbodyContact = await fetchMindbodyClientContact(
          staffHeaders,
          knownMindbodyClientId,
          { timeoutMs: prefillBudgetMs },
        );
      }
      contactLookupTiming = { ms: Date.now() - t0, ok: mindbodyContact != null };
    } catch (e) {
      contactLookupTiming = { ms: Date.now() - t0, ok: false };
      console.error(
        JSON.stringify({
          event: "stripe_prefill_mindbody_lookup_failed",
          clientId: knownMindbodyClientId,
          elapsedMs: Date.now() - t0,
          detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 200),
        }),
      );
    }
    const contactEmail =
      (mindbodyContact && mindbodyContact.email && isReasonableEmail(mindbodyContact.email)
        ? mindbodyContact.email
        : customerEmail) || "";
    if (mindbodyContact && contactEmail) {
      const t0 = Date.now();
      try {
        stripeCustomerId = await findOrCreateStripeCustomerForMindbodyMember(
          stripe,
          {
            email: contactEmail,
            fullName: mindbodyContact.fullName,
            phone: mindbodyContact.phone,
            mindbodyClientId: knownMindbodyClientId,
            amareUserId: commerceCustomer?.amareUserId || null,
          },
          orderId,
        );
        if (stripeCustomerId) prefillSource = "mindbody_member";
        stripeCustomerTiming = { ms: Date.now() - t0, ok: stripeCustomerId != null };
      } catch (e) {
        stripeCustomerTiming = { ms: Date.now() - t0, ok: false };
        console.error(
          JSON.stringify({
            event: "stripe_prefill_customer_bind_failed",
            clientId: knownMindbodyClientId,
            elapsedMs: Date.now() - t0,
            detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 200),
          }),
        );
      }
    }
  }

  /**
   * Anonymous-buyer prefill: when the new pre-checkout dialog supplied email + first/last
   * + phone, bind a Stripe Customer up-front so Checkout shows everything pre-filled. This
   * is the Express equivalent of the member prefill above — same UX guarantee, just sourced
   * from our own dialog instead of Mindbody. Member prefill takes precedence; this branch
   * only runs when we don't have a member contact.
   */
  if (
    !stripeCustomerId &&
    customerEmail &&
    haveDialogNames &&
    !(commerceCustomer && isPurchaseLinkedState(commerceCustomer.state))
  ) {
    const t0 = Date.now();
    try {
      stripeCustomerId = await findOrCreateStripeCustomerForAnonymousBuyer(
        stripe,
        {
          email: customerEmail,
          fullName: dialogFullName,
          phone: customerPhone,
        },
        orderId,
      );
      if (stripeCustomerId) prefillSource = "dialog_anonymous";
      stripeCustomerTiming = { ms: Date.now() - t0, ok: stripeCustomerId != null };
    } catch (e) {
      stripeCustomerTiming = { ms: Date.now() - t0, ok: false };
      console.error(
        JSON.stringify({
          event: "stripe_prefill_anonymous_customer_bind_failed",
          elapsedMs: Date.now() - t0,
          detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 200),
        }),
      );
    }
  }

  const origin = hostedCheckoutReturnOrigin(event);
  const successUrl =
    (process.env.STRIPE_SUCCESS_URL || "").trim() ||
    `${origin}/checkout/success?session_id={CHECKOUT_SESSION_ID}&orderId=${encodeURIComponent(orderId)}`;
  const cancelUrl =
    (process.env.STRIPE_CANCEL_URL || "").trim() ||
    `${origin}/checkout/cancel?orderId=${encodeURIComponent(orderId)}`;

  /** @type {Record<string, string>} */
  const metadata = {
    localSku: item.localSku,
    mindbodyItemType: item.mindbodyItemType,
    mindbodyServiceId:
      item.mindbodyServiceId != null ? String(item.mindbodyServiceId) : "resolve_at_sync",
    mindbodyLocationId: (process.env.MINDBODY_SALE_LOCATION_ID || "").trim() || "default",
    knownMindbodyClientId: knownMindbodyClientId != null ? String(knownMindbodyClientId) : "",
    mindbodyClientId: knownMindbodyClientId != null ? String(knownMindbodyClientId) : "",
    siteId: amareSiteId(),
    source: "amare_site",
    flow: "stripe_to_mindbody_one_time",
    orderId,
    amarePaymentFlow: "hosted_checkout",
    ctaLocation: ctaLocation || "",
    pageLocation: pageLocation || "",
    duplicatePolicy: item.duplicatePolicy,
    oneTimePerClient: item.oneTimePerClient ? "1" : "0",
  };
  if (topUpCycle?.cycleStartDay) {
    metadata.topUpCycleStartDay = topUpCycle.cycleStartDay;
    if (topUpCycle.cycleStart) metadata.topUpCycleStart = topUpCycle.cycleStart;
    if (topUpCycle.cycleEnd) metadata.topUpCycleEnd = topUpCycle.cycleEnd;
  }
  if (commerceCustomer?.amareUserId) metadata.amareUserId = commerceCustomer.amareUserId;
  if (commerceCustomer?.authSource) metadata.commerceAuthSource = commerceCustomer.authSource;
  if (commerceCustomer?.state) metadata.commerceState = commerceCustomer.state;

  /**
   * Line item price: dynamic `unit_amount` from the local catalog for every SKU.
   * `drop_in_single_class` alone references a stable Stripe Product
   * (`STRIPE_DROPIN_SINGLE_PRODUCT_ID`) so Coupons can use `applies_to.products`.
   * All other SKUs keep inline `product_data` (never both `product` and `product_data`).
   * Fulfillment identity stays on Session / PaymentIntent metadata (`localSku`, …) —
   * not on Product metadata.
   */
  /** @type {string | null} */
  let stripeProductIdForLog = null;
  /** @type {Stripe.Checkout.SessionCreateParams.LineItem.PriceData} */
  const priceData = {
    currency: item.currency,
    unit_amount: item.amountCents,
  };
  if (item.localSku === DROP_IN_SINGLE_CLASS_SKU) {
    const productId = dropInSingleProductId();
    if (!productId) {
      console.error(
        JSON.stringify({
          event: "stripe_checkout_dropin_product_id_missing",
          orderId,
          localSku: item.localSku,
          hint: "Set STRIPE_DROPIN_SINGLE_PRODUCT_ID to a Stripe Product id (prod_…) in this environment.",
        }),
      );
      return jsonResponse(500, {
        ok: false,
        error: "stripe_dropin_product_id_missing",
        message:
          "STRIPE_DROPIN_SINGLE_PRODUCT_ID is missing or invalid. Required for drop_in_single_class checkout (prod_…).",
      });
    }
    priceData.product = productId;
    stripeProductIdForLog = productId;
  } else {
    priceData.product_data = {
      name: item.displayName,
      description: item.description || undefined,
      metadata: {
        localSku: item.localSku,
        mindbodyItemType: item.mindbodyItemType,
      },
    };
  }

  /** @type {Stripe.Checkout.SessionCreateParams.LineItem[]} */
  const lineItems = [{ quantity: 1, price_data: priceData }];

  /** @type {Stripe.Checkout.SessionCreateParams} */
  const params = {
    mode: "payment",
    line_items: lineItems,
    automatic_tax: { enabled: false },
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: orderId,
    metadata,
    payment_intent_data: { metadata },
    /**
     * Customer detail collection on Stripe-hosted Checkout — used to drive the post-payment
     * Mindbody resolve/create flow:
     *   • email — Stripe always collects (or pre-fills from `customer_email` when known).
     *     Required for the email-match path in `resolveOrCreateMindbodyClient`.
     *   • name  — Stripe always collects on the card form (cardholder name) and exposes it
     *     on `session.customer_details.name`. Required to create a new Mindbody client when
     *     the email has no existing match.
     *   • phone — explicitly opted-in via `phone_number_collection`. Helps disambiguate
     *     duplicate Mindbody clients on the same email and is stored on the new client when
     *     we have to create one.
     *   • billing address — left as Stripe default (`auto`). Hosted Checkout will collect it
     *     only when the chosen payment method actually requires it (cards usually do
     *     postal/zip, Apple Pay/Google Pay surface address from the wallet). We deliberately
     *     do not force `billing_address_collection: "required"` to avoid extra friction.
     *
     * Apple Pay / Google Pay / Link / Card surface automatically on the hosted page; no
     * extra opt-in needed (Express Element is for embedded UIs).
     */
    phone_number_collection: { enabled: true },
  };

  /**
   * Surface Stripe's built-in "Add promotion code" field on the hosted Checkout page when
   * `ENABLE_STRIPE_PROMOTION_CODES=1`. Behaviour with the flag OFF is byte-identical to the
   * pre-coupon flow — Stripe simply doesn't render the field and `session.amount_total`
   * always equals the catalog list price. With the flag ON, Stripe handles validation,
   * application, and arithmetic; the discount story is propagated to Mindbody by the
   * webhook (`stripe-webhook.mjs` → `extractStripeAmountSnapshot` → `Items[].DiscountAmount`).
   *
   * Coupons without `applies_to` remain global across one-time SKUs. Product-scoped coupons
   * for Drop-In Single Class require `STRIPE_DROPIN_SINGLE_PRODUCT_ID` + Coupon
   * `applies_to.products` pointing at that Product (dynamic `unit_amount`, no fixed Price id).
   */
  if (promotionCodesEnabled()) {
    params.allow_promotion_codes = true;
  }

  if (stripeCustomerId) {
    /**
     * Logged-in Mindbody member with a known/created Stripe Customer. Passing `customer`
     * pre-fills email + name + phone (and any saved address) on the Checkout page; the
     * email field becomes read-only, but name & phone remain editable in case the buyer
     * wants to use a different shipping/billing identity for this transaction.
     *
     * `customer_update.{name, address}: "auto"` lets Stripe persist any new details the
     * customer types back onto the Customer record. We don't allow `shipping` updates —
     * we don't ship physical goods on this flow.
     */
    params.customer = stripeCustomerId;
    params.customer_update = { name: "auto", address: "auto" };
  } else if (customerEmail) {
    params.customer_email = customerEmail;
  }

  /**
   * First/last name capture decision.
   *
   * Stripe Hosted Checkout exposes `session.customer_details.name` as a single string from
   * card/Apple Pay/Google Pay/Link/wallet. That single name is unsplittable when there are
   * no spaces, which forces a fragile FirstName/LastName fallback in `addclient`
   * (`LastName = FirstName || "Client"`). The downstream consequence: the API-created
   * Studio Client and the Mindbody Identity Studio Client end up with mismatched names,
   * and Identity refuses to auto-link them.
   *
   * We have two sources of clean, separate first/last:
   *   1. **Mindbody contact** (logged-in members) — already on file, asking again is friction.
   *   2. **Pre-checkout dialog** (anonymous buyers) — collected by the new unified Express
   *      dialog before posting to this endpoint. This is THE fix for the
   *      `paid_but_not_synced` symptom we saw on `mrsmccombs1@yahoo.com` etc.
   *
   * Only fall back to Stripe `custom_fields` when neither source supplied them — typically
   * legacy callers (older cached frontend, direct API consumers) that haven't been updated
   * to the dialog yet. Without the fallback, those callers would degrade silently to a
   * single-string name.
   *
   * Note: `custom_fields` cannot be pre-filled from a Stripe Customer or from the request
   * body — Stripe always shows them empty for the buyer to type. That's the whole reason we
   * prefer the dialog: the buyer types once, on our page, and the OrderRecord persists the
   * clean first/last for both the webhook AND admin-retry paths.
   */
  const haveCleanMindbodyName = Boolean(
    mindbodyContact &&
      typeof mindbodyContact.firstName === "string" &&
      mindbodyContact.firstName.trim() &&
      typeof mindbodyContact.lastName === "string" &&
      mindbodyContact.lastName.trim(),
  );
  if (!haveCleanMindbodyName && !haveDialogNames) {
    params.custom_fields = [
      {
        key: "first_name",
        label: { type: "custom", custom: "First name" },
        type: "text",
        text: { minimum_length: 1, maximum_length: 80 },
        optional: false,
      },
      {
        key: "last_name",
        label: { type: "custom", custom: "Last name" },
        type: "text",
        text: { minimum_length: 1, maximum_length: 80 },
        optional: false,
      },
    ];
  }

  let session;
  try {
    session = await stripe.checkout.sessions.create(params, {
      idempotencyKey: createIdempotencyKey ?? `create-session_${orderId}`,
    });
  } catch (e) {
    const detail = String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 240);
    const code = String(/** @type {{ code?: string }} */ (e)?.code ?? "");
    console.error(
      JSON.stringify({
        event: "stripe_create_checkout_session_failed",
        orderId,
        localSku,
        code: code || undefined,
        detail,
      }),
    );
    if (topUpCycle) {
      await releaseTopUpForAbandonedOrder(event, {
        localSku: item.localSku,
        orderId,
        knownMindbodyClientId,
        topUpCycleStartDay: topUpCycle.cycleStartDay,
      });
    }
    return jsonResponse(502, {
      ok: false,
      error: "stripe_create_session_failed",
      message: detail || "Stripe rejected the session creation request.",
    });
  }

  /* ---------------- Persist order BEFORE returning to the browser --------- */
  const store = openOrderStore(event);
  if (!store.available) {
    /**
     * Without persistence the webhook can't safely fulfill. Refuse rather than redirect.
     * `paid_but_not_synced` would be impossible to detect later. Surface clearly.
     */
    console.error(
      JSON.stringify({
        event: "stripe_order_store_unavailable_at_create_session",
        orderId,
        sessionId: session.id,
      }),
    );
    return jsonResponse(503, {
      ok: false,
      error: "order_store_unavailable",
      message:
        "Order persistence (Netlify Blobs) is not available on this Function. Configure Blobs and redeploy.",
    });
  }

  /** @type {import("./stripe-order-store.mjs").OrderRecord["pendingBook"]=} */
  let pendingBookRecord = undefined;
  /** @type {import("./stripe-order-store.mjs").OrderRecord["deferredBook"]=} */
  let deferredBookRecord = undefined;
  /** @type {string | undefined} */
  let deferredBookConsumerAuthSealed = undefined;
  /** @type {Record<string, string | string[]>} */
  let checkoutExtraHeaders = {};

  if (isDeferredBookEligibleCta(ctaLocation) && isDeferredBookEligibleSku(item.localSku)) {
    /** @type {{ ok: true; pendingBook: import("./mindbody-pending-book-intent-lib.mjs").PendingBookRecord } | { ok: false; reason: string }} */
    let validation;
    if (ctaLocation === DEFERRED_BOOK_ANONYMOUS_CTA) {
      const anonIntent = readAnonymousBookIntentFromEvent(event);
      validation = validateAnonymousPendingBookForCheckout(anonIntent, pendingBookBody);
      if (validation.ok && validation.pendingBook) {
        checkoutExtraHeaders = { "Set-Cookie": anonymousBookIntentClearCookieHeader(event.headers) };
      }
    } else {
      const intent = readBookFailIntentFromEvent(event);
      validation = validatePendingBookForCheckout(intent, pendingBookBody, knownMindbodyClientId);
      if (validation.ok && validation.pendingBook) {
        checkoutExtraHeaders = { "Set-Cookie": bookFailIntentClearCookieHeader(event.headers) };
      }
    }
    if (validation.ok && validation.pendingBook) {
      pendingBookRecord = validation.pendingBook;
      deferredBookRecord = { status: "pending", attemptCount: 0 };
      if (knownMindbodyClientId != null) {
        try {
          const cookieHeader = (header(event, "cookie") || header(event, "Cookie") || "").trim();
          if (cookieHeader) {
            const raw = parseCookies(cookieHeader).mb_sess;
            if (raw) {
              const sess = unsealCookiePayload(raw, sessionSecret());
              const refresh =
                typeof sess?.refresh_token === "string" ? sess.refresh_token.trim() : "";
              if (refresh) {
                deferredBookConsumerAuthSealed = sealDeferredBookConsumerAuth({
                  orderId,
                  clientId: knownMindbodyClientId,
                  refreshToken: refresh,
                });
              }
            }
          }
        } catch {
          /* checkout still proceeds; email falls back to success-page consumer retry */
        }
      }
      console.log(
        JSON.stringify({
          event: "stripe_checkout_deferred_book_attached",
          orderId,
          classId: pendingBookRecord.classId,
          clientId: knownMindbodyClientId,
          localSku: item.localSku,
          hasConsumerAuthForEmail: Boolean(deferredBookConsumerAuthSealed),
        }),
      );
    } else {
      console.warn(
        JSON.stringify({
          event: "stripe_checkout_deferred_book_rejected",
          orderId,
          reason: validation.reason,
          ctaLocation,
          localSku: item.localSku,
          knownClient: knownMindbodyClientId != null,
        }),
      );
    }
  }

  /** @type {import("./stripe-order-store.mjs").OrderRecord} */
  const record = {
    orderId,
    localSku: item.localSku,
    amountCents: item.amountCents,
    currency: item.currency,
    stripeCheckoutSessionId: session.id,
    stripePaymentIntentId:
      typeof session.payment_intent === "string" ? session.payment_intent : undefined,
    /**
     * Prefer Mindbody-sourced contact for logged-in members so that admin/debug + the
     * post-payment Mindbody resolve flow have authoritative data even before the webhook
     * fires. Anonymous buyers fall back to whatever the form posted (usually empty).
     */
    customerEmail:
      (mindbodyContact && mindbodyContact.email) || customerEmail || undefined,
    customerName:
      (mindbodyContact && mindbodyContact.fullName) ||
      dialogFullName ||
      customerName ||
      undefined,
    /**
     * Persist the explicit first/last from the pre-checkout dialog (or Mindbody contact for
     * logged-in members) so the webhook can prefer them over the single-string
     * `customer_details.name` Stripe will return. This is what enables the Mindbody Identity
     * auto-link to work cleanly on the buyer's first OAuth sign-in: `addclient` must receive
     * the same FirstName + LastName the buyer typed, not a `splitFullName`-mangled version.
     */
    customerFirstName:
      (mindbodyContact && mindbodyContact.firstName) || customerFirstNameRaw || undefined,
    customerLastName:
      (mindbodyContact && mindbodyContact.lastName) || customerLastNameRaw || undefined,
    customerPhone:
      (mindbodyContact && mindbodyContact.phone) || customerPhone || undefined,
    stripeCustomerId: stripeCustomerId || undefined,
    knownMindbodyClientId: knownMindbodyClientId,
    amareUserId: commerceCustomer?.amareUserId || undefined,
    commerceAuthSource: commerceCustomer?.authSource || undefined,
    commerceState: commerceCustomer?.state || undefined,
    mindbodySyncStatus: "checkout_created",
    mindbodyServiceId: item.mindbodyServiceId,
    ctaLocation: ctaLocation,
    pageLocation: pageLocation,
    purchaseSource: purchaseSource === "classes" ? "classes" : purchaseSource === "pricing" ? "pricing" : undefined,
    selectedClassContext,
    classesAutoBook: selectedClassContext
      ? {
          status: /** @type {const} */ ("pending"),
          attemptedAt: null,
          completedAt: null,
          result: null,
          reason: null,
        }
      : undefined,
    bookingFailureAdminEmail: selectedClassContext
      ? {
          status: /** @type {const} */ ("not_sent"),
          attemptedAt: null,
          sentAt: null,
          reason: null,
          lastError: null,
          checkoutSessionId: session.id,
          firstInvoiceId: null,
        }
      : undefined,
    flow: "stripe_to_mindbody_one_time",
    paymentFlow: "hosted_checkout",
    topUpCycleStartDay: topUpCycle?.cycleStartDay || undefined,
    topUpCycleStart: topUpCycle?.cycleStart || undefined,
    topUpCycleEnd: topUpCycle?.cycleEnd || undefined,
    source: "amare_site",
    idempotencyKey: createIdempotencyKey || randomUUID(),
    createSessionIdempotencyKey: createIdempotencyKey || `create-session_${orderId}`,
    expressCheckoutEligible: true,
    mindbodyPaymentMode:
      ((process.env.MINDBODY_STRIPE_PAYMENT_MODE || "custom").trim().toLowerCase()) || "custom",
    pendingBook: pendingBookRecord,
    deferredBook: deferredBookRecord,
    deferredBookConsumerAuthSealed,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const putRes = await store.put(record, { onlyIfNew: true });
  if (!putRes.ok) {
    console.error(
      JSON.stringify({
        event: "stripe_order_put_failed",
        orderId,
        sessionId: session.id,
        reason: putRes.reason,
      }),
    );
    if (topUpCycle) {
      await releaseTopUpForAbandonedOrder(event, {
        localSku: item.localSku,
        orderId,
        knownMindbodyClientId,
        topUpCycleStartDay: topUpCycle.cycleStartDay,
      });
    }
    return jsonResponse(500, {
      ok: false,
      error: "order_persist_failed",
      detail: putRes.reason,
    });
  }
  try {
    await store.bindSession(session.id, orderId);
  } catch (e) {
    console.error(
      JSON.stringify({
        event: "stripe_order_session_bind_failed",
        orderId,
        sessionId: session.id,
        detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 200),
      }),
    );
  }

  /**
   * Roll-up of where time went. `prefillTotalMs` is the only number that actually delays the
   * customer's redirect to Stripe — watch it in production and flip
   * `STRIPE_CHECKOUT_PREFILL_FROM_MINDBODY=0` if the p95 climbs.
   */
  const prefillTotalMs =
    (clientIdResolveTiming?.ms || 0) +
    (contactLookupTiming?.ms || 0) +
    (stripeCustomerTiming?.ms || 0);
  console.log(
    JSON.stringify({
      event: "stripe_checkout_session_created",
      orderId,
      sessionId: session.id,
      localSku,
      amountCents: item.amountCents,
      stripeProductId: stripeProductIdForLog,
      ctaLocation: ctaLocation || null,
      knownClient: knownMindbodyClientId != null,
      knownClientResolvedFrom: memberSessionEmail
        ? "server_cookie_email"
        : knownMindbodyClientId != null
        ? "frontend_payload"
        : "none",
      mode: record.mindbodyPaymentMode,
      prefillSource,
      prefillEnabled,
      prefillBudgetMs,
      prefillTotalMs,
      clientIdResolveMs: clientIdResolveTiming?.ms,
      contactLookupMs: contactLookupTiming?.ms,
      stripeCustomerMs: stripeCustomerTiming?.ms,
      stripeCustomerBound: stripeCustomerId != null,
    }),
  );

  return jsonResponse(
    200,
    {
      ok: true,
      orderId,
      sessionId: session.id,
      url: session.url,
      expiresAt: session.expires_at,
      localSku,
      displayName: item.displayName,
      amountCents: item.amountCents,
    },
    checkoutExtraHeaders,
  );
}

export const lambdaHandler = withMobileCorsHandler(createCheckoutSessionHandler);
export default withLambda(lambdaHandler);
