/**
 * App checkout identity bind.
 * POST /api/amare/commerce/app-checkout-start  — Bearer AMARÉ → handoff URL
 * GET  /api/amare/commerce/app-checkout-open   — consume handoff → amare_sess → /pricing
 *
 * create-session still owns Stripe Customer + Checkout URL.
 * Linked app buyers are not sent to anonymous /pricing.
 */

import { isForeignOriginMutation, resolveAmareUser } from "./amare-sess-lib.mjs";
import {
  consumeAppCheckoutHandoff,
  issueAmareSessFromAppCheckoutHandoff,
  issueAppCheckoutHandoff,
  isPurchaseLinkedState,
  resolveCommerceCustomer,
} from "./amare-commerce-lib.mjs";
import { jsonResponse } from "./amare-auth-lib.mjs";
import { withMobileCorsHandler } from "./mobile-api-cors.mjs";

function publicOrigin(event) {
  const headers = event.headers || {};
  const proto = String(headers["x-forwarded-proto"] || headers["X-Forwarded-Proto"] || "http")
    .split(",")[0]
    .trim();
  const host = String(headers["x-forwarded-host"] || headers["X-Forwarded-Host"] || headers.host || headers.Host || "")
    .split(",")[0]
    .trim();
  if (!host) return "";
  return `${proto}://${host}`;
}

export async function handleAmareCommerceAppCheckoutStart(event, deps = {}) {
  if ((event.httpMethod || "GET") !== "POST") {
    return { statusCode: 405, headers: { "Cache-Control": "no-store" }, body: "method_not_allowed" };
  }
  if (isForeignOriginMutation(event)) {
    return jsonResponse(403, { ok: false, error: "foreign_origin" });
  }
  const user = await resolveAmareUser(event, { findUser: deps.findUser });
  if (!user.signedIn || !user.amareUserId) {
    return jsonResponse(401, { ok: false, error: "signed_out" });
  }
  const commerce = deps.resolveCommerceCustomer
    ? await deps.resolveCommerceCustomer(event)
    : await resolveCommerceCustomer(event, deps);
  if (!isPurchaseLinkedState(commerce.state) || !commerce.amareUserId || commerce.amareUserId !== user.amareUserId) {
    return jsonResponse(409, { ok: false, error: "not_linked", state: commerce.state || null });
  }
  const handoff = issueAppCheckoutHandoff({ amareUserId: user.amareUserId });
  const origin = publicOrigin(event);
  const url = `${origin}/api/amare/commerce/app-checkout-open?h=${encodeURIComponent(handoff.token)}`;
  return jsonResponse(200, {
    ok: true,
    url,
    expiresIn: handoff.expiresIn,
  });
}

export async function handleAmareCommerceAppCheckoutOpen(event) {
  if ((event.httpMethod || "GET") !== "GET") {
    return { statusCode: 405, headers: { "Cache-Control": "no-store" }, body: "method_not_allowed" };
  }
  const raw = String(event.queryStringParameters?.h || event.queryStringParameters?.token || "").trim();
  const consumed = consumeAppCheckoutHandoff(raw);
  if (!consumed) {
    return jsonResponse(403, { ok: false, error: "invalid_handoff" });
  }
  const issued = issueAmareSessFromAppCheckoutHandoff(consumed.amareUserId, event.headers || {});
  if (!issued?.cookie) {
    return jsonResponse(503, { ok: false, error: "session_issue_unavailable" });
  }
  return {
    statusCode: 302,
    headers: {
      Location: "/pricing",
      "Cache-Control": "no-store",
      "Set-Cookie": issued.cookie,
    },
    body: "",
  };
}

async function appCheckoutHandler(event) {
  if ((event.httpMethod || "GET") === "POST") {
    return handleAmareCommerceAppCheckoutStart(event);
  }
  return handleAmareCommerceAppCheckoutOpen(event);
}

export const handler = withMobileCorsHandler(appCheckoutHandler);
