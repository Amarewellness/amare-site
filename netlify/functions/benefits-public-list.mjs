import { jsonResponse } from "./mindbody-consumer-lib.mjs";
import { partnerBenefitsBlobsEnabled, tryOpenPartnerBenefitsBlobStore } from "./partner-benefits-blobs.mjs";
import { benefitFrequencyType, isBenefitVisible, listBenefits } from "./partner-benefits-lib.mjs";

/** @param {NonNullable<Awaited<ReturnType<typeof listBenefits>>[number]>} benefit */
function publicBenefitSummary(benefit) {
  const freq = benefitFrequencyType(benefit);
  return {
    id: benefit.id,
    title: benefit.title,
    description: benefit.description || null,
    partnerDisplayName: benefit.partnerDisplayName,
    logoUrl: benefit.logoUrl || null,
    locationAddress: benefit.locationAddress || null,
    frequency: freq === "once_per_campaign" ? "campaign" : "monthly",
  };
}

async function publicListHandler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: { "Cache-Control": "no-store" }, body: "" };
  }
  if (event.httpMethod !== "GET") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" });
  }
  if (!partnerBenefitsBlobsEnabled()) {
    return jsonResponse(200, { ok: true, benefits: [] }, { "Cache-Control": "public, max-age=300" });
  }
  const store = tryOpenPartnerBenefitsBlobStore(event);
  if (!store) {
    return jsonResponse(200, { ok: true, benefits: [] }, { "Cache-Control": "public, max-age=300" });
  }

  const benefits = (await listBenefits(store))
    .filter((b) => isBenefitVisible(b))
    .map(publicBenefitSummary);

  return jsonResponse(200, { ok: true, benefits }, { "Cache-Control": "public, max-age=300" });
}

export const handler = publicListHandler;
