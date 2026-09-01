/**
 * Annual membership Stripe webhook helpers (Phase 3).
 * Postgres annual ledger + Phase 2 issuance engine.
 * Does not modify monthly invoice.paid Mindbody sync.
 */

import {
  ANNUAL_SKU_DEFINITIONS,
  extractStripeInvoiceSubscriptionId,
  getAnnualSkuDefinition,
  resolveAnnualStripeSubscriptionId,
  stripeInstantToBusinessDate,
} from "./annual-membership-lib.mjs";
import { openAnnualMembershipStore } from "./annual-membership-store.mjs";
import {
  currentBusinessDate,
  issueAnnualMembershipPeriod,
} from "./annual-membership-issue.mjs";
import { isAnnualMembershipCatalogItem, getCatalogItem } from "./stripe-catalog-lib.mjs";

/** @typedef {import("stripe").Stripe} Stripe */

/**
 * Annual Mindbody issuance skip is QA/test-mode only.
 * Stripe LIVE events always attempt live issuance regardless of
 * ANNUAL_WEBHOOK_SKIP_MINDDBODY_ISSUE or STRIPE_TEST_MODE_MINDBODY_BEHAVIOR.
 *
 * @param {{ stripeLivemode: boolean; behavior: "skip" | "mindbody_test" | "live"; mindbodyTest: boolean }} testModeDecision
 * @returns {{ skipMindbodyIssue: boolean; mindbodyTest: boolean }}
 */
export function resolveAnnualSkipMindbodyIssue(testModeDecision) {
  if (testModeDecision.stripeLivemode === true) {
    const qaSkipRequested =
      (process.env.ANNUAL_WEBHOOK_SKIP_MINDDBODY_ISSUE || "").trim() === "1";
    if (qaSkipRequested) {
      console.warn(
        JSON.stringify({
          event: "annual_test_skip_ignored_in_live_mode",
          detail:
            "ANNUAL_WEBHOOK_SKIP_MINDDBODY_ISSUE is ignored for Stripe live-mode events; Mindbody issuance proceeds.",
        }),
      );
    }
    return { skipMindbodyIssue: false, mindbodyTest: false };
  }

  const skipMindbodyIssue =
    (process.env.ANNUAL_WEBHOOK_SKIP_MINDDBODY_ISSUE || "").trim() === "1" ||
    testModeDecision.behavior === "skip";
  return {
    skipMindbodyIssue,
    mindbodyTest: testModeDecision.behavior === "mindbody_test",
  };
}

/**
 * @param {unknown} invoice
 */
export function extractAnnualTermFromInvoice(invoice) {
  if (!invoice || typeof invoice !== "object") {
    throw new Error("invalid_stripe_invoice");
  }
  const inv = /** @type {Record<string, unknown>} */ (invoice);
  /** @type {Record<string, unknown> | null} */
  let line = null;
  const lines = inv.lines;
  if (lines && typeof lines === "object") {
    const d = /** @type {Record<string, unknown>} */ (lines);
    if (Array.isArray(d.data) && d.data[0] && typeof d.data[0] === "object") {
      line = /** @type {Record<string, unknown>} */ (d.data[0]);
    }
  }
  const linePeriod =
    line?.period && typeof line.period === "object"
      ? /** @type {Record<string, unknown>} */ (line.period)
      : null;
  const periodStartRaw = linePeriod?.start ?? inv.period_start;
  const periodEndRaw = linePeriod?.end ?? inv.period_end;
  const periodStartSec =
    typeof periodStartRaw === "number"
      ? periodStartRaw
      : typeof periodStartRaw === "string"
        ? Number(periodStartRaw)
        : NaN;
  const periodEndSec =
    typeof periodEndRaw === "number"
      ? periodEndRaw
      : typeof periodEndRaw === "string"
        ? Number(periodEndRaw)
        : NaN;
  if (!Number.isFinite(periodStartSec) || !Number.isFinite(periodEndSec) || periodEndSec <= periodStartSec) {
    throw new Error("missing_stripe_invoice_period");
  }
  const stripePeriodStartAt = new Date(periodStartSec * 1000).toISOString();
  const stripePeriodEndAt = new Date(periodEndSec * 1000).toISOString();
  return {
    stripePeriodStartAt,
    stripePeriodEndAt,
    termStartDate: stripeInstantToBusinessDate(new Date(periodStartSec * 1000)),
    termEndDate: stripeInstantToBusinessDate(new Date(periodEndSec * 1000)),
  };
}

/**
 * @param {string | null | undefined} localSku
 */
export function resolveAnnualCatalogSku(localSku) {
  const item = getCatalogItem(typeof localSku === "string" ? localSku : "");
  if (!item || !isAnnualMembershipCatalogItem(item)) return null;
  if (!ANNUAL_SKU_DEFINITIONS[item.localSku]) return null;
  return item;
}

/**
 * @param {unknown} value
 */
function stripeId(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object" && "id" in value) {
    const id = /** @type {{ id?: unknown }} */ (value).id;
    if (typeof id === "string" && id.trim()) return id.trim();
  }
  return null;
}

/**
 * @param {unknown} invoice
 */
function resolveStripeSubscriptionIdForAnnualTerm(invoice, subscriptionRecord) {
  const invoiceSubId = extractStripeInvoiceSubscriptionId(invoice);
  return resolveAnnualStripeSubscriptionId({
    invoiceSubscriptionId: invoiceSubId,
    recordSubscriptionId: String(subscriptionRecord.stripeSubscriptionId || ""),
  });
}

/**
 * @param {{
 *   invoice: import("stripe").Stripe.Invoice;
 *   subscriptionRecord: Record<string, unknown>;
 *   store?: ReturnType<typeof openAnnualMembershipStore>;
 *   issueFn?: typeof issueAnnualMembershipPeriod;
 *   skipMindbodyIssue?: boolean;
 *   mindbodyTest?: boolean;
 * }} input
 */
export async function handleAnnualInvoicePaid(input) {
  const store = input.store ?? openAnnualMembershipStore();
  const issueFn = input.issueFn ?? issueAnnualMembershipPeriod;
  const invoice = input.invoice;
  const record = input.subscriptionRecord;

  const localSku = String(record.localSku || "");
  const catalogItem = resolveAnnualCatalogSku(localSku);
  if (!catalogItem) {
    console.warn(
      JSON.stringify({
        event: "annual_invoice_paid_unknown_sku",
        localSku,
        invoiceId: invoice.id,
        status: "fail_closed",
      }),
    );
    return { ok: false, status: "unknown_annual_sku", retryable: false };
  }

  const mindbodyClientId = Number(record.mindbodyClientId);
  if (!Number.isInteger(mindbodyClientId) || mindbodyClientId <= 0) {
    return { ok: false, status: "missing_mindbody_client_id", retryable: true };
  }

  let term;
  try {
    term = extractAnnualTermFromInvoice(invoice);
  } catch (err) {
    return {
      ok: false,
      status: "invalid_stripe_term",
      retryable: false,
      message: String(/** @type {{ message?: string }} */ (err)?.message ?? err),
    };
  }

  const annualDef = getAnnualSkuDefinition(localSku);
  const stripeInvoiceId = String(invoice.id);
  const stripeSubscriptionId = resolveStripeSubscriptionIdForAnnualTerm(invoice, record);
  if (!stripeSubscriptionId) {
    return { ok: false, status: "missing_stripe_subscription_id", retryable: true };
  }
  const stripeCustomerId = stripeId(invoice.customer) || String(record.stripeCustomerId || "");
  const stripePriceId =
    typeof invoice.lines?.data?.[0]?.price?.id === "string" ? invoice.lines.data[0].price.id : null;

  const termResult = await store.createAnnualTermWithPeriods({
    amareUserId: typeof record.amareUserId === "string" ? record.amareUserId : null,
    mindbodyClientId,
    stripeCustomerId,
    stripeSubscriptionId,
    stripeInvoiceId,
    stripePriceId,
    sku: localSku,
    status: "active",
    termStartDate: term.termStartDate,
    termEndDate: term.termEndDate,
    stripePeriodStartAt: term.stripePeriodStartAt,
    stripePeriodEndAt: term.stripePeriodEndAt,
    annualAmountCents: catalogItem.amountCents,
  });

  console.log(
    JSON.stringify({
      event: termResult.created ? "annual_term_created" : "annual_term_existing_idempotent",
      annual_membership_id: termResult.membership.id,
      stripe_invoice_id: stripeInvoiceId,
      stripe_subscription_id: stripeSubscriptionId,
      mindbody_client_id: mindbodyClientId,
      sku: localSku,
      term_start_date: term.termStartDate,
      term_end_date: term.termEndDate,
      period_count: termResult.periods.length,
    }),
  );

  const period0 = termResult.periods.find((p) => p.period_index === 0);
  if (!period0) {
    return { ok: false, status: "missing_period_zero", retryable: true };
  }

  /** @type {Record<string, unknown>} */
  let issueOutcome = { outcome: "skipped", period: period0 };
  if (period0.status === "issued") {
    issueOutcome = { outcome: "already_issued", period: period0 };
  } else if (
    period0.status === "ambiguous" ||
    period0.status === "manual_review" ||
    period0.status === "claiming"
  ) {
    issueOutcome = { outcome: "no_blind_retry", period: period0, status: period0.status };
  } else if (input.skipMindbodyIssue === true) {
    console.log(
      JSON.stringify({
        event: "period_issue_started",
        annual_membership_id: termResult.membership.id,
        period_id: period0.id,
        period_index: 0,
        sku: localSku,
        mindbody_client_id: mindbodyClientId,
        stripe_invoice_id: stripeInvoiceId,
        mode: "skip_mindbody_issue",
      }),
    );
    issueOutcome = { outcome: "skipped_mindbody_qa", period: period0 };
  } else if (period0.status === "pending" || period0.status === "failed") {
    console.log(
      JSON.stringify({
        event: "period_issue_started",
        annual_membership_id: termResult.membership.id,
        period_id: period0.id,
        period_index: 0,
        sku: localSku,
        mindbody_client_id: mindbodyClientId,
        stripe_invoice_id: stripeInvoiceId,
      }),
    );
    const issued = await issueFn(period0.id, {
      store,
      businessDate: currentBusinessDate(),
      mindbodyTest: input.mindbodyTest === true,
    });
    issueOutcome = issued;
    if (issued.outcome === "ISSUED") {
      console.log(
        JSON.stringify({
          event: "period_issued",
          annual_membership_id: termResult.membership.id,
          period_id: period0.id,
          period_index: 0,
          sku: localSku,
          mindbody_client_id: mindbodyClientId,
          stripe_invoice_id: stripeInvoiceId,
          mindbody_sale_id: issued.mindbodySaleId ?? null,
          mindbody_client_service_id: issued.mindbodyClientServiceId ?? null,
        }),
      );
    } else if (issued.outcome === "AMBIGUOUS") {
      console.warn(
        JSON.stringify({
          event: "period_ambiguous",
          annual_membership_id: termResult.membership.id,
          period_id: period0.id,
          period_index: 0,
          sku: localSku,
          stripe_invoice_id: stripeInvoiceId,
          reason: issued.reason ?? null,
        }),
      );
    } else if (issued.outcome === "DEFERRED_PREVIOUS_PERIOD_ACTIVE") {
      console.log(
        JSON.stringify({
          event: "period_deferred_previous_active",
          annual_membership_id: termResult.membership.id,
          period_id: period0.id,
          period_index: 0,
          sku: localSku,
        }),
      );
    } else if (issued.outcome === "FAILED" || issued.outcome === "PRE_REQUEST_FAILED") {
      console.warn(
        JSON.stringify({
          event: "period_failed",
          annual_membership_id: termResult.membership.id,
          period_id: period0.id,
          period_index: 0,
          sku: localSku,
          stripe_invoice_id: stripeInvoiceId,
          outcome: issued.outcome,
          reason: issued.reason ?? null,
        }),
      );
    }
  }

  return {
    ok: true,
    status: "annual_term_ready",
    created: termResult.created,
    membership: termResult.membership,
    periods: termResult.periods,
    period0Issue: issueOutcome,
    annualAmountCents: annualDef.annualTotalCents,
  };
}

/**
 * @param {{
 *   invoice: import("stripe").Stripe.Invoice;
 *   subscriptionRecord: Record<string, unknown>;
 *   subStore: { appendInvoiceSync: Function; patch: Function; get: Function };
 * }} input
 */
export async function handleAnnualInvoicePaymentFailed(input) {
  const { invoice, subscriptionRecord: record, subStore } = input;
  const localSku = String(record.localSku || "");
  if (!resolveAnnualCatalogSku(localSku)) {
    return { ok: true, status: "noop_not_annual", noop: true };
  }

  const nowIso = new Date().toISOString();
  const recordId = String(record.id);
  const existing = (record.invoices || []).find((e) => e && e.invoiceId === invoice.id);
  if (!existing) {
    await subStore.appendInvoiceSync(recordId, {
      invoiceId: invoice.id,
      amountPaidCents: 0,
      currency: (invoice.currency || record.currency || "usd").toLowerCase(),
      paidAt: nowIso,
      status: "skipped_payment_failed",
      mindbodySaleId: null,
      mindbodyTransactionId: null,
      retryCount: 0,
      firstAttemptAt: nowIso,
      lastAttemptAt: nowIso,
      lastError: "annual_renewal_payment_failed",
      lastErrorMessage: `Annual renewal invoice ${invoice.id} could not be collected; no new annual term created.`.slice(
        0,
        240,
      ),
    });
  }

  const billingReason = typeof invoice.billing_reason === "string" ? invoice.billing_reason : "";
  const isRenewal = billingReason === "subscription_cycle" || billingReason === "subscription_update";
  if (
    record.status !== "past_due" &&
    record.status !== "canceled_admin" &&
    record.status !== "canceled_payment_failure"
  ) {
    await subStore.patch(recordId, { status: "past_due" });
  }

  console.warn(
    JSON.stringify({
      event: "annual_renewal_failed",
      subscriptionId: recordId,
      stripe_invoice_id: invoice.id,
      stripe_subscription_id: record.stripeSubscriptionId ?? null,
      sku: localSku,
      billing_reason: billingReason || null,
      is_renewal: isRenewal,
      note: "Existing paid annual DB terms are not revoked by renewal failure.",
    }),
  );

  return { ok: true, status: "annual_renewal_failed", noop: false, isRenewal };
}

/**
 * @param {{ subscriptionRecord: Record<string, unknown>; stripeSubscription: import("stripe").Stripe.Subscription }} input
 */
export function describeAnnualCancellationSemantics(input) {
  return {
    dbEntitlement: "paid_annual_term_remains_until_term_end_date",
    stripeRenewal: "canceled_subscription_prevents_future_yearly_invoice",
    refundRevocation: "not_implemented_v1",
    recordStatus: input.subscriptionRecord.status ?? null,
    stripeStatus: input.stripeSubscription.status ?? null,
    cancelAtPeriodEnd: input.stripeSubscription.cancel_at_period_end === true,
  };
}

export const __testing = {
  extractAnnualTermFromInvoice,
  resolveAnnualCatalogSku,
  resolveAnnualSkipMindbodyIssue,
  resolveStripeSubscriptionIdForAnnualTerm,
};
