/**
 * POST /api/stripe/deferred-book/confirm-email
 *
 * Success-page fallback: re-book the deferred visit with the buyer's live consumer
 * Mindbody token + SendEmail:true so Mindbody sends Reservation Confirmation (staff
 * token returns 200 but only emits purchase Receipt emails).
 */

import { getSessionWithConsumerHeaders, jsonResponse, resolveConsumerClient } from "./mindbody-consumer-lib.mjs";
import {
  resolveStaffAuthHeaders,
} from "./mindbody-class-book-lib.mjs";
import { sendDeferredBookReservationEmail } from "./mindbody-deferred-class-book.mjs";
import { isDeferredBookEligibleCta } from "./mindbody-pending-book-intent-lib.mjs";
import { openOrderStore } from "./stripe-order-store.mjs";

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: { "Cache-Control": "no-store" }, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" });
  }

  let body = {};
  try {
    body = event.body ? JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body) : {};
  } catch {
    return jsonResponse(400, { ok: false, error: "invalid_json" });
  }

  const orderId = typeof body.orderId === "string" ? body.orderId.trim() : "";
  if (!/^ord_[A-Z0-9]{8,40}$/.test(orderId)) {
    return jsonResponse(400, { ok: false, error: "invalid_order_id" });
  }

  const ctx = await resolveConsumerClient(event);
  if (!ctx.ok) return ctx.response;

  const store = openOrderStore(event);
  if (!store.available) {
    return jsonResponse(503, { ok: false, error: "order_store_unavailable" });
  }

  const order = await store.get(orderId);
  if (!order) return jsonResponse(404, { ok: false, error: "order_not_found" });
  if (!isDeferredBookEligibleCta(order.ctaLocation)) {
    return jsonResponse(400, { ok: false, error: "not_deferred_book_order" });
  }

  const orderClientId =
    typeof order.resolvedMindbodyClientId === "number" && order.resolvedMindbodyClientId > 0
      ? order.resolvedMindbodyClientId
      : typeof order.knownMindbodyClientId === "number" && order.knownMindbodyClientId > 0
        ? order.knownMindbodyClientId
        : null;
  if (orderClientId == null || orderClientId !== ctx.clientId) {
    return jsonResponse(403, { ok: false, error: "order_client_mismatch" });
  }

  const staffHeaders = await resolveStaffAuthHeaders();
  if (!staffHeaders) {
    return jsonResponse(503, { ok: false, error: "staff_auth_unavailable" });
  }

  const emailRes = await sendDeferredBookReservationEmail({
    order,
    clientId: ctx.clientId,
    consumerHeaders: ctx.authHeaders,
    staffHeaders,
  });

  if (emailRes.noop) {
    return jsonResponse(200, { ok: true, noop: true, mindbodyConfirmationEmailSent: true });
  }

  const sent = emailRes.ok && emailRes.mindbodyConfirmationEmail === true;
  const db = order.deferredBook || { status: "booked", attemptCount: 0 };
  await store.patch(orderId, {
    deferredBook: {
      ...db,
      visitId: emailRes.visitId ?? db.visitId,
      mindbodyConfirmationEmailSent: sent,
      confirmationEmailPending: !sent,
      lastAttemptAt: new Date().toISOString(),
    },
  });

  console.log(
    JSON.stringify({
      event: sent
        ? "deferred_class_book_confirmation_email_sent_success_page"
        : "deferred_class_book_confirmation_email_failed_success_page",
      orderId,
      clientId: ctx.clientId,
      reason: emailRes.reason ?? null,
    }),
  );

  if (!sent) {
    return jsonResponse(502, {
      ok: false,
      error: "confirmation_email_failed",
      reason: emailRes.reason ?? null,
    });
  }

  const extra = {};
  const sess = await getSessionWithConsumerHeaders(event);
  if (sess.ok && sess.setCookie) extra["Set-Cookie"] = sess.setCookie;

  return jsonResponse(200, { ok: true, mindbodyConfirmationEmailSent: true }, extra);
}
