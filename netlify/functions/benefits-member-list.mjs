import { jsonResponse } from "./mindbody-consumer-lib.mjs";
import { resolveStudioCustomer } from "./amare-studio-lib.mjs";
import { partnerBenefitsBlobsEnabled, tryOpenPartnerBenefitsBlobStore } from "./partner-benefits-blobs.mjs";
import {
  collectMemberBenefitItems,
  currentPeriodKey,
  memberDisplayName,
  redemptionPeriodKey,
  resolvePartnerBenefitsEntitlement,
  validThroughLabelForBenefit,
} from "./partner-benefits-lib.mjs";
import { withLambdaMobileCors } from "./amare-lambda-mobile-cors.mjs";
import { withMobileCorsHandler } from "./mobile-api-cors.mjs";

async function listHandler(event) {
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

  const ctx = await resolveStudioCustomer(event);
  if (!ctx.ok) return ctx.response;

  const periodKey = currentPeriodKey();
  const entitlement = await resolvePartnerBenefitsEntitlement(event, ctx.clientId, {
    consumerAuthHeaders: ctx.authHeaders,
  });
  const sessionName = typeof ctx.session?.name === "string" ? ctx.session.name : null;
  const collected = await collectMemberBenefitItems(store, ctx.clientId, entitlement);

  const benefits = collected.map(({ benefit, st }) => {
    const rk = st.redemptionPeriodKey || redemptionPeriodKey(benefit);
    return {
      ...benefit,
      memberStatus: st.status,
      validThrough: st.validThrough || validThroughLabelForBenefit(benefit, rk),
      redeemedAt: st.redeemedAt || null,
      availableAgain: st.availableAgain || null,
      redeemedMessage: st.redeemedMessage || null,
      redemptionPeriodKey: rk,
      message: st.message || null,
    };
  });

  return jsonResponse(200, {
    ok: true,
    periodKey,
    eligible: entitlement.monthly || entitlement.flexiblePack,
    monthlyMember: entitlement.monthly,
    flexiblePack: entitlement.flexiblePack,
    memberDisplayName: memberDisplayName(sessionName, null).display,
    benefits,
  });
}

export const lambdaHandler = withMobileCorsHandler(listHandler);
export default withLambdaMobileCors(lambdaHandler);
