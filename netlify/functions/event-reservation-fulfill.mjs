/**
 * Stripe webhook fulfillment for private-event deposits.
 * Saves the card as the customer default and emails client + admin.
 */

import { sendEventDepositEmails } from "./event-reservation-emails.mjs";
import { openEventOfferStore } from "./event-offer-store.mjs";
import { openEventReservationStore } from "./event-reservation-store.mjs";

/**
 * @param {import("stripe").default} stripe
 * @param {import("stripe").Stripe.Checkout.Session} session
 * @param {unknown} lambdaEvent
 */
export async function fulfillEventDepositSession(stripe, session, lambdaEvent, deps = {}) {
  const reservationId = String(session.metadata?.reservationId || "").trim();
  const store = deps.reservationStore || openEventReservationStore(lambdaEvent);
  if (!store.available) {
    return { ok: false, retryable: true, error: "store_unavailable" };
  }

  let rec = reservationId ? await store.get(reservationId) : null;
  if (!rec) rec = await store.getByCheckoutSessionId(session.id);
  if (!rec) {
    console.error(
      JSON.stringify({
        event: "event_deposit_reservation_missing",
        sessionId: session.id,
        reservationId: reservationId || null,
      }),
    );
    return { ok: false, retryable: true, error: "reservation_missing" };
  }

  if (rec.status === "deposit_paid_pending_confirm" || rec.status === "confirmed") {
    return { ok: true, noop: true, id: rec.id, status: rec.status };
  }

  const customerId =
    typeof session.customer === "string"
      ? session.customer
      : session.customer && typeof session.customer === "object" && "id" in session.customer
        ? String(session.customer.id)
        : rec.stripeCustomerId || "";

  let paymentIntentId = rec.stripePaymentIntentId || "";
  let paymentMethodId = rec.stripePaymentMethodId || "";
  const piRef = session.payment_intent;
  if (typeof piRef === "string") paymentIntentId = piRef;
  else if (piRef && typeof piRef === "object" && "id" in piRef) paymentIntentId = String(piRef.id);

  if (paymentIntentId) {
    try {
      const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
      const pm = pi.payment_method;
      if (typeof pm === "string") paymentMethodId = pm;
      else if (pm && typeof pm === "object" && "id" in pm) paymentMethodId = String(pm.id);
    } catch (e) {
      console.warn(
        JSON.stringify({
          event: "event_deposit_pi_retrieve_failed",
          reservationId: rec.id,
          detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 200),
        }),
      );
    }
  }

  if (customerId && paymentMethodId) {
    try {
      await stripe.customers.update(customerId, {
        invoice_settings: { default_payment_method: paymentMethodId },
      });
    } catch (e) {
      console.warn(
        JSON.stringify({
          event: "event_deposit_default_pm_failed",
          reservationId: rec.id,
          detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 200),
        }),
      );
    }
  }

  const emailFromStripe =
    session.customer_details && typeof session.customer_details.email === "string"
      ? session.customer_details.email.trim().toLowerCase()
      : "";
  const phoneFromStripe =
    session.customer_details && typeof session.customer_details.phone === "string"
      ? session.customer_details.phone.trim()
      : "";

  await store.patch(rec.id, {
    status: "deposit_paid_pending_confirm",
    stripeCustomerId: customerId || rec.stripeCustomerId,
    stripeCheckoutSessionId: session.id,
    stripePaymentIntentId: paymentIntentId || rec.stripePaymentIntentId,
    stripePaymentMethodId: paymentMethodId || rec.stripePaymentMethodId,
    stripeLivemode: session.livemode === true,
    email: emailFromStripe || rec.email,
    phone: phoneFromStripe || rec.phone,
  });

  const latest = (await store.get(rec.id)) || rec;
  if (!latest.emailsSent) {
    const mail = await (deps.sendDepositEmails || sendEventDepositEmails)(latest);
    console.log(
      JSON.stringify({
        event: "event_deposit_emails",
        reservationId: latest.id,
        clientOk: mail.client?.ok === true,
        adminOk: mail.admin?.ok === true,
        adminError: mail.admin?.ok ? undefined : mail.admin?.error,
      }),
    );
    await store.patch(rec.id, { emailsSent: true });
  }

  const offerId = String(latest.offerId || session.metadata?.offerId || "").trim();
  if (offerId) {
    try {
      const offerStore = deps.offerStore || openEventOfferStore(lambdaEvent);
      if (offerStore.available) {
        const offer = await offerStore.get(offerId);
        if (offer && offer.status === "sent") {
          await offerStore.put({ ...offer, status: "used", reservationId: rec.id });
        }
      }
    } catch {
      /* deposit already paid — don't fail fulfillment */
    }
  }

  console.log(
    JSON.stringify({
      event: "event_deposit_paid",
      reservationId: rec.id,
      sessionId: session.id,
      remainingCents: rec.remainingCents,
      room: rec.room,
      guests: rec.guests,
    }),
  );

  return { ok: true, noop: false, id: rec.id, status: "deposit_paid_pending_confirm" };
}

/**
 * @param {import("stripe").Stripe.Checkout.Session} session
 * @param {unknown} lambdaEvent
 */
export async function expireEventDepositSession(session, lambdaEvent) {
  const store = openEventReservationStore(lambdaEvent);
  if (!store.available) return { ok: false };
  const reservationId = String(session.metadata?.reservationId || "").trim();
  let rec = reservationId ? await store.get(reservationId) : null;
  if (!rec) rec = await store.getByCheckoutSessionId(session.id);
  if (!rec || rec.status !== "deposit_pending") return { ok: true, noop: true };
  await store.patch(rec.id, { status: "expired" });
  return { ok: true, noop: false, id: rec.id };
}

/** @param {import("stripe").Stripe.Checkout.Session | null | undefined} session */
export function isEventDepositSession(session) {
  return !!(session && session.metadata && session.metadata.flow === "event_deposit");
}
