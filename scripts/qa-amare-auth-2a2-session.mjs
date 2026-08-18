/**
 * AMARÉ Auth 2A.2 session core QA. No Google/Apple/OTP. No Book changes.
 * Run: npm run test:amare-auth-2a2
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { newAmareUserId } from "../netlify/functions/amare-identity-policy.mjs";
import { sealCookiePayload, unsealCookiePayload } from "../netlify/functions/oauth-lib.mjs";
import {
  AMARE_SESS_COOKIE,
  AMARE_SESS_TTL_MS,
  AMARE_SESS_TTL_SECONDS,
  amareAuthEnabled,
  amareSessIssueEnabled,
  buildAmareSessionCookie,
  buildClearAmareSessionCookie,
  canIssueAmareSession,
  maybeIssueAmareSession,
  resolveAmareUser,
  rotateAmareSessionValue,
  sealAmareSessPayload,
  unsealAmareSessPayload,
  unsealAmareSession,
} from "../netlify/functions/amare-sess-lib.mjs";
import { handleAmareAuthSession } from "../netlify/functions/amare-auth-session.mjs";
import { handleAmareAuthLogout } from "../netlify/functions/amare-auth-logout.mjs";

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
  ENABLE_AMARE_AUTH: process.env.ENABLE_AMARE_AUTH,
  ENABLE_AMARE_SESS_ISSUE: process.env.ENABLE_AMARE_SESS_ISSUE,
  AMARE_SESSION_SECRET: process.env.AMARE_SESSION_SECRET,
  MINDBODY_SESSION_SECRET: process.env.MINDBODY_SESSION_SECRET,
};

function restoreEnv() {
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

const AMARE_SECRET = "qa-2a2-amare-session-secret-key!!";
const MB_SECRET = "qa-2a2-mindbody-session-secret!!";
const userId = newAmareUserId();

delete process.env.ENABLE_AMARE_AUTH;
delete process.env.ENABLE_AMARE_SESS_ISSUE;
check("ENABLE_AMARE_AUTH default off", amareAuthEnabled() === false);
check("ENABLE_AMARE_SESS_ISSUE default off", amareSessIssueEnabled() === false);

process.env.AMARE_SESSION_SECRET = AMARE_SECRET;
process.env.MINDBODY_SESSION_SECRET = MB_SECRET;

const sealed = sealAmareSessPayload({ amare_user_id: userId });
const opened = unsealAmareSessPayload(sealed);
check("seal/unseal valid amare_sess", opened && opened.amare_user_id === userId);
check(
  "payload contains amare_user_id, at, exp",
  opened &&
    opened.amare_user_id === userId &&
    typeof opened.at === "number" &&
    typeof opened.exp === "number",
);
check("payload contains NO clientId", opened && !("client_id" in opened) && !("clientId" in opened));
check(
  "payload contains NO Mindbody tokens",
  opened && !("access_token" in opened) && !("refresh_token" in opened),
);
check(
  "timestamps are Unix milliseconds",
  opened && opened.at > 1e12 && opened.exp > 1e12 && opened.exp - opened.at === AMARE_SESS_TTL_MS,
);

const expiredSealed = sealAmareSessPayload({
  amare_user_id: userId,
  at: Date.now() - AMARE_SESS_TTL_MS - 5_000,
});
const expired = unsealAmareSession(expiredSealed);
check("expired session rejected", expired.ok === false && expired.reason === "expired");

const noExpSealed = sealCookiePayload({ amare_user_id: userId, at: Date.now() }, AMARE_SECRET);
const noExp = unsealAmareSession(noExpSealed);
check("session without exp rejected", noExp.ok === false && noExp.reason === "missing_exp");

const tampered = `${sealed.slice(0, -2)}aa`;
const tamperedResult = unsealAmareSession(tampered);
check("tampered ciphertext rejected", tamperedResult.ok === false && tamperedResult.reason === "invalid");

const malformed = sealCookiePayload({ foo: 1, at: Date.now(), exp: Date.now() + 1000 }, AMARE_SECRET);
check("malformed payload rejected", unsealAmareSessPayload(malformed) === null);

const missingId = sealCookiePayload({ at: Date.now(), exp: Date.now() + AMARE_SESS_TTL_MS }, AMARE_SECRET);
check("missing amare_user_id rejected", unsealAmareSessPayload(missingId) === null);

let invalidIdThrew = false;
try {
  sealAmareSessPayload({ amare_user_id: "not-a-user" });
} catch (err) {
  invalidIdThrew = String(err.message) === "invalid_amare_user_id";
}
check("invalid user id format rejected if current policy exposes validator", invalidIdThrew);

const unknown = await resolveAmareUser(
  { headers: { cookie: `${AMARE_SESS_COOKIE}=${encodeURIComponent(sealed)}` } },
  { findUser: async () => null },
);
check(
  "unknown/deleted amare_user_id does not resolve authenticated user",
  unknown.signedIn === false && unknown.reason === "user_not_found",
);

const known = await resolveAmareUser(
  { headers: { cookie: `${AMARE_SESS_COOKIE}=${encodeURIComponent(sealed)}` } },
  { findUser: async (id) => ({ amare_user_id: id }) },
);
check("current user resolver confirms existing user", known.signedIn === true && known.amareUserId === userId);
check("resolver does not load Studio clientId", !("clientId" in known) && !("client_id" in known));

const httpsCookie = buildAmareSessionCookie(sealed, { "x-forwarded-proto": "https" });
check("session Max-Age matches payload TTL", httpsCookie.includes(`Max-Age=${AMARE_SESS_TTL_SECONDS}`));
check("HttpOnly present", /HttpOnly/i.test(httpsCookie));
check("SameSite=Lax present", /SameSite=Lax/i.test(httpsCookie));
check("Path=/ present", /Path=\//.test(httpsCookie));
check("Secure on HTTPS", /;\s*Secure/.test(httpsCookie));

const httpCookie = buildAmareSessionCookie(sealed, { "x-forwarded-proto": "http" });
check("Secure omitted on HTTP", !/;\s*Secure/.test(httpCookie));

const clearCookie = buildClearAmareSessionCookie({ "x-forwarded-proto": "https" });
check("clear cookie uses Max-Age=0", /Max-Age=0/.test(clearCookie) && clearCookie.startsWith(`${AMARE_SESS_COOKIE}=;`));
check("clear cookie keeps Path=/ SameSite HttpOnly", /Path=\//.test(clearCookie) && /SameSite=Lax/.test(clearCookie) && /HttpOnly/.test(clearCookie));

const rotatedA = rotateAmareSessionValue(userId);
const rotatedB = rotateAmareSessionValue(userId);
const rotA = unsealAmareSessPayload(rotatedA);
const rotB = unsealAmareSessPayload(rotatedB);
check(
  "rotation creates a new sealed value/new at",
  rotatedA !== rotatedB && rotA && rotB && rotA.amare_user_id === userId && rotB.exp !== undefined,
);

process.env.ENABLE_AMARE_AUTH = "1";
delete process.env.ENABLE_AMARE_SESS_ISSUE;
check("ENABLE_AMARE_SESS_ISSUE=0 blocks normal issuance", maybeIssueAmareSession({ amare_user_id: userId }) === null);
check("canIssueAmareSession false when issue flag off", canIssueAmareSession() === false);

process.env.ENABLE_AMARE_SESS_ISSUE = "1";
const issued = maybeIssueAmareSession({
  amare_user_id: userId,
  headers: { "x-forwarded-proto": "https" },
});
check("issuance allowed only when both flags and secret are set", Boolean(issued?.cookie && issued.sealed));

const sealedWithAmare = sealAmareSessPayload({ amare_user_id: userId });
let mbUnsealFailed = false;
try {
  unsealCookiePayload(sealedWithAmare, MB_SECRET);
} catch {
  mbUnsealFailed = true;
}
process.env.AMARE_SESSION_SECRET = MB_SECRET;
const swapped = unsealAmareSessPayload(sealedWithAmare);
process.env.AMARE_SESSION_SECRET = AMARE_SECRET;
check(
  "AMARE_SESSION_SECRET and MINDBODY_SESSION_SECRET are not interchangeable assumptions",
  mbUnsealFailed && swapped === null,
);

delete process.env.ENABLE_AMARE_AUTH;
const disabledSession = await handleAmareAuthSession({ httpMethod: "GET", headers: {} });
check(
  "master flag off: /api/amare/auth/session unavailable/disabled",
  disabledSession.statusCode === 404 && disabledSession.body === "amare_auth_disabled",
);
const disabledLogout = await handleAmareAuthLogout({ httpMethod: "POST", headers: {} });
check("master flag off: /api/amare/auth/logout unavailable/disabled", disabledLogout.statusCode === 404);

process.env.ENABLE_AMARE_AUTH = "1";
const signedOut = await handleAmareAuthSession({ httpMethod: "GET", headers: {} });
check(
  "no cookie: signedIn=false",
  signedOut.statusCode === 200 && JSON.parse(signedOut.body).signedIn === false,
);

const validHttp = await handleAmareAuthSession(
  {
    httpMethod: "GET",
    headers: { cookie: `${AMARE_SESS_COOKIE}=${encodeURIComponent(sealed)}` },
  },
  { findUser: async (id) => ({ amare_user_id: id }) },
);
const validBody = JSON.parse(validHttp.body);
check("valid session: signedIn=true", validHttp.statusCode === 200 && validBody.signedIn === true && validBody.amareUserId === userId);
check(
  "session response exposes no clientId",
  !("clientId" in validBody) && !("client_id" in validBody) && !("candidate_client_ids" in validBody),
);

const expiredHttp = await handleAmareAuthSession({
  httpMethod: "GET",
  headers: { cookie: `${AMARE_SESS_COOKIE}=${encodeURIComponent(expiredSealed)}` },
});
const expiredBody = JSON.parse(expiredHttp.body);
check(
  "expired/tampered cookie: signedIn=false no privileged data",
  expiredHttp.statusCode === 200 && expiredBody.signedIn === false && !expiredBody.amareUserId,
);

const tamperedHttp = await handleAmareAuthSession({
  httpMethod: "GET",
  headers: { cookie: `${AMARE_SESS_COOKIE}=${encodeURIComponent(tampered)}` },
});
check("tampered cookie: signedIn=false", JSON.parse(tamperedHttp.body).signedIn === false);

const logout = await handleAmareAuthLogout({
  httpMethod: "POST",
  headers: {
    cookie: `${AMARE_SESS_COOKIE}=${encodeURIComponent(sealed)}; mb_sess=keep-me`,
    host: "www.amarewellness.com",
    origin: "https://www.amarewellness.com",
    "x-forwarded-proto": "https",
  },
});
const logoutSet = String(logout.headers["Set-Cookie"] || "");
check("logout clears amare_sess", logout.statusCode === 200 && logoutSet.includes(`${AMARE_SESS_COOKIE}=`) && /Max-Age=0/.test(logoutSet));
check("logout does NOT clear mb_sess", !/mb_sess=/.test(logoutSet));

const logoutAgain = await handleAmareAuthLogout({
  httpMethod: "POST",
  headers: { host: "www.amarewellness.com", origin: "https://www.amarewellness.com" },
});
check("logout is idempotent", logoutAgain.statusCode === 200 && JSON.parse(logoutAgain.body).ok === true);

const foreign = await handleAmareAuthLogout({
  httpMethod: "POST",
  headers: { host: "www.amarewellness.com", origin: "https://evil.example" },
});
check("logout rejects foreign Origin", foreign.statusCode === 403);

const toml = await readFile(path.join(root, "netlify.toml"), "utf8");
const functionsDir = [
  "amare-auth-session.mjs",
  "amare-auth-logout.mjs",
  "amare-sess-lib.mjs",
  "amare-identity-store.mjs",
];
let issueRoute = /from = "\/api\/amare\/auth\/(session\/create|dev-login|issue)"/.test(toml);
for (const name of functionsDir) {
  const src = await readFile(path.join(root, "netlify/functions", name), "utf8");
  if (/\/api\/amare\/auth\/(session\/create|dev-login|issue)\b/.test(src)) issueRoute = true;
}
check("no public endpoint can issue a session for arbitrary amare_user_id", !issueRoute);

const book = await readFile(path.join(root, "netlify/functions/mindbody-class-book.mjs"), "utf8");
const consumer = await readFile(path.join(root, "netlify/functions/mindbody-consumer-lib.mjs"), "utf8");
const classes = await readFile(path.join(root, "src/js/classes-schedule.js"), "utf8");
check("bookingAllowed unchanged in class-book", book.includes("bookingAllowed"));
check("consumerAssociated unchanged in class-book", book.includes("consumerAssociated"));
check("class-book still resolves a Studio client", book.includes("resolveStudioCustomer") && book.includes("bookingAllowed"));
check("class-book does not read amare_sess", !book.includes("amare_sess"));
check("consumer-lib does not read amare_sess", !consumer.includes("amare_sess"));
check("classes-schedule still gates on oauthBookingAllowed", classes.includes("oauthLoggedIn && !oauthBookingAllowed"));

const oauthSession = await readFile(path.join(root, "netlify/functions/mindbody-oauth-session.mjs"), "utf8");
check(
  "Mindbody session JSON still returns authenticated/clientId/bookingAllowed",
  oauthSession.includes("authenticated: true") &&
    oauthSession.includes("clientId: link.clientId") &&
    oauthSession.includes("bookingAllowed: link.bookingAllowed") &&
    oauthSession.includes("consumerAssociated: link.consumerAssociated"),
);
check("logAmareSessVersusMbSess option renamed to lookupActiveClientId", !(await readFile(path.join(root, "netlify/functions/amare-sess-lib.mjs"), "utf8")).includes("lookupLinkedClientId"));

restoreEnv();

if (failed) {
  console.log(`\n${failed} 2A.2 session check(s) failed`);
  process.exit(1);
}
console.log("\nAll AMARÉ 2A.2 session QA checks passed.");
