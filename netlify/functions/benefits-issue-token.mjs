import { jsonResponse, resolveConsumerClient } from "./mindbody-consumer-lib.mjs";
import { partnerBenefitsBlobsEnabled, tryOpenPartnerBenefitsBlobStore } from "./partner-benefits-blobs.mjs";
import {
  getBenefit,
  isBenefitVisible,
  isEligibleForBenefit,
  issueOrReuseToken,
  memberDisplayName,
  qrUrl,
  redemptionPeriodKey,
  resolvePartnerBenefitsEntitlement,
  siteOriginFromEvent,
  validThroughLabelForBenefit,
} from "./partner-benefits-lib.mjs";
import { withMobileCorsHandler } from "./mobile-api-cors.mjs";

/** @param {import("@netlify/functions").HandlerEvent} event */
function parseJsonBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function issueHandler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: { "Cache-Control": "no-store" }, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" });
  }
  if (!partnerBenefitsBlobsEnabled()) {
    return jsonResponse(503, { ok: false, error: "partner_benefits_blobs_disabled" });
  }
  const store = tryOpenPartnerBenefitsBlobStore(event);
  if (!store) return jsonResponse(503, { ok: false, error: "partner_benefits_store_unavailable" });

  const body = parseJsonBody(event);
  if (body == null) return jsonResponse(400, { ok: false, error: "invalid_json" });
  const benefitId = String(body.benefitId || "").trim();
  if (!benefitId) return jsonResponse(400, { ok: false, error: "missing_benefit_id" });

  const ctx = await resolveConsumerClient(event);
  if (!ctx.ok) return ctx.response;

  const benefit = await getBenefit(store, benefitId);
  if (!benefit || !isBenefitVisible(benefit)) {
    return jsonResponse(404, { ok: false, error: "benefit_not_found" });
  }

  const entitlement = await resolvePartnerBenefitsEntitlement(event, ctx.clientId, {
    consumerAuthHeaders: ctx.authHeaders,
  });
  if (!isEligibleForBenefit(benefit, entitlement)) {
    return jsonResponse(403, { ok: false, error: "not_eligible" });
  }

  const periodKey = redemptionPeriodKey(benefit);
  const names = memberDisplayName(typeof ctx.session.name === "string" ? ctx.session.name : null, null);
  const issued = await issueOrReuseToken(store, {
    benefit,
    memberClientId: ctx.clientId,
    memberFirstName: names.firstName,
    memberLastInitial: names.lastInitial,
    periodKey,
  });

  if (!issued.ok) {
    const code = issued.error === "already_redeemed_this_period" ? 409 : 500;
    return jsonResponse(code, { ok: false, error: issued.error });
  }

  const origin = siteOriginFromEvent(event);
  return jsonResponse(200, {
    ok: true,
    benefitId: benefit.id,
    status: "pending",
    qrUrl: qrUrl(origin, issued.token),
    validThrough: validThroughLabelForBenefit(benefit, periodKey),
    redemptionPeriodKey: periodKey,
    expiresAt: String(issued.redemption?.expiresAt || ""),
    reused: issued.reused === true,
  });
}

export const handler = withMobileCorsHandler(issueHandler);
