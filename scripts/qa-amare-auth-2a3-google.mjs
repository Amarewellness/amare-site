/**
 * AMARÉ Auth 2A.3 Google + claim QA. Deterministic mocks. No live Google E2E.
 * Run: npm run test:amare-auth-2a3
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { newAmareUserId } from "../netlify/functions/amare-identity-policy.mjs";
import { sealCookiePayload } from "../netlify/functions/oauth-lib.mjs";
import {
  AMARE_CLAIM_TX_COOKIE,
  AMARE_OAUTH_TX_COOKIE,
  AMARE_PENDING_LINK_COOKIE,
  amareAuthGoogleEnabled,
  buildGoogleStart,
  buildPendingLinkCookie,
  canIssueAmareSessionFromGoogle,
  confirmAmareClaim,
  consumeOAuthTransaction,
  finishGoogleAuthentication,
  googleAuthRoutesEnabled,
  issueGoogleAmareSession,
  verifyGoogleIdToken,
} from "../netlify/functions/amare-auth-lib.mjs";
import { handleAmareAuthGoogleStart } from "../netlify/functions/amare-auth-google-start.mjs";
import { handleAmareAuthGoogleCallback } from "../netlify/functions/amare-auth-google-callback.mjs";
import { handleAmareAuthClaimConfirm } from "../netlify/functions/amare-auth-claim-confirm.mjs";
import {
  AMARE_SESS_COOKIE,
  unsealAmareSessPayload,
} from "../netlify/functions/amare-sess-lib.mjs";

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
function restoreEnv() {
  for (const k of [
    "ENABLE_AMARE_AUTH",
    "QA_AMARE_GOOGLE_AUTH",
    "ENABLE_AMARE_SESS_ISSUE",
    "AMARE_SESSION_SECRET",
    "GOOGLE_OAUTH_CLIENT_ID",
    "GOOGLE_OAUTH_CLIENT_SECRET",
    "GOOGLE_OAUTH_REDIRECT_URI",
    "MINDBODY_SITE_ID",
  ]) {
    if (prev[k] === undefined) delete process.env[k];
    else process.env[k] = prev[k];
  }
}

delete process.env.QA_AMARE_GOOGLE_AUTH;
check("google auth permanently off in production runtime", amareAuthGoogleEnabled() === false);

delete process.env.ENABLE_AMARE_AUTH;
check("start requires master + Google feature", googleAuthRoutesEnabled() === false);
const disabledStart = await handleAmareAuthGoogleStart({ httpMethod: "GET", headers: {}, queryStringParameters: {} });
check("start unavailable when flags off", disabledStart.statusCode === 404);

process.env.ENABLE_AMARE_AUTH = "1";
process.env.QA_AMARE_GOOGLE_AUTH = "1";
process.env.ENABLE_AMARE_SESS_ISSUE = "1";
process.env.AMARE_SESSION_SECRET = "qa-2a3-amare-session-secret-key!!";
process.env.GOOGLE_OAUTH_CLIENT_ID = "qa-google-client.apps.googleusercontent.com";
process.env.GOOGLE_OAUTH_CLIENT_SECRET = "qa-google-secret";
process.env.GOOGLE_OAUTH_REDIRECT_URI = "https://www.amarewellness.com/api/amare/auth/google/callback";
process.env.MINDBODY_SITE_ID = "amare-qa-2a3";

const started = buildGoogleStart({ returnPath: "https://evil.example/phish", headers: { "x-forwarded-proto": "https" } });
const startUrl = new URL(started.url);
check("return path sanitized", started.txCookie.includes(AMARE_OAUTH_TX_COOKIE) && !startUrl.searchParams.get("state")?.includes("evil.example"));
check("state generated and validated", Boolean(started.state) && consumeOAuthTransaction({ cookieHeader: started.txCookie.replace(/^amare_oauth_tx=/, `${AMARE_OAUTH_TX_COOKIE}=`), state: started.state }).ok !== undefined);
function cookiePair(setCookie) {
  return String(setCookie).split(";")[0];
}
const startCookieHeader = cookiePair(started.txCookie);
const consumedOk = consumeOAuthTransaction({ cookieHeader: startCookieHeader, state: started.state });
check("state generated and validated", consumedOk.ok === true && consumedOk.tx.tx === started.tx);
check("PKCE verifier/challenge used", Boolean(started.pkce.verifier) && startUrl.searchParams.get("code_challenge_method") === "S256" && Boolean(startUrl.searchParams.get("code_challenge")));
check(
  "redirect_uri is explicit GOOGLE_OAUTH_REDIRECT_URI, not SITE_URL",
  startUrl.searchParams.get("redirect_uri") === process.env.GOOGLE_OAUTH_REDIRECT_URI,
);
check("nonce generated and validated", Boolean(started.nonce) && consumedOk.tx.nonce === started.nonce);

const wrongState = consumeOAuthTransaction({ cookieHeader: startCookieHeader, state: "not-a-state" });
check("wrong state rejected", wrongState.ok === false && wrongState.reason === "invalid_state");
check("missing correlation cookie rejected", consumeOAuthTransaction({ cookieHeader: "", state: started.state }).reason === "missing_correlation_cookie");

const replayCookie = `${AMARE_OAUTH_TX_COOKIE}=${encodeURIComponent(
  (await import("../netlify/functions/oauth-lib.mjs")).sealCookiePayload(
    { ...consumedOk.tx, consumed: true },
    process.env.AMARE_SESSION_SECRET,
  ),
)}`;
check(
  "replayed/consumed OAuth transaction rejected",
  consumeOAuthTransaction({ cookieHeader: replayCookie, state: started.state }).reason === "replayed_transaction",
);

async function verifyWith(payload, token = "tok", expectedNonce = "n") {
  return verifyGoogleIdToken(token, { nonce: expectedNonce, audience: process.env.GOOGLE_OAUTH_CLIENT_ID }, {
    jwtVerify: async (_t, _j, opts) => {
      if (token === "bad-sig") {
        const err = new Error("signature verification failed");
        err.code = "ERR_JWS_SIGNATURE_VERIFICATION_FAILED";
        throw err;
      }
      if (opts.issuer && payload.iss && !opts.issuer.includes(payload.iss)) {
        const err = new Error("unexpected issuer");
        err.claim = "iss";
        throw err;
      }
      if (opts.audience && payload.aud && opts.audience !== payload.aud) {
        const err = new Error("unexpected audience");
        err.claim = "aud";
        throw err;
      }
      if (payload.exp && payload.exp * 1000 < Date.now()) {
        const err = new Error("expired");
        err.code = "ERR_JWT_EXPIRED";
        err.claim = "exp";
        throw err;
      }
      return { payload };
    },
  });
}

let issThrew = false;
try {
  await verifyWith({ iss: "https://evil.example", aud: process.env.GOOGLE_OAUTH_CLIENT_ID, sub: "g1", nonce: "n", exp: Math.floor(Date.now() / 1000) + 60 });
} catch (e) {
  issThrew = e.code === "google_issuer_invalid";
}
check("invalid issuer rejected", issThrew);

let audThrew = false;
try {
  await verifyWith({ iss: "https://accounts.google.com", aud: "other-client", sub: "g1", nonce: "n", exp: Math.floor(Date.now() / 1000) + 60 });
} catch (e) {
  audThrew = e.code === "google_audience_invalid";
}
check("invalid audience rejected", audThrew);

let expThrew = false;
try {
  await verifyWith({ iss: "https://accounts.google.com", aud: process.env.GOOGLE_OAUTH_CLIENT_ID, sub: "g1", nonce: "n", exp: Math.floor(Date.now() / 1000) - 10 });
} catch (e) {
  expThrew = e.code === "google_id_token_expired";
}
check("expired ID token rejected", expThrew);

let sigThrew = false;
try {
  await verifyWith({ iss: "https://accounts.google.com", aud: process.env.GOOGLE_OAUTH_CLIENT_ID, sub: "g1", nonce: "n", exp: Math.floor(Date.now() / 1000) + 60 }, "bad-sig");
} catch (e) {
  sigThrew = e.code === "google_id_token_bad_signature";
}
check("invalid signature rejected", sigThrew);

let nonceThrew = false;
try {
  await verifyWith({ iss: "https://accounts.google.com", aud: process.env.GOOGLE_OAUTH_CLIENT_ID, sub: "g1", nonce: "other", exp: Math.floor(Date.now() / 1000) + 60 }, "tok", "n");
} catch (e) {
  nonceThrew = e.code === "google_nonce_mismatch";
}
check("nonce mismatch rejected", nonceThrew);

let subThrew = false;
try {
  await verifyWith({ iss: "https://accounts.google.com", aud: process.env.GOOGLE_OAUTH_CLIENT_ID, sub: "", nonce: "n", exp: Math.floor(Date.now() / 1000) + 60 });
} catch (e) {
  subThrew = e.code === "google_sub_missing";
}
check("missing sub rejected", subThrew);

const goodClaims = await verifyWith({
  iss: "https://accounts.google.com",
  aud: process.env.GOOGLE_OAUTH_CLIENT_ID,
  sub: "google-sub-abc",
  nonce: "n",
  email: "a@b.com",
  email_verified: true,
  exp: Math.floor(Date.now() / 1000) + 60,
});
check("sub used as identity key", goodClaims.sub === "google-sub-abc");
check("email is NOT identity key", goodClaims.email === "a@b.com" && goodClaims.sub !== goodClaims.email);

const unverified = await verifyWith({
  iss: "https://accounts.google.com",
  aud: process.env.GOOGLE_OAUTH_CLIENT_ID,
  sub: "google-sub-u",
  nonce: "n",
  email: "u@b.com",
  email_verified: false,
  exp: Math.floor(Date.now() / 1000) + 60,
});
check("unverified email not used for Studio matching", unverified.email === null && unverified.rawEmailPresent === true);

function memoryIdentity() {
  const users = new Map();
  const identities = [];
  const associations = [];
  let assocId = 1;
  return {
    users,
    identities,
    associations,
    async findIdentity(provider, sub) {
      return identities.find((i) => i.provider === provider && i.provider_sub === sub) || null;
    },
    async createUserWithIdentity({ provider, provider_sub, email, email_verified }) {
      const amare_user_id = newAmareUserId();
      users.set(amare_user_id, { amare_user_id });
      identities.push({ amare_user_id, provider, provider_sub, email: email || null, email_verified: !!email_verified });
      return { amare_user_id, provider, provider_sub };
    },
    async attachIdentity({ amare_user_id, provider, provider_sub, email, email_verified }) {
      if (identities.some((i) => i.provider === provider && i.provider_sub === provider_sub)) {
        const err = new Error("duplicate key amare_identities_provider_sub_uidx");
        err.code = "23505";
        throw err;
      }
      identities.push({ amare_user_id, provider, provider_sub, email: email || null, email_verified: !!email_verified });
    },
    async findActiveAssociationByClientId(siteId, clientId) {
      return (
        associations.find(
          (a) => a.site_id === siteId && Number(a.client_id) === Number(clientId) && (a.status === "verified" || a.status === "linked"),
        ) || null
      );
    },
    async getActiveAssociation(amareUserId, siteId) {
      return (
        associations.find(
          (a) => a.amare_user_id === amareUserId && a.site_id === siteId && (a.status === "verified" || a.status === "linked"),
        ) || null
      );
    },
    async getCandidateAssociation(amareUserId, siteId) {
      const rows = associations.filter((a) => a.amare_user_id === amareUserId && a.site_id === siteId && a.status === "candidate");
      return rows[rows.length - 1] || null;
    },
    async getLatestAssociation(amareUserId, siteId) {
      const rows = associations.filter((a) => a.amare_user_id === amareUserId && a.site_id === siteId);
      return rows[rows.length - 1] || null;
    },
    async proposeAssociation(input) {
      if (input.status === "verified" || input.status === "linked") throw new Error("propose_cannot_write_active_status");
      associations.push({ id: assocId++, ...input, client_id: input.client_id ?? null });
    },
    async confirmAssociation(input) {
      if (input.explicitConfirm !== true) throw new Error("verified_requires_explicit_confirm");
      const owner = associations.find(
        (a) => Number(a.client_id) === Number(input.client_id) && (a.status === "verified" || a.status === "linked"),
      );
      if (owner && owner.amare_user_id !== input.amare_user_id) {
        const err = new Error("duplicate key amare_studio_assoc_site_client_active_uidx");
        err.code = "23505";
        throw err;
      }
      associations.push({
        id: assocId++,
        amare_user_id: input.amare_user_id,
        site_id: input.site_id,
        status: "verified",
        client_id: input.client_id,
      });
    },
    async promoteAssociationToLinked() {
      throw new Error("linked_forbidden_in_phase1");
    },
  };
}

const siteId = "amare-qa-2a3";
const mem = memoryIdentity();
const first = await finishGoogleAuthentication(
  { sub: "g-new-1", email: null, mbSessClientId: null, siteId },
  { identity: mem, searchStudioClientsByEmail: async () => [] },
);
check("first Google sub creates one amare_user + one identity", first.createdUser === true && mem.users.size === 1 && mem.identities.length === 1);
check("new Google identity alone creates zero verified Studio associations", !mem.associations.some((a) => a.status === "verified" || a.status === "linked"));
check("Google authentication alone never writes linked", !mem.associations.some((a) => a.status === "linked"));
check("callback cannot write verified", first.claim.status !== "verified" && first.claim.status !== "linked");
check("D26 preserved", first.claim.status === "unlinked");

const again = await finishGoogleAuthentication(
  { sub: "g-new-1", email: null, mbSessClientId: null, siteId },
  { identity: mem, searchStudioClientsByEmail: async () => [] },
);
check("same Google sub returns same amare_user", again.amare_user_id === first.amare_user_id && again.createdUser === false);

let attachOther = false;
try {
  await mem.attachIdentity({ amare_user_id: newAmareUserId(), provider: "google", provider_sub: "g-new-1" });
} catch (e) {
  attachOther = /duplicate|23505/.test(String(e.code || e.message));
}
check("same Google sub cannot attach to another user", attachOther);

const emailMem = memoryIdentity();
const uniqueEmail = await finishGoogleAuthentication(
  { sub: "g-email-1", email: "one@example.test", mbSessClientId: null, siteId },
  { identity: emailMem, searchStudioClientsByEmail: async () => [1001] },
);
check("unique verified email → candidate not verified", uniqueEmail.claim.status === "candidate" && uniqueEmail.claim.clientId === 1001);

const ambMem = memoryIdentity();
const amb = await finishGoogleAuthentication(
  { sub: "g-amb", email: "many@example.test", mbSessClientId: null, siteId },
  { identity: ambMem, searchStudioClientsByEmail: async () => [1, 2] },
);
check("multiple clients → ambiguous", amb.claim.status === "ambiguous");

const noneMem = memoryIdentity();
const none = await finishGoogleAuthentication(
  { sub: "g-none", email: "none@example.test", mbSessClientId: null, siteId },
  { identity: noneMem, searchStudioClientsByEmail: async () => [] },
);
check("no Studio match → unlinked", none.claim.status === "unlinked");

const mbMem = memoryIdentity();
const mbCand = await finishGoogleAuthentication(
  { sub: "g-mb", email: "x@y.test", mbSessClientId: 84500, siteId },
  { identity: mbMem, searchStudioClientsByEmail: async () => [] },
);
check("valid mb_sess → strong candidate confirmation still required", mbCand.claim.status === "candidate" && mbCand.claim.clientId === 84500 && mbCand.claim.autoBind === false);

const mismatchMem = memoryIdentity();
const mismatch = await finishGoogleAuthentication(
  { sub: "g-mis", email: "new@example.com", mbSessClientId: 77001, siteId },
  { identity: mismatchMem, searchStudioClientsByEmail: async () => [] },
);
check("email mismatch + valid mb_sess → candidate from mb_sess", mismatch.claim.status === "candidate" && mismatch.claim.clientId === 77001);

const usrA = newAmareUserId();
const crit = memoryIdentity();
crit.users.set(usrA, { amare_user_id: usrA });
crit.associations.push({
  id: 1,
  amare_user_id: usrA,
  site_id: siteId,
  client_id: 84521,
  status: "verified",
});
const critical = await finishGoogleAuthentication(
  { sub: "g-brand-new", email: "b@example.com", mbSessClientId: 84521, siteId },
  { identity: crit, searchStudioClientsByEmail: async () => [] },
);
check(
  "CRITICAL existing client + new Google sub: no usr_B created",
  critical.outcome === "pending_attach" && crit.users.size === 1 && crit.identities.length === 0,
);
check(
  "CRITICAL no silent Google attach to usr_A",
  !crit.identities.some((i) => i.amare_user_id === usrA),
);

const confirmAttach = await confirmAmareClaim(
  {
    pending: critical.pending,
    explicitConfirm: true,
    siteId,
  },
  { identity: crit },
);
check(
  "pending-link confirm attaches Google to usr_A",
  confirmAttach.ok && confirmAttach.amare_user_id === usrA && crit.identities[0].provider_sub === "g-brand-new",
);

const shared = memoryIdentity();
shared.users.set(usrA, { amare_user_id: usrA });
shared.associations.push({ id: 1, amare_user_id: usrA, site_id: siteId, client_id: 84521, status: "verified" });
const sharedPend = await finishGoogleAuthentication(
  { sub: "g-person-b", email: "b@x.test", mbSessClientId: 84521, siteId },
  { identity: shared, searchStudioClientsByEmail: async () => [] },
);
const continued = await confirmAmareClaim(
  { pending: sharedPend.pending, continueAsNew: true, siteId },
  { identity: shared },
);
check(
  "shared-computer case: continue-as-new is Person B, no steal",
  continued.ok &&
    continued.amare_user_id !== usrA &&
    !shared.associations.some((a) => a.amare_user_id === continued.amare_user_id && Number(a.client_id) === 84521 && a.status !== "unlinked"),
);
check(
  "continue-as-new: B has no candidate/verified/linked from A",
  continued.status === "unlinked" &&
    shared.identities.some((i) => i.amare_user_id === continued.amare_user_id && i.provider === "google" && i.provider_sub === "g-person-b") &&
    !shared.associations.some(
      (a) =>
        a.amare_user_id === continued.amare_user_id &&
        Number(a.client_id) === 84521 &&
        ["candidate", "verified", "linked"].includes(a.status),
    ),
);
const afterContinue = await finishGoogleAuthentication(
  { sub: "g-person-b", email: "b@x.test", mbSessClientId: 84521, siteId },
  { identity: shared, searchStudioClientsByEmail: async () => [] },
);
check(
  "after continueAsNew, A's mb_sess is not claim proof for B",
  afterContinue.amare_user_id === continued.amare_user_id &&
    afterContinue.claim.status === "unlinked" &&
    afterContinue.claim.clientId == null &&
    !shared.associations.some(
      (a) => a.amare_user_id === continued.amare_user_id && ["candidate", "verified", "linked"].includes(a.status),
    ),
);
const dualLogs = [];
const prevLog = console.log;
console.log = (...args) => {
  dualLogs.push(args.map(String).join(" "));
  prevLog(...args);
};
const { logDualSessionMismatch } = await import("../netlify/functions/amare-auth-lib.mjs");
const dual = logDualSessionMismatch({
  amareUserId: continued.amare_user_id,
  mbClientId: 84521,
  reason: "continue_as_new",
});
console.log = prevLog;
check(
  "dual-session mismatch logged for amare_sess=B + mb_sess=A",
  dual.event === "dual_session_mismatch" && dualLogs.some((line) => line.includes("dual_session_mismatch")),
);

const stealMem = memoryIdentity();
const userB = (await stealMem.createUserWithIdentity({ provider: "google", provider_sub: "g-b-own", email: null })).amare_user_id;
stealMem.users.set(usrA, { amare_user_id: usrA });
stealMem.associations.push({ id: 9, amare_user_id: usrA, site_id: siteId, client_id: 84521, status: "verified" });
const steal = await finishGoogleAuthentication(
  { sub: "g-b-own", email: null, mbSessClientId: 84521, siteId },
  { identity: stealMem, searchStudioClientsByEmail: async () => [] },
);
check(
  "existing association belongs to another AMARÉ user → conflict no steal",
  steal.amare_user_id === userB && steal.claim.status === "conflict",
);

const candMem = memoryIdentity();
const candUser = await finishGoogleAuthentication(
  { sub: "g-confirm", email: null, mbSessClientId: 3001, siteId },
  { identity: candMem, searchStudioClientsByEmail: async () => [] },
);
const confirmed = await confirmAmareClaim(
  { amare_user_id: candUser.amare_user_id, explicitConfirm: true, siteId },
  { identity: candMem },
);
check("stored candidate + explicit confirm → verified", confirmed.ok && confirmed.status === "verified");

const hijack = await confirmAmareClaim(
  { amare_user_id: candUser.amare_user_id, explicitConfirm: true, displayedClientId: 99999, siteId },
  { identity: candMem },
);
check("arbitrary browser clientId cannot redirect confirmation", hijack.ok === false && hijack.error === "client_id_not_authority");

const ambRefuse = await confirmAmareClaim(
  { amare_user_id: amb.amare_user_id, explicitConfirm: true, siteId },
  { identity: ambMem },
);
check("ambiguous → confirm route must refuse", ambRefuse.ok === false);

let linkedThrew = false;
try {
  await candMem.promoteAssociationToLinked();
} catch (e) {
  linkedThrew = String(e.message) === "linked_forbidden_in_phase1";
}
check("linked still forbidden in 2A", linkedThrew);

const issued = issueGoogleAmareSession(first.amare_user_id, { "x-forwarded-proto": "https" });
const sess = unsealAmareSessPayload(issued.sealed);
check("successful Google login → fresh amare_sess", Boolean(issued?.cookie) && sess.amare_user_id === first.amare_user_id);
check("session payload { amare_user_id, at, exp }", sess && sess.at && sess.exp);
check("AMARE_SESS contains no clientId", !("client_id" in sess) && !("clientId" in sess));
check("OAuth tokens not stored in amare_sess", !("access_token" in sess) && !("id_token" in sess) && !("refresh_token" in sess));
const issued2 = issueGoogleAmareSession(first.amare_user_id, { "x-forwarded-proto": "https" });
check("re-login rotates cookie", issued.sealed !== issued2.sealed);
check("Google login works even with no Studio association", first.claim.status === "unlinked" && Boolean(issued.cookie));

const libSrc = await readFile(path.join(root, "netlify/functions/amare-auth-lib.mjs"), "utf8");
const cbSrc = await readFile(path.join(root, "netlify/functions/amare-auth-google-callback.mjs"), "utf8");
check("Google OAuth does not derive callback from SITE_URL", !/\bSITE_URL\b/.test(libSrc + cbSrc));
check(
  "OAuth tokens not logged",
  !/console\.(log|warn|error)\([^\)]*id_token/.test(libSrc + cbSrc) &&
    !/console\.(log|warn|error)\([^\)]*access_token/.test(libSrc + cbSrc) &&
    !/console\.(log|warn|error)\([^\)]*client_secret/.test(libSrc + cbSrc),
);
check("OAuth tokens not stored in identities", !/INSERT INTO amare_identities[\s\S]*access_token/.test(libSrc));
check("callback source cannot write verified", !/status:\s*"verified"/.test(cbSrc) && cbSrc.includes("finishGoogleAuthentication"));

const startHttp = await handleAmareAuthGoogleStart({
  httpMethod: "GET",
  headers: { "x-forwarded-proto": "https" },
  queryStringParameters: { return: "/classes" },
});
check("start HTTP redirects to Google", startHttp.statusCode === 302 && String(startHttp.headers.Location).includes("accounts.google.com"));

const start2 = buildGoogleStart({ returnPath: "/classes", headers: { "x-forwarded-proto": "https" } });
const cb = await handleAmareAuthGoogleCallback(
  {
    httpMethod: "GET",
    headers: { cookie: cookiePair(start2.txCookie), "x-forwarded-proto": "https" },
    queryStringParameters: { code: "auth-code", state: start2.state },
  },
  {
    siteId,
    identity: memoryIdentity(),
    searchStudioClientsByEmail: async () => [],
    exchangeGoogleAuthorizationCode: async () => ({ id_token: "idtok" }),
    verifyGoogleIdToken: async () => ({ sub: "g-http-1", email: null, emailVerified: false }),
  },
);
check("callback HTTP succeeds without Studio association", cb.statusCode === 302 && String(cb.headers.Location).includes("amare_auth=ok"));

const pendingHttp = await handleAmareAuthClaimConfirm(
  {
    httpMethod: "POST",
    headers: {
      host: "www.amarewellness.com",
      origin: "https://www.amarewellness.com",
      cookie: cookiePair(buildPendingLinkCookie(critical.pending, { "x-forwarded-proto": "https" })),
    },
    body: JSON.stringify({ claimToken: critical.pending.jti, client_id: 111, explicitConfirm: true }),
  },
  { siteId, identity: crit },
);
check("claim confirm ignores frontend client_id for pending-link", pendingHttp.statusCode === 200);

const logoutSrc = await readFile(path.join(root, "netlify/functions/amare-auth-logout.mjs"), "utf8");
check("AMARÉ logout still clears amare_sess only", logoutSrc.includes("amare_sess") && !logoutSrc.includes("mb_sess="));

const book = await readFile(path.join(root, "netlify/functions/mindbody-class-book.mjs"), "utf8");
check("class-book still resolves a Studio client", book.includes("resolveStudioCustomer") && book.includes("bookingAllowed"));
check("bookingAllowed unchanged", book.includes("bookingAllowed"));
check("consumerAssociated unchanged", book.includes("consumerAssociated"));
check("class-book does not read amare_sess", !book.includes("amare_sess"));

restoreEnv();
if (failed) {
  console.log(`\n${failed} 2A.3 Google check(s) failed`);
  process.exit(1);
}
console.log("\nAll AMARÉ 2A.3 Google QA checks passed. Real Google E2E: NOT RUN.");
