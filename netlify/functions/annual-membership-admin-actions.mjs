/**
 * Admin mutations for annual prepaid memberships.
 * Action A: cancel Stripe renewal (current paid term unchanged).
 * Action B: revoke current term (skip future allocations).
 */

import Stripe from "stripe";

import {
  ANNUAL_ISSUANCE_ELIGIBLE_MEMBERSHIP_STATUSES,
  ANNUAL_TIMEZONE,
  assessAnnualPeriodRevokeEligibility,
  isPendingStripeSubscriptionId,
  isRealStripeSubscriptionId,
  stripeInstantToBusinessDate,
} from "./annual-membership-lib.mjs";
import { openAnnualMembershipStore, STALE_CLAIM_MS } from "./annual-membership-store.mjs";
import {
  recoverStaleAnnualClaims,
  reconcileAmbiguousAnnualPeriod,
} from "./annual-membership-issue.mjs";
import { getMindbodyStaffAccessTokenCached } from "./mindbody-consumer-lib.mjs";
import { mindbodyStaffBearerHeaders } from "./mindbody-upstream.mjs";

/**
 * @param {ReturnType<typeof openAnnualMembershipStore>} store
 * @param {string} membershipId
 * @param {{ headers?: Record<string, string>; now?: Date }} [opts]
 */
export async function prepareMembershipForRevoke(store, membershipId, opts = {}) {
  const now = opts.now ?? new Date();
  const staleBefore = new Date(now.getTime() - STALE_CLAIM_MS).toISOString();
  const staleRows = (await store.findStaleClaims(staleBefore)).filter(
    (p) => String(p.annual_membership_id) === String(membershipId),
  );
  if (opts.headers && staleRows.length) {
    await recoverStaleAnnualClaims({ store, headers: opts.headers, now });
  }

  const periods = await store.listPeriodsForMembership(membershipId);
  if (opts.headers) {
    for (const p of periods) {
      if (p.status !== "ambiguous") continue;
      await reconcileAmbiguousAnnualPeriod({
        store,
        periodId: p.id,
        headers: opts.headers,
        now,
      });
    }
  }

  const refreshed = await store.listPeriodsForMembership(membershipId);
  const blocking = refreshed.find((p) => {
    const assess = assessAnnualPeriodRevokeEligibility(p);
    return assess.block;
  });
  if (blocking) {
    const assess = assessAnnualPeriodRevokeEligibility(blocking);
    return {
      ok: false,
      reason: assess.reason,
      periodId: assess.periodId ?? blocking.id,
    };
  }
  return { ok: true };
}

/**
 * @param {string} membershipId
 * @param {{ now?: Date; stripe?: Stripe }} [opts]
 */
export async function adminCancelAnnualRenewal(membershipId, opts = {}) {
  const store = openAnnualMembershipStore();
  const membership = await store.getAnnualMembership(membershipId);
  if (!membership) return { ok: false, error: "membership_not_found" };
  if (membership.status === "revoked") {
    return { ok: false, error: "membership_revoked", membership };
  }
  if (!ANNUAL_ISSUANCE_ELIGIBLE_MEMBERSHIP_STATUSES.includes(String(membership.status))) {
    return {
      ok: false,
      error: "membership_not_active",
      status: membership.status,
      membership,
    };
  }

  const subId = String(membership.stripe_subscription_id || "").trim();
  if (!subId) return { ok: false, error: "missing_stripe_subscription_id", membership };
  if (!isRealStripeSubscriptionId(subId)) {
    return {
      ok: false,
      error: isPendingStripeSubscriptionId(subId)
        ? "REAL_STRIPE_SUBSCRIPTION_ID_MISSING"
        : "invalid_stripe_subscription_id",
      membership,
      stripe_subscription_id: subId,
    };
  }

  const sk = (process.env.STRIPE_SECRET_KEY || "").trim();
  if (!sk && !opts.stripe) return { ok: false, error: "stripe_not_configured" };
  const stripe = opts.stripe ?? new Stripe(sk, { apiVersion: "2025-08-27.basil" });

  let stripeSub;
  try {
    stripeSub = await stripe.subscriptions.retrieve(subId);
  } catch (err) {
    return {
      ok: false,
      error: "stripe_subscription_lookup_failed",
      message: String(/** @type {{ message?: string }} */ (err)?.message ?? err).slice(0, 200),
    };
  }

  if (stripeSub.cancel_at_period_end === true || stripeSub.status === "canceled") {
    return {
      ok: true,
      idempotent: true,
      action: "cancel_renewal",
      membership,
      stripe: {
        subscriptionId: stripeSub.id,
        cancelAtPeriodEnd: stripeSub.cancel_at_period_end === true,
        cancelAt: stripeSub.cancel_at ?? null,
        currentPeriodEnd: stripeSub.current_period_end ?? null,
        status: stripeSub.status,
      },
      message: "Renewal already canceled at Stripe.",
      currentTermEnds: membership.term_end_date,
    };
  }

  const updated = await stripe.subscriptions.update(subId, {
    cancel_at_period_end: true,
  });

  return {
    ok: true,
    action: "cancel_renewal",
    membership,
    stripe: {
      subscriptionId: updated.id,
      cancelAtPeriodEnd: updated.cancel_at_period_end === true,
      cancelAt: updated.cancel_at ?? null,
      currentPeriodEnd: updated.current_period_end ?? null,
      status: updated.status,
    },
    message: "Renewal canceled — member keeps current paid annual term through term end.",
    currentTermEnds: membership.term_end_date,
  };
}

/**
 * @param {string} membershipId
 * @param {{ reason?: string; confirmStop?: string; now?: Date }} [opts]
 */
export async function adminRevokeAnnualTerm(membershipId, opts = {}) {
  if (String(opts.confirmStop || "").trim().toUpperCase() !== "STOP") {
    return { ok: false, error: "confirm_stop_required", hint: "Type STOP to confirm." };
  }

  const store = openAnnualMembershipStore();
  let staffHeaders = null;
  try {
    const issued = await getMindbodyStaffAccessTokenCached();
    if (issued.ok) staffHeaders = mindbodyStaffBearerHeaders(issued.accessToken);
  } catch {
    staffHeaders = null;
  }

  const prepared = await prepareMembershipForRevoke(store, membershipId, {
    headers: staffHeaders ?? undefined,
    now: opts.now,
  });
  if (!prepared.ok) {
    return { ok: false, error: prepared.reason, periodId: prepared.periodId };
  }

  const result = await store.revokeAnnualMembershipTerm(membershipId, {
    reason: opts.reason ? String(opts.reason) : "admin_revoked_term",
  });
  if (!result.ok) {
    return {
      ok: false,
      error: result.reason || "revoke_failed",
      status: result.status,
      periodId: result.periodId,
    };
  }

  const periods = await store.listPeriodsForMembership(membershipId);
  const issuedPeriod = periods.find((p) => p.status === "issued") ?? null;

  return {
    ok: true,
    action: "revoke_term",
    idempotent: result.idempotent === true,
    membership: result.membership,
    termStatus: result.membership?.status ?? "revoked",
    futurePeriodsSkipped: result.futurePeriodsSkipped ?? result.skippedCount ?? 0,
    issuedPeriodsPreserved: result.issuedPreserved ?? 0,
    currentIssuedPeriod: issuedPeriod
      ? {
          period_index: issuedPeriod.period_index,
          mindbody_client_service_id: issuedPeriod.mindbody_client_service_id,
          mindbody_sale_id: issuedPeriod.mindbody_sale_id,
        }
      : null,
    mindbodyNote:
      "Current Mindbody entitlement remains until separately removed or adjusted in Mindbody.",
  };
}

/**
 * @param {Record<string, unknown>} membership
 */
export function summarizeAnnualMembershipForAdmin(membership) {
  const businessToday = stripeInstantToBusinessDate(new Date(), ANNUAL_TIMEZONE);
  return {
    ...membership,
    entitlement_active_through: membership.term_end_date,
    business_today: businessToday,
  };
}
