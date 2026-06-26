import { jsonResponse } from "./mindbody-consumer-lib.mjs";
import { partnerBenefitsBlobsEnabled, tryOpenPartnerBenefitsBlobStore } from "./partner-benefits-blobs.mjs";
import {
  formatMemberShort,
  mapsUrlForAddress,
  validateToken,
  validThroughLabelForRedemption,
} from "./partner-benefits-lib.mjs";

async function validateHandler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: { "Cache-Control": "no-store" }, body: "" };
  }
  if (event.httpMethod !== "GET") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" });
  }
  if (!partnerBenefitsBlobsEnabled()) {
    return jsonResponse(503, { ok: false, error: "partner_benefits_blobs_disabled" });
  }
  const store = tryOpenPartnerBenefitsBlobStore(event);
  if (!store) return jsonResponse(503, { ok: false, error: "partner_benefits_store_unavailable" });

  const token = String(event.queryStringParameters?.t || event.queryStringParameters?.token || "").trim();
  if (!token) return jsonResponse(400, { ok: false, error: "missing_token" });

  const result = await validateToken(store, token);
  if (!result.ok) {
    const code =
      result.error === "already_redeemed" ? 409 : result.error === "period_expired" ? 410 : 404;
    return jsonResponse(code, { ok: false, error: result.error });
  }

  const r = result.redemption;
  const benefit = result.benefit;

  return jsonResponse(200, {
    ok: true,
    status: "pending",
    benefitTitle: benefit.title,
    partnerDisplayName: benefit.partnerDisplayName,
    logoUrl: benefit.logoUrl || null,
    locationAddress: benefit.locationAddress || null,
    mapsUrl: mapsUrlForAddress(benefit.locationAddress),
    terms: benefit.terms || null,
    memberDisplayName: formatMemberShort(String(r.memberFirstName || ""), String(r.memberLastInitial || "")),
    validThrough: validThroughLabelForRedemption(benefit, r),
  });
}

export const handler = validateHandler;
