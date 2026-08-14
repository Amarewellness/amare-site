/**
 * Admin API for private-event reservations.
 * GET  /api/admin/events/list
 * POST /api/admin/events/confirm
 * POST /api/admin/events/charge-overtime
 * POST /api/admin/events/charge-custom
 * POST /api/admin/events/charge-remaining
 * POST /api/admin/events/cancel
 * POST /api/admin/events/reschedule
 */

import { randomUUID } from "node:crypto";
import Stripe from "stripe";

import { adminAuthorized, adminCorsHeaders } from "./new-client-sms-admin-auth.mjs";
import {
  eventSafeStr,
  formatUsd,
  parseEventCustomCharge,
  parseEventOvertimeMinutes,
  todayEtYmd,
  validateEventDateTime,
} from "./event-booking-lib.mjs";
import { chargeSavedEventCard } from "./event-reservation-charge.mjs";
import {
  sendEventConfirmedEmail,
  sendEventCustomChargeEmail,
  sendEventOvertimeEmail,
  sendEventCanceledEmail,
  sendEventRemainingChargeEmail,
  sendEventRescheduledEmail,
} from "./event-reservation-emails.mjs";
import { openEventReservationStore } from "./event-reservation-store.mjs";

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
    packageCents: rec.packageCents,
    depositCents: rec.depositCents,
    stylingCents: rec.stylingCents,
    remainingCents: rec.remainingCents,
    overtimeCentsTotal: rec.overtimeCentsTotal || 0,
    overtimeCharges: Array.isArray(rec.overtimeCharges) ? rec.overtimeCharges : [],
    customCentsTotal: rec.customCentsTotal || 0,
    customCharges: Array.isArray(rec.customCharges) ? rec.customCharges : [],
    extrasCentsTotal: (rec.overtimeCentsTotal || 0) + (rec.customCentsTotal || 0),
    remainingPaid: rec.remainingPaid === true,
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

  const store = openEventReservationStore(event);
  if (!store.available) {
    return adminJson(503, { ok: false, error: "store_unavailable" });
  }

  const path = adminPath(event);

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
    const canceledAt = new Date().toISOString();
    await store.patch(id, { status: "canceled", canceledAt, cancelNote: note || undefined });
    const latest = (await store.get(id)) || { ...rec, status: "canceled", canceledAt, cancelNote: note };
    const mail = await sendEventCanceledEmail(latest, note);
    console.log(
      JSON.stringify({
        event: "event_canceled",
        reservationId: rec.id,
        emailOk: mail.ok === true,
      }),
    );
    return adminJson(200, { ok: true, reservation: toAdminRow(latest, todayEtYmd()) });
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
