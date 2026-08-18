/**
 * AMARÉ mobile auth alignment QA. Local only. Does not deploy.
 * Run: npm run test:amare-auth-mobile
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { newAmareUserId } from "../netlify/functions/amare-identity-policy.mjs";
import {
  amareUserIdFromMobileAccessToken,
  amareUserIdFromMobileRefreshToken,
  issueAmareMobileTokenPair,
  isTrustedMobileAppOrigin,
  mobileBearerAuthEnabled,
  sessionFromMobileAccessToken,
} from "../netlify/functions/mobile-auth-lib.mjs";
import { isForeignOriginMutation, resolveAmareUser } from "../netlify/functions/amare-sess-lib.mjs";
import {
  readProfileTxToken,
  sealProfileTxToken,
  withAmareMobileTokens,
} from "../netlify/functions/amare-auth-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;

function check(name, ok, detail) {
  if (ok) console.log(`PASS — ${name}`);
  else {
    failed += 1;
    console.log(`FAIL — ${name}${detail ? `\n  ${detail}` : ""}`);
  }
}

const prev = {
  ENABLE_MOBILE_BEARER_AUTH: process.env.ENABLE_MOBILE_BEARER_AUTH,
  ENABLE_AMARE_AUTH: process.env.ENABLE_AMARE_AUTH,
  MINDBODY_SESSION_SECRET: process.env.MINDBODY_SESSION_SECRET,
  AMARE_SESSION_SECRET: process.env.AMARE_SESSION_SECRET,
  MOBILE_JWT_SECRET: process.env.MOBILE_JWT_SECRET,
  AMARE_MOBILE_ALLOWED_ORIGINS: process.env.AMARE_MOBILE_ALLOWED_ORIGINS,
};

function restoreEnv() {
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

process.env.MINDBODY_SESSION_SECRET = "qa-mobile-mindbody-session-secret!!";
process.env.AMARE_SESSION_SECRET = "qa-mobile-amare-session-secret-key!!";
process.env.MOBILE_JWT_SECRET = "qa-mobile-jwt-secret-key-24chars!!";
delete process.env.ENABLE_MOBILE_BEARER_AUTH;
check("mobile bearer default off", mobileBearerAuthEnabled() === false);
check(
  "untrusted origin still foreign when mobile flag off",
  isForeignOriginMutation({
    headers: { origin: "http://127.0.0.1:5178", host: "127.0.0.1:4321" },
  }) === true,
);

process.env.ENABLE_MOBILE_BEARER_AUTH = "1";
process.env.ENABLE_AMARE_AUTH = "1";
check("mobile bearer on", mobileBearerAuthEnabled() === true);
check("capacitor origin trusted", isTrustedMobileAppOrigin("capacitor://localhost") === true);
check("vite origin trusted", isTrustedMobileAppOrigin("http://127.0.0.1:5178") === true);
check("localhost vite trusted", isTrustedMobileAppOrigin("http://localhost:5178") === true);
check("random origin not trusted", isTrustedMobileAppOrigin("https://evil.example") === false);
check(
  "vite OTP POST is not foreign_origin",
  isForeignOriginMutation({
    headers: { origin: "http://127.0.0.1:5178", host: "127.0.0.1:4321" },
  }) === false,
);
check(
  "evil origin still foreign",
  isForeignOriginMutation({
    headers: { origin: "https://evil.example", host: "127.0.0.1:4321" },
  }) === true,
);

const userId = newAmareUserId();
const pair = issueAmareMobileTokenPair(userId);
check("amare access issued", typeof pair.accessToken === "string" && pair.accessToken.includes("."));
check("amare refresh issued", typeof pair.refreshToken === "string");
check("sessionKind amare", pair.sessionKind === "amare");
check("access typ resolves user", amareUserIdFromMobileAccessToken(pair.accessToken) === userId);
check("refresh typ resolves user", amareUserIdFromMobileRefreshToken(pair.refreshToken) === userId);
check(
  "amare token is not a Mindbody mobile session",
  sessionFromMobileAccessToken(pair.accessToken) === null,
);
check("amare JWT has no clientId", !pair.accessToken.includes("clientId") && !pair.accessToken.includes("client_id"));

const resolved = await resolveAmareUser(
  { headers: { authorization: `Bearer ${pair.accessToken}` } },
  { findUser: async (id) => ({ amare_user_id: id }) },
);
check("resolveAmareUser accepts amare mobile bearer", resolved.signedIn === true && resolved.amareUserId === userId);
check("bearer resolve has no clientId", !("clientId" in resolved) && !("client_id" in resolved));

const missingUser = await resolveAmareUser(
  { headers: { authorization: `Bearer ${pair.accessToken}` } },
  { findUser: async () => null },
);
check("unknown amare user rejected", missingUser.signedIn === false && missingUser.reason === "user_not_found");

const attached = withAmareMobileTokens({ ok: true, claimStatus: "linked" }, userId);
check("verify-style JSON includes mobile tokens", !!attached.accessToken && !!attached.refreshToken);
check("tokens wrap same user", amareUserIdFromMobileAccessToken(attached.accessToken) === userId);

const profileTx = sealProfileTxToken({
  kind: "new_profile",
  provider: "email",
  amare_user_id: userId,
  provider_sub: "qa@example.com",
  exp: Date.now() + 60_000,
  nonce: "qa-nonce",
});
check("profile tx sealed for mobile JSON", typeof profileTx === "string" && profileTx.length > 10);
const openedTx = readProfileTxToken(profileTx);
check("profile tx unseals without cookie", openedTx?.amare_user_id === userId && openedTx?.kind === "new_profile");
check("empty profile tx rejected", readProfileTxToken("") === null);
check("garbage profile tx rejected", readProfileTxToken("not-a-seal") === null);

const loginSrc = await readFile(path.join(root, "amare-app/src/screens/LoginScreen.tsx"), "utf8");
check("OTP is primary login", loginSrc.includes("requestEmailOtp") && loginSrc.includes("verifyEmailOtp"));
check("candidate copy present", loginSrc.includes("We found your existing AMARÉ profile"));
check("candidate confirm present", loginSrc.includes("Continue with this profile"));
check("candidate reject present", loginSrc.includes("This isn't my profile") || loginSrc.includes("This isn&apos;t my profile"));
check("no continue as new on mobile login", !loginSrc.includes("Continue as a new account"));
check(
  "reject does not call profile create",
  /function onRejectCandidate\(\) \{\s*setStep\("mismatch"\);/.test(loginSrc),
);
check("D28 fields collected", loginSrc.includes("First name") && loginSrc.includes("Last name") && loginSrc.includes("Mobile phone"));
check("Apple UI hidden", !/Sign in with Apple/i.test(loginSrc));
check("Google UI hidden", !/Sign in with Google/i.test(loginSrc));
check("Mindbody is fallback only", loginSrc.includes("Already use Mindbody with AMARÉ?") && loginSrc.includes("signInWithMindbody"));
check("orderId is hint only", loginSrc.includes("sanitizeOrderIdHint"));

const authSrc = await readFile(path.join(root, "amare-app/src/auth/AuthContext.tsx"), "utf8");
check(
  "Mindbody fallback if member-access is signed out",
  authSrc.includes("if (access.signedIn)") && authSrc.includes("/api/mindbody/member/summary"),
);

const bookSrc = await readFile(path.join(root, "amare-app/src/screens/ScheduleScreen.tsx"), "utf8");
check(
  "book POST does not send clientId",
  !/JSON\.stringify\(\{[^}]*clientId/.test(bookSrc) && bookSrc.includes('JSON.stringify({ classId: id })'),
);

const storeSrc = await readFile(path.join(root, "amare-app/src/session-store.ts"), "utf8");
check("native store prefers Keychain plugin", storeSrc.includes("capacitor-secure-storage"));
check("does not treat localStorage as native store", storeSrc.includes("not a native app"));

restoreEnv();

if (failed) {
  console.log(`\nRESULT: FAIL (${failed})`);
  process.exit(1);
}
console.log("\nRESULT: PASS");
