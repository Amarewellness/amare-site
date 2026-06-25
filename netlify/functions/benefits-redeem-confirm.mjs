import { jsonResponse } from "./mindbody-consumer-lib.mjs";
import { partnerBenefitsBlobsEnabled, tryOpenPartnerBenefitsBlobStore } from "./partner-benefits-blobs.mjs";
import { clientIp, confirmRedemption, formatMemberShort } from "./partner-benefits-lib.mjs";

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

async function confirmHandler(event) {
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
  const token = String(body.token || event.queryStringParameters?.t || "").trim();
  if (!token) return jsonResponse(400, { ok: false, error: "missing_token" });

  const result = await confirmRedemption(store, token, clientIp(event));
  if (!result.ok) {
    const code =
      result.error === "already_redeemed" ? 409 : result.error === "period_expired" ? 410 : 400;
    return jsonResponse(code, { ok: false, error: result.error });
  }

  const r = result.redemption;
  const benefit = result.benefit;

  return jsonResponse(200, {
    ok: true,
    status: "redeemed",
    redeemedAt: String(r.redeemedAt || ""),
    memberDisplayName: formatMemberShort(String(r.memberFirstName || ""), String(r.memberLastInitial || "")),
    benefitTitle: benefit.title,
    partnerDisplayName: benefit.partnerDisplayName,
  });
}

export const handler = confirmHandler;
