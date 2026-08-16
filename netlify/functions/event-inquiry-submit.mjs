/**
 * POST /api/events/inquiry
 * Public save of the /privateevents inquiry form.
 */

import { jsonResponse } from "./mindbody-consumer-lib.mjs";
import { sendEventInquiryAdminEmail } from "./event-reservation-emails.mjs";
import {
  composeInquiryDate,
  newEventInquiryId,
  openEventInquiryStore,
} from "./event-inquiry-store.mjs";

/** @param {unknown} event */
function parseJsonBody(event) {
  if (!event || typeof event !== "object") return {};
  const e = /** @type {{ body?: unknown; isBase64Encoded?: boolean }} */ (event);
  if (e.body == null || e.body === "") return {};
  const raw = e.isBase64Encoded
    ? Buffer.from(/** @type {string} */ (e.body), "base64").toString("utf8")
    : /** @type {string} */ (e.body);
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** @param {unknown} v @param {number} max */
function clip(v, max) {
  return String(v ?? "").trim().slice(0, max);
}

function looksLikeEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

/** @param {import("@netlify/functions").HandlerEvent} event */
export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type" }, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" });
  }

  const body = parseJsonBody(event);
  if (body == null || typeof body !== "object") {
    return jsonResponse(400, { ok: false, error: "invalid_json" });
  }
  const rec = /** @type {Record<string, unknown>} */ (body);
  if (clip(rec.botField || rec["bot-field"], 80)) {
    return jsonResponse(200, { ok: true, noop: true });
  }

  const email = clip(rec.email, 160).toLowerCase();
  const message = clip(rec.message, 4000);
  if (!looksLikeEmail(email)) {
    return jsonResponse(400, { ok: false, error: "invalid_email", message: "Enter a valid email." });
  }
  if (message.length < 2) {
    return jsonResponse(400, { ok: false, error: "missing_message", message: "Enter a short message." });
  }

  const store = openEventInquiryStore(event);
  if (!store.available) {
    return jsonResponse(503, { ok: false, error: "store_unavailable" });
  }

  const inquiry = {
    id: newEventInquiryId(),
    firstName: clip(rec.firstName || rec.first_name, 80),
    lastName: clip(rec.lastName || rec.last_name, 80),
    email,
    phone: clip(rec.phone, 40),
    eventDate: composeInquiryDate(
      clip(rec.eventYear || rec.event_year, 8),
      clip(rec.eventMonth || rec.event_month, 8),
      clip(rec.eventDay || rec.event_day, 8),
    ),
    eventTime: clip(rec.eventTime || rec.event_time, 8),
    message,
    source: /** @type {const} */ ("site"),
    createdAt: new Date().toISOString(),
  };

  const wr = await store.put(inquiry);
  if (!wr.ok) {
    return jsonResponse(500, { ok: false, error: "save_failed" });
  }

  try {
    const mail = await sendEventInquiryAdminEmail(inquiry);
    console.log(
      JSON.stringify({
        event: "event_inquiry_saved",
        id: inquiry.id,
        emailOk: mail.ok === true,
      }),
    );
  } catch (e) {
    console.warn(
      JSON.stringify({
        event: "event_inquiry_admin_email_failed",
        id: inquiry.id,
        detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 200),
      }),
    );
  }

  return jsonResponse(200, { ok: true, id: inquiry.id });
}
