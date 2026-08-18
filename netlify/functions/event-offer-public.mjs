/**
 * GET /api/events/offer?o=
 * Public read of a personalized event-info offer (no admin token).
 */

import { jsonResponse } from "./mindbody-consumer-lib.mjs";
import { offerIsOpen, openEventOfferStore, toPublicOffer } from "./event-offer-store.mjs";

/** @param {unknown} event @param {string} name */
function queryParam(event, name) {
  if (!event || typeof event !== "object") return "";
  const e = /** @type {{ rawUrl?: string; queryStringParameters?: Record<string, string | undefined> | null }} */ (event);
  const fromQs = e.queryStringParameters?.[name];
  if (fromQs) return String(fromQs).trim();
  try {
    if (e.rawUrl && e.rawUrl.includes("://")) {
      return (new URL(e.rawUrl).searchParams.get(name) || "").trim();
    }
  } catch {
    /* ignore */
  }
  return "";
}

/** @param {import("@netlify/functions").HandlerEvent} event */
export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" }, body: "" };
  }
  if (event.httpMethod !== "GET") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" });
  }
  const id = queryParam(event, "o").trim();
  if (!id.startsWith("off_") || id.length < 12) {
    return jsonResponse(400, { ok: false, error: "missing_offer" });
  }
  const store = openEventOfferStore(event);
  if (!store.available) {
    return jsonResponse(503, { ok: false, error: "store_unavailable" });
  }
  const offer = await store.get(id);
  if (!offer) {
    return jsonResponse(404, { ok: false, error: "not_found", message: "This booking link is not valid." });
  }
  if (offer.status === "used") {
    return jsonResponse(409, {
      ok: false,
      error: "offer_used",
      message: "This booking link was already used. Reply to your email if you need a new one.",
    });
  }
  if (!offerIsOpen(offer)) {
    return jsonResponse(410, {
      ok: false,
      error: "offer_expired",
      message: "This booking link has expired. Ask the studio to send a new Event Info link.",
    });
  }
  return jsonResponse(200, { ok: true, offer: toPublicOffer(offer) });
}
