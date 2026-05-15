/**
 * Protected admin / debug endpoint for the Stripe Recurring Membership flow.
 * Gated by header `x-admin-token: <ADMIN_DEBUG_TOKEN>` (and `ADMIN_DEBUG_TOKEN` is required).
 *
 * V1 SCOPE — explicitly limited to read + retry-sync. No cancellation, no Customer Portal,
 * no plan switching, no payment-method update. The studio handles all those actions
 * manually through the Stripe Dashboard. See `docs/MEMBERSHIP-RECURRING-CHECKOUT.md` §4.5.
 *
 * Endpoints:
 *
 *   GET  /api/stripe/admin/subscriptions
 *        ?status=active|pending_first_invoice|past_due|canceled_admin|canceled_payment_failure
 *        &limit=50
 *      → list subscription records by status (default `active`).
 *
 *   GET  /api/stripe/admin/subscriptions?subscriptionId=sub_amare_…
 *      → single subscription record (sensitive fields elided).
 *
 *   GET  /api/stripe/admin/subscriptions/failures?limit=50
 *      → list invoices in `paid_but_not_synced` state across all subscriptions.
 *
 *   POST /api/stripe/admin/subscriptions/retry-sync
 *        body: { "subscriptionId": "sub_amare_…", "invoiceId": "in_…" }
 *      → re-attempt the Mindbody Pricing Option add for ONE specific invoice. Idempotent —
 *        refuses to retry an invoice that is already `synced`. Updates the InvoiceSyncEntry
 *        in place and adjusts top-level subscription status if the retry succeeds.
 *
 *   POST /api/stripe/admin/subscriptions/abandon
 *        body: { "subscriptionId": "sub_amare_…", "reason": "<short note>" }
 *      → mark a `pending_first_invoice` orphan as `canceled_admin`. Refuses to operate on
 *        records that ever reached `active`/`past_due` (those need a real Stripe-side
 *        cancellation). Use case: buyer aborted Stripe Checkout, our local record stayed
 *        at `pending_first_invoice`, and `block_if_active_subscription` is now blocking
 *        legitimate retries. Mindbody is NEVER touched by this endpoint.
 *
 * Refunds, plan-change, payment-method updates, and cancellations of *active* subscriptions
 * are NOT exposed here in V1 — those go through the Stripe Dashboard. If a request arrives
 * at a route that would imply one of those operations, we respond 405.
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
import {
  openSubscriptionStore,
} from "./stripe-subscription-store.mjs";
import { syncOneTimePurchaseToMindbody } from "./stripe-mindbody-sync-lib.mjs";

/* -------------------------------------------------------------------------- */
/* Auth + helpers                                                             */
/* -------------------------------------------------------------------------- */

/** @param {unknown} event */
function adminAuthorized(event) {
  const expected = (process.env.ADMIN_DEBUG_TOKEN || "").trim();
  if (!expected || expected.length < 16) return false;
  if (!event || typeof event !== "object") return false;
  const headers =
    /** @type {{ headers?: Record<string, string | undefined> }} */ (event).headers || {};
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === "x-admin-token") {
      const got = String(headers[k] || "").trim();
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

/**
 * Public-safe shape — strips raw consent text + IP/UA so the admin UI can be embedded
 * in dashboards without leaking PII. Includes the per-invoice sync state (without the
 * full Mindbody response payloads).
 *
 * @param {import("./stripe-subscription-store.mjs").SubscriptionRecord} record
 */
function adminSafeSubscription(record) {
  return {
    id: record.id,
    stripeSubscriptionId: record.stripeSubscriptionId,
    stripeCustomerId: record.stripeCustomerId,
    stripeCheckoutSessionId: record.stripeCheckoutSessionId,
    localSku: record.localSku,
    displayName: record.displayName,
    monthlyAmountCents: record.monthlyAmountCents,
    currency: record.currency,
    mindbodyClientId: record.mindbodyClientId,
    mindbodyServiceId: record.mindbodyServiceId,
    mindbodyContractProductId: record.mindbodyContractProductId,
    minimumCommitmentMonths: record.minimumCommitmentMonths,
    earlyCancellationFeePercent: record.earlyCancellationFeePercent,
    earlyCancellationFeeCents: record.earlyCancellationFeeCents,
    commitmentStartDate: record.commitmentStartDate,
    commitmentEndDate: record.commitmentEndDate,
    membershipConsentId: record.membershipConsentId,
    agreementVersion: record.agreementVersion,
    agreementTextHash: record.agreementTextHash,
    agreementAcceptedAt: record.agreementAcceptedAt,
    legalNameTyped: record.legalNameTyped || "",
    status: record.status,
    currentPeriodStart: record.currentPeriodStart,
    currentPeriodEnd: record.currentPeriodEnd,
    cancelAt: record.cancelAt,
    canceledAt: record.canceledAt,
    cancellationReason: record.cancellationReason,
    customerEmail: record.customerEmail || null,
    customerName: record.customerName || null,
    customerPhone: record.customerPhone || null,
    stripeLivemode: record.stripeLivemode === true,
    mindbodyTestModeBehavior: record.mindbodyTestModeBehavior || null,
    invoices: (record.invoices || []).map((e) => ({
      invoiceId: e.invoiceId,
      invoiceNumber: e.invoiceNumber ?? null,
      stripePaymentIntentId: e.stripePaymentIntentId || null,
      amountPaidCents: e.amountPaidCents,
      /**
       * Coupon audit (added when `ENABLE_STRIPE_RECURRING_COUPONS=1`). All four are
       * optional: pre-coupon entries omit them entirely, no-coupon invoices have
       * `discountAmountCents: 0` and empty coupon identity. Surface as `null` rather
       * than `undefined` so JSON consumers (admin UI, support tools) get a stable shape.
       */
      subtotalCents: typeof e.subtotalCents === "number" ? e.subtotalCents : null,
      discountAmountCents: typeof e.discountAmountCents === "number" ? e.discountAmountCents : null,
      taxAmountCents: typeof e.taxAmountCents === "number" ? e.taxAmountCents : null,
      couponId: e.couponId || null,
      promotionCode: e.promotionCode || null,
      currency: e.currency,
      paidAt: e.paidAt,
      status: e.status,
      mindbodySaleId: e.mindbodySaleId || null,
      mindbodyTransactionId: e.mindbodyTransactionId || null,
      retryCount: e.retryCount || 0,
      lastError: e.lastError || null,
      lastErrorMessage: e.lastErrorMessage || null,
      firstAttemptAt: e.firstAttemptAt,
      lastAttemptAt: e.lastAttemptAt,
      adminRetryRequired: e.adminRetryRequired === true,
      adminRetryCount: e.adminRetryCount || 0,
      adminLastRetryAt: e.adminLastRetryAt || null,
    })),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
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

  const subStore = openSubscriptionStore(event);
  if (!subStore.available) {
    return jsonResponse(503, { ok: false, error: "subscription_store_unavailable" });
  }

  const path = (event.path || event.rawUrl || "").toLowerCase();

  /* ---------------- POST abandon (orphan pending_first_invoice) ----------- */
  if (event.httpMethod === "POST" && /abandon$/.test(path)) {
    const body = parseJsonBody(event);
    if (!body || typeof body !== "object") {
      return jsonResponse(400, { ok: false, error: "invalid_body" });
    }
    const subscriptionId =
      typeof /** @type {{ subscriptionId?: unknown }} */ (body).subscriptionId === "string"
        ? /** @type {string} */ (/** @type {{ subscriptionId: string }} */ (body).subscriptionId).trim()
        : "";
    const reasonRaw =
      typeof /** @type {{ reason?: unknown }} */ (body).reason === "string"
        ? /** @type {string} */ (/** @type {{ reason: string }} */ (body).reason).trim()
        : "";
    if (!/^sub_amare_[A-Z0-9]{8,40}$/.test(subscriptionId)) {
      return jsonResponse(400, { ok: false, error: "invalid_subscriptionId" });
    }
    const reason = reasonRaw ? reasonRaw.slice(0, 120) : "admin_abandon";

    const record = await subStore.get(subscriptionId);
    if (!record) {
      return jsonResponse(404, { ok: false, error: "subscription_not_found" });
    }
    /**
     * Hard guardrails: this endpoint must NEVER abandon a subscription that has actually
     * billed the customer or could still bill them. Only orphans where Stripe Checkout
     * was opened but never completed are eligible — those cannot reach `active` anymore.
     */
    if (record.status !== "pending_first_invoice") {
      return jsonResponse(409, {
        ok: false,
        error: "not_abandonable",
        reason: "status_not_pending_first_invoice",
        currentStatus: record.status,
        message:
          "Only pending_first_invoice records can be abandoned. Active/past_due subscriptions must be canceled in the Stripe Dashboard.",
      });
    }
    if (Array.isArray(record.invoices) && record.invoices.length > 0) {
      return jsonResponse(409, {
        ok: false,
        error: "not_abandonable",
        reason: "has_invoice_history",
        message: "This record has invoice history — it has billed the customer. Cancel via Stripe Dashboard instead.",
      });
    }
    const subId = String(record.stripeSubscriptionId || "");
    if (subId && !subId.startsWith("pending_")) {
      return jsonResponse(409, {
        ok: false,
        error: "not_abandonable",
        reason: "real_stripe_subscription_bound",
        stripeSubscriptionId: subId,
        message:
          "A real Stripe subscription is already bound to this record. Cancel it via the Stripe Dashboard, then let customer.subscription.deleted clean up the record.",
      });
    }

    const updated = await subStore.patch(subscriptionId, {
      status: "canceled_admin",
      canceledAt: new Date().toISOString(),
      cancelReason: `admin_abandon:${reason}`,
    });
    console.log(
      JSON.stringify({
        event: "stripe_admin_subscription_abandoned",
        subscriptionId,
        mindbodyClientId: record.mindbodyClientId,
        localSku: record.localSku,
        reason,
      }),
    );
    return jsonResponse(200, {
      ok: true,
      abandoned: true,
      subscription: updated ? adminSafeSubscription(updated) : null,
    });
  }

  /* ---------------- POST retry-sync --------------------------------------- */
  if (event.httpMethod === "POST" && /retry-sync$/.test(path)) {
    const body = parseJsonBody(event);
    if (!body || typeof body !== "object") {
      return jsonResponse(400, { ok: false, error: "invalid_body" });
    }
    const subscriptionId =
      typeof /** @type {{ subscriptionId?: unknown }} */ (body).subscriptionId === "string"
        ? /** @type {string} */ (/** @type {{ subscriptionId: string }} */ (body).subscriptionId).trim()
        : "";
    const invoiceId =
      typeof /** @type {{ invoiceId?: unknown }} */ (body).invoiceId === "string"
        ? /** @type {string} */ (/** @type {{ invoiceId: string }} */ (body).invoiceId).trim()
        : "";
    if (!/^sub_amare_[A-Z0-9]{8,40}$/.test(subscriptionId)) {
      return jsonResponse(400, { ok: false, error: "invalid_subscriptionId" });
    }
    if (!/^in_[A-Za-z0-9_]{4,200}$/.test(invoiceId)) {
      return jsonResponse(400, { ok: false, error: "invalid_invoiceId" });
    }

    const record = await subStore.get(subscriptionId);
    if (!record) {
      return jsonResponse(404, { ok: false, error: "subscription_not_found" });
    }
    const entry = (record.invoices || []).find((e) => e && e.invoiceId === invoiceId);
    if (!entry) {
      return jsonResponse(404, { ok: false, error: "invoice_not_found" });
    }
    /**
     * Refuse if this invoice already synced — admin retry MUST be idempotent because the
     * sync grants Mindbody class credits. Surfacing 409 here is intentional; the dashboard
     * should hide the "Retry" button for `synced` rows but defense-in-depth on the API.
     */
    if (entry.status === "synced") {
      return jsonResponse(409, {
        ok: false,
        error: "already_synced",
        subscription: adminSafeSubscription(record),
      });
    }
    if (
      entry.status === "skipped_payment_failed" ||
      entry.status === "skipped_zero_amount" ||
      entry.status === "skipped_subscription_canceled"
    ) {
      return jsonResponse(409, {
        ok: false,
        error: "not_retryable",
        reason: entry.status,
        subscription: adminSafeSubscription(record),
      });
    }

    /** Catalog item is needed by `syncOneTimePurchaseToMindbody`. */
    const item = getCatalogItem(record.localSku);
    if (!item) {
      return jsonResponse(409, { ok: false, error: "catalog_sku_missing" });
    }

    /** Acquire staff headers — same logic as one-time admin retry. */
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

    const sync = await syncOneTimePurchaseToMindbody({
      orderId: `${record.id}_${entry.invoiceId}`,
      stripeCheckoutSessionId: record.stripeCheckoutSessionId || `inv_${entry.invoiceId}`,
      localSku: record.localSku,
      clientId: record.mindbodyClientId,
      amountCents: record.monthlyAmountCents,
      paidAmountCents: entry.amountPaidCents > 0 ? entry.amountPaidCents : record.monthlyAmountCents,
      /**
       * Use the coupon snapshot recorded when the invoice was first received. Pre-coupon
       * entries (or no-coupon invoices) have `entry.discountAmountCents` undefined → 0.
       * This keeps Mindbody Sale arithmetic consistent with the original Stripe charge:
       *   RegularPrice (`amountCents`) - DiscountAmount (`discountAmountCents`) == AmountPaid (`paidAmountCents`).
       * If the entry is from before the coupon-audit fields were added, we fall back to 0
       * — matching the pre-coupon byte-identical behavior.
       */
      discountAmountCents:
        typeof entry.discountAmountCents === "number" ? entry.discountAmountCents : 0,
      promotionCode: entry.promotionCode || undefined,
      couponId: entry.couponId || undefined,
      currency: entry.currency || record.currency,
      item,
    });

    const nowIso = new Date().toISOString();
    if (sync.ok) {
      const update = await subStore.updateInvoiceSync(record.id, entry.invoiceId, {
        status: "synced",
        mindbodySaleId: sync.mindbodySaleId,
        mindbodyTransactionId: sync.mindbodyTransactionId,
        adminRetryRequired: false,
        adminRetryCount: (entry.adminRetryCount || 0) + 1,
        adminLastRetryAt: nowIso,
        lastError: undefined,
        lastErrorMessage: undefined,
      });
      /** Promote subscription status to active if the failed invoice was holding it back. */
      if (record.status !== "active" && record.status !== "canceled_admin" && record.status !== "canceled_payment_failure") {
        await subStore.patch(record.id, { status: "active" });
      }
      const fresh = await subStore.get(record.id);
      return jsonResponse(200, {
        ok: true,
        retried: true,
        invoiceId: entry.invoiceId,
        mbSaleId: sync.mindbodySaleId,
        subscription: fresh ? adminSafeSubscription(fresh) : null,
        updateOk: update.ok,
      });
    }

    /** Retry failed → bump counters, keep paid_but_not_synced. */
    await subStore.updateInvoiceSync(record.id, entry.invoiceId, {
      status: "paid_but_not_synced",
      adminRetryRequired: true,
      adminRetryCount: (entry.adminRetryCount || 0) + 1,
      adminLastRetryAt: nowIso,
      lastError: sync.reason,
      lastErrorMessage: String((sync.message || "")).slice(0, 480),
    });
    const fresh = await subStore.get(record.id);
    return jsonResponse(409, {
      ok: false,
      error: "retry_failed",
      reason: sync.reason,
      retryable: !!sync.retryable,
      message: sync.message || "",
      subscription: fresh ? adminSafeSubscription(fresh) : null,
    });
  }

  /* ---------------- GET failures view ------------------------------------- */
  if (event.httpMethod === "GET" && /failures$/.test(path)) {
    const q = event.queryStringParameters || {};
    const limit = Math.min(
      Math.max(parseInt(typeof q.limit === "string" ? q.limit : "50", 10) || 50, 1),
      200,
    );
    const list = await subStore.listInvoiceSyncFailures({ limit });
    return jsonResponse(200, {
      ok: true,
      count: list.length,
      failures: list.map(({ subscription, entry }) => ({
        subscriptionId: subscription.id,
        stripeSubscriptionId: subscription.stripeSubscriptionId,
        localSku: subscription.localSku,
        mindbodyClientId: subscription.mindbodyClientId,
        customerEmail: subscription.customerEmail || null,
        invoiceId: entry.invoiceId,
        invoiceNumber: entry.invoiceNumber ?? null,
        amountPaidCents: entry.amountPaidCents,
        subtotalCents: typeof entry.subtotalCents === "number" ? entry.subtotalCents : null,
        discountAmountCents: typeof entry.discountAmountCents === "number" ? entry.discountAmountCents : null,
        couponId: entry.couponId || null,
        promotionCode: entry.promotionCode || null,
        currency: entry.currency,
        paidAt: entry.paidAt,
        retryCount: entry.retryCount || 0,
        adminRetryCount: entry.adminRetryCount || 0,
        adminLastRetryAt: entry.adminLastRetryAt || null,
        lastError: entry.lastError || null,
        lastErrorMessage: entry.lastErrorMessage || null,
        firstAttemptAt: entry.firstAttemptAt,
        lastAttemptAt: entry.lastAttemptAt,
      })),
    });
  }

  /* ---------------- GET single by subscriptionId -------------------------- */
  const q = event.queryStringParameters || {};
  const subIdQ = typeof q.subscriptionId === "string" ? q.subscriptionId.trim() : "";
  if (event.httpMethod === "GET" && /^sub_amare_[A-Z0-9]{8,40}$/.test(subIdQ)) {
    const record = await subStore.get(subIdQ);
    if (!record) return jsonResponse(404, { ok: false, error: "subscription_not_found" });
    return jsonResponse(200, { ok: true, subscription: adminSafeSubscription(record) });
  }

  /* ---------------- GET list by status ------------------------------------ */
  if (event.httpMethod === "GET") {
    const status =
      typeof q.status === "string" && q.status.trim() ? q.status.trim() : "active";
    const limit = Math.min(
      Math.max(parseInt(typeof q.limit === "string" ? q.limit : "50", 10) || 50, 1),
      200,
    );
    const list = await subStore.listByStatus(status, { limit });
    return jsonResponse(200, {
      ok: true,
      status,
      count: list.length,
      subscriptions: list.map(adminSafeSubscription),
    });
  }

  /**
   * V1 explicitly forbids cancel / portal / plan-change / payment-method endpoints. Any
   * other method/path combination is rejected so the surface area stays small.
   */
  return jsonResponse(405, { ok: false, error: "method_not_allowed" });
}
