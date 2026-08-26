/**
 * POST /api/stripe/events/create-deposit
 *
 * Creates a Stripe Checkout Session for the $200 private-event deposit.
 * Saves the card (setup_future_usage: off_session) for the day-before balance
 * and extra-time charges. Does not touch Mindbody.
 */

import Stripe from "stripe";

import { jsonResponse } from "./mindbody-consumer-lib.mjs";
import { normalizeUsMobilePhone } from "./oauth-lib.mjs";
import {
  EVENT_CONSENT_TEXT,
  EVENT_CURRENCY,
  EVENT_DEPOSIT_CENTS,
  EVENT_DEPOSIT_MIN_CENTS,
  EVENT_OVERTIME_BLOCK_CENTS,
  EVENT_PACKAGE_CENTS,
  validateEventReservationInput,
  reservationDepositPaid,
  formatUsd,
  assertEventLiveStripeBlocked,
  eventCheckoutIdempotencyKey,
} from "./event-booking-lib.mjs";
import { applyOfferLocks, applyReservationPricingLocks, eventPriceOverrideFrom, offerIsOpen, openEventOfferStore } from "./event-offer-store.mjs";
import { appendReservationActivity } from "./event-reservation-activity.mjs";
import { newEventReservationId, openEventReservationStore } from "./event-reservation-store.mjs";

function featureEnabled() {
  return (process.env.ENABLE_STRIPE_EVENT_DEPOSIT || "").trim() === "1";
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
  return (process.env.SITE_URL || "").trim().replace(/\/$/, "");
}

/** @param {unknown} event @param {string} name */
function header(event, name) {
  if (!event || typeof event !== "object") return "";
  const headers = /** @type {{ headers?: Record<string, unknown> }} */ (event).headers || {};
  const want = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === want) return String(headers[k] ?? "").trim();
  }
  return "";
}

/** @param {unknown} raw */
function formatStripeCustomerPhoneE164(raw) {
  const norm = normalizeUsMobilePhone(raw);
  if (norm) return `+1${norm}`;
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return "";
  const compact = trimmed.replace(/[\s().-]/g, "");
  if (/^\+[1-9]\d{6,14}$/.test(compact)) return compact;
  return trimmed.slice(0, 32);
}

/** @param {unknown} event */
function clientIp(event) {
  const fwd = header(event, "x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim().slice(0, 64);
  return header(event, "x-nf-client-connection-ip").slice(0, 64);
}

/**
 * @param {import("stripe").default} stripe
 * @param {string} email
 * @param {string} name
 * @param {string} phone
 */
async function findOrCreateCustomer(stripe, email, name, phone) {
  const list = await stripe.customers.list({ email, limit: 20 });
  const existing = (list.data || []).find((c) => c && !c.deleted);
  const phoneE164 = formatStripeCustomerPhoneE164(phone);
  if (existing) {
    /** @type {import("stripe").Stripe.CustomerUpdateParams} */
    const patch = {};
    if (name && existing.name !== name) patch.name = name;
    if (phoneE164 && existing.phone !== phoneE164) patch.phone = phoneE164;
    const md = existing.metadata || {};
    if (md.source !== "amare_event") {
      patch.metadata = { ...md, source: md.source || "amare_event" };
    }
    if (Object.keys(patch).length) {
      try {
        await stripe.customers.update(existing.id, patch);
      } catch {
        /* reuse anyway */
      }
    }
    return existing.id;
  }
  const created = await stripe.customers.create({
    email,
    name,
    phone: phoneE164 || undefined,
    metadata: { source: "amare_event" },
  });
  return created.id;
}

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
      error: "event_deposit_disabled",
      message: "Online deposits aren’t open yet. Send an inquiry and we’ll follow up with a payment link.",
    });
  }
  const sk = stripeSecret();
  if (!sk) {
    return jsonResponse(503, {
      ok: false,
      error: "stripe_not_configured",
      message: "Payments aren’t available right now. Please try again later or send an inquiry.",
    });
  }
  const liveGuard = assertEventLiveStripeBlocked();
  if (!liveGuard.ok) {
    return jsonResponse(403, { ok: false, error: liveGuard.error, message: liveGuard.message });
  }

  const body = parseJsonBody(event);
  if (body === null) return jsonResponse(400, { ok: false, error: "invalid_json" });
  const rawBody = /** @type {Record<string, unknown>} */ (body && typeof body === "object" ? body : {});
  const offerToken = String(rawBody.offerId || rawBody.o || "").trim();
  const offerStore = offerToken ? openEventOfferStore(event) : null;
  let offer = null;
  if (offerToken) {
    if (!offerStore?.available) {
      return jsonResponse(503, { ok: false, error: "store_unavailable", message: "Could not load this booking link." });
    }
    offer = await offerStore.get(offerToken);
    if (!offer || !offerIsOpen(offer)) {
      return jsonResponse(409, {
        ok: false,
        error: "offer_invalid",
        message: "This booking link is no longer valid. Ask the studio to send a new one.",
      });
    }
  }
  const store = openEventReservationStore(event);
  /** @type {import("./event-reservation-store.mjs").EventReservation | null} */
  let linkedReservation = null;
  if (offer?.reservationId) {
    if (!store.available) {
      return jsonResponse(503, {
        ok: false,
        error: "store_unavailable",
        message: "Could not start the reservation. Please try again in a moment.",
      });
    }
    linkedReservation = await store.get(offer.reservationId);
  }
  if (offer && !linkedReservation && store.available) {
    linkedReservation = await store.findByOfferId(offer.id);
  }
  const parsed = validateEventReservationInput(
    offer ? applyReservationPricingLocks(rawBody, offer, linkedReservation) : rawBody,
    offer ? eventPriceOverrideFrom(offer, linkedReservation, {
      packageDefault: EVENT_PACKAGE_CENTS,
      depositDefault: EVENT_DEPOSIT_CENTS,
    }) : undefined,
    // Staff-locked dates (manual events / booking links) may already be today or past
    // when the client opens checkout. The public form still requires a future date.
    { allowPast: offer?.lockDateTime === true },
  );
  if (!parsed.ok) {
    return jsonResponse(400, { ok: false, error: parsed.error, message: parsed.message });
  }

  if (!store.available) {
    return jsonResponse(503, {
      ok: false,
      error: "store_unavailable",
      message: "Could not start the reservation. Please try again in a moment.",
    });
  }

  const now = new Date().toISOString();
  const fullName = `${parsed.firstName} ${parsed.lastName}`.trim();
  let id = "";
  let existing = linkedReservation;
  const depositAlreadyPaid =
    offer?.depositPaid === true || existing?.depositPaid === true || reservationDepositPaid(existing);
  const balanceDueCents =
    depositAlreadyPaid && Number(existing?.remainingCents) > 0
      ? Number(existing.remainingCents)
      : parsed.remainingCents;
  if (existing?.remainingPaid === true) {
    return jsonResponse(409, {
      ok: false,
      error: "already_paid",
      message: "This event balance is already paid. Contact the studio if you need help.",
    });
  }
  if (depositAlreadyPaid && balanceDueCents < EVENT_DEPOSIT_MIN_CENTS) {
    return jsonResponse(400, {
      ok: false,
      error: "nothing_due",
      message: "There is no remaining balance to pay online.",
    });
  }
  if (offer?.reservationId || linkedReservation) {
    const reusable =
      existing &&
      existing.status !== "canceled" &&
      existing.remainingPaid !== true;
    if (reusable) id = existing.id;
  }
  if (!id) {
    id = newEventReservationId();
    /** @type {import("./event-reservation-store.mjs").EventReservation} */
    const record = {
      id,
      status: depositAlreadyPaid ? existing?.status || "deposit_paid_pending_confirm" : "deposit_pending",
      firstName: parsed.firstName,
      lastName: parsed.lastName,
      email: parsed.email,
      phone: parsed.phone,
      eventDate: parsed.eventDate,
      eventTime: parsed.eventTime,
      guests: parsed.guests,
      room: parsed.room,
      styling: parsed.styling,
      packageCents: parsed.packageCents,
      depositCents: parsed.depositCents,
      stylingCents: parsed.stylingCents,
      remainingCents: parsed.remainingCents,
      cleaningCents: parsed.cleaningCents || 0,
      schedule: offer?.schedule,
      overtimeBlockCents: EVENT_OVERTIME_BLOCK_CENTS,
      overtimeCentsTotal: 0,
      overtimeCharges: [],
      customCentsTotal: 0,
      customCharges: [],
      currency: EVENT_CURRENCY,
      consentText: EVENT_CONSENT_TEXT,
      consentAcceptedAt: now,
      consentIp: clientIp(event) || undefined,
      offerId: offer?.id,
      depositPaid: depositAlreadyPaid ? true : undefined,
      checkoutGeneration: 0,
      createdAt: now,
      updatedAt: now,
    };
    const put = await store.put(record, { onlyIfNew: true });
    if (!put.ok) {
      return jsonResponse(500, { ok: false, error: "reservation_create_failed" });
    }
  } else {
    const patched = await store.patch(id, {
      firstName: parsed.firstName,
      lastName: parsed.lastName,
      email: parsed.email,
      phone: parsed.phone,
      eventDate: parsed.eventDate,
      eventTime: parsed.eventTime,
      guests: parsed.guests,
      room: parsed.room,
      styling: parsed.styling,
      packageCents: parsed.packageCents,
      depositCents: parsed.depositCents,
      stylingCents: parsed.stylingCents,
      remainingCents: parsed.remainingCents,
      cleaningCents: parsed.cleaningCents || 0,
      schedule: offer?.schedule || existing?.schedule,
      offerId: offer?.id,
      consentAcceptedAt: now,
      consentIp: clientIp(event) || undefined,
    });
    if (!patched.ok) {
      return jsonResponse(500, { ok: false, error: "reservation_create_failed" });
    }
    if (existing?.status === "expired") {
      await store.patch(id, { status: "deposit_pending" });
    }
  }

  let recForCheckout = (await store.get(id)) || existing;
  let checkoutGeneration =
    Number.isInteger(recForCheckout?.checkoutGeneration) && (recForCheckout?.checkoutGeneration || 0) >= 0
      ? /** @type {number} */ (recForCheckout.checkoutGeneration)
      : 0;

  const stripe = new Stripe(sk, {
    apiVersion: "2025-08-27.basil",
    appInfo: { name: "amare-event-deposit", version: "0.1.0" },
  });

  const priorSessionId = String(recForCheckout?.stripeCheckoutSessionId || "").trim();
  if (priorSessionId) {
    try {
      const liveSession = await stripe.checkout.sessions.retrieve(priorSessionId);
      const alreadyPaid = depositAlreadyPaid
        ? recForCheckout?.remainingPaid === true
        : reservationDepositPaid(recForCheckout);
      if (liveSession.status === "open" && liveSession.url && !alreadyPaid) {
        if (!depositAlreadyPaid && recForCheckout?.status === "expired") {
          await store.patch(id, { status: "deposit_pending" });
        }
        return jsonResponse(200, {
          ok: true,
          url: liveSession.url,
          reservationId: id,
          reused: true,
        });
      }
      if ((liveSession.status === "expired" || liveSession.status === "complete") && !alreadyPaid) {
        checkoutGeneration += 1;
        await store.patch(id, {
          checkoutGeneration,
          ...(depositAlreadyPaid ? {} : { status: "deposit_pending" }),
        });
        recForCheckout = (await store.get(id)) || recForCheckout;
      }
    } catch {
      /* create a new checkout below */
    }
  }

  let customerId = "";
  try {
    customerId = await findOrCreateCustomer(stripe, parsed.email, fullName, parsed.phone);
  } catch (e) {
    console.error(
      JSON.stringify({
        event: "event_deposit_customer_failed",
        reservationId: id,
        detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 200),
      }),
    );
    return jsonResponse(502, {
      ok: false,
      error: "stripe_customer_failed",
      message: "Could not start checkout. Please try again.",
    });
  }

  const origin = originFromEvent(event);
  const offerQs = offer ? `&o=${encodeURIComponent(offer.id)}` : "";
  const successUrl = depositAlreadyPaid
    ? `${origin}/event-info?reserved=1&balance=1&eventId=${encodeURIComponent(id)}${offerQs}`
    : `${origin}/event-info?reserved=1&eventId=${encodeURIComponent(id)}${offerQs}`;
  const cancelUrl = `${origin}/event-info?canceled=1${offerQs}`;

  /** @type {Record<string, string>} */
  const metadata = {
    flow: "event_deposit",
    reservationId: id,
    eventDate: parsed.eventDate,
    eventTime: parsed.eventTime,
    guests: String(parsed.guests),
    room: parsed.room,
    styling: parsed.styling ? "1" : "0",
    remainingCents: String(balanceDueCents),
    source: "amare_site",
    ...(depositAlreadyPaid ? { payRemainingNow: "1" } : {}),
    ...(offer ? { offerId: offer.id } : {}),
  };

  /** @type {import("stripe").Stripe.Checkout.SessionCreateParams} */
  const params = depositAlreadyPaid
    ? {
        mode: "payment",
        customer: customerId,
        customer_update: { name: "auto", address: "auto" },
        phone_number_collection: { enabled: true },
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: EVENT_CURRENCY,
              unit_amount: balanceDueCents,
              product_data: {
                name: "Private event balance — AMARÉ",
                description: `${parsed.eventDate} ${parsed.eventTime} · ${parsed.room} · ${parsed.guests} guests`,
                metadata: { flow: "event_deposit", reservationId: id, payRemainingNow: "1" },
              },
            },
          },
        ],
        automatic_tax: { enabled: false },
        success_url: successUrl,
        cancel_url: cancelUrl,
        client_reference_id: id,
        metadata,
        payment_intent_data: {
          setup_future_usage: "off_session",
          metadata,
        },
      }
    : {
        mode: "payment",
        customer: customerId,
        customer_update: { name: "auto", address: "auto" },
        phone_number_collection: { enabled: true },
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: EVENT_CURRENCY,
              unit_amount: parsed.depositCents,
              product_data: {
                name: "Private event deposit — AMARÉ",
                description: `${parsed.eventDate} ${parsed.eventTime} · ${parsed.room} · ${parsed.guests} guests`,
                metadata: { flow: "event_deposit", reservationId: id },
              },
            },
          },
        ],
        automatic_tax: { enabled: false },
        success_url: successUrl,
        cancel_url: cancelUrl,
        client_reference_id: id,
        metadata,
        payment_intent_data: {
          setup_future_usage: "off_session",
          metadata,
        },
      };

  try {
    const session = await stripe.checkout.sessions.create(params, {
      idempotencyKey: eventCheckoutIdempotencyKey(id, checkoutGeneration, depositAlreadyPaid),
    });
    if (!session.url) {
      return jsonResponse(502, { ok: false, error: "missing_checkout_url" });
    }
    await store.patch(id, {
      stripeCustomerId: customerId,
      stripeCheckoutSessionId: session.id,
      ...(depositAlreadyPaid ? {} : { status: "deposit_pending" }),
    });
    await store.indexSession(session.id, id);
    const checkoutLabel = depositAlreadyPaid
      ? `Checkout started — balance ${formatUsd(balanceDueCents)}`
      : `Checkout started — deposit ${formatUsd(parsed.depositCents)}`;
    await appendReservationActivity(store, id, {
      kind: "checkout_started",
      label: checkoutLabel,
      amountCents: depositAlreadyPaid ? balanceDueCents : parsed.depositCents,
      offerId: offer?.id,
    });
    console.log(
      JSON.stringify({
        event: "event_deposit_checkout_created",
        reservationId: id,
        sessionId: session.id,
        remainingCents: parsed.remainingCents,
        room: parsed.room,
        guests: parsed.guests,
      }),
    );
    return jsonResponse(200, { ok: true, url: session.url, reservationId: id });
  } catch (e) {
    console.error(
      JSON.stringify({
        event: "event_deposit_checkout_failed",
        reservationId: id,
        detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 240),
      }),
    );
    return jsonResponse(502, {
      ok: false,
      error: "stripe_checkout_failed",
      message: "Could not open payment. Please try again.",
    });
  }
}
