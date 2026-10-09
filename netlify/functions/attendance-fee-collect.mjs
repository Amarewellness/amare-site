/**
 * Orchestration: processing row → Stripe → ledger charged/failed.
 */

import {
  resolveAttendanceFeeCollectionConfig,
  ATTENDANCE_FEE_AMOUNT_CENTS,
  ATTENDANCE_FEE_CURRENCY,
} from "./attendance-fee-config.mjs";
import { openAttendanceFeeStore } from "./attendance-fee-store.mjs";
import { collectAttendanceFeePayment } from "./stripe-attendance-fee-charge.mjs";
import {
  computeAttendanceFeeNextRetryAt,
  shouldConvertAttendanceFeeToPermanentRetry,
} from "./attendance-fee-failure-lib.mjs";

/**
 * @param {import("./attendance-fee-store.mjs").AttendanceFeeRecord} row
 * @param {string | null | undefined} priceId
 */
export function validateAttendanceFeeRowForCollection(row, priceId) {
  if (!row || row.status !== "processing") {
    return { ok: false, failureCode: "invalid_row_status" };
  }
  if (Number(row.amountCents) !== ATTENDANCE_FEE_AMOUNT_CENTS) {
    return { ok: false, failureClass: "permanent", failureCode: "invalid_amount_or_currency" };
  }
  if (String(row.currency) !== ATTENDANCE_FEE_CURRENCY) {
    return { ok: false, failureClass: "permanent", failureCode: "invalid_amount_or_currency" };
  }
  const pid = String(priceId || "").trim();
  if (!pid.startsWith("price_")) {
    return { ok: false, failureClass: "permanent", failureCode: "invalid_price_config" };
  }
  return { ok: true };
}

/**
 * @param {import("./attendance-fee-store.mjs").AttendanceFeeRecord} row
 * @param {{
 *   store: ReturnType<typeof openAttendanceFeeStore>;
 *   stripe: import("stripe").default;
 *   priceId: string;
 *   subscriptionStore?: unknown;
 *   collectPayment?: typeof collectAttendanceFeePayment;
 * }} deps
 */
export async function collectAttendanceFeeForProcessingRow(row, deps) {
  const collectPayment = deps.collectPayment ?? collectAttendanceFeePayment;
  const valid = validateAttendanceFeeRowForCollection(row, deps.priceId);
  if (!valid.ok) {
    const failureClass = valid.failureClass === "retryable" ? "retryable" : "permanent";
    const failureCode = valid.failureCode || "validation_failed";
    const failed = await deps.store.markAttendanceFeeFailed(row.visitId, {
      failureClass,
      failureCode,
      failureMessage: failureCode,
      nextRetryAt: null,
    });
    return {
      outcome: "failed",
      failureClass,
      failureCode,
      record: failed.record,
    };
  }

  const result = await collectPayment(row, {
    stripe: deps.stripe,
    priceId: deps.priceId,
    subscriptionStore: deps.subscriptionStore,
    persistStripeRefs: async (payload) => {
      await deps.store.markAttendanceFeeProcessingStripeRefs(row.visitId, payload);
    },
  });

  if (result.ok) {
    const marked = await deps.store.markAttendanceFeeCharged(row.visitId, {
      stripeCustomerId: result.stripeCustomerId,
      stripeInvoiceId: result.stripeInvoiceId,
      stripePaymentIntentId: result.stripePaymentIntentId,
    });
    return {
      outcome: marked.ok ? "charged" : "charge_mark_failed",
      record: marked.record,
      recovered: result.recovered === true,
    };
  }

  const attemptCount = Number(row.attemptCount) || 1;
  let failureClass = result.failureClass === "retryable" ? "retryable" : "permanent";
  let failureCode = result.failureCode || "charge_failed";
  let failureMessage = result.failureMessage || "Charge failed.";
  let nextRetryAt = null;

  if (failureClass === "retryable") {
    if (shouldConvertAttendanceFeeToPermanentRetry(attemptCount)) {
      failureClass = "permanent";
      failureCode = "max_retries_exceeded";
      failureMessage = "Maximum automatic charge attempts exceeded.";
    } else {
      nextRetryAt = computeAttendanceFeeNextRetryAt(attemptCount);
    }
  }

  const failed = await deps.store.markAttendanceFeeFailed(row.visitId, {
    failureClass,
    failureCode,
    failureMessage,
    nextRetryAt,
  });

  return {
    outcome: "failed",
    failureClass,
    failureCode,
    record: failed.record,
  };
}

/**
 * @param {number} visitId
 * @param {{
 *   store?: ReturnType<typeof openAttendanceFeeStore>;
 *   stripe?: import("stripe").default | null;
 *   subscriptionStore?: unknown;
 *   config?: import("./attendance-fee-config.mjs").AttendanceFeeCollectionConfig;
 *   collectPayment?: typeof collectAttendanceFeePayment;
 *   acquireLock?: boolean;
 * }} [deps]
 */
export async function collectAttendanceFee(visitId, deps = {}) {
  const cfg = resolveAttendanceFeeCollectionConfig(deps.config);
  if (!cfg.enabled || cfg.dryRun) {
    return { outcome: "skipped_config", reason: cfg.enabled ? "dry_run" : "disabled" };
  }
  if (!deps.stripe) {
    return { outcome: "skipped_config", reason: "stripe_unavailable" };
  }

  const store = deps.store ?? openAttendanceFeeStore();
  let row = await store.getAttendanceFeeByVisitId(visitId);

  if (deps.acquireLock !== false) {
    const lock = await store.acquireAttendanceFeeProcessingLock(visitId);
    if (!lock.acquired) {
      return { outcome: "not_acquired", reason: lock.reason, record: lock.record };
    }
    row = lock.record;
  }

  if (!row || row.status !== "processing") {
    return { outcome: "invalid_status", record: row };
  }

  return collectAttendanceFeeForProcessingRow(row, {
    store,
    stripe: deps.stripe,
    priceId: String(cfg.stripePriceId || ""),
    subscriptionStore: deps.subscriptionStore,
    collectPayment: deps.collectPayment,
  });
}
