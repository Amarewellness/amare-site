/**
 * OpenAI Ads conversion measurement helpers (browser + Node tests).
 * Keep in sync with src/js/openai-conversion-measure.js
 * @see https://developers.openai.com/ads/measurement-pixel
 */

/**
 * @param {{ kind?: unknown } | null | undefined} order
 */
export function isMembershipOrder(order) {
  return !!(order && order.kind === "subscription");
}

/**
 * Integer minor currency units from order-status `amountCents`.
 * @param {{ amountCents?: unknown } | null | undefined} order
 * @returns {number | null}
 */
export function openAiAmountCents(order) {
  if (!order) return null;
  const cents =
    typeof order.amountCents === "number" && Number.isFinite(order.amountCents)
      ? Math.round(order.amountCents)
      : NaN;
  if (!Number.isFinite(cents) || cents <= 0) return null;
  return cents;
}

/**
 * Build the OpenAI measure() call descriptor without side effects.
 * @param {{ orderId?: unknown; kind?: unknown; localSku?: unknown; displayName?: unknown; amountCents?: unknown; currency?: unknown } | null | undefined} order
 * @returns {{ eventName: string; data: Record<string, unknown>; options: { event_id: string } } | null}
 */
export function buildOpenAiMeasureCall(order) {
  if (!order || typeof order.orderId !== "string" || !order.orderId.trim()) return null;
  const amount = openAiAmountCents(order);
  if (amount == null) return null;

  const orderId = order.orderId.trim();
  const localSku =
    typeof order.localSku === "string" && order.localSku.trim() ? order.localSku.trim() : "package";
  const displayName =
    typeof order.displayName === "string" && order.displayName.trim()
      ? order.displayName.trim()
      : localSku;
  const currency =
    typeof order.currency === "string" && order.currency.trim()
      ? order.currency.trim().toUpperCase()
      : "USD";

  const options = { event_id: orderId };

  if (isMembershipOrder(order)) {
    return {
      eventName: "subscription_created",
      data: {
        type: "plan_enrollment",
        plan_id: localSku,
        amount,
        currency,
        contents: [
          {
            id: localSku,
            name: displayName,
            content_type: "plan",
            quantity: 1,
          },
        ],
      },
      options,
    };
  }

  return {
    eventName: "order_created",
    data: {
      type: "contents",
      amount,
      currency,
      contents: [
        {
          id: localSku,
          name: displayName,
          content_type: "product",
          quantity: 1,
        },
      ],
    },
    options,
  };
}

/**
 * @param {{ orderId?: unknown; kind?: unknown; localSku?: unknown; displayName?: unknown; amountCents?: unknown; currency?: unknown } | null | undefined} order
 * @param {((...args: unknown[]) => unknown)=} oaiq
 * @returns {boolean}
 */
export function measureOpenAiConversion(order, oaiq) {
  const call = buildOpenAiMeasureCall(order);
  if (!call) return false;

  const fn =
    typeof oaiq === "function"
      ? oaiq
      : typeof globalThis.oaiq === "function"
        ? globalThis.oaiq
        : null;
  if (typeof fn !== "function") return false;

  try {
    fn("measure", call.eventName, call.data, call.options);
    return true;
  } catch {
    return false;
  }
}

/**
 * GA4 purchase payload builder — mirrors checkout-success.js (must stay unchanged).
 * @param {{ orderId: string; localSku: string; displayName?: string; amountCents?: number; currency?: string; ctaLocation?: string|null; clientWasNewlyCreated?: boolean; promotionCode?: string }} order
 */
export function buildGa4PurchasePayload(order) {
  const cents = typeof order.amountCents === "number" && Number.isFinite(order.amountCents) ? order.amountCents : 0;
  const value = cents > 0 ? Math.round(cents) / 100 : 0;
  const currency = (order.currency || "USD").toUpperCase();
  const displayName = order.displayName || order.localSku || "Package";
  const coupon =
    typeof order.promotionCode === "string" && order.promotionCode.trim()
      ? order.promotionCode.trim()
      : undefined;

  return {
    transaction_id: order.orderId,
    value,
    currency,
    affiliation: "Stripe",
    coupon,
    tax: 0,
    shipping: 0,
    items: [
      {
        item_id: order.localSku,
        item_name: displayName,
        item_category: "package",
        price: value,
        quantity: 1,
      },
    ],
    cta_location: order.ctaLocation || undefined,
    new_client: order.clientWasNewlyCreated ? "1" : "0",
  };
}
