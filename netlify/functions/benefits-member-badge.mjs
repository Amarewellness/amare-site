import { jsonResponse, resolveConsumerClient } from "./mindbody-consumer-lib.mjs";
import { partnerBenefitsBlobsEnabled, tryOpenPartnerBenefitsBlobStore } from "./partner-benefits-blobs.mjs";
import {
  collectMemberBenefitItems,
  hasActiveMonthlyMembership,
  memberBenefitsBadgeFromItems,
} from "./partner-benefits-lib.mjs";
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

  const ctx = await resolveConsumerClient(event);
  if (!ctx.ok) return ctx.response;

  const eligible = await hasActiveMonthlyMembership(event, ctx.clientId);
  if (!eligible) {
    return jsonResponse(200, { ok: true, show: false, eligible: false, eligibleCount: 0 });
  }

  const items = await collectMemberBenefitItems(store, ctx.clientId, eligible);
  const badge = memberBenefitsBadgeFromItems(items);

  return jsonResponse(200, {
    ok: true,
    eligible: true,
    ...badge,
  });
}

export const handler = withMobileCorsHandler(badgeHandler);
