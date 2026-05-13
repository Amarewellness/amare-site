/**
 * POST /api/stripe/checkout/create-session
 *
 * Creates a Stripe Checkout Session in `payment` mode for a one-time AMARÉ Mindbody package
 * (NCS / drop-in / 5–10–20 class packs). Recurring memberships do NOT use this endpoint —
 * they continue to flow through Mindbody classic / `mindbody-sale-purchase-contract.mjs`.
 *
 * Decisions: docs/STRIPE-MINDBODY-QUESTIONS.md.
 * Inspection: one-time packages are `Type: "Service"` in Mindbody (see
 * `mindbody-sale-checkout.mjs`), confirmed before code.
 *
 * Server-side validation (never trust client):
 *  • Reject if `ENABLE_STRIPE_ONE_TIME_CHECKOUT !== "1"`.
 *  • Look up `localSku` in the catalog config; reject if disabled or unknown.
 *  • Reject anything that isn't `mindbodyItemType === "Service"`.
 *  • Use server-side amount; ignore any `amount` from the request body.
 *  • Block NCS for already-known logged-in clients per Q3 (`block_before_checkout_if_known`).
 *
 * Order is created in the order store BEFORE redirecting to Stripe so the webhook can find it.
 */

import { randomUUID } from "node:crypto";
import Stripe from "stripe";

import {
  getMindbodyStaffAccessTokenCached,
  jsonResponse,
} from "./mindbody-consumer-lib.mjs";
import { parseCookies, sessionSecret, unsealCookiePayload } from "./oauth-lib.mjs";
import {
  mindbodyStaffApiHeaders,
  mindbodyStaffBearerHeaders,
} from "./mindbody-upstream.mjs";
import { getCatalogItem } from "./stripe-catalog-lib.mjs";
import { newOrderId, openOrderStore } from "./stripe-order-store.mjs";
import {
  fetchClientIdByEmail,
  fetchClientNcsHistory,
  fetchMindbodyClientContact,
} from "./stripe-mindbody-sync-lib.mjs";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function featureEnabled() {
  return (process.env.ENABLE_STRIPE_ONE_TIME_CHECKOUT || "").trim() === "1";
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

/** @param {unknown} v @param {number} max */
function safeStr(v, max) {
  if (typeof v !== "string") return "";
  return v.trim().slice(0, max);
}

/** @param {string} email */
function isReasonableEmail(email) {
  if (!email || email.length > 254) return false;
  return /^[^\s@]{1,200}@[^\s@]{1,64}\.[A-Za-z0-9.-]{2,24}$/.test(email);
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
 * @param {{ email: string; fullName: string; phone: string; mindbodyClientId: number }} input
 * @param {string} idemBase Idempotency key root tied to the order being created
 * @returns {Promise<string | null>}
 */
async function findOrCreateStripeCustomerForMindbodyMember(stripe, input, idemBase) {
  const email = (input.email || "").trim().toLowerCase();
  if (!email) return null;
  const fullName = (input.fullName || "").trim().slice(0, 160);
  const phone = (input.phone || "").trim().slice(0, 32);
  const clientId = String(input.mindbodyClientId);

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

  /**
   * Backfill any missing contact field on the existing Customer (idempotent and conservative —
   * we only fill blanks, never overwrite values the customer or another flow already saved).
   *
   * Why this matters: Customers created earlier (or from `customer_email`-only flows) may
   * have an empty `phone`/`name`. Without backfill, Stripe Checkout would prefill email but
   * leave Phone blank — which is exactly the "email yes, phone no" symptom we're fixing.
   *
   * @param {Stripe.Customer} c
   * @returns {Promise<void>}
   */
  async function backfillCustomerContact(c) {
    /** @type {Stripe.CustomerUpdateParams} */
    const patch = {};
    let needs = false;
    const md = c.metadata || {};
    if (md.mindbodyClientId !== clientId) {
      patch.metadata = { ...md, mindbodyClientId: clientId, source: md.source || "amare_site" };
      needs = true;
    }
    if (!c.name && fullName) {
      patch.name = fullName;
      needs = true;
    }
    if (!c.phone && phone) {
      patch.phone = phone;
      needs = true;
    }
    if (!needs) return;
    try {
      await stripe.customers.update(c.id, patch, {
        idempotencyKey: `cust-update_${idemBase}_${c.id}`,
      });
    } catch (e) {
      console.error(
        JSON.stringify({
          event: "stripe_customer_update_failed",
          customerId: c.id,
          detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 200),
        }),
      );
      /* still safe to use this Customer ID even if metadata patch failed */
    }
  }

  const byMindbodyId = existing.find(
    (c) => c && c.metadata && c.metadata.mindbodyClientId === clientId,
  );
  if (byMindbodyId && byMindbodyId.id) {
    await backfillCustomerContact(byMindbodyId);
    return byMindbodyId.id;
  }

  const byEmail = existing.find((c) => c && c.id);
  if (byEmail && byEmail.id) {
    await backfillCustomerContact(byEmail);
    return byEmail.id;
  }

  try {
    const created = await stripe.customers.create(
      {
        email,
        name: fullName || undefined,
        phone: phone || undefined,
        metadata: {
          mindbodyClientId: clientId,
          source: "amare_site",
          flow: "stripe_to_mindbody_one_time",
        },
      },
      { idempotencyKey: `cust-create_${idemBase}_${clientId}` },
    );
    return created?.id || null;
  } catch (e) {
    console.error(
      JSON.stringify({
        event: "stripe_customer_create_failed",
        clientId,
        detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 200),
      }),
    );
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Handler                                                                    */
/* -------------------------------------------------------------------------- */

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": header(event, "origin") || "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
      body: "",
    };
  }
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" });
  }

  if (!featureEnabled()) {
    return jsonResponse(503, {
      ok: false,
      error: "stripe_one_time_checkout_disabled",
      message:
        "Stripe one-time checkout is not enabled on this server. Set ENABLE_STRIPE_ONE_TIME_CHECKOUT=1 (after Stripe envs are configured).",
    });
  }

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
  if (!item.enabledForExpressCheckout) {
    return jsonResponse(403, {
      ok: false,
      error: "sku_not_enabled_for_express_checkout",
      message:
        "This SKU is in the catalog but Express Checkout is not enabled for it yet. Use Mindbody classic checkout.",
    });
  }
  if (item.mindbodyItemType !== "Service") {
    return jsonResponse(400, {
      ok: false,
      error: "non_service_item_blocked",
      message: "Only Mindbody Service (Pricing Option) SKUs are eligible for Stripe one-time checkout.",
    });
  }

  /** Optional inputs (server still owns the truth). */
  const ctaLocation = safeStr(/** @type {{ ctaLocation?: unknown }} */ (body).ctaLocation, 80) || null;
  const pageLocation = safeStr(/** @type {{ pageLocation?: unknown }} */ (body).pageLocation, 200) || null;
  const knownClientIdRaw = /** @type {{ knownMindbodyClientId?: unknown }} */ (body).knownMindbodyClientId;
  /** @type {number | null} */
  let knownMindbodyClientId = null;
  if (typeof knownClientIdRaw === "number" && Number.isFinite(knownClientIdRaw) && knownClientIdRaw > 0) {
    knownMindbodyClientId = Math.trunc(knownClientIdRaw);
  } else if (typeof knownClientIdRaw === "string" && /^\d{1,18}$/.test(knownClientIdRaw.trim())) {
    knownMindbodyClientId = parseInt(knownClientIdRaw.trim(), 10);
  }

  const customerEmailRaw = safeStr(/** @type {{ email?: unknown }} */ (body).email, 254).toLowerCase();
  const customerEmail = isReasonableEmail(customerEmailRaw) ? customerEmailRaw : "";
  const customerName = safeStr(/** @type {{ name?: unknown }} */ (body).name, 160);
  const customerPhone = safeStr(/** @type {{ phone?: unknown }} */ (body).phone, 32);

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

  /* ---------------- NCS block_before_checkout_if_known eligibility -------- */
  if (
    item.duplicatePolicy === "block_before_checkout_if_known" &&
    item.oneTimePerClient &&
    knownMindbodyClientId != null
  ) {
    const staffHeaders = await getStaffHeaders();
    if (staffHeaders) {
      const history = await fetchClientNcsHistory(staffHeaders, knownMindbodyClientId);
      if (history.ok && history.hadNcs) {
        return jsonResponse(409, {
          ok: false,
          error: "ncs_already_used",
          message:
            "This studio account already has a New Client Special on file. Please choose a different package.",
          evidence: history.evidence,
        });
      }
    }
  }

  /* ---------------- Build the Stripe Checkout Session --------------------- */
  const orderId = newOrderId();
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
    if (mindbodyContact && mindbodyContact.email) {
      const t0 = Date.now();
      try {
        stripeCustomerId = await findOrCreateStripeCustomerForMindbodyMember(
          stripe,
          {
            email: mindbodyContact.email,
            fullName: mindbodyContact.fullName,
            phone: mindbodyContact.phone,
            mindbodyClientId: knownMindbodyClientId,
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

  const origin = originFromEvent(event);
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
    source: "amare_site",
    flow: "stripe_to_mindbody_one_time",
    orderId,
    ctaLocation: ctaLocation || "",
    pageLocation: pageLocation || "",
    duplicatePolicy: item.duplicatePolicy,
    oneTimePerClient: item.oneTimePerClient ? "1" : "0",
  };

  /** @type {Stripe.Checkout.SessionCreateParams.LineItem[]} */
  const lineItems = [
    {
      quantity: 1,
      price_data: {
        currency: item.currency,
        unit_amount: item.amountCents,
        product_data: {
          name: item.displayName,
          description: item.description || undefined,
          metadata: {
            localSku: item.localSku,
            mindbodyItemType: item.mindbodyItemType,
          },
        },
      },
    },
  ];

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
   * Anonymous-buyer first/last name capture.
   *
   * Stripe Hosted Checkout exposes `session.customer_details.name` as a single string.
   * Sources vary widely:
   *   • Card  → "Cardholder name" textbox (whatever buyer typed; often just first name).
   *   • Link  → name saved on the Link account (may be partial).
   *   • Apple Pay / Google Pay → name from the wallet provider.
   *   • Klarna / Affirm → name supplied during the BNPL flow.
   *
   * That single `name` is unsplittable when there are no spaces, which forces us into a
   * fragile FirstName/LastName fallback in `addclient` (`LastName = FirstName || "Client"`).
   * The downstream consequence: the API-created Studio Client and the Mindbody Identity
   * Studio Client end up with mismatched names, and Identity refuses to auto-link them.
   *
   * Solution: ask anonymous buyers for First/Last name explicitly via Stripe `custom_fields`
   * (max 3 fields per session; we use 2). This guarantees we always have clean, separate
   * `FirstName` + `LastName` to pass to Mindbody `addclient`, which in turn maximises the
   * chance Mindbody Identity will recognise + auto-link the API-created client on first
   * sign-in (and the OAuth-callback auto-merge cleans up anything that slips through).
   *
   * We deliberately skip `custom_fields` when we already have a clean first/last from
   * Mindbody (`mindbodyContact.firstName && mindbodyContact.lastName`) — those buyers are
   * logged-in members and asking again would be needless friction. If a member's Mindbody
   * profile has only a first name on file, we fall back to showing the fields too.
   *
   * Note: `custom_fields` cannot be pre-filled from a Stripe Customer; that's why we gate
   * by Mindbody contact instead of `stripeCustomerId`. Members always have both names.
   */
  const haveCleanMindbodyName = Boolean(
    mindbodyContact &&
      typeof mindbodyContact.firstName === "string" &&
      mindbodyContact.firstName.trim() &&
      typeof mindbodyContact.lastName === "string" &&
      mindbodyContact.lastName.trim(),
  );
  if (!haveCleanMindbodyName) {
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
      (mindbodyContact && mindbodyContact.fullName) || customerName || undefined,
    customerPhone:
      (mindbodyContact && mindbodyContact.phone) || customerPhone || undefined,
    stripeCustomerId: stripeCustomerId || undefined,
    knownMindbodyClientId: knownMindbodyClientId,
    mindbodySyncStatus: "checkout_created",
    mindbodyServiceId: item.mindbodyServiceId,
    ctaLocation: ctaLocation,
    pageLocation: pageLocation,
    flow: "stripe_to_mindbody_one_time",
    source: "amare_site",
    idempotencyKey: createIdempotencyKey || randomUUID(),
    createSessionIdempotencyKey: createIdempotencyKey || `create-session_${orderId}`,
    expressCheckoutEligible: true,
    mindbodyPaymentMode:
      ((process.env.MINDBODY_STRIPE_PAYMENT_MODE || "custom").trim().toLowerCase()) || "custom",
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

  return jsonResponse(200, {
    ok: true,
    orderId,
    sessionId: session.id,
    url: session.url,
    expiresAt: session.expires_at,
    localSku,
    displayName: item.displayName,
    amountCents: item.amountCents,
  });
}
