/**
 * Mobile one-time PaymentSheet backend (Phase B).
 *
 * POST /api/amare/commerce/mobile/prepare  { sku, purchaseAttemptId }
 * GET  /api/amare/commerce/mobile/status?orderId=
 * GET  /api/amare/commerce/mobile/pending
 *
 * Does not fulfill. Does not mint Hosted Checkout sessions. Monthly SKUs stay out.
 */

import Stripe from "stripe";

import { amareAuthEnabled, isForeignOriginMutation, resolveAmareUser } from "./amare-sess-lib.mjs";
import { jsonResponse } from "./amare-auth-lib.mjs";
import { amareCommerceEnabled, isPurchaseLinkedState, resolveCommerceCustomer } from "./amare-commerce-lib.mjs";
import { withMobileCorsHandler } from "./mobile-api-cors.mjs";
import { getCatalogItem } from "./stripe-catalog-lib.mjs";
import { ncsDuplicateDryRun } from "./stripe-mindbody-sync-lib.mjs";
import { newOrderId, openOrderStore } from "./stripe-order-store.mjs";
import {
  isMobilePrepareSku,
  isOneTimeCatalogProduct,
  mobilePaymentStatusAlias,
  PAYMENT_FLOW_MOBILE,
  PRODUCT_FLOW_ONE_TIME,
} from "./stripe-payment-flow.mjs";
import { memberTopUpEnabled } from "./member-topup-blobs.mjs";
import {
  isMemberTopUpSku,
  prepareTopUpForPurchase,
  releaseTopUpForAbandonedOrder,
} from "./member-topup-lib.mjs";

function header(event, name) {
  if (!event || typeof event !== "object") return "";
  const headers = /** @type {{ headers?: Record<string, string | undefined> }} */ (event).headers || {};
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) return String(headers[k] || "").trim();
  }
  return "";
}

function requireBearer(event) {
  const raw = header(event, "authorization");
  return /^Bearer\s+\S+/i.test(raw);
}

function parseJsonBody(event) {
  const raw = event && event.body;
  if (raw == null || raw === "") return {};
  try {
    const text = event.isBase64Encoded ? Buffer.from(String(raw), "base64").toString("utf8") : String(raw);
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return null;
  }
}

function stripeSecret() {
  const k = (process.env.STRIPE_SECRET_KEY || "").trim();
  if (!k.startsWith("sk_")) return null;
  return k;
}

function oneTimeCheckoutEnabled() {
  return (process.env.ENABLE_STRIPE_ONE_TIME_CHECKOUT || "").trim() === "1";
}

function isValidPurchaseAttemptId(raw) {
  return typeof raw === "string" && /^[A-Za-z0-9_-]{8,80}$/.test(raw.trim());
}

function isResolvedMobilePurchaseStatus(status) {
  return status === "mindbody_synced" || status === "canceled" || status === "refunded";
}

/** PaymentSheet can only confirm these. Never return a canceled (or other terminal) PI secret. */
export function isConfirmablePaymentIntentStatus(status) {
  const s = String(status || "");
  return s === "requires_payment_method" || s === "requires_confirmation" || s === "requires_action";
}

export function isCanceledPaymentIntentStatus(status) {
  return String(status || "") === "canceled";
}

/** Released unpaid Top-Up order. Same purchaseAttemptId must not reopen it. */
export function isRetiredUnpaidTopUpOrder(order) {
  if (!order || !isMemberTopUpSku(order.localSku)) return false;
  return String(order.mindbodySyncStatus || "") === "canceled";
}

/**
 * Discovery pointer only. Never stores client secrets or card data.
 * @param {{ upsertMobilePending?: Function }} store
 * @param {string} amareUserId
 * @param {{ orderId?: string; localSku?: string; createdAt?: string; purchaseAttemptId?: string }} order
 * @param {string} purchaseAttemptId
 */
async function rememberMobilePending(store, amareUserId, order, purchaseAttemptId) {
  if (!store?.upsertMobilePending || !order?.orderId) return;
  try {
    await store.upsertMobilePending(amareUserId, {
      orderId: order.orderId,
      sku: order.localSku,
      purchaseAttemptId: purchaseAttemptId || order.purchaseAttemptId,
      createdAt: order.createdAt,
    });
  } catch {
    /* discovery index is not fulfillment */
  }
}

/** Public PaymentSheet fields only. Not price or ownership authority. */
export function paymentSheetPublicConfig() {
  const pk = (process.env.STRIPE_PUBLISHABLE_KEY || "").trim();
  return {
    merchantDisplayName: "AMARÉ",
    publishableKey: pk.startsWith("pk_") ? pk : "",
    googlePay: {
      environment: "TEST",
      country: "US",
      currency: "USD",
    },
  };
}

function prepareClientPayload(order, clientSecret, customerId) {
  return {
    ok: true,
    orderId: order.orderId,
    paymentIntentClientSecret: clientSecret,
    customerId,
    amount: order.amountCents,
    currency: order.currency,
    ...paymentSheetPublicConfig(),
  };
}

/**
 * Reuse the Hosted Checkout customer key: Studio clientId on Stripe metadata,
 * then email, then create. Linked buyers only.
 *
 * @param {Stripe} stripe
 * @param {{
 *   mindbodyClientId: number;
 *   amareUserId: string;
 *   email?: string | null;
 *   fullName?: string | null;
 *   orderId: string;
 * }} input
 */
async function resolveStripeCustomerForLinkedBuyer(stripe, input) {
  const clientId = String(input.mindbodyClientId);
  const email = (input.email || "").trim().toLowerCase();
  const fullName = (input.fullName || "").trim().slice(0, 160);
  const amareUserId = input.amareUserId;
  const idemBase = input.orderId;

  try {
    const found = await stripe.customers.search({
      query: `metadata['mindbodyClientId']:'${clientId}'`,
      limit: 20,
    });
    const hits = (found.data || []).filter((c) => c && !c.deleted && c.id);
    const tagged = hits.find((c) => c.metadata && c.metadata.mindbodyClientId === clientId);
    const picked = tagged || hits[0];
    if (picked?.id) {
      const md = { ...(picked.metadata || {}), mindbodyClientId: clientId, amareUserId, source: "amare_site" };
      try {
        await stripe.customers.update(
          picked.id,
          { metadata: md, ...(fullName && !picked.name ? { name: fullName } : {}) },
          { idempotencyKey: `cust-update_${idemBase}_${picked.id}` },
        );
      } catch {
        /* reuse even if backfill fails */
      }
      return picked.id;
    }
  } catch (e) {
    console.warn(
      JSON.stringify({
        event: "stripe_mobile_customer_search_failed",
        detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 200),
      }),
    );
  }

  if (email) {
    try {
      const list = await stripe.customers.list({ email, limit: 100 });
      const byEmail = (list.data || []).find((c) => {
        if (!c || !c.id || c.deleted) return false;
        const tagged = c.metadata && String(c.metadata.mindbodyClientId || "");
        if (tagged && tagged !== clientId) return false;
        return true;
      });
      if (byEmail?.id) {
        try {
          await stripe.customers.update(
            byEmail.id,
            {
              metadata: {
                ...(byEmail.metadata || {}),
                mindbodyClientId: clientId,
                amareUserId,
                source: "amare_site",
              },
              ...(fullName && !byEmail.name ? { name: fullName } : {}),
            },
            { idempotencyKey: `cust-update_${idemBase}_${byEmail.id}` },
          );
        } catch {
          /* reuse */
        }
        return byEmail.id;
      }
    } catch (e) {
      console.warn(
        JSON.stringify({
          event: "stripe_mobile_customer_list_failed",
          detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 200),
        }),
      );
    }
  }

  const created = await stripe.customers.create(
    {
      email: email || undefined,
      name: fullName || undefined,
      metadata: {
        mindbodyClientId: clientId,
        amareUserId,
        source: "amare_site",
        flow: PRODUCT_FLOW_ONE_TIME,
      },
    },
    { idempotencyKey: `cust-create_${idemBase}_${clientId}` },
  );
  return created?.id || null;
}

/**
 * @param {import("@netlify/functions").HandlerEvent} event
 * @param {Record<string, unknown>} [deps]
 */
export async function handleMobilePaymentPrepare(event, deps = {}) {
  if (!amareAuthEnabled() && !deps.resolveAmareUser) {
    return jsonResponse(404, { ok: false, error: "amare_auth_disabled" });
  }
  if (!amareCommerceEnabled() && deps.commerceEnabled !== true) {
    return jsonResponse(404, { ok: false, error: "commerce_disabled" });
  }
  if ((event.httpMethod || "GET") !== "POST") {
    return { statusCode: 405, headers: { "Cache-Control": "no-store" }, body: "method_not_allowed" };
  }
  if (isForeignOriginMutation(event)) {
    return jsonResponse(403, { ok: false, error: "foreign_origin" });
  }
  if (!requireBearer(event)) {
    return jsonResponse(401, { ok: false, error: "signed_out" });
  }

  const oneTimeOn = typeof deps.oneTimeEnabled === "boolean" ? deps.oneTimeEnabled : oneTimeCheckoutEnabled();
  if (!oneTimeOn) {
    return jsonResponse(503, { ok: false, error: "one_time_checkout_disabled" });
  }

  const user = deps.resolveAmareUser
    ? await deps.resolveAmareUser(event, deps)
    : await resolveAmareUser(event, { findUser: deps.findUser });
  if (!user?.signedIn || !user.amareUserId) {
    return jsonResponse(401, { ok: false, error: "signed_out" });
  }

  const commerce = deps.resolveCommerceCustomer
    ? await deps.resolveCommerceCustomer(event)
    : await resolveCommerceCustomer(event, deps);
  if (
    !isPurchaseLinkedState(commerce.state) ||
    !commerce.amareUserId ||
    commerce.amareUserId !== user.amareUserId ||
    !(Number(commerce.clientId) > 0)
  ) {
    return jsonResponse(409, { ok: false, error: "not_linked", state: commerce.state || null });
  }

  const body = parseJsonBody(event);
  if (!body) return jsonResponse(400, { ok: false, error: "invalid_json" });

  const sku = String(body.sku || body.localSku || "").trim();
  const purchaseAttemptId = String(body.purchaseAttemptId || "").trim();
  if (!isMobilePrepareSku(sku)) {
    return jsonResponse(400, { ok: false, error: "sku_not_allowed" });
  }
  if (!isValidPurchaseAttemptId(purchaseAttemptId)) {
    return jsonResponse(400, { ok: false, error: "invalid_purchaseAttemptId" });
  }

  const item = getCatalogItem(sku);
  if (!item || !item.enabled) {
    return jsonResponse(403, { ok: false, error: "sku_disabled" });
  }
  if (!isOneTimeCatalogProduct(item) || item.stripeMode === "subscription") {
    return jsonResponse(400, { ok: false, error: "sku_not_one_time" });
  }
  if (isMemberTopUpSku(item.localSku) && !memberTopUpEnabled()) {
    return jsonResponse(503, { ok: false, error: "topup_disabled" });
  }

  const studioClientId = Number(commerce.clientId);
  if (item.duplicatePolicy === "block_before_checkout_if_known" && item.oneTimePerClient) {
    const dry = deps.ncsDuplicateDryRun
      ? await deps.ncsDuplicateDryRun({ clientId: studioClientId, amountCents: item.amountCents, item })
      : await ncsDuplicateDryRun({ clientId: studioClientId, amountCents: item.amountCents, item });
    if (dry && dry.decision === "blocked") {
      return jsonResponse(409, { ok: false, error: "ncs_already_used" });
    }
  }

  const store = deps.orderStore || openOrderStore(event);
  if (!store.available) {
    return jsonResponse(503, { ok: false, error: "store_unavailable" });
  }

  const candidateId = newOrderId();
  const bound = await store.bindPurchaseAttempt(user.amareUserId, sku, purchaseAttemptId, candidateId);
  const orderId = bound.orderId || candidateId;
  if (!orderId) {
    return jsonResponse(500, { ok: false, error: "purchase_attempt_bind_failed" });
  }

  let order = await store.get(orderId);
  if (!order) {
    const now = new Date().toISOString();
    const record = {
      orderId,
      localSku: item.localSku,
      amountCents: item.amountCents,
      currency: item.currency,
      paymentFlow: PAYMENT_FLOW_MOBILE,
      purchaseAttemptId,
      prepareStatus: "creating_payment_intent",
      amareUserId: user.amareUserId,
      knownMindbodyClientId: studioClientId,
      commerceAuthSource: commerce.authSource,
      commerceState: commerce.state,
      customerEmail: commerce.mbEmail || undefined,
      mindbodySyncStatus: "checkout_created",
      mindbodyServiceId: item.mindbodyServiceId,
      flow: PRODUCT_FLOW_ONE_TIME,
      source: "amare_mobile_payment_sheet",
      createdAt: now,
      updatedAt: now,
    };
    await store.put(record, { onlyIfNew: true });
    order = await store.get(orderId);
  }

  if (!order) {
    return jsonResponse(500, { ok: false, error: "order_persist_failed" });
  }
  if (order.amareUserId !== user.amareUserId || order.localSku !== item.localSku) {
    return jsonResponse(409, { ok: false, error: "purchase_attempt_conflict" });
  }
  if (order.paymentFlow !== PAYMENT_FLOW_MOBILE) {
    return jsonResponse(409, { ok: false, error: "purchase_attempt_conflict" });
  }
  if (isRetiredUnpaidTopUpOrder(order)) {
    return jsonResponse(409, { ok: false, error: "purchase_attempt_retired" });
  }

  if (isMemberTopUpSku(item.localSku) && !order.topUpCycleStartDay) {
    const reserveTopUp =
      typeof deps.prepareTopUpForPurchase === "function" ? deps.prepareTopUpForPurchase : prepareTopUpForPurchase;
    const reserved = await reserveTopUp({
      event,
      clientId: studioClientId,
      orderId,
    });
    if (!reserved.ok) {
      return jsonResponse(409, { ok: false, error: reserved.reason || "ineligible" });
    }
    order = await store.patch(orderId, {
      topUpCycleStartDay: reserved.ctx.cycle.cycleStartDay,
      topUpCycleStart: reserved.ctx.cycle.cycleStart,
      topUpCycleEnd: reserved.ctx.cycle.cycleEnd,
    });
  }

  const stripe =
    deps.stripe ||
    (stripeSecret()
      ? new Stripe(stripeSecret(), {
          apiVersion: "2025-08-27.basil",
          appInfo: { name: "amare-mobile-payment-sheet", version: "0.1.0" },
        })
      : null);
  if (!stripe) {
    return jsonResponse(503, { ok: false, error: "stripe_not_configured" });
  }

  if (order.prepareStatus !== "ready" || !order.stripePaymentIntentId) {
    let stripeCustomerId = order.stripeCustomerId;
    if (!stripeCustomerId) {
      stripeCustomerId = deps.resolveStripeCustomer
        ? await deps.resolveStripeCustomer({
            mindbodyClientId: studioClientId,
            amareUserId: user.amareUserId,
            email: commerce.mbEmail || order.customerEmail,
            orderId,
          })
        : await resolveStripeCustomerForLinkedBuyer(stripe, {
            mindbodyClientId: studioClientId,
            amareUserId: user.amareUserId,
            email: commerce.mbEmail || order.customerEmail,
            orderId,
          });
      if (!stripeCustomerId) {
        return jsonResponse(502, { ok: false, error: "stripe_customer_unavailable" });
      }
      await store.patch(orderId, { stripeCustomerId });
    }

    const metadata = {
      localSku: item.localSku,
      mindbodyItemType: item.mindbodyItemType,
      mindbodyServiceId:
        item.mindbodyServiceId != null ? String(item.mindbodyServiceId) : "resolve_at_sync",
      knownMindbodyClientId: String(studioClientId),
      mindbodyClientId: String(studioClientId),
      source: "amare_mobile_payment_sheet",
      flow: PRODUCT_FLOW_ONE_TIME,
      orderId,
      amareUserId: user.amareUserId,
      amarePaymentFlow: PAYMENT_FLOW_MOBILE,
      purchaseAttemptId,
    };
    if (order.topUpCycleStartDay) metadata.topUpCycleStartDay = String(order.topUpCycleStartDay);

    let pi;
    try {
      pi = await stripe.paymentIntents.create(
      {
        amount: item.amountCents,
        currency: item.currency,
        customer: stripeCustomerId,
        metadata,
        payment_method_types: ["card"],
      },
      { idempotencyKey: `amare-mobile-payment:${orderId}` },
      );
    } catch (e) {
      if (isMemberTopUpSku(item.localSku)) {
        await releaseTopUpForAbandonedOrder(event, order);
      }
      throw e;
    }

    order = await store.patch(orderId, {
      stripePaymentIntentId: pi.id,
      stripeCustomerId,
      amountCents: item.amountCents,
      currency: item.currency,
      prepareStatus: "ready",
    });
    if (!order?.stripePaymentIntentId) {
      return jsonResponse(500, { ok: false, error: "payment_intent_persist_failed" });
    }

    await rememberMobilePending(store, user.amareUserId, order, purchaseAttemptId);
    return jsonResponse(200, prepareClientPayload(order, pi.client_secret, stripeCustomerId));
  }

  await rememberMobilePending(store, user.amareUserId, order, purchaseAttemptId);
  const existing = await stripe.paymentIntents.retrieve(order.stripePaymentIntentId);
  if (isMemberTopUpSku(item.localSku) && isCanceledPaymentIntentStatus(existing?.status)) {
    return jsonResponse(409, { ok: false, error: "purchase_attempt_retired" });
  }
  return jsonResponse(
    200,
    prepareClientPayload(order, existing.client_secret, order.stripeCustomerId),
  );
}

/**
 * @param {import("@netlify/functions").HandlerEvent} event
 * @param {Record<string, unknown>} [deps]
 */
export async function handleMobileOrderStatus(event, deps = {}) {
  if (!amareAuthEnabled() && !deps.resolveAmareUser) {
    return jsonResponse(404, { ok: false, error: "amare_auth_disabled" });
  }
  if (!amareCommerceEnabled() && deps.commerceEnabled !== true) {
    return jsonResponse(404, { ok: false, error: "commerce_disabled" });
  }
  if ((event.httpMethod || "GET") !== "GET" && event.httpMethod !== "HEAD") {
    return { statusCode: 405, headers: { "Cache-Control": "no-store" }, body: "method_not_allowed" };
  }
  if (!requireBearer(event)) {
    return jsonResponse(401, { ok: false, error: "signed_out" });
  }

  const user = deps.resolveAmareUser
    ? await deps.resolveAmareUser(event, deps)
    : await resolveAmareUser(event, { findUser: deps.findUser });
  if (!user?.signedIn || !user.amareUserId) {
    return jsonResponse(401, { ok: false, error: "signed_out" });
  }

  const orderId = String(event.queryStringParameters?.orderId || "").trim();
  if (!orderId) return jsonResponse(400, { ok: false, error: "missing_orderId" });

  const store = deps.orderStore || openOrderStore(event);
  if (!store.available) {
    return jsonResponse(503, { ok: false, error: "store_unavailable" });
  }

  let order = null;
  try {
    order = await store.get(orderId);
  } catch {
    order = null;
  }
  if (!order || order.paymentFlow !== PAYMENT_FLOW_MOBILE) {
    return jsonResponse(404, { ok: false, error: "order_not_found" });
  }
  if (order.amareUserId !== user.amareUserId) {
    return jsonResponse(403, { ok: false, error: "forbidden" });
  }

  const paymentStatus = mobilePaymentStatusAlias(order);
  return jsonResponse(200, {
    ok: true,
    orderId: order.orderId,
    localSku: order.localSku,
    paymentFlow: order.paymentFlow,
    purchaseAttemptId: order.purchaseAttemptId || null,
    mindbodySyncStatus: order.mindbodySyncStatus,
    paymentStatus,
    fulfilled: order.mindbodySyncStatus === "mindbody_synced",
  });
}

/**
 * Server-authoritative discovery of the signed-in user's unresolved mobile orders.
 * GET never fulfills. Pointers are not payment secrets.
 *
 * @param {import("@netlify/functions").HandlerEvent} event
 * @param {Record<string, unknown>} [deps]
 */
export async function handleMobilePendingOrders(event, deps = {}) {
  if (!amareAuthEnabled() && !deps.resolveAmareUser) {
    return jsonResponse(404, { ok: false, error: "amare_auth_disabled" });
  }
  if (!amareCommerceEnabled() && deps.commerceEnabled !== true) {
    return jsonResponse(404, { ok: false, error: "commerce_disabled" });
  }
  if ((event.httpMethod || "GET") !== "GET" && event.httpMethod !== "HEAD") {
    return { statusCode: 405, headers: { "Cache-Control": "no-store" }, body: "method_not_allowed" };
  }
  if (!requireBearer(event)) {
    return jsonResponse(401, { ok: false, error: "signed_out" });
  }

  const user = deps.resolveAmareUser
    ? await deps.resolveAmareUser(event, deps)
    : await resolveAmareUser(event, { findUser: deps.findUser });
  if (!user?.signedIn || !user.amareUserId) {
    return jsonResponse(401, { ok: false, error: "signed_out" });
  }

  const store = deps.orderStore || openOrderStore(event);
  if (!store.available) {
    return jsonResponse(503, { ok: false, error: "store_unavailable" });
  }

  /** @type {unknown[]} */
  let pointers = [];
  try {
    pointers = (await store.listMobilePending?.(user.amareUserId)) || [];
  } catch {
    pointers = [];
  }

  const orders = [];
  for (const row of pointers) {
    if (!row || typeof row !== "object") continue;
    const orderId = String(/** @type {{ orderId?: unknown }} */ (row).orderId || "").trim();
    if (!orderId) continue;
    let order = null;
    try {
      order = await store.get(orderId);
    } catch {
      order = null;
    }
    if (!order || order.paymentFlow !== PAYMENT_FLOW_MOBILE) continue;
    if (order.amareUserId !== user.amareUserId) continue;
    if (isResolvedMobilePurchaseStatus(order.mindbodySyncStatus)) continue;
    orders.push({
      orderId: order.orderId,
      localSku: order.localSku,
      purchaseAttemptId: order.purchaseAttemptId || /** @type {{ purchaseAttemptId?: unknown }} */ (row).purchaseAttemptId || null,
      createdAt: order.createdAt || /** @type {{ createdAt?: unknown }} */ (row).createdAt || null,
      mindbodySyncStatus: order.mindbodySyncStatus,
      paymentStatus: mobilePaymentStatusAlias(order),
      fulfilled: order.mindbodySyncStatus === "mindbody_synced",
    });
  }

  return jsonResponse(200, { ok: true, orders });
}

function requestPath(event) {
  const raw = String(event.path || event.rawUrl || "");
  try {
    if (raw.startsWith("http")) return new URL(raw).pathname;
  } catch {
    /* keep raw */
  }
  return raw.split("?")[0];
}

async function mobilePaymentsHandler(event) {
  if ((event.httpMethod || "GET") === "POST") {
    return handleMobilePaymentPrepare(event);
  }
  if (requestPath(event).endsWith("/pending")) {
    return handleMobilePendingOrders(event);
  }
  return handleMobileOrderStatus(event);
}

export const handler = withMobileCorsHandler(mobilePaymentsHandler);
