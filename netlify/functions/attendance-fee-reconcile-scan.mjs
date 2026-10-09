/**
 * Scheduled attendance fee reconciler — pending/retryable → Stripe → charged/failed.
 * Safe no-op when ATTENDANCE_FEES_ENABLED=false or ATTENDANCE_FEES_DRY_RUN=true.
 */

import Stripe from "stripe";
import { withLambda } from "@netlify/aws-lambda-compat";
import {
  ATTENDANCE_FEE_RECONCILE_BATCH_SIZE,
  ATTENDANCE_FEE_RECONCILE_MAX_CONCURRENCY,
  resolveAttendanceFeeCollectionConfig,
} from "./attendance-fee-config.mjs";
import { openAttendanceFeeStore } from "./attendance-fee-store.mjs";
import { collectAttendanceFeeForProcessingRow } from "./attendance-fee-collect.mjs";
import { openSubscriptionStore } from "./stripe-subscription-store.mjs";

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

function stripeClientFromEnv() {
  const sk = (process.env.STRIPE_SECRET_KEY || "").trim();
  if (!sk.startsWith("sk_")) return null;
  return new Stripe(sk, { apiVersion: "2025-08-27.basil" });
}

/**
 * @param {{
 *   store?: ReturnType<typeof openAttendanceFeeStore>;
 *   stripe?: import("stripe").default | null;
 *   subscriptionStore?: ReturnType<typeof openSubscriptionStore>;
 *   config?: import("./attendance-fee-config.mjs").AttendanceFeeCollectionConfig;
 *   collectPayment?: import("./stripe-attendance-fee-charge.mjs").collectAttendanceFeePayment;
 *   nowMs?: number;
 *   listProcessableOpts?: { visitIdMin?: number; visitIdMax?: number };
 * }} [opts]
 */
export async function runAttendanceFeeReconciliation(opts = {}) {
  const cfg = resolveAttendanceFeeCollectionConfig(opts.config);
  /** @type {{
   *   skipped: boolean;
   *   reason?: string;
   *   scanned: number;
   *   charged: unknown[];
   *   failed: unknown[];
   *   notAcquired: unknown[];
   *   errors: unknown[];
   * }} */
  const summary = {
    skipped: false,
    scanned: 0,
    charged: [],
    failed: [],
    notAcquired: [],
    errors: [],
  };

  if (!cfg.enabled) {
    summary.skipped = true;
    summary.reason = "disabled";
    return summary;
  }
  if (cfg.dryRun) {
    summary.skipped = true;
    summary.reason = "dry_run";
    return summary;
  }

  const priceId = String(cfg.stripePriceId || "").trim();
  if (!priceId.startsWith("price_")) {
    summary.skipped = true;
    summary.reason = "invalid_price_config";
    return summary;
  }

  /** @type {ReturnType<typeof openAttendanceFeeStore>} */
  let store;
  try {
    store = opts.store ?? openAttendanceFeeStore();
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "attendance_fee_reconcile_ledger_unavailable",
        code: err?.code ?? null,
        message: String(err?.message || err).slice(0, 240),
      }),
    );
    summary.skipped = true;
    summary.reason = "ledger_unavailable";
    return summary;
  }

  const stripe = opts.stripe ?? stripeClientFromEnv();
  if (!stripe) {
    summary.skipped = true;
    summary.reason = "stripe_unavailable";
    return summary;
  }

  const subscriptionStore = opts.subscriptionStore ?? openSubscriptionStore(null);
  const listOpts = {
    limit: ATTENDANCE_FEE_RECONCILE_BATCH_SIZE,
    nowMs: opts.nowMs,
    ...(opts.listProcessableOpts || {}),
  };
  const candidates = await store.listProcessableAttendanceFees(listOpts);
  summary.scanned = candidates.length;

  for (const batch of chunk(candidates, ATTENDANCE_FEE_RECONCILE_MAX_CONCURRENCY)) {
    await Promise.all(
      batch.map(async (row) => {
        try {
          const lock = await store.acquireAttendanceFeeProcessingLock(row.visitId, {
            nowMs: opts.nowMs,
          });
          if (!lock.acquired || !lock.record) {
            summary.notAcquired.push({ visitId: row.visitId, reason: lock.reason });
            return;
          }
          const outcome = await collectAttendanceFeeForProcessingRow(lock.record, {
            store,
            stripe,
            priceId,
            subscriptionStore,
            collectPayment: opts.collectPayment,
          });
          if (outcome.outcome === "charged") {
            summary.charged.push({ visitId: row.visitId, recovered: outcome.recovered === true });
          } else {
            summary.failed.push({
              visitId: row.visitId,
              failureCode: outcome.failureCode,
              failureClass: outcome.failureClass,
            });
          }
        } catch (err) {
          summary.errors.push({
            visitId: row.visitId,
            message: String(/** @type {{ message?: string }} */ (err)?.message ?? err).slice(0, 200),
          });
        }
      }),
    );
  }

  console.log(JSON.stringify({ event: "attendance_fee_reconcile_complete", summary }));
  return summary;
}

export async function lambdaHandler() {
  try {
    const summary = await runAttendanceFeeReconciliation();
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, summary }),
    };
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "attendance_fee_reconcile_error",
        message: String(/** @type {{ message?: string }} */ (err)?.message ?? err).slice(0, 240),
      }),
    );
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, error: "attendance_fee_reconcile_failed" }),
    };
  }
}

export default withLambda(lambdaHandler);

export const config = {
  schedule: "*/7 * * * *",
};
