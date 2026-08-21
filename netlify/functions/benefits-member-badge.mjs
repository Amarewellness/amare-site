import { jsonResponse } from "./mindbody-consumer-lib.mjs";
import { resolveStudioCustomer } from "./amare-studio-lib.mjs";
import { partnerBenefitsBlobsEnabled, tryOpenPartnerBenefitsBlobStore } from "./partner-benefits-blobs.mjs";
import {
  collectMemberBenefitItems,
  memberBenefitsBadgeFromItems,
  resolvePartnerBenefitsEntitlement,
} from "./partner-benefits-lib.mjs";
import { withLambdaMobileCors } from "./amare-lambda-mobile-cors.mjs";
import { withMobileCorsHandler } from "./mobile-api-cors.mjs";

async function badgeHandler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: { "Cache-Control": "no-store" }, body: "" };
  }
  if (event.httpMethod !== "GET") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" });
  }
  if (!partnerBenefitsBlobsEnabled()) {
    return jsonResponse(200, { ok: true, show: false, eligibleCount: 0 });
  }
  const store = tryOpenPartnerBenefitsBlobStore(event);
  if (!store) return jsonResponse(200, { ok: true, show: false, eligibleCount: 0 });

  const ctx = await resolveStudioCustomer(event);
  if (!ctx.ok) return ctx.response;

  const entitlement = await resolvePartnerBenefitsEntitlement(event, ctx.clientId, {
    consumerAuthHeaders: ctx.authHeaders,
  });
  const items = await collectMemberBenefitItems(store, ctx.clientId, entitlement);
  const badge = memberBenefitsBadgeFromItems(items);

  return jsonResponse(200, {
    ok: true,
    eligible: entitlement.monthly || entitlement.flexiblePack,
    monthlyMember: entitlement.monthly,
    flexiblePack: entitlement.flexiblePack,
    ...badge,
  });
}

export const lambdaHandler = withMobileCorsHandler(badgeHandler);
export default withLambdaMobileCors(lambdaHandler);
