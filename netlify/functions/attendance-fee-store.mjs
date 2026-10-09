/**
 * AMARÉ attendance fee ledger (Phase 1).
 * Memory adapter for tests; Postgres when DATABASE_URL is configured.
 * No Stripe collection in this module.
 */

import { randomUUID } from "node:crypto";
import { getConnectionString, getDatabase } from "@netlify/database";
import {
  ATTENDANCE_FEE_AMOUNT_CENTS,
  ATTENDANCE_FEE_CURRENCY,
  ATTENDANCE_FEE_STALE_PROCESSING_MS,
} from "./attendance-fee-config.mjs";

export { ATTENDANCE_FEE_AMOUNT_CENTS, ATTENDANCE_FEE_CURRENCY, ATTENDANCE_FEE_STALE_PROCESSING_MS };

export const ATTENDANCE_FEE_STATUSES = Object.freeze([
  "pending",
  "processing",
  "charged",
  "failed",
  "waived",
  "skipped",
]);

export const ATTENDANCE_FEE_TERMINAL_STATUSES = Object.freeze(["charged", "waived", "skipped"]);

/**
 * @param {string} status
 */
export function isAttendanceFeeTerminalStatus(status) {
  return ATTENDANCE_FEE_TERMINAL_STATUSES.includes(String(status || ""));
}

/**
 * @param {Record<string, unknown>} row
 */
export function mapAttendanceFeeRow(row) {
  if (!row || typeof row !== "object") return null;
  return {
    visitId: Number(row.visit_id ?? row.visitId),
    siteId: Number(row.site_id ?? row.siteId),
    classId: Number(row.class_id ?? row.classId),
    clientId: Number(row.client_id ?? row.clientId),
    clientServiceId:
      row.client_service_id != null || row.clientServiceId != null
        ? Number(row.client_service_id ?? row.clientServiceId)
        : null,
    mindbodyProductId:
      row.mindbody_product_id != null || row.mindbodyProductId != null
        ? Number(row.mindbody_product_id ?? row.mindbodyProductId)
        : null,
    feeType: String(row.fee_type ?? row.feeType ?? ""),
    amountCents: Number(row.amount_cents ?? row.amountCents ?? ATTENDANCE_FEE_AMOUNT_CENTS),
    currency: String(row.currency ?? ATTENDANCE_FEE_CURRENCY),
    status: String(row.status ?? ""),
    failureClass: row.failure_class != null || row.failureClass != null
      ? String(row.failure_class ?? row.failureClass)
      : null,
    skipReason: row.skip_reason != null || row.skipReason != null
      ? String(row.skip_reason ?? row.skipReason)
      : null,
    dryRun: row.dry_run === true || row.dryRun === true,
    triggerSource: String(row.trigger_source ?? row.triggerSource ?? ""),
    stripeCustomerId: row.stripe_customer_id ?? row.stripeCustomerId ?? null,
    stripeInvoiceId: row.stripe_invoice_id ?? row.stripeInvoiceId ?? null,
    stripePaymentIntentId: row.stripe_payment_intent_id ?? row.stripePaymentIntentId ?? null,
    failureCode: row.failure_code ?? row.failureCode ?? null,
    failureMessage: row.failure_message ?? row.failureMessage ?? null,
    processingToken: row.processing_token ?? row.processingToken ?? null,
    processingStartedAt: row.processing_started_at ?? row.processingStartedAt ?? null,
    attemptCount: Number(row.attempt_count ?? row.attemptCount ?? 0),
    lastAttemptAt: row.last_attempt_at ?? row.lastAttemptAt ?? null,
    nextRetryAt: row.next_retry_at ?? row.nextRetryAt ?? null,
    classStartAt: row.class_start_at ?? row.classStartAt ?? null,
    triggerAt: row.trigger_at ?? row.triggerAt ?? null,
    chargedAt: row.charged_at ?? row.chargedAt ?? null,
    webhookMessageId: row.webhook_message_id ?? row.webhookMessageId ?? null,
    createdAt: row.created_at ?? row.createdAt ?? null,
    updatedAt: row.updated_at ?? row.updatedAt ?? null,
  };
}

/**
 * @param {import("./attendance-fee-store.mjs").AttendanceFeeRecord} rec
 */
function memoryRowFromRecord(rec) {
  const now = new Date().toISOString();
  return {
    visit_id: rec.visitId,
    site_id: rec.siteId,
    class_id: rec.classId,
    client_id: rec.clientId,
    client_service_id: rec.clientServiceId,
    mindbody_product_id: rec.mindbodyProductId,
    fee_type: rec.feeType,
    amount_cents: rec.amountCents ?? ATTENDANCE_FEE_AMOUNT_CENTS,
    currency: rec.currency ?? ATTENDANCE_FEE_CURRENCY,
    status: rec.status,
    failure_class: rec.failureClass,
    skip_reason: rec.skipReason,
    dry_run: rec.dryRun === true,
    trigger_source: rec.triggerSource,
    stripe_customer_id: rec.stripeCustomerId,
    stripe_invoice_id: rec.stripeInvoiceId,
    stripe_payment_intent_id: rec.stripePaymentIntentId,
    failure_code: rec.failureCode,
    failure_message: rec.failureMessage,
    processing_token: rec.processingToken,
    processing_started_at: rec.processingStartedAt,
    attempt_count: rec.attemptCount ?? 0,
    last_attempt_at: rec.lastAttemptAt,
    next_retry_at: rec.nextRetryAt,
    class_start_at: rec.classStartAt,
    trigger_at: rec.triggerAt ?? now,
    charged_at: rec.chargedAt,
    webhook_message_id: rec.webhookMessageId,
    created_at: rec.createdAt ?? now,
    updated_at: rec.updatedAt ?? now,
  };
}

/**
 * @param {number} visitId
 * @param {Record<string, unknown>} raw
 * @param {number} [nowMs]
 * @param {number} [staleMs]
 */
export function isAttendanceFeeRowProcessable(raw, nowMs = Date.now(), staleMs = ATTENDANCE_FEE_STALE_PROCESSING_MS) {
  const row = mapAttendanceFeeRow(raw);
  if (!row) return false;
  if (row.status === "pending") return true;
  if (row.status === "failed" && row.failureClass === "retryable") {
    if (!row.nextRetryAt) return true;
    const n = Date.parse(String(row.nextRetryAt));
    return Number.isFinite(n) && n <= nowMs;
  }
  if (row.status === "processing" && row.processingStartedAt) {
    const started = Date.parse(String(row.processingStartedAt));
    return Number.isFinite(started) && nowMs - started >= staleMs;
  }
  return false;
}

export function createMemoryAttendanceFeeStore() {
  /** @type {Map<number, Record<string, unknown>>} */
  const byVisit = new Map();

  return {
    kind: "memory",

    async getAttendanceFeeByVisitId(visitId) {
      const raw = byVisit.get(Math.trunc(Number(visitId)));
      return raw ? mapAttendanceFeeRow(raw) : null;
    },

    async insertAttendanceFeeCandidate(rec) {
      const vid = Math.trunc(Number(rec.visitId));
      if (!Number.isFinite(vid) || vid <= 0) throw new Error("invalid_visit_id");
      if (byVisit.has(vid)) {
        return { created: false, record: mapAttendanceFeeRow(byVisit.get(vid)) };
      }
      const raw = memoryRowFromRecord(rec);
      byVisit.set(vid, raw);
      return { created: true, record: mapAttendanceFeeRow(raw) };
    },

    async recordOrGetAttendanceFeeCandidate(rec) {
      return this.insertAttendanceFeeCandidate(rec);
    },

    async acquireAttendanceFeeProcessingLock(visitId, opts = {}) {
      const vid = Math.trunc(Number(visitId));
      const staleMs = opts.staleMs ?? ATTENDANCE_FEE_STALE_PROCESSING_MS;
      const nowMs = opts.nowMs ?? Date.now();
      const raw = byVisit.get(vid);
      if (!raw) return { acquired: false, reason: "not_found", record: null };
      if (!isAttendanceFeeRowProcessable(raw, nowMs, staleMs)) {
        return { acquired: false, reason: "not_processable", record: mapAttendanceFeeRow(raw) };
      }
      const token = randomUUID();
      const ts = new Date(nowMs).toISOString();
      raw.status = "processing";
      raw.processing_token = token;
      raw.processing_started_at = ts;
      raw.attempt_count = Number(raw.attempt_count ?? 0) + 1;
      raw.last_attempt_at = ts;
      raw.updated_at = ts;
      return { acquired: true, processingToken: token, record: mapAttendanceFeeRow(raw) };
    },

    async markAttendanceFeeCharged(visitId, payload = {}) {
      const vid = Math.trunc(Number(visitId));
      const raw = byVisit.get(vid);
      if (!raw) return { ok: false, reason: "not_found", record: null };
      if (raw.status !== "processing") {
        return { ok: false, reason: "invalid_status", record: mapAttendanceFeeRow(raw) };
      }
      const ts = new Date().toISOString();
      raw.status = "charged";
      raw.charged_at = payload.chargedAt ?? ts;
      raw.stripe_customer_id = payload.stripeCustomerId ?? raw.stripe_customer_id;
      raw.stripe_invoice_id = payload.stripeInvoiceId ?? raw.stripe_invoice_id;
      raw.stripe_payment_intent_id = payload.stripePaymentIntentId ?? raw.stripe_payment_intent_id;
      raw.processing_token = null;
      raw.processing_started_at = null;
      raw.failure_class = null;
      raw.failure_code = null;
      raw.failure_message = null;
      raw.updated_at = ts;
      return { ok: true, record: mapAttendanceFeeRow(raw) };
    },

    async markAttendanceFeeProcessingStripeRefs(visitId, payload = {}) {
      const vid = Math.trunc(Number(visitId));
      const raw = byVisit.get(vid);
      if (!raw) return { ok: false, reason: "not_found", record: null };
      if (raw.status !== "processing") {
        return { ok: false, reason: "invalid_status", record: mapAttendanceFeeRow(raw) };
      }
      const ts = new Date().toISOString();
      if (payload.stripeCustomerId) raw.stripe_customer_id = payload.stripeCustomerId;
      if (payload.stripeInvoiceId) raw.stripe_invoice_id = payload.stripeInvoiceId;
      if (payload.stripePaymentIntentId) raw.stripe_payment_intent_id = payload.stripePaymentIntentId;
      raw.updated_at = ts;
      return { ok: true, record: mapAttendanceFeeRow(raw) };
    },

    async markAttendanceFeeFailed(visitId, payload = {}) {
      const vid = Math.trunc(Number(visitId));
      const raw = byVisit.get(vid);
      if (!raw) return { ok: false, reason: "not_found", record: null };
      if (raw.status !== "processing") {
        return { ok: false, reason: "invalid_status", record: mapAttendanceFeeRow(raw) };
      }
      const ts = new Date().toISOString();
      raw.status = "failed";
      raw.failure_class = payload.failureClass === "permanent" ? "permanent" : "retryable";
      raw.failure_code = payload.failureCode ?? null;
      raw.failure_message = payload.failureMessage ?? null;
      raw.next_retry_at = payload.nextRetryAt ?? null;
      raw.processing_token = null;
      raw.processing_started_at = null;
      raw.updated_at = ts;
      return { ok: true, record: mapAttendanceFeeRow(raw) };
    },

    async markAttendanceFeeSkipped(rec) {
      return this.insertAttendanceFeeCandidate({ ...rec, status: "skipped" });
    },

    async markAttendanceFeeWaived(visitId, payload = {}) {
      const vid = Math.trunc(Number(visitId));
      const raw = byVisit.get(vid);
      if (!raw) return { ok: false, reason: "not_found", record: null };
      const ts = new Date().toISOString();
      raw.status = "waived";
      raw.skip_reason = payload.skipReason ?? raw.skip_reason ?? "waived";
      raw.processing_token = null;
      raw.processing_started_at = null;
      raw.updated_at = ts;
      return { ok: true, record: mapAttendanceFeeRow(raw) };
    },

    async releaseStaleProcessing(visitId, opts = {}) {
      const vid = Math.trunc(Number(visitId));
      const staleMs = opts.staleMs ?? ATTENDANCE_FEE_STALE_PROCESSING_MS;
      const nowMs = opts.nowMs ?? Date.now();
      const raw = byVisit.get(vid);
      if (!raw || raw.status !== "processing") {
        return { ok: false, reason: "not_stale_processing", record: raw ? mapAttendanceFeeRow(raw) : null };
      }
      const started = Date.parse(String(raw.processing_started_at ?? ""));
      if (!Number.isFinite(started) || nowMs - started < staleMs) {
        return { ok: false, reason: "not_stale", record: mapAttendanceFeeRow(raw) };
      }
      const ts = new Date(nowMs).toISOString();
      raw.status = "pending";
      raw.processing_token = null;
      raw.processing_started_at = null;
      raw.updated_at = ts;
      return { ok: true, record: mapAttendanceFeeRow(raw) };
    },

    async listProcessableAttendanceFees(opts = {}) {
      const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 500);
      const nowMs = opts.nowMs ?? Date.now();
      const staleMs = opts.staleMs ?? ATTENDANCE_FEE_STALE_PROCESSING_MS;
      const visitIdMin =
        opts.visitIdMin != null && Number.isFinite(Number(opts.visitIdMin))
          ? Math.trunc(Number(opts.visitIdMin))
          : null;
      const visitIdMax =
        opts.visitIdMax != null && Number.isFinite(Number(opts.visitIdMax))
          ? Math.trunc(Number(opts.visitIdMax))
          : null;
      const out = [];
      for (const raw of byVisit.values()) {
        const vid = Math.trunc(Number(raw.visit_id));
        if (visitIdMin != null && vid < visitIdMin) continue;
        if (visitIdMax != null && vid > visitIdMax) continue;
        if (isAttendanceFeeRowProcessable(raw, nowMs, staleMs)) {
          out.push(mapAttendanceFeeRow(raw));
        }
      }
      out.sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
      return out.slice(0, limit);
    },

    async resetForTests() {
      byVisit.clear();
    },
  };
}

export function attendanceFeeDatabaseUrl() {
  try {
    const native = getConnectionString();
    if (typeof native === "string" && native.trim()) return native.trim();
  } catch {
    /* local CLI / tests */
  }
  return (
    (process.env.NETLIFY_DB_URL || "").trim() ||
    (process.env.NETLIFY_DATABASE_URL || "").trim() ||
    (process.env.DATABASE_URL || "").trim() ||
    ""
  );
}

/** @type {{ url: string, db: import("@netlify/database").DatabaseConnection } | null} */
let cachedAttendanceFeeDb = null;

function getAttendanceFeeDb() {
  const url = attendanceFeeDatabaseUrl();
  if (!url) throw new Error("attendance_fee_db_unconfigured");
  if (cachedAttendanceFeeDb && cachedAttendanceFeeDb.url === url) return cachedAttendanceFeeDb.db;
  cachedAttendanceFeeDb = { url, db: getDatabase({ connectionString: url }) };
  return cachedAttendanceFeeDb.db;
}

/**
 * @param {string} text
 * @param {unknown[]} [values]
 */
export async function attendanceFeeQuery(text, values = []) {
  const result = await getAttendanceFeeDb().pool.query(text, values);
  return { rows: result.rows || [] };
}

function staleIntervalMs(staleMs) {
  return Math.max(1, Math.trunc(staleMs));
}

export function createPostgresAttendanceFeeStore() {
  const query = attendanceFeeQuery;

  return {
    kind: "postgres",

    async getAttendanceFeeByVisitId(visitId) {
      const r = await query(`SELECT * FROM amare_attendance_fees WHERE visit_id = $1 LIMIT 1`, [
        Math.trunc(Number(visitId)),
      ]);
      return r.rows[0] ? mapAttendanceFeeRow(r.rows[0]) : null;
    },

    async insertAttendanceFeeCandidate(rec) {
      const r = await query(
        `INSERT INTO amare_attendance_fees (
          visit_id, site_id, class_id, client_id, client_service_id, mindbody_product_id,
          fee_type, amount_cents, currency, status, failure_class, skip_reason, dry_run,
          trigger_source, class_start_at, trigger_at, webhook_message_id
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17
        )
        ON CONFLICT (visit_id) DO NOTHING
        RETURNING *`,
        [
          rec.visitId,
          rec.siteId,
          rec.classId,
          rec.clientId,
          rec.clientServiceId,
          rec.mindbodyProductId,
          rec.feeType,
          rec.amountCents ?? ATTENDANCE_FEE_AMOUNT_CENTS,
          rec.currency ?? ATTENDANCE_FEE_CURRENCY,
          rec.status,
          rec.failureClass,
          rec.skipReason,
          rec.dryRun === true,
          rec.triggerSource,
          rec.classStartAt,
          rec.triggerAt,
          rec.webhookMessageId,
        ],
      );
      if (r.rows[0]) {
        return { created: true, record: mapAttendanceFeeRow(r.rows[0]) };
      }
      const existing = await this.getAttendanceFeeByVisitId(rec.visitId);
      return { created: false, record: existing };
    },

    async recordOrGetAttendanceFeeCandidate(rec) {
      return this.insertAttendanceFeeCandidate(rec);
    },

    async acquireAttendanceFeeProcessingLock(visitId, opts = {}) {
      const staleMs = staleIntervalMs(opts.staleMs ?? ATTENDANCE_FEE_STALE_PROCESSING_MS);
      const token = randomUUID();
      const r = await query(
        `UPDATE amare_attendance_fees
            SET status = 'processing',
                processing_token = $2::uuid,
                processing_started_at = NOW(),
                attempt_count = attempt_count + 1,
                last_attempt_at = NOW(),
                updated_at = NOW()
          WHERE visit_id = $1
            AND (
              status = 'pending'
              OR (
                status = 'failed'
                AND failure_class = 'retryable'
                AND (next_retry_at IS NULL OR next_retry_at <= NOW())
              )
              OR (
                status = 'processing'
                AND processing_started_at IS NOT NULL
                AND processing_started_at < NOW() - ($3::int * interval '1 second')
              )
            )
          RETURNING *`,
        [Math.trunc(Number(visitId)), token, Math.ceil(staleMs / 1000)],
      );
      if (r.rows[0]) {
        return {
          acquired: true,
          processingToken: token,
          record: mapAttendanceFeeRow(r.rows[0]),
        };
      }
      const existing = await this.getAttendanceFeeByVisitId(visitId);
      return {
        acquired: false,
        reason: existing ? "not_processable" : "not_found",
        record: existing,
      };
    },

    async markAttendanceFeeCharged(visitId, payload = {}) {
      const r = await query(
        `UPDATE amare_attendance_fees
            SET status = 'charged',
                charged_at = COALESCE($2::timestamptz, NOW()),
                stripe_customer_id = COALESCE($3, stripe_customer_id),
                stripe_invoice_id = COALESCE($4, stripe_invoice_id),
                stripe_payment_intent_id = COALESCE($5, stripe_payment_intent_id),
                processing_token = NULL,
                processing_started_at = NULL,
                failure_class = NULL,
                failure_code = NULL,
                failure_message = NULL,
                updated_at = NOW()
          WHERE visit_id = $1
            AND status = 'processing'
          RETURNING *`,
        [
          Math.trunc(Number(visitId)),
          payload.chargedAt ?? null,
          payload.stripeCustomerId ?? null,
          payload.stripeInvoiceId ?? null,
          payload.stripePaymentIntentId ?? null,
        ],
      );
      if (r.rows[0]) return { ok: true, record: mapAttendanceFeeRow(r.rows[0]) };
      const existing = await this.getAttendanceFeeByVisitId(visitId);
      return { ok: false, reason: existing ? "invalid_status" : "not_found", record: existing };
    },

    async markAttendanceFeeProcessingStripeRefs(visitId, payload = {}) {
      const r = await query(
        `UPDATE amare_attendance_fees
            SET stripe_customer_id = COALESCE($2, stripe_customer_id),
                stripe_invoice_id = COALESCE($3, stripe_invoice_id),
                stripe_payment_intent_id = COALESCE($4, stripe_payment_intent_id),
                updated_at = NOW()
          WHERE visit_id = $1
            AND status = 'processing'
          RETURNING *`,
        [
          Math.trunc(Number(visitId)),
          payload.stripeCustomerId ?? null,
          payload.stripeInvoiceId ?? null,
          payload.stripePaymentIntentId ?? null,
        ],
      );
      if (r.rows[0]) return { ok: true, record: mapAttendanceFeeRow(r.rows[0]) };
      const existing = await this.getAttendanceFeeByVisitId(visitId);
      return { ok: false, reason: existing ? "invalid_status" : "not_found", record: existing };
    },

    async markAttendanceFeeFailed(visitId, payload = {}) {
      const failureClass = payload.failureClass === "permanent" ? "permanent" : "retryable";
      const r = await query(
        `UPDATE amare_attendance_fees
            SET status = 'failed',
                failure_class = $2,
                failure_code = $3,
                failure_message = $4,
                next_retry_at = $5::timestamptz,
                processing_token = NULL,
                processing_started_at = NULL,
                updated_at = NOW()
          WHERE visit_id = $1
            AND status = 'processing'
          RETURNING *`,
        [
          Math.trunc(Number(visitId)),
          failureClass,
          payload.failureCode ?? null,
          payload.failureMessage ?? null,
          payload.nextRetryAt ?? null,
        ],
      );
      if (r.rows[0]) return { ok: true, record: mapAttendanceFeeRow(r.rows[0]) };
      const existing = await this.getAttendanceFeeByVisitId(visitId);
      return { ok: false, reason: existing ? "invalid_status" : "not_found", record: existing };
    },

    async markAttendanceFeeSkipped(rec) {
      return this.insertAttendanceFeeCandidate({ ...rec, status: "skipped" });
    },

    async markAttendanceFeeWaived(visitId, payload = {}) {
      const r = await query(
        `UPDATE amare_attendance_fees
            SET status = 'waived',
                skip_reason = COALESCE($2, skip_reason, 'waived'),
                processing_token = NULL,
                processing_started_at = NULL,
                updated_at = NOW()
          WHERE visit_id = $1
          RETURNING *`,
        [Math.trunc(Number(visitId)), payload.skipReason ?? null],
      );
      if (r.rows[0]) return { ok: true, record: mapAttendanceFeeRow(r.rows[0]) };
      return { ok: false, reason: "not_found", record: null };
    },

    async releaseStaleProcessing(visitId, opts = {}) {
      const staleMs = staleIntervalMs(opts.staleMs ?? ATTENDANCE_FEE_STALE_PROCESSING_MS);
      const r = await query(
        `UPDATE amare_attendance_fees
            SET status = 'pending',
                processing_token = NULL,
                processing_started_at = NULL,
                updated_at = NOW()
          WHERE visit_id = $1
            AND status = 'processing'
            AND processing_started_at IS NOT NULL
            AND processing_started_at < NOW() - ($2::int * interval '1 second')
          RETURNING *`,
        [Math.trunc(Number(visitId)), Math.ceil(staleMs / 1000)],
      );
      if (r.rows[0]) return { ok: true, record: mapAttendanceFeeRow(r.rows[0]) };
      return { ok: false, reason: "not_stale_processing", record: await this.getAttendanceFeeByVisitId(visitId) };
    },

    async listProcessableAttendanceFees(opts = {}) {
      const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 500);
      const staleMs = staleIntervalMs(opts.staleMs ?? ATTENDANCE_FEE_STALE_PROCESSING_MS);
      const visitIdMin =
        opts.visitIdMin != null && Number.isFinite(Number(opts.visitIdMin))
          ? Math.trunc(Number(opts.visitIdMin))
          : null;
      const visitIdMax =
        opts.visitIdMax != null && Number.isFinite(Number(opts.visitIdMax))
          ? Math.trunc(Number(opts.visitIdMax))
          : null;
      const r = await query(
        `SELECT *
           FROM amare_attendance_fees
          WHERE (
              status = 'pending'
             OR (
               status = 'failed'
               AND failure_class = 'retryable'
               AND (next_retry_at IS NULL OR next_retry_at <= NOW())
             )
             OR (
               status = 'processing'
               AND processing_started_at IS NOT NULL
               AND processing_started_at < NOW() - ($2::int * interval '1 second')
             )
            )
            AND ($3::bigint IS NULL OR visit_id >= $3::bigint)
            AND ($4::bigint IS NULL OR visit_id <= $4::bigint)
          ORDER BY created_at ASC
          LIMIT $1`,
        [limit, Math.ceil(staleMs / 1000), visitIdMin, visitIdMax],
      );
      return r.rows.map((row) => mapAttendanceFeeRow(row));
    },
  };
}

export class AttendanceFeeDbUnconfiguredError extends Error {
  constructor(message = "attendance_fee_db_unconfigured") {
    super(message);
    this.name = "AttendanceFeeDbUnconfiguredError";
    this.code = "attendance_fee_db_unconfigured";
  }
}

function shouldUseAttendanceFeeMemoryStore(opts = {}) {
  return opts.forceMemory === true;
}

/** @type {ReturnType<typeof createMemoryAttendanceFeeStore> | null} */
let sharedMemoryAttendanceFeeStore = null;

/**
 * @param {{ forceMemory?: boolean }} [opts]
 */
export function openAttendanceFeeStore(opts = {}) {
  if (shouldUseAttendanceFeeMemoryStore(opts)) {
    if (!sharedMemoryAttendanceFeeStore) {
      sharedMemoryAttendanceFeeStore = createMemoryAttendanceFeeStore();
    }
    return sharedMemoryAttendanceFeeStore;
  }
  const url = attendanceFeeDatabaseUrl();
  if (!url) {
    throw new AttendanceFeeDbUnconfiguredError();
  }
  return createPostgresAttendanceFeeStore();
}

export function resetAttendanceFeeStoreForTests() {
  sharedMemoryAttendanceFeeStore = createMemoryAttendanceFeeStore();
  return sharedMemoryAttendanceFeeStore;
}

export function openAttendanceFeeStoreForTests() {
  return resetAttendanceFeeStoreForTests();
}

export const __testing = {
  shouldUseAttendanceFeeMemoryStore,
  isAttendanceFeeRowProcessable,
};
