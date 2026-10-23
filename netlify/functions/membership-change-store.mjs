/**
 * Durable ledger for admin membership plan changes (Postgres `amare_membership_change_operations`).
 *
 * The per-subscription lock is the partial unique index on `subscription_record_id` for active
 * statuses, so two admins (or two clicks) cannot both hold an operation for one subscription.
 * `request_id` is the client idempotency key: a repeated submit returns the original row.
 *
 * Memory adapter mirrors the same constraints for tests.
 */

import { randomUUID } from "node:crypto";
import { getConnectionString, getDatabase } from "@netlify/database";

export const MEMBERSHIP_CHANGE_ACTIVE_STATUSES = Object.freeze([
  "executing",
  "scheduled",
  "syncing",
  "needs_reconciliation",
]);

export const MEMBERSHIP_CHANGE_STATUSES = Object.freeze([
  ...MEMBERSHIP_CHANGE_ACTIVE_STATUSES,
  "completed",
  "payment_required",
  "failed",
  "canceled",
]);

/** Columns an operation update may set. Anything else in a patch is ignored. */
const UPDATABLE_COLUMNS = Object.freeze({
  status: "status",
  effectiveAt: "effective_at",
  stripeProductId: "stripe_product_id",
  stripePriceId: "stripe_price_id",
  stripeInvoiceId: "stripe_invoice_id",
  stripePaymentIntentId: "stripe_payment_intent_id",
  stripeScheduleId: "stripe_schedule_id",
  stripeIdempotencyKey: "stripe_idempotency_key",
  amountChargedCents: "amount_charged_cents",
  mindbodySaleId: "mindbody_sale_id",
  mindbodyClientServiceId: "mindbody_client_service_id",
  errorCode: "error_code",
  errorMessage: "error_message",
  recoveryNote: "recovery_note",
  completedAt: "completed_at",
});

/** @param {string} status */
export function isActiveMembershipChangeStatus(status) {
  return MEMBERSHIP_CHANGE_ACTIVE_STATUSES.includes(String(status || ""));
}

/**
 * @typedef {{
 *   id: string,
 *   requestId: string,
 *   subscriptionRecordId: string,
 *   stripeSubscriptionId: string,
 *   stripeCustomerId: string | null,
 *   mindbodyClientId: number | null,
 *   actorId: string,
 *   actorRole: string | null,
 *   fromSku: string,
 *   toSku: string,
 *   direction: "upgrade" | "downgrade",
 *   timing: "immediate" | "next_cycle",
 *   billingPolicy: "new_cycle_no_credit" | "new_cycle_with_credit" | "scheduled_no_charge",
 *   previewAmountCents: number | null,
 *   previewFingerprint: string | null,
 *   previewCreatedAt: string | null,
 *   targetAmountCents: number,
 *   effectiveAt: string | null,
 *   status: string,
 *   stripeProductId: string | null,
 *   stripePriceId: string | null,
 *   stripeInvoiceId: string | null,
 *   stripePaymentIntentId: string | null,
 *   stripeScheduleId: string | null,
 *   stripeIdempotencyKey: string | null,
 *   amountChargedCents: number | null,
 *   mindbodySaleId: string | null,
 *   mindbodyClientServiceId: string | null,
 *   warnings: unknown[],
 *   acknowledgements: Record<string, unknown>,
 *   errorCode: string | null,
 *   errorMessage: string | null,
 *   recoveryNote: string | null,
 *   attemptCount: number,
 *   createdAt: string | null,
 *   updatedAt: string | null,
 *   completedAt: string | null,
 * }} MembershipChangeOperation
 */

/** @param {unknown} v */
function isoOrNull(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/** @param {unknown} v */
function numOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** @param {unknown} v @param {unknown} fallback */
function jsonValue(v, fallback) {
  if (v == null) return fallback;
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return fallback;
    }
  }
  return v;
}

/**
 * @param {Record<string, unknown>} row
 * @returns {MembershipChangeOperation}
 */
export function mapMembershipChangeRow(row) {
  return {
    id: String(row.id),
    requestId: String(row.request_id),
    subscriptionRecordId: String(row.subscription_record_id),
    stripeSubscriptionId: String(row.stripe_subscription_id),
    stripeCustomerId: row.stripe_customer_id == null ? null : String(row.stripe_customer_id),
    mindbodyClientId: numOrNull(row.mindbody_client_id),
    actorId: String(row.actor_id),
    actorRole: row.actor_role == null ? null : String(row.actor_role),
    fromSku: String(row.from_sku),
    toSku: String(row.to_sku),
    direction: /** @type {"upgrade" | "downgrade"} */ (String(row.direction)),
    timing: /** @type {"immediate" | "next_cycle"} */ (String(row.timing)),
    billingPolicy: /** @type {MembershipChangeOperation["billingPolicy"]} */ (String(row.billing_policy)),
    previewAmountCents: numOrNull(row.preview_amount_cents),
    previewFingerprint: row.preview_fingerprint == null ? null : String(row.preview_fingerprint),
    previewCreatedAt: isoOrNull(row.preview_created_at),
    targetAmountCents: Number(row.target_amount_cents),
    effectiveAt: isoOrNull(row.effective_at),
    status: String(row.status),
    stripeProductId: row.stripe_product_id == null ? null : String(row.stripe_product_id),
    stripePriceId: row.stripe_price_id == null ? null : String(row.stripe_price_id),
    stripeInvoiceId: row.stripe_invoice_id == null ? null : String(row.stripe_invoice_id),
    stripePaymentIntentId: row.stripe_payment_intent_id == null ? null : String(row.stripe_payment_intent_id),
    stripeScheduleId: row.stripe_schedule_id == null ? null : String(row.stripe_schedule_id),
    stripeIdempotencyKey: row.stripe_idempotency_key == null ? null : String(row.stripe_idempotency_key),
    amountChargedCents: numOrNull(row.amount_charged_cents),
    mindbodySaleId: row.mindbody_sale_id == null ? null : String(row.mindbody_sale_id),
    mindbodyClientServiceId:
      row.mindbody_client_service_id == null ? null : String(row.mindbody_client_service_id),
    warnings: /** @type {unknown[]} */ (jsonValue(row.warnings, [])),
    acknowledgements: /** @type {Record<string, unknown>} */ (jsonValue(row.acknowledgements, {})),
    errorCode: row.error_code == null ? null : String(row.error_code),
    errorMessage: row.error_message == null ? null : String(row.error_message),
    recoveryNote: row.recovery_note == null ? null : String(row.recovery_note),
    attemptCount: Number(row.attempt_count ?? 0),
    createdAt: isoOrNull(row.created_at),
    updatedAt: isoOrNull(row.updated_at),
    completedAt: isoOrNull(row.completed_at),
  };
}

/**
 * @param {Partial<MembershipChangeOperation>} input
 * @returns {Record<string, unknown>}
 */
function rowFromInput(input) {
  const now = new Date().toISOString();
  return {
    id: input.id || randomUUID(),
    request_id: input.requestId,
    subscription_record_id: input.subscriptionRecordId,
    stripe_subscription_id: input.stripeSubscriptionId,
    stripe_customer_id: input.stripeCustomerId ?? null,
    mindbody_client_id: input.mindbodyClientId ?? null,
    actor_id: input.actorId,
    actor_role: input.actorRole ?? null,
    from_sku: input.fromSku,
    to_sku: input.toSku,
    direction: input.direction,
    timing: input.timing,
    billing_policy: input.billingPolicy,
    preview_amount_cents: input.previewAmountCents ?? null,
    preview_fingerprint: input.previewFingerprint ?? null,
    preview_created_at: input.previewCreatedAt ?? null,
    target_amount_cents: input.targetAmountCents,
    effective_at: input.effectiveAt ?? null,
    status: input.status || "executing",
    stripe_product_id: null,
    stripe_price_id: null,
    stripe_invoice_id: null,
    stripe_payment_intent_id: null,
    stripe_schedule_id: null,
    stripe_idempotency_key: input.stripeIdempotencyKey ?? null,
    amount_charged_cents: null,
    mindbody_sale_id: null,
    mindbody_client_service_id: null,
    warnings: input.warnings ?? [],
    acknowledgements: input.acknowledgements ?? {},
    error_code: null,
    error_message: null,
    recovery_note: null,
    attempt_count: 1,
    created_at: now,
    updated_at: now,
    completed_at: null,
  };
}

/** @param {Partial<MembershipChangeOperation>} input */
function validateInsert(input) {
  for (const k of [
    "requestId",
    "subscriptionRecordId",
    "stripeSubscriptionId",
    "actorId",
    "fromSku",
    "toSku",
    "direction",
    "timing",
    "billingPolicy",
  ]) {
    if (!input[/** @type {keyof MembershipChangeOperation} */ (k)]) {
      throw new Error(`membership_change_insert_missing_${k}`);
    }
  }
  if (!Number.isInteger(input.targetAmountCents)) {
    throw new Error("membership_change_insert_missing_targetAmountCents");
  }
  if (input.fromSku === input.toSku) throw new Error("membership_change_same_sku");
  const status = input.status || "executing";
  if (!isActiveMembershipChangeStatus(status)) {
    throw new Error(`membership_change_insert_must_be_active:${status}`);
  }
}

/** @param {Partial<MembershipChangeOperation>} patch */
function validatePatch(patch) {
  if (patch.status && !MEMBERSHIP_CHANGE_STATUSES.includes(patch.status)) {
    throw new Error(`membership_change_invalid_status:${patch.status}`);
  }
}

export function createMemoryMembershipChangeStore() {
  /** @type {Map<string, Record<string, unknown>>} */
  const rows = new Map();

  /** @param {string} subscriptionRecordId */
  function activeFor(subscriptionRecordId) {
    for (const r of rows.values()) {
      if (r.subscription_record_id === subscriptionRecordId && isActiveMembershipChangeStatus(String(r.status))) {
        return r;
      }
    }
    return null;
  }

  return {
    kind: /** @type {const} */ ("memory"),

    /** @param {Partial<MembershipChangeOperation>} input */
    async insertOperation(input) {
      validateInsert(input);
      for (const r of rows.values()) {
        if (r.request_id === input.requestId) {
          return { created: false, reason: "request_id_exists", operation: mapMembershipChangeRow(r) };
        }
      }
      const active = activeFor(String(input.subscriptionRecordId));
      if (active) {
        return { created: false, reason: "active_operation_exists", operation: mapMembershipChangeRow(active) };
      }
      const row = rowFromInput(input);
      rows.set(String(row.id), row);
      return { created: true, reason: null, operation: mapMembershipChangeRow(row) };
    },

    /** @param {string} id */
    async getOperation(id) {
      const r = rows.get(String(id));
      return r ? mapMembershipChangeRow(r) : null;
    },

    /** @param {string} requestId */
    async getOperationByRequestId(requestId) {
      for (const r of rows.values()) {
        if (r.request_id === requestId) return mapMembershipChangeRow(r);
      }
      return null;
    },

    /** @param {string} subscriptionRecordId */
    async getActiveOperation(subscriptionRecordId) {
      const r = activeFor(subscriptionRecordId);
      return r ? mapMembershipChangeRow(r) : null;
    },

    /** @param {string} subscriptionRecordId @param {number} [limit] */
    async listOperations(subscriptionRecordId, limit = 20) {
      return [...rows.values()]
        .filter((r) => r.subscription_record_id === subscriptionRecordId)
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, Math.max(1, Math.min(100, limit)))
        .map(mapMembershipChangeRow);
    },

    /**
     * Compare-and-set on status. Returns null when the row is missing or not in `expectStatuses`.
     * @param {string} id
     * @param {Partial<MembershipChangeOperation>} patch
     * @param {{ expectStatuses?: string[], incrementAttempt?: boolean }} [opts]
     */
    async updateOperation(id, patch, opts = {}) {
      validatePatch(patch);
      const r = rows.get(String(id));
      if (!r) return null;
      if (opts.expectStatuses && !opts.expectStatuses.includes(String(r.status))) return null;
      if (patch.status && isActiveMembershipChangeStatus(patch.status)) {
        const other = activeFor(String(r.subscription_record_id));
        if (other && other.id !== r.id) throw new Error("membership_change_active_conflict");
      }
      for (const [key, col] of Object.entries(UPDATABLE_COLUMNS)) {
        if (Object.prototype.hasOwnProperty.call(patch, key)) {
          r[col] = /** @type {Record<string, unknown>} */ (patch)[key] ?? null;
        }
      }
      if (opts.incrementAttempt) r.attempt_count = Number(r.attempt_count ?? 0) + 1;
      r.updated_at = new Date().toISOString();
      return mapMembershipChangeRow(r);
    },

    async resetForTests() {
      rows.clear();
    },
  };
}

export function membershipChangeDatabaseUrl() {
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
let cachedDb = null;

/**
 * Shared Netlify Database query for membership-change tables (ledger + billing admins).
 * @param {string} text
 * @param {unknown[]} [values]
 */
export async function membershipChangeDbQuery(text, values = []) {
  return query(text, values);
}

/**
 * @param {string} text
 * @param {unknown[]} [values]
 */
async function query(text, values = []) {
  const url = membershipChangeDatabaseUrl();
  if (!url) throw new Error("membership_change_db_unconfigured");
  if (!cachedDb || cachedDb.url !== url) {
    cachedDb = { url, db: getDatabase({ connectionString: url }) };
  }
  const result = await cachedDb.db.pool.query(text, values);
  return { rows: result.rows || [] };
}

const ACTIVE_SQL_LIST = MEMBERSHIP_CHANGE_ACTIVE_STATUSES.map((s) => `'${s}'`).join(", ");

export function createPostgresMembershipChangeStore() {
  return {
    kind: /** @type {const} */ ("postgres"),

    /** @param {Partial<MembershipChangeOperation>} input */
    async insertOperation(input) {
      validateInsert(input);
      const row = rowFromInput(input);
      const r = await query(
        `INSERT INTO amare_membership_change_operations (
           id, request_id, subscription_record_id, stripe_subscription_id, stripe_customer_id,
           mindbody_client_id, actor_id, actor_role, from_sku, to_sku, direction, timing,
           billing_policy, preview_amount_cents, preview_fingerprint, preview_created_at,
           target_amount_cents, effective_at, status, stripe_idempotency_key, warnings,
           acknowledgements, attempt_count
         ) VALUES (
           $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
           $17, $18, $19, $20, $21::jsonb, $22::jsonb, 1
         )
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [
          row.id,
          row.request_id,
          row.subscription_record_id,
          row.stripe_subscription_id,
          row.stripe_customer_id,
          row.mindbody_client_id,
          row.actor_id,
          row.actor_role,
          row.from_sku,
          row.to_sku,
          row.direction,
          row.timing,
          row.billing_policy,
          row.preview_amount_cents,
          row.preview_fingerprint,
          row.preview_created_at,
          row.target_amount_cents,
          row.effective_at,
          row.status,
          row.stripe_idempotency_key,
          JSON.stringify(row.warnings ?? []),
          JSON.stringify(row.acknowledgements ?? {}),
        ],
      );
      if (r.rows[0]) {
        return { created: true, reason: null, operation: mapMembershipChangeRow(r.rows[0]) };
      }
      const byRequest = await this.getOperationByRequestId(String(input.requestId));
      if (byRequest) return { created: false, reason: "request_id_exists", operation: byRequest };
      const active = await this.getActiveOperation(String(input.subscriptionRecordId));
      return { created: false, reason: "active_operation_exists", operation: active };
    },

    /** @param {string} id */
    async getOperation(id) {
      if (!/^[0-9a-f-]{36}$/i.test(String(id))) return null;
      const r = await query(`SELECT * FROM amare_membership_change_operations WHERE id = $1::uuid`, [id]);
      return r.rows[0] ? mapMembershipChangeRow(r.rows[0]) : null;
    },

    /** @param {string} requestId */
    async getOperationByRequestId(requestId) {
      const r = await query(`SELECT * FROM amare_membership_change_operations WHERE request_id = $1`, [
        requestId,
      ]);
      return r.rows[0] ? mapMembershipChangeRow(r.rows[0]) : null;
    },

    /** @param {string} subscriptionRecordId */
    async getActiveOperation(subscriptionRecordId) {
      const r = await query(
        `SELECT * FROM amare_membership_change_operations
          WHERE subscription_record_id = $1 AND status IN (${ACTIVE_SQL_LIST})
          LIMIT 1`,
        [subscriptionRecordId],
      );
      return r.rows[0] ? mapMembershipChangeRow(r.rows[0]) : null;
    },

    /** @param {string} subscriptionRecordId @param {number} [limit] */
    async listOperations(subscriptionRecordId, limit = 20) {
      const r = await query(
        `SELECT * FROM amare_membership_change_operations
          WHERE subscription_record_id = $1
          ORDER BY created_at DESC
          LIMIT $2`,
        [subscriptionRecordId, Math.max(1, Math.min(100, Math.trunc(limit)))],
      );
      return r.rows.map(mapMembershipChangeRow);
    },

    /**
     * @param {string} id
     * @param {Partial<MembershipChangeOperation>} patch
     * @param {{ expectStatuses?: string[], incrementAttempt?: boolean }} [opts]
     */
    async updateOperation(id, patch, opts = {}) {
      validatePatch(patch);
      /** @type {string[]} */
      const sets = [];
      /** @type {unknown[]} */
      const values = [id];
      for (const [key, col] of Object.entries(UPDATABLE_COLUMNS)) {
        if (Object.prototype.hasOwnProperty.call(patch, key)) {
          values.push(/** @type {Record<string, unknown>} */ (patch)[key] ?? null);
          sets.push(`${col} = $${values.length}`);
        }
      }
      if (opts.incrementAttempt) sets.push("attempt_count = attempt_count + 1");
      sets.push("updated_at = NOW()");
      let where = "id = $1::uuid";
      if (opts.expectStatuses?.length) {
        values.push(opts.expectStatuses);
        where += ` AND status = ANY($${values.length}::text[])`;
      }
      const r = await query(
        `UPDATE amare_membership_change_operations SET ${sets.join(", ")} WHERE ${where} RETURNING *`,
        values,
      );
      return r.rows[0] ? mapMembershipChangeRow(r.rows[0]) : null;
    },
  };
}

/** @type {ReturnType<typeof createMemoryMembershipChangeStore> | null} */
let sharedMemoryStore = null;

export class MembershipChangeDbUnconfiguredError extends Error {
  constructor() {
    super("membership_change_db_unconfigured");
    this.code = "membership_change_db_unconfigured";
  }
}

/** @param {{ forceMemory?: boolean }} [opts] */
export function openMembershipChangeStore(opts = {}) {
  const envMemory =
    !(process.env.NETLIFY || "").trim() && (process.env.MEMBERSHIP_CHANGE_STORE_MEMORY || "").trim() === "1";
  if (opts.forceMemory === true || envMemory) {
    if (!sharedMemoryStore) sharedMemoryStore = createMemoryMembershipChangeStore();
    return sharedMemoryStore;
  }
  if (!membershipChangeDatabaseUrl()) throw new MembershipChangeDbUnconfiguredError();
  return createPostgresMembershipChangeStore();
}

export function resetMembershipChangeStoreForTests() {
  sharedMemoryStore = createMemoryMembershipChangeStore();
  return sharedMemoryStore;
}
