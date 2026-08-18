/**
 * One-time Stripe → Mindbody side-effect runner.
 *
 * `claimInvoiceSlot` already serializes recurring `invoice.paid` before Mindbody.
 * This module is the equivalent for one-time CheckoutShoppingCart:
 *
 *   1. Atomically claim the paid order (ORDER-scoped, not Stripe event id).
 *   2. Only the winner may call `syncOneTimePurchaseToMindbody`.
 *   3. Success → `mindbody_synced` via CAS.
 *   4. Uncertain post-request outcomes → `mindbody_sync_unknown` (no auto retry).
 *   5. Clear pre-request failures → release claim so a later delivery may retry.
 *
 * Reconciliation audit (2026-08-17): CheckoutShoppingCart PayNotes include
 * `orderId` + Stripe session id, but Mindbody Public API has no indexed lookup
 * by those notes. Client-purchase scans by clientId + ServiceId + price + time
 * are heuristic and can collide with a legitimate second purchase.
 * CAN AUTOMATICALLY RECONCILE UNKNOWN: NO. Admin attaches a sale id.
 */

import { syncOneTimePurchaseToMindbody } from "./stripe-mindbody-sync-lib.mjs";

/**
 * Failures that occur before CheckoutShoppingCart is POSTed. Safe to release
 * the claim and allow a later retry.
 */
export const PRE_REQUEST_SYNC_REASONS = new Set([
  "invalid_payment_mode_env",
  "missing_payment_method_id",
  "staff_credentials_not_configured",
  "staff_headers_unavailable",
  "staff_token_issue_timeout",
  "mindbody_service_id_unresolved",
  "non_usd_currency",
  "invalid_amount",
  "invalid_paid_amount",
  "stripe_amount_arithmetic_mismatch",
]);

/**
 * @param {string | undefined} reason
 */
export function isPreRequestSyncFailure(reason) {
  return typeof reason === "string" && PRE_REQUEST_SYNC_REASONS.has(reason);
}

/**
 * @param {string | undefined} reason
 */
export function isUncertainPostRequestFailure(reason) {
  return reason === "mindbody_sync_timeout";
}

/**
 * @param {{
 *   store: ReturnType<import("./stripe-order-store.mjs").openOrderStore>;
 *   orderId: string;
 *   stripeCheckoutSessionId?: string;
 *   localSku: string;
 *   clientId: number;
 *   amountCents: number;
 *   paidAmountCents?: number;
 *   discountAmountCents?: number;
 *   promotionCode?: string;
 *   couponId?: string;
 *   currency: string;
 *   mindbodyTest?: boolean;
 *   item: import("./stripe-catalog-lib.mjs").CatalogItem;
 *   stripeEventId?: string;
 *   syncFn?: typeof syncOneTimePurchaseToMindbody;
 *   crashAfterMindbodySuccess?: boolean;
 * }} input
 * @returns {Promise<{
 *   ok: boolean;
 *   status: string;
 *   noop?: boolean;
 *   reason?: string;
 *   retryable?: boolean;
 *   claimOutcome?: string;
 *   attemptId?: string;
 *   mindbodySaleId?: string | null;
 * }>}
 */
export async function fulfillOneTimeMindbodySale(input) {
  const store = input.store;
  const syncFn = input.syncFn || syncOneTimePurchaseToMindbody;
  const claim = await store.claimOneTimeFulfillment(input.orderId, {
    stripeEventId: input.stripeEventId,
  });
  if (!claim.ok) {
    return { ok: false, status: "claim_store_unavailable", reason: claim.reason, retryable: true };
  }
  if (claim.outcome !== "CLAIMED") {
    console.log(
      JSON.stringify({
        event: "stripe_order_fulfillment_dedup",
        orderId: input.orderId,
        outcome: claim.outcome,
        stripeEventId: input.stripeEventId || null,
      }),
    );
    if (
      claim.outcome === "IN_PROGRESS" &&
      !(claim.record && claim.record.fulfillmentRequestSentAt)
    ) {
      return {
        ok: false,
        status: "mindbody_sync_claimed",
        reason: "claim_in_progress_pre_send",
        retryable: true,
        noop: true,
        claimOutcome: claim.outcome,
      };
    }
    return {
      ok: true,
      status:
        claim.outcome === "ALREADY_SYNCED"
          ? "mindbody_synced"
          : claim.outcome === "UNKNOWN"
            ? "mindbody_sync_unknown"
            : claim.outcome === "NOT_ELIGIBLE"
              ? claim.record?.mindbodySyncStatus || "not_eligible"
              : "mindbody_sync_claimed",
      noop: true,
      claimOutcome: claim.outcome,
    };
  }

  const attemptId = claim.attemptId;
  const marked = await store.markOneTimeFulfillmentRequestSent(
    input.orderId,
    attemptId,
    claim.etag && claim.record ? { record: claim.record, etag: claim.etag } : undefined,
  );
  if (!marked.ok) {
    console.warn(
      JSON.stringify({
        event: "stripe_order_fulfillment_mark_sent_failed",
        orderId: input.orderId,
        attemptId,
        reason: marked.reason,
      }),
    );
    if (marked.reason === "already_synced") {
      return { ok: true, status: "mindbody_synced", noop: true, claimOutcome: "ALREADY_SYNCED", attemptId };
    }
    if (marked.reason === "unknown") {
      return {
        ok: true,
        status: "mindbody_sync_unknown",
        noop: true,
        claimOutcome: "UNKNOWN",
        attemptId,
        reason: marked.reason,
      };
    }
    await store.releaseOneTimeFulfillmentClaim(
      input.orderId,
      attemptId,
      "sync_failed_retryable",
      {
        errorCode: "fulfillment_mark_sent_failed",
        errorMessageSafe: `Pre-cart claim CAS failed (${marked.reason}). Safe to retry.`,
      },
      claim.etag && claim.record ? { record: claim.record, etag: claim.etag } : undefined,
    );
    return {
      ok: false,
      status: "sync_failed_retryable",
      noop: false,
      claimOutcome: "CLAIMED",
      attemptId,
      reason: marked.reason || "mark_sent_failed",
      retryable: true,
    };
  }
  const markedExpected =
    marked.etag && marked.record ? { record: marked.record, etag: marked.etag } : undefined;

  /** @type {Awaited<ReturnType<typeof syncOneTimePurchaseToMindbody>>} */
  let sync;
  try {
    sync = await syncFn({
      orderId: input.orderId,
      stripeCheckoutSessionId: input.stripeCheckoutSessionId || "",
      localSku: input.localSku,
      clientId: input.clientId,
      amountCents: input.amountCents,
      paidAmountCents: input.paidAmountCents,
      discountAmountCents: input.discountAmountCents,
      promotionCode: input.promotionCode,
      couponId: input.couponId,
      currency: input.currency,
      mindbodyTest: input.mindbodyTest === true,
      item: input.item,
    });
  } catch (e) {
    const message = String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 240);
    const unknown = await store.markOneTimeFulfillmentUnknown(
      input.orderId,
      attemptId,
      "sync_threw",
      message,
      markedExpected,
    );
    console.error(
      JSON.stringify({
        event: "stripe_order_fulfillment_sync_threw",
        orderId: input.orderId,
        attemptId,
        detail: message,
      }),
    );
    return {
      ok: unknown.ok,
      status:
        unknown.ok && unknown.outcome === "ALREADY_SYNCED"
          ? "mindbody_synced"
          : unknown.ok
            ? "mindbody_sync_unknown"
            : "mindbody_sync_claimed",
      noop: false,
      claimOutcome: "CLAIMED",
      attemptId,
      reason: unknown.ok ? "sync_threw" : `unknown_transition_failed_${unknown.reason}`,
      ...(!unknown.ok ? { retryable: true } : {}),
    };
  }

  if (sync.ok) {
    if (input.crashAfterMindbodySuccess === true) {
      return {
        ok: true,
        status: "mindbody_sync_claimed",
        noop: false,
        claimOutcome: "CLAIMED",
        attemptId,
        mindbodySaleId: sync.mindbodySaleId ?? null,
        reason: "crash_after_mindbody_success",
      };
    }
    const done = await store.completeOneTimeFulfillment(
      input.orderId,
      attemptId,
      {
        mindbodySaleId: sync.mindbodySaleId ?? null,
        mindbodyTransactionId: sync.mindbodyTransactionId ?? null,
        mindbodyResponseSummary: sync.responseSummary ?? null,
        mindbodyPaymentMode: sync.mode ?? null,
        resolvedMindbodyClientId: input.clientId,
      },
      markedExpected,
    );
    if (!done.ok) {
      const unknown = await store.markOneTimeFulfillmentUnknown(
        input.orderId,
        attemptId,
        "complete_failed",
        done.reason,
        markedExpected,
      );
      if (!unknown.ok) {
        return {
          ok: false,
          status: "mindbody_sync_claimed",
          noop: false,
          claimOutcome: "CLAIMED",
          attemptId,
          mindbodySaleId: sync.mindbodySaleId ?? null,
          reason: `completion_state_unresolved_${unknown.reason}`,
          retryable: true,
        };
      }
      return {
        ok: true,
        status:
          unknown.outcome === "ALREADY_SYNCED" ? "mindbody_synced" : "mindbody_sync_unknown",
        noop: false,
        claimOutcome: "CLAIMED",
        attemptId,
        mindbodySaleId: sync.mindbodySaleId ?? null,
        reason: done.reason,
      };
    }
    return {
      ok: true,
      status: "mindbody_synced",
      noop: false,
      claimOutcome: "CLAIMED",
      attemptId,
      mindbodySaleId: sync.mindbodySaleId ?? null,
    };
  }

  if (isUncertainPostRequestFailure(sync.reason) || sync.retryable === true && !isPreRequestSyncFailure(sync.reason)) {
    const unknown = await store.markOneTimeFulfillmentUnknown(
      input.orderId,
      attemptId,
      sync.reason || "mindbody_sync_uncertain",
      sync.message,
      markedExpected,
    );
    return {
      ok: unknown.ok,
      status:
        unknown.ok && unknown.outcome === "ALREADY_SYNCED"
          ? "mindbody_synced"
          : unknown.ok
            ? "mindbody_sync_unknown"
            : "mindbody_sync_claimed",
      noop: false,
      claimOutcome: "CLAIMED",
      attemptId,
      reason: unknown.ok ? sync.reason : `unknown_transition_failed_${unknown.reason}`,
      ...(!unknown.ok ? { retryable: true } : {}),
    };
  }

  if (isPreRequestSyncFailure(sync.reason)) {
    const nextStatus = sync.retryable ? "sync_failed_retryable" : "paid_but_not_synced";
    await store.releaseOneTimeFulfillmentClaim(
      input.orderId,
      attemptId,
      nextStatus,
      {
        errorCode: sync.reason,
        errorMessageSafe: (sync.message || sync.reason || "").slice(0, 480),
      },
      markedExpected,
    );
    return {
      ok: sync.retryable ? false : true,
      status: nextStatus,
      noop: false,
      claimOutcome: "CLAIMED",
      attemptId,
      reason: sync.reason,
      retryable: !!sync.retryable,
    };
  }

  await store.releaseOneTimeFulfillmentClaim(input.orderId, attemptId, "paid_but_not_synced", {
    errorCode: sync.reason,
    errorMessageSafe: (sync.message || sync.reason || "").slice(0, 480),
  });
  return {
    ok: true,
    status: "paid_but_not_synced",
    noop: false,
    claimOutcome: "CLAIMED",
    attemptId,
    reason: sync.reason,
  };
}
