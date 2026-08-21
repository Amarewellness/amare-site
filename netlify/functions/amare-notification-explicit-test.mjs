/**
 * Admin/invoke-secret explicit QA send.
 * Resolves the owned S25 installation on Netlify, then relays to Cloud Run.
 * Does not accept a device token or an arbitrary user id from the caller.
 * Not imported by the Mindbody webhook. Automatic candidate delivery stays off.
 */
import { withLambda } from "@netlify/aws-lambda-compat";
import { jsonResponse } from "./mindbody-consumer-lib.mjs";
import { adminAuthorized } from "./new-client-sms-admin-auth.mjs";
import { resolveAmareUserForClient } from "./amare-notification-lib.mjs";
import { deliverExplicitPushTest, fcmTestSendingEnabled } from "./amare-notification-send.mjs";

const QA_SITE_ID = "5744068";
const QA_CLIENT_ID = 100002726;
const QA_USER_ID = "usr_WHB3H2RMWAMGC7S8YYTXTG";

function headerValue(headers, name) {
  const want = String(name || "").toLowerCase();
  for (const [k, v] of Object.entries(headers || {})) {
    if (String(k).toLowerCase() === want) return String(v || "").trim();
  }
  return "";
}

function invokeAuthorized(event) {
  if (adminAuthorized(event)) return true;
  const expected = (process.env.AMARE_PUSH_TEST_INVOKE_SECRET || "").trim();
  if (!expected || expected.length < 16) return false;
  const got = headerValue(event?.headers, "x-amare-push-test");
  if (!got || got.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < got.length; i += 1) mismatch |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  return mismatch === 0;
}

export async function handleExplicitPushRelayTest(event) {
  const method = (event.httpMethod || "GET").toUpperCase();
  if (method === "OPTIONS") return { statusCode: 204, headers: { "Cache-Control": "no-store" }, body: "" };
  if (!fcmTestSendingEnabled()) {
    return { statusCode: 404, headers: { "Cache-Control": "no-store" }, body: "not_found" };
  }
  if (!invokeAuthorized(event)) {
    return jsonResponse(401, { ok: false, error: "unauthorized" });
  }
  if (method !== "POST") return jsonResponse(405, { ok: false, error: "method_not_allowed" });

  const amareUserId = await resolveAmareUserForClient(QA_SITE_ID, QA_CLIENT_ID);
  if (!amareUserId || amareUserId !== QA_USER_ID) {
    return jsonResponse(409, { ok: false, error: "qa_owner_mismatch" });
  }

  const result = await deliverExplicitPushTest({
    amareUserId,
    title: "AMARÉ",
    body: "Production Push relay is ready ✨",
    path: "/my-classes",
    kind: "push_test",
  });
  return jsonResponse(result.ok ? 200 : 502, {
    ok: result.ok,
    sent: result.sent,
    skipped: result.skipped,
    installations: result.installations,
    origin: "netlify",
  });
}

export async function lambdaHandler(event) {
  return handleExplicitPushRelayTest(event);
}

export default withLambda(lambdaHandler);
