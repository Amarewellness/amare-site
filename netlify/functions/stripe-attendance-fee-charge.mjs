/**
 * Off-session Stripe invoice for a $10 attendance fee (Price-based line item).
 * Does not mutate Postgres — orchestration lives in attendance-fee-collect.mjs.
 */

import { ATTENDANCE_FEE_AMOUNT_CENTS, ATTENDANCE_FEE_CURRENCY } from "./attendance-fee-config.mjs";
import {
  assertStripeCustomerChargeable,
  resolveStripeCustomerForMindbodyClient,
} from "./stripe-customer-for-mindbody-client.mjs";
import {
  attendanceFeeChargeDescription,
  attendanceFeeStripeIdempotencyBase,
  attendanceFeeStripeMetadata,
  classifyAttendanceFeeStripeError,
} from "./attendance-fee-failure-lib.mjs";

/**
 * @param {import("stripe").default} stripe
 * @param {string} invoiceId
 */
async function recoverPaidInvoice(stripe, invoiceId) {
  const id = String(invoiceId || "").trim();
  if (!id.startsWith("in_")) return null;
  try {
    const inv = await stripe.invoices.retrieve(id);
    if (inv.status === "paid") {
      const piRef = inv.payment_intent;
      const paymentIntentId =
        typeof piRef === "string"
          ? piRef
          : piRef && typeof piRef === "object" && "id" in piRef
            ? String(piRef.id)
            : "";
      return {
        ok: true,
        invoiceId: inv.id,
        paymentIntentId,
        stripeCustomerId: typeof inv.customer === "string" ? inv.customer : inv.customer?.id ?? "",
        recovered: true,
      };
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * @param {import("./attendance-fee-store.mjs").AttendanceFeeRecord} row
 * @param {{
 *   stripe: import("stripe").default;
 *   priceId: string;
 *   subscriptionStore?: import("./stripe-customer-for-mindbody-client.mjs").resolveStripeCustomerForMindbodyClient extends Function ? Parameters<typeof resolveStripeCustomerForMindbodyClient>[2]["subscriptionStore"] : unknown;
 *   persistStripeRefs?: (payload: { stripeCustomerId?: string; stripeInvoiceId?: string; stripePaymentIntentId?: string }) => Promise<void>;
 * }} deps
 */
export async function collectAttendanceFeePayment(row, deps) {
  if (!row || row.status !== "processing") {
    return { ok: false, failureCode: "invalid_row_status", failureMessage: "Row is not processing." };
  }
  if (Number(row.amountCents) !== ATTENDANCE_FEE_AMOUNT_CENTS || String(row.currency) !== ATTENDANCE_FEE_CURRENCY) {
    return {
      ok: false,
      failureClass: "permanent",
      failureCode: "invalid_amount_or_currency",
      failureMessage: "Attendance fee amount/currency invariant violated.",
    };
  }

  const priceId = String(deps.priceId || "").trim();
  if (!priceId.startsWith("price_")) {
    return {
      ok: false,
      failureClass: "permanent",
      failureCode: "invalid_price_config",
      failureMessage: "Stripe attendance fee Price ID is not configured.",
    };
  }

  const stripe = deps.stripe;
  const idemBase = attendanceFeeStripeIdempotencyBase(row.visitId);
  const description = attendanceFeeChargeDescription(row.feeType);
  const metadata = attendanceFeeStripeMetadata(row);

  if (row.stripeInvoiceId) {
    const recovered = await recoverPaidInvoice(stripe, row.stripeInvoiceId);
    if (recovered?.ok) {
      return {
        ok: true,
        stripeCustomerId: recovered.stripeCustomerId,
        stripeInvoiceId: recovered.invoiceId,
        stripePaymentIntentId: recovered.paymentIntentId,
        recovered: true,
      };
    }
  }

  const customerRes = await resolveStripeCustomerForMindbodyClient(stripe, row.clientId, {
    subscriptionStore: deps.subscriptionStore,
  });
  if (!customerRes.ok || !customerRes.stripeCustomerId) {
    return {
      ok: false,
      failureClass: "permanent",
      failureCode: "missing_stripe_customer",
      failureMessage: "No existing Stripe customer for this Mindbody client.",
    };
  }

  const chargeable = await assertStripeCustomerChargeable(stripe, customerRes.stripeCustomerId);
  if (!chargeable.ok) {
    return {
      ok: false,
      failureClass: "permanent",
      failureCode: chargeable.code || "customer_not_chargeable",
      failureMessage: chargeable.message || "Customer not chargeable.",
    };
  }

  const customerId = customerRes.stripeCustomerId;
  if (deps.persistStripeRefs) {
    try {
      await deps.persistStripeRefs({ stripeCustomerId: customerId });
    } catch (e) {
      return {
        ok: false,
        failureClass: "retryable",
        failureCode: "ledger_persist_failed",
        failureMessage: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 240),
        stripeCustomerId: customerId,
      };
    }
  }

  let invoiceId = row.stripeInvoiceId ? String(row.stripeInvoiceId) : "";

  try {
    if (!invoiceId) {
      // Stripe replays the same invoice for identical idempotency keys even when our ledger
      // never persisted stripe_invoice_id (e.g. crash after create, before UPDATE).
      const invoice = await stripe.invoices.create(
        {
          customer: customerId,
          auto_advance: false,
          collection_method: "charge_automatically",
          pending_invoice_items_behavior: "exclude",
          description,
          metadata,
        },
        { idempotencyKey: `${idemBase}-invoice` },
      );
      invoiceId = invoice.id;
      if (deps.persistStripeRefs) {
        try {
          await deps.persistStripeRefs({ stripeCustomerId: customerId, stripeInvoiceId: invoiceId });
        } catch (e) {
          return {
            ok: false,
            failureClass: "retryable",
            failureCode: "ledger_persist_failed",
            failureMessage: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 240),
            stripeCustomerId: customerId,
            stripeInvoiceId: invoiceId,
          };
        }
      }
    }

    await stripe.invoiceItems.create(
      {
        customer: customerId,
        invoice: invoiceId,
        pricing: { price: priceId },
        quantity: 1,
        description,
        metadata,
      },
      { idempotencyKey: `${idemBase}-item` },
    );

    const paid = await stripe.invoices.pay(
      invoiceId,
      { off_session: true },
      { idempotencyKey: `${idemBase}-pay` },
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
        failureClass: "permanent",
        failureCode: "invoice_unpaid",
        failureMessage: `Stripe invoice status is ${paid.status || "unknown"}.`,
        stripeCustomerId: customerId,
        stripeInvoiceId: paid.id,
      };
    }

    return {
      ok: true,
      stripeCustomerId: customerId,
      stripeInvoiceId: paid.id,
      stripePaymentIntentId: paymentIntentId,
    };
  } catch (e) {
    if (invoiceId) {
      try {
        const inv = await stripe.invoices.retrieve(invoiceId);
        if (inv.status === "paid") {
          const piRef = inv.payment_intent;
          const paymentIntentId =
            typeof piRef === "string"
              ? piRef
              : piRef && typeof piRef === "object" && "id" in piRef
                ? String(piRef.id)
                : "";
          return {
            ok: true,
            stripeCustomerId: customerId,
            stripeInvoiceId: inv.id,
            stripePaymentIntentId: paymentIntentId,
            recovered: true,
          };
        }
      } catch {
        /* continue to failure mapping */
      }
    }

    const err = /** @type {{ type?: string; code?: string; decline_code?: string; message?: string; statusCode?: number }} */ (
      e
    );
    const classified = classifyAttendanceFeeStripeError(err);
    return {
      ok: false,
      failureClass: classified.failureClass,
      failureCode: classified.failureCode,
      failureMessage: classified.failureMessage,
      stripeCustomerId: customerId,
      stripeInvoiceId: invoiceId || null,
    };
  }
}
