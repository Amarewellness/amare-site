/**
 * AMARÉ attendance fee candidate recording (Phase 1).
 * Visit-scoped Unlimited eligibility; no Stripe collection.
 */

import {
  bookingServiceKind,
  clientServiceRowId,
  loadMergedClientServiceRows,
} from "./booking-cancellation-policy-lib.mjs";
import { clientServiceProductId } from "./member-topup-lib.mjs";
import { visitServiceIdFromRow } from "./mindbody-class-book-lib.mjs";
import {
  isStaffMemberLateCancelWindow,
  STUDIO_LATE_CANCEL_HOURS,
} from "./guest-pass-lib.mjs";
import {
  ATTENDANCE_FEE_AMOUNT_CENTS,
  ATTENDANCE_FEE_CURRENCY,
  resolveAttendanceFeeRuntimeConfig,
} from "./attendance-fee-config.mjs";
import {
  isAttendanceFeeTerminalStatus,
  openAttendanceFeeStore,
} from "./attendance-fee-store.mjs";

/** Skip reasons that warrant a durable ledger row (resolution / dry-run audit). */
export const ATTENDANCE_FEE_PERSISTED_SKIP_REASONS = Object.freeze([
  "dry_run_would_charge",
  "missing_visit_row",
  "missing_client_service_id",
  "client_service_row_not_found",
]);

export {
  resolveAttendanceFeeRuntimeConfig,
  resolveAttendanceFeeCollectionConfig,
} from "./attendance-fee-config.mjs";

export function configuredAttendanceFeeSiteId(env = process.env) {
  const raw = String(env.MINDBODY_SITE_ID || "").trim();
  if (!raw || raw === "-99") return 0;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * @param {Record<string, unknown>} visitRow
 * @param {number} clientId
 * @param {Record<string, unknown>[]} clientServiceRows
 */
export function resolveVisitUnlimitedEligibility(visitRow, clientId, clientServiceRows) {
  if (!visitRow || typeof visitRow !== "object") {
    return { eligible: false, reason: "missing_visit_row", failClosed: true, persist: true };
  }
  const clientServiceInstanceId = visitServiceIdFromRow(visitRow);
  if (clientServiceInstanceId == null || !Number.isFinite(clientServiceInstanceId) || clientServiceInstanceId <= 0) {
    return {
      eligible: false,
      reason: "missing_client_service_id",
      failClosed: true,
      persist: true,
    };
  }

  const row = (clientServiceRows || []).find(
    (r) => clientServiceRowId(r) === clientServiceInstanceId,
  );
  if (!row) {
    return {
      eligible: false,
      reason: "client_service_row_not_found",
      failClosed: true,
      persist: true,
      clientServiceInstanceId,
    };
  }

  const kind = bookingServiceKind(row);
  if (kind !== "unlimited") {
    return {
      eligible: false,
      reason: "not_unlimited_visit",
      failClosed: false,
      persist: false,
      clientServiceInstanceId,
      mindbodyProductId: clientServiceProductId(row),
    };
  }

  return {
    eligible: true,
    clientServiceInstanceId,
    mindbodyProductId: clientServiceProductId(row),
    clientServiceRow: row,
  };
}

/**
 * @param {{
 *   classStartMs: number;
 *   triggerAtMs: number;
 * }} input
 */
export function assertLateCancelFeeGate(input) {
  const { classStartMs, triggerAtMs } = input;
  if (!Number.isFinite(classStartMs) || !Number.isFinite(triggerAtMs)) {
    return { ok: false, reason: "invalid_timing" };
  }
  if (classStartMs <= triggerAtMs) {
    return { ok: false, reason: "class_already_started" };
  }
  if (!isStaffMemberLateCancelWindow(classStartMs, triggerAtMs)) {
    return { ok: false, reason: "outside_late_cancel_window" };
  }
  return { ok: true };
}

/**
 * No-show verification is wired in a later phase.
 *
 * @param {{
 *   visitRow?: Record<string, unknown> | null;
 *   noShowVerified?: boolean;
 * }} input
 */
export function assertNoShowFeeGate(input) {
  if (input.noShowVerified !== true) {
    return { ok: false, reason: "no_show_not_verified" };
  }
  const visitRow = input.visitRow;
  if (!visitRow || typeof visitRow !== "object") {
    return { ok: false, reason: "missing_visit_row" };
  }
  if (visitRow.SignedIn === true || visitRow.signedIn === true) {
    return { ok: false, reason: "client_signed_in" };
  }
  if (visitRow.LateCancelled === true || visitRow.lateCancelled === true) {
    return { ok: false, reason: "visit_late_cancelled" };
  }
  return { ok: true };
}

/**
 * @param {string} iso
 */
function isoOrNull(iso) {
  if (typeof iso !== "string" || !iso.trim()) return null;
  const n = Date.parse(iso);
  return Number.isFinite(n) ? new Date(n).toISOString() : iso.trim();
}

/**
 * @param {{
 *   feeType: "late_cancel" | "no_show";
 *   triggerSource: string;
 *   visitId: number;
 *   clientId: number;
 *   classId: number;
 *   classStartMs?: number;
 *   classStartIso?: string;
 *   triggerAtMs?: number;
 *   triggerAtIso?: string;
 *   visitRow?: Record<string, unknown> | null;
 *   clientServiceRows?: Record<string, unknown>[];
 *   noShowVerified?: boolean;
 *   webhookMessageId?: string | null;
 *   siteId?: number;
 *   store?: import("./attendance-fee-store.mjs").AttendanceFeeStore;
 *   fetchVisit?: (input: { visitId: number; clientId: number; classId: number }) => Promise<Record<string, unknown> | null>;
 *   loadClientServices?: (clientId: number) => Promise<Record<string, unknown>[]>;
 *   env?: NodeJS.ProcessEnv;
 *   config?: Partial<import("./attendance-fee-config.mjs").AttendanceFeeRuntimeConfig>;
 * }} input
 */
export async function recordAttendanceFeeCandidate(input, deps = {}) {
  const env = deps.env ?? process.env;
  const runtime = resolveAttendanceFeeRuntimeConfig(deps.config ?? input.config);
  if (!runtime.enabled) {
    return { outcome: "disabled", persisted: false };
  }

  const store =
    input.store ??
    deps.store ??
    openAttendanceFeeStore(deps.forceMemory === true ? { forceMemory: true } : {});
  const visitId = Math.trunc(Number(input.visitId));
  const clientId = Math.trunc(Number(input.clientId));
  const classId = Math.trunc(Number(input.classId));
  if (!Number.isFinite(visitId) || visitId <= 0) {
    return { outcome: "invalid_input", reason: "invalid_visit_id", persisted: false };
  }

  const existing = await store.getAttendanceFeeByVisitId(visitId);
  if (existing) {
    return {
      outcome: isAttendanceFeeTerminalStatus(existing.status) ? "duplicate_terminal" : "existing",
      persisted: true,
      created: false,
      record: existing,
    };
  }

  let visitRow = input.visitRow ?? null;
  if (!visitRow && typeof deps.fetchVisit === "function") {
    visitRow = await deps.fetchVisit({ visitId, clientId, classId });
  } else if (!visitRow && typeof input.fetchVisit === "function") {
    visitRow = await input.fetchVisit({ visitId, clientId, classId });
  }
  if (!visitRow) {
    if (ATTENDANCE_FEE_PERSISTED_SKIP_REASONS.includes("missing_visit_row")) {
      const triggerAt = isoOrNull(input.triggerAtIso) ?? new Date(input.triggerAtMs ?? Date.now()).toISOString();
      const ins = await store.markAttendanceFeeSkipped({
        visitId,
        siteId: input.siteId ?? configuredAttendanceFeeSiteId(env),
        classId,
        clientId,
        clientServiceId: null,
        mindbodyProductId: null,
        feeType: input.feeType,
        amountCents: ATTENDANCE_FEE_AMOUNT_CENTS,
        currency: ATTENDANCE_FEE_CURRENCY,
        skipReason: "missing_visit_row",
        dryRun: false,
        triggerSource: input.triggerSource,
        triggerAt,
        webhookMessageId: input.webhookMessageId ?? null,
        classStartAt: isoOrNull(input.classStartIso),
      });
      return {
        outcome: "skipped",
        reason: "missing_visit_row",
        persisted: true,
        created: ins.created,
        record: ins.record,
      };
    }
    return { outcome: "skipped", reason: "missing_visit_row", persisted: false };
  }

  let clientServiceRows = input.clientServiceRows;
  if (!clientServiceRows) {
    if (typeof deps.loadClientServices === "function") {
      clientServiceRows = await deps.loadClientServices(clientId);
    } else if (typeof input.loadClientServices === "function") {
      clientServiceRows = await input.loadClientServices(clientId);
    } else {
      clientServiceRows = await loadMergedClientServiceRows(clientId, null, deps.staffHeaders ?? null);
    }
  }

  const eligibility = resolveVisitUnlimitedEligibility(visitRow, clientId, clientServiceRows);
  if (!eligibility.eligible) {
    if (eligibility.persist) {
      const triggerAt = isoOrNull(input.triggerAtIso) ?? new Date(input.triggerAtMs ?? Date.now()).toISOString();
      const ins = await store.markAttendanceFeeSkipped({
        visitId,
        siteId: input.siteId ?? configuredAttendanceFeeSiteId(env),
        classId,
        clientId,
        clientServiceId: eligibility.clientServiceInstanceId ?? null,
        mindbodyProductId: eligibility.mindbodyProductId ?? null,
        feeType: input.feeType,
        amountCents: ATTENDANCE_FEE_AMOUNT_CENTS,
        currency: ATTENDANCE_FEE_CURRENCY,
        skipReason: eligibility.reason,
        dryRun: false,
        triggerSource: input.triggerSource,
        triggerAt,
        webhookMessageId: input.webhookMessageId ?? null,
        classStartAt: isoOrNull(input.classStartIso),
      });
      return {
        outcome: "skipped",
        reason: eligibility.reason,
        persisted: true,
        created: ins.created,
        record: ins.record,
      };
    }
    return {
      outcome: "skipped",
      reason: eligibility.reason,
      persisted: false,
    };
  }

  const triggerAtMs = Number.isFinite(input.triggerAtMs) ? input.triggerAtMs : Date.now();
  const classStartMs = Number.isFinite(input.classStartMs)
    ? input.classStartMs
    : input.classStartIso
      ? Date.parse(input.classStartIso)
      : NaN;

  if (input.feeType === "late_cancel") {
    const gate = assertLateCancelFeeGate({ classStartMs, triggerAtMs });
    if (!gate.ok) {
      return { outcome: "skipped", reason: gate.reason, persisted: false };
    }
  } else if (input.feeType === "no_show") {
    const gate = assertNoShowFeeGate({ visitRow, noShowVerified: input.noShowVerified });
    if (!gate.ok) {
      return { outcome: "skipped", reason: gate.reason, persisted: false };
    }
  } else {
    return { outcome: "invalid_input", reason: "invalid_fee_type", persisted: false };
  }

  const triggerAt = isoOrNull(input.triggerAtIso) ?? new Date(triggerAtMs).toISOString();
  const classStartAt = isoOrNull(input.classStartIso) ?? (Number.isFinite(classStartMs) ? new Date(classStartMs).toISOString() : null);

  const base = {
    visitId,
    siteId: input.siteId ?? configuredAttendanceFeeSiteId(env),
    classId,
    clientId,
    clientServiceId: eligibility.clientServiceInstanceId,
    mindbodyProductId: eligibility.mindbodyProductId,
    feeType: input.feeType,
    amountCents: ATTENDANCE_FEE_AMOUNT_CENTS,
    currency: ATTENDANCE_FEE_CURRENCY,
    triggerSource: input.triggerSource,
    triggerAt,
    webhookMessageId: input.webhookMessageId ?? null,
    classStartAt,
    failureClass: null,
  };

  if (runtime.dryRun) {
    const ins = await store.markAttendanceFeeSkipped({
      ...base,
      skipReason: "dry_run_would_charge",
      dryRun: true,
    });
    return {
      outcome: "dry_run",
      persisted: true,
      created: ins.created,
      record: ins.record,
    };
  }

  const ins = await store.recordOrGetAttendanceFeeCandidate({
    ...base,
    status: "pending",
    dryRun: false,
    skipReason: null,
  });

  return {
    outcome: ins.created ? "pending_created" : "existing",
    persisted: true,
    created: ins.created,
    record: ins.record,
  };
}

export {
  STUDIO_LATE_CANCEL_HOURS,
  isStaffMemberLateCancelWindow,
};
