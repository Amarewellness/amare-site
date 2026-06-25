import { jsonResponse, resolveConsumerClient } from "./mindbody-consumer-lib.mjs";
import { partnerBenefitsBlobsEnabled, tryOpenPartnerBenefitsBlobStore } from "./partner-benefits-blobs.mjs";
import {
  collectMemberBenefitItems,
  currentPeriodKey,
  hasActiveMonthlyMembership,
  memberDisplayName,
  redemptionPeriodKey,
  validThroughLabelForBenefit,
} from "./partner-benefits-lib.mjs";
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

  const ctx = await resolveConsumerClient(event);
  if (!ctx.ok) return ctx.response;

  const periodKey = currentPeriodKey();
  const eligible = await hasActiveMonthlyMembership(event, ctx.clientId);
  const sessionName = typeof ctx.session.name === "string" ? ctx.session.name : null;
  const collected = await collectMemberBenefitItems(store, ctx.clientId, eligible);

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
    eligible,
    memberDisplayName: memberDisplayName(sessionName, null).display,
    benefits,
  });
}

export const handler = withMobileCorsHandler(listHandler);
