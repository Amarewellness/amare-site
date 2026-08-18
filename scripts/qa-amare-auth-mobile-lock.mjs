/**
 * Mobile Auth lock invariants. Local only.
 * Run: npm run test:amare-auth-mobile-lock
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { newAmareUserId } from "../netlify/functions/amare-identity-policy.mjs";
import {
  amareUserIdFromMobileAccessToken,
  amareUserIdFromMobileRefreshToken,
  inspectMobileToken,
  issueAmareMobileTokenPair,
  issueMobileTokenPair,
  resetMobileRevokeStoreForTests,
  sessionFromMobileAccessToken,
  sessionFromMobileRefreshToken,
} from "../netlify/functions/mobile-auth-lib.mjs";
import { handler as mobileRefresh } from "../netlify/functions/mindbody-oauth-mobile-refresh.mjs";
import { handler as mobileRevoke } from "../netlify/functions/mindbody-oauth-mobile-revoke.mjs";
import {
  buildNewProfileTx,
  PROFILE_TX_TTL_MS,
  readProfileTxToken,
  sealProfileTxToken,
} from "../netlify/functions/amare-auth-lib.mjs";
import { rejectedProfileBodyFields } from "../netlify/functions/amare-auth-profile-lib.mjs";
import { handleAmareAuthProfileCreate } from "../netlify/functions/amare-auth-profile-create.mjs";
import {
  consumeAppCheckoutHandoff,
  issueAppCheckoutHandoff,
  resetAppCheckoutHandoffsForTests,
} from "../netlify/functions/amare-commerce-lib.mjs";
import { handleAmareCommerceAppCheckoutStart } from "../netlify/functions/amare-commerce-app-checkout.mjs";
import { unsealCookiePayload } from "../netlify/functions/oauth-lib.mjs";
import { requireAmareSessionSecret } from "../netlify/functions/amare-sess-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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

const prev = { ...process.env };
process.env.ENABLE_MOBILE_BEARER_AUTH = "1";
process.env.ENABLE_AMARE_AUTH = "1";
process.env.ENABLE_AMARE_SESS_ISSUE = "1";
process.env.ENABLE_AMARE_AUTH_EMAIL_OTP = "1";
process.env.MINDBODY_SESSION_SECRET = "qa-lock-mindbody-session-secret!!";
process.env.AMARE_SESSION_SECRET = "qa-lock-amare-session-secret-key!!";
process.env.MOBILE_JWT_SECRET = "qa-lock-mobile-jwt-secret-key!!";
resetMobileRevokeStoreForTests();
resetAppCheckoutHandoffsForTests();

const userId = newAmareUserId();
const otherUser = newAmareUserId();
const amare = issueAmareMobileTokenPair(userId);
const mindbody = issueMobileTokenPair({
  at: Date.now(),
  access_token: "mb-access",
  refresh_token: "mb-refresh",
});

check("amare refresh typ is amare_mobile_refresh", inspectMobileToken(amare.refreshToken)?.typ === "amare_mobile_refresh");
check("mindbody refresh typ is mobile_refresh", inspectMobileToken(mindbody.refreshToken)?.typ === "mobile_refresh");
check("families differ", inspectMobileToken(amare.refreshToken)?.family === "amare" && inspectMobileToken(mindbody.refreshToken)?.family === "mindbody");

const amareRefreshRes = await postJson(mobileRefresh, { refreshToken: amare.refreshToken });
const amareRefreshBody = JSON.parse(amareRefreshRes.body);
check("amare refresh issues amare family", amareRefreshRes.statusCode === 200 && amareRefreshBody.sessionKind === "amare");
check(
  "amare refresh cannot become mindbody",
  inspectMobileToken(amareRefreshBody.accessToken)?.family === "amare" &&
    sessionFromMobileAccessToken(amareRefreshBody.accessToken) === null,
);

const mbRefreshRes = await postJson(mobileRefresh, { refreshToken: mindbody.refreshToken });
const mbRefreshBody = JSON.parse(mbRefreshRes.body);
check("mindbody refresh issues mindbody family", mbRefreshRes.statusCode === 200 && mbRefreshBody.sessionKind === "mindbody");
check(
  "mindbody refresh cannot become amare",
  inspectMobileToken(mbRefreshBody.accessToken)?.family === "mindbody" &&
    amareUserIdFromMobileAccessToken(mbRefreshBody.accessToken) === null,
);

const amareAsMb = sessionFromMobileRefreshToken(amare.refreshToken);
const mbAsAmare = amareUserIdFromMobileRefreshToken(mindbody.refreshToken);
check("amare refresh is rejected by mindbody verifier", amareAsMb === null);
check("mindbody refresh is rejected by amare verifier", mbAsAmare === null);

const accessAsRefresh = await postJson(mobileRefresh, { refreshToken: amare.accessToken });
check("amare access cannot be used as refresh", accessAsRefresh.statusCode === 401);
const mbAccessAsRefresh = await postJson(mobileRefresh, { refreshToken: mindbody.accessToken });
check("mindbody access cannot be used as refresh", mbAccessAsRefresh.statusCode === 401);

const cross = await postJson(mobileRefresh, { refreshToken: mindbody.refreshToken });
const crossBody = JSON.parse(cross.body);
check("mindbody refresh still cannot mint amare_user_id", !amareUserIdFromMobileAccessToken(crossBody.accessToken || ""));

await postJson(mobileRevoke, {}, { authorization: `Bearer ${amare.accessToken}` });
const reused = await postJson(mobileRefresh, { refreshToken: amare.refreshToken });
check("revoked amare refresh cannot be reused", reused.statusCode === 401);

const mbAfterAmareRevoke = await postJson(mobileRefresh, { refreshToken: mindbody.refreshToken });
check(
  "revoking amare does not revoke mindbody family",
  mbAfterAmareRevoke.statusCode === 200 && JSON.parse(mbAfterAmareRevoke.body).sessionKind === "mindbody",
);

const mb2 = issueMobileTokenPair({ at: Date.now(), access_token: "mb-access-2", refresh_token: "mb-refresh-2" });
await postJson(mobileRevoke, { refreshToken: mb2.refreshToken });
const mb2Reuse = await postJson(mobileRefresh, { refreshToken: mb2.refreshToken });
check("revoked mindbody refresh cannot be reused", mb2Reuse.statusCode === 401);
const amare2 = issueAmareMobileTokenPair(otherUser);
const amareAfterMbRevoke = await postJson(mobileRefresh, { refreshToken: amare2.refreshToken });
check(
  "revoking mindbody does not revoke amare family",
  amareAfterMbRevoke.statusCode === 200 && JSON.parse(amareAfterMbRevoke.body).sessionKind === "amare",
);

const tx = buildNewProfileTx({ amareUserId: userId, email: "otp.user@example.com" });
const sealed = sealProfileTxToken(tx);
const opened = readProfileTxToken(sealed);
check("profileTx is server-issued sealed blob", typeof sealed === "string" && sealed.length > 20);
check("profileTx unseals to new_profile/email", opened?.kind === "new_profile" && opened?.provider === "email");
check("profileTx bound to amare_user_id", opened?.amare_user_id === userId);
check("profileTx bound to verified OTP email", opened?.provider_sub === "otp.user@example.com");
check("profileTx has no clientId", opened && !("clientId" in opened) && !("client_id" in opened));
check("profileTx is short-lived (15m)", opened && opened.exp - opened.at === PROFILE_TX_TTL_MS);
check("tampered profileTx rejected", readProfileTxToken(`${sealed.slice(0, -3)}zzz`) === null);
check("body email cannot establish ownership", rejectedProfileBodyFields({ email: "spoof@example.com" }) === "email");
check("body amareUserId cannot establish ownership", rejectedProfileBodyFields({ amareUserId: "usr_SPOOF" }) === "amare_user_id");
check("body clientId cannot establish ownership", rejectedProfileBodyFields({ clientId: 999 }) === "clientId");

const mismatch = await handleAmareAuthProfileCreate(
  {
    httpMethod: "POST",
    headers: {
      authorization: `Bearer ${amare2.accessToken}`,
      origin: "http://127.0.0.1:5178",
      host: "127.0.0.1:4321",
    },
    body: JSON.stringify({
      firstName: "Ada",
      lastName: "Lovelace",
      mobilePhone: "2025550100",
      explicitCreate: true,
      profileTx: sealed,
    }),
  },
  { findUser: async (id) => ({ amare_user_id: id }) },
);
const mismatchBody = JSON.parse(mismatch.body || "{}");
check(
  "foreign user cannot spend another user's profileTx",
  mismatch.statusCode === 403 && mismatchBody.error === "profile_tx_user_mismatch",
);

resetAppCheckoutHandoffsForTests();
const handoff = issueAppCheckoutHandoff({ amareUserId: userId });
const handoffOpen = unsealCookiePayload(handoff.token, requireAmareSessionSecret());
check("checkout handoff is sealed", typeof handoff.token === "string");
check("checkout handoff has no clientId/email authority", !("clientId" in handoffOpen) && !("email" in handoffOpen));
check("checkout handoff bound to amare_user_id only", handoffOpen.kind === "app_checkout_handoff" && handoffOpen.amare_user_id === userId);
const first = consumeAppCheckoutHandoff(handoff.token);
const second = consumeAppCheckoutHandoff(handoff.token);
check("checkout handoff is single-use", first?.amareUserId === userId && second === null);

const start = await handleAmareCommerceAppCheckoutStart(
  {
    httpMethod: "POST",
    headers: {
      authorization: `Bearer ${JSON.parse(amareAfterMbRevoke.body).accessToken}`,
      origin: "http://127.0.0.1:5178",
      host: "127.0.0.1:4321",
      "x-forwarded-proto": "http",
    },
  },
  {
    findUser: async (id) => ({ amare_user_id: id }),
    resolveCommerceCustomer: async () => ({
      state: "AMARE_LINKED",
      ok: true,
      amareUserId: otherUser,
      clientId: 4242,
    }),
  },
);
const startBody = JSON.parse(start.body || "{}");
check("linked Bearer can start app checkout", start.statusCode === 200 && typeof startBody.url === "string");
check("start URL is first-party handoff, not anonymous /pricing", String(startBody.url).includes("/api/amare/commerce/app-checkout-open?h="));

const checkoutSrc = await readFile(path.join(root, "netlify/functions/stripe-create-checkout-session.mjs"), "utf8");
const handlerIdx = checkoutSrc.indexOf("async function createCheckoutSessionHandler");
const resolveIdx = checkoutSrc.indexOf("commerceCustomer = await resolveCommerceCustomer(event)");
check(
  "create-session resolves commerce customer in the request handler",
  handlerIdx > 0 && resolveIdx > handlerIdx,
);
check("create-session accepts Authorization", checkoutSrc.includes("Authorization") && checkoutSrc.includes("withMobileCorsHandler"));
check("browser clientId is ignored at create-session", checkoutSrc.includes("browser_client_id_never_ownership"));

const appCheckout = await readFile(path.join(root, "amare-app/src/api/checkout.ts"), "utf8");
check("app can POST create-session with Bearer", appCheckout.includes("/api/stripe/checkout/create-session") && appCheckout.includes("Authorization"));
check("linked Buy a pass does not open bare /pricing first", appCheckout.includes("app-checkout-start") && !/window\.open\(pricingUrl/.test(appCheckout.split("startAuthenticatedAppCheckout")[0] || ""));
check("D29 is not used for linked app checkout", !appCheckout.includes("evaluateAnonymousPurchaseAutoLink") && !appCheckout.includes("sanitizeOrderIdHint"));

const profileCreateApp = await readFile(path.join(root, "amare-app/src/api/amare-auth.ts"), "utf8");
check(
  "app profile create sends names/phone/profileTx only",
  profileCreateApp.includes("profileTx") &&
    !/createStudioProfile[\s\S]*email:/.test(profileCreateApp) &&
    !profileCreateApp.includes("clientId:"),
);

for (const [k, v] of Object.entries(prev)) {
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

if (failed) {
  console.log(`\nRESULT: FAIL (${failed})`);
  process.exit(1);
}
console.log("\nRESULT: PASS");
