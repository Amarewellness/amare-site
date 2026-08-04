/**
 * OpenAI Ads conversion measurement (checkout success only).
 * Logic mirrored in scripts/openai-conversion-measure.mjs — keep both in sync.
 */
(function openAiConversionMeasureBootstrap(global) {
  "use strict";

  function isMembershipOrder(order) {
    return !!(order && order.kind === "subscription");
  }

  function openAiAmountCents(order) {
    if (!order) return null;
    var cents =
      typeof order.amountCents === "number" && isFinite(order.amountCents)
        ? Math.round(order.amountCents)
        : NaN;
    if (!isFinite(cents) || cents <= 0) return null;
    return cents;
  }

  function buildOpenAiMeasureCall(order) {
    if (!order || typeof order.orderId !== "string" || !order.orderId.trim()) return null;
    var amount = openAiAmountCents(order);
    if (amount == null) return null;

    var orderId = order.orderId.trim();
    var localSku =
      typeof order.localSku === "string" && order.localSku.trim() ? order.localSku.trim() : "package";
    var displayName =
      typeof order.displayName === "string" && order.displayName.trim()
        ? order.displayName.trim()
        : localSku;
    var currency =
      typeof order.currency === "string" && order.currency.trim()
        ? order.currency.trim().toUpperCase()
        : "USD";

    var options = { event_id: orderId };

    if (isMembershipOrder(order)) {
      return {
        eventName: "subscription_created",
        data: {
          type: "plan_enrollment",
          plan_id: localSku,
          amount: amount,
          currency: currency,
          contents: [
            {
              id: localSku,
              name: displayName,
              content_type: "plan",
              quantity: 1,
            },
          ],
        },
        options: options,
      };
    }

    return {
      eventName: "order_created",
      data: {
        type: "contents",
        amount: amount,
        currency: currency,
        contents: [
          {
            id: localSku,
            name: displayName,
            content_type: "product",
            quantity: 1,
          },
        ],
      },
      options: options,
    };
  }

  function measureOpenAiConversion(order) {
    var call = buildOpenAiMeasureCall(order);
    if (!call) return false;
    if (typeof global.oaiq !== "function") return false;
    try {
      global.oaiq("measure", call.eventName, call.data, call.options);
      return true;
    } catch (e) {
      return false;
    }
  }

  global.amareOpenAiConversion = {
    measureOpenAiConversion: measureOpenAiConversion,
  };
})(typeof window !== "undefined" ? window : globalThis);
