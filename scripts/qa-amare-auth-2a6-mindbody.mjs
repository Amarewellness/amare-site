/**
 * AMARÉ Auth 2A.6 Mindbody legacy identity bridge QA.
 * Run: npm run test:amare-auth-2a6
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { newAmareUserId } from "../netlify/functions/amare-identity-policy.mjs";
import { signState } from "../netlify/functions/oauth-lib.mjs";
import {
  applyMindbodyLegacyBridge,
  confirmAmareClaim,
  finishEmailAuthentication,
  finishMindbodyAuthentication,
  mindbodyBridgeEnabled,
  usableMindbodyOidcSub,
} from "../netlify/functions/amare-auth-lib.mjs";
import { handleMindbodyOAuthCallback } from "../netlify/functions/mindbody-oauth-callback.mjs";
import { unsealAmareSessPayload } from "../netlify/functions/amare-sess-lib.mjs";
import { unsealCookiePayload } from "../netlify/functions/oauth-lib.mjs";

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
  for (const k of [
    "ENABLE_AMARE_AUTH",
    "ENABLE_AMARE_AUTH_MINDBODY_BRIDGE",
    "ENABLE_AMARE_SESS_ISSUE",
    "AMARE_SESSION_SECRET",
    "MINDBODY_SESSION_SECRET",
    "MINDBODY_SITE_ID",
  ]) {
    if (prev[k] === undefined) delete process.env[k];
    else process.env[k] = prev[k];
  }
}

function memoryIdentity() {
  const users = new Map();
  const identities = [];
  const associations = [];
  let assocId = 1;
  let writes = 0;
  return {
    users,
    identities,
    associations,
    get writes() {
      return writes;
    },
    async findIdentity(provider, sub) {
      return identities.find((i) => i.provider === provider && i.provider_sub === sub) || null;
    },
    async listIdentities(amareUserId) {
      return identities.filter((i) => i.amare_user_id === amareUserId);
    },
    async createUserWithIdentity({ provider, provider_sub, email, email_verified }) {
      writes += 1;
      const amare_user_id = newAmareUserId();
      users.set(amare_user_id, { amare_user_id });
      identities.push({ amare_user_id, provider, provider_sub, email: email || null, email_verified: !!email_verified });
      return { amare_user_id, provider, provider_sub };
    },
    async attachIdentity({ amare_user_id, provider, provider_sub, email, email_verified }) {
      writes += 1;
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
    async getLatestAssociation(amareUserId, siteId) {
      const rows = associations.filter((a) => a.amare_user_id === amareUserId && a.site_id === siteId);
      return rows[rows.length - 1] || null;
    },
    async getCandidateAssociation(amareUserId, siteId) {
      const rows = associations.filter((a) => a.amare_user_id === amareUserId && a.site_id === siteId && a.status === "candidate");
      return rows[rows.length - 1] || null;
    },
    async proposeAssociation(input) {
      writes += 1;
      if (input.status === "verified" || input.status === "linked") throw new Error("propose_cannot_write_verified");
      associations.push({ id: assocId++, ...input, client_id: input.client_id ?? null });
    },
    async confirmAssociation(input) {
      writes += 1;
      if (input.explicitConfirm !== true) throw new Error("verified_requires_explicit_confirm");
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

delete process.env.ENABLE_AMARE_AUTH;
delete process.env.ENABLE_AMARE_AUTH_MINDBODY_BRIDGE;
check("bridge requires master + Mindbody bridge flags", mindbodyBridgeEnabled() === false);

process.env.ENABLE_AMARE_AUTH = "1";
process.env.ENABLE_AMARE_AUTH_MINDBODY_BRIDGE = "1";
process.env.ENABLE_AMARE_SESS_ISSUE = "1";
process.env.AMARE_SESSION_SECRET = "qa-2a6-amare-session-secret-key!!";
process.env.MINDBODY_SESSION_SECRET = "qa-2a6-mindbody-session-secret!!";
process.env.MINDBODY_SITE_ID = "amare-qa-2a6";
const siteId = "amare-qa-2a6";

check("valid Mindbody sub accepted as opaque identity key", usableMindbodyOidcSub("  M123-opaque  ") === "M123-opaque");
check("numeric-looking Mindbody sub is still a sub", usableMindbodyOidcSub("24400320") === "24400320");
check("missing sub creates no key", usableMindbodyOidcSub("") === null && usableMindbodyOidcSub(null) === null);

const missingIdent = memoryIdentity();
const missing = await finishMindbodyAuthentication(
  { sub: "", email: "x@example.com", mbSessClientId: 84521, siteId },
  { identity: missingIdent, searchStudioClientsByEmail: async () => [] },
);
check("missing sub creates no Mindbody identity", missing.outcome === "sub_missing" && missingIdent.identities.length === 0 && missingIdent.users.size === 0);
check("missing sub does not invent provider_sub", missingIdent.identities.every((i) => i.provider_sub !== "84521" && i.provider_sub !== "x@example.com"));

const src = await readFile(path.join(root, "netlify/functions/amare-auth-lib.mjs"), "utf8");
const cbSrc = await readFile(path.join(root, "netlify/functions/mindbody-oauth-callback.mjs"), "utf8");
const buildSrc = await readFile(path.join(root, "netlify/functions/mindbody-oauth-session-build.mjs"), "utf8");
const mobileSrc = await readFile(path.join(root, "netlify/functions/mindbody-oauth-mobile-exchange.mjs"), "utf8");
check("no clientId/email/phone fallback for provider_sub", !/provider_sub:\s*input\.(email|clientId|phone)/.test(src) && src.includes("usableMindbodyOidcSub"));
check("bridge is web-callback specific", cbSrc.includes("applyMindbodyLegacyBridge") && !buildSrc.includes("amare-auth-lib") && !mobileSrc.includes("amare-auth-lib"));

const firstIdent = memoryIdentity();
const first = await finishMindbodyAuthentication(
  { sub: "mb-sub-first", email: "first@example.com", mbSessClientId: null, siteId },
  { identity: firstIdent, searchStudioClientsByEmail: async () => [] },
);
check("first Mindbody identity creates/resolves one amare_user", first.createdUser === true && firstIdent.users.size === 1 && firstIdent.identities.length === 1);
check("identity is provider=mindbody + OIDC sub", firstIdent.identities[0].provider === "mindbody" && firstIdent.identities[0].provider_sub === "mb-sub-first");
check("auth creation automatically creates zero verified Studio associations", !firstIdent.associations.some((a) => a.status === "verified" || a.status === "linked"));
check("no Studio match → unlinked", first.claim.status === "unlinked");

const second = await finishMindbodyAuthentication(
  { sub: "mb-sub-first", email: "first@example.com", mbSessClientId: null, siteId },
  { identity: firstIdent, searchStudioClientsByEmail: async () => [] },
);
check("second login resolves same amare_user", second.amare_user_id === first.amare_user_id && firstIdent.users.size === 1);
check("no duplicate Mindbody identity", firstIdent.identities.filter((i) => i.provider === "mindbody").length === 1);

const withClient = memoryIdentity();
const createdWithClient = await finishMindbodyAuthentication(
  { sub: "mb-sub-client", email: "c@example.com", mbSessClientId: 9001, siteId },
  { identity: withClient, searchStudioClientsByEmail: async () => [] },
);
check("new Mindbody user + clientId is candidate not verified", createdWithClient.claim.status === "candidate" && createdWithClient.claim.clientId === 9001 && createdWithClient.claim.autoBind === false);
check("callback cannot write linked", !withClient.associations.some((a) => a.status === "linked" || a.status === "verified"));

const emailIdent = memoryIdentity();
const emailUser = await finishEmailAuthentication(
  { email: "jane@example.com", mbSessClientId: null, siteId },
  { identity: emailIdent, searchStudioClientsByEmail: async () => [] },
);
const emailMerge = await finishMindbodyAuthentication(
  { sub: "mb-sub-other", email: "jane@example.com", mbSessClientId: null, siteId },
  { identity: emailIdent, searchStudioClientsByEmail: async () => [] },
);
check(
  "email equality alone does not merge users",
  emailMerge.amare_user_id !== emailUser.amare_user_id &&
    emailIdent.users.size === 2 &&
    emailIdent.identities.some((i) => i.provider === "email") &&
    emailIdent.identities.some((i) => i.provider === "mindbody" && i.amare_user_id === emailMerge.amare_user_id),
);

const owned = memoryIdentity();
const usrA = newAmareUserId();
owned.users.set(usrA, { amare_user_id: usrA });
owned.identities.push({ amare_user_id: usrA, provider: "email", provider_sub: "owner@example.com" });
owned.associations.push({ id: 1, amare_user_id: usrA, site_id: siteId, client_id: 84521, status: "verified" });
const pend = await finishMindbodyAuthentication(
  { sub: "NEW_SUB", email: "owner@example.com", mbSessClientId: 84521, siteId },
  { identity: owned, searchStudioClientsByEmail: async () => [] },
);
check("existing client owned by usr_A does not create usr_B", pend.outcome === "pending_attach" && owned.users.size === 1 && !owned.identities.some((i) => i.provider === "mindbody"));
check("existing client owner requires explicit link confirmation", pend.pending?.target_amare_user_id === usrA && pend.pending?.provider === "mindbody");

const attached = await confirmAmareClaim(
  { pending: pend.pending, explicitConfirm: true, siteId },
  { identity: owned },
);
check(
  "Email OTP user + Mindbody identity can resolve to same user safely",
  attached.ok &&
    attached.amare_user_id === usrA &&
    owned.identities.some((i) => i.provider === "email" && i.amare_user_id === usrA) &&
    owned.identities.some((i) => i.provider === "mindbody" && i.provider_sub === "NEW_SUB" && i.amare_user_id === usrA),
);

const shared = memoryIdentity();
const usrB = newAmareUserId();
shared.users.set(usrA, { amare_user_id: usrA });
shared.users.set(usrB, { amare_user_id: usrB });
shared.identities.push({ amare_user_id: usrB, provider: "email", provider_sub: "person-b@example.com" });
shared.associations.push({ id: 1, amare_user_id: usrA, site_id: siteId, client_id: 111, status: "verified" });
const sharedPend = await finishMindbodyAuthentication(
  { sub: "person-a-sub", email: "person-a@example.com", mbSessClientId: 111, siteId },
  { identity: shared, searchStudioClientsByEmail: async () => [] },
);
check(
  "shared-computer mismatch protected",
  sharedPend.outcome === "pending_attach" &&
    sharedPend.pending.target_amare_user_id === usrA &&
    !shared.identities.some((i) => i.provider === "mindbody") &&
    shared.identities.filter((i) => i.amare_user_id === usrB).length === 1,
);

let linkedThrew = false;
try {
  await firstIdent.promoteAssociationToLinked();
} catch (err) {
  linkedThrew = String(err.message) === "linked_forbidden_in_phase1";
}
check("linked still forbidden", linkedThrew);

const issued = await applyMindbodyLegacyBridge(
  { sub: "mb-sub-first", email: "first@example.com", mbSessClientId: null, headers: { "x-forwarded-proto": "https" }, siteId },
  { identity: firstIdent, searchStudioClientsByEmail: async () => [] },
);
const sessCookie = issued.cookies.find((c) => c.startsWith("amare_sess="));
const sealed = sessCookie ? decodeURIComponent(sessCookie.split(";")[0].slice("amare_sess=".length)) : "";
const sess = sealed ? unsealAmareSessPayload(sealed) : null;
check("amare_sess uses 2A.2 core", Boolean(sessCookie) && sess?.amare_user_id === first.amare_user_id);
check("amare_sess contains no clientId", sess && !("client_id" in sess) && !("clientId" in sess) && !("access_token" in sess));

delete process.env.ENABLE_AMARE_AUTH_MINDBODY_BRIDGE;
const offIdent = memoryIdentity();
const off = await applyMindbodyLegacyBridge(
  { sub: "should-not-write", email: "off@example.com", mbSessClientId: 1, siteId },
  { identity: offIdent, searchStudioClientsByEmail: async () => [] },
);
check("bridge OFF causes no AMARÉ identity writes", off.applied === false && offIdent.writes === 0 && offIdent.users.size === 0);

process.env.ENABLE_AMARE_AUTH_MINDBODY_BRIDGE = "1";
const state = signState({ return: "/classes", platform: "web", exp: Date.now() + 10 * 60 * 1000 }, process.env.MINDBODY_SESSION_SECRET);
const sessionPayload = {
  sub: "mb-http-sub",
  email: "http@example.com",
  name: "Http",
  client_id: null,
  client_exists: false,
  consumer_associated: false,
  booking_allowed: false,
  link_status: "not_associated",
  access_token: "tok",
  refresh_token: "ref",
  at: Date.now(),
};
const httpIdent = memoryIdentity();
const httpOn = await handleMindbodyOAuthCallback(
  { httpMethod: "GET", headers: {}, queryStringParameters: { code: "abc", state } },
  {
    exchangeAuthorizationCode: async () => ({ access_token: "tok", refresh_token: "ref" }),
    buildSessionPayloadFromOAuthTokens: async () => sessionPayload,
    identity: httpIdent,
    searchStudioClientsByEmail: async () => [],
  },
);
const onCookies = [httpOn.headers?.["Set-Cookie"], ...(httpOn.multiValueHeaders?.["Set-Cookie"] || [])].flat().filter(Boolean);
check("web callback still sets mb_sess", onCookies.some((c) => String(c).startsWith("mb_sess=")));
const mbSealed = decodeURIComponent(String(onCookies.find((c) => String(c).startsWith("mb_sess="))).split(";")[0].slice("mb_sess=".length));
const mbPayload = unsealCookiePayload(mbSealed, process.env.MINDBODY_SESSION_SECRET);
check("mb_sess remains unchanged", mbPayload.sub === "mb-http-sub" && mbPayload.client_id == null && mbPayload.access_token === "tok");
check("HTTP first Mindbody login created one user", httpIdent.users.size === 1 && httpIdent.identities[0].provider === "mindbody");

delete process.env.ENABLE_AMARE_AUTH_MINDBODY_BRIDGE;
const offHttpIdent = memoryIdentity();
const httpOff = await handleMindbodyOAuthCallback(
  { httpMethod: "GET", headers: {}, queryStringParameters: { code: "abc", state } },
  {
    exchangeAuthorizationCode: async () => ({ access_token: "tok", refresh_token: "ref" }),
    buildSessionPayloadFromOAuthTokens: async () => sessionPayload,
    identity: offHttpIdent,
    searchStudioClientsByEmail: async () => [],
  },
);
check(
  "bridge OFF callback is legacy Set-Cookie mb_sess only",
  httpOff.statusCode === 302 &&
    httpOff.headers.Location === "/classes" &&
    String(httpOff.headers["Set-Cookie"] || "").startsWith("mb_sess=") &&
    !httpOff.multiValueHeaders &&
    offHttpIdent.writes === 0,
);

const book = await readFile(path.join(root, "netlify/functions/mindbody-class-book.mjs"), "utf8");
const consumer = await readFile(path.join(root, "netlify/functions/mindbody-consumer-lib.mjs"), "utf8");
const sessionSrc = await readFile(path.join(root, "netlify/functions/mindbody-oauth-session.mjs"), "utf8");
check("bookingAllowed unchanged", book.includes("bookingAllowed"));
check("consumerAssociated unchanged", book.includes("consumerAssociated") && consumer.includes("resolveConsumerClient"));
check("class-book does not read amare_sess", !book.includes("amare_sess"));
check("oauth session still returns authenticated/clientId/bookingAllowed", sessionSrc.includes("bookingAllowed") || sessionSrc.includes("booking_allowed"));
check("Google start/callback retained", (await readFile(path.join(root, "netlify/functions/amare-auth-google-start.mjs"), "utf8")).includes("buildGoogleStart"));
check("Email OTP routes retained", (await readFile(path.join(root, "netlify/functions/amare-auth-email-request.mjs"), "utf8")).includes("request-code"));

restore();
if (failed) {
  console.error(`\n${failed} AMARÉ 2A.6 Mindbody bridge QA check(s) failed.`);
  process.exit(1);
}
console.log("\nAll AMARÉ 2A.6 Mindbody bridge QA checks passed.");
