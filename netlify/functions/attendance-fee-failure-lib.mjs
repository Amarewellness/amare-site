/**
 * Attendance fee charge failure classification + retry schedule (code constants).
 */

import {
  ATTENDANCE_FEE_MAX_CHARGE_ATTEMPTS,
  ATTENDANCE_FEE_RETRY_DELAY_MINUTES,
} from "./attendance-fee-config.mjs";

/**
 * @param {number | string} visitId
 */
export function attendanceFeeStripeIdempotencyBase(visitId) {
  return `amare:attendance-fee:v1:${Math.trunc(Number(visitId))}`;
}

/**
 * @param {"late_cancel" | "no_show" | string} feeType
 */
export function attendanceFeeChargeDescription(feeType) {
  if (feeType === "no_show") return "AMARÉ No Show Fee";
  return "AMARÉ Late Cancellation Fee";
}

/**
 * @param {import("./attendance-fee-store.mjs").AttendanceFeeRecord | Record<string, unknown>} row
 */
export function attendanceFeeStripeMetadata(row) {
  return {
    attendanceFee: "true",
    visitId: String(row.visitId ?? row.visit_id ?? ""),
    classId: String(row.classId ?? row.class_id ?? ""),
    mindbodyClientId: String(row.clientId ?? row.client_id ?? ""),
    mindbodyProductId: String(row.mindbodyProductId ?? row.mindbody_product_id ?? ""),
    feeType: String(row.feeType ?? row.fee_type ?? ""),
    triggerSource: String(row.triggerSource ?? row.trigger_source ?? ""),
  };
}

/**
 * @param {{
 *   type?: string;
 *   code?: string;
 *   decline_code?: string;
 *   message?: string;
 *   statusCode?: number;
 *   rawCode?: string;
 * }} err
 */
export function classifyAttendanceFeeStripeError(err) {
  const type = String(err?.type || "").toLowerCase();
  const code = String(err?.code || err?.rawCode || "").toLowerCase();
  const decline = String(err?.decline_code || "").toLowerCase();
  const status = Number(err?.statusCode);
  const message = String(err?.message || "Stripe charge failed.").slice(0, 240);

  if (code === "invalid_price_config" || code === "missing_price_id") {
    return {
      failureClass: "permanent",
      failureCode: "invalid_price_config",
      failureMessage: message,
    };
  }
  if (code === "missing_stripe_customer") {
    return {
      failureClass: "permanent",
      failureCode: "missing_stripe_customer",
      failureMessage: message,
    };
  }
  if (code === "missing_payment_method" || code === "missing_customer") {
    return {
      failureClass: "permanent",
      failureCode: "missing_payment_method",
      failureMessage: message,
    };
  }
  if (code === "customer_not_chargeable") {
    return {
      failureClass: "permanent",
      failureCode: "customer_not_chargeable",
      failureMessage: message,
    };
  }
  if (type === "card_error" || decline || code === "card_declined") {
    return {
      failureClass: "permanent",
      failureCode: decline || code || "card_declined",
      failureMessage: message,
    };
  }
  if (
    code === "authentication_required" ||
    code === "invoice_payment_intent_requires_action" ||
    type === "authentication_error"
  ) {
    return {
      failureClass: "permanent",
      failureCode: "authentication_required",
      failureMessage: message,
    };
  }
  if (code === "rate_limit" || type === "rate_limit_error") {
    return {
      failureClass: "retryable",
      failureCode: "rate_limit",
      failureMessage: message,
    };
  }
  if (Number.isFinite(status) && status >= 500) {
    return {
      failureClass: "retryable",
      failureCode: "stripe_server_error",
      failureMessage: message,
    };
  }
  if (
    type === "api_connection_error" ||
    code === "timeout" ||
    /timeout|ECONNRESET|ETIMEDOUT|network/i.test(message)
  ) {
    return {
      failureClass: "retryable",
      failureCode: "network_timeout",
      failureMessage: message,
    };
  }
  if (type === "api_error") {
    return {
      failureClass: "retryable",
      failureCode: code || "stripe_api_error",
      failureMessage: message,
    };
  }
  return {
    failureClass: "permanent",
    failureCode: code || "charge_failed",
    failureMessage: message,
  };
}

/**
 * @param {number} attemptCount after failed processing attempt
 * @param {Date} [now]
 */
export function computeAttendanceFeeNextRetryAt(attemptCount, now = new Date()) {
  const attempts = Math.trunc(Number(attemptCount));
  if (!Number.isFinite(attempts) || attempts >= ATTENDANCE_FEE_MAX_CHARGE_ATTEMPTS) {
    return null;
  }
  const idx = Math.max(0, Math.min(attempts - 1, ATTENDANCE_FEE_RETRY_DELAY_MINUTES.length - 1));
  const minutes = ATTENDANCE_FEE_RETRY_DELAY_MINUTES[idx] ?? 60;
  return new Date(now.getTime() + minutes * 60 * 1000).toISOString();
}

/**
 * @param {number} attemptCount
 */
export function shouldConvertAttendanceFeeToPermanentRetry(attemptCount) {
  return Math.trunc(Number(attemptCount)) >= ATTENDANCE_FEE_MAX_CHARGE_ATTEMPTS;
}
