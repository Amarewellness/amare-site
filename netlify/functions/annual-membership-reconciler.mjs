/**
 * AMARÉ Annual Membership daily reconciler (Phase 3).
 * Repairs due periods + stale claiming/ambiguous rows.
 */

import { getMindbodyStaffAccessTokenCached } from "./mindbody-consumer-lib.mjs";
import { mindbodyStaffBearerHeaders } from "./mindbody-upstream.mjs";
import { ANNUAL_ISSUANCE_ELIGIBLE_MEMBERSHIP_STATUSES } from "./annual-membership-lib.mjs";
import { openAnnualMembershipStore } from "./annual-membership-store.mjs";
import {
  currentBusinessDate,
  issueAnnualMembershipPeriod,
  recoverStaleAnnualClaims,
  reconcileAmbiguousAnnualPeriod,
} from "./annual-membership-issue.mjs";

export const RECONCILER_MAX_CONCURRENCY = 3;

/**
 * @param {unknown[]} rows
 * @param {number} size
 */
function chunk(rows, size) {
  /** @type {unknown[][]} */
  const out = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/**
 * @param {{
 *   store?: ReturnType<typeof openAnnualMembershipStore>;
 *   issueFn?: typeof issueAnnualMembershipPeriod;
 *   businessDate?: string;
 *   now?: Date;
 * }} [opts]
 */
export async function runAnnualMembershipReconciliation(opts = {}) {
  const store = opts.store ?? openAnnualMembershipStore();
  const issueFn = opts.issueFn ?? issueAnnualMembershipPeriod;
  const businessDate = opts.businessDate ?? currentBusinessDate(opts.now);
  /** @type {{
   *   businessDate: string;
   *   staleRecovered: unknown[];
   *   ambiguousRecovered: unknown[];
   *   issued: unknown[];
   *   deferred: unknown[];
   *   failed: unknown[];
   *   skipped: unknown[];
   * }} */
  const summary = {
    businessDate,
    staleRecovered: [],
    ambiguousRecovered: [],
    issued: [],
    deferred: [],
    failed: [],
    skipped: [],
  };

  let staffHeaders = null;
  try {
    const issued = await getMindbodyStaffAccessTokenCached();
    if (issued.ok) {
      staffHeaders = mindbodyStaffBearerHeaders(issued.accessToken);
    }
  } catch {
    staffHeaders = null;
  }

  if (staffHeaders) {
    const stale = await recoverStaleAnnualClaims({
      store,
      headers: staffHeaders,
      now: opts.now,
    });
    summary.staleRecovered = stale.reconciled;
  } else {
    console.warn(JSON.stringify({ event: "annual_reconciler_staff_unavailable" }));
  }

  const ambiguousRows = await store.listDuePeriods(businessDate, {
    statuses: ["ambiguous"],
  });
  for (const row of ambiguousRows) {
    if (!staffHeaders) continue;
    const rec = await reconcileAmbiguousAnnualPeriod({
      store,
      periodId: row.id,
      headers: staffHeaders,
      now: opts.now,
    });
    summary.ambiguousRecovered.push({ periodId: row.id, outcome: rec.outcome ?? rec.reason });
    if (rec.outcome === "issued") {
      console.log(
        JSON.stringify({
          event: "period_reconciled",
          period_id: row.id,
          period_index: row.period_index,
          annual_membership_id: row.annual_membership_id,
          outcome: "issued",
        }),
      );
    }
  }

  const due = await store.listDuePeriods(businessDate, {
    statuses: ["pending", "failed"],
  });

  for (const batch of chunk(due, RECONCILER_MAX_CONCURRENCY)) {
    await Promise.all(
      batch.map(async (period) => {
        if (period.status === "manual_review" || period.status === "issued") {
          summary.skipped.push({ periodId: period.id, reason: "terminal_or_manual" });
          return;
        }
        const membership = await store.getAnnualMembership(period.annual_membership_id);
        if (
          !membership ||
          !ANNUAL_ISSUANCE_ELIGIBLE_MEMBERSHIP_STATUSES.includes(String(membership.status))
        ) {
          summary.skipped.push({
            periodId: period.id,
            reason: "membership_not_eligible",
            membershipStatus: membership?.status ?? null,
          });
          return;
        }
        const result = await issueFn(period.id, {
          store,
          businessDate,
        });
        const entry = {
          periodId: period.id,
          period_index: period.period_index,
          annual_membership_id: period.annual_membership_id,
          outcome: result.outcome,
        };
        if (result.outcome === "ISSUED") {
          summary.issued.push(entry);
          console.log(
            JSON.stringify({
              event: "period_issued",
              ...entry,
              mindbody_sale_id: result.mindbodySaleId ?? null,
              mindbody_client_service_id: result.mindbodyClientServiceId ?? null,
            }),
          );
        } else if (result.outcome === "DEFERRED_PREVIOUS_PERIOD_ACTIVE") {
          summary.deferred.push(entry);
          console.log(JSON.stringify({ event: "period_deferred_previous_active", ...entry }));
        } else if (result.outcome === "AMBIGUOUS") {
          summary.failed.push({ ...entry, reason: result.reason ?? "ambiguous" });
          console.warn(JSON.stringify({ event: "period_ambiguous", ...entry }));
        } else if (result.outcome === "FAILED" || result.outcome === "PRE_REQUEST_FAILED") {
          summary.failed.push({ ...entry, reason: result.reason ?? result.outcome });
          console.warn(JSON.stringify({ event: "period_failed", ...entry }));
        } else {
          summary.skipped.push({ ...entry, reason: result.outcome });
        }
      }),
    );
  }

  console.log(
    JSON.stringify({
      event: "annual_reconciler_complete",
      businessDate,
      dueCount: due.length,
      issued: summary.issued.length,
      deferred: summary.deferred.length,
      failed: summary.failed.length,
      skipped: summary.skipped.length,
    }),
  );

  return summary;
}

export async function handler() {
  try {
    const summary = await runAnnualMembershipReconciliation();
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, summary }),
    };
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "annual_reconciler_error",
        message: String(/** @type {{ message?: string }} */ (err)?.message ?? err).slice(0, 240),
      }),
    );
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, error: "annual_reconciler_failed" }),
    };
  }
}

export const config = {
  schedule: "30 9 * * *",
};
