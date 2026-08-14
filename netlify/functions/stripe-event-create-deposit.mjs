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
  EVENT_OVERTIME_BLOCK_CENTS,
  EVENT_PACKAGE_CENTS,
  validateEventReservationInput,
} from "./event-booking-lib.mjs";
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

  const body = parseJsonBody(event);
  if (body === null) return jsonResponse(400, { ok: false, error: "invalid_json" });
  const parsed = validateEventReservationInput(body);
  if (!parsed.ok) {
    return jsonResponse(400, { ok: false, error: parsed.error, message: parsed.message });
  }

  const store = openEventReservationStore(event);
  if (!store.available) {
    return jsonResponse(503, {
      ok: false,
      error: "store_unavailable",
      message: "Could not start the reservation. Please try again in a moment.",
    });
  }

  const id = newEventReservationId();
  const now = new Date().toISOString();
  const fullName = `${parsed.firstName} ${parsed.lastName}`.trim();

  /** @type {import("./event-reservation-store.mjs").EventReservation} */
  const record = {
    id,
    status: "deposit_pending",
    firstName: parsed.firstName,
    lastName: parsed.lastName,
    email: parsed.email,
    phone: parsed.phone,
    eventDate: parsed.eventDate,
    eventTime: parsed.eventTime,
    guests: parsed.guests,
    room: parsed.room,
    styling: parsed.styling,
    packageCents: EVENT_PACKAGE_CENTS,
    depositCents: EVENT_DEPOSIT_CENTS,
    stylingCents: parsed.stylingCents,
    remainingCents: parsed.remainingCents,
    overtimeBlockCents: EVENT_OVERTIME_BLOCK_CENTS,
    overtimeCentsTotal: 0,
    overtimeCharges: [],
    customCentsTotal: 0,
    customCharges: [],
    currency: EVENT_CURRENCY,
    consentText: EVENT_CONSENT_TEXT,
    consentAcceptedAt: now,
    consentIp: clientIp(event) || undefined,
    createdAt: now,
    updatedAt: now,
  };

  const put = await store.put(record, { onlyIfNew: true });
  if (!put.ok) {
    return jsonResponse(500, { ok: false, error: "reservation_create_failed" });
  }

  const stripe = new Stripe(sk, {
    apiVersion: "2025-08-27.basil",
    appInfo: { name: "amare-event-deposit", version: "0.1.0" },
  });
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
  const successUrl = `${origin}/event-info?reserved=1&eventId=${encodeURIComponent(id)}`;
  const cancelUrl = `${origin}/event-info?canceled=1`;

  /** @type {Record<string, string>} */
  const metadata = {
    flow: "event_deposit",
    reservationId: id,
    eventDate: parsed.eventDate,
    eventTime: parsed.eventTime,
    guests: String(parsed.guests),
    room: parsed.room,
    styling: parsed.styling ? "1" : "0",
    remainingCents: String(parsed.remainingCents),
    source: "amare_site",
  };

  /** @type {import("stripe").Stripe.Checkout.SessionCreateParams} */
  const params = {
    mode: "payment",
    customer: customerId,
    customer_update: { name: "auto", address: "auto" },
    phone_number_collection: { enabled: true },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: EVENT_CURRENCY,
          unit_amount: EVENT_DEPOSIT_CENTS,
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
      idempotencyKey: `event-deposit-${id}`,
    });
    if (!session.url) {
      return jsonResponse(502, { ok: false, error: "missing_checkout_url" });
    }
    await store.patch(id, {
      stripeCustomerId: customerId,
      stripeCheckoutSessionId: session.id,
    });
    await store.indexSession(session.id, id);
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
