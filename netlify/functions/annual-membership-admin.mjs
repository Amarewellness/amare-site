/**
 * Admin observability + controlled mutations for annual prepaid memberships.
 *
 * Gated by header `x-admin-token: <ADMIN_DEBUG_TOKEN>`.
 *
 *   GET  /api/admin/annual-memberships?…
 *   POST /api/admin/annual-memberships  { action, annualMembershipId, confirmStop? }
 *
 * Actions:
 *   cancel_renewal — Stripe cancel_at_period_end; current paid term unchanged
 *   revoke_term    — Postgres revoked + skip future periods (requires confirmStop: "STOP")
 */

import { jsonResponse } from "./mindbody-consumer-lib.mjs";
import {
  adminCancelAnnualRenewal,
  adminRevokeAnnualTerm,
} from "./annual-membership-admin-actions.mjs";
import { formatAnnualBusinessDate } from "./annual-membership-lib.mjs";
import {
  annualMembershipQuery,
  openAnnualMembershipStore,
} from "./annual-membership-store.mjs";

const MAX_LIMIT = 20;
const STALE_CLAIM_MS = 15 * 60 * 1000;

/** @param {unknown} event */
function adminAuthorized(event) {
  const expected = (process.env.ADMIN_DEBUG_TOKEN || "").trim();
  if (!expected || expected.length < 16) return false;
  if (!event || typeof event !== "object") return false;
  const headers =
    /** @type {{ headers?: Record<string, string | undefined> }} */ (event).headers || {};
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === "x-admin-token") {
      const got = String(headers[k] || "").trim();
      if (got.length !== expected.length) return false;
      let mismatch = 0;
      for (let i = 0; i < got.length; i += 1) {
        mismatch |= got.charCodeAt(i) ^ expected.charCodeAt(i);
      }
      return mismatch === 0;
    }
  }
  return false;
}

/** @param {unknown} event */
function queryParams(event) {
  const raw =
    event && typeof event === "object" && "queryStringParameters" in event
      ? /** @type {{ queryStringParameters?: Record<string, string | undefined> | null }} */ (event)
          .queryStringParameters
      : null;
  return raw && typeof raw === "object" ? raw : {};
}

/**
 * @param {Record<string, unknown>} period
 * @param {number} nowMs
 */
function periodAttentionFlags(period, nowMs) {
  /** @type {string[]} */
  const flags = [];
  const status = String(period.status || "");
  if (status === "failed") flags.push("failed");
  if (status === "ambiguous") flags.push("ambiguous");
  if (status === "manual_review") flags.push("manual_review");
  if (status === "claiming" && period.claim_started_at) {
    const started = new Date(String(period.claim_started_at)).getTime();
    if (Number.isFinite(started) && nowMs - started >= STALE_CLAIM_MS) {
      flags.push("stale_claiming");
    }
  }
  return flags;
}

/**
 * @param {Record<string, unknown>[]} periods
 * @param {number} nowMs
 */
function pickCurrentAndNextPeriod(periods, nowMs) {
  const sorted = [...periods].sort((a, b) => Number(a.period_index) - Number(b.period_index));
  /** @type {Record<string, unknown> | null} */
  let current = null;
  for (const p of sorted) {
    const st = String(p.status || "");
    if (["claiming", "failed", "ambiguous", "manual_review"].includes(st)) {
      current = p;
      break;
    }
    if (st === "issued") current = p;
  }
  if (!current && sorted.length) {
    const firstPending = sorted.find((p) => String(p.status) === "pending");
    current = firstPending || sorted[0];
  }
  const curIdx = current != null ? Number(current.period_index) : -1;
  const next =
    curIdx >= 0 ? sorted.find((p) => Number(p.period_index) === curIdx + 1) ?? null : null;
  return {
    currentPeriod: current ? sanitizePeriod(current, nowMs) : null,
    nextPeriod: next ? sanitizePeriod(next, nowMs) : null,
  };
}

/**
 * @param {Record<string, unknown>} row
 * @param {number} nowMs
 */
function sanitizePeriod(row, nowMs) {
  const mapped = {
    period_id: String(row.id ?? ""),
    period_index: Number(row.period_index),
    period_start_date: formatAnnualBusinessDate(row.period_start_date),
    period_end_date: formatAnnualBusinessDate(row.period_end_date),
    status: String(row.status ?? ""),
    mindbody_product_id: row.mindbody_product_id ?? null,
    mindbody_sale_id: row.mindbody_sale_id ?? null,
    mindbody_client_service_id: row.mindbody_client_service_id ?? null,
    issued_at: row.issued_at ?? null,
    attempt_count: row.attempt_count ?? 0,
    last_attempt_at: row.last_attempt_at ?? null,
    last_error: row.last_error ?? null,
    claim_started_at: row.claim_started_at ?? null,
  };
  return {
    ...mapped,
    attention: periodAttentionFlags(mapped, nowMs),
  };
}

/**
 * @param {Record<string, unknown>} row
 * @param {Record<string, unknown>[]} periods
 * @param {number} nowMs
 */
function sanitizeMembership(row, periods, nowMs) {
  const { currentPeriod, nextPeriod } = pickCurrentAndNextPeriod(periods, nowMs);
  /** @type {string[]} */
  const attention = [];
  for (const p of periods) {
    for (const f of periodAttentionFlags(p, nowMs)) {
      if (!attention.includes(f)) attention.push(f);
    }
  }
  return {
    annual_membership_id: String(row.id ?? ""),
    amare_user_id: row.amare_user_id ?? null,
    mindbody_client_id: row.mindbody_client_id ?? null,
    sku: String(row.sku ?? ""),
    status: String(row.status ?? ""),
    stripe_subscription_id: String(row.stripe_subscription_id ?? ""),
    stripe_invoice_id: String(row.stripe_invoice_id ?? ""),
    stripe_customer_id: row.stripe_customer_id ?? null,
    annual_amount_cents: row.annual_amount_cents ?? null,
    term_start_date: formatAnnualBusinessDate(row.term_start_date),
    term_end_date: formatAnnualBusinessDate(row.term_end_date),
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
    attention,
    current_period: currentPeriod,
    next_period: nextPeriod,
    period_count: periods.length,
  };
}

/**
 * @param {string} sql
 * @param {unknown[]} values
 */
async function queryMembershipRows(sql, values) {
  if ((process.env.ANNUAL_MEMBERSHIP_STORE_LOCAL_MEMORY || "").trim() === "1") {
    return [];
  }
  const result = await annualMembershipQuery(sql, values);
  return Array.isArray(result.rows) ? result.rows : [];
}

/** @param {Record<string, string | undefined>} q */
async function lookupMemberships(q) {
  const id = (q.id || "").trim();
  const mindbodyClientIdRaw = (q.mindbodyClientId || q.mindbody_client_id || "").trim();
  const stripeSubscriptionId = (q.stripeSubscriptionId || q.stripe_subscription_id || "").trim();
  const stripeInvoiceId = (q.stripeInvoiceId || q.stripe_invoice_id || "").trim();
  let limit = Number(q.limit || "5");
  if (!Number.isFinite(limit) || limit < 1) limit = 5;
  limit = Math.min(Math.trunc(limit), MAX_LIMIT);

  const store = openAnnualMembershipStore();
  if (store.kind === "memory" && typeof store.listMembershipsForAdmin === "function") {
    return store.listMembershipsForAdmin({
      id: id || undefined,
      stripeInvoiceId: stripeInvoiceId || undefined,
      stripeSubscriptionId: stripeSubscriptionId || undefined,
      mindbodyClientId:
        mindbodyClientIdRaw && /^\d+$/.test(mindbodyClientIdRaw)
          ? Number(mindbodyClientIdRaw)
          : undefined,
      limit,
    });
  }

  if (id) {
    return queryMembershipRows(
      `SELECT * FROM annual_memberships WHERE id = $1::uuid LIMIT 1`,
      [id],
    );
  }
  if (stripeInvoiceId) {
    return queryMembershipRows(
      `SELECT * FROM annual_memberships WHERE stripe_invoice_id = $1 LIMIT 1`,
      [stripeInvoiceId],
    );
  }
  if (stripeSubscriptionId) {
    return queryMembershipRows(
      `SELECT *
         FROM annual_memberships
        WHERE stripe_subscription_id = $1
        ORDER BY term_start_date DESC
        LIMIT $2`,
      [stripeSubscriptionId, limit],
    );
  }
  if (mindbodyClientIdRaw && /^\d+$/.test(mindbodyClientIdRaw)) {
    return queryMembershipRows(
      `SELECT *
         FROM annual_memberships
        WHERE mindbody_client_id = $1::bigint
        ORDER BY term_start_date DESC
        LIMIT $2`,
      [Number(mindbodyClientIdRaw), limit],
    );
  }
  return queryMembershipRows(
    `SELECT *
       FROM annual_memberships
      ORDER BY created_at DESC
      LIMIT $1`,
    [limit],
  );
}

/** @param {string} membershipId */
async function loadPeriodsForMembership(membershipId) {
  const store = openAnnualMembershipStore();
  if (store.kind === "memory") {
    /** @type {Record<string, unknown>[]} */
    const all = [];
    for (let i = 0; i <= 11; i += 1) {
      const p = await store.getAnnualPeriodByMembershipIndex(membershipId, i);
      if (p) all.push(p);
    }
    return all;
  }
  const result = await annualMembershipQuery(
    `SELECT *
       FROM annual_membership_periods
      WHERE annual_membership_id = $1::uuid
      ORDER BY period_index ASC`,
    [membershipId],
  );
  return Array.isArray(result.rows) ? result.rows : [];
}

/** @param {import("@netlify/functions").HandlerEvent} event */
async function handlePost(event) {
  let body = {};
  try {
    body =
      event.body && typeof event.body === "string"
        ? JSON.parse(event.body)
        : /** @type {Record<string, unknown>} */ (event.body ?? {});
  } catch {
    return jsonResponse(400, { ok: false, error: "invalid_json_body" });
  }

  const action = String(body.action || "").trim();
  const annualMembershipId = String(body.annualMembershipId || body.id || "").trim();
  if (!annualMembershipId) {
    return jsonResponse(400, { ok: false, error: "annual_membership_id_required" });
  }

  if (action === "cancel_renewal") {
    const result = await adminCancelAnnualRenewal(annualMembershipId);
    if (!result.ok) {
      return jsonResponse(result.error === "membership_not_found" ? 404 : 409, {
        ok: false,
        ...result,
      });
    }
    return jsonResponse(200, { ok: true, ...result });
  }

  if (action === "revoke_term") {
    const result = await adminRevokeAnnualTerm(annualMembershipId, {
      confirmStop: typeof body.confirmStop === "string" ? body.confirmStop : "",
      reason: typeof body.reason === "string" ? body.reason : undefined,
    });
    if (!result.ok) {
      const status =
        result.error === "membership_not_found"
          ? 404
          : result.error === "confirm_stop_required"
            ? 400
            : 409;
      return jsonResponse(status, { ok: false, ...result });
    }
    return jsonResponse(200, { ok: true, ...result });
  }

  return jsonResponse(400, {
    ok: false,
    error: "unknown_action",
    allowed: ["cancel_renewal", "revoke_term"],
  });
}

/** @param {import("@netlify/functions").HandlerEvent} event */
export async function handler(event) {
  const method = String(event.httpMethod || "").toUpperCase();
  if (!adminAuthorized(event)) {
    return jsonResponse(401, {
      ok: false,
      error: "unauthorized",
      hint: "Set x-admin-token to ADMIN_DEBUG_TOKEN",
    });
  }

  if (method === "POST") {
    try {
      return await handlePost(event);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonResponse(500, {
        ok: false,
        error: "annual_membership_admin_mutation_failed",
        message: message.slice(0, 240),
      });
    }
  }

  if (method !== "GET") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" });
  }

  try {
    const q = queryParams(event);
    const rows = await lookupMemberships(q);
    const nowMs = Date.now();
    /** @type {Record<string, unknown>[]} */
    const memberships = [];
    for (const row of rows) {
      const id = String(row.id ?? "");
      if (!id) continue;
      const periods = await loadPeriodsForMembership(id);
      memberships.push(sanitizeMembership(row, periods, nowMs));
    }
    return jsonResponse(200, {
      ok: true,
      count: memberships.length,
      memberships,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const dbMissing = message.includes("annual_membership_db_unconfigured");
    return jsonResponse(dbMissing ? 503 : 500, {
      ok: false,
      error: dbMissing ? "annual_membership_db_unconfigured" : "annual_membership_admin_failed",
      message: dbMissing
        ? "Postgres annual membership store is not configured in this environment."
        : message.slice(0, 240),
    });
  }
}
