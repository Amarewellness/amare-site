/**
 * AMARÉ Auth 2B — authorization transition + member-read parity QA.
 * Run: npm run test:amare-auth-2b
 *
 * 2B member-read + authorization. Studio mutations are covered by
 * test:amare-auth-studio-ops. Does not enable production.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { newAmareUserId } from "../netlify/functions/amare-identity-policy.mjs";
import { sealCookiePayload } from "../netlify/functions/oauth-lib.mjs";
import {
  AMARE_SESS_COOKIE,
  sealAmareSessPayload,
} from "../netlify/functions/amare-sess-lib.mjs";
import { promoteAssociationToLinked } from "../netlify/functions/amare-identity-store.mjs";
import {
  amareMemberReadEnabled,
  resolveAmareStudioClient,
  studioAccessFromResolve,
} from "../netlify/functions/amare-studio-lib.mjs";
import { displayEmailFromIdentities, handleAmareAuthMemberAccess } from "../netlify/functions/amare-auth-member-access.mjs";
import { handleAmareAuthAssociationLink } from "../netlify/functions/amare-auth-association-link.mjs";
import { handleAmareAuthSession } from "../netlify/functions/amare-auth-session.mjs";

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
function restoreEnv(keys) {
  for (const k of keys) {
    if (prev[k] === undefined) delete process.env[k];
    else process.env[k] = prev[k];
  }
}

const ENV_KEYS = [
  "ENABLE_AMARE_AUTH",
  "ENABLE_AMARE_MEMBER_READ",
  "ENABLE_AMARE_STUDIO_OPERATIONS",
  "ENABLE_AMARE_SESS_ISSUE",
  "AMARE_SESSION_SECRET",
  "MINDBODY_SESSION_SECRET",
  "MINDBODY_SITE_ID",
];

const AMARE_SECRET = "qa-2b-amare-session-secret-key!!";
const MB_SECRET = "qa-2b-mindbody-session-secret!!";
const userId = newAmareUserId();
const otherUserId = newAmareUserId();

const toml = await readFile(path.join(root, "netlify.toml"), "utf8");
const envExample = await readFile(path.join(root, ".env.example"), "utf8");
const localDev = await readFile(path.join(root, "scripts/unified-local-dev.mjs"), "utf8");
const store = await readFile(path.join(root, "netlify/functions/amare-identity-store.mjs"), "utf8");
const studio = await readFile(path.join(root, "netlify/functions/amare-studio-lib.mjs"), "utf8");
const sessionFn = await readFile(path.join(root, "netlify/functions/amare-auth-session.mjs"), "utf8");
const memberAccessFn = await readFile(path.join(root, "netlify/functions/amare-auth-member-access.mjs"), "utf8");
const linkFn = await readFile(path.join(root, "netlify/functions/amare-auth-association-link.mjs"), "utf8");
const authLib = await readFile(path.join(root, "netlify/functions/amare-auth-lib.mjs"), "utf8");
const emailVerify = await readFile(path.join(root, "netlify/functions/amare-auth-email-verify.mjs"), "utf8");
const googleCb = await readFile(path.join(root, "netlify/functions/amare-auth-google-callback.mjs"), "utf8");
const mbCallback = await readFile(path.join(root, "netlify/functions/mindbody-oauth-callback.mjs"), "utf8");
const summary = await readFile(path.join(root, "netlify/functions/mindbody-member-summary.mjs"), "utf8");
const book = await readFile(path.join(root, "netlify/functions/mindbody-class-book.mjs"), "utf8");
const cancel = await readFile(path.join(root, "netlify/functions/mindbody-class-cancel.mjs"), "utf8");
const waitlist = await readFile(path.join(root, "netlify/functions/mindbody-class-waitlist-remove.mjs"), "utf8");
const classes = await readFile(path.join(root, "src/js/classes-schedule.js"), "utf8");
const member = await readFile(path.join(root, "src/js/member-dashboard.js"), "utf8");
const header = await readFile(path.join(root, "src/js/header-members.js"), "utf8");
const mbAuth = await readFile(path.join(root, "src/js/mindbody-auth.js"), "utf8");
const loginJs = await readFile(path.join(root, "src/js/amare-auth.js"), "utf8");
const stripe = await readFile(path.join(root, "src/js/stripe-express-cta.js"), "utf8");
const mobileExchange = await readFile(path.join(root, "netlify/functions/mindbody-oauth-mobile-exchange.mjs"), "utf8");

check("ENABLE_AMARE_MEMBER_READ is documented and default-off", envExample.includes("# ENABLE_AMARE_MEMBER_READ=0"));
check(
  "member-read routes are wired",
  toml.includes("/api/amare/auth/member-access") &&
    toml.includes("/api/amare/auth/association/link") &&
    localDev.includes("/api/amare/auth/member-access") &&
    localDev.includes("/api/amare/auth/association/link"),
);
check("promote requires explicitPromote", store.includes("explicitPromote") && store.includes("linked_requires_explicit_promote"));
check("promote is flag-gated", store.includes("ENABLE_AMARE_MEMBER_READ") && store.includes("linked_forbidden_in_phase1"));
check("resolver uses linked association only", studio.includes("getLinkedAssociation") && store.includes("status = 'linked'"));
check("resolver never trusts frontend clientId", studio.includes("resolveAmareStudioClient") && !studio.includes("queryStringParameters"));
check(
  "session GET still omits claimStatus and clientId",
  sessionFn.includes("signedIn: true") &&
    sessionFn.includes("amareUserId") &&
    !sessionFn.includes("claimStatus:") &&
    !sessionFn.includes('"claimStatus"') &&
    !sessionFn.includes("clientId:") &&
    !sessionFn.includes('"clientId"'),
);
check("member-access omits clientId", memberAccessFn.includes("studioAccess") && !memberAccessFn.includes("clientId:") && !memberAccessFn.includes('"clientId"'));
check("member-access can return display email", memberAccessFn.includes("displayEmailFromIdentities") && memberAccessFn.includes("email"));
check(
  "display email prefers Email identity and ignores Mindbody sub",
  displayEmailFromIdentities([
    { provider: "mindbody", provider_sub: "24400320", email: null },
    { provider: "email", provider_sub: "Ada@Example.com", email: "Ada@Example.com" },
  ]) === "ada@example.com",
);
check(
  "display email does not invent a match from Mindbody sub",
  displayEmailFromIdentities([{ provider: "mindbody", provider_sub: "24400320" }]) === null,
);
check("association/link rejects body clientId", linkFn.includes("client_id_not_authority") && linkFn.includes("explicitPromote"));
check("login/verify do not write linked", !emailVerify.includes("promoteAssociationToLinked") && !googleCb.includes("promoteAssociationToLinked"));
check("Mindbody callback does not write linked", !mbCallback.includes("promoteAssociationToLinked"));
check("claim confirm may promote only after explicit confirm", authLib.includes("maybePromoteLinkedAfterConfirm") && authLib.includes("explicitPromote: true"));
check("member summary has dual-session conflict", summary.includes("session_conflict") && summary.includes("resolveAmareStudioClient"));
check("member summary reuses existing client fetches", summary.includes("clientservices") && summary.includes("activeclientmemberships") && summary.includes("clientaccountbalances"));
check("class-book does not read amare_sess", !book.includes("amare_sess") && !book.includes("resolveAmareStudioClient"));
check("class-cancel does not read amare_sess", !cancel.includes("amare_sess") && !cancel.includes("resolveAmareStudioClient"));
check("waitlist-remove does not read amare_sess", !waitlist.includes("amare_sess") && !waitlist.includes("resolveAmareStudioClient"));
check("classes Book dialog still uses Mindbody", classes.includes("Sign in with Mindbody") && classes.includes("oauthLoggedIn"));
check("classes member-read does not set oauthLoggedIn from AMARÉ", classes.includes("amareStudioReadAuthorized") && classes.includes("memberReadActive"));
check("classes mutations use studioOpsActive", classes.includes("function studioOpsActive") && classes.includes("const isEnrolled = studioOpsActive() && visitForCancel != null") && classes.includes("const onWaitlist = studioOpsActive() && waitlistEntryForLeave != null"));
check("member dashboard Cancel uses mutationAuthorized", member.includes("mutationAuthorized") && member.includes("studioOperations") && member.includes("/api/mindbody/class/cancel"));
check("header general signed-in is amare_sess", header.includes("/api/amare/auth/session") && header.includes("member-access"));
check("Mindbody fallback remains", mbAuth.includes("Sign in with Mindbody") && mbAuth.includes("/api/mindbody/oauth/start") && loginJs.includes("/api/mindbody/oauth/start"));
check("linked strip does not look logged out", mbAuth.includes("Signed in to AMARÉ") && mbAuth.includes("renderAmareLinked"));
check("Stripe express CTA does not use member-access as purchase authority", !stripe.includes("/api/amare/auth/member-access"));
check("Stripe express CTA reads provider-neutral commerce status", stripe.includes("/api/amare/commerce/status"));
check("mobile exchange unchanged by 2B", !mobileExchange.includes("ENABLE_AMARE_MEMBER_READ") && !mobileExchange.includes("resolveAmareStudioClient"));

delete process.env.ENABLE_AMARE_AUTH;
delete process.env.ENABLE_AMARE_MEMBER_READ;
delete process.env.ENABLE_AMARE_STUDIO_OPERATIONS;
check("ENABLE_AMARE_MEMBER_READ default off", amareMemberReadEnabled() === false);

let flagOffThrew = false;
try {
  await promoteAssociationToLinked({ amare_user_id: userId, site_id: "amare-qa-phase1", explicitPromote: true });
} catch (err) {
  flagOffThrew = String(err.message) === "linked_forbidden_in_phase1";
}
check("promote stays forbidden when member-read flag is off", flagOffThrew);

process.env.ENABLE_AMARE_AUTH = "1";
process.env.ENABLE_AMARE_SESS_ISSUE = "1";
process.env.AMARE_SESSION_SECRET = AMARE_SECRET;
process.env.MINDBODY_SESSION_SECRET = MB_SECRET;
process.env.MINDBODY_SITE_ID = "12345";
delete process.env.ENABLE_AMARE_MEMBER_READ;
delete process.env.ENABLE_AMARE_STUDIO_OPERATIONS;

const sealed = sealAmareSessPayload({ amare_user_id: userId });
const cookie = `${AMARE_SESS_COOKIE}=${encodeURIComponent(sealed)}`;
const findUser = async (id) => (id === userId || id === otherUserId ? { amare_user_id: id } : null);

const flagOffResolve = await resolveAmareStudioClient({ headers: { cookie } }, {
  findUser,
  getLinkedAssociation: async () => ({ status: "linked", client_id: 84521 }),
});
check("resolver flag-off does not return clientId", flagOffResolve.ok === false && flagOffResolve.reason === "flag_off" && flagOffResolve.clientId == null);

const accessFlagOff = await handleAmareAuthMemberAccess(
  { httpMethod: "GET", headers: { cookie } },
  { findUser },
);
const accessFlagOffBody = JSON.parse(accessFlagOff.body);
check(
  "member-access with auth on and member-read off: signed in, studioAccess none",
  accessFlagOff.statusCode === 200 &&
    accessFlagOffBody.signedIn === true &&
    accessFlagOffBody.studioAccess === "none" &&
    !("clientId" in accessFlagOffBody) &&
    !("client_id" in accessFlagOffBody),
);

const disabledAccess = await handleAmareAuthMemberAccess({ httpMethod: "GET", headers: {} });
delete process.env.ENABLE_AMARE_AUTH;
const disabledAccessOff = await handleAmareAuthMemberAccess({ httpMethod: "GET", headers: {} });
process.env.ENABLE_AMARE_AUTH = "1";
check("member-access disabled when master flag is off", disabledAccessOff.statusCode === 404);

const signedOutAccess = await handleAmareAuthMemberAccess({ httpMethod: "GET", headers: {} });
check("member-access signed out", signedOutAccess.statusCode === 200 && JSON.parse(signedOutAccess.body).signedIn === false);

process.env.ENABLE_AMARE_MEMBER_READ = "1";
check("member-read requires master flag", amareMemberReadEnabled() === true);

const resolved = await resolveAmareStudioClient({ headers: { cookie } }, {
  findUser,
  getLinkedAssociation: async () => ({ status: "linked", client_id: 84521 }),
  getLatestAssociation: async () => ({ status: "linked", client_id: 84521 }),
});
check("resolver returns internal clientId from linked association", resolved.ok === true && resolved.clientId === 84521 && resolved.amareUserId === userId);

const verifiedOnly = await resolveAmareStudioClient({ headers: { cookie } }, {
  findUser,
  getLinkedAssociation: async () => null,
  getLatestAssociation: async () => ({ status: "verified", client_id: 84521 }),
});
check(
  "verified is not authorized for member-read",
  verifiedOnly.ok === false && verifiedOnly.reason === "verified_pending_link" && verifiedOnly.clientId == null,
);

const noAssoc = await resolveAmareStudioClient({ headers: { cookie } }, {
  findUser,
  getLinkedAssociation: async () => null,
  getLatestAssociation: async () => null,
});
check("no association is not authorized", noAssoc.ok === false && noAssoc.reason === "not_authorized" && noAssoc.clientId == null);

const mbAlign = sealCookiePayload({ client_id: 84521, at: Date.now() }, MB_SECRET);
const aligned = await resolveAmareStudioClient(
  { headers: { cookie: `${cookie}; mb_sess=${encodeURIComponent(mbAlign)}` } },
  {
    findUser,
    getLinkedAssociation: async () => ({ status: "linked", client_id: 84521 }),
  },
);
check("dual session same clientId aligns", aligned.ok === true && aligned.clientId === 84521);

const mbConflict = sealCookiePayload({ client_id: 99999, at: Date.now() }, MB_SECRET);
const conflicted = await resolveAmareStudioClient(
  { headers: { cookie: `${cookie}; mb_sess=${encodeURIComponent(mbConflict)}` } },
  {
    findUser,
    getLinkedAssociation: async () => ({ status: "linked", client_id: 84521 }),
  },
);
check(
  "dual session different clientId conflicts and hides clientId",
  conflicted.ok === false && conflicted.reason === "session_conflict" && conflicted.clientId == null,
);

const accessLinked = await handleAmareAuthMemberAccess(
  { httpMethod: "GET", headers: { cookie } },
  {
    findUser,
    getLinkedAssociation: async () => ({ status: "linked", client_id: 84521 }),
    getLatestAssociation: async () => ({ status: "linked", client_id: 84521 }),
    listIdentities: async () => [{ provider: "email", provider_sub: "qa@example.com", email: "qa@example.com" }],
  },
);
const accessLinkedBody = JSON.parse(accessLinked.body);
check(
  "member-access linked omits clientId",
  accessLinked.statusCode === 200 &&
    accessLinkedBody.signedIn === true &&
    accessLinkedBody.studioAccess === "linked" &&
    !("clientId" in accessLinkedBody) &&
    !("client_id" in accessLinkedBody) &&
    !("amareUserId" in accessLinkedBody),
);
check(
  "member-access linked includes display email",
  accessLinkedBody.email === "qa@example.com",
);
check("studioAccessFromResolve linked", studioAccessFromResolve(resolved) === "linked");
check("studioAccessFromResolve conflict", studioAccessFromResolve(conflicted) === "conflict");

const sessionBody = JSON.parse(
  (
    await handleAmareAuthSession(
      { httpMethod: "GET", headers: { cookie } },
      { findUser },
    )
  ).body,
);
check(
  "session GET still has no clientId or studioAccess",
  sessionBody.signedIn === true &&
    sessionBody.amareUserId === userId &&
    !("clientId" in sessionBody) &&
    !("studioAccess" in sessionBody) &&
    !("claimStatus" in sessionBody),
);

const linkDisabled = await handleAmareAuthAssociationLink({
  httpMethod: "POST",
  headers: { cookie, host: "127.0.0.1:4321" },
  body: JSON.stringify({ explicitPromote: true, clientId: 84521 }),
});
check("association/link rejects frontend clientId", linkDisabled.statusCode === 400 && JSON.parse(linkDisabled.body).error === "client_id_not_authority");

const linkNoExplicit = await handleAmareAuthAssociationLink({
  httpMethod: "POST",
  headers: { cookie, host: "127.0.0.1:4321" },
  body: JSON.stringify({}),
});
check("association/link requires explicitPromote", linkNoExplicit.statusCode === 400 && JSON.parse(linkNoExplicit.body).error === "explicit_promote_required");

delete process.env.ENABLE_AMARE_MEMBER_READ;
const linkFlagOff = await handleAmareAuthAssociationLink({
  httpMethod: "POST",
  headers: { cookie, host: "127.0.0.1:4321" },
  body: JSON.stringify({ explicitPromote: true }),
});
check("association/link disabled when member-read is off", linkFlagOff.statusCode === 404);

delete process.env.ENABLE_AMARE_AUTH;
const accessMasterOff = await handleAmareAuthMemberAccess({ httpMethod: "GET", headers: { cookie } });
check("rollback: master flag off hides member-access", accessMasterOff.statusCode === 404);
void disabledAccess;

restoreEnv(ENV_KEYS);

if (failed) {
  console.error(`\n${failed} AMARÉ 2B QA check(s) failed.`);
  process.exit(1);
}
console.log("\nAll AMARÉ 2B authorization / member-read QA checks passed.");
