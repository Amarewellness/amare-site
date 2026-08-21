/**
 * Capacitor OTP/member-access CORS on the modern Netlify default-export path.
 * Emulates deployed withLambda wrapping. Local only. Does not deploy.
 * Run: npm run test:amare-auth-mobile-cors
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { newAmareUserId } from "../netlify/functions/amare-identity-policy.mjs";
import { handleAmareAuthEmailRequest } from "../netlify/functions/amare-auth-email-request.mjs";
import requestCodeDefault, { lambdaHandler as requestCodeLambda } from "../netlify/functions/amare-auth-email-request.mjs";
import { handleAmareAuthEmailVerify } from "../netlify/functions/amare-auth-email-verify.mjs";
import verifyCodeDefault from "../netlify/functions/amare-auth-email-verify.mjs";
import { handleAmareAuthMemberAccess } from "../netlify/functions/amare-auth-member-access.mjs";
import memberAccessDefault from "../netlify/functions/amare-auth-member-access.mjs";
import { withLambdaMobileCors } from "../netlify/functions/amare-lambda-mobile-cors.mjs";
import { withMobileCorsHandler } from "../netlify/functions/mobile-api-cors.mjs";
import { identityDatabaseUrl } from "../netlify/functions/amare-identity-store.mjs";
import { issueAmareMobileTokenPair } from "../netlify/functions/mobile-auth-lib.mjs";
import {
  OTP_EMAIL_HOURLY_CAP,
  OTP_REQUEST_KEY_HOURLY_CAP,
  OTP_RESEND_COOLDOWN_MS,
  OTP_TTL_MS,
} from "../netlify/functions/amare-otp-store.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;
function check(name, ok, detail) {
  if (ok) console.log(`PASS — ${name}`);
  else {
    failed += 1;
    console.log(`FAIL — ${name}${detail ? `\n  ${detail}` : ""}`);
  }
}

const prev = { ...process.env };
function restore() {
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function optionsRequest(url) {
  return new Request(url, {
    method: "OPTIONS",
    headers: {
      Origin: "https://localhost",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type,authorization",
    },
  });
}

function corsOk(res, allowMethodsNeed) {
  const acao = res.headers.get("Access-Control-Allow-Origin");
  const methods = String(res.headers.get("Access-Control-Allow-Methods") || "");
  const allowHeaders = String(res.headers.get("Access-Control-Allow-Headers") || "").toLowerCase();
  const vary = String(res.headers.get("Vary") || "");
  return (
    res.status === 204 &&
    acao === "https://localhost" &&
    allowMethodsNeed.every((m) => methods.split(",").map((s) => s.trim()).includes(m)) &&
    allowHeaders.includes("authorization") &&
    allowHeaders.includes("content-type") &&
    vary.toLowerCase().includes("origin")
  );
}

async function assertOptions(name, handler, url, methods) {
  let innerRan = 0;
  const wrapped = withLambdaMobileCors(async () => {
    innerRan += 1;
    return { statusCode: 500, body: "should_not_run" };
  });
  const fromWrapper = await wrapped(optionsRequest(url), { requestId: "qa-options" });
  check(`${name} OPTIONS wrapper 204 + CORS`, corsOk(fromWrapper, methods));
  check(`${name} OPTIONS does not execute business handler`, innerRan === 0, `innerRan=${innerRan}`);

  const fromDefault = await handler(optionsRequest(url), { requestId: "qa-options" });
  check(`${name} default-export OPTIONS 204 + CORS`, corsOk(fromDefault, methods));
}

delete process.env.ENABLE_AMARE_AUTH;
delete process.env.ENABLE_AMARE_AUTH_EMAIL_OTP;
delete process.env.ENABLE_MOBILE_BEARER_AUTH;

await assertOptions(
  "A request-code",
  requestCodeDefault,
  "https://www.amarewellness.com/api/amare/auth/email/request-code",
  ["POST", "OPTIONS"],
);
await assertOptions(
  "B verify-code",
  verifyCodeDefault,
  "https://www.amarewellness.com/api/amare/auth/email/verify-code",
  ["POST", "OPTIONS"],
);
await assertOptions(
  "C member-access",
  memberAccessDefault,
  "https://www.amarewellness.com/api/amare/auth/member-access",
  ["GET", "OPTIONS"],
);

const disabledOptions = await requestCodeLambda({
  httpMethod: "OPTIONS",
  headers: { origin: "https://localhost" },
});
check(
  "request-code lambdaHandler OPTIONS is 204 when OTP flags are off",
  disabledOptions.statusCode === 204 &&
    disabledOptions.headers["Access-Control-Allow-Origin"] === "https://localhost",
);

process.env.ENABLE_AMARE_AUTH = "1";
process.env.ENABLE_AMARE_AUTH_EMAIL_OTP = "1";
process.env.ENABLE_AMARE_SESS_ISSUE = "1";
process.env.ENABLE_MOBILE_BEARER_AUTH = "1";
process.env.AMARE_SESSION_SECRET = "qa-mobile-cors-amare-session-secret!!";
process.env.AMARE_OTP_PEPPER = "qa-mobile-cors-amare-otp-pepper!!";
process.env.MINDBODY_SESSION_SECRET = "qa-mobile-cors-mindbody-session!!";
process.env.MOBILE_JWT_SECRET = "qa-mobile-cors-jwt-secret-key!!";

let requestReached = 0;
const requestOtp = {
  OTP_EMAIL_HOURLY_CAP,
  OTP_REQUEST_KEY_HOURLY_CAP,
  OTP_RESEND_COOLDOWN_MS,
  OTP_TTL_MS,
  async countRecentOtpChallenges() {
    return { email: 0, requestKey: 0 };
  },
  async latestOtpCreatedAt() {
    return null;
  },
  async insertOtpChallenge() {
    requestReached += 1;
    return { id: 1 };
  },
};
const requestRes = await handleAmareAuthEmailRequest(
  {
    httpMethod: "POST",
    headers: {
      origin: "https://localhost",
      host: "www.amarewellness.com",
      "content-type": "application/json",
    },
    body: JSON.stringify({ email: "qa.cors@example.com" }),
  },
  {
    otp: requestOtp,
    sendEmail: async () => {
      requestReached += 1;
      return { ok: true };
    },
    generateOtp: () => "246810",
  },
);
check("D request-code POST reaches OTP handler", requestReached >= 1 && requestRes.statusCode === 200, `status=${requestRes.statusCode} reached=${requestReached}`);

let verifyReached = 0;
const verifyRes = await handleAmareAuthEmailVerify(
  {
    httpMethod: "POST",
    headers: {
      origin: "https://localhost",
      host: "www.amarewellness.com",
      "content-type": "application/json",
    },
    body: JSON.stringify({ email: "qa.cors@example.com", code: "000000" }),
  },
  {
    otp: {
      async consumeOtpChallenge() {
        verifyReached += 1;
        return { ok: false, reason: "wrong_code" };
      },
      async deleteExpiredOtpChallenges() {},
    },
    identity: {
      async findIdentitiesByEmail() {
        return [];
      },
    },
  },
);
check("E verify-code POST reaches OTP handler", verifyReached >= 1 && verifyRes.statusCode === 401, `status=${verifyRes.statusCode} reached=${verifyReached}`);

const userId = newAmareUserId();
const pair = issueAmareMobileTokenPair(userId);
let memberReached = 0;
const memberRes = await handleAmareAuthMemberAccess(
  {
    httpMethod: "GET",
    headers: {
      origin: "https://localhost",
      authorization: `Bearer ${pair.accessToken}`,
    },
  },
  {
    findUser: async (id) => {
      memberReached += 1;
      return { amare_user_id: id };
    },
    listIdentities: async () => [],
  },
);
const memberBody = JSON.parse(memberRes.body || "{}");
check(
  "F member-access GET reaches handler with AMARÉ bearer",
  memberReached >= 1 && memberRes.statusCode === 200 && memberBody.signedIn === true,
  `status=${memberRes.statusCode} body=${memberRes.body}`,
);

const sitePost = await handleAmareAuthEmailRequest(
  {
    httpMethod: "POST",
    headers: {
      origin: "https://www.amarewellness.com",
      host: "www.amarewellness.com",
      "content-type": "application/json",
    },
    body: JSON.stringify({ email: "qa.web@example.com" }),
  },
  {
    otp: requestOtp,
    sendEmail: async () => ({ ok: true }),
    generateOtp: () => "135790",
  },
);
check("G website same-origin request-code is not foreign_origin", sitePost.statusCode === 200);

const websiteOptions = await requestCodeDefault(
  new Request("https://www.amarewellness.com/api/amare/auth/email/request-code", {
    method: "OPTIONS",
    headers: { Origin: "https://www.amarewellness.com" },
  }),
  { requestId: "qa-web-options" },
);
check(
  "G website origin OPTIONS still 204 (fallback ACAO *)",
  websiteOptions.status === 204 && websiteOptions.headers.get("Access-Control-Allow-Origin") === "*",
);

const verifySrc = await readFile(path.join(root, "netlify/functions/amare-auth-email-verify.mjs"), "utf8");
check(
  "G verify-code still issues website session cookies",
  verifySrc.includes("issueEmailAmareSession") && verifySrc.includes("Set-Cookie"),
);

const wrapperSrc = await readFile(path.join(root, "netlify/functions/amare-lambda-mobile-cors.mjs"), "utf8");
const identitySrc = await readFile(path.join(root, "netlify/functions/amare-identity-store.mjs"), "utf8");
check("H withLambdaMobileCors still calls withLambda for non-OPTIONS", wrapperSrc.includes("withLambda(lambdaHandler)"));
check("H identity store still uses getConnectionString", identitySrc.includes("getConnectionString"));
check("H identityDatabaseUrl helper remains exported", typeof identityDatabaseUrl === "function");

let postThroughLambda = 0;
const through = withLambdaMobileCors(
  withMobileCorsHandler(async (event) => {
    postThroughLambda += 1;
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true, method: event.httpMethod }),
    };
  }),
);
const postRes = await through(
  new Request("https://www.amarewellness.com/api/amare/auth/email/request-code", {
    method: "POST",
    headers: { Origin: "https://localhost", "Content-Type": "application/json" },
    body: JSON.stringify({ email: "qa.cors@example.com" }),
  }),
  { requestId: "qa-post" },
);
const postJson = await postRes.json();
check(
  "H POST still executes through withLambda",
  postThroughLambda === 1 && postRes.status === 200 && postJson.method === "POST",
  `status=${postRes.status} ran=${postThroughLambda}`,
);
check(
  "H POST CORS reflects https://localhost",
  postRes.headers.get("Access-Control-Allow-Origin") === "https://localhost",
);

const requestSrc = await readFile(path.join(root, "netlify/functions/amare-auth-email-request.mjs"), "utf8");
check("H request-code does not export named handler", !/export (?:async function handler|const handler)/.test(requestSrc));

restore();

if (failed) {
  console.error(`\n${failed} mobile CORS QA check(s) failed.`);
  process.exit(1);
}
console.log("\nAll AMARÉ mobile CORS QA checks passed.");
