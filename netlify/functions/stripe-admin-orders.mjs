/**
 * Protected admin / debug endpoint for Stripe → Mindbody one-time orders.
 * Gated by header `x-admin-token: <ADMIN_DEBUG_TOKEN>` (and `ADMIN_DEBUG_TOKEN` is required).
 *
 * GET    /api/stripe/admin/orders?status=paid_but_not_synced&limit=50
 *   → list recent orders by status (default `paid_but_not_synced`).
 *
 * GET    /api/stripe/admin/orders?orderId=ord_…
 *   → return one full order record (sensitive fields elided).
 *
 * POST   /api/stripe/admin/orders/retry  body: { "orderId": "ord_…" }
 *   → retry the Mindbody sync for an order that is paid_but_not_synced or
 *     sync_failed_retryable. Idempotent — refuses to retry if order already mindbody_synced.
 *
 * POST   /api/stripe/admin/orders/resolve  body: { "orderId": "ord_…", "note": "…" }
 *   → mark an order as `manual_review` resolved (status becomes mindbody_synced if a
 *     `mindbodySaleId` is supplied, else `mindbody_synced` cannot be claimed — only `manual_review`).
 */

import {
  getMindbodyStaffAccessTokenCached,
  jsonResponse,
} from "./mindbody-consumer-lib.mjs";
import {
  mindbodyStaffApiHeaders,
  mindbodyStaffBearerHeaders,
} from "./mindbody-upstream.mjs";
import { getCatalogItem } from "./stripe-catalog-lib.mjs";
import { openOrderStore } from "./stripe-order-store.mjs";
import {
  resolveOrCreateMindbodyClient,
  syncOneTimePurchaseToMindbody,
} from "./stripe-mindbody-sync-lib.mjs";

/* -------------------------------------------------------------------------- */
/* Auth + helpers                                                             */
/* -------------------------------------------------------------------------- */

/** @param {unknown} event */
function adminAuthorized(event) {
  const expected = (process.env.ADMIN_DEBUG_TOKEN || "").trim();
  if (!expected || expected.length < 16) return false;
  if (!event || typeof event !== "object") return false;
  const headers = /** @type {{ headers?: Record<string, string | undefined> }} */ (event).headers || {};
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === "x-admin-token") {
      const got = String(headers[k] || "").trim();
      /** Constant-time-ish compare. */
      if (got.length !== expected.length) return false;
      let mismatch = 0;
      for (let i = 0; i < got.length; i += 1) {
        mismatch |= got.charCodeAt(i) ^ expected.charCodeAt(i);
      }
      return mismatch === 0;
    }
  }
  return false;
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

/** @param {import("./stripe-order-store.mjs").OrderRecord} order */
function adminSafeOrder(order) {
  return {
    orderId: order.orderId,
    localSku: order.localSku,
    amountCents: order.amountCents,
    currency: order.currency,
    stripeCheckoutSessionId: order.stripeCheckoutSessionId || null,
    stripePaymentIntentId: order.stripePaymentIntentId || null,
    stripeCustomerId: order.stripeCustomerId || null,
    stripePaymentStatus: order.stripePaymentStatus || null,
    /**
     * Stripe-side amount snapshot — the actual paid total + discount story for this
     * order. `stripeAmountTotalCents` is the source of truth for "money in" reconciliation
     * (matches Stripe Dashboard / bank deposit), `amountCents` above remains the catalog
     * list price for cohort/SKU reporting.
     */
    stripeAmountTotalCents: order.stripeAmountTotalCents ?? null,
    stripeAmountSubtotalCents: order.stripeAmountSubtotalCents ?? null,
    stripeAmountDiscountCents: order.stripeAmountDiscountCents ?? null,
    stripePromotionCode: order.stripePromotionCode || null,
    stripeCouponId: order.stripeCouponId || null,
    customerEmail: order.customerEmail || null,
    customerName: order.customerName || null,
    customerPhone: order.customerPhone || null,
    knownMindbodyClientId: order.knownMindbodyClientId ?? null,
    resolvedMindbodyClientId: order.resolvedMindbodyClientId ?? null,
    mindbodySyncStatus: order.mindbodySyncStatus,
    mindbodySaleId: order.mindbodySaleId || null,
    mindbodyTransactionId: order.mindbodyTransactionId || null,
    mindbodyServiceId: order.mindbodyServiceId ?? null,
    mindbodyPaymentMode: order.mindbodyPaymentMode || null,
    syncAttempts: order.syncAttempts || 0,
    lastSyncAttemptAt: order.lastSyncAttemptAt || null,
    errorCode: order.errorCode || null,
    errorMessageSafe: order.errorMessageSafe || null,
    ncsEligibilityReason: order.ncsEligibilityReason || null,
    ctaLocation: order.ctaLocation || null,
    pageLocation: order.pageLocation || null,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
}

/* -------------------------------------------------------------------------- */
/* Handler                                                                    */
/* -------------------------------------------------------------------------- */

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: { "Cache-Control": "no-store" }, body: "" };
  }
  if (!adminAuthorized(event)) {
    return jsonResponse(401, { ok: false, error: "unauthorized" });
  }

  const store = openOrderStore(event);
  if (!store.available) {
    return jsonResponse(503, { ok: false, error: "order_store_unavailable" });
  }

  const path = (event.path || event.rawUrl || "").toLowerCase();

  /* ---------------- POST retry --------------------------------------------- */
  if (event.httpMethod === "POST" && /retry$/.test(path)) {
    const body = parseJsonBody(event);
    if (!body || typeof body !== "object") return jsonResponse(400, { ok: false, error: "invalid_body" });
    const orderId = typeof /** @type {{ orderId?: unknown }} */ (body).orderId === "string"
      ? /** @type {string} */ (/** @type {{ orderId: string }} */ (body).orderId).trim()
      : "";
    if (!/^ord_[A-Z0-9]{8,40}$/.test(orderId)) {
      return jsonResponse(400, { ok: false, error: "invalid_orderId" });
    }
    const order = await store.get(orderId);
    if (!order) return jsonResponse(404, { ok: false, error: "order_not_found" });
    if (order.mindbodySyncStatus === "mindbody_synced") {
      return jsonResponse(409, {
        ok: false,
        error: "already_synced",
        order: adminSafeOrder(order),
      });
    }
    const item = getCatalogItem(order.localSku);
    if (!item) return jsonResponse(409, { ok: false, error: "catalog_sku_missing" });

    /** Acquire staff headers. */
    const staffUser = process.env.MINDBODY_STAFF_USERNAME?.trim();
    const staffPass = process.env.MINDBODY_STAFF_PASSWORD;
    /** @type {Record<string, string> | null} */
    let staffHeaders = null;
    if (staffUser && typeof staffPass === "string" && staffPass !== "") {
      const issued = await getMindbodyStaffAccessTokenCached();
      if (issued.ok) staffHeaders = mindbodyStaffBearerHeaders(issued.accessToken);
    } else {
      staffHeaders = mindbodyStaffApiHeaders();
    }
    if (!staffHeaders) {
      return jsonResponse(503, { ok: false, error: "staff_credentials_unavailable" });
    }

    /** If we don't have a resolved client yet, run resolve again. */
    /** @type {number | null} */
    let clientId = order.resolvedMindbodyClientId ?? null;
    if (clientId == null) {
      const resolved = await resolveOrCreateMindbodyClient(
        {
          knownMindbodyClientId: order.knownMindbodyClientId ?? null,
          email: order.customerEmail || "",
          fullName: order.customerName || "",
          firstName: order.customerFirstName || undefined,
          lastName: order.customerLastName || undefined,
          phone: order.customerPhone || "",
        },
        staffHeaders,
      );
      if (!resolved.ok) {
        return jsonResponse(409, {
          ok: false,
          error: "client_resolve_failed",
          reason: resolved.reason,
          ...("candidateCount" in resolved ? { candidateCount: resolved.candidateCount } : {}),
        });
      }
      clientId = resolved.clientId;
      await store.patch(order.orderId, {
        resolvedMindbodyClientId: clientId,
        mindbodySyncStatus: resolved.clientCreated ? "client_created" : "client_found",
      });
    }

    await store.patch(order.orderId, { mindbodySyncStatus: "mindbody_checkout_started" });

    const sessionId = order.stripeCheckoutSessionId || "manual_retry";
    /**
     * Forward the persisted Stripe-side amount snapshot so retries are amount-faithful.
     * Without these, a retry on a coupon-discounted order would re-send the catalog list
     * price to Mindbody (Stripe charged $55, Mindbody would record $65) — exactly the
     * silent-mismatch the webhook rewrite is designed to prevent. When the order had no
     * coupon, the persisted fields are absent → `syncOneTimePurchaseToMindbody` falls back
     * to `amountCents` for the paid amount and discount = 0, byte-identical to legacy.
     */
    const sync = await syncOneTimePurchaseToMindbody({
      orderId: order.orderId,
      stripeCheckoutSessionId: sessionId,
      localSku: order.localSku,
      clientId,
      amountCents: order.amountCents,
      paidAmountCents:
        typeof order.stripeAmountTotalCents === "number"
          ? order.stripeAmountTotalCents
          : undefined,
      discountAmountCents:
        typeof order.stripeAmountDiscountCents === "number"
          ? order.stripeAmountDiscountCents
          : undefined,
      promotionCode: order.stripePromotionCode || undefined,
      couponId: order.stripeCouponId || undefined,
      currency: order.currency,
      item,
    });
    if (sync.ok) {
      const updated = await store.patch(order.orderId, {
        mindbodySyncStatus: "mindbody_synced",
        mindbodySaleId: sync.mindbodySaleId,
        mindbodyTransactionId: sync.mindbodyTransactionId,
        mindbodyResponseSummary: sync.responseSummary,
        mindbodyPaymentMode: sync.mode,
        lastSyncAttemptAt: new Date().toISOString(),
        syncAttempts: (order.syncAttempts || 0) + 1,
        errorCode: undefined,
        errorMessageSafe: undefined,
      });
      return jsonResponse(200, {
        ok: true,
        retried: true,
        order: updated ? adminSafeOrder(updated) : null,
      });
    }
    const updated = await store.patch(order.orderId, {
      mindbodySyncStatus: sync.retryable ? "sync_failed_retryable" : "paid_but_not_synced",
      errorCode: sync.reason,
      errorMessageSafe: sync.message || "",
      lastSyncAttemptAt: new Date().toISOString(),
      syncAttempts: (order.syncAttempts || 0) + 1,
    });
    return jsonResponse(409, {
      ok: false,
      error: "retry_failed",
      reason: sync.reason,
      retryable: !!sync.retryable,
      order: updated ? adminSafeOrder(updated) : null,
    });
  }

  /* ---------------- POST resolve manual_review ---------------------------- */
  if (event.httpMethod === "POST" && /resolve$/.test(path)) {
    const body = parseJsonBody(event);
    if (!body || typeof body !== "object") return jsonResponse(400, { ok: false, error: "invalid_body" });
    const orderId = typeof /** @type {{ orderId?: unknown }} */ (body).orderId === "string"
      ? /** @type {string} */ (/** @type {{ orderId: string }} */ (body).orderId).trim()
      : "";
    if (!/^ord_[A-Z0-9]{8,40}$/.test(orderId)) {
      return jsonResponse(400, { ok: false, error: "invalid_orderId" });
    }
    const note = typeof /** @type {{ note?: unknown }} */ (body).note === "string"
      ? /** @type {string} */ (/** @type {{ note: string }} */ (body).note).trim().slice(0, 240)
      : "";
    const mbSaleIdRaw = typeof /** @type {{ mindbodySaleId?: unknown }} */ (body).mindbodySaleId === "string"
      ? /** @type {string} */ (/** @type {{ mindbodySaleId: string }} */ (body).mindbodySaleId).trim()
      : "";
    const mbSaleId = /^\d{1,18}$/.test(mbSaleIdRaw) ? mbSaleIdRaw : null;

    const order = await store.get(orderId);
    if (!order) return jsonResponse(404, { ok: false, error: "order_not_found" });
    /** @type {Partial<import("./stripe-order-store.mjs").OrderRecord>} */
    const patch = {
      errorMessageSafe: note,
      lastSyncAttemptAt: new Date().toISOString(),
    };
    if (mbSaleId) {
      patch.mindbodySyncStatus = "mindbody_synced";
      patch.mindbodySaleId = mbSaleId;
      patch.errorCode = undefined;
    } else {
      patch.mindbodySyncStatus = "manual_review";
    }
    const updated = await store.patch(order.orderId, patch);
    return jsonResponse(200, { ok: true, order: updated ? adminSafeOrder(updated) : null });
  }

  /* ---------------- GET single by orderId --------------------------------- */
  const q = event.queryStringParameters || {};
  const orderIdQ = typeof q.orderId === "string" ? q.orderId.trim() : "";
  if (event.httpMethod === "GET" && /^ord_[A-Z0-9]{8,40}$/.test(orderIdQ)) {
    const order = await store.get(orderIdQ);
    if (!order) return jsonResponse(404, { ok: false, error: "order_not_found" });
    return jsonResponse(200, { ok: true, order: adminSafeOrder(order) });
  }

  /* ---------------- GET list by status ------------------------------------ */
  if (event.httpMethod === "GET") {
    const status = typeof q.status === "string" && q.status.trim() ? q.status.trim() : "paid_but_not_synced";
    const limit = Math.min(Math.max(parseInt(typeof q.limit === "string" ? q.limit : "50", 10) || 50, 1), 200);
    const list = await store.listByStatus(status, { limit });
    return jsonResponse(200, {
      ok: true,
      status,
      count: list.length,
      orders: list.map(adminSafeOrder),
    });
  }

  return jsonResponse(405, { ok: false, error: "method_not_allowed" });
}
