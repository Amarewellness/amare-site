/**
 * Late-cancel attendance fee candidate recording after successful Mindbody cancel (Phase 2).
 * Record-only — no Stripe. Failures are logged; never fail the cancel HTTP response.
 */

import { loadMergedClientServiceRows } from "./booking-cancellation-policy-lib.mjs";
import { resolveStaffAuthHeaders } from "./mindbody-class-book-lib.mjs";
import { recordAttendanceFeeCandidate, configuredAttendanceFeeSiteId } from "./attendance-fee-lib.mjs";

/**
 * @param {{
 *   visitId: number;
 *   classId: number;
 *   clientId: number;
 *   classStartMs: number;
 *   classStartIso: string;
 *   visitRow: Record<string, unknown>;
 *   authHeaders: Record<string, string>;
 *   authSource: string | null | undefined;
 *   triggerAtMs?: number;
 *   env?: NodeJS.ProcessEnv;
 *   resolveStaffHeaders?: () => Promise<Record<string, string> | null>;
 *   loadClientServices?: (clientId: number) => Promise<Record<string, unknown>[]>;
 *   config?: Partial<import("./attendance-fee-config.mjs").AttendanceFeeRuntimeConfig>;
 *   store?: import("./attendance-fee-store.mjs").AttendanceFeeStore;
 *   forceMemory?: boolean;
 * }} input
 */
export async function recordLateCancelAttendanceFeeAfterSuccessfulCancel(input) {
  const env = input.env ?? process.env;
  const triggerAtMs = Number.isFinite(input.triggerAtMs) ? input.triggerAtMs : Date.now();
  const resolveStaff =
    input.resolveStaffHeaders ??
    (async () => resolveStaffAuthHeaders());

  const loadClientServices =
    input.loadClientServices ??
    (async (clientId) => {
      const staffHeadersForServices =
        input.authSource === "amare" ? input.authHeaders : await resolveStaff();
      return loadMergedClientServiceRows(
        clientId,
        input.authHeaders,
        input.authSource === "amare" ? null : staffHeadersForServices,
      );
    });

  return recordAttendanceFeeCandidate(
    {
      feeType: "late_cancel",
      triggerSource: "amare_cancel",
      visitId: input.visitId,
      classId: input.classId,
      clientId: input.clientId,
      classStartMs: input.classStartMs,
      classStartIso: input.classStartIso,
      triggerAtMs,
      triggerAtIso: new Date(triggerAtMs).toISOString(),
      visitRow: input.visitRow,
      siteId: configuredAttendanceFeeSiteId(env),
    },
    {
      loadClientServices,
      env: input.env,
      config: input.config,
      store: input.store,
      forceMemory: input.forceMemory === true,
    },
  );
}

/**
 * @param {Parameters<typeof recordLateCancelAttendanceFeeAfterSuccessfulCancel>[0]} input
 */
export async function tryRecordLateCancelAttendanceFeeAfterSuccessfulCancel(input) {
  try {
    const result = await recordLateCancelAttendanceFeeAfterSuccessfulCancel(input);
    console.log(
      JSON.stringify({
        event: "attendance_fee_late_cancel_record",
        visitId: input.visitId,
        classId: input.classId,
        clientId: input.clientId,
        triggerSource: "amare_cancel",
        outcome: result.outcome,
        persisted: result.persisted === true,
        reason: result.reason ?? null,
      }),
    );
    return result;
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "attendance_fee_late_cancel_record_failed",
        visitId: input.visitId,
        classId: input.classId,
        clientId: input.clientId,
        triggerSource: "amare_cancel",
        error: String(err?.message || err).slice(0, 500),
        code: err?.code ?? null,
      }),
    );
    return { outcome: "error", persisted: false, error: String(err?.message || err) };
  }
}
