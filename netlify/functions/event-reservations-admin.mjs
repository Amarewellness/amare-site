/**
 * Admin API for private-event reservations.
 * GET  /api/admin/events/list
 * GET  /api/admin/events/forms
 * POST /api/admin/events/manual
 * POST /api/admin/events/offers
 * POST /api/admin/events/confirm
 * POST /api/admin/events/charge-overtime
 * POST /api/admin/events/charge-custom
 * POST /api/admin/events/charge-remaining
 * POST /api/admin/events/cancel
 * POST /api/admin/events/reschedule
 * POST /api/admin/events/update
 * POST /api/admin/events/send-details
 * POST /api/admin/events/send-booking
 */

import { randomUUID } from "node:crypto";
import Stripe from "stripe";

import { adminAuthorized, adminCorsHeaders } from "./new-client-sms-admin-auth.mjs";
import {
  EVENT_CONSENT_TEXT,
  EVENT_CURRENCY,
  EVENT_DEPOSIT_CENTS,
  EVENT_DEPOSIT_MIN_CENTS,
  EVENT_OVERTIME_BLOCK_CENTS,
  EVENT_PACKAGE_CENTS,
  EVENT_PACKAGE_MAX_CENTS,
  EVENT_PACKAGE_MIN_CENTS,
  eventSafeStr,
  formatUsd,
  parseEventCustomCharge,
  parseEventOvertimeMinutes,
  parseEventUsdToCents,
  parseGuestCount,
  resolveEventRoom,
  stylingCentsForRoom,
  todayEtYmd,
  validateEventDateTime,
  eventStaffNotes,
  parseEventScheduleInput,
  parseEventCleaningCents,
  reservationDepositPaid,
} from "./event-booking-lib.mjs";
import { chargeSavedEventCard } from "./event-reservation-charge.mjs";
import {
  sendEventConfirmedEmail,
  sendEventCustomChargeEmail,
  sendEventOvertimeEmail,
  sendEventCanceledEmail,
  sendEventRemainingChargeEmail,
  sendEventRescheduledEmail,
  sendEventOfferEmail,
  sendEventDetailsEmail,
  sendEventReservationDetailsEmail,
} from "./event-reservation-emails.mjs";
import { fetchNetlifyEventInquiries } from "./event-inquiry-netlify.mjs";
import { inquiryFingerprint, openEventInquiryStore } from "./event-inquiry-store.mjs";
import {
  defaultOfferExpiryIso,
  newEventOfferId,
  offerIsOpen,
  openEventOfferStore,
} from "./event-offer-store.mjs";
import { newEventReservationId, openEventReservationStore } from "./event-reservation-store.mjs";

/** @param {number} status @param {unknown} body @param {Record<string, string>} [extra] */
function adminJson(status, body, extra = {}) {
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...adminCorsHeaders(extra),
    },
    body: JSON.stringify(body),
  };
}

/** @param {import("@netlify/functions").HandlerEvent} event */
function parseJsonBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** @param {import("@netlify/functions").HandlerEvent} event */
function adminPath(event) {
  const fwd = event.headers["x-forwarded-uri"] || event.headers["X-Forwarded-Uri"];
  if (typeof fwd === "string" && fwd.includes("/api/admin/events")) {
    return fwd.split("?")[0].replace(/\/+$/, "");
  }
  const raw = event.rawUrl || event.path || "";
  const path = raw.includes("://") ? new URL(raw).pathname : String(raw).split("?")[0];
  return path.replace(/\/+$/, "") || "/api/admin/events";
}

function stripeSecret() {
  const k = (process.env.STRIPE_SECRET_KEY || "").trim();
  if (!k.startsWith("sk_")) return null;
  return k;
}

/**
 * @param {import("./event-reservation-store.mjs").EventReservation} rec
 * @param {string} today
 */
function toAdminRow(rec, today) {
  const paid =
    rec.status === "deposit_paid_pending_confirm" || rec.status === "confirmed";
  return {
    id: rec.id,
    status: rec.status,
    firstName: rec.firstName,
    lastName: rec.lastName,
    email: rec.email,
    phone: rec.phone || "",
    eventDate: rec.eventDate,
    eventTime: rec.eventTime,
    guests: rec.guests,
    room: rec.room,
    styling: rec.styling === true,
    staffNotes: rec.staffNotes || "",
    packageCents: rec.packageCents,
    depositCents: rec.depositCents,
    stylingCents: rec.stylingCents,
    remainingCents: rec.remainingCents,
    overtimeCentsTotal: rec.overtimeCentsTotal || 0,
    overtimeCharges: Array.isArray(rec.overtimeCharges) ? rec.overtimeCharges : [],
    customCentsTotal: rec.customCentsTotal || 0,
    customCharges: Array.isArray(rec.customCharges) ? rec.customCharges : [],
    extrasCentsTotal: (rec.overtimeCentsTotal || 0) + (rec.customCentsTotal || 0),
    cleaningCents: rec.cleaningCents || 0,
    schedule: rec.schedule || null,
    remainingPaid: rec.remainingPaid === true,
    depositPaid: reservationDepositPaid(rec),
    manualEntry: rec.manualEntry === true,
    emailsSent: rec.emailsSent === true,
    confirmEmailSent: rec.confirmEmailSent === true,
    paidOnline: !!rec.stripeCheckoutSessionId,
    remainingPaidAt: rec.remainingPaidAt || "",
    currency: rec.currency || "usd",
    stripeLivemode: rec.stripeLivemode === true,
    confirmedAt: rec.confirmedAt || "",
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    whenBucket: rec.eventDate >= today ? "upcoming" : "past",
    canConfirm: rec.status === "deposit_paid_pending_confirm",
    canChargeOvertime: paid && !!rec.stripeCustomerId,
    canChargeRemaining:
      rec.status === "confirmed" &&
      rec.remainingPaid !== true &&
      (rec.remainingCents || 0) > 0 &&
      !!rec.stripeCustomerId,
    canCancel: rec.status === "deposit_paid_pending_confirm" || rec.status === "confirmed",
    canReschedule: rec.status === "deposit_paid_pending_confirm" || rec.status === "confirmed",
    canSendDetails:
      rec.status !== "canceled" && rec.status !== "expired" && String(rec.email || "").includes("@"),
    canSendBooking:
      rec.status !== "canceled" &&
      rec.status !== "expired" &&
      rec.remainingPaid !== true &&
      !reservationDepositPaid(rec) &&
      Number(rec.depositCents) >= EVENT_DEPOSIT_MIN_CENTS &&
      String(rec.email || "").includes("@"),
    bookingLinkSent: !!rec.offerId || !!rec.bookingLinkSentAt,
    offerId: rec.offerId || "",
    canEdit: rec.status !== "expired",
    canEditPricing: rec.remainingPaid !== true,
    canEditDeposit: rec.remainingPaid !== true && (rec.manualEntry === true || !rec.stripeCheckoutSessionId),
    canEditDepositPaid: rec.remainingPaid !== true && rec.manualEntry === true && !rec.stripeCheckoutSessionId,
    canEditRemainingPaid: rec.manualEntry === true && !rec.remainingStripeInvoiceId,
  };
}

/** @param {import("./event-reservation-store.mjs").EventReservation[]} rows */
function summaryFrom(rows) {
  /** @type {Record<string, number>} */
  const byStatus = {};
  let upcoming = 0;
  let needsConfirm = 0;
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    if (r.eventDate >= todayEtYmd()) upcoming += 1;
    if (r.status === "deposit_paid_pending_confirm") needsConfirm += 1;
  }
  return { total: rows.length, upcoming, needsConfirm, byStatus };
}

async function adminHandler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: adminCorsHeaders(), body: "" };
  }
  if (!adminAuthorized(event)) {
    return adminJson(401, { ok: false, error: "unauthorized" });
  }

  const path = adminPath(event);

  if (path.endsWith("/forms") && event.httpMethod === "GET") {
    const inquiryStore = openEventInquiryStore(event);
    const saved = inquiryStore.available ? await inquiryStore.list({ limit: 200 }) : [];
    const netlify = await fetchNetlifyEventInquiries();
    /** @type {Map<string, import("./event-inquiry-store.mjs").EventInquiry>} */
    const byFp = new Map();
    for (const row of netlify.rows) byFp.set(inquiryFingerprint(row), row);
    for (const row of saved) byFp.set(inquiryFingerprint(row), row);
    const forms = Array.from(byFp.values()).sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    const offerStore = openEventOfferStore(event);
    const offers = offerStore.available ? await offerStore.list({ limit: 300 }) : [];
    const withOffers = forms.map((row) => {
      const matches = offers
        .filter(
          (o) =>
            (row.id && o.inquiryId === row.id) ||
            (row.email && o.email && String(o.email).toLowerCase() === String(row.email).toLowerCase()),
        )
        .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
      const latest = matches[0];
      return {
        ...row,
        offer: latest
          ? {
              id: latest.id,
              status: offerIsOpen(latest) ? latest.status : latest.status === "used" ? "used" : "expired",
              firstName: latest.firstName,
              lastName: latest.lastName,
              email: latest.email,
              phone: latest.phone,
              eventDate: latest.eventDate,
              eventTime: latest.eventTime,
              guests: latest.guests || 0,
              room: latest.room || "auto",
              lockDateTime: latest.lockDateTime === true,
              lockGuestsRoom: latest.lockGuestsRoom === true,
              lockName: latest.lockName === true,
              lockEmail: latest.lockEmail === true,
              lockPhone: latest.lockPhone === true,
              packageCents: latest.packageCents,
              depositCents: latest.depositCents,
              cleaningCents: latest.cleaningCents || 0,
              schedule: latest.schedule || null,
              lastSentKind: latest.lastSentKind || "",
              sentDetailsAt: latest.sentDetailsAt || "",
              sentBookAt: latest.sentBookAt || "",
              sentAt: latest.sentAt || latest.createdAt,
            }
          : null,
      };
    });
    return adminJson(200, {
      ok: true,
      forms: withOffers,
      summary: { total: withOffers.length, site: saved.length, netlify: netlify.rows.length },
      netlifySource: netlify.source,
      netlifyError: netlify.error || "",
    });
  }

  if (path.endsWith("/offers") && event.httpMethod === "POST") {
    const body = parseJsonBody(event);
    if (body == null) return adminJson(400, { ok: false, error: "invalid_json" });
    const firstName = eventSafeStr(body.firstName, 80);
    const lastName = eventSafeStr(body.lastName, 80);
    const email = eventSafeStr(body.email, 254).toLowerCase();
    const phone = eventSafeStr(body.phone, 32);
    const inquiryId = eventSafeStr(body.inquiryId, 80);
    if (!email.includes("@")) {
      return adminJson(400, { ok: false, error: "invalid_email", message: "Enter a valid email." });
    }
    const whenOk = validateEventDateTime(body.eventDate, body.eventTime, { allowPast: true });
    if (!whenOk.ok) return adminJson(400, { ok: false, error: whenOk.error, message: whenOk.message });
    const packageParsed = parseEventUsdToCents(
      body.packageUsd != null ? body.packageUsd : EVENT_PACKAGE_CENTS / 100,
      EVENT_PACKAGE_MIN_CENTS,
      EVENT_PACKAGE_MAX_CENTS,
    );
    if (!packageParsed.ok) {
      return adminJson(400, { ok: false, error: packageParsed.error, message: `Package: ${packageParsed.message}` });
    }
    const depositParsed = parseEventUsdToCents(
      body.depositUsd != null ? body.depositUsd : EVENT_DEPOSIT_CENTS / 100,
      EVENT_DEPOSIT_MIN_CENTS,
      packageParsed.cents,
    );
    if (!depositParsed.ok) {
      return adminJson(400, {
        ok: false,
        error: depositParsed.error,
        message: `Deposit: ${depositParsed.message}`,
      });
    }
    const scheduleParsed = parseEventScheduleInput(body);
    if (!scheduleParsed.ok) {
      return adminJson(400, { ok: false, error: scheduleParsed.error, message: scheduleParsed.message });
    }
    const cleaningParsed = parseEventCleaningCents(body.cleaningUsd, body.addCleaning === true);
    if (!cleaningParsed.ok) {
      return adminJson(400, { ok: false, error: cleaningParsed.error, message: cleaningParsed.message });
    }
    const lockGuestsRoom = body.lockGuestsRoom === true;
    const roomWanted = eventSafeStr(body.room, 16) || "auto";
    let guests = 0;
    let room = roomWanted;
    const guestsRaw = body.guests;
    const guestsFilled = guestsRaw !== "" && guestsRaw != null;
    if (lockGuestsRoom && !guestsFilled) {
      return adminJson(400, { ok: false, error: "invalid_guests", message: "Enter a guest count to lock guests and room." });
    }
    if (guestsFilled) {
      const guestsParsed = parseGuestCount(guestsRaw);
      if (!guestsParsed.ok) {
        return adminJson(400, { ok: false, error: "invalid_guests", message: "Guest count must be between 1 and 17." });
      }
      guests = guestsParsed.guests;
      const roomOk = resolveEventRoom(guests, roomWanted);
      if (!roomOk.ok) return adminJson(400, { ok: false, error: roomOk.error, message: roomOk.message });
      room = roomWanted === "auto" ? "auto" : roomOk.room;
    }
    const offerStore = openEventOfferStore(event);
    if (!offerStore.available) {
      return adminJson(503, { ok: false, error: "store_unavailable" });
    }
    const kind = body.kind === "details" ? "details" : "book";
    const existing = await offerStore.list({ limit: 300 });
    const now = new Date().toISOString();
    /** @type {import("./event-offer-store.mjs").EventOffer | null} */
    let prevOpen = null;
    for (const prev of existing) {
      if (prev.status !== "sent") continue;
      const sameInquiry = inquiryId && prev.inquiryId === inquiryId;
      if (!sameInquiry) continue;
      if (offerIsOpen(prev) && (!prevOpen || String(prev.sentAt || prev.createdAt) > String(prevOpen.sentAt || prevOpen.createdAt))) {
        prevOpen = prev;
      }
    }
    for (const prev of existing) {
      if (prev.status !== "sent") continue;
      const sameInquiry = inquiryId && prev.inquiryId === inquiryId;
      if (sameInquiry && prev.id !== prevOpen?.id) await offerStore.put({ ...prev, status: "superseded" });
    }
    const offer = {
      id: prevOpen?.id || newEventOfferId(),
      inquiryId: inquiryId || undefined,
      firstName,
      lastName,
      email,
      phone,
      eventDate: whenOk.eventDate,
      eventTime: whenOk.eventTime,
      lockDateTime: body.lockDateTime !== false,
      lockName: body.allowEditName === false,
      lockEmail: body.allowEditEmail === false,
      lockPhone: body.allowEditPhone === false,
      guests: guests || undefined,
      room: guests || roomWanted !== "auto" ? room : undefined,
      lockGuestsRoom: lockGuestsRoom,
      packageCents: packageParsed.cents,
      depositCents: depositParsed.cents,
      cleaningCents: cleaningParsed.cents || undefined,
      schedule: scheduleParsed.schedule,
      lastSentKind: /** @type {const} */ (kind),
      sentDetailsAt: kind === "details" ? now : prevOpen?.sentDetailsAt,
      sentBookAt: kind === "book" ? now : prevOpen?.sentBookAt,
      status: /** @type {const} */ ("sent"),
      expiresAt: defaultOfferExpiryIso(),
      createdAt: prevOpen?.createdAt || now,
      sentAt: now,
    };
    const wr = await offerStore.put(offer);
    if (!wr.ok) return adminJson(500, { ok: false, error: "save_failed" });
    const headers = event.headers || {};
    const origin = String(headers.origin || headers.Origin || "").trim().replace(/\/$/, "");
    const host = String(headers["x-forwarded-host"] || headers["X-Forwarded-Host"] || headers.host || headers.Host || "")
      .split(",")[0]
      .trim();
    const proto = String(headers["x-forwarded-proto"] || headers["X-Forwarded-Proto"] || "https").split(",")[0].trim();
    const fromHost = host ? `${proto}://${host}`.replace(/\/$/, "") : "";
    const prod = (process.env.SITE_URL || "https://www.amarewellness.com").replace(/\/$/, "");
    const isProd = (u) => /^(https?:\/\/)?(www\.)?amarewellness\.com$/i.test(String(u || "").replace(/\/$/, ""));
    const site = origin && !isProd(origin) ? origin : fromHost && !isProd(fromHost) ? fromHost : prod;
    const offerUrl =
      kind === "book"
        ? `${site}/event-info?o=${encodeURIComponent(offer.id)}&book=1`
        : `${site}/event-info?o=${encodeURIComponent(offer.id)}`;
    let emailOk = false;
    let emailError = "";
    if (body.sendEmail !== false) {
      const mail =
        kind === "details" ? await sendEventDetailsEmail(offer, offerUrl) : await sendEventOfferEmail(offer, offerUrl);
      emailOk = mail.ok === true;
      emailError = mail.ok ? "" : String(mail.error || "email_failed");
    }
    return adminJson(200, {
      ok: true,
      kind,
      offer: { id: offer.id, eventDate: offer.eventDate, eventTime: offer.eventTime, status: offer.status },
      url: offerUrl,
      emailOk,
      emailError,
    });
  }

  const store = openEventReservationStore(event);
  if (!store.available) {
    return adminJson(503, { ok: false, error: "store_unavailable" });
  }

  if (path.endsWith("/manual") && event.httpMethod === "POST") {
    const body = parseJsonBody(event);
    if (body == null) return adminJson(400, { ok: false, error: "invalid_json" });
    const firstName = eventSafeStr(body.firstName, 80);
    const lastName = eventSafeStr(body.lastName, 80);
    const email = eventSafeStr(body.email, 254).toLowerCase();
    const phone = eventSafeStr(body.phone, 32);
    if (!firstName || !lastName) {
      return adminJson(400, { ok: false, error: "invalid_name", message: "First and last name are required." });
    }
    if (!email || !email.includes("@")) {
      return adminJson(400, { ok: false, error: "invalid_email", message: "A valid email is required." });
    }
    const whenOk = validateEventDateTime(body.eventDate, body.eventTime, { allowPast: true });
    if (!whenOk.ok) return adminJson(400, { ok: false, error: whenOk.error, message: whenOk.message });
    const guestsParsed = parseGuestCount(body.guests);
    if (!guestsParsed.ok) {
      return adminJson(400, { ok: false, error: "invalid_guests", message: "Guest count must be between 1 and 17." });
    }
    const roomOk = resolveEventRoom(guestsParsed.guests, eventSafeStr(body.room, 16) || "auto");
    if (!roomOk.ok) return adminJson(400, { ok: false, error: roomOk.error, message: roomOk.message });
    const packageParsed = parseEventUsdToCents(
      body.packageUsd != null ? body.packageUsd : EVENT_PACKAGE_CENTS / 100,
      EVENT_PACKAGE_MIN_CENTS,
      EVENT_PACKAGE_MAX_CENTS,
    );
    if (!packageParsed.ok) {
      return adminJson(400, { ok: false, error: packageParsed.error, message: `Package: ${packageParsed.message}` });
    }
    const depositParsed = parseEventUsdToCents(
      body.depositUsd != null ? body.depositUsd : EVENT_DEPOSIT_CENTS / 100,
      0,
      packageParsed.cents,
    );
    if (!depositParsed.ok) {
      return adminJson(400, { ok: false, error: depositParsed.error, message: `Deposit: ${depositParsed.message}` });
    }
    const scheduleParsed = parseEventScheduleInput(body);
    if (!scheduleParsed.ok) {
      return adminJson(400, { ok: false, error: scheduleParsed.error, message: scheduleParsed.message });
    }
    const cleaningParsed = parseEventCleaningCents(body.cleaningUsd, body.addCleaning === true);
    if (!cleaningParsed.ok) {
      return adminJson(400, { ok: false, error: cleaningParsed.error, message: cleaningParsed.message });
    }
    const styling = body.styling === true;
    const stylingCents = stylingCentsForRoom(roomOk.room, styling);
    const remainingCents = packageParsed.cents + stylingCents + cleaningParsed.cents - depositParsed.cents;
    if (remainingCents < 0) {
      return adminJson(400, { ok: false, error: "invalid_remaining", message: "Deposit cannot exceed package + styling + cleaning." });
    }
    const status = body.needsConfirm === true ? "deposit_paid_pending_confirm" : "confirmed";
    const remainingPaid = body.remainingPaid === true;
    const staffNotes = eventStaffNotes(body.staffNotes ?? body.notes);
    const now = new Date().toISOString();
    const rec = {
      id: newEventReservationId(),
      status: /** @type {const} */ (status),
      firstName,
      lastName,
      email,
      phone,
      eventDate: whenOk.eventDate,
      eventTime: whenOk.eventTime,
      guests: guestsParsed.guests,
      room: roomOk.room,
      styling,
      packageCents: packageParsed.cents,
      depositCents: depositParsed.cents,
      stylingCents,
      remainingCents,
      overtimeBlockCents: EVENT_OVERTIME_BLOCK_CENTS,
      overtimeCentsTotal: 0,
      overtimeCharges: [],
      customCentsTotal: 0,
      customCharges: [],
      currency: EVENT_CURRENCY,
      consentText: EVENT_CONSENT_TEXT,
      consentAcceptedAt: now,
      emailsSent: false,
      confirmEmailSent: false,
      confirmedAt: status === "confirmed" ? now : undefined,
      remainingPaid,
      remainingPaidAt: remainingPaid ? now : undefined,
      depositPaid: depositParsed.cents > 0 && body.depositPaid === true,
      staffNotes: staffNotes || undefined,
      cleaningCents: cleaningParsed.cents || 0,
      schedule: scheduleParsed.schedule,
      manualEntry: true,
      createdAt: now,
      updatedAt: now,
    };
    const wr = await store.put(rec, { onlyIfNew: true });
    if (!wr.ok) return adminJson(500, { ok: false, error: "save_failed" });
    let emailOk = false;
    let emailError = "";
    if (body.sendEmail === true && status === "confirmed") {
      const mail = await sendEventConfirmedEmail(rec);
      emailOk = mail.ok === true;
      emailError = mail.ok ? "" : String(mail.error || "email_failed");
      if (emailOk) await store.patch(rec.id, { confirmEmailSent: true, emailsSent: true });
    }
    return adminJson(200, {
      ok: true,
      reservation: toAdminRow((await store.get(rec.id)) || rec, todayEtYmd()),
      emailOk,
      emailError,
    });
  }

  if (path.endsWith("/list") && event.httpMethod === "GET") {
    const records = await store.list({ limit: 200 });
    const today = todayEtYmd();
    const rows = records
      .map((r) => toAdminRow(r, today))
      .sort((a, b) => {
        const whenA = `${a.eventDate}T${a.eventTime || "00:00"}`;
        const whenB = `${b.eventDate}T${b.eventTime || "00:00"}`;
        if (a.whenBucket !== b.whenBucket) return a.whenBucket === "upcoming" ? -1 : 1;
        return a.whenBucket === "upcoming" ? whenA.localeCompare(whenB) : whenB.localeCompare(whenA);
      });
    return adminJson(200, { ok: true, today, summary: summaryFrom(records), reservations: rows });
  }

  if (path.endsWith("/confirm") && event.httpMethod === "POST") {
    const body = parseJsonBody(event);
    if (body == null) return adminJson(400, { ok: false, error: "invalid_json" });
    const id = String(body.id || "").trim();
    if (!id) return adminJson(400, { ok: false, error: "missing_id" });
    const rec = await store.get(id);
    if (!rec) return adminJson(404, { ok: false, error: "not_found" });
    if (rec.status === "confirmed") {
      return adminJson(200, { ok: true, reservation: toAdminRow(rec, todayEtYmd()), noop: true });
    }
    if (rec.status !== "deposit_paid_pending_confirm") {
      return adminJson(409, {
        ok: false,
        error: "not_confirmable",
        message: `Cannot confirm a reservation in status ${rec.status}.`,
      });
    }
    const confirmedAt = new Date().toISOString();
    await store.patch(id, { status: "confirmed", confirmedAt });
    const latest = (await store.get(id)) || { ...rec, status: "confirmed", confirmedAt };
    if (!latest.confirmEmailSent) {
      const mail = await sendEventConfirmedEmail(latest);
      console.log(
        JSON.stringify({
          event: "event_confirmed_email",
          reservationId: latest.id,
          ok: mail.ok === true,
          error: mail.ok ? undefined : mail.error,
        }),
      );
      await store.patch(id, { confirmEmailSent: true });
    }
    const after = (await store.get(id)) || latest;
    return adminJson(200, { ok: true, reservation: toAdminRow(after, todayEtYmd()) });
  }

  if (path.endsWith("/charge-overtime") && event.httpMethod === "POST") {
    const body = parseJsonBody(event);
    if (body == null) return adminJson(400, { ok: false, error: "invalid_json" });
    const id = String(body.id || "").trim();
    const parsedMinutes = parseEventOvertimeMinutes(body.minutes);
    if (!id) return adminJson(400, { ok: false, error: "missing_id" });
    if (!parsedMinutes.ok) {
      return adminJson(400, { ok: false, error: parsedMinutes.error, message: parsedMinutes.message });
    }
    const minutes = parsedMinutes.minutes;
    const rec = await store.get(id);
    if (!rec) return adminJson(404, { ok: false, error: "not_found" });
    if (rec.status !== "deposit_paid_pending_confirm" && rec.status !== "confirmed") {
      return adminJson(409, {
        ok: false,
        error: "not_chargeable",
        message: "Overtime can only be charged after the deposit is paid.",
      });
    }
    const sk = stripeSecret();
    if (!sk) return adminJson(503, { ok: false, error: "stripe_unconfigured" });

    const cents = parsedMinutes.cents;
    const chargeId = `ot_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const stripe = new Stripe(sk, {
      apiVersion: "2025-08-27.basil",
      appInfo: { name: "amare-event-overtime", version: "0.1.0" },
    });
    const charged = await chargeSavedEventCard(stripe, rec, {
      amountCents: cents,
      description: `AMARÉ private event overtime +${minutes} min — ${rec.firstName} ${rec.lastName}`,
      metadata: {
        flow: "event_overtime",
        reservationId: rec.id,
        minutes: String(minutes),
        chargeId,
      },
      idempotencyKey: `evt-${chargeId}`,
    });
    if (!charged.ok) {
      const status = charged.error === "stripe_charge_failed" ? 402 : 400;
      return adminJson(status, charged);
    }

    const entry = {
      id: chargeId,
      minutes,
      cents,
      stripeInvoiceId: charged.invoiceId,
      stripePaymentIntentId: charged.paymentIntentId,
      chargedAt: new Date().toISOString(),
      status: "paid",
    };
    const prev = Array.isArray(rec.overtimeCharges) ? rec.overtimeCharges : [];
    const overtimeCentsTotal = (rec.overtimeCentsTotal || 0) + cents;
    await store.patch(id, {
      overtimeCharges: [...prev, entry],
      overtimeCentsTotal,
    });
    const latest = (await store.get(id)) || rec;
    const mail = await sendEventOvertimeEmail(latest, { minutes, cents });
    console.log(
      JSON.stringify({
        event: "event_overtime_charged",
        reservationId: rec.id,
        minutes,
        cents,
        invoiceId: charged.invoiceId,
        emailOk: mail.ok === true,
      }),
    );
    return adminJson(200, {
      ok: true,
      charged: { minutes, cents, formatted: formatUsd(cents), invoiceId: charged.invoiceId },
      reservation: toAdminRow(latest, todayEtYmd()),
    });
  }

  if (path.endsWith("/charge-custom") && event.httpMethod === "POST") {
    const body = parseJsonBody(event);
    if (body == null) return adminJson(400, { ok: false, error: "invalid_json" });
    const id = String(body.id || "").trim();
    const parsed = parseEventCustomCharge(body.amountUsd ?? body.amount, body.description);
    if (!id) return adminJson(400, { ok: false, error: "missing_id" });
    if (!parsed.ok) {
      return adminJson(400, { ok: false, error: parsed.error, message: parsed.message });
    }
    const rec = await store.get(id);
    if (!rec) return adminJson(404, { ok: false, error: "not_found" });
    if (rec.status !== "deposit_paid_pending_confirm" && rec.status !== "confirmed") {
      return adminJson(409, {
        ok: false,
        error: "not_chargeable",
        message: "Extra charges can only be taken after the deposit is paid.",
      });
    }
    const sk = stripeSecret();
    if (!sk) return adminJson(503, { ok: false, error: "stripe_unconfigured" });

    const chargeId = `oc_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const stripe = new Stripe(sk, {
      apiVersion: "2025-08-27.basil",
      appInfo: { name: "amare-event-custom-charge", version: "0.1.0" },
    });
    const charged = await chargeSavedEventCard(stripe, rec, {
      amountCents: parsed.cents,
      description: `AMARÉ private event — ${parsed.description} — ${rec.firstName} ${rec.lastName}`,
      metadata: {
        flow: "event_custom_charge",
        reservationId: rec.id,
        description: parsed.description.slice(0, 80),
        chargeId,
      },
      idempotencyKey: `evt-${chargeId}`,
    });
    if (!charged.ok) {
      const status = charged.error === "stripe_charge_failed" ? 402 : 400;
      return adminJson(status, charged);
    }

    const entry = {
      id: chargeId,
      description: parsed.description,
      cents: parsed.cents,
      stripeInvoiceId: charged.invoiceId,
      stripePaymentIntentId: charged.paymentIntentId,
      chargedAt: new Date().toISOString(),
      status: "paid",
    };
    const prev = Array.isArray(rec.customCharges) ? rec.customCharges : [];
    const customCentsTotal = (rec.customCentsTotal || 0) + parsed.cents;
    await store.patch(id, {
      customCharges: [...prev, entry],
      customCentsTotal,
    });
    const latest = (await store.get(id)) || rec;
    const mail = await sendEventCustomChargeEmail(latest, {
      description: parsed.description,
      cents: parsed.cents,
    });
    console.log(
      JSON.stringify({
        event: "event_custom_charged",
        reservationId: rec.id,
        cents: parsed.cents,
        invoiceId: charged.invoiceId,
        emailOk: mail.ok === true,
      }),
    );
    return adminJson(200, {
      ok: true,
      charged: {
        description: parsed.description,
        cents: parsed.cents,
        formatted: formatUsd(parsed.cents),
        invoiceId: charged.invoiceId,
      },
      reservation: toAdminRow(latest, todayEtYmd()),
    });
  }

  if (path.endsWith("/charge-remaining") && event.httpMethod === "POST") {
    const body = parseJsonBody(event);
    if (body == null) return adminJson(400, { ok: false, error: "invalid_json" });
    const id = String(body.id || "").trim();
    if (!id) return adminJson(400, { ok: false, error: "missing_id" });
    const rec = await store.get(id);
    if (!rec) return adminJson(404, { ok: false, error: "not_found" });
    if (rec.remainingPaid === true) {
      return adminJson(200, { ok: true, noop: true, reservation: toAdminRow(rec, todayEtYmd()) });
    }
    if (rec.status !== "confirmed") {
      return adminJson(409, {
        ok: false,
        error: "not_confirmed",
        message: "Confirm the date before charging the remaining balance.",
      });
    }
    const cents = Number(rec.remainingCents) || 0;
    if (cents < 50) {
      return adminJson(400, { ok: false, error: "nothing_due", message: "No remaining balance to charge." });
    }
    const sk = stripeSecret();
    if (!sk) return adminJson(503, { ok: false, error: "stripe_unconfigured" });

    const chargeId = `rb_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const stripe = new Stripe(sk, {
      apiVersion: "2025-08-27.basil",
      appInfo: { name: "amare-event-remaining", version: "0.1.0" },
    });
    const charged = await chargeSavedEventCard(stripe, rec, {
      amountCents: cents,
      description: `AMARÉ private event remaining balance — ${rec.firstName} ${rec.lastName}`,
      metadata: {
        flow: "event_remaining",
        reservationId: rec.id,
        chargeId,
      },
      idempotencyKey: `evt-${chargeId}`,
    });
    if (!charged.ok) {
      const status = charged.error === "stripe_charge_failed" ? 402 : 400;
      return adminJson(status, charged);
    }

    const remainingPaidAt = new Date().toISOString();
    await store.patch(id, {
      remainingPaid: true,
      remainingPaidAt,
      remainingStripeInvoiceId: charged.invoiceId,
    });
    const latest = (await store.get(id)) || rec;
    const mail = await sendEventRemainingChargeEmail(latest);
    console.log(
      JSON.stringify({
        event: "event_remaining_charged",
        reservationId: rec.id,
        cents,
        invoiceId: charged.invoiceId,
        emailOk: mail.ok === true,
      }),
    );
    return adminJson(200, {
      ok: true,
      charged: { cents, formatted: formatUsd(cents), invoiceId: charged.invoiceId },
      reservation: toAdminRow(latest, todayEtYmd()),
    });
  }

  if (path.endsWith("/cancel") && event.httpMethod === "POST") {
    const body = parseJsonBody(event);
    if (body == null) return adminJson(400, { ok: false, error: "invalid_json" });
    const id = String(body.id || "").trim();
    const note = eventSafeStr(body.note, 200);
    if (!id) return adminJson(400, { ok: false, error: "missing_id" });
    const rec = await store.get(id);
    if (!rec) return adminJson(404, { ok: false, error: "not_found" });
    if (rec.status === "canceled") {
      return adminJson(200, { ok: true, noop: true, reservation: toAdminRow(rec, todayEtYmd()) });
    }
    if (rec.status !== "deposit_paid_pending_confirm" && rec.status !== "confirmed") {
      return adminJson(409, {
        ok: false,
        error: "not_cancelable",
        message: "Only a paid reservation can be canceled here.",
      });
    }
    const sendEmail = body.sendEmail !== false;
    const canceledAt = new Date().toISOString();
    await store.patch(id, { status: "canceled", canceledAt, cancelNote: note || undefined });
    const latest = (await store.get(id)) || { ...rec, status: "canceled", canceledAt, cancelNote: note };
    let emailOk = false;
    if (sendEmail) {
      const mail = await sendEventCanceledEmail(latest, note);
      emailOk = mail.ok === true;
    }
    console.log(
      JSON.stringify({
        event: "event_canceled",
        reservationId: rec.id,
        sendEmail,
        emailOk,
      }),
    );
    return adminJson(200, { ok: true, emailOk, reservation: toAdminRow(latest, todayEtYmd()) });
  }

  if (path.endsWith("/reschedule") && event.httpMethod === "POST") {
    const body = parseJsonBody(event);
    if (body == null) return adminJson(400, { ok: false, error: "invalid_json" });
    const id = String(body.id || "").trim();
    if (!id) return adminJson(400, { ok: false, error: "missing_id" });
    const whenOk = validateEventDateTime(body.eventDate, body.eventTime);
    if (!whenOk.ok) {
      return adminJson(400, { ok: false, error: whenOk.error, message: whenOk.message });
    }
    const rec = await store.get(id);
    if (!rec) return adminJson(404, { ok: false, error: "not_found" });
    if (rec.status !== "deposit_paid_pending_confirm" && rec.status !== "confirmed") {
      return adminJson(409, {
        ok: false,
        error: "not_reschedulable",
        message: "Only a paid, active reservation can be moved.",
      });
    }
    const prev = { oldDate: rec.eventDate, oldTime: rec.eventTime };
    if (prev.oldDate === whenOk.eventDate && prev.oldTime === whenOk.eventTime) {
      return adminJson(200, { ok: true, noop: true, reservation: toAdminRow(rec, todayEtYmd()) });
    }
    await store.patch(id, {
      eventDate: whenOk.eventDate,
      eventTime: whenOk.eventTime,
      previousEventDate: rec.eventDate,
      previousEventTime: rec.eventTime,
    });
    const latest = (await store.get(id)) || {
      ...rec,
      eventDate: whenOk.eventDate,
      eventTime: whenOk.eventTime,
    };
    const mail = await sendEventRescheduledEmail(latest, prev);
    console.log(
      JSON.stringify({
        event: "event_rescheduled",
        reservationId: rec.id,
        from: `${prev.oldDate} ${prev.oldTime}`,
        to: `${whenOk.eventDate} ${whenOk.eventTime}`,
        emailOk: mail.ok === true,
      }),
    );
    return adminJson(200, { ok: true, reservation: toAdminRow(latest, todayEtYmd()) });
  }

  if (path.endsWith("/update") && event.httpMethod === "POST") {
    const body = parseJsonBody(event);
    if (body == null) return adminJson(400, { ok: false, error: "invalid_json" });
    const id = String(body.id || "").trim();
    if (!id) return adminJson(400, { ok: false, error: "missing_id" });
    const rec = await store.get(id);
    if (!rec) return adminJson(404, { ok: false, error: "not_found" });
    if (rec.status === "expired") {
      return adminJson(409, { ok: false, error: "not_editable", message: "Expired reservations cannot be edited." });
    }
    const firstName = eventSafeStr(body.firstName, 80);
    const lastName = eventSafeStr(body.lastName, 80);
    const email = eventSafeStr(body.email, 254).toLowerCase();
    const phone = eventSafeStr(body.phone, 32);
    if (!firstName || !lastName) {
      return adminJson(400, { ok: false, error: "invalid_name", message: "First and last name are required." });
    }
    if (!email || !email.includes("@")) {
      return adminJson(400, { ok: false, error: "invalid_email", message: "A valid email is required." });
    }
    const whenOk = validateEventDateTime(body.eventDate, body.eventTime, { allowPast: true });
    if (!whenOk.ok) return adminJson(400, { ok: false, error: whenOk.error, message: whenOk.message });
    const guestsParsed = parseGuestCount(body.guests);
    if (!guestsParsed.ok) {
      return adminJson(400, { ok: false, error: "invalid_guests", message: "Guest count must be between 1 and 17." });
    }
    const roomOk = resolveEventRoom(guestsParsed.guests, eventSafeStr(body.room, 16) || rec.room || "auto");
    if (!roomOk.ok) return adminJson(400, { ok: false, error: roomOk.error, message: roomOk.message });

    const pricingLocked = rec.remainingPaid === true;
    const depositLocked = pricingLocked || (rec.manualEntry !== true && !!rec.stripeCheckoutSessionId);
    let packageCents = rec.packageCents;
    let depositCents = rec.depositCents;
    let styling = rec.styling === true;
    if (!pricingLocked) {
      const packageParsed = parseEventUsdToCents(
        body.packageUsd != null ? body.packageUsd : rec.packageCents / 100,
        EVENT_PACKAGE_MIN_CENTS,
        EVENT_PACKAGE_MAX_CENTS,
      );
      if (!packageParsed.ok) {
        return adminJson(400, { ok: false, error: packageParsed.error, message: `Package: ${packageParsed.message}` });
      }
      packageCents = packageParsed.cents;
      styling = body.styling === true;
    }
    if (!depositLocked) {
      const depositParsed = parseEventUsdToCents(
        body.depositUsd != null ? body.depositUsd : rec.depositCents / 100,
        0,
        packageCents,
      );
      if (!depositParsed.ok) {
        return adminJson(400, { ok: false, error: depositParsed.error, message: `Deposit: ${depositParsed.message}` });
      }
      depositCents = depositParsed.cents;
    }
    const stylingCents = pricingLocked ? rec.stylingCents : stylingCentsForRoom(roomOk.room, styling);
    const scheduleParsed = parseEventScheduleInput(body);
    if (!scheduleParsed.ok) {
      return adminJson(400, { ok: false, error: scheduleParsed.error, message: scheduleParsed.message });
    }
    let cleaningCents = rec.cleaningCents || 0;
    if (!pricingLocked) {
      const cleaningParsed = parseEventCleaningCents(body.cleaningUsd, body.addCleaning === true);
      if (!cleaningParsed.ok) {
        return adminJson(400, { ok: false, error: cleaningParsed.error, message: cleaningParsed.message });
      }
      cleaningCents = cleaningParsed.cents;
    }
    const remainingCents = pricingLocked
      ? rec.remainingCents
      : packageCents + stylingCents + cleaningCents - depositCents;
    if (remainingCents < 0) {
      return adminJson(400, { ok: false, error: "invalid_remaining", message: "Deposit cannot exceed package + styling + cleaning." });
    }

    let remainingPaid = rec.remainingPaid === true;
    let remainingPaidAt = rec.remainingPaidAt || "";
    const canTogglePaid = rec.manualEntry === true && !rec.remainingStripeInvoiceId;
    if (canTogglePaid && Object.prototype.hasOwnProperty.call(body, "remainingPaid")) {
      remainingPaid = body.remainingPaid === true;
      if (remainingPaid && !remainingPaidAt) remainingPaidAt = new Date().toISOString();
      if (!remainingPaid) remainingPaidAt = "";
    }
    const staffNotes = eventStaffNotes(body.staffNotes ?? body.notes);
    let depositPaid = reservationDepositPaid({ ...rec, depositCents, remainingPaid });
    const canToggleDepositPaid = rec.manualEntry === true && !rec.stripeCheckoutSessionId && !remainingPaid;
    if (canToggleDepositPaid && Object.prototype.hasOwnProperty.call(body, "depositPaid")) {
      depositPaid = depositCents > 0 && body.depositPaid === true;
    }
    if (remainingPaid) depositPaid = depositCents > 0;
    if (depositCents <= 0) depositPaid = false;

    await store.patch(id, {
      firstName,
      lastName,
      email,
      phone,
      eventDate: whenOk.eventDate,
      eventTime: whenOk.eventTime,
      guests: guestsParsed.guests,
      room: roomOk.room,
      styling,
      packageCents,
      depositCents,
      stylingCents,
      remainingCents,
      remainingPaid,
      remainingPaidAt: remainingPaidAt || undefined,
      depositPaid,
      staffNotes,
      cleaningCents,
      schedule: scheduleParsed.schedule,
    });
    const latest = (await store.get(id)) || rec;
    console.log(
      JSON.stringify({
        event: "event_reservation_updated",
        reservationId: rec.id,
        emailed: false,
      }),
    );
    return adminJson(200, { ok: true, reservation: toAdminRow(latest, todayEtYmd()) });
  }

  if (path.endsWith("/send-details") && event.httpMethod === "POST") {
    const body = parseJsonBody(event);
    if (body == null) return adminJson(400, { ok: false, error: "invalid_json" });
    const id = String(body.id || "").trim();
    if (!id) return adminJson(400, { ok: false, error: "missing_id" });
    const rec = await store.get(id);
    if (!rec) return adminJson(404, { ok: false, error: "not_found" });
    if (rec.status === "canceled" || rec.status === "expired") {
      return adminJson(409, {
        ok: false,
        error: "not_sendable",
        message: "This reservation cannot receive event details.",
      });
    }
    if (!String(rec.email || "").includes("@")) {
      return adminJson(400, { ok: false, error: "invalid_email", message: "This reservation needs a valid email." });
    }
    const mail = await sendEventReservationDetailsEmail(rec);
    if (mail.ok === true) {
      await store.patch(id, { emailsSent: true });
    }
    console.log(
      JSON.stringify({
        event: "event_details_sent",
        reservationId: rec.id,
        emailOk: mail.ok === true,
      }),
    );
    return adminJson(200, {
      ok: true,
      emailOk: mail.ok === true,
      emailError: mail.ok ? "" : String(mail.error || "email_failed"),
      reservation: toAdminRow((await store.get(id)) || rec, todayEtYmd()),
    });
  }

  if (path.endsWith("/send-booking") && event.httpMethod === "POST") {
    const body = parseJsonBody(event);
    if (body == null) return adminJson(400, { ok: false, error: "invalid_json" });
    const id = String(body.id || "").trim();
    if (!id) return adminJson(400, { ok: false, error: "missing_id" });
    const rec = await store.get(id);
    if (!rec) return adminJson(404, { ok: false, error: "not_found" });
    if (rec.status === "canceled" || rec.status === "expired") {
      return adminJson(409, {
        ok: false,
        error: "not_sendable",
        message: "This reservation cannot receive a booking link.",
      });
    }
    if (rec.remainingPaid === true || reservationDepositPaid(rec)) {
      return adminJson(409, {
        ok: false,
        error: "already_paid",
        message: "This reservation already has a paid deposit.",
      });
    }
    if (!String(rec.email || "").includes("@")) {
      return adminJson(400, { ok: false, error: "invalid_email", message: "This reservation needs a valid email." });
    }
    if (!Number(rec.depositCents) || rec.depositCents < EVENT_DEPOSIT_MIN_CENTS) {
      return adminJson(400, {
        ok: false,
        error: "invalid_deposit",
        message: "Set a deposit of at least $1.00 before sending a booking link.",
      });
    }
    const whenOk = validateEventDateTime(rec.eventDate, rec.eventTime, { allowPast: true });
    if (!whenOk.ok) {
      return adminJson(400, { ok: false, error: whenOk.error, message: whenOk.message });
    }
    const offerStore = openEventOfferStore(event);
    if (!offerStore.available) {
      return adminJson(503, { ok: false, error: "store_unavailable" });
    }
    const existingOffers = await offerStore.list({ limit: 300 });
    const now = new Date().toISOString();
    /** @type {import("./event-offer-store.mjs").EventOffer | null} */
    let prevOpen = null;
    for (const prev of existingOffers) {
      if (prev.status !== "sent") continue;
      if (prev.reservationId !== rec.id) continue;
      if (offerIsOpen(prev) && (!prevOpen || String(prev.sentAt || prev.createdAt) > String(prevOpen.sentAt || prevOpen.createdAt))) {
        prevOpen = prev;
      }
    }
    for (const prev of existingOffers) {
      if (prev.status !== "sent") continue;
      if (prev.reservationId === rec.id && prev.id !== prevOpen?.id) {
        await offerStore.put({ ...prev, status: "superseded" });
      }
    }
    const offer = {
      id: prevOpen?.id || rec.offerId || newEventOfferId(),
      reservationId: rec.id,
      firstName: rec.firstName,
      lastName: rec.lastName,
      email: rec.email,
      phone: rec.phone || "",
      eventDate: rec.eventDate,
      eventTime: rec.eventTime,
      lockDateTime: true,
      lockName: false,
      lockEmail: false,
      lockPhone: false,
      guests: rec.guests,
      room: rec.room,
      lockGuestsRoom: true,
      packageCents: rec.packageCents,
      depositCents: rec.depositCents,
      cleaningCents: rec.cleaningCents || undefined,
      schedule: rec.schedule,
      lastSentKind: /** @type {const} */ ("book"),
      sentBookAt: now,
      sentDetailsAt: prevOpen?.sentDetailsAt,
      status: /** @type {const} */ ("sent"),
      expiresAt: defaultOfferExpiryIso(),
      createdAt: prevOpen?.createdAt || now,
      sentAt: now,
    };
    const wr = await offerStore.put(offer);
    if (!wr.ok) return adminJson(500, { ok: false, error: "save_failed" });
    await store.patch(id, { offerId: offer.id, bookingLinkSentAt: now });
    const headers = event.headers || {};
    const origin = String(headers.origin || headers.Origin || "").trim().replace(/\/$/, "");
    const host = String(headers["x-forwarded-host"] || headers["X-Forwarded-Host"] || headers.host || headers.Host || "")
      .split(",")[0]
      .trim();
    const proto = String(headers["x-forwarded-proto"] || headers["X-Forwarded-Proto"] || "https").split(",")[0].trim();
    const fromHost = host ? `${proto}://${host}`.replace(/\/$/, "") : "";
    const prod = (process.env.SITE_URL || "https://www.amarewellness.com").replace(/\/$/, "");
    const isProd = (u) => /^(https?:\/\/)?(www\.)?amarewellness\.com$/i.test(String(u || "").replace(/\/$/, ""));
    const site = origin && !isProd(origin) ? origin : fromHost && !isProd(fromHost) ? fromHost : prod;
    const url = `${site}/event-info?o=${encodeURIComponent(offer.id)}&book=1`;
    let emailOk = false;
    let emailError = "";
    if (body.sendEmail !== false) {
      const mail = await sendEventOfferEmail(offer, url);
      emailOk = mail.ok === true;
      emailError = mail.ok ? "" : String(mail.error || "email_failed");
    }
    console.log(
      JSON.stringify({
        event: "event_booking_link_sent",
        reservationId: rec.id,
        offerId: offer.id,
        emailOk,
      }),
    );
    return adminJson(200, {
      ok: true,
      url,
      emailOk,
      emailError,
      reservation: toAdminRow((await store.get(id)) || rec, todayEtYmd()),
    });
  }

  return adminJson(404, { ok: false, error: "not_found" });
}

/** @param {import("@netlify/functions").HandlerEvent} event */
export async function handler(event) {
  try {
    return await adminHandler(event);
  } catch (e) {
    console.error(
      JSON.stringify({
        event: "event_reservations_admin_error",
        detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 240),
      }),
    );
    return adminJson(500, { ok: false, error: "server_error" });
  }
}
