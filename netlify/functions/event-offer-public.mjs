/**
 * GET /api/events/offer?o=
 * Public read of a personalized event-info offer (no admin token).
 */

import { jsonResponse } from "./mindbody-consumer-lib.mjs";
import { reservationDepositPaid } from "./event-booking-lib.mjs";
import { offerFromReservation, offerIsOpen, openEventOfferStore, toPublicOffer } from "./event-offer-store.mjs";
import { appendReservationActivity } from "./event-reservation-activity.mjs";
import { openEventReservationStore } from "./event-reservation-store.mjs";

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

/**
 * @param {import("./event-offer-store.mjs").EventOffer} offer
 * @param {import("./event-reservation-store.mjs").EventReservation | null} linkedRec
 */
function enrichOfferFromReservation(offer, linkedRec) {
  if (!linkedRec) return offer;
  return {
    ...offer,
    firstName: linkedRec.firstName || offer.firstName,
    lastName: linkedRec.lastName || offer.lastName,
    eventDate: linkedRec.eventDate || offer.eventDate,
    eventTime: linkedRec.eventTime || offer.eventTime,
    guests: linkedRec.guests ?? offer.guests,
    room: linkedRec.room || offer.room,
    packageCents: linkedRec.packageCents ?? offer.packageCents,
    depositCents: linkedRec.depositCents ?? offer.depositCents,
    remainingCents: linkedRec.remainingCents,
    remainingPaid: linkedRec.remainingPaid === true,
    depositPaid: offer.depositPaid === true || linkedRec.depositPaid === true || reservationDepositPaid(linkedRec),
    styling: offer.styling === true || linkedRec.styling === true,
    stylingCents: linkedRec.stylingCents,
    lockStyling: offer.lockStyling === true || linkedRec.styling === true,
    cleaningCents: linkedRec.cleaningCents ?? offer.cleaningCents,
    schedule: linkedRec.schedule || offer.schedule,
    reservationStatus: linkedRec.status || "",
  };
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
  const afterCheckout = queryParam(event, "afterCheckout") === "1";
  const viewReservation = queryParam(event, "view") === "1";
  const allowUsed = afterCheckout || viewReservation;

  const store = openEventOfferStore(event);
  const reservationStore = openEventReservationStore(event);
  if (!store.available && !reservationStore.available) {
    return jsonResponse(503, { ok: false, error: "store_unavailable" });
  }

  /** @type {import("./event-offer-store.mjs").EventOffer | null} */
  let offer = store.available ? await store.get(id) : null;
  /** @type {import("./event-reservation-store.mjs").EventReservation | null} */
  let linkedRec = null;

  if (!offer && allowUsed && reservationStore.available) {
    linkedRec = await reservationStore.findByOfferId(id);
    if (linkedRec) {
      offer = offerFromReservation(linkedRec, id);
    }
  }

  if (!offer) {
    return jsonResponse(404, { ok: false, error: "not_found", message: "This booking link is not valid." });
  }

  if (offer.status === "used" && !allowUsed) {
    return jsonResponse(409, {
      ok: false,
      error: "offer_used",
      message: "This booking link was already used. Reply to your email if you need a new one.",
    });
  }

  const paidLinked =
    linkedRec &&
    (linkedRec.depositPaid === true ||
      linkedRec.remainingPaid === true ||
      reservationDepositPaid(linkedRec) ||
      linkedRec.status === "deposit_paid_pending_confirm" ||
      linkedRec.status === "confirmed");

  if (!allowUsed || offer.status !== "used") {
    if (!paidLinked && !offerIsOpen(offer)) {
      return jsonResponse(410, {
        ok: false,
        error: "offer_expired",
        message: "This booking link has expired. Ask the studio to send a new Event Info link.",
      });
    }
  }

  if (!linkedRec && reservationStore.available) {
    if (offer.reservationId) {
      linkedRec = await reservationStore.get(offer.reservationId);
    }
    if (!linkedRec) {
      linkedRec = await reservationStore.findByOfferId(id);
    }
  }

  const enriched = enrichOfferFromReservation(offer, linkedRec);

  const trackView = queryParam(event, "track") === "1";
  if (trackView && !allowUsed && linkedRec && reservationStore.available) {
    const reservationId = linkedRec.id || offer.reservationId;
    if (reservationId) {
      await appendReservationActivity(
        reservationStore,
        reservationId,
        {
          kind: "booking_link_opened",
          label: "Payment link opened",
          offerId: offer.id,
        },
        { dedupeMs: 120_000 },
      );
    }
  }

  return jsonResponse(200, { ok: true, offer: toPublicOffer(enriched) });
}
