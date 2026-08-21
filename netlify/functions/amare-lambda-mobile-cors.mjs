/**
 * Modern-runtime default export for AMARÉ auth Functions that also need
 * Capacitor OPTIONS preflight.
 *
 * Must not export a named `handler` (that forces runtime v1 and drops
 * Netlify Database bindings). POST/GET still go through withLambda.
 */
import { withLambda } from "@netlify/aws-lambda-compat";
import { MOBILE_API_CORS, mobileCorsHeadersForOrigin } from "./mobile-api-cors.mjs";

function requestOrigin(request) {
  try {
    return String(request?.headers?.get?.("origin") || "").trim();
  } catch {
    return "";
  }
}

function isOptionsRequest(request) {
  return String(request?.method || "").toUpperCase() === "OPTIONS";
}

/** @param {Request} request */
export function mobilePreflightWebResponse(request, cors = MOBILE_API_CORS) {
  const headers = mobileCorsHeadersForOrigin(requestOrigin(request), cors);
  return new Response(null, {
    status: 204,
    headers: { ...headers, "Cache-Control": "no-store" },
  });
}

/**
 * @param {import('@netlify/functions').Handler} lambdaHandler
 */
export function withLambdaMobileCors(lambdaHandler, cors = MOBILE_API_CORS) {
  const modern = withLambda(lambdaHandler);
  return async function amareLambdaMobileCors(request, context) {
    if (isOptionsRequest(request)) {
      return mobilePreflightWebResponse(request, cors);
    }
    return modern(request, context);
  };
}
