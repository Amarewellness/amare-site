/**
 * AMARÉ Annual Membership durable store (Phase 1).
 * Memory adapter for tests; Postgres when DATABASE_URL is configured.
 * No Stripe webhook, Mindbody checkout, or scheduled reconciler in this phase.
 */

import { randomUUID } from "node:crypto";
import { getConnectionString, getDatabase } from "@netlify/database";
import {
  ANNUAL_ISSUANCE_ELIGIBLE_MEMBERSHIP_STATUSES,
  ANNUAL_REVOKE_SKIPPABLE_PERIOD_STATUSES,
  ANNUAL_TIMEZONE,
  assertAnnualSku,
  assessAnnualPeriodRevokeEligibility,
  buildAnnualMembershipPeriods,
  formatAnnualBusinessDate,
  getAnnualSkuDefinition,
  isAnnualFailedPeriodProvablySafeToSkip,
  isRealStripeSubscriptionId,
  shouldBackfillAnnualStripeSubscriptionId,
} from "./annual-membership-lib.mjs";

export const STALE_CLAIM_MS = 15 * 60 * 1000;

/**
 * @param {Record<string, unknown> | null | undefined} row
 */
function cloneRow(row) {
  if (!row) return null;
  return {
    ...row,
    pre_issue_client_service_ids: Array.isArray(row.pre_issue_client_service_ids)
      ? [...row.pre_issue_client_service_ids]
      : row.pre_issue_client_service_ids,
  };
}

/**
 * @param {unknown} value
 */
function formatPgDate(value) {
  return formatAnnualBusinessDate(value) || "";
}

/**
 * @param {string} existingSubId
 * @param {string} incomingSubId
 * @param {{ membershipId?: string; stripeInvoiceId?: string }} context
 */
function warnAnnualStripeSubConflict(existingSubId, incomingSubId, context = {}) {
  console.warn(
    JSON.stringify({
      event: "annual_stripe_sub_id_conflict",
      existing_stripe_subscription_id: existingSubId,
      incoming_stripe_subscription_id: incomingSubId,
      annual_membership_id: context.membershipId ?? null,
      stripe_invoice_id: context.stripeInvoiceId ?? null,
    }),
  );
}

/**
 * @param {Record<string, unknown>} row
 */
function mapMembershipRow(row) {
  return {
    id: String(row.id),
    amare_user_id: row.amare_user_id == null ? null : String(row.amare_user_id),
    mindbody_client_id: Number(row.mindbody_client_id),
    stripe_customer_id: row.stripe_customer_id == null ? null : String(row.stripe_customer_id),
    stripe_subscription_id: String(row.stripe_subscription_id),
    stripe_invoice_id: String(row.stripe_invoice_id),
    stripe_price_id: row.stripe_price_id == null ? null : String(row.stripe_price_id),
    sku: String(row.sku),
    status: String(row.status),
    term_start_date: formatPgDate(row.term_start_date),
    term_end_date: formatPgDate(row.term_end_date),
    stripe_period_start_at: row.stripe_period_start_at ?? null,
    stripe_period_end_at: row.stripe_period_end_at ?? null,
    annual_amount_cents: Number(row.annual_amount_cents),
    timezone: String(row.timezone || ANNUAL_TIMEZONE),
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  };
}

/**
 * @param {Record<string, unknown>} row
 */
function mapPeriodRow(row) {
  /** @type {number[] | null} */
  let preIssueIds = null;
  if (Array.isArray(row.pre_issue_client_service_ids)) {
    preIssueIds = row.pre_issue_client_service_ids.map((v) => Number(v));
  } else if (typeof row.pre_issue_client_service_ids === "string") {
    try {
      const parsed = JSON.parse(row.pre_issue_client_service_ids);
      if (Array.isArray(parsed)) preIssueIds = parsed.map((v) => Number(v));
    } catch {
      preIssueIds = null;
    }
  }

  return {
    id: String(row.id),
    annual_membership_id: String(row.annual_membership_id),
    period_index: Number(row.period_index),
    period_start_date: formatPgDate(row.period_start_date),
    period_end_date: formatPgDate(row.period_end_date),
    status: String(row.status),
    mindbody_product_id: Number(row.mindbody_product_id),
    expected_list_amount_cents: Number(row.expected_list_amount_cents),
    expected_discount_amount_cents: Number(row.expected_discount_amount_cents),
    expected_net_amount_cents: Number(row.expected_net_amount_cents),
    mindbody_sale_id: row.mindbody_sale_id == null ? null : Number(row.mindbody_sale_id),
    mindbody_client_service_id:
      row.mindbody_client_service_id == null ? null : Number(row.mindbody_client_service_id),
    claim_token: row.claim_token == null ? null : String(row.claim_token),
    claim_started_at: row.claim_started_at ?? null,
    claimed_at: row.claimed_at ?? null,
    pre_issue_client_service_ids: preIssueIds,
    attempt_count: Number(row.attempt_count ?? 0),
    last_attempt_at: row.last_attempt_at ?? null,
    last_error: row.last_error == null ? null : String(row.last_error),
    issued_at: row.issued_at ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  };
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * @param {unknown} dateStr
 */
function assertIsoDate(dateStr) {
  if (typeof dateStr !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new Error("invalid_business_date");
  }
  return dateStr;
}

export function createMemoryAnnualMembershipStore() {
  /** @type {Map<string, Record<string, unknown>>} */
  const memberships = new Map();
  /** @type {Map<string, Record<string, unknown>>} */
  const periods = new Map();
  /** @type {Map<string, string>} */
  const membershipByInvoice = new Map();

  /**
   * @param {string} membershipId
   */
  function listPeriodsForMembership(membershipId) {
    return [...periods.values()]
      .filter((row) => String(row.annual_membership_id) === membershipId)
      .sort((a, b) => Number(a.period_index) - Number(b.period_index))
      .map((row) => mapPeriodRow(row));
  }

  return {
    kind: "memory",

    async createAnnualTermWithPeriods(input) {
      const sku = assertAnnualSku(input.sku);
      const pricing = getAnnualSkuDefinition(sku);
      const stripeInvoiceId = String(input.stripeInvoiceId || "").trim();
      const stripeSubscriptionId = String(input.stripeSubscriptionId || "").trim();
      if (!stripeInvoiceId) throw new Error("missing_stripe_invoice_id");
      if (!stripeSubscriptionId) throw new Error("missing_stripe_subscription_id");
      if (!Number.isInteger(input.mindbodyClientId) || input.mindbodyClientId <= 0) {
        throw new Error("invalid_mindbody_client_id");
      }

      const termStartDate = assertIsoDate(input.termStartDate);
      const termEndDate = assertIsoDate(input.termEndDate);
      const periodDefs = buildAnnualMembershipPeriods({ termStartDate, termEndDate, sku });
      const annualAmountCents =
        typeof input.annualAmountCents === "number" && Number.isInteger(input.annualAmountCents)
          ? input.annualAmountCents
          : pricing.annualTotalCents;

      const existingId = membershipByInvoice.get(stripeInvoiceId);
      if (existingId) {
        const membership = memberships.get(existingId);
        const existingSub = String(membership.stripe_subscription_id || "");
        if (
          shouldBackfillAnnualStripeSubscriptionId(existingSub, stripeSubscriptionId) &&
          stripeSubscriptionId !== existingSub
        ) {
          membership.stripe_subscription_id = stripeSubscriptionId;
          membership.updated_at = nowIso();
        } else if (
          isRealStripeSubscriptionId(existingSub) &&
          isRealStripeSubscriptionId(stripeSubscriptionId) &&
          existingSub !== stripeSubscriptionId
        ) {
          warnAnnualStripeSubConflict(existingSub, stripeSubscriptionId, {
            membershipId: existingId,
            stripeInvoiceId,
          });
        }
        return {
          created: false,
          membership: mapMembershipRow(membership),
          periods: listPeriodsForMembership(existingId),
        };
      }

      const ts = nowIso();
      const membershipId = randomUUID();
      /** @type {Record<string, unknown>} */
      const membership = {
        id: membershipId,
        amare_user_id: input.amareUserId ? String(input.amareUserId) : null,
        mindbody_client_id: input.mindbodyClientId,
        stripe_customer_id: input.stripeCustomerId ? String(input.stripeCustomerId) : null,
        stripe_subscription_id: stripeSubscriptionId,
        stripe_invoice_id: stripeInvoiceId,
        stripe_price_id: input.stripePriceId ? String(input.stripePriceId) : null,
        sku,
        status: input.status ? String(input.status) : "active",
        term_start_date: termStartDate,
        term_end_date: termEndDate,
        stripe_period_start_at: input.stripePeriodStartAt ?? null,
        stripe_period_end_at: input.stripePeriodEndAt ?? null,
        annual_amount_cents: annualAmountCents,
        timezone: input.timezone ? String(input.timezone) : ANNUAL_TIMEZONE,
        created_at: ts,
        updated_at: ts,
      };
      memberships.set(membershipId, membership);
      membershipByInvoice.set(stripeInvoiceId, membershipId);

      for (const def of periodDefs) {
        const periodId = randomUUID();
        periods.set(periodId, {
          id: periodId,
          annual_membership_id: membershipId,
          period_index: def.periodIndex,
          period_start_date: def.periodStartDate,
          period_end_date: def.periodEndDate,
          status: "pending",
          mindbody_product_id: def.mindbodyProductId,
          expected_list_amount_cents: def.expectedListAmountCents,
          expected_discount_amount_cents: def.expectedDiscountAmountCents,
          expected_net_amount_cents: def.expectedNetAmountCents,
          mindbody_sale_id: null,
          mindbody_client_service_id: null,
          claim_token: null,
          claim_started_at: null,
          claimed_at: null,
          pre_issue_client_service_ids: null,
          attempt_count: 0,
          last_attempt_at: null,
          last_error: null,
          issued_at: null,
          created_at: ts,
          updated_at: ts,
        });
      }

      return {
        created: true,
        membership: mapMembershipRow(membership),
        periods: listPeriodsForMembership(membershipId),
      };
    },

    async getAnnualMembership(membershipId) {
      const row = memberships.get(String(membershipId || ""));
      return row ? mapMembershipRow(row) : null;
    },

    async getAnnualMembershipByInvoiceId(stripeInvoiceId) {
      const id = membershipByInvoice.get(String(stripeInvoiceId || "").trim());
      return id ? this.getAnnualMembership(id) : null;
    },

    async getAnnualPeriod(periodId) {
      const row = periods.get(String(periodId || ""));
      return row ? mapPeriodRow(row) : null;
    },

    async getAnnualPeriodByMembershipIndex(annualMembershipId, periodIndex) {
      const row = [...periods.values()].find(
        (p) =>
          String(p.annual_membership_id) === String(annualMembershipId) &&
          Number(p.period_index) === Number(periodIndex),
      );
      return row ? mapPeriodRow(row) : null;
    },

    async listDuePeriods(asOfDate, opts = {}) {
      const date = assertIsoDate(asOfDate);
      const statuses = opts.statuses ?? ["pending", "failed"];
      const parentStatuses =
        opts.eligibleMembershipStatuses ?? ANNUAL_ISSUANCE_ELIGIBLE_MEMBERSHIP_STATUSES;
      return [...periods.values()]
        .filter((row) => {
          if (!statuses.includes(String(row.status))) return false;
          if (String(row.period_start_date) > date) return false;
          const mem = memberships.get(String(row.annual_membership_id));
          if (!mem) return false;
          return parentStatuses.includes(String(mem.status));
        })
        .sort((a, b) => {
          const byDate = String(a.period_start_date).localeCompare(String(b.period_start_date));
          if (byDate !== 0) return byDate;
          return Number(a.period_index) - Number(b.period_index);
        })
        .map((row) => mapPeriodRow(row));
    },

    async listPeriodsForMembership(annualMembershipId) {
      return listPeriodsForMembership(String(annualMembershipId || ""));
    },

    async markPeriodSkipped(periodId, payload = {}) {
      const id = String(periodId || "");
      const row = periods.get(id);
      if (!row) return { ok: false, reason: "period_not_found", period: null };
      const st = String(row.status);
      const mapped = mapPeriodRow(row);
      const revocable =
        st === "claiming" ||
        ANNUAL_REVOKE_SKIPPABLE_PERIOD_STATUSES.includes(st) ||
        isAnnualFailedPeriodProvablySafeToSkip(mapped);
      if (!revocable) {
        return { ok: false, reason: "invalid_period_status", period: mapped };
      }
      row.status = "skipped";
      row.last_error = payload.reason ? String(payload.reason) : row.last_error;
      row.updated_at = nowIso();
      return { ok: true, period: mapPeriodRow(row) };
    },

    async revokeAnnualMembershipTerm(membershipId, payload = {}) {
      const id = String(membershipId || "");
      const membership = memberships.get(id);
      if (!membership) return { ok: false, reason: "membership_not_found" };
      const periodRows = listPeriodsForMembership(id);
      if (String(membership.status) === "revoked") {
        let healedCount = 0;
        for (const p of periodRows) {
          if (p.status === "skipped") continue;
          const assess = assessAnnualPeriodRevokeEligibility(p);
          if (!assess.skip) continue;
          const raw = periods.get(String(p.id));
          if (!raw) continue;
          raw.status = "skipped";
          raw.last_error = payload.reason ? String(payload.reason) : "admin_revoked_term";
          raw.updated_at = nowIso();
          healedCount += 1;
        }
        const after = listPeriodsForMembership(id);
        return {
          ok: true,
          idempotent: true,
          membership: mapMembershipRow(membership),
          skippedCount: healedCount,
          healedCount,
          issuedPreserved: after.filter((p) => p.status === "issued").length,
          futurePeriodsSkipped: after.filter((p) => p.status === "skipped").length,
        };
      }
      if (!["active", "past_due"].includes(String(membership.status))) {
        return {
          ok: false,
          reason: "membership_not_revocable",
          status: String(membership.status),
        };
      }
      for (const p of periodRows) {
        const assess = assessAnnualPeriodRevokeEligibility(p);
        if (assess.block) {
          return { ok: false, reason: assess.reason, periodId: assess.periodId ?? p.id };
        }
      }
      let skippedCount = 0;
      for (const p of periodRows) {
        const assess = assessAnnualPeriodRevokeEligibility(p);
        if (!assess.skip) continue;
        const raw = periods.get(String(p.id));
        if (raw) {
          raw.status = "skipped";
          raw.last_error = payload.reason ? String(payload.reason) : "admin_revoked_term";
          raw.updated_at = nowIso();
          skippedCount += 1;
        }
      }
      membership.status = "revoked";
      membership.updated_at = nowIso();
      const after = listPeriodsForMembership(id);
      return {
        ok: true,
        membership: mapMembershipRow(membership),
        skippedCount,
        issuedPreserved: after.filter((p) => p.status === "issued").length,
        futurePeriodsSkipped: after.filter((p) => p.status === "skipped").length,
      };
    },

    async claimPeriod(periodId) {
      const id = String(periodId || "");
      const row = periods.get(id);
      if (!row) return { ok: false, acquired: false, reason: "period_not_found", period: null };
      if (row.status !== "pending") {
        return { ok: true, acquired: false, period: mapPeriodRow(row) };
      }
      const ts = nowIso();
      row.status = "claiming";
      row.claim_token = randomUUID();
      row.claim_started_at = ts;
      row.claimed_at = ts;
      row.attempt_count = Number(row.attempt_count ?? 0) + 1;
      row.last_attempt_at = ts;
      row.updated_at = ts;
      return { ok: true, acquired: true, period: mapPeriodRow(row) };
    },

    async persistPreIssueSnapshot(periodId, snapshot) {
      const id = String(periodId || "");
      const row = periods.get(id);
      if (!row) return { ok: false, reason: "period_not_found", period: null };
      if (row.status !== "claiming") {
        return { ok: false, reason: "invalid_period_status", period: mapPeriodRow(row) };
      }
      const ids = Array.isArray(snapshot?.clientServiceIds)
        ? snapshot.clientServiceIds.map((v) => Number(v))
        : [];
      row.pre_issue_client_service_ids = ids;
      if (snapshot?.claimStartedAt) row.claim_started_at = String(snapshot.claimStartedAt);
      row.updated_at = nowIso();
      return { ok: true, period: mapPeriodRow(row) };
    },

    async markPeriodIssued(periodId, payload = {}) {
      const id = String(periodId || "");
      const row = periods.get(id);
      if (!row) return { ok: false, reason: "period_not_found", period: null };
      if (!["claiming", "ambiguous"].includes(String(row.status))) {
        return { ok: false, reason: "invalid_period_status", period: mapPeriodRow(row) };
      }
      const ts = nowIso();
      row.status = "issued";
      if (payload.mindbodySaleId != null) row.mindbody_sale_id = Number(payload.mindbodySaleId);
      if (payload.mindbodyClientServiceId != null) {
        row.mindbody_client_service_id = Number(payload.mindbodyClientServiceId);
      }
      row.issued_at = ts;
      row.last_error = null;
      row.updated_at = ts;
      return { ok: true, period: mapPeriodRow(row) };
    },

    async markPeriodFailed(periodId, payload = {}) {
      const id = String(periodId || "");
      const row = periods.get(id);
      if (!row) return { ok: false, reason: "period_not_found", period: null };
      if (!["claiming", "pending"].includes(String(row.status))) {
        return { ok: false, reason: "invalid_period_status", period: mapPeriodRow(row) };
      }
      row.status = "failed";
      row.last_error = payload.error ? String(payload.error) : null;
      row.updated_at = nowIso();
      return { ok: true, period: mapPeriodRow(row) };
    },

    async markPeriodAmbiguous(periodId, payload = {}) {
      const id = String(periodId || "");
      const row = periods.get(id);
      if (!row) return { ok: false, reason: "period_not_found", period: null };
      if (row.status !== "claiming") {
        return { ok: false, reason: "invalid_period_status", period: mapPeriodRow(row) };
      }
      row.status = "ambiguous";
      row.last_error = payload.error ? String(payload.error) : "mindbody_write_ambiguous";
      row.updated_at = nowIso();
      return { ok: true, period: mapPeriodRow(row) };
    },

    async markPeriodManualReview(periodId, payload = {}) {
      const id = String(periodId || "");
      const row = periods.get(id);
      if (!row) return { ok: false, reason: "period_not_found", period: null };
      if (row.status === "issued") {
        return { ok: false, reason: "invalid_period_status", period: mapPeriodRow(row) };
      }
      row.status = "manual_review";
      row.last_error = payload.error ? String(payload.error) : row.last_error;
      row.updated_at = nowIso();
      return { ok: true, period: mapPeriodRow(row) };
    },

    async releaseSafeRetryToPending(periodId, payload = {}) {
      const id = String(periodId || "");
      const row = periods.get(id);
      if (!row) return { ok: false, reason: "period_not_found", period: null };
      if (!["failed", "ambiguous"].includes(String(row.status))) {
        return { ok: false, reason: "invalid_period_status", period: mapPeriodRow(row) };
      }
      row.status = "pending";
      row.claim_token = null;
      row.claim_started_at = null;
      row.claimed_at = null;
      row.pre_issue_client_service_ids = null;
      row.last_error = payload.note ? String(payload.note) : row.last_error;
      row.updated_at = nowIso();
      return { ok: true, period: mapPeriodRow(row) };
    },

    async findStaleClaims(staleBeforeIso) {
      const cutoff = new Date(staleBeforeIso).getTime();
      return [...periods.values()]
        .filter((row) => {
          if (row.status !== "claiming" || !row.claim_started_at) return false;
          return new Date(String(row.claim_started_at)).getTime() <= cutoff;
        })
        .map((row) => mapPeriodRow(row));
    },

    async resetForTests() {
      memberships.clear();
      periods.clear();
      membershipByInvoice.clear();
    },

    /** @param {string} membershipId @param {string} status */
    async setMembershipStatusForTests(membershipId, status) {
      const row = memberships.get(String(membershipId || ""));
      if (!row) return { ok: false, reason: "membership_not_found" };
      row.status = String(status);
      row.updated_at = nowIso();
      return { ok: true, membership: mapMembershipRow(row) };
    },

    /** @param {string} periodId @param {string} status */
    async setPeriodStatusForTests(periodId, status) {
      const row = periods.get(String(periodId || ""));
      if (!row) return { ok: false, reason: "period_not_found" };
      row.status = String(status);
      row.updated_at = nowIso();
      return { ok: true, period: mapPeriodRow(row) };
    },

    /**
     * Admin read-only listing (memory store / local QA).
     * @param {{ id?: string; mindbodyClientId?: number; stripeSubscriptionId?: string; stripeInvoiceId?: string; limit?: number }} filters
     */
    async listMembershipsForAdmin(filters = {}) {
      const limit =
        typeof filters.limit === "number" && Number.isFinite(filters.limit)
          ? Math.min(Math.max(1, Math.trunc(filters.limit)), 20)
          : 5;
      if (filters.id) {
        const row = memberships.get(String(filters.id));
        return row ? [mapMembershipRow(row)] : [];
      }
      if (filters.stripeInvoiceId) {
        const memId = membershipByInvoice.get(String(filters.stripeInvoiceId).trim());
        if (!memId) return [];
        const row = memberships.get(memId);
        return row ? [mapMembershipRow(row)] : [];
      }
      let rows = [...memberships.values()];
      if (filters.stripeSubscriptionId) {
        const sub = String(filters.stripeSubscriptionId).trim();
        rows = rows.filter((row) => String(row.stripe_subscription_id) === sub);
      }
      if (typeof filters.mindbodyClientId === "number" && Number.isFinite(filters.mindbodyClientId)) {
        rows = rows.filter((row) => Number(row.mindbody_client_id) === filters.mindbodyClientId);
      }
      rows.sort((a, b) => String(b.term_start_date || "").localeCompare(String(a.term_start_date || "")));
      return rows.slice(0, limit).map((row) => mapMembershipRow(row));
    },
  };
}

export function annualMembershipDatabaseUrl() {
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

function getAnnualMembershipDb() {
  const url = annualMembershipDatabaseUrl();
  if (!url) throw new Error("annual_membership_db_unconfigured");
  if (cachedDb && cachedDb.url === url) return cachedDb.db;
  cachedDb = { url, db: getDatabase({ connectionString: url }) };
  return cachedDb.db;
}

/**
 * @param {string} text
 * @param {unknown[]} [values]
 */
export async function annualMembershipQuery(text, values = []) {
  const result = await getAnnualMembershipDb().pool.query(text, values);
  return { rows: result.rows || [] };
}

/**
 * @template T
 * @param {(client: { query: Function }) => Promise<T>} fn
 */
export async function withAnnualMembershipTransaction(fn) {
  const client = await getAnnualMembershipDb().pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function closeAnnualMembershipDb() {
  if (!cachedDb) return;
  const pool = cachedDb.db.pool;
  cachedDb = null;
  if (pool && typeof pool.end === "function") await pool.end();
}

export function createPostgresAnnualMembershipStore() {
  const query = annualMembershipQuery;
  const withTx = withAnnualMembershipTransaction;

  /**
   * @param {Record<string, unknown>} row
   */
  async function periodsForMembershipId(annualMembershipId) {
    const r = await query(
      `SELECT *
         FROM annual_membership_periods
        WHERE annual_membership_id = $1
        ORDER BY period_index ASC`,
      [annualMembershipId],
    );
    return r.rows.map((row) => mapPeriodRow(row));
  }

  return {
    kind: "postgres",

    async createAnnualTermWithPeriods(input) {
      const sku = assertAnnualSku(input.sku);
      const pricing = getAnnualSkuDefinition(sku);
      const stripeInvoiceId = String(input.stripeInvoiceId || "").trim();
      const stripeSubscriptionId = String(input.stripeSubscriptionId || "").trim();
      if (!stripeInvoiceId) throw new Error("missing_stripe_invoice_id");
      if (!stripeSubscriptionId) throw new Error("missing_stripe_subscription_id");
      if (!Number.isInteger(input.mindbodyClientId) || input.mindbodyClientId <= 0) {
        throw new Error("invalid_mindbody_client_id");
      }

      const termStartDate = assertIsoDate(input.termStartDate);
      const termEndDate = assertIsoDate(input.termEndDate);
      const periodDefs = buildAnnualMembershipPeriods({ termStartDate, termEndDate, sku });
      const annualAmountCents =
        typeof input.annualAmountCents === "number" && Number.isInteger(input.annualAmountCents)
          ? input.annualAmountCents
          : pricing.annualTotalCents;

      return withTx(async (client) => {
        const existing = await client.query(
          `SELECT *
             FROM annual_memberships
            WHERE stripe_invoice_id = $1
            LIMIT 1
            FOR UPDATE`,
          [stripeInvoiceId],
        );
        if (existing.rows[0]) {
          const rawRow = existing.rows[0];
          const existingSub = String(rawRow.stripe_subscription_id || "");
          if (
            shouldBackfillAnnualStripeSubscriptionId(existingSub, stripeSubscriptionId) &&
            stripeSubscriptionId !== existingSub
          ) {
            await client.query(
              `UPDATE annual_memberships
                  SET stripe_subscription_id = $2,
                      updated_at = NOW()
                WHERE id = $1`,
              [rawRow.id, stripeSubscriptionId],
            );
            rawRow.stripe_subscription_id = stripeSubscriptionId;
          } else if (
            isRealStripeSubscriptionId(existingSub) &&
            isRealStripeSubscriptionId(stripeSubscriptionId) &&
            existingSub !== stripeSubscriptionId
          ) {
            warnAnnualStripeSubConflict(existingSub, stripeSubscriptionId, {
              membershipId: String(rawRow.id),
              stripeInvoiceId,
            });
          }
          const membership = mapMembershipRow(rawRow);
          const periods = await client.query(
            `SELECT *
               FROM annual_membership_periods
              WHERE annual_membership_id = $1
              ORDER BY period_index ASC`,
            [membership.id],
          );
          return {
            created: false,
            membership,
            periods: periods.rows.map((row) => mapPeriodRow(row)),
          };
        }

        const inserted = await client.query(
          `INSERT INTO annual_memberships (
             amare_user_id,
             mindbody_client_id,
             stripe_customer_id,
             stripe_subscription_id,
             stripe_invoice_id,
             stripe_price_id,
             sku,
             status,
             term_start_date,
             term_end_date,
             stripe_period_start_at,
             stripe_period_end_at,
             annual_amount_cents,
             timezone
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14
           )
           RETURNING *`,
          [
            input.amareUserId ? String(input.amareUserId) : null,
            input.mindbodyClientId,
            input.stripeCustomerId ? String(input.stripeCustomerId) : null,
            stripeSubscriptionId,
            stripeInvoiceId,
            input.stripePriceId ? String(input.stripePriceId) : null,
            sku,
            input.status ? String(input.status) : "active",
            termStartDate,
            termEndDate,
            input.stripePeriodStartAt ?? null,
            input.stripePeriodEndAt ?? null,
            annualAmountCents,
            input.timezone ? String(input.timezone) : ANNUAL_TIMEZONE,
          ],
        );
        const membership = mapMembershipRow(inserted.rows[0]);

        /** @type {Record<string, unknown>[]} */
        const periodRows = [];
        for (const def of periodDefs) {
          const r = await client.query(
            `INSERT INTO annual_membership_periods (
               annual_membership_id,
               period_index,
               period_start_date,
               period_end_date,
               status,
               mindbody_product_id,
               expected_list_amount_cents,
               expected_discount_amount_cents,
               expected_net_amount_cents
             ) VALUES ($1,$2,$3,$4,'pending',$5,$6,$7,$8)
             RETURNING *`,
            [
              membership.id,
              def.periodIndex,
              def.periodStartDate,
              def.periodEndDate,
              def.mindbodyProductId,
              def.expectedListAmountCents,
              def.expectedDiscountAmountCents,
              def.expectedNetAmountCents,
            ],
          );
          periodRows.push(r.rows[0]);
        }

        return {
          created: true,
          membership,
          periods: periodRows.map((row) => mapPeriodRow(row)),
        };
      });
    },

    async getAnnualMembership(membershipId) {
      const r = await query(`SELECT * FROM annual_memberships WHERE id = $1 LIMIT 1`, [membershipId]);
      return r.rows[0] ? mapMembershipRow(r.rows[0]) : null;
    },

    async getAnnualMembershipByInvoiceId(stripeInvoiceId) {
      const r = await query(`SELECT * FROM annual_memberships WHERE stripe_invoice_id = $1 LIMIT 1`, [
        stripeInvoiceId,
      ]);
      return r.rows[0] ? mapMembershipRow(r.rows[0]) : null;
    },

    async getAnnualPeriod(periodId) {
      const r = await query(`SELECT * FROM annual_membership_periods WHERE id = $1 LIMIT 1`, [periodId]);
      return r.rows[0] ? mapPeriodRow(r.rows[0]) : null;
    },

    async getAnnualPeriodByMembershipIndex(annualMembershipId, periodIndex) {
      const r = await query(
        `SELECT *
           FROM annual_membership_periods
          WHERE annual_membership_id = $1 AND period_index = $2
          LIMIT 1`,
        [annualMembershipId, periodIndex],
      );
      return r.rows[0] ? mapPeriodRow(r.rows[0]) : null;
    },

    async listDuePeriods(asOfDate, opts = {}) {
      const statuses = opts.statuses ?? ["pending", "failed"];
      const parentStatuses =
        opts.eligibleMembershipStatuses ?? ANNUAL_ISSUANCE_ELIGIBLE_MEMBERSHIP_STATUSES;
      const r = await query(
        `SELECT p.*
           FROM annual_membership_periods p
           INNER JOIN annual_memberships m ON m.id = p.annual_membership_id
          WHERE p.status = ANY($1::text[])
            AND p.period_start_date <= $2::date
            AND m.status = ANY($3::text[])
          ORDER BY p.period_start_date ASC, p.period_index ASC`,
        [statuses, assertIsoDate(asOfDate), parentStatuses],
      );
      return r.rows.map((row) => mapPeriodRow(row));
    },

    async listPeriodsForMembership(annualMembershipId) {
      return periodsForMembershipId(annualMembershipId);
    },

    async markPeriodSkipped(periodId, payload = {}) {
      const current = await this.getAnnualPeriod(periodId);
      if (!current) return { ok: false, reason: "period_not_found", period: null };
      const st = String(current.status);
      const revocable =
        st === "claiming" ||
        ANNUAL_REVOKE_SKIPPABLE_PERIOD_STATUSES.includes(st) ||
        isAnnualFailedPeriodProvablySafeToSkip(current);
      if (!revocable) {
        return { ok: false, reason: "invalid_period_status", period: current };
      }
      const r = await query(
        `UPDATE annual_membership_periods
            SET status = 'skipped',
                last_error = COALESCE($2, last_error),
                updated_at = NOW()
          WHERE id = $1
            AND status = $3
          RETURNING *`,
        [periodId, payload.reason ? String(payload.reason) : "admin_revoked_term", st],
      );
      if (!r.rows[0]) {
        const again = await this.getAnnualPeriod(periodId);
        if (!again) return { ok: false, reason: "period_not_found", period: null };
        return { ok: false, reason: "invalid_period_status", period: again };
      }
      return { ok: true, period: mapPeriodRow(r.rows[0]) };
    },

    async revokeAnnualMembershipTerm(membershipId, payload = {}) {
      return withTx(async (client) => {
        const locked = await client.query(
          `SELECT * FROM annual_memberships WHERE id = $1::uuid LIMIT 1 FOR UPDATE`,
          [membershipId],
        );
        const row = locked.rows[0];
        if (!row) return { ok: false, reason: "membership_not_found" };
        const membership = mapMembershipRow(row);
        const periodsRes = await client.query(
          `SELECT * FROM annual_membership_periods
            WHERE annual_membership_id = $1::uuid
            ORDER BY period_index ASC`,
          [membershipId],
        );
        const periodRows = periodsRes.rows.map((p) => mapPeriodRow(p));
        if (membership.status === "revoked") {
          let healedCount = 0;
          for (const p of periodRows) {
            if (p.status === "skipped") continue;
            const assess = assessAnnualPeriodRevokeEligibility(p);
            if (!assess.skip) continue;
            const skip = await client.query(
              `UPDATE annual_membership_periods
                  SET status = 'skipped',
                      last_error = $2,
                      updated_at = NOW()
                WHERE id = $1::uuid
                  AND status = $3
              RETURNING id`,
              [p.id, payload.reason ? String(payload.reason) : "admin_revoked_term", String(p.status)],
            );
            if (skip.rows[0]) healedCount += 1;
          }
          const afterPeriods = await client.query(
            `SELECT status FROM annual_membership_periods WHERE annual_membership_id = $1::uuid`,
            [membershipId],
          );
          const statuses = afterPeriods.rows.map((row) => String(row.status));
          return {
            ok: true,
            idempotent: true,
            membership,
            skippedCount: healedCount,
            healedCount,
            issuedPreserved: statuses.filter((s) => s === "issued").length,
            futurePeriodsSkipped: statuses.filter((s) => s === "skipped").length,
          };
        }
        if (!["active", "past_due"].includes(String(membership.status))) {
          return {
            ok: false,
            reason: "membership_not_revocable",
            status: String(membership.status),
          };
        }
        for (const p of periodRows) {
          const assess = assessAnnualPeriodRevokeEligibility(p);
          if (assess.block) {
            return { ok: false, reason: assess.reason, periodId: assess.periodId ?? p.id };
          }
        }
        let skippedCount = 0;
        for (const p of periodRows) {
          const assess = assessAnnualPeriodRevokeEligibility(p);
          if (!assess.skip) continue;
          const skip = await client.query(
            `UPDATE annual_membership_periods
                SET status = 'skipped',
                    last_error = $2,
                    updated_at = NOW()
              WHERE id = $1::uuid
                AND status = $3
            RETURNING id`,
            [p.id, payload.reason ? String(payload.reason) : "admin_revoked_term", String(p.status)],
          );
          if (skip.rows[0]) skippedCount += 1;
        }
        await client.query(
          `UPDATE annual_memberships
              SET status = 'revoked', updated_at = NOW()
            WHERE id = $1::uuid`,
          [membershipId],
        );
        const refreshed = await client.query(`SELECT * FROM annual_memberships WHERE id = $1::uuid`, [
          membershipId,
        ]);
        const afterPeriods = await client.query(
          `SELECT status FROM annual_membership_periods WHERE annual_membership_id = $1::uuid`,
          [membershipId],
        );
        const statuses = afterPeriods.rows.map((p) => String(p.status));
        return {
          ok: true,
          membership: mapMembershipRow(refreshed.rows[0]),
          skippedCount,
          issuedPreserved: statuses.filter((s) => s === "issued").length,
          futurePeriodsSkipped: statuses.filter((s) => s === "skipped").length,
        };
      });
    },

    async claimPeriod(periodId) {
      const claimToken = randomUUID();
      const r = await query(
        `UPDATE annual_membership_periods
            SET status = 'claiming',
                claim_token = $2,
                claim_started_at = NOW(),
                claimed_at = NOW(),
                attempt_count = attempt_count + 1,
                last_attempt_at = NOW(),
                updated_at = NOW()
          WHERE id = $1
            AND status = 'pending'
          RETURNING *`,
        [periodId, claimToken],
      );
      if (r.rows[0]) {
        return { ok: true, acquired: true, period: mapPeriodRow(r.rows[0]) };
      }
      const current = await this.getAnnualPeriod(periodId);
      if (!current) return { ok: false, acquired: false, reason: "period_not_found", period: null };
      return { ok: true, acquired: false, period: current };
    },

    async persistPreIssueSnapshot(periodId, snapshot) {
      const ids = Array.isArray(snapshot?.clientServiceIds)
        ? snapshot.clientServiceIds.map((v) => Number(v))
        : [];
      const claimStartedAt = snapshot?.claimStartedAt ?? null;
      const r = await query(
        `UPDATE annual_membership_periods
            SET pre_issue_client_service_ids = $2::jsonb,
                claim_started_at = COALESCE($3::timestamptz, claim_started_at),
                updated_at = NOW()
          WHERE id = $1
            AND status = 'claiming'
          RETURNING *`,
        [periodId, JSON.stringify(ids), claimStartedAt],
      );
      if (!r.rows[0]) {
        const current = await this.getAnnualPeriod(periodId);
        if (!current) return { ok: false, reason: "period_not_found", period: null };
        return { ok: false, reason: "invalid_period_status", period: current };
      }
      return { ok: true, period: mapPeriodRow(r.rows[0]) };
    },

    async markPeriodIssued(periodId, payload = {}) {
      const r = await query(
        `UPDATE annual_membership_periods
            SET status = 'issued',
                mindbody_sale_id = COALESCE($2, mindbody_sale_id),
                mindbody_client_service_id = COALESCE($3, mindbody_client_service_id),
                issued_at = NOW(),
                last_error = NULL,
                updated_at = NOW()
          WHERE id = $1
            AND status IN ('claiming', 'ambiguous')
          RETURNING *`,
        [periodId, payload.mindbodySaleId ?? null, payload.mindbodyClientServiceId ?? null],
      );
      if (!r.rows[0]) {
        const current = await this.getAnnualPeriod(periodId);
        if (!current) return { ok: false, reason: "period_not_found", period: null };
        return { ok: false, reason: "invalid_period_status", period: current };
      }
      return { ok: true, period: mapPeriodRow(r.rows[0]) };
    },

    async markPeriodFailed(periodId, payload = {}) {
      const r = await query(
        `UPDATE annual_membership_periods
            SET status = 'failed',
                last_error = $2,
                updated_at = NOW()
          WHERE id = $1
            AND status IN ('claiming', 'pending')
          RETURNING *`,
        [periodId, payload.error ? String(payload.error) : null],
      );
      if (!r.rows[0]) {
        const current = await this.getAnnualPeriod(periodId);
        if (!current) return { ok: false, reason: "period_not_found", period: null };
        return { ok: false, reason: "invalid_period_status", period: current };
      }
      return { ok: true, period: mapPeriodRow(r.rows[0]) };
    },

    async markPeriodAmbiguous(periodId, payload = {}) {
      const r = await query(
        `UPDATE annual_membership_periods
            SET status = 'ambiguous',
                last_error = $2,
                updated_at = NOW()
          WHERE id = $1
            AND status = 'claiming'
          RETURNING *`,
        [periodId, payload.error ? String(payload.error) : "mindbody_write_ambiguous"],
      );
      if (!r.rows[0]) {
        const current = await this.getAnnualPeriod(periodId);
        if (!current) return { ok: false, reason: "period_not_found", period: null };
        return { ok: false, reason: "invalid_period_status", period: current };
      }
      return { ok: true, period: mapPeriodRow(r.rows[0]) };
    },

    async markPeriodManualReview(periodId, payload = {}) {
      const r = await query(
        `UPDATE annual_membership_periods
            SET status = 'manual_review',
                last_error = COALESCE($2, last_error),
                updated_at = NOW()
          WHERE id = $1
            AND status <> 'issued'
          RETURNING *`,
        [periodId, payload.error ? String(payload.error) : null],
      );
      if (!r.rows[0]) {
        const current = await this.getAnnualPeriod(periodId);
        if (!current) return { ok: false, reason: "period_not_found", period: null };
        return { ok: false, reason: "invalid_period_status", period: current };
      }
      return { ok: true, period: mapPeriodRow(r.rows[0]) };
    },

    async releaseSafeRetryToPending(periodId, payload = {}) {
      const r = await query(
        `UPDATE annual_membership_periods
            SET status = 'pending',
                claim_token = NULL,
                claim_started_at = NULL,
                claimed_at = NULL,
                pre_issue_client_service_ids = NULL,
                last_error = COALESCE($2, last_error),
                updated_at = NOW()
          WHERE id = $1
            AND status IN ('failed', 'ambiguous')
          RETURNING *`,
        [periodId, payload.note ? String(payload.note) : null],
      );
      if (!r.rows[0]) {
        const current = await this.getAnnualPeriod(periodId);
        if (!current) return { ok: false, reason: "period_not_found", period: null };
        return { ok: false, reason: "invalid_period_status", period: current };
      }
      return { ok: true, period: mapPeriodRow(r.rows[0]) };
    },

    async findStaleClaims(staleBeforeIso) {
      const r = await query(
        `SELECT *
           FROM annual_membership_periods
          WHERE status = 'claiming'
            AND claim_started_at IS NOT NULL
            AND claim_started_at <= $1::timestamptz
          ORDER BY claim_started_at ASC`,
        [staleBeforeIso],
      );
      return r.rows.map((row) => mapPeriodRow(row));
    },
  };
}

/**
 * @param {{ forceMemory?: boolean }} [opts]
 */
export function openAnnualMembershipStore(opts = {}) {
  if (opts.forceMemory || process.env.ANNUAL_MEMBERSHIP_STORE_LOCAL_MEMORY === "1") {
    if (!sharedMemoryStore) sharedMemoryStore = createMemoryAnnualMembershipStore();
    return sharedMemoryStore;
  }
  const url = annualMembershipDatabaseUrl();
  if (url) return createPostgresAnnualMembershipStore();
  return createMemoryAnnualMembershipStore();
}

/** @type {ReturnType<typeof createMemoryAnnualMembershipStore> | null} */
let sharedMemoryStore = null;

export function resetAnnualMembershipStoreMemoryForTests() {
  sharedMemoryStore = createMemoryAnnualMembershipStore();
  return sharedMemoryStore;
}

export function openAnnualMembershipStoreForTests() {
  process.env.ANNUAL_MEMBERSHIP_STORE_LOCAL_MEMORY = "1";
  if (!sharedMemoryStore) sharedMemoryStore = createMemoryAnnualMembershipStore();
  return sharedMemoryStore;
}
