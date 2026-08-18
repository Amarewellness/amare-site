/**
 * Payment-flow routing for one-time commerce.
 *
 * `flow` (existing) = product path (`stripe_to_mindbody_one_time`).
 * `paymentFlow` / Stripe `amarePaymentFlow` = who collected the card.
 *
 * Missing paymentFlow is legacy Hosted Checkout. Do not guess or repair
 * metadata during webhook fulfillment.
 */

import { getCatalogItem } from "./stripe-catalog-lib.mjs";
import { fulfillOneTimeMindbodySale } from "./stripe-onetime-fulfillment.mjs";

export const PAYMENT_FLOW_HOSTED = "hosted_checkout";
export const PAYMENT_FLOW_MOBILE = "mobile_payment_sheet";
export const PRODUCT_FLOW_ONE_TIME = "stripe_to_mindbody_one_time";

export const MOBILE_ONE_TIME_SKUS = Object.freeze([
  "new_client_special_3_for_65",
  "drop_in_single_class",
  "drop_in_same_day",
  "pack_10_classes",
  "pack_20_classes",
]);

/** @param {unknown} value */
export function normalizePaymentFlow(value) {
  if (value === PAYMENT_FLOW_MOBILE) return PAYMENT_FLOW_MOBILE;
  if (value === PAYMENT_FLOW_HOSTED || value == null || value === "") {
    return PAYMENT_FLOW_HOSTED;
  }
  return String(value);
}

/** @param {unknown} order */
export function isMobilePaymentSheetOrder(order) {
  return Boolean(order && typeof order === "object" && /** @type {{ paymentFlow?: unknown }} */ (order).paymentFlow === PAYMENT_FLOW_MOBILE);
}

/** @param {unknown} order */
export function checkoutSessionMayFulfillOrder(order) {
  if (!order || typeof order !== "object") return false;
  return !isMobilePaymentSheetOrder(order);
}

/** @param {unknown} item */
export function isOneTimeCatalogProduct(item) {
  if (!item || typeof item !== "object") return false;
  const it = /** @type {{ stripeMode?: unknown; kind?: unknown }} */ (item);
  if (it.stripeMode === "subscription" || it.kind === "monthlyMembership") return false;
  return it.kind === "newClient" || it.kind === "dropin" || it.kind === "packs";
}

export function isMobilePrepareSku(sku) {
  return MOBILE_ONE_TIME_SKUS.includes(String(sku || "").trim());
}

/** @param {unknown} customer */
function stripeCustomerIdOf(customer) {
  if (typeof customer === "string" && customer.trim()) return customer.trim();
  if (customer && typeof customer === "object") {
    const id = /** @type {{ id?: unknown }} */ (customer).id;
    if (typeof id === "string" && id.trim()) return id.trim();
  }
  return "";
}

/** @param {unknown} metadata */
function meta(metadata) {
  if (!metadata || typeof metadata !== "object") return /** @type {Record<string, string>} */ ({});
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(/** @type {Record<string, unknown>} */ (metadata))) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * Fail-closed `payment_intent.succeeded` gate. Never look up by PaymentIntent id.
 *
 * @param {{
 *   paymentIntent: Record<string, unknown>;
 *   order: import("./stripe-order-store.mjs").OrderRecord | null | undefined;
 *   catalogItem?: import("./stripe-catalog-lib.mjs").CatalogItem | null;
 * }} input
 * @returns {{ ok: true } | { ok: false; reason: string }}
 */
export function evaluateMobilePaymentIntentGate(input) {
  const pi = input.paymentIntent;
  const order = input.order;
  const md = meta(pi && pi.metadata);

  if (pi && (pi.invoice != null && pi.invoice !== "")) {
    return { ok: false, reason: "subscription_invoice_intent" };
  }

  if (md.amarePaymentFlow !== PAYMENT_FLOW_MOBILE) {
    return { ok: false, reason: "wrong_amarePaymentFlow" };
  }

  const metaOrderId = typeof md.orderId === "string" ? md.orderId.trim() : "";
  if (!metaOrderId) return { ok: false, reason: "missing_order_id" };
  if (!order || typeof order !== "object") return { ok: false, reason: "order_not_found" };
  if (order.orderId !== metaOrderId) return { ok: false, reason: "order_id_mismatch" };

  if (order.paymentFlow !== PAYMENT_FLOW_MOBILE) {
    return { ok: false, reason: "wrong_paymentFlow" };
  }

  const metaSku = typeof md.localSku === "string" ? md.localSku.trim() : "";
  if (!metaSku) return { ok: false, reason: "missing_sku" };
  if (metaSku !== order.localSku) return { ok: false, reason: "sku_mismatch" };

  const catalogItem =
    input.catalogItem !== undefined ? input.catalogItem : getCatalogItem(order.localSku);
  if (!catalogItem) return { ok: false, reason: "catalog_missing" };
  if (!isOneTimeCatalogProduct(catalogItem)) return { ok: false, reason: "not_one_time" };
  if (catalogItem.localSku !== order.localSku) return { ok: false, reason: "sku_mismatch" };

  const received = Number(pi.amount_received);
  const catalogAmount = Number(catalogItem.amountCents);
  const orderAmount = Number(order.amountCents);
  if (!Number.isInteger(received) || received <= 0) return { ok: false, reason: "amount_mismatch" };
  if (received !== orderAmount || received !== catalogAmount) return { ok: false, reason: "amount_mismatch" };

  const piCurrency = String(pi.currency || "").trim().toLowerCase();
  const orderCurrency = String(order.currency || "").trim().toLowerCase();
  const catalogCurrency = String(catalogItem.currency || "").trim().toLowerCase();
  if (!piCurrency || piCurrency !== orderCurrency || piCurrency !== catalogCurrency) {
    return { ok: false, reason: "currency_mismatch" };
  }

  if (order.stripeCustomerId) {
    const piCustomer = stripeCustomerIdOf(pi.customer);
    if (!piCustomer || piCustomer !== order.stripeCustomerId) {
      return { ok: false, reason: "customer_mismatch" };
    }
  }

  const orderUser =
    typeof order.amareUserId === "string" && order.amareUserId.startsWith("usr_")
      ? order.amareUserId
      : "";
  if (!orderUser) return { ok: false, reason: "missing_amare_user" };
  if (md.amareUserId && md.amareUserId !== orderUser) {
    return { ok: false, reason: "amare_user_mismatch" };
  }

  return { ok: true };
}

/**
 * @param {import("./stripe-order-store.mjs").OrderRecord} order
 * @returns {"processing"|"payment_succeeded"|"mindbody_sync_claimed"|"mindbody_synced"|"mindbody_sync_unknown"|"failed"}
 */
export function mobilePaymentStatusAlias(order) {
  const s = String(order?.mindbodySyncStatus || "");
  if (s === "mindbody_synced") return "mindbody_synced";
  if (s === "mindbody_sync_claimed") return "mindbody_sync_claimed";
  if (s === "mindbody_sync_unknown") return "mindbody_sync_unknown";
  if (s === "payment_completed" || s === "client_resolving" || s === "client_created" || s === "client_found") {
    return "payment_succeeded";
  }
  if (
    s === "canceled" ||
    s === "paid_but_not_synced" ||
    s === "sync_failed_retryable" ||
    s === "sync_failed_manual_review" ||
    s === "manual_review" ||
    s === "refunded"
  ) {
    return "failed";
  }
  return "processing";
}

/**
 * @param {Record<string, unknown>} paymentIntent
 * @param {ReturnType<import("./stripe-order-store.mjs").openOrderStore>} store
 * @param {{
 *   stripeEventId?: string;
 *   syncFn?: import("./stripe-mindbody-sync-lib.mjs").syncOneTimePurchaseToMindbody;
 *   getCatalogItem?: typeof getCatalogItem;
 *   testModeDecision?: { stripeLivemode: boolean; behavior: "skip" | "mindbody_test" | "live"; mindbodyTest: boolean };
 * }} [opts]
 */
export async function handleMobilePaymentIntentSucceeded(paymentIntent, store, opts = {}) {
  const md = meta(paymentIntent && paymentIntent.metadata);
  const orderId = typeof md.orderId === "string" ? md.orderId.trim() : "";
  let order = null;
  if (orderId) {
    try {
      order = await store.get(orderId);
    } catch {
      order = null;
    }
  }

  const lookup = opts.getCatalogItem || getCatalogItem;
  const catalogItem = order ? lookup(order.localSku) : null;
  const gate = evaluateMobilePaymentIntentGate({
    paymentIntent,
    order,
    catalogItem,
  });
  if (!gate.ok) {
    console.log(
      JSON.stringify({
        event: "stripe_mobile_pi_gate_rejected",
        reason: gate.reason,
        orderId: orderId || null,
        stripeEventId: opts.stripeEventId || null,
      }),
    );
    return { fulfilled: false, claimed: false, noop: true, reason: gate.reason, status: "ignored" };
  }

  const testModeDecision = opts.testModeDecision || {
    stripeLivemode: true,
    behavior: /** @type {const} */ ("live"),
    mindbodyTest: false,
  };
  if (!testModeDecision.stripeLivemode && testModeDecision.behavior === "skip") {
    await store.patch(order.orderId, {
      mindbodySyncStatus: "test_mode_no_sync",
      errorCode: "stripe_test_mode_skipped",
      stripePaymentIntentId:
        typeof paymentIntent.id === "string" ? paymentIntent.id : order.stripePaymentIntentId,
      stripePaymentStatus: "succeeded",
    });
    return { fulfilled: false, claimed: false, noop: false, reason: "test_mode_skipped", status: "test_mode_no_sync" };
  }

  const clientId =
    typeof order.knownMindbodyClientId === "number" && order.knownMindbodyClientId > 0
      ? order.knownMindbodyClientId
      : typeof order.resolvedMindbodyClientId === "number" && order.resolvedMindbodyClientId > 0
        ? order.resolvedMindbodyClientId
        : null;
  if (clientId == null) {
    console.error(
      JSON.stringify({
        event: "stripe_mobile_pi_missing_studio_client",
        orderId: order.orderId,
        stripeEventId: opts.stripeEventId || null,
      }),
    );
    return { fulfilled: false, claimed: false, noop: true, reason: "missing_studio_client", status: "ignored" };
  }

  await store.patch(order.orderId, {
    mindbodySyncStatus: "payment_completed",
    stripePaymentStatus: "succeeded",
    stripePaymentIntentId:
      typeof paymentIntent.id === "string" ? paymentIntent.id : order.stripePaymentIntentId,
    stripeAmountTotalCents: Number(paymentIntent.amount_received),
    stripeLivemode: testModeDecision.stripeLivemode === true,
    mindbodyTestModeBehavior: testModeDecision.behavior,
  });

  const sale = await fulfillOneTimeMindbodySale({
    store,
    orderId: order.orderId,
    stripeCheckoutSessionId: order.stripeCheckoutSessionId || String(paymentIntent.id || ""),
    localSku: order.localSku,
    clientId,
    amountCents: order.amountCents,
    paidAmountCents: Number(paymentIntent.amount_received),
    discountAmountCents: 0,
    currency: order.currency,
    mindbodyTest: testModeDecision.mindbodyTest === true,
    item: catalogItem,
    stripeEventId: opts.stripeEventId,
    syncFn: opts.syncFn,
  });

  return {
    fulfilled: sale.status === "mindbody_synced" && !sale.noop,
    claimed: sale.claimOutcome === "CLAIMED" && !sale.noop,
    noop: !!sale.noop,
    reason: sale.reason || (sale.noop ? "already_fulfilled" : null),
    status: sale.status,
    claimOutcome: sale.claimOutcome,
  };
}
