/**
 * POST /api/mindbody/member/top-up/release
 *
 * Confirmed unpaid cancel. Fail-closed if Stripe/order may already be paid.
 * Browser/app clientId is never trusted. orderId is the capability token
 * (same unguessable ord_… used on cancel_url / PaymentSheet).
 */

import { jsonResponse } from "./mindbody-consumer-lib.mjs";
import { resolveStudioCustomer } from "./amare-studio-lib.mjs";
import { memberTopUpEnabled } from "./member-topup-blobs.mjs";
import {
  isMemberTopUpSku,
  releaseUnpaidTopUpOrder,
} from "./member-topup-lib.mjs";
import { openOrderStore } from "./stripe-order-store.mjs";
import { withMobileCorsHandler } from "./mobile-api-cors.mjs";

function parseJsonBody(event) {
  if (!event || typeof event !== "object") return {};
  const e = /** @type {{ body?: unknown; isBase64Encoded?: boolean }} */ (event);
  if (e.body == null || e.body === "") return {};
  const raw = e.isBase64Encoded
    ? Buffer.from(/** @type {string} */ (e.body), "base64").toString("utf8")
    : /** @type {string} */ (e.body);
  try {
    return JSON.parse(typeof raw === "string" ? raw.trim() || "{}" : String(raw));
  } catch {
    return null;
  }
}

/** @param {import("@netlify/functions").HandlerEvent} event */
async function topUpReleaseHandler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: { "Cache-Control": "no-store" }, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" });
  }
  if (!memberTopUpEnabled()) {
    return jsonResponse(503, { ok: false, error: "topup_disabled" });
  }

  const body = parseJsonBody(event);
  if (body === null) return jsonResponse(400, { ok: false, error: "invalid_json" });
  const orderId = String(/** @type {{ orderId?: unknown }} */ (body).orderId || "").trim();
  if (!/^ord_[A-Za-z0-9]{8,40}$/.test(orderId)) {
    return jsonResponse(400, { ok: false, error: "invalid_orderId" });
  }

  const store = openOrderStore(event);
  if (!store.available) return jsonResponse(503, { ok: false, error: "store_unavailable" });
  const order = await store.get(orderId);
  if (!order || !isMemberTopUpSku(order.localSku)) {
    return jsonResponse(404, { ok: false, error: "order_not_found" });
  }

  const ctxAuth = await resolveStudioCustomer(event);
  const linkedId = ctxAuth.ok && Number(ctxAuth.clientId) > 0 ? Number(ctxAuth.clientId) : null;
  const orderClient = Number(order.knownMindbodyClientId || 0);
  const clientId = linkedId && orderClient === linkedId ? linkedId : null;

  const result = await releaseUnpaidTopUpOrder(event, { order, clientId });
  if (!result.ok && (result.reason === "order_paid" || result.reason === "pi_succeeded" || result.reason === "session_paid" || result.reason === "pi_processing")) {
    return jsonResponse(409, { ok: false, released: false, error: result.reason });
  }
  if (result.released && order.mindbodySyncStatus === "checkout_created") {
    try {
      await store.patch(order.orderId, {
        mindbodySyncStatus: "canceled",
        errorCode: "buyer_canceled",
      });
    } catch {
      /* reservation release is the authority */
    }
  }
  return jsonResponse(200, {
    ok: true,
    released: result.released === true,
    reason: result.reason || null,
  });
}

export const handler = withMobileCorsHandler(topUpReleaseHandler);
