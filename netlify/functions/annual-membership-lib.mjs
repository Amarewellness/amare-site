/**
 * AMARÉ Annual Membership — pure domain helpers (Phase 1).
 * No Postgres, Stripe, or Mindbody I/O.
 */

export const ANNUAL_TIMEZONE = "America/New_York";

/** @typedef {"annual_monthly_5" | "annual_monthly_8" | "annual_monthly_unlimited"} AnnualSku */

/** @typedef {{
 *   sku: AnnualSku;
 *   mindbodyProductId: number;
 *   listAmountCents: number;
 *   discountAmountCents: number;
 *   netAmountCents: number;
 *   annualTotalCents: number;
 * }} AnnualSkuDefinition */

/** @typedef {{
 *   periodIndex: number;
 *   periodStartDate: string;
 *   periodEndDate: string;
 *   mindbodyProductId: number;
 *   expectedListAmountCents: number;
 *   expectedDiscountAmountCents: number;
 *   expectedNetAmountCents: number;
 * }} AnnualPeriodDefinition */

/** @typedef {"ALLOW" | "DEFER" | "MANUAL_REVIEW"} OverlapPolicyDecision */

export const ANNUAL_MEMBERSHIP_STATUSES = Object.freeze([
  "pending",
  "active",
  "past_due",
  "canceled",
  "refunded",
  "completed",
  "revoked",
]);

/** Period statuses unconditionally skippable when revoking (never issued to Mindbody). */
export const ANNUAL_REVOKE_SKIPPABLE_PERIOD_STATUSES = Object.freeze(["pending"]);

/**
 * Failed-period errors where Mindbody CheckoutShoppingCart was never successfully committed.
 * Evidence: engine marks `failed` before POST, or POST returned a definitive HTTP rejection
 * with no mindbody_sale_id / mindbody_client_service_id on the period row.
 */
export const ANNUAL_REVOKE_SAFE_PRE_MINDbody_WRITE_FAILED_ERRORS = Object.freeze([
  "snapshot_persist_failed",
  "membership_not_eligible_before_sync",
  "invalid_annual_sku",
  "annual_product_id_mismatch",
  "annual_list_amount_mismatch",
  "annual_discount_amount_mismatch",
  "annual_net_amount_mismatch",
  "annual_amount_arithmetic_mismatch",
  "invalid_payment_mode_env",
  "missing_payment_method_id",
  "staff_credentials_not_configured",
  "staff_headers_unavailable",
  "staff_token_issue_timeout",
]);

/** Definitive Mindbody rejection responses — POST attempted, no allocation ids persisted. */
export const ANNUAL_REVOKE_SAFE_DEFINITIVE_MINDbody_REJECTION_ERRORS = Object.freeze([
  "mindbody_sync_rejected",
  "mindbody_calculated_total_mismatch",
]);

/**
 * @param {unknown} ids
 */
function annualPeriodPreIssueIdsEmpty(ids) {
  if (ids == null) return true;
  if (Array.isArray(ids)) return ids.length === 0;
  return false;
}

/**
 * Overlap-policy manual_review only: issuance never entered `claiming` and no Mindbody ids exist.
 * Persisted evidence:
 * - last_error === overlap_policy_manual_review
 * - claim_started_at IS NULL
 * - pre_issue_client_service_ids empty/null
 * - mindbody_sale_id AND mindbody_client_service_id IS NULL
 *
 * @param {{ status?: string; last_error?: string | null; claim_started_at?: string | null; pre_issue_client_service_ids?: unknown; mindbody_sale_id?: number | null; mindbody_client_service_id?: number | null }} period
 */
export function isAnnualOverlapManualReviewProvablyUnissued(period) {
  if (String(period?.status) !== "manual_review") return false;
  if (String(period.last_error || "") !== "overlap_policy_manual_review") return false;
  if (period.claim_started_at) return false;
  if (!annualPeriodPreIssueIdsEmpty(period.pre_issue_client_service_ids)) return false;
  if (period.mindbody_sale_id != null || period.mindbody_client_service_id != null) return false;
  return true;
}

/**
 * @param {{ status?: string; last_error?: string | null; mindbody_sale_id?: number | null; mindbody_client_service_id?: number | null }} period
 */
export function isAnnualFailedPeriodProvablySafeToSkip(period) {
  if (String(period?.status) !== "failed") return false;
  if (period.mindbody_sale_id != null || period.mindbody_client_service_id != null) return false;
  const err = String(period.last_error || "");
  if (ANNUAL_REVOKE_SAFE_PRE_MINDbody_WRITE_FAILED_ERRORS.includes(err)) return true;
  if (ANNUAL_REVOKE_SAFE_DEFINITIVE_MINDbody_REJECTION_ERRORS.includes(err)) return true;
  return false;
}

/**
 * @param {{ id?: string; status?: string; last_error?: string | null; claim_started_at?: string | null; pre_issue_client_service_ids?: unknown; mindbody_sale_id?: number | null; mindbody_client_service_id?: number | null }} period
 * @returns {{ skip: boolean; block: boolean; reason?: string; periodId?: string }}
 */
export function assessAnnualPeriodRevokeEligibility(period) {
  const status = String(period?.status || "");
  const periodId = period?.id ? String(period.id) : undefined;
  if (status === "issued" || status === "skipped") {
    return { skip: false, block: false };
  }
  if (status === "claiming") {
    return { skip: false, block: true, reason: "period_claim_in_progress", periodId };
  }
  if (status === "ambiguous") {
    return { skip: false, block: true, reason: "ambiguous_periods_must_be_reconciled_first", periodId };
  }
  if (status === "manual_review") {
    if (isAnnualOverlapManualReviewProvablyUnissued(period)) {
      return { skip: true, block: false };
    }
    return { skip: false, block: true, reason: "manual_review_requires_resolution", periodId };
  }
  if (status === "failed") {
    if (isAnnualFailedPeriodProvablySafeToSkip(period)) {
      return { skip: true, block: false };
    }
    return { skip: false, block: true, reason: "failed_may_have_committed_write", periodId };
  }
  if (status === "pending") {
    return { skip: true, block: false };
  }
  return { skip: false, block: false };
}

export const ANNUAL_PERIOD_STATUSES = Object.freeze([
  "pending",
  "claiming",
  "issued",
  "failed",
  "ambiguous",
  "manual_review",
  "skipped",
]);

/** @type {Record<AnnualSku, AnnualSkuDefinition>} */
export const ANNUAL_SKU_DEFINITIONS = Object.freeze({
  annual_monthly_5: Object.freeze({
    sku: "annual_monthly_5",
    mindbodyProductId: 100133,
    listAmountCents: 12500,
    discountAmountCents: 1875,
    netAmountCents: 10625,
    annualTotalCents: 127500,
  }),
  annual_monthly_8: Object.freeze({
    sku: "annual_monthly_8",
    mindbodyProductId: 100134,
    listAmountCents: 17900,
    discountAmountCents: 2685,
    netAmountCents: 15215,
    annualTotalCents: 182580,
  }),
  annual_monthly_unlimited: Object.freeze({
    sku: "annual_monthly_unlimited",
    mindbodyProductId: 100135,
    listAmountCents: 22900,
    discountAmountCents: 3435,
    netAmountCents: 19465,
    annualTotalCents: 233580,
  }),
});

export const ANNUAL_SKUS = Object.freeze(Object.keys(ANNUAL_SKU_DEFINITIONS));

for (const def of Object.values(ANNUAL_SKU_DEFINITIONS)) {
  if (def.listAmountCents - def.discountAmountCents !== def.netAmountCents) {
    throw new Error(`annual_sku_net_mismatch:${def.sku}`);
  }
  if (def.netAmountCents * 12 !== def.annualTotalCents) {
    throw new Error(`annual_sku_total_mismatch:${def.sku}`);
  }
}

/**
 * Period boundaries use half-open civil dates: [period_start_date, period_end_date).
 *
 * @param {unknown} sku
 * @returns {AnnualSku}
 */
export function assertAnnualSku(sku) {
  const s = typeof sku === "string" ? sku.trim() : "";
  if (!ANNUAL_SKUS.includes(s)) throw new Error("invalid_annual_sku");
  return /** @type {AnnualSku} */ (s);
}

/**
 * @param {unknown} sku
 * @returns {AnnualSkuDefinition}
 */
export function getAnnualSkuDefinition(sku) {
  return ANNUAL_SKU_DEFINITIONS[assertAnnualSku(sku)];
}

/**
 * @param {unknown} dateStr
 * @returns {string}
 */
export function assertBusinessDate(dateStr) {
  if (typeof dateStr !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr.trim())) {
    throw new Error("invalid_business_date");
  }
  const [y, m, d] = dateStr.trim().split("-").map(Number);
  const lastDay = daysInMonth(y, m);
  if (d < 1 || d > lastDay) throw new Error("invalid_business_date");
  return dateStr.trim();
}

/**
 * @param {number} year
 * @param {number} month 1-12
 */
export function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Add calendar months to a civil date, clamping the day to the target month's last day.
 * Always derives from the original anchor day, not from chained intermediate results.
 *
 * @param {string} anchorDate YYYY-MM-DD
 * @param {number} months
 * @returns {string}
 */
export function addMonthsToBusinessDate(anchorDate, months) {
  const anchor = assertBusinessDate(anchorDate);
  const [anchorYear, anchorMonth, anchorDay] = anchor.split("-").map(Number);
  const totalMonths = anchorYear * 12 + (anchorMonth - 1) + months;
  const year = Math.floor(totalMonths / 12);
  const month = (totalMonths % 12) + 1;
  const day = Math.min(anchorDay, daysInMonth(year, month));
  return formatBusinessDate(year, month, day);
}

/**
 * @param {number} year
 * @param {number} month
 * @param {number} day
 */
export function formatBusinessDate(year, month, day) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Convert a Stripe billing instant to the canonical America/New_York business date.
 *
 * @param {string | Date} instant
 * @param {string} [timezone]
 * @returns {string}
 */
export function stripeInstantToBusinessDate(instant, timezone = ANNUAL_TIMEZONE) {
  const d = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(d.getTime())) throw new Error("invalid_stripe_instant");
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/**
 * Build exactly 12 contiguous half-open entitlement periods for one annual term.
 *
 * @param {{
 *   termStartDate: string;
 *   termEndDate: string;
 *   sku: AnnualSku | string;
 * }} input
 * @returns {AnnualPeriodDefinition[]}
 */
export function buildAnnualMembershipPeriods(input) {
  const termStartDate = assertBusinessDate(input.termStartDate);
  const termEndDate = assertBusinessDate(input.termEndDate);
  if (termStartDate >= termEndDate) throw new Error("invalid_annual_term_dates");

  const pricing = getAnnualSkuDefinition(input.sku);
  /** @type {AnnualPeriodDefinition[]} */
  const periods = [];

  for (let periodIndex = 0; periodIndex < 12; periodIndex += 1) {
    const periodStartDate = addMonthsToBusinessDate(termStartDate, periodIndex);
    const periodEndDate =
      periodIndex === 11 ? termEndDate : addMonthsToBusinessDate(termStartDate, periodIndex + 1);
    periods.push({
      periodIndex,
      periodStartDate,
      periodEndDate,
      mindbodyProductId: pricing.mindbodyProductId,
      expectedListAmountCents: pricing.listAmountCents,
      expectedDiscountAmountCents: pricing.discountAmountCents,
      expectedNetAmountCents: pricing.netAmountCents,
    });
  }

  validateAnnualMembershipPeriods(periods, termStartDate, termEndDate);
  return periods;
}

/**
 * @param {AnnualPeriodDefinition[]} periods
 * @param {string} termStartDate
 * @param {string} termEndDate
 */
export function validateAnnualMembershipPeriods(periods, termStartDate, termEndDate) {
  if (!Array.isArray(periods) || periods.length !== 12) {
    throw new Error("annual_period_count_invalid");
  }

  for (let i = 0; i < periods.length; i += 1) {
    const row = periods[i];
    if (row.periodIndex !== i) throw new Error("annual_period_index_invalid");
    assertBusinessDate(row.periodStartDate);
    assertBusinessDate(row.periodEndDate);
    if (row.periodStartDate >= row.periodEndDate) throw new Error("annual_period_range_invalid");
    if (i === 0 && row.periodStartDate !== termStartDate) throw new Error("annual_period_anchor_mismatch");
    if (i === 11 && row.periodEndDate !== termEndDate) throw new Error("annual_term_end_mismatch");
    if (i < 11 && row.periodEndDate !== periods[i + 1].periodStartDate) {
      throw new Error("annual_period_gap_or_overlap");
    }
  }
}

/**
 * Compare a Mindbody expiration value to a canonical civil period start date.
 *
 * @param {unknown} expirationValue
 * @param {string} periodStartDate
 * @returns {boolean}
 */
export function mindbodyExpirationAfterPeriodStart(expirationValue, periodStartDate) {
  const start = assertBusinessDate(periodStartDate);
  const expDate = mindbodyValueToBusinessDate(expirationValue);
  if (!expDate) return false;
  return expDate > start;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
export function mindbodyValueToBusinessDate(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    const match = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
    if (match) return assertBusinessDate(match[1]);
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return stripeInstantToBusinessDate(value);
  }
  return null;
}

/**
 * Annual overlap guard — inspect only the previous annual period's linked Mindbody service.
 *
 * @param {{
 *   previousAnnualPeriod?: {
 *     periodIndex?: number;
 *     status?: string;
 *     mindbodyClientServiceId?: number | string | null;
 *   } | null;
 *   previousMindbodyClientService?: {
 *     Remaining?: number | string | null;
 *     ExpirationDate?: string | Date | null;
 *   } | null;
 *   currentPeriod?: {
 *     periodIndex?: number;
 *     periodStartDate?: string;
 *   } | null;
 * }} input
 * @returns {OverlapPolicyDecision}
 */
export function evaluateAnnualOverlapPolicy(input) {
  const previousAnnualPeriod = input.previousAnnualPeriod ?? null;
  const previousMindbodyClientService = input.previousMindbodyClientService ?? null;
  const currentPeriod = input.currentPeriod ?? null;

  const rawStart =
    currentPeriod && typeof currentPeriod === "object"
      ? /** @type {Record<string, unknown>} */ (currentPeriod).periodStartDate ??
        /** @type {Record<string, unknown>} */ (currentPeriod).period_start_date
      : null;

  if (!rawStart || typeof rawStart !== "string") {
    return "MANUAL_REVIEW";
  }

  let periodStartDate;
  try {
    periodStartDate = assertBusinessDate(rawStart);
  } catch {
    return "MANUAL_REVIEW";
  }

  if (!previousAnnualPeriod) return "ALLOW";

  if (previousAnnualPeriod.status !== "issued") return "MANUAL_REVIEW";

  const prevRow =
    previousAnnualPeriod && typeof previousAnnualPeriod === "object"
      ? /** @type {Record<string, unknown>} */ (previousAnnualPeriod)
      : null;
  const linkedServiceId =
    prevRow?.mindbodyClientServiceId ?? prevRow?.mindbody_client_service_id ?? null;
  if (linkedServiceId == null || linkedServiceId === "") return "MANUAL_REVIEW";

  if (!previousMindbodyClientService) return "MANUAL_REVIEW";

  const remainingRaw = previousMindbodyClientService.Remaining;
  const remaining =
    typeof remainingRaw === "number"
      ? remainingRaw
      : typeof remainingRaw === "string" && remainingRaw.trim() !== ""
        ? Number(remainingRaw)
        : NaN;

  if (!Number.isFinite(remaining)) return "MANUAL_REVIEW";

  if (remaining === 0) return "ALLOW";

  if (remaining > 0) {
    const expiration = previousMindbodyClientService.ExpirationDate;
    if (expiration == null || expiration === "") return "MANUAL_REVIEW";
    if (mindbodyExpirationAfterPeriodStart(expiration, periodStartDate)) return "DEFER";
    return "ALLOW";
  }

  return "MANUAL_REVIEW";
}

/**
 * @param {unknown} ids
 * @returns {number[]}
 */
export function normalizeClientServiceIdSnapshot(ids) {
  if (!Array.isArray(ids)) throw new Error("invalid_pre_issue_snapshot");
  /** @type {number[]} */
  const out = [];
  const seen = new Set();
  for (const raw of ids) {
    const n = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isInteger(n) || n <= 0) throw new Error("invalid_pre_issue_snapshot");
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  out.sort((a, b) => a - b);
  return out;
}

/**
 * @param {number[]} ids
 * @returns {string}
 */
export function fingerprintClientServiceIds(ids) {
  return normalizeClientServiceIdSnapshot(ids).join(",");
}

/**
 * Strict Model F amount validation — caller values must match SKU config exactly.
 *
 * @param {{
 *   sku: AnnualSku | string;
 *   productId: number;
 *   listAmountCents: number;
 *   discountAmountCents: number;
 *   netAmountCents: number;
 * }} input
 * @returns {{ ok: true; definition: AnnualSkuDefinition } | { ok: false; reason: string }}
 */
export function validateAnnualAllocationAmounts(input) {
  let sku;
  try {
    sku = assertAnnualSku(input.sku);
  } catch {
    return { ok: false, reason: "invalid_annual_sku" };
  }
  const def = getAnnualSkuDefinition(sku);
  const productId = Number(input.productId);
  const listAmountCents = Math.round(Number(input.listAmountCents));
  const discountAmountCents = Math.round(Number(input.discountAmountCents));
  const netAmountCents = Math.round(Number(input.netAmountCents));

  if (productId !== def.mindbodyProductId) {
    return { ok: false, reason: "annual_product_id_mismatch" };
  }
  if (listAmountCents !== def.listAmountCents) {
    return { ok: false, reason: "annual_list_amount_mismatch" };
  }
  if (discountAmountCents !== def.discountAmountCents) {
    return { ok: false, reason: "annual_discount_amount_mismatch" };
  }
  if (netAmountCents !== def.netAmountCents) {
    return { ok: false, reason: "annual_net_amount_mismatch" };
  }
  if (listAmountCents - discountAmountCents !== netAmountCents) {
    return { ok: false, reason: "annual_amount_arithmetic_mismatch" };
  }
  return { ok: true, definition: def };
}

/**
 * Compact prepaid-allocation PayNote for Mindbody staff forensics.
 *
 * @param {{
 *   annualMembershipId: string;
 *   stripeInvoiceId: string;
 *   periodIndex: number;
 *   sku: AnnualSku | string;
 *   netAmountCents: number;
 * }} input
 */
export function buildAnnualAllocationPayNote(input) {
  const sku = assertAnnualSku(input.sku);
  const netAmountCents = Math.round(Number(input.netAmountCents));
  const netUsd = (netAmountCents / 100).toFixed(2);
  const periodHuman = `${Number(input.periodIndex) + 1}/12`;
  const note = [
    `annual=${String(input.annualMembershipId).slice(0, 36)}`,
    `inv=${String(input.stripeInvoiceId).slice(0, 40)}`,
    `p=${periodHuman}`,
    "alloc=prepaid",
    `sku=${sku}`,
    `net=${netUsd}`,
  ].join("; ");
  return note.slice(0, 250);
}

export const ANNUAL_ISSUANCE_ELIGIBLE_MEMBERSHIP_STATUSES = Object.freeze(["active"]);

/**
 * Real Stripe subscription ids use the `sub_` prefix.
 *
 * @param {unknown} id
 * @returns {boolean}
 */
export function isRealStripeSubscriptionId(id) {
  const s = typeof id === "string" ? id.trim() : "";
  return s.startsWith("sub_") && !isPendingStripeSubscriptionId(s);
}

/**
 * Internal checkout placeholder ids (not valid for Stripe API calls).
 *
 * @param {unknown} id
 * @returns {boolean}
 */
export function isPendingStripeSubscriptionId(id) {
  const s = typeof id === "string" ? id.trim() : "";
  return s.startsWith("pending_");
}

/**
 * Extract subscription id from Stripe invoice payloads (legacy + Basil parent shape).
 *
 * @param {unknown} invoice
 * @returns {string}
 */
export function extractStripeInvoiceSubscriptionId(invoice) {
  if (!invoice || typeof invoice !== "object") return "";
  /** @type {unknown} */
  const legacy = /** @type {{ subscription?: unknown }} */ (invoice).subscription;
  if (typeof legacy === "string" && legacy.trim()) return legacy.trim();
  if (legacy && typeof legacy === "object") {
    const id = /** @type {{ id?: string }} */ (legacy).id;
    if (typeof id === "string" && id.trim()) return id.trim();
  }
  /** @type {unknown} */
  const parent = /** @type {{ parent?: unknown }} */ (invoice).parent;
  if (parent && typeof parent === "object") {
    const p = /** @type {{ type?: string; subscription_details?: unknown }} */ (parent);
    if (
      p.type === "subscription_details" &&
      p.subscription_details &&
      typeof p.subscription_details === "object"
    ) {
      const sd = /** @type {{ subscription?: unknown }} */ (p.subscription_details);
      if (typeof sd.subscription === "string" && sd.subscription.trim()) return sd.subscription.trim();
      if (sd.subscription && typeof sd.subscription === "object") {
        const id = /** @type {{ id?: string }} */ (sd.subscription).id;
        if (typeof id === "string" && id.trim()) return id.trim();
      }
    }
  }
  return "";
}

/**
 * Prefer authoritative invoice subscription id, then healed subscription-store id.
 *
 * @param {{ invoiceSubscriptionId?: unknown; recordSubscriptionId?: unknown }} input
 * @returns {string}
 */
export function resolveAnnualStripeSubscriptionId(input) {
  const invoiceSub =
    typeof input.invoiceSubscriptionId === "string" ? input.invoiceSubscriptionId.trim() : "";
  const recordSub =
    typeof input.recordSubscriptionId === "string" ? input.recordSubscriptionId.trim() : "";
  if (isRealStripeSubscriptionId(invoiceSub)) return invoiceSub;
  if (isRealStripeSubscriptionId(recordSub)) return recordSub;
  if (recordSub) return recordSub;
  if (invoiceSub) return invoiceSub;
  return "";
}

/**
 * Whether to backfill pending placeholder → real Stripe subscription id on the same term row.
 *
 * @param {unknown} existingSubId
 * @param {unknown} incomingSubId
 * @returns {boolean}
 */
export function shouldBackfillAnnualStripeSubscriptionId(existingSubId, incomingSubId) {
  if (!isRealStripeSubscriptionId(incomingSubId)) return false;
  const incoming = String(incomingSubId).trim();
  const existing = typeof existingSubId === "string" ? existingSubId.trim() : "";
  if (isRealStripeSubscriptionId(existing)) return existing === incoming;
  return isPendingStripeSubscriptionId(existing) || !existing;
}

/**
 * Serialize Postgres DATE / civil business dates for JSON without timezone shift.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function formatAnnualBusinessDate(value) {
  if (value == null) return null;
  if (typeof value === "string") {
    const m = value.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
  }
  if (value instanceof Date) {
    const y = value.getUTCFullYear();
    const mo = String(value.getUTCMonth() + 1).padStart(2, "0");
    const d = String(value.getUTCDate()).padStart(2, "0");
    return `${y}-${mo}-${d}`;
  }
  return String(value).slice(0, 10);
}

export const __testing = {
  daysInMonth,
  formatBusinessDate,
  isRealStripeSubscriptionId,
  isPendingStripeSubscriptionId,
  extractStripeInvoiceSubscriptionId,
  resolveAnnualStripeSubscriptionId,
  shouldBackfillAnnualStripeSubscriptionId,
  formatAnnualBusinessDate,
};
