/**
 * POST /api/amare/auth/email/request-code
 * Always generic { ok: true } when the address is syntactically valid.
 * Does not create an AMARÉ user. Does not reveal account existence.
 */

import { withLambda } from "@netlify/aws-lambda-compat";
import {
  disabledAuthResponse,
  emailOtpRoutesEnabled,
  isForeignOriginMutation,
  jsonResponse,
  requestEmailOtp,
} from "./amare-auth-lib.mjs";
import { withMobileCorsHandler } from "./mobile-api-cors.mjs";

function clientIp(event) {
  const headers = event.headers || {};
  const forwarded = String(headers["x-forwarded-for"] || headers["X-Forwarded-For"] || "")
    .split(",")[0]
    .trim();
  return forwarded || String(headers["x-nf-client-connection-ip"] || headers["client-ip"] || "").trim();
}

function parseBody(event) {
  if (!event.body) return {};
  try {
    return JSON.parse(event.body);
  } catch {
    return {};
  }
}

function sanitizeRequestCodeErrorMessage(raw) {
  let message = String(raw || "");
  message = message.replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted_url]");
  message = message.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted_email]");
  message = message.replace(/\b(pepper|secret|password|authorization|cookie|bearer)\b\S*/gi, "[redacted]");
  return message.slice(0, 240);
}

function logRequestCodeFailure(err) {
  const stage =
    err && typeof err === "object" && typeof err.amareOtpStage === "string"
      ? err.amareOtpStage.slice(0, 40)
      : "otp_unknown";
  console.error(
    JSON.stringify({
      event: "amare_auth_email_request_error",
      function: "amare-auth-email-request",
      name: err && typeof err.name === "string" ? err.name.slice(0, 80) : "",
      code: err && err.code != null ? String(err.code).slice(0, 64) : "",
      message: sanitizeRequestCodeErrorMessage(err && err.message ? err.message : err),
      stage,
    }),
  );
}

export async function handleAmareAuthEmailRequest(event, deps = {}) {
  if (!emailOtpRoutesEnabled()) return disabledAuthResponse();
  if ((event.httpMethod || "GET") !== "POST") {
    return { statusCode: 405, headers: { "Cache-Control": "no-store" }, body: "method_not_allowed" };
  }
  if (isForeignOriginMutation(event)) {
    return jsonResponse(403, { ok: false, error: "foreign_origin" });
  }

  const body = parseBody(event);
  let result;
  try {
    result = await requestEmailOtp(
      { email: body.email, ip: clientIp(event) },
      {
        otp: deps.otp,
        sendEmail: deps.sendEmail,
        generateOtp: deps.generateOtp,
        pepper: deps.pepper,
        now: deps.now,
      },
    );
  } catch (err) {
    logRequestCodeFailure(err);
    throw err;
  }
  if (!result.ok && result.error === "invalid_email") {
    return jsonResponse(400, { ok: false, error: "invalid_email" });
  }
  return jsonResponse(200, { ok: true });
}

export const lambdaHandler = withMobileCorsHandler(handleAmareAuthEmailRequest);
export default withLambda(lambdaHandler);
