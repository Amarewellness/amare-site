/**
 * GET /api/mindbody/member/top-up/status
 *
 * Server-authoritative Top-Up eligibility. Browser/app clientId is never trusted.
 */

import { jsonResponse } from "./mindbody-consumer-lib.mjs";
import { resolveStudioCustomer } from "./amare-studio-lib.mjs";
import { memberTopUpEnabled, tryOpenMemberTopUpBlobStore } from "./member-topup-blobs.mjs";
import {
  TOPUP_SKU,
  evaluateTopUpGate,
  loadTopUpEligibilityContext,
  topUpPublicCopy,
  topUpUsageKey,
} from "./member-topup-lib.mjs";
import { withMobileCorsHandler } from "./mobile-api-cors.mjs";

/** @param {import("@netlify/functions").HandlerEvent} event */
async function topUpStatusHandler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: { "Cache-Control": "no-store" }, body: "" };
  }
  if (event.httpMethod !== "GET") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" });
  }

  if (!memberTopUpEnabled()) {
    return jsonResponse(200, {
      ok: true,
      eligible: false,
      reason: "topup_disabled",
      cta: "none",
      copy: topUpPublicCopy("none"),
    });
  }

  const ctxAuth = await resolveStudioCustomer(event);
  if (!ctxAuth.ok) return ctxAuth.response;

  const clientId = Number(ctxAuth.clientId);
  if (!Number.isFinite(clientId) || clientId <= 0) {
    return jsonResponse(200, {
      ok: true,
      eligible: false,
      reason: "signed_out",
      cta: "none",
      copy: topUpPublicCopy("none"),
    });
  }

  const cookieHdr = ctxAuth.setCookie ? { "Set-Cookie": ctxAuth.setCookie } : {};
  const store = tryOpenMemberTopUpBlobStore(event);
  const ctx = await loadTopUpEligibilityContext(clientId, event, {
    consumerAuthHeaders: ctxAuth.authHeaders || null,
  });

  /** @type {import("./member-topup-lib.mjs").TopUpUsageRecord | null} */
  let usage = null;
  if (store && ctx.cycle.cycleStartDay) {
    const raw = await store.get(topUpUsageKey(ctx.siteId, clientId, ctx.cycle.cycleStartDay), { type: "json" });
    if (raw && typeof raw === "object") usage = /** @type {import("./member-topup-lib.mjs").TopUpUsageRecord} */ (raw);
  }

  const gate = evaluateTopUpGate({
    tier: ctx.tier,
    monthlyCreditsRemaining: ctx.monthlyCreditsRemaining,
    otherUsableCredits: ctx.otherUsableCredits,
    usage,
    cycleStartDay: ctx.cycle.cycleStartDay,
  });
  const copy = topUpPublicCopy(gate.cta);

  return jsonResponse(
    200,
    {
      ok: true,
      eligible: gate.eligible,
      reason: gate.reason,
      cta: gate.cta,
      tier: ctx.tier,
      monthlyCreditsRemaining: ctx.monthlyCreditsRemaining,
      otherUsableCredits: ctx.otherUsableCredits,
      cycleStart: ctx.cycle.cycleStart,
      cycleEnd: ctx.cycle.cycleEnd,
      cycleStartDay: ctx.cycle.cycleStartDay,
      cycleEndDay: ctx.cycle.cycleEndDay || null,
      cycleSource: ctx.cycle.source,
      usageStatus: usage?.status || null,
      sku: TOPUP_SKU,
      amountCents: 2900,
      copy,
    },
    cookieHdr,
  );
}

export const handler = withMobileCorsHandler(topUpStatusHandler);
