/**
 * Proves expired access → member-access signedIn:false → mobile-refresh → signedIn:true.
 * Local only. Run: node scripts/qa-amare-auth-expired-access-refresh.mjs
 */

const prev = { ...process.env };
process.env.ENABLE_MOBILE_BEARER_AUTH = "1";
process.env.ENABLE_AMARE_AUTH = "1";
process.env.ENABLE_AMARE_SESS_ISSUE = "1";
process.env.MOBILE_JWT_ACCESS_TTL_SECONDS = "60";
process.env.MINDBODY_SESSION_SECRET = "qa-expired-access-mindbody-secret!!";
process.env.AMARE_SESSION_SECRET = "qa-expired-access-amare-secret-key!!";
process.env.MOBILE_JWT_SECRET = "qa-expired-access-mobile-jwt-secret!!";

const { newAmareUserId } = await import("../netlify/functions/amare-identity-policy.mjs");
const {
  amareUserIdFromMobileAccessToken,
  issueAmareMobileTokenPair,
  resetMobileRevokeStoreForTests,
} = await import("../netlify/functions/mobile-auth-lib.mjs");
const { handler: mobileRefresh } = await import("../netlify/functions/mindbody-oauth-mobile-refresh.mjs");
const { handleAmareAuthMemberAccess } = await import("../netlify/functions/amare-auth-member-access.mjs");

let failed = 0;
function check(name, ok, detail) {
  if (ok) console.log(`PASS — ${name}`);
  else {
    failed += 1;
    console.log(`FAIL — ${name}${detail ? `\n  ${detail}` : ""}`);
  }
}

async function postJson(handler, body, headers = {}) {
  return handler({
    httpMethod: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

resetMobileRevokeStoreForTests();

const userId = newAmareUserId();
const pair = issueAmareMobileTokenPair(userId);
check("issued access token", !!pair.accessToken && !!pair.refreshToken);

await new Promise((r) => setTimeout(r, 61000));

const expiredAccess = await handleAmareAuthMemberAccess({
  httpMethod: "GET",
  headers: { authorization: `Bearer ${pair.accessToken}` },
}, {
  findUser: async (id) => ({ amare_user_id: id, deleted_at: null }),
});
const expiredBody = JSON.parse(expiredAccess.body || "{}");
check(
  "expired access → member-access signedIn:false (200)",
  expiredAccess.statusCode === 200 && expiredBody.signedIn === false,
  JSON.stringify(expiredBody),
);

const refreshRes = await postJson(mobileRefresh, { refreshToken: pair.refreshToken });
const refreshBody = JSON.parse(refreshRes.body || "{}");
check(
  "refresh with valid refresh token succeeds",
  refreshRes.statusCode === 200 && refreshBody.accessToken && refreshBody.refreshToken,
  refreshRes.body,
);

const freshAccess = await handleAmareAuthMemberAccess({
  httpMethod: "GET",
  headers: { authorization: `Bearer ${refreshBody.accessToken}` },
}, {
  findUser: async (id) => ({ amare_user_id: id, deleted_at: null }),
});
const freshBody = JSON.parse(freshAccess.body || "{}");
check(
  "refreshed access → member-access signedIn:true",
  freshAccess.statusCode === 200 && freshBody.signedIn === true,
  JSON.stringify(freshBody),
);
check(
  "refreshed access maps to same amare user",
  amareUserIdFromMobileAccessToken(refreshBody.accessToken) === userId,
);

for (const [k, v] of Object.entries(prev)) {
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

if (failed) {
  console.log(`\nRESULT: FAIL (${failed})`);
  process.exit(1);
}
console.log("\nRESULT: PASS — expired access refresh chain verified");
