/**
 * POST /api/stripe/deferred-book/confirm-email
 *
 * Success-page fallback for AMARÉ Book/checkout.
 *
 * Auth is provider-neutral via resolveStudioCustomer:
 *   Email OTP linked — amare_sess → linked Studio client
 *   Mindbody — mb_sess → Studio client
 *   Dual mismatch — 409
 *
 * Reservation Confirmation (cancel + rebook with SendEmail:true) is a
 * Mindbody Consumer-specific template. Staff tokens return 200 but only
 * emit purchase Receipt emails. That Consumer step is isolated below.
 * AMARÉ-linked buyers are not required to have mb_sess merely to confirm
 * the booking belongs to them.
 */

import { jsonResponse } from "./mindbody-consumer-lib.mjs";
import { resolveStudioCustomer } from "./amare-studio-lib.mjs";
import {
  resolveStaffAuthHeaders,
} from "./mindbody-class-book-lib.mjs";
import { sendDeferredBookReservationEmail } from "./mindbody-deferred-class-book.mjs";
import { isDeferredBookEligibleCta } from "./mindbody-pending-book-intent-lib.mjs";
import { openOrderStore } from "./stripe-order-store.mjs";

/**
 * @param {"amare" | "mindbody" | string | null | undefined} authSource
 * @param {boolean} hasConsumerHeaders
 */
export function deferredBookConfirmPlan(authSource, hasConsumerHeaders) {
  if (authSource === "mindbody" || (authSource === "amare" && hasConsumerHeaders)) {
    return { path: "consumer_reservation_email" };
  }
  if (authSource === "amare") {
    return {
      path: "skip_consumer_template",
      reason: "reservation_confirmation_is_mindbody_consumer_specific",
    };
  }
  return { path: "unauthenticated" };
}

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

  const ctx = await resolveStudioCustomer(event);
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

  const consumerHeaders =
    ctx.authSource === "mindbody"
      ? ctx.authHeaders
      : ctx.consumerCtx && ctx.consumerCtx.authHeaders
        ? ctx.consumerCtx.authHeaders
        : null;
  const plan = deferredBookConfirmPlan(ctx.authSource, Boolean(consumerHeaders));

  if (plan.path === "skip_consumer_template") {
    const already = order.deferredBook && order.deferredBook.mindbodyConfirmationEmailSent === true;
    console.log(
      JSON.stringify({
        event: "deferred_class_book_confirmation_email_skipped_consumer_template",
        orderId,
        clientId: ctx.clientId,
        authSource: ctx.authSource,
        reason: plan.reason,
      }),
    );
    return jsonResponse(200, {
      ok: true,
      mindbodyConfirmationEmailSent: already === true,
      confirmationEmail: "skipped_consumer_template",
      reason: plan.reason,
      authSource: ctx.authSource,
      noop: already === true,
    });
  }

  const staffHeaders = await resolveStaffAuthHeaders();
  if (!staffHeaders) {
    return jsonResponse(503, { ok: false, error: "staff_auth_unavailable" });
  }

  const emailRes = await sendDeferredBookReservationEmail({
    order,
    clientId: ctx.clientId,
    consumerHeaders,
    staffHeaders,
  });

  if (emailRes.noop) {
    return jsonResponse(200, { ok: true, noop: true, mindbodyConfirmationEmailSent: true, authSource: ctx.authSource });
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
      authSource: ctx.authSource,
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
  if (ctx.setCookie) extra["Set-Cookie"] = ctx.setCookie;

  return jsonResponse(200, { ok: true, mindbodyConfirmationEmailSent: true, authSource: ctx.authSource }, extra);
}
