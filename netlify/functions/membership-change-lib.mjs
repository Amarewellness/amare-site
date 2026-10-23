/**
 * Pure policy for admin membership plan changes (monthly Stripe-managed memberships).
 *
 * Every price, Mindbody service id and contract product comes from the embedded catalog via
 * `getCatalogItem()`. Nothing here talks to Stripe, Mindbody, Blobs or Postgres — the service
 * module (`membership-change-service.mjs`) does I/O and calls into these helpers.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { getCatalogItem } from "./stripe-catalog-lib.mjs";

export const MEMBERSHIP_CHANGE_SKUS = Object.freeze(["monthly_5", "monthly_8", "monthly_unlimited"]);

export const BILLING_POLICIES = Object.freeze({
  new_cycle_no_credit: Object.freeze({
    id: "new_cycle_no_credit",
    timing: "immediate",
    label: "New billing cycle today, full new price, no credit",
    stripe: { proration_behavior: "none", billing_cycle_anchor: "now" },
  }),
  new_cycle_with_credit: Object.freeze({
    id: "new_cycle_with_credit",
    timing: "immediate",
    label: "New billing cycle today, credit for unused time on current plan",
    stripe: { proration_behavior: "always_invoice", billing_cycle_anchor: "now" },
  }),
  scheduled_no_charge: Object.freeze({
    id: "scheduled_no_charge",
    timing: "next_cycle",
    label: "Switch at next billing date, nothing charged today",
    stripe: null,
  }),
});

/** Immediate changes are refused this close to the renewal so the change cannot race renewal invoicing. */
export const RENEWAL_GUARD_MS = 2 * 60 * 60 * 1000;
export const PREVIEW_TOKEN_TTL_MS = 10 * 60 * 1000;
/** A scheduled transition invoice may start slightly before the stored effective time (clock skew). */
const PENDING_EFFECTIVE_TOLERANCE_MS = 6 * 60 * 60 * 1000;

/** Warning codes the admin must explicitly acknowledge before execute. */
export const ACK_REQUIRED_WARNINGS = Object.freeze([
  "grandfathered_price",
  "subscription_discount_present",
  "target_agreement_not_on_file",
  "future_bookings_after_effective",
  "unused_credits_with_stripe_credit",
]);

/** @param {string} sku */
export function isMembershipChangeSku(sku) {
  return MEMBERSHIP_CHANGE_SKUS.includes(String(sku || ""));
}

/** @param {string} sku */
export function catalogPlan(sku) {
  if (!isMembershipChangeSku(sku)) return null;
  const item = getCatalogItem(sku);
  if (!item || item.kind !== "monthlyMembership" || item.stripeMode !== "subscription") return null;
  return item;
}

export function listCatalogPlans() {
  return MEMBERSHIP_CHANGE_SKUS.map((sku) => catalogPlan(sku))
    .filter(Boolean)
    .map((item) => ({
      sku: item.localSku,
      displayName: item.displayName,
      description: item.description,
      amountCents: item.amountCents,
      currency: item.currency,
      mindbodyServiceId: item.mindbodyServiceId,
      mindbodyContractProductId: item.mindbodyContractProductId,
      minimumCommitmentMonths: item.minimumCommitmentMonths,
      enabled: item.enabled === true,
      unlimited: item.localSku === "monthly_unlimited",
    }));
}

/**
 * Direction comes from catalog list prices, never from client input.
 * @param {string} fromSku @param {string} toSku
 * @returns {"upgrade" | "downgrade" | null}
 */
export function changeDirection(fromSku, toSku) {
  const a = catalogPlan(fromSku);
  const b = catalogPlan(toSku);
  if (!a || !b || a.localSku === b.localSku) return null;
  return b.amountCents > a.amountCents ? "upgrade" : "downgrade";
}

/**
 * Policies an admin may choose for a direction. Downgrades only switch at the next billing date
 * (no refund for unused access; current entitlement stays until renewal).
 * @param {"upgrade" | "downgrade"} direction
 */
export function allowedPoliciesForDirection(direction) {
  if (direction === "upgrade") {
    return ["new_cycle_no_credit", "new_cycle_with_credit", "scheduled_no_charge"];
  }
  if (direction === "downgrade") return ["scheduled_no_charge"];
  return [];
}

/** @param {string} policy */
export function policyTiming(policy) {
  const p = BILLING_POLICIES[/** @type {keyof typeof BILLING_POLICIES} */ (policy)];
  return p ? p.timing : null;
}

/**
 * Record fields that define the plan for webhook fulfillment. Commitment dates, consent pointers
 * and invoice history are deliberately absent so a plan change never rewrites them.
 * @param {string} sku
 */
export function planFieldsForSku(sku) {
  const item = catalogPlan(sku);
  if (!item) throw new Error(`membership_change_unknown_sku:${sku}`);
  const pct = item.earlyCancellationFeePercent;
  return {
    localSku: item.localSku,
    displayName: item.displayName,
    monthlyAmountCents: item.amountCents,
    mindbodyServiceId: item.mindbodyServiceId,
    mindbodyContractProductId: item.mindbodyContractProductId,
    earlyCancellationFeeCents:
      typeof pct === "number" && pct > 0 ? Math.round((item.amountCents * pct) / 100) : null,
  };
}

/** @param {Record<string, unknown>} record */
export function snapshotPlanFields(record) {
  return {
    localSku: record.localSku ?? null,
    displayName: record.displayName ?? null,
    monthlyAmountCents: record.monthlyAmountCents ?? null,
    mindbodyServiceId: record.mindbodyServiceId ?? null,
    mindbodyContractProductId: record.mindbodyContractProductId ?? null,
    earlyCancellationFeeCents: record.earlyCancellationFeeCents ?? null,
  };
}

/**
 * Stripe subscription metadata after the change. Keeps consent / agreement keys untouched.
 * @param {Record<string, string>} existing
 * @param {string} sku
 * @param {{ operationId: string }} extra
 */
export function subscriptionMetadataForSku(existing, sku, extra) {
  const item = catalogPlan(sku);
  if (!item) throw new Error(`membership_change_unknown_sku:${sku}`);
  return {
    ...(existing || {}),
    localSku: item.localSku,
    mindbodyServiceId: String(item.mindbodyServiceId),
    mindbodyContractProductId: String(item.mindbodyContractProductId),
    lastPlanChangeOperationId: extra.operationId,
  };
}

/** @param {unknown} v */
function unixToIso(v) {
  return typeof v === "number" && Number.isFinite(v) ? new Date(v * 1000).toISOString() : null;
}

/**
 * @param {any} sub Stripe subscription (items.data.price expanded)
 */
export function readSubscriptionShape(sub) {
  const items = Array.isArray(sub?.items?.data) ? sub.items.data : [];
  const item = items[0] || null;
  const price = item && typeof item.price === "object" ? item.price : null;
  return {
    id: sub?.id ?? null,
    status: sub?.status ?? null,
    livemode: sub?.livemode === true,
    customerId: typeof sub?.customer === "string" ? sub.customer : sub?.customer?.id ?? null,
    itemCount: items.length,
    itemId: item?.id ?? null,
    quantity: item?.quantity ?? 1,
    priceId: price?.id ?? (typeof item?.price === "string" ? item.price : null),
    productId: price ? (typeof price.product === "string" ? price.product : price.product?.id ?? null) : null,
    unitAmount: typeof price?.unit_amount === "number" ? price.unit_amount : null,
    interval: price?.recurring?.interval ?? null,
    periodStart: unixToIso(item?.current_period_start ?? sub?.current_period_start),
    periodEnd: unixToIso(item?.current_period_end ?? sub?.current_period_end),
    cancelAtPeriodEnd: sub?.cancel_at_period_end === true,
    cancelAt: unixToIso(sub?.cancel_at),
    pauseCollection: sub?.pause_collection ?? null,
    pendingUpdate: Boolean(sub?.pending_update),
    scheduleId: typeof sub?.schedule === "string" ? sub.schedule : sub?.schedule?.id ?? null,
    discountCount: Array.isArray(sub?.discounts) ? sub.discounts.length : sub?.discount ? 1 : 0,
    latestInvoiceId:
      typeof sub?.latest_invoice === "string" ? sub.latest_invoice : sub?.latest_invoice?.id ?? null,
    metadata: sub?.metadata && typeof sub.metadata === "object" ? sub.metadata : {},
  };
}

/**
 * Stable digest of the subscription facts a preview depends on. Any change → stale preview.
 * @param {ReturnType<typeof readSubscriptionShape>} shape
 * @param {Record<string, unknown>} record
 */
export function subscriptionFingerprint(shape, record) {
  const basis = {
    id: shape.id,
    status: shape.status,
    itemId: shape.itemId,
    priceId: shape.priceId,
    unitAmount: shape.unitAmount,
    periodStart: shape.periodStart,
    periodEnd: shape.periodEnd,
    cancelAtPeriodEnd: shape.cancelAtPeriodEnd,
    scheduleId: shape.scheduleId,
    pendingUpdate: shape.pendingUpdate,
    latestInvoiceId: shape.latestInvoiceId,
    recordSku: record.localSku ?? null,
    recordStatus: record.status ?? null,
  };
  return createHash("sha256").update(JSON.stringify(basis)).digest("hex").slice(0, 32);
}

/**
 * @typedef {{ code: string, message: string, ackRequired?: boolean, detail?: unknown }} ChangeNotice
 */

/**
 * Subscription-level blockers (independent of the target plan).
 * @param {{
 *   record: Record<string, any>,
 *   shape: ReturnType<typeof readSubscriptionShape>,
 *   openInvoiceCount: number,
 *   activeOperation: { id: string, status: string } | null,
 * }} input
 * @returns {ChangeNotice[]}
 */
export function subscriptionBlockers(input) {
  const { record, shape } = input;
  /** @type {ChangeNotice[]} */
  const out = [];
  if (!catalogPlan(String(record.localSku || ""))) {
    out.push({
      code: "unsupported_plan",
      message: `Plan "${record.localSku}" is not a Stripe-managed Monthly 5 / 8 / Unlimited membership. Change it in Mindbody or the Stripe Dashboard.`,
    });
  }
  if (!/^sub_[A-Za-z0-9]+$/.test(String(record.stripeSubscriptionId || ""))) {
    out.push({ code: "not_linked_to_stripe", message: "This membership has no linked Stripe subscription yet." });
  }
  if (record.status !== "active") {
    out.push({
      code: "membership_not_active",
      message: `Membership status is "${record.status}". Only active memberships can change plan (resolve payment failures first).`,
    });
  }
  if (shape.status && shape.status !== "active") {
    out.push({ code: "stripe_not_active", message: `Stripe subscription status is "${shape.status}".` });
  }
  if (shape.customerId && record.stripeCustomerId && shape.customerId !== record.stripeCustomerId) {
    out.push({ code: "customer_mismatch", message: "Stripe customer does not match the AMARÉ record." });
  }
  if (shape.itemCount !== 1) {
    out.push({ code: "multi_item_subscription", message: "Subscription has more than one item; change it in Stripe." });
  }
  if (shape.quantity !== 1) {
    out.push({ code: "quantity_not_one", message: "Subscription quantity is not 1." });
  }
  if (shape.interval && shape.interval !== "month") {
    out.push({ code: "not_monthly", message: "Subscription is not billed monthly." });
  }
  if (shape.pauseCollection) {
    out.push({ code: "membership_frozen", message: "Billing is paused (membership frozen). Unfreeze before changing plan." });
  }
  if (shape.cancelAtPeriodEnd || shape.cancelAt || record.cancelAt) {
    out.push({
      code: "cancellation_scheduled",
      message: "A cancellation is scheduled. Remove it in Stripe before changing plan.",
    });
  }
  if (shape.pendingUpdate) {
    out.push({ code: "stripe_pending_update", message: "Stripe has a pending subscription update awaiting payment." });
  }
  if (input.openInvoiceCount > 0) {
    out.push({
      code: "outstanding_invoice",
      message: "This subscription has an open or draft invoice. Resolve it before changing plan.",
    });
  }
  if (input.activeOperation) {
    out.push({
      code: "operation_in_progress",
      message: `A plan change is already ${input.activeOperation.status.replace(/_/g, " ")} for this membership.`,
      detail: { operationId: input.activeOperation.id, status: input.activeOperation.status },
    });
  } else if (shape.scheduleId) {
    out.push({
      code: "existing_stripe_schedule",
      message: "Stripe already has a subscription schedule for this membership. Release it in Stripe first.",
    });
  }
  if (record.pendingPlanChange && !input.activeOperation) {
    out.push({
      code: "pending_change_without_operation",
      message: "The record carries a pending plan change without a ledger operation. Reconcile before changing.",
    });
  }
  return out;
}

/**
 * Plan / timing level blockers and warnings.
 * @param {{
 *   record: Record<string, any>,
 *   shape: ReturnType<typeof readSubscriptionShape>,
 *   toSku: string,
 *   policy: string,
 *   nowMs: number,
 *   catalogProductReady: boolean,
 *   currentPackage: { remaining: number | null, unlimited: boolean } | null,
 *   futureVisits: Array<{ startDateTime: string, name?: string }> | null,
 *   targetAgreementOnFile: boolean | null,
 * }} input
 */
export function evaluateChange(input) {
  const { record, shape, toSku, policy, nowMs } = input;
  /** @type {ChangeNotice[]} */
  const blockers = [];
  /** @type {ChangeNotice[]} */
  const warnings = [];
  const fromSku = String(record.localSku || "");
  const target = catalogPlan(toSku);
  const current = catalogPlan(fromSku);
  const direction = changeDirection(fromSku, toSku);

  if (!target) blockers.push({ code: "unknown_target_plan", message: "Choose Monthly 5, Monthly 8 or Monthly Unlimited." });
  else if (target.enabled !== true) blockers.push({ code: "target_plan_disabled", message: `${target.displayName} is not currently sold.` });
  if (fromSku === toSku) blockers.push({ code: "same_plan", message: "That is already the current plan." });
  if (!direction) return { direction: null, timing: null, blockers, warnings, effectiveAt: null };

  const allowed = allowedPoliciesForDirection(direction);
  if (!allowed.includes(policy)) {
    blockers.push({
      code: "policy_not_allowed",
      message:
        direction === "downgrade"
          ? "Downgrades switch at the next billing date."
          : "That billing option is not available for this change.",
    });
  }
  const timing = policyTiming(policy);
  const periodEndMs = shape.periodEnd ? Date.parse(shape.periodEnd) : NaN;

  if (timing === "immediate") {
    if (Number.isFinite(periodEndMs) && periodEndMs - nowMs < RENEWAL_GUARD_MS) {
      blockers.push({
        code: "too_close_to_renewal",
        message: "Renewal is less than 2 hours away. Wait for the renewal, or schedule the change for the next billing date.",
      });
    }
  }
  if (timing === "next_cycle") {
    if (!Number.isFinite(periodEndMs) || periodEndMs <= nowMs) {
      blockers.push({ code: "period_end_unknown", message: "Next billing date is unknown." });
    }
  }
  if (!input.catalogProductReady) {
    blockers.push({
      code: "catalog_product_not_prepared",
      message: `Stripe has no active technical product for ${target?.displayName ?? toSku} yet. Prepare it first (one-time, no charge).`,
    });
  }

  if (current && typeof shape.unitAmount === "number" && shape.unitAmount !== current.amountCents) {
    warnings.push({
      code: "grandfathered_price",
      ackRequired: true,
      message: `Current Stripe price $${(shape.unitAmount / 100).toFixed(2)} differs from today's ${current.displayName} price $${(current.amountCents / 100).toFixed(2)}. The new plan bills at the catalog price; the old price will not be kept.`,
    });
  }
  if (shape.discountCount > 0) {
    warnings.push({
      code: "subscription_discount_present",
      ackRequired: true,
      message: "A Stripe discount/coupon is attached to this subscription and will keep applying after the change.",
    });
  }
  if (input.targetAgreementOnFile === false && target) {
    warnings.push({
      code: "target_agreement_not_on_file",
      ackRequired: true,
      message: `The customer's signed agreement covers their original plan, not ${target.displayName}. Confirm the customer agreed to the ${target.displayName} terms (the existing consent record is kept unchanged).`,
    });
  }

  const effectiveAt = timing === "next_cycle" ? shape.periodEnd : new Date(nowMs).toISOString();
  const effectiveMs = effectiveAt ? Date.parse(effectiveAt) : NaN;
  if (Array.isArray(input.futureVisits) && Number.isFinite(effectiveMs)) {
    const after = input.futureVisits.filter((v) => Date.parse(v.startDateTime) >= effectiveMs);
    if (after.length > 0 && (direction === "downgrade" || timing === "immediate")) {
      warnings.push({
        code: "future_bookings_after_effective",
        ackRequired: true,
        message: `${after.length} booked class(es) fall on or after the change date and were booked with the current package. Check them in Mindbody after the change.`,
        detail: after.slice(0, 20),
      });
    }
  } else if (input.futureVisits === null) {
    warnings.push({
      code: "future_bookings_unknown",
      message: "Could not read future bookings from Mindbody. Check them manually.",
    });
  }

  if (timing === "immediate" && input.currentPackage && !input.currentPackage.unlimited) {
    const remaining = input.currentPackage.remaining;
    if (typeof remaining === "number" && remaining > 0) {
      warnings.push({
        code: policy === "new_cycle_with_credit" ? "unused_credits_with_stripe_credit" : "unused_credits_remaining",
        ackRequired: policy === "new_cycle_with_credit",
        message:
          policy === "new_cycle_with_credit"
            ? `The current package still has ${remaining} class credit(s), which stay usable until they expire, and Stripe will also credit the unused time.`
            : `The current package still has ${remaining} class credit(s); they stay usable until they expire.`,
      });
    }
  }
  if (record.commitmentEndDate) {
    warnings.push({
      code: "commitment_preserved",
      message: `Original commitment end date ${String(record.commitmentEndDate).slice(0, 10)} is kept unchanged.`,
    });
  }
  if (toSku === "monthly_unlimited") {
    warnings.push({
      code: "unlimited_policies_apply",
      message: "Unlimited rules apply after the change: $10 late-cancel / no-show fee and Unlimited daily booking limits.",
    });
  } else if (fromSku === "monthly_unlimited") {
    warnings.push({
      code: "credit_policies_apply",
      message: "After the change, late cancels / no-shows deduct a class credit instead of the Unlimited $10 fee.",
    });
  }
  return { direction, timing, blockers, warnings, effectiveAt };
}

/**
 * @param {ChangeNotice[]} warnings
 * @param {Record<string, unknown>} acknowledgements
 */
export function missingAcknowledgements(warnings, acknowledgements) {
  return warnings
    .filter((w) => w.ackRequired && ACK_REQUIRED_WARNINGS.includes(w.code))
    .filter((w) => acknowledgements?.[w.code] !== true)
    .map((w) => w.code);
}

/**
 * Classify invoice-preview lines so unexpected charges block the change.
 * @param {any} preview Stripe `invoices.createPreview` result
 * @param {{ targetProductId: string, currentProductId: string | null, currentPriceId: string | null, policy: string }} ctx
 */
export function summarizePreviewInvoice(preview, ctx) {
  const lines = Array.isArray(preview?.lines?.data) ? preview.lines.data : [];
  /** @type {Array<{ description: string, amountCents: number, proration: boolean, kind: string, periodStart: string | null, periodEnd: string | null }>} */
  const out = [];
  let creditCents = 0;
  let targetLine = null;
  /** @type {string[]} */
  const unexpected = [];
  for (const l of lines) {
    const priceObj = l?.pricing?.price_details ?? l?.price ?? null;
    const product =
      (typeof priceObj?.product === "string" ? priceObj.product : priceObj?.product?.id) ?? null;
    const priceId = typeof l?.price === "object" ? l.price?.id : priceObj?.price ?? null;
    const proration = l?.proration === true || l?.parent?.subscription_item_details?.proration === true;
    const amount = Number(l?.amount ?? 0);
    let kind = "other";
    if (product && product === ctx.targetProductId && !proration) kind = "target_plan";
    else if (proration && amount < 0) kind = "credit_unused_time";
    else if (proration) kind = "proration_charge";
    else if ((product && product === ctx.currentProductId) || (priceId && priceId === ctx.currentPriceId)) kind = "current_plan";
    if (kind === "credit_unused_time") creditCents += amount;
    if (kind === "target_plan" && !targetLine) targetLine = l;
    if (kind === "other" || kind === "current_plan" || (kind === "proration_charge" && ctx.policy !== "new_cycle_with_credit")) {
      unexpected.push(String(l?.description || l?.id || "line"));
    }
    if (kind === "credit_unused_time" && ctx.policy !== "new_cycle_with_credit") {
      unexpected.push(String(l?.description || "credit"));
    }
    out.push({
      description: String(l?.description || ""),
      amountCents: amount,
      proration,
      kind,
      periodStart: unixToIso(l?.period?.start),
      periodEnd: unixToIso(l?.period?.end),
    });
  }
  return {
    amountDueCents: Number(preview?.amount_due ?? 0),
    subtotalCents: Number(preview?.subtotal ?? 0),
    totalCents: Number(preview?.total ?? 0),
    taxCents: Number(
      preview?.tax ??
        (Array.isArray(preview?.total_taxes) ? preview.total_taxes.reduce((s, t) => s + Number(t?.amount || 0), 0) : 0),
    ),
    discountCents: Array.isArray(preview?.total_discount_amounts)
      ? preview.total_discount_amounts.reduce((s, d) => s + Number(d?.amount || 0), 0)
      : 0,
    startingBalanceCents: Number(preview?.starting_balance ?? 0),
    creditCents,
    lines: out,
    targetLinePeriodStart: targetLine ? unixToIso(targetLine.period?.start) : null,
    targetLinePeriodEnd: targetLine ? unixToIso(targetLine.period?.end) : null,
    hasTargetLine: Boolean(targetLine),
    unexpectedLines: unexpected,
  };
}

/** @param {string} secret */
function previewKey(secret) {
  return createHmac("sha256", secret).update("amare-membership-change-preview-v1").digest();
}

/** @param {Buffer} buf */
function b64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * @param {Record<string, unknown>} payload
 * @param {string} secret
 */
export function signPreviewToken(payload, secret) {
  if (!secret || secret.length < 16) throw new Error("membership_change_preview_secret_missing");
  const body = b64url(Buffer.from(JSON.stringify({ v: 1, ...payload }), "utf8"));
  const sig = b64url(createHmac("sha256", previewKey(secret)).update(body).digest());
  return `${body}.${sig}`;
}

/**
 * @param {string} token
 * @param {string} secret
 * @param {number} nowMs
 * @returns {{ ok: true, payload: Record<string, any> } | { ok: false, reason: string }}
 */
export function verifyPreviewToken(token, secret, nowMs) {
  const parts = String(token || "").split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };
  const expected = b64url(createHmac("sha256", previewKey(secret)).update(parts[0]).digest());
  const a = Buffer.from(parts[1]);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "bad_signature" };
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[0].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (payload?.v !== 1) return { ok: false, reason: "version" };
  if (typeof payload.exp !== "number" || payload.exp < nowMs) return { ok: false, reason: "expired" };
  return { ok: true, payload };
}

/**
 * Decide whether a paid invoice is the transition invoice of a scheduled plan change.
 * Matching uses invoice content (renewal reason, period, target plan amount / subscription
 * metadata), never wall-clock time alone, so webhook retries and late deliveries stay correct.
 *
 * @param {{
 *   pending: { operationId?: string, toSku?: string, effectiveAt?: string } | null | undefined,
 *   invoice: any,
 *   subscriptionMetadataSku?: string | null,
 * }} input
 * @returns {{ apply: boolean, reason: string }}
 */
export function matchPendingPlanChangeToInvoice(input) {
  const pending = input.pending;
  if (!pending || !pending.toSku) return { apply: false, reason: "no_pending_change" };
  const target = catalogPlan(pending.toSku);
  if (!target) return { apply: false, reason: "pending_target_unknown" };
  const invoice = input.invoice || {};
  if (invoice.billing_reason !== "subscription_cycle") return { apply: false, reason: "not_renewal_invoice" };
  const lines = Array.isArray(invoice?.lines?.data) ? invoice.lines.data : [];
  const recurring = lines.filter((l) => l?.proration !== true);
  const periodStartSec = recurring.length
    ? Math.min(...recurring.map((l) => Number(l?.period?.start ?? Infinity)))
    : Number(invoice.period_end ?? NaN);
  const effectiveMs = Date.parse(String(pending.effectiveAt || ""));
  if (!Number.isFinite(effectiveMs)) return { apply: false, reason: "pending_effective_unknown" };
  if (!Number.isFinite(periodStartSec) || periodStartSec * 1000 < effectiveMs - PENDING_EFFECTIVE_TOLERANCE_MS) {
    return { apply: false, reason: "invoice_before_effective_date" };
  }
  const amountMatches = recurring.some(
    (l) =>
      Number(l?.amount) === target.amountCents ||
      Number(l?.pricing?.unit_amount_decimal ?? l?.price?.unit_amount ?? NaN) === target.amountCents,
  );
  const metadataMatches = input.subscriptionMetadataSku === pending.toSku;
  if (!amountMatches && !metadataMatches) return { apply: false, reason: "invoice_not_target_plan" };
  return { apply: true, reason: amountMatches ? "target_amount_line" : "subscription_metadata" };
}

/**
 * Pure transform: record after a scheduled change takes effect. Keeps commitment, consent and
 * invoice history; appends an audit entry.
 * @param {Record<string, any>} record
 * @param {{ invoiceId: string, appliedAt: string }} ctx
 */
export function applyPendingPlanChangeToRecord(record, ctx) {
  const pending = record.pendingPlanChange;
  if (!pending?.toSku) return null;
  const fields = planFieldsForSku(pending.toSku);
  const history = Array.isArray(record.planChangeHistory) ? record.planChangeHistory : [];
  return {
    ...fields,
    pendingPlanChange: null,
    planChangeHistory: [
      ...history,
      {
        operationId: pending.operationId ?? null,
        fromSku: pending.fromSku ?? record.localSku ?? null,
        toSku: pending.toSku,
        timing: "next_cycle",
        appliedAt: ctx.appliedAt,
        transitionInvoiceId: ctx.invoiceId,
        actorId: pending.actorId ?? null,
      },
    ].slice(-20),
  };
}
