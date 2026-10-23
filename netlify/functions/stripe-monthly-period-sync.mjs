/**
 * Phase 1 — a monthly Stripe invoice that failed and was later paid
 * gets exactly one Mindbody Pricing Option through the existing
 * CheckoutShoppingCart flow.
 *
 * Mindbody sets ActiveDate and ExpirationDate from the sale date.
 * This module does not call updateclientservice and does not backdate.
 * Overlapping packages are allowed. Booking order is unchanged.
 *
 * Annual memberships and one-time packs do not use this module.
 */

import { isPreRequestSyncFailure } from "./stripe-onetime-fulfillment.mjs";
import { syncOneTimePurchaseToMindbody } from "./stripe-mindbody-sync-lib.mjs";

/** Minimum claim age before admin recovery may take it over (blocks two concurrent admin retries). */
const ADMIN_CLAIM_TAKEOVER_MS = 60 * 1000;

/** Statuses a later invoice.paid must not treat as finished. */
export const MONTHLY_RETRYABLE_INVOICE_STATUSES = new Set([
  "skipped_payment_failed",
  "mindbody_dates_pending",
  "mindbody_sale_uncertain",
]);

/**
 * A `paid_but_not_synced` row is safe to retry only when Mindbody was never contacted for it:
 * the pre-request failure path marks it `retryOnRedelivery` and clears `checkoutRequestSentAt`.
 * Older rows without the marker stay admin-only.
 * @param {{ status?: string, mindbodySaleId?: string | null, checkoutRequestSentAt?: string | null, retryOnRedelivery?: boolean } | null | undefined} entry
 */
export function paidButNotSyncedIsRetryable(entry) {
  return Boolean(
    entry &&
      entry.status === "paid_but_not_synced" &&
      entry.retryOnRedelivery === true &&
      !entry.checkoutRequestSentAt &&
      !entry.mindbodySaleId,
  );
}

/**
 * @param {{ status?: string, mindbodySaleId?: string | null, checkoutRequestSentAt?: string | null, retryOnRedelivery?: boolean } | null | undefined} entry
 * @returns {
 *   "sync" |
 *   "verify_paid_then_sync" |
 *   "resume_without_checkout" |
 *   "noop_synced" |
 *   "admin_only" |
 *   "noop_terminal"
 * }
 */
export function monthlyInvoicePaidAction(entry) {
  if (!entry) return "sync";
  const status = String(entry.status || "");
  if (status === "synced") return "noop_synced";
  if (status === "paid_but_not_synced") return paidButNotSyncedIsRetryable(entry) ? "sync" : "admin_only";
  if (status === "mindbody_sale_uncertain" || status === "mindbody_dates_pending") {
    return "resume_without_checkout";
  }
  if (status === "skipped_payment_failed") return "verify_paid_then_sync";
  return "noop_terminal";
}

/**
 * @param {unknown} invoice
 * @returns {{ ok: true, amountPaidCents: number } | { ok: false, reason: string }}
 */
export function assertInvoiceCollected(invoice) {
  if (!invoice || typeof invoice !== "object") return { ok: false, reason: "stripe_invoice_missing" };
  const row = /** @type {{ status?: unknown, amount_paid?: unknown }} */ (invoice);
  if (row.status !== "paid") return { ok: false, reason: "stripe_invoice_not_paid" };
  const paid = typeof row.amount_paid === "number" ? row.amount_paid : Number(row.amount_paid);
  if (!Number.isFinite(paid) || paid <= 0) return { ok: false, reason: "stripe_invoice_unpaid_amount" };
  return { ok: true, amountPaidCents: Math.round(paid) };
}

/**
 * Read-only plan. Does not check out, charge, or edit service dates.
 *
 * @param {{
 *   entry: { status?: string, mindbodySaleId?: string | null, checkoutRequestSentAt?: string | null } | null,
 *   liveInvoice: unknown,
 *   claimHeldWithoutOwner?: boolean,
 * }} input
 */
export function buildMonthlyReconcileReport(input) {
  const entry = input.entry || null;
  const action = monthlyInvoicePaidAction(entry);
  const collected = assertInvoiceCollected(input.liveInvoice);
  const hasSale = Boolean(entry?.mindbodySaleId);
  const checkoutBlocked = Boolean(
    hasSale ||
      entry?.checkoutRequestSentAt ||
      entry?.status === "mindbody_sale_uncertain" ||
      entry?.status === "mindbody_dates_pending" ||
      input.claimHeldWithoutOwner === true,
  );
  /** @type {string} */
  let plan = action;
  if (action === "noop_synced" || action === "noop_terminal" || action === "admin_only") {
    plan = action;
  } else if (!collected.ok) {
    plan = "leave_unpaid";
  } else if (hasSale) {
    plan = "attach_existing_sale";
  } else if (checkoutBlocked) {
    plan = "hold_uncertain_no_second_checkout";
  } else {
    plan = "checkout_once";
  }
  return {
    dryRun: true,
    phase: 1,
    plan,
    invoiceAction: action,
    stripePaid: collected.ok === true,
    stripeBlockReason: collected.ok ? null : collected.reason,
    amountPaidCents: collected.ok ? collected.amountPaidCents : null,
    wouldCheckout: plan === "checkout_once",
    wouldCreateStripeInvoice: false,
    wouldChargeAgain: false,
    wouldCallUpdateClientService: false,
    wouldBackdate: false,
    mindbodyAssignsDatesFromSale: plan === "checkout_once" || plan === "attach_existing_sale",
    overlappingPackagesAllowed: true,
    wouldChangeCredits: false,
    checkoutBlocked,
    bookingOrderUnchanged: true,
  };
}

/**
 * @param {import("./stripe-subscription-store.mjs").SubscriptionRecord} record
 * @param {string} invoiceId
 * @param {import("./stripe-subscription-store.mjs").InvoiceSyncEntry} base
 * @param {Partial<import("./stripe-subscription-store.mjs").InvoiceSyncEntry>} partial
 * @param {ReturnType<import("./stripe-subscription-store.mjs").openSubscriptionStore>} subStore
 */
async function persistInvoice(record, invoiceId, base, partial, subStore) {
  const fresh = await subStore.get(record.id);
  const exists = (fresh?.invoices || []).some((row) => row && row.invoiceId === invoiceId);
  if (exists) return subStore.updateInvoiceSync(record.id, invoiceId, partial);
  return subStore.appendInvoiceSync(record.id, { ...base, ...partial, invoiceId });
}

/**
 * @param {{
 *   subStore: ReturnType<import("./stripe-subscription-store.mjs").openSubscriptionStore>,
 *   record: import("./stripe-subscription-store.mjs").SubscriptionRecord,
 *   invoice: { id: string, currency?: string },
 *   existingEntry?: import("./stripe-subscription-store.mjs").InvoiceSyncEntry | null,
 *   item: { localSku?: string },
 *   retrieveInvoice: (invoiceId: string) => Promise<unknown>,
 *   syncFn: (input: Record<string, unknown>) => Promise<{ ok: boolean, reason?: string, message?: string, mindbodySaleId?: string | null, mindbodyClientServiceId?: string | null }>,
 *   claimAlreadyAcquired?: boolean,
 *   lostClaim?: boolean,
 *   mindbodyTest?: boolean,
 *   discountAmountCents?: number,
 *   promotionCode?: string,
 *   couponId?: string,
 *   nowMs?: number,
 *   confirmNoMindbodySale?: boolean,
 *   adminRetry?: boolean,
 * }} input
 */
export async function executeMonthlyRenewalSync(input) {
  const invoiceId = input.invoice.id;
  const entry = input.existingEntry || null;
  const action = monthlyInvoicePaidAction(entry);
  /**
   * Admin recovery may re-attempt a `paid_but_not_synced` row that has no sale id. A row whose
   * cart may already have been sent still falls into the uncertain guard below, so this can
   * never post a second cart without `confirmNoMindbodySale`.
   */
  const adminRecoverable = action === "admin_only" && input.adminRetry === true && !entry?.mindbodySaleId;
  if (action === "noop_synced" || action === "noop_terminal" || (action === "admin_only" && !adminRecoverable)) {
    return { ok: true, status: entry?.status || "noop", noop: true, persisted: false };
  }

  /**
   * Exits before any Mindbody request must hand back a claim this caller holds; otherwise every
   * webhook redelivery would see a held claim with no record and could never recover.
   */
  const releaseHeldClaim = async () => {
    if (input.claimAlreadyAcquired === true && typeof input.subStore.releaseInvoiceClaim === "function") {
      await input.subStore.releaseInvoiceClaim(input.record.id, invoiceId);
    }
  };

  let live;
  try {
    live = await input.retrieveInvoice(invoiceId);
  } catch (err) {
    await releaseHeldClaim();
    return {
      ok: false,
      status: "stripe_retrieve_failed",
      retryable: true,
      reason: "stripe_retrieve_failed",
      persisted: false,
      message: String(/** @type {{ message?: string }} */ (err)?.message || err).slice(0, 180),
    };
  }
  const collected = assertInvoiceCollected(live);
  if (!collected.ok) {
    await releaseHeldClaim();
    return {
      ok: true,
      status: entry?.status || "skipped_payment_failed",
      noop: true,
      reason: collected.reason,
      persisted: false,
    };
  }

  const nowIso = new Date(input.nowMs || Date.now()).toISOString();
  const paidAt =
    live &&
    typeof live === "object" &&
    typeof /** @type {{ status_transitions?: { paid_at?: number } }} */ (live).status_transitions?.paid_at === "number"
      ? new Date(
          /** @type {{ status_transitions: { paid_at: number } }} */ (live).status_transitions.paid_at * 1000,
        ).toISOString()
      : nowIso;
  /** @type {import("./stripe-subscription-store.mjs").InvoiceSyncEntry} */
  const base = {
    invoiceId,
    amountPaidCents: collected.amountPaidCents,
    currency: (input.invoice.currency || input.record.currency || "usd").toLowerCase(),
    paidAt,
    status: "paid_but_not_synced",
    mindbodySaleId: entry?.mindbodySaleId ?? null,
    mindbodyTransactionId: entry?.mindbodyTransactionId ?? null,
    mindbodyClientServiceId: entry?.mindbodyClientServiceId ?? null,
    retryCount: entry?.retryCount || 0,
    firstAttemptAt: entry?.firstAttemptAt || nowIso,
    lastAttemptAt: nowIso,
    discountAmountCents: input.discountAmountCents || 0,
    promotionCode: input.promotionCode,
    couponId: input.couponId,
  };

  if (entry?.mindbodySaleId) {
    await persistInvoice(
      input.record,
      invoiceId,
      base,
      {
        status: "synced",
        amountPaidCents: collected.amountPaidCents,
        mindbodySaleId: entry.mindbodySaleId,
        mindbodyClientServiceId: entry.mindbodyClientServiceId || null,
        lastError: undefined,
        lastErrorMessage: undefined,
        adminRetryRequired: false,
      },
      input.subStore,
    );
    return {
      ok: true,
      status: "synced",
      persisted: true,
      linkedExisting: true,
      mindbodySaleId: entry.mindbodySaleId,
      mindbodyClientServiceId: entry.mindbodyClientServiceId || null,
    };
  }

  const priorSent = Boolean(entry?.checkoutRequestSentAt);
  const blockCheckout =
    input.lostClaim === true ||
    priorSent ||
    entry?.status === "mindbody_sale_uncertain" ||
    entry?.status === "mindbody_dates_pending";
  const humanConfirmedFreshCheckout = input.confirmNoMindbodySale === true && input.lostClaim !== true;

  if (blockCheckout && !humanConfirmedFreshCheckout) {
    if (!priorSent && input.lostClaim === true) {
      return { ok: false, status: "claim_in_progress", retryable: true, persisted: false, reason: "claim_in_progress" };
    }
    await persistInvoice(
      input.record,
      invoiceId,
      base,
      {
        status: "mindbody_sale_uncertain",
        amountPaidCents: collected.amountPaidCents,
        checkoutRequestSentAt: entry?.checkoutRequestSentAt || nowIso,
        mindbodySaleId: null,
        lastError: "checkout_blocked_pending_sale_id",
        lastErrorMessage: "Checkout may already have been sent. A second sale was not created.",
        adminRetryRequired: true,
      },
      input.subStore,
    );
    return { ok: true, status: "mindbody_sale_uncertain", persisted: true, reason: "checkout_blocked_pending_sale_id" };
  }

  if (input.claimAlreadyAcquired !== true) {
    let claim = await input.subStore.claimInvoiceSlot(input.record.id, invoiceId, {});
    if (!claim.ok) {
      return { ok: false, status: "claim_store_unavailable", retryable: true, persisted: false, reason: claim.reason };
    }
    /**
     * Admin recovery of a row that proves no cart was sent (checked above via `blockCheckout`)
     * may take over the finished handler's leftover claim.
     */
    if (!claim.acquired && adminRecoverable && typeof input.subStore.takeOverStaleInvoiceClaim === "function") {
      claim = await input.subStore.takeOverStaleInvoiceClaim(input.record.id, invoiceId, { staleMs: ADMIN_CLAIM_TAKEOVER_MS });
      if (!claim.ok) {
        return { ok: false, status: "claim_store_unavailable", retryable: true, persisted: false, reason: claim.reason };
      }
    }
    if (!claim.acquired) {
      return { ok: false, status: "claim_in_progress", retryable: true, persisted: false, reason: "claim_in_progress" };
    }
  }

  await persistInvoice(
    input.record,
    invoiceId,
    base,
    {
      status: "mindbody_sale_uncertain",
      amountPaidCents: collected.amountPaidCents,
      checkoutRequestSentAt: nowIso,
      mindbodySaleId: null,
      lastError: "checkout_request_in_flight",
      adminRetryRequired: true,
      retryOnRedelivery: false,
    },
    input.subStore,
  );

  const sync = await input.syncFn({
    orderId: `${input.record.id}_${invoiceId}`,
    stripeCheckoutSessionId: input.record.stripeCheckoutSessionId || `inv_${invoiceId}`,
    localSku: input.record.localSku,
    clientId: input.record.mindbodyClientId,
    amountCents: input.record.monthlyAmountCents,
    paidAmountCents: collected.amountPaidCents,
    discountAmountCents: input.discountAmountCents || 0,
    promotionCode: input.promotionCode,
    couponId: input.couponId,
    currency: base.currency,
    mindbodyTest: input.mindbodyTest === true,
    item: input.item,
  });

  if (!sync.ok && isPreRequestSyncFailure(sync.reason)) {
    await persistInvoice(
      input.record,
      invoiceId,
      base,
      {
        status: entry?.status === "skipped_payment_failed" ? "skipped_payment_failed" : "paid_but_not_synced",
        checkoutRequestSentAt: null,
        amountPaidCents: entry?.status === "skipped_payment_failed" ? 0 : collected.amountPaidCents,
        mindbodySaleId: null,
        lastError: sync.reason,
        lastErrorMessage: String(sync.message || sync.reason || "").slice(0, 480),
        adminRetryRequired: entry?.status !== "skipped_payment_failed",
        retryOnRedelivery: true,
      },
      input.subStore,
    );
    if (typeof input.subStore.releaseInvoiceClaim === "function") {
      await input.subStore.releaseInvoiceClaim(input.record.id, invoiceId);
    }
    return { ok: false, status: "pre_request_failed", retryable: true, persisted: true, reason: sync.reason };
  }

  if (!sync.ok || !sync.mindbodySaleId) {
    await persistInvoice(
      input.record,
      invoiceId,
      base,
      {
        status: "mindbody_sale_uncertain",
        amountPaidCents: collected.amountPaidCents,
        checkoutRequestSentAt: nowIso,
        mindbodySaleId: sync.mindbodySaleId || null,
        mindbodyClientServiceId: sync.mindbodyClientServiceId || null,
        lastError: sync.reason || "sale_id_missing",
        lastErrorMessage: String(sync.message || "Checkout result is uncertain. Not posting another cart.").slice(0, 480),
        adminRetryRequired: true,
      },
      input.subStore,
    );
    return {
      ok: true,
      status: "mindbody_sale_uncertain",
      persisted: true,
      reason: sync.reason || "sale_id_missing",
      mindbodySaleId: sync.mindbodySaleId || null,
    };
  }

  await persistInvoice(
    input.record,
    invoiceId,
    base,
    {
      status: "synced",
      amountPaidCents: collected.amountPaidCents,
      mindbodySaleId: sync.mindbodySaleId,
      mindbodyClientServiceId: sync.mindbodyClientServiceId || null,
      checkoutRequestSentAt: nowIso,
      lastError: undefined,
      lastErrorMessage: undefined,
      adminRetryRequired: false,
    },
    input.subStore,
  );
  return {
    ok: true,
    status: "synced",
    persisted: true,
    mindbodySaleId: sync.mindbodySaleId,
    mindbodyClientServiceId: sync.mindbodyClientServiceId || null,
  };
}

/** Existing cart. No service-date update. */
export function createMonthlyMindbodyIO() {
  return { syncFn: syncOneTimePurchaseToMindbody };
}
