/**
 * AMARÉ Annual Membership — Mindbody Model F issuance engine (Phase 2).
 *
 * Single code path for Period 0 and Periods 1–11.
 * No Stripe webhook integration in this phase.
 */

import { MB_API_VERSION, fetchMb } from "./mindbody-consumer-lib.mjs";
import {
  ANNUAL_ISSUANCE_ELIGIBLE_MEMBERSHIP_STATUSES,
  ANNUAL_TIMEZONE,
  evaluateAnnualOverlapPolicy,
  fingerprintClientServiceIds,
  normalizeClientServiceIdSnapshot,
  stripeInstantToBusinessDate,
  validateAnnualAllocationAmounts,
} from "./annual-membership-lib.mjs";
import { STALE_CLAIM_MS, openAnnualMembershipStore } from "./annual-membership-store.mjs";
import { syncAnnualAllocationToMindbody, __testing as syncTesting } from "./stripe-mindbody-sync-lib.mjs";
import {
  isPreRequestSyncFailure,
  isUncertainPostRequestFailure,
} from "./stripe-onetime-fulfillment.mjs";

export { STALE_CLAIM_MS };

/** @typedef {ReturnType<typeof openAnnualMembershipStore>} AnnualMembershipStore */

export const ANNUAL_PRE_REQUEST_REASONS = new Set([
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

const DEFAULT_CLAIM_WINDOW_MS = STALE_CLAIM_MS;

/**
 * @param {unknown} reason
 */
export function isAnnualPreRequestFailure(reason) {
  return typeof reason === "string" && ANNUAL_PRE_REQUEST_REASONS.has(reason);
}

/**
 * @param {Date} [now]
 */
export function currentBusinessDate(now = new Date()) {
  return stripeInstantToBusinessDate(now, ANNUAL_TIMEZONE);
}

/**
 * @param {Record<string, unknown>} row
 */
function mapClientServiceRow(row) {
  if (!row || typeof row !== "object") return null;
  const r = /** @type {Record<string, unknown>} */ (row);
  return {
    Id: r.Id ?? r.id,
    ProductId: r.ProductId ?? r.productId,
    Remaining: r.Remaining ?? r.remaining,
    ExpirationDate: r.ExpirationDate ?? r.expirationDate,
    ActiveDate: r.ActiveDate ?? r.activeDate,
  };
}

/**
 * @param {unknown} data
 */
function clientServicesFromPayload(data) {
  if (!data || typeof data !== "object") return [];
  const d = /** @type {Record<string, unknown>} */ (data);
  const rows = Array.isArray(d.ClientServices)
    ? d.ClientServices
    : Array.isArray(d.clientServices)
      ? d.clientServices
      : [];
  return rows.map((row) => mapClientServiceRow(row)).filter(Boolean);
}

/**
 * @param {unknown} data
 */
function purchasesFromPayload(data) {
  if (!data || typeof data !== "object") return [];
  const d = /** @type {Record<string, unknown>} */ (data);
  return Array.isArray(d.Purchases)
    ? d.Purchases
    : Array.isArray(d.purchases)
      ? d.purchases
      : [];
}

/**
 * @param {Record<string, string>} headers
 * @param {number} clientId
 * @param {number} productId
 * @param {{ fetchMbFn?: typeof fetchMb }} [opts]
 */
export async function fetchClientServicesForProduct(headers, clientId, productId, opts = {}) {
  const fetchMbFn = opts.fetchMbFn ?? fetchMb;
  const q = new URLSearchParams();
  q.set("request.clientId", String(clientId));
  q.set("request.limit", "200");
  const r = await fetchMbFn(
    "GET",
    `/public/v${MB_API_VERSION}/client/clientservices?${q}`,
    headers,
    null,
  );
  if (!r.ok) return { ok: false, status: r.status, services: [], error: "clientservices_fetch_failed" };
  const services = clientServicesFromPayload(r.data).filter(
    (s) => Number(s?.ProductId) === Number(productId),
  );
  return { ok: true, status: r.status, services };
}

/**
 * @param {Record<string, string>} headers
 * @param {number} clientId
 * @param {number} clientServiceId
 * @param {{ fetchMbFn?: typeof fetchMb; productId?: number }} [opts]
 */
export async function fetchLinkedClientService(headers, clientId, clientServiceId, opts = {}) {
  const productId = opts.productId;
  const listed = await fetchClientServicesForProduct(headers, clientId, productId ?? 0, opts);
  if (!listed.ok && productId == null) return { ok: false, service: null, error: listed.error };
  const match = listed.services.find((s) => Number(s?.Id) === Number(clientServiceId)) ?? null;
  if (match) return { ok: true, service: match };
  if (productId != null) {
    const all = await fetchClientServicesForProduct(headers, clientId, productId, opts);
    const row = all.services.find((s) => Number(s?.Id) === Number(clientServiceId)) ?? null;
    if (row) return { ok: true, service: row };
  }
  return { ok: false, service: null, error: "linked_clientservice_not_found" };
}

/**
 * @param {Record<string, string>} headers
 * @param {number} clientId
 * @param {string} startIso
 * @param {string} endIso
 * @param {{ fetchMbFn?: typeof fetchMb }} [opts]
 */
export async function fetchClientPurchasesInWindow(headers, clientId, startIso, endIso, opts = {}) {
  const fetchMbFn = opts.fetchMbFn ?? fetchMb;
  const q = new URLSearchParams();
  q.set("request.clientId", String(clientId));
  q.set("request.startDate", startIso);
  q.set("request.endDate", endIso);
  q.set("request.limit", "100");
  const r = await fetchMbFn(
    "GET",
    `/public/v${MB_API_VERSION}/client/clientpurchases?${q}`,
    headers,
    null,
  );
  if (!r.ok) return { ok: false, status: r.status, purchases: [], error: "clientpurchases_fetch_failed" };
  return { ok: true, status: r.status, purchases: purchasesFromPayload(r.data) };
}

/**
 * @param {Record<string, string>} headers
 * @param {number} saleId
 * @param {{ fetchMbFn?: typeof fetchMb }} [opts]
 */
export async function fetchSaleById(headers, saleId, opts = {}) {
  const fetchMbFn = opts.fetchMbFn ?? fetchMb;
  const q = new URLSearchParams();
  q.set("request.saleId", String(saleId));
  const r = await fetchMbFn("GET", `/public/v${MB_API_VERSION}/sale/sales?${q}`, headers, null);
  if (!r.ok) return { ok: false, status: r.status, sale: null, error: "sale_fetch_failed" };
  const d = r.data && typeof r.data === "object" ? /** @type {Record<string, unknown>} */ (r.data) : {};
  const sales = Array.isArray(d.Sales) ? d.Sales : Array.isArray(d.sales) ? d.sales : [];
  return { ok: true, status: r.status, sale: sales[0] ?? null };
}

/**
 * @param {unknown} amount
 */
function amountToCents(amount) {
  const n = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/**
 * @param {unknown} sale
 * @param {number} expectedProductId
 * @param {number} expectedNetCents
 * @param {number} expectedPaymentMethodId
 */
function saleMatchesAllocation(sale, expectedProductId, expectedNetCents, expectedPaymentMethodId) {
  if (!sale || typeof sale !== "object") return false;
  const s = /** @type {Record<string, unknown>} */ (sale);
  const items = Array.isArray(s.PurchasedItems)
    ? s.PurchasedItems
    : Array.isArray(s.purchasedItems)
      ? s.purchasedItems
      : [];
  const line = items.find((raw) => {
    if (!raw || typeof raw !== "object") return false;
    const row = /** @type {Record<string, unknown>} */ (raw);
    return Number(row.Id ?? row.id) === expectedProductId;
  });
  if (!line || typeof line !== "object") return false;
  const row = /** @type {Record<string, unknown>} */ (line);
  const total = amountToCents(row.TotalAmount ?? row.totalAmount);
  if (total == null || total !== expectedNetCents) return false;
  const payments = Array.isArray(s.Payments) ? s.Payments : Array.isArray(s.payments) ? s.payments : [];
  return payments.some((raw) => {
    if (!raw || typeof raw !== "object") return false;
    const p = /** @type {Record<string, unknown>} */ (raw);
    return Number(p.Method ?? p.method) === expectedPaymentMethodId;
  });
}

/**
 * @param {unknown} purchase
 * @param {number} expectedProductId
 * @param {number} expectedNetCents
 * @param {number} expectedPaymentMethodId
 */
function purchaseMatchesAllocation(purchase, expectedProductId, expectedNetCents, expectedPaymentMethodId) {
  if (!purchase || typeof purchase !== "object") return false;
  const p = /** @type {Record<string, unknown>} */ (purchase);
  const sale = p.Sale && typeof p.Sale === "object" ? p.Sale : null;
  if (sale) return saleMatchesAllocation(sale, expectedProductId, expectedNetCents, expectedPaymentMethodId);
  const paid = amountToCents(p.AmountPaid ?? p.amountPaid);
  return paid === expectedNetCents;
}

/**
 * @param {{
 *   period: Record<string, unknown>;
 *   membership: Record<string, unknown>;
 *   preIssueIds: number[];
 *   currentServices: Record<string, unknown>[];
 *   purchases: unknown[];
 *   paymentMethodId: number;
 *   claimStartedAt: string;
 *   claimWindowMs?: number;
 *   nowMs?: number;
 * }} input
 */
export function reconcileAnnualPeriodCandidates(input) {
  const preSet = new Set(input.preIssueIds.map((n) => Number(n)));
  const productId = Number(input.period.mindbody_product_id);
  const netCents = Number(input.period.expected_net_amount_cents);
  const newServices = input.currentServices.filter((s) => !preSet.has(Number(s?.Id)));

  /** @type {{ clientServiceId: number; saleId: number | null; source: string }[]} */
  const candidates = [];

  for (const svc of newServices) {
    const clientServiceId = Number(svc?.Id);
    if (!Number.isInteger(clientServiceId) || clientServiceId <= 0) continue;
    let saleId = null;
    for (const raw of input.purchases) {
      if (!raw || typeof raw !== "object") continue;
      const p = /** @type {Record<string, unknown>} */ (raw);
      const sale = p.Sale && typeof p.Sale === "object" ? /** @type {Record<string, unknown>} */ (p.Sale) : null;
      if (!sale) continue;
      const items = Array.isArray(sale.PurchasedItems) ? sale.PurchasedItems : [];
      const line = items.find((row) => {
        if (!row || typeof row !== "object") return false;
        const r = /** @type {Record<string, unknown>} */ (row);
        return Number(r.PaymentRefId ?? r.paymentRefId) === clientServiceId;
      });
      if (!line) continue;
      if (!purchaseMatchesAllocation(p, productId, netCents, input.paymentMethodId)) continue;
      const saleIdRaw = sale.Id ?? sale.id;
      saleId = Number(saleIdRaw);
      break;
    }
    candidates.push({ clientServiceId, saleId: Number.isInteger(saleId) ? saleId : null, source: "clientservice_diff" });
  }

  const claimStartMs = new Date(input.claimStartedAt).getTime();
  const nowMs = input.nowMs ?? Date.now();
  const windowMs = input.claimWindowMs ?? DEFAULT_CLAIM_WINDOW_MS;
  const fresh = nowMs - claimStartMs < windowMs;

  if (candidates.length === 1) {
    return { outcome: "attach", candidate: candidates[0], fresh };
  }
  if (candidates.length === 0) {
    return { outcome: fresh ? "remain_ambiguous" : "safe_retry", fresh };
  }
  return { outcome: "manual_review", candidates, fresh };
}

/**
 * @param {{
 *   store?: AnnualMembershipStore;
 *   periodId: string;
 *   headers: Record<string, string>;
 *   paymentMethodId?: number;
 *   claimWindowMs?: number;
 *   now?: Date;
 *   fetchMbFn?: typeof fetchMb;
 * }} input
 */
export async function reconcileAmbiguousAnnualPeriod(input) {
  const store = input.store ?? openAnnualMembershipStore();
  const period = await store.getAnnualPeriod(input.periodId);
  if (!period) return { ok: false, reason: "period_not_found" };
  if (!["ambiguous", "claiming"].includes(period.status)) {
    return { ok: false, reason: "invalid_period_status", period };
  }

  const membership = await store.getAnnualMembership(period.annual_membership_id);
  if (!membership) return { ok: false, reason: "membership_not_found", period };

  const preIssueIds = Array.isArray(period.pre_issue_client_service_ids)
    ? normalizeClientServiceIdSnapshot(period.pre_issue_client_service_ids)
    : [];
  if (!period.claim_started_at) {
    await store.markPeriodManualReview(period.id, { error: "missing_claim_started_at" });
    return { ok: false, reason: "missing_claim_metadata", period };
  }

  const paymentMethodId = input.paymentMethodId ?? parseInt(process.env.MINDBODY_STRIPE_PAYMENT_METHOD_ID || "17", 10);
  const listed = await fetchClientServicesForProduct(
    input.headers,
    membership.mindbody_client_id,
    period.mindbody_product_id,
    { fetchMbFn: input.fetchMbFn },
  );
  if (!listed.ok) return { ok: false, reason: listed.error, period };

  const endIso = (input.now ?? new Date()).toISOString();
  const startIso = new Date(new Date(period.claim_started_at).getTime() - 60_000).toISOString();
  const purchases = await fetchClientPurchasesInWindow(
    input.headers,
    membership.mindbody_client_id,
    startIso,
    endIso,
    { fetchMbFn: input.fetchMbFn },
  );

  const decision = reconcileAnnualPeriodCandidates({
    period,
    membership,
    preIssueIds,
    currentServices: listed.services,
    purchases: purchases.ok ? purchases.purchases : [],
    paymentMethodId,
    claimStartedAt: period.claim_started_at,
    claimWindowMs: input.claimWindowMs,
    nowMs: (input.now ?? new Date()).getTime(),
  });

  if (decision.outcome === "attach" && decision.candidate) {
    let saleId = decision.candidate.saleId;
    if (!saleId && decision.candidate.clientServiceId) {
      for (const raw of purchases.ok ? purchases.purchases : []) {
        if (!purchaseMatchesAllocation(raw, period.mindbody_product_id, period.expected_net_amount_cents, paymentMethodId)) {
          continue;
        }
        const p = /** @type {Record<string, unknown>} */ (raw);
        const sale = p.Sale && typeof p.Sale === "object" ? /** @type {Record<string, unknown>} */ (p.Sale) : null;
        if (!sale) continue;
        const items = Array.isArray(sale.PurchasedItems) ? sale.PurchasedItems : [];
        if (
          items.some((row) => {
            if (!row || typeof row !== "object") return false;
            const r = /** @type {Record<string, unknown>} */ (row);
            return Number(r.PaymentRefId ?? r.paymentRefId) === decision.candidate.clientServiceId;
          })
        ) {
          saleId = Number(sale.Id ?? sale.id);
          break;
        }
      }
    }
    const issued = await store.markPeriodIssued(period.id, {
      mindbodySaleId: saleId ?? undefined,
      mindbodyClientServiceId: decision.candidate.clientServiceId,
    });
    return { ok: true, outcome: "issued", period: issued.period, candidate: decision.candidate };
  }

  if (decision.outcome === "manual_review") {
    const reviewed = await store.markPeriodManualReview(period.id, {
      error: `ambiguous_multiple_candidates:${decision.candidates?.length ?? 0}`,
    });
    return { ok: true, outcome: "manual_review", period: reviewed.period, candidates: decision.candidates };
  }

  if (decision.outcome === "safe_retry") {
    const released = await store.releaseSafeRetryToPending(period.id, {
      note: "reconciliation_zero_matches_stale",
    });
    return { ok: true, outcome: "safe_retry", period: released.period };
  }

  return { ok: true, outcome: "remain_ambiguous", period, fresh: decision.fresh };
}

/**
 * @param {{
 *   store?: AnnualMembershipStore;
 *   headers: Record<string, string>;
 *   staleMs?: number;
 *   now?: Date;
 *   fetchMbFn?: typeof fetchMb;
 * }} [input]
 */
export async function recoverStaleAnnualClaims(input = {}) {
  const store = input.store ?? openAnnualMembershipStore();
  const now = input.now ?? new Date();
  const staleMs = input.staleMs ?? STALE_CLAIM_MS;
  const staleBefore = new Date(now.getTime() - staleMs).toISOString();
  const staleClaiming = await store.findStaleClaims(staleBefore);
  /** @type {unknown[]} */
  const results = [];

  for (const period of staleClaiming) {
    results.push(
      await reconcileAmbiguousAnnualPeriod({
        store,
        periodId: period.id,
        headers: input.headers,
        now,
        fetchMbFn: input.fetchMbFn,
      }),
    );
  }

  return { ok: true, reconciled: results };
}

/**
 * @param {{
 *   store?: AnnualMembershipStore;
 *   periodId: string;
 *   businessDate?: string;
 *   mindbodyTest?: boolean;
 *   syncFn?: typeof syncAnnualAllocationToMindbody;
 *   staffHeadersFn?: () => Promise<{ ok: boolean; headers?: Record<string, string>; error?: string }>;
 *   fetchClientServicesFn?: typeof fetchClientServicesForProduct;
 *   fetchLinkedClientServiceFn?: typeof fetchLinkedClientService;
 *   now?: Date;
 * }} [options]
 */
export async function issueAnnualMembershipPeriod(periodId, options = {}) {
  const store = options.store ?? openAnnualMembershipStore();
  const syncFn = options.syncFn ?? syncAnnualAllocationToMindbody;
  const businessDate = options.businessDate ?? currentBusinessDate(options.now);

  const period = await store.getAnnualPeriod(periodId);
  if (!period) return { ok: false, outcome: "PERIOD_NOT_FOUND" };
  if (period.status !== "pending") {
    return { ok: false, outcome: "PERIOD_NOT_ISSUABLE", status: period.status, period };
  }

  const membership = await store.getAnnualMembership(period.annual_membership_id);
  if (!membership) return { ok: false, outcome: "MEMBERSHIP_NOT_FOUND", period };
  if (!ANNUAL_ISSUANCE_ELIGIBLE_MEMBERSHIP_STATUSES.includes(membership.status)) {
    return { ok: false, outcome: "MEMBERSHIP_NOT_ELIGIBLE", membershipStatus: membership.status, period };
  }

  const amountCheck = validateAnnualAllocationAmounts({
    sku: membership.sku,
    productId: period.mindbody_product_id,
    listAmountCents: period.expected_list_amount_cents,
    discountAmountCents: period.expected_discount_amount_cents,
    netAmountCents: period.expected_net_amount_cents,
  });
  if (!amountCheck.ok) {
    return { ok: false, outcome: "VALIDATION_FAILED", reason: amountCheck.reason, period };
  }

  if (period.period_start_date > businessDate) {
    return { ok: false, outcome: "PERIOD_NOT_DUE", period, businessDate };
  }

  if (period.period_index > 0) {
    const previous = await store.getAnnualPeriodByMembershipIndex(
      period.annual_membership_id,
      period.period_index - 1,
    );
    if (previous?.status === "issued" && previous.mindbody_client_service_id) {
      let previousService = null;
      if (options.fetchLinkedClientServiceFn && options.staffHeadersFn) {
        const staff = await options.staffHeadersFn();
        if (staff.ok && staff.headers) {
          const linked = await options.fetchLinkedClientServiceFn(
            staff.headers,
            membership.mindbody_client_id,
            previous.mindbody_client_service_id,
            { productId: previous.mindbody_product_id },
          );
          previousService = linked.service;
        }
      } else if (options.mockPreviousClientService) {
        previousService = options.mockPreviousClientService;
      }

      const overlap = evaluateAnnualOverlapPolicy({
        previousAnnualPeriod: previous,
        previousMindbodyClientService: previousService,
        currentPeriod: period,
      });
      if (overlap === "DEFER") {
        return { ok: true, outcome: "DEFERRED_PREVIOUS_PERIOD_ACTIVE", period, previousPeriodId: previous.id };
      }
      if (overlap === "MANUAL_REVIEW") {
        await store.markPeriodManualReview(period.id, { error: "overlap_policy_manual_review" });
        return { ok: false, outcome: "OVERLAP_MANUAL_REVIEW", period };
      }
    }
  }

  const claim = await store.claimPeriod(period.id);
  if (!claim.acquired) {
    return { ok: true, outcome: "CLAIM_LOST", period: claim.period };
  }

  const staff = options.staffHeadersFn
    ? await options.staffHeadersFn()
    : await syncTesting.staffHeadersForSync();

  if (!staff.ok || !staff.headers) {
    await store.releaseSafeRetryToPending(period.id, { note: staff.error || "staff_unavailable" });
    return { ok: false, outcome: "PRE_REQUEST_FAILED", reason: staff.error, period };
  }

  const listed = options.fetchClientServicesFn
    ? await options.fetchClientServicesFn(
        staff.headers,
        membership.mindbody_client_id,
        period.mindbody_product_id,
      )
    : await fetchClientServicesForProduct(
        staff.headers,
        membership.mindbody_client_id,
        period.mindbody_product_id,
      );

  if (!listed.ok) {
    await store.releaseSafeRetryToPending(period.id, { note: listed.error || "clientservices_prefetch_failed" });
    return { ok: false, outcome: "PRE_REQUEST_FAILED", reason: listed.error, period };
  }

  const preIssueIds = listed.services
    .map((s) => Number(s?.Id))
    .filter((n) => Number.isInteger(n) && n > 0);
  const claimStartedAt = new Date().toISOString();
  const snap = await store.persistPreIssueSnapshot(period.id, {
    clientServiceIds: preIssueIds,
    claimStartedAt,
  });
  if (!snap.ok) {
    await store.markPeriodFailed(period.id, { error: snap.reason || "snapshot_persist_failed" });
    return { ok: false, outcome: "SNAPSHOT_FAILED", reason: snap.reason, period: snap.period };
  }

  const membershipRecheck = await store.getAnnualMembership(period.annual_membership_id);
  if (
    !membershipRecheck ||
    !ANNUAL_ISSUANCE_ELIGIBLE_MEMBERSHIP_STATUSES.includes(String(membershipRecheck.status))
  ) {
    if (typeof store.markPeriodSkipped === "function") {
      await store.markPeriodSkipped(period.id, { reason: "membership_not_eligible_before_sync" });
    } else {
      await store.markPeriodFailed(period.id, { error: "membership_not_eligible_before_sync" });
    }
    return {
      ok: false,
      outcome: "MEMBERSHIP_REVOKED_BEFORE_SYNC",
      membershipStatus: membershipRecheck?.status ?? null,
      period,
    };
  }

  const periodRecheck = await store.getAnnualPeriod(period.id);
  if (!periodRecheck || periodRecheck.status !== "claiming") {
    return { ok: true, outcome: "CLAIM_LOST", period: periodRecheck };
  }

  const sync = await syncFn({
    mindbodyClientId: membership.mindbody_client_id,
    annualMembershipId: membership.id,
    periodId: period.id,
    periodIndex: period.period_index,
    stripeInvoiceId: membership.stripe_invoice_id,
    sku: membership.sku,
    productId: period.mindbody_product_id,
    listAmountCents: period.expected_list_amount_cents,
    discountAmountCents: period.expected_discount_amount_cents,
    netAmountCents: period.expected_net_amount_cents,
    mindbodyTest: options.mindbodyTest === true,
  });

  if (sync.ok) {
    let clientServiceId = sync.mindbodyClientServiceId ? Number(sync.mindbodyClientServiceId) : null;
    if (!clientServiceId && !options.mindbodyTest) {
      const after = await fetchClientServicesForProduct(
        staff.headers,
        membership.mindbody_client_id,
        period.mindbody_product_id,
      );
      const preSet = new Set(preIssueIds);
      const created = after.ok
        ? after.services.filter((s) => !preSet.has(Number(s?.Id)))
        : [];
      if (created.length === 1) clientServiceId = Number(created[0]?.Id);
      if (created.length > 1) {
        await store.markPeriodAmbiguous(period.id, { error: "multiple_new_clientservices_after_success" });
        return { ok: false, outcome: "AMBIGUOUS", reason: "multiple_new_clientservices_after_success", period };
      }
    }

    const done = await store.markPeriodIssued(period.id, {
      mindbodySaleId: sync.mindbodySaleId ? Number(sync.mindbodySaleId) : undefined,
      mindbodyClientServiceId: clientServiceId ?? undefined,
    });
    return {
      ok: true,
      outcome: "ISSUED",
      period: done.period,
      mindbodySaleId: sync.mindbodySaleId,
      mindbodyClientServiceId: clientServiceId,
      payNote: sync.payNote,
    };
  }

  const reason = sync.reason || "mindbody_sync_failed";
  if (isUncertainPostRequestFailure(reason) || reason === "mindbody_sync_timeout") {
    const ambiguous = await store.markPeriodAmbiguous(period.id, { error: reason });
    return { ok: false, outcome: "AMBIGUOUS", reason, period: ambiguous.period, retryable: true };
  }

  if (isAnnualPreRequestFailure(reason) || isPreRequestSyncFailure(reason)) {
    const released = await store.releaseSafeRetryToPending(period.id, { note: reason });
    return { ok: false, outcome: "PRE_REQUEST_FAILED", reason, period: released.period, retryable: true };
  }

  const failed = await store.markPeriodFailed(period.id, { error: reason });
  return { ok: false, outcome: "FAILED", reason, period: failed.period, message: sync.message };
}

export const __testing = {
  reconcileAnnualPeriodCandidates,
  saleMatchesAllocation,
  purchaseMatchesAllocation,
  fingerprintClientServiceIds,
};
