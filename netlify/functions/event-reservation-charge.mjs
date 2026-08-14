/**
 * Off-session Stripe invoice against a saved event-reservation card.
 * Used for overtime (Phase 2) and remaining balance (Phase 3).
 */

import { EVENT_CURRENCY } from "./event-booking-lib.mjs";

/**
 * @param {import("stripe").default} stripe
 * @param {import("./event-reservation-store.mjs").EventReservation} rec
 * @param {{
 *   amountCents: number,
 *   description: string,
 *   metadata: Record<string, string>,
 *   idempotencyKey: string,
 * }} opts
 * @returns {Promise<
 *   | { ok: true, invoiceId: string, paymentIntentId: string }
 *   | { ok: false, error: string, message: string, code?: string }
 * >}
 */
export async function chargeSavedEventCard(stripe, rec, opts) {
  const customerId = String(rec.stripeCustomerId || "").trim();
  const paymentMethodId = String(rec.stripePaymentMethodId || "").trim();
  if (!customerId) {
    return { ok: false, error: "missing_customer", message: "No saved Stripe customer on this reservation." };
  }
  if (!Number.isFinite(opts.amountCents) || opts.amountCents < 50) {
    return { ok: false, error: "invalid_amount", message: "Charge amount is invalid." };
  }

  if (paymentMethodId) {
    try {
      await stripe.customers.update(customerId, {
        invoice_settings: { default_payment_method: paymentMethodId },
      });
    } catch (e) {
      console.warn(
        JSON.stringify({
          event: "event_charge_default_pm_failed",
          reservationId: rec.id,
          detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 200),
        }),
      );
    }
  }

  let invoiceId = "";
  try {
    const invoice = await stripe.invoices.create(
      {
        customer: customerId,
        auto_advance: false,
        collection_method: "charge_automatically",
        pending_invoice_items_behavior: "exclude",
        description: opts.description,
        metadata: opts.metadata,
      },
      { idempotencyKey: `${opts.idempotencyKey}-inv` },
    );
    invoiceId = invoice.id;

    await stripe.invoiceItems.create(
      {
        customer: customerId,
        invoice: invoice.id,
        amount: opts.amountCents,
        currency: EVENT_CURRENCY,
        description: opts.description,
      },
      { idempotencyKey: `${opts.idempotencyKey}-item` },
    );

    const paid = await stripe.invoices.pay(
      invoice.id,
      { off_session: true },
      { idempotencyKey: `${opts.idempotencyKey}-pay` },
    );

    const piRef = paid.payment_intent;
    const paymentIntentId =
      typeof piRef === "string"
        ? piRef
        : piRef && typeof piRef === "object" && "id" in piRef
          ? String(piRef.id)
          : "";

    if (paid.status !== "paid") {
      return {
        ok: false,
        error: "invoice_unpaid",
        message: `Stripe invoice status is ${paid.status || "unknown"}.`,
      };
    }

    return { ok: true, invoiceId: paid.id, paymentIntentId };
  } catch (e) {
    if (invoiceId) {
      try {
        await stripe.invoices.voidInvoice(invoiceId);
      } catch {
        /* leave open invoice for Stripe Dashboard review */
      }
    }
    const err = /** @type {{ message?: string, code?: string, decline_code?: string }} */ (e);
    const code = String(err.decline_code || err.code || "").trim();
    const message = String(err.message || "Card charge failed.").slice(0, 240);
    return { ok: false, error: "stripe_charge_failed", message, code: code || undefined };
  }
}
