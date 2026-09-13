/**
 * Admin-gated one-shot: commit Dijana Step 1 ledger onto the Netlify Functions
 * Postgres binding (extension DB). Idempotent — no-op when row already exists.
 */

import { withLambda } from "@netlify/aws-lambda-compat";
import { buildAnnualMembershipPeriods } from "./annual-membership-lib.mjs";
import {
  annualMembershipQuery,
  withAnnualMembershipTransaction,
} from "./annual-membership-store.mjs";

const CLIENT_ID = 100003742;
const KEEPER_SALE_ID = 37485;
const KEEPER_SERVICE_ID = 33341;
const ISSUED_AT_ISO = "2026-09-09T13:46:21.000Z";

/** Verified canonical Stripe (production readonly probe, Step 1). */
const CANONICAL = Object.freeze({
  stripeCustomerId: "cus_V6RX6IvJhHTZq7",
  stripeSubscriptionId: "sub_1UDlpMA47S4kb7VHDwUbR2Bb",
  stripeInvoiceId: "in_1UDlpIA47S4kb7VH1OWpDMIp",
  stripePriceId: "price_1UDlnfA47S4kb7VHz70CgCib",
  localSku: "annual_monthly_unlimited",
  termStartDate: "2026-09-09",
  termEndDate: "2027-09-09",
  stripePeriodStartAt: "2026-09-09T13:46:12.000Z",
  stripePeriodEndAt: "2027-09-09T13:46:12.000Z",
  annualAmountCents: 233580,
});

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(body),
  };
}

/** @param {import("@netlify/functions").HandlerEvent} event */
function adminAuthorized(event) {
  const expected = (process.env.ADMIN_DEBUG_TOKEN || "").trim();
  if (!expected) return false;
  const headers = event.headers || {};
  const provided = String(headers["x-admin-token"] || headers["X-Admin-Token"] || "").trim();
  return provided === expected;
}

async function existingClientCount() {
  const r = await annualMembershipQuery(
    `SELECT COUNT(*)::int AS n FROM annual_memberships WHERE mindbody_client_id = $1::bigint`,
    [CLIENT_ID],
  );
  return Number(r.rows[0]?.n ?? 0);
}

async function commitBackfill() {
  const periodDefs = buildAnnualMembershipPeriods({
    termStartDate: CANONICAL.termStartDate,
    termEndDate: CANONICAL.termEndDate,
    sku: CANONICAL.localSku,
  });

  return withAnnualMembershipTransaction(async (client) => {
    const dup = await client.query(
      `SELECT id FROM annual_memberships WHERE stripe_invoice_id = $1 LIMIT 1 FOR UPDATE`,
      [CANONICAL.stripeInvoiceId],
    );
    if (dup.rows[0]) {
      return { noop: true, membershipId: String(dup.rows[0].id) };
    }

    const inserted = await client.query(
      `INSERT INTO annual_memberships (
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
       ) VALUES ($1,$2,$3,$4,$5,$6,'active',$7,$8,$9,$10,$11,'America/New_York')
       RETURNING id`,
      [
        CLIENT_ID,
        CANONICAL.stripeCustomerId,
        CANONICAL.stripeSubscriptionId,
        CANONICAL.stripeInvoiceId,
        CANONICAL.stripePriceId,
        CANONICAL.localSku,
        CANONICAL.termStartDate,
        CANONICAL.termEndDate,
        CANONICAL.stripePeriodStartAt,
        CANONICAL.stripePeriodEndAt,
        CANONICAL.annualAmountCents,
      ],
    );
    const membershipId = String(inserted.rows[0]?.id ?? "");
    if (!membershipId) throw new Error("membership_insert_failed");

    for (const def of periodDefs) {
      const isZero = def.periodIndex === 0;
      await client.query(
        `INSERT INTO annual_membership_periods (
           annual_membership_id,
           period_index,
           period_start_date,
           period_end_date,
           status,
           mindbody_product_id,
           expected_list_amount_cents,
           expected_discount_amount_cents,
           expected_net_amount_cents,
           mindbody_sale_id,
           mindbody_client_service_id,
           issued_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          membershipId,
          def.periodIndex,
          def.periodStartDate,
          def.periodEndDate,
          isZero ? "issued" : "pending",
          def.mindbodyProductId,
          def.expectedListAmountCents,
          def.expectedDiscountAmountCents,
          def.expectedNetAmountCents,
          isZero ? KEEPER_SALE_ID : null,
          isZero ? KEEPER_SERVICE_ID : null,
          isZero ? ISSUED_AT_ISO : null,
        ],
      );
    }

    return { noop: false, membershipId };
  });
}

/** @param {import("@netlify/functions").HandlerEvent} event */
export async function lambdaHandler(event) {
  const method = String(event.httpMethod || "").toUpperCase();
  if (method === "OPTIONS") {
    return { statusCode: 204, headers: { "Cache-Control": "no-store" }, body: "" };
  }
  if (method !== "POST") {
    return json(405, { ok: false, error: "method_not_allowed" });
  }
  if (!adminAuthorized(event)) {
    return json(401, { ok: false, error: "unauthorized" });
  }

  try {
    const before = await existingClientCount();
    if (before > 0) {
      return json(200, { ok: true, noop: true, beforeCount: before, message: "already_present" });
    }

    const result = await commitBackfill();
    const after = await existingClientCount();
    const periods = await annualMembershipQuery(
      `SELECT COUNT(*)::int AS n
         FROM annual_membership_periods p
         INNER JOIN annual_memberships m ON m.id = p.annual_membership_id
        WHERE m.mindbody_client_id = $1::bigint`,
      [CLIENT_ID],
    );

    return json(200, {
      ok: true,
      ...result,
      afterCount: after,
      periodCount: periods.rows[0]?.n ?? 0,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json(500, { ok: false, error: "extension_backfill_failed", message: message.slice(0, 240) });
  }
}

export default withLambda(lambdaHandler);
