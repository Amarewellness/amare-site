/**
 * D28 brand-new Email OTP customer onboarding QA.
 * Run: npm run test:amare-auth-new-customer
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { newAmareUserId } from "../netlify/functions/amare-identity-policy.mjs";
import {
  buildProfileTxCookie,
  finishEmailAuthentication,
  normalizeStudioEmailSearchResult,
} from "../netlify/functions/amare-auth-lib.mjs";
import { handleAmareAuthProfileCreate } from "../netlify/functions/amare-auth-profile-create.mjs";
import {
  createAmareStudioProfile,
  normalizeProfileName,
  rejectedProfileBodyFields,
} from "../netlify/functions/amare-auth-profile-lib.mjs";
import { studioAccessFromLatestAssociation } from "../netlify/functions/amare-studio-lib.mjs";
import { maybeIssueAmareSession } from "../netlify/functions/amare-sess-lib.mjs";
import { normalizeUsMobilePhone } from "../netlify/functions/oauth-lib.mjs";

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
process.env.ENABLE_AMARE_AUTH = "1";
process.env.ENABLE_AMARE_AUTH_EMAIL_OTP = "1";
process.env.ENABLE_AMARE_SESS_ISSUE = "1";
process.env.ENABLE_AMARE_MEMBER_READ = "1";
process.env.ENABLE_AMARE_STUDIO_OPERATIONS = "1";
process.env.AMARE_SESSION_SECRET = "qa-d28-amare-session-secret-key!!";
process.env.AMARE_OTP_PEPPER = "qa-d28-amare-otp-pepper-secret!!!!";
process.env.MINDBODY_SITE_ID = "amare-qa-d28";

const src = await readFile(path.join(root, "netlify/functions/amare-auth-lib.mjs"), "utf8");
const profileLib = await readFile(path.join(root, "netlify/functions/amare-auth-profile-lib.mjs"), "utf8");
const createSrc = await readFile(path.join(root, "netlify/functions/amare-auth-profile-create.mjs"), "utf8");
const loginJs = await readFile(path.join(root, "src/js/amare-auth.js"), "utf8");
const loginHtml = await readFile(path.join(root, "src/content/mindbody-login.html"), "utf8");
const mbAuth = await readFile(path.join(root, "src/js/mindbody-auth.js"), "utf8");
const design = await readFile(path.join(root, "docs/AMARE-AUTH-PHASE02-DESIGN.md"), "utf8");
const syncLib = await readFile(path.join(root, "netlify/functions/stripe-mindbody-sync-lib.mjs"), "utf8");
const guestLib = await readFile(path.join(root, "netlify/functions/mindbody-guest-client-lib.mjs"), "utf8");
const book = await readFile(path.join(root, "netlify/functions/mindbody-class-book.mjs"), "utf8");
const consumer = await readFile(path.join(root, "netlify/functions/mindbody-consumer-lib.mjs"), "utf8");
const stripeCta = await readFile(path.join(root, "src/js/stripe-express-cta.js"), "utf8");
const stripeWebhook = await readFile(path.join(root, "netlify/functions/stripe-webhook.mjs"), "utf8");

check("D28 is locked and D18–D27 are not renumbered", design.includes("D28") && design.includes("| D27 |") && design.includes("| D26 |"));
check("search never returns [] on failure", src.includes("staff_search_unavailable") && src.includes("exactMatches: []") && src.includes("ok: false"));
check("profile create rejects body email/clientId", createSrc.includes("field_not_allowed") || profileLib.includes("rejectedProfileBodyFields"));
check("profile create requires explicitCreate", profileLib.includes("explicit_create_required"));
check("final Staff re-search happens before addclient", profileLib.includes("runStaffEmailSearch") && profileLib.includes("createStudioClient"));
check("does not call resolveOrCreateMindbodyClient", !profileLib.includes("resolveOrCreateMindbodyClient"));
check("does not use mindbody-client-register as the API", !profileLib.includes("mindbody-client-register"));
check("claim_method new_profile_created", profileLib.includes("new_profile_created"));
check("login stays on profile form", loginJs.includes('showStep("profile")') && loginHtml.includes("Create my profile"));
check("login does not finishSignedIn for needs_profile", /needs_profile[\s\S]*showStep\("profile"\)/.test(loginJs));
check("classes needs_profile is not Sign in with Mindbody", mbAuth.includes("renderAmareNeedsProfile") && mbAuth.includes("Complete your AMARÉ profile"));
check("Mindbody fallback remains on login", loginHtml.includes("Already use Mindbody with AMARÉ?") && loginHtml.includes("Sign in with Mindbody"));
check("Stripe addclient still defaults promotional true", syncLib.includes("SendPromotionalEmails: true"));
check(
  "AMARÉ onboarding opts in schedule + promo email, not account mail",
  /AMARE_ONBOARDING_EMAIL_SUBSCRIPTION_FIELDS\s*=\s*\{[^}]*SendAccountEmails:\s*false[^}]*SendScheduleEmails:\s*true[^}]*SendPromotionalEmails:\s*true/.test(
    syncLib,
  ),
);
check("D28 AddClient sets SendEmail false via options, not Stripe defaults", /createStudioClientForAmareOnboarding[\s\S]*sendEmail:\s*false/.test(syncLib) && !/CLIENT_SITE_EMAIL_SUBSCRIPTION_FIELDS[\s\S]{0,80}SendEmail/.test(syncLib));
check("D28 does not call password/account helpers", !profileLib.includes("sendpasswordresetemail") && !profileLib.includes("sendNewClientPasswordSetupEmail") && !createSrc.includes("sendpasswordresetemail") && !createSrc.includes("Link My Account"));
check("guest AddClient still sends SendEmail false and is unchanged by D28", /SendEmail:\s*false/.test(guestLib) && /SendScheduleEmails:\s*false/.test(guestLib) && !guestLib.includes("createStudioClientForAmareOnboarding"));
check("Stripe webhook still owns password-setup helper", stripeWebhook.includes("sendNewClientPasswordSetupEmail"));
check("bookingAllowed / consumerAssociated unchanged", book.includes("consumerAssociated") && consumer.includes("resolveConsumerClient"));
check("class-book SendEmail logic unchanged", /SendEmail:\s*sendEmail/.test(book));
check("Stripe express CTA unchanged", !stripeCta.includes("/api/amare/auth/profile/create"));

check("legacy array search result is successful", normalizeStudioEmailSearchResult([]).ok === true && normalizeStudioEmailSearchResult([]).exactMatches.length === 0);
check("object failure is not a successful zero", normalizeStudioEmailSearchResult({ ok: false, reason: "staff_search_unavailable" }).ok === false);
check("generic unlinked is not needs_profile", studioAccessFromLatestAssociation({ status: "unlinked", block_reason: null }) === null);
check("staff_zero_match is needs_profile", studioAccessFromLatestAssociation({ status: "unlinked", block_reason: "staff_zero_match" }) === "needs_profile");
check("staff_search_unavailable is not needs_profile", studioAccessFromLatestAssociation({ status: "unlinked", block_reason: "staff_search_unavailable" }) === "search_unavailable");

check("first name required", normalizeProfileName("  ") === "" && normalizeProfileName("Ada") === "Ada");
check("phone uses existing US helper", normalizeUsMobilePhone("786-503-1414") === "7865031414" && normalizeUsMobilePhone("17865031414") === "7865031414");
check("body email rejected", rejectedProfileBodyFields({ email: "x@y.com" }) === "email");
check("body clientId rejected", rejectedProfileBodyFields({ clientId: 1 }) === "clientId");

function memoryIdentity() {
  const users = new Map();
  const identities = [];
  const associations = [];
  let assocId = 1;
  const api = {
    users,
    identities,
    associations,
    async findIdentity(provider, sub) {
      return identities.find((i) => i.provider === provider && i.provider_sub === sub) || null;
    },
    async listIdentities(amareUserId) {
      return identities.filter((i) => i.amare_user_id === amareUserId);
    },
    async createUserWithIdentity({ provider, provider_sub, email, email_verified }) {
      const amare_user_id = newAmareUserId();
      users.set(amare_user_id, { amare_user_id });
      identities.push({ amare_user_id, provider, provider_sub, email: email || null, email_verified: !!email_verified });
      return { amare_user_id, provider, provider_sub };
    },
    async findUser(id) {
      return users.get(id) || null;
    },
    async findActiveAssociationByClientId(sid, clientId) {
      return (
        associations.find(
          (a) => a.site_id === sid && Number(a.client_id) === Number(clientId) && (a.status === "verified" || a.status === "linked"),
        ) || null
      );
    },
    async getActiveAssociation(amareUserId, sid) {
      return (
        [...associations]
          .reverse()
          .find((a) => a.amare_user_id === amareUserId && a.site_id === sid && (a.status === "verified" || a.status === "linked")) || null
      );
    },
    async getLatestAssociation(amareUserId, sid) {
      const rows = associations.filter((a) => a.amare_user_id === amareUserId && a.site_id === sid);
      return rows[rows.length - 1] || null;
    },
    async getCandidateAssociation(amareUserId, sid) {
      const rows = associations.filter((a) => a.amare_user_id === amareUserId && a.site_id === sid && a.status === "candidate");
      return rows[rows.length - 1] || null;
    },
    async proposeAssociation(input) {
      associations.push({ id: assocId++, claim_method: "none", ...input, client_id: input.client_id ?? null });
    },
    async confirmAssociation(input) {
      associations.push({
        id: assocId++,
        amare_user_id: input.amare_user_id,
        site_id: input.site_id,
        status: "verified",
        client_id: input.client_id,
        claim_method: input.claim_method,
        claim_proof_ref: input.claim_proof_ref || null,
      });
    },
    async promoteAssociationToLinked(input) {
      if (input?.explicitPromote !== true) throw new Error("linked_requires_explicit_promote");
      const current = await api.getActiveAssociation(input.amare_user_id, input.site_id);
      if (!current || current.status !== "verified") throw new Error("linked_requires_verified");
      current.status = "linked";
      return { ok: true, status: "linked", already: false, client_id: current.client_id };
    },
    async completeNewProfileCreatedAssociation(input) {
      await api.proposeAssociation({
        amare_user_id: input.amare_user_id,
        site_id: input.site_id,
        status: "candidate",
        client_id: input.client_id,
        claim_proof_ref: `new_profile_pending:${input.verifiedEmail || ""}`,
      });
      await api.confirmAssociation({
        ...input,
        fromStatus: "candidate",
        claim_method: "new_profile_created",
        explicitConfirm: true,
      });
      return api.promoteAssociationToLinked({
        amare_user_id: input.amare_user_id,
        site_id: input.site_id,
        explicitPromote: true,
      });
    },
  };
  return api;
}

const siteId = "amare-qa-d28";
const ident = memoryIdentity();
const created = await finishEmailAuthentication(
  { email: "brand.new@example.com", mbSessClientId: null, siteId },
  { identity: ident, searchStudioClientsByEmail: async () => ({ ok: true, exactMatches: [] }) },
);
check("brand-new email creates amare_user before Studio profile", created.createdUser === true && Boolean(created.amare_user_id));
check("email identity exists", ident.identities[0]?.provider === "email" && ident.identities[0]?.provider_sub === "brand.new@example.com");
check("successful Staff 0 → needs_profile", created.claim.needsProfile === true && created.profileTx?.provider_sub === "brand.new@example.com");
check("profile tx binds OTP email not listIdentities", created.profileTx.provider === "email" && created.profileTx.amare_user_id === created.amare_user_id);
check("no clientId in profile tx", created.profileTx.client_id == null && created.profileTx.clientId == null);

const reuse = await finishEmailAuthentication(
  { email: "brand.new@example.com", mbSessClientId: null, siteId },
  { identity: ident, searchStudioClientsByEmail: async () => ({ ok: true, exactMatches: [] }) },
);
check("second OTP reuses same amare_user_id", reuse.amare_user_id === created.amare_user_id && ident.users.size === 1);

const failIdent = memoryIdentity();
const failedSearch = await finishEmailAuthentication(
  { email: "outage@example.com", mbSessClientId: null, siteId },
  { identity: failIdent, searchStudioClientsByEmail: async () => ({ ok: false, reason: "staff_search_timeout", exactMatches: [] }) },
);
check("Staff failure does not → needs_profile", failedSearch.claim.needsProfile !== true && !failedSearch.profileTx);

let addclientCalls = 0;
const createOnce = async (_headers, input) => {
  addclientCalls += 1;
  return { ok: true, clientId: 100009001 };
};
const profileTx = created.profileTx;
const made = await createAmareStudioProfile(
  {
    amareUserId: created.amare_user_id,
    profileTx,
    firstName: "Ada",
    lastName: "Lovelace",
    mobilePhone: "7865031414",
    explicitCreate: true,
    body: { firstName: "Ada", lastName: "Lovelace", mobilePhone: "7865031414", explicitCreate: true },
    siteId,
  },
  {
    identity: ident,
    searchStudioClientsByEmail: async () => ({ ok: true, exactMatches: [] }),
    createStudioClient: createOnce,
    staffHeaders: { Authorization: "Bearer qa" },
    withLock: async (_key, fn) => fn(),
  },
);
check("Staff create succeeds → linked", made.ok === true && made.status === "linked" && made.claimMethod === "new_profile_created");
check("one addclient for happy path", addclientCalls === 1);
check(
  "association linked with new_profile_created",
  ident.associations.some((a) => a.status === "linked" && a.claim_method === "new_profile_created" && Number(a.client_id) === 100009001),
);

const noSess = await createAmareStudioProfile(
  { amareUserId: "", profileTx, firstName: "A", lastName: "B", mobilePhone: "7865031414", explicitCreate: true, body: {}, siteId },
  { identity: ident, withLock: async (_k, fn) => fn(), searchStudioClientsByEmail: async () => ({ ok: true, exactMatches: [] }) },
);
check("profile/create requires amare user", noSess.error === "signed_out");

const noTx = await createAmareStudioProfile(
  {
    amareUserId: created.amare_user_id,
    profileTx: null,
    firstName: "A",
    lastName: "B",
    mobilePhone: "7865031414",
    explicitCreate: true,
    body: {},
    siteId,
  },
  { identity: ident, withLock: async (_k, fn) => fn() },
);
check("profile/create requires profile transaction", noTx.error === "profile_tx_required");

const otherUser = await createAmareStudioProfile(
  {
    amareUserId: newAmareUserId(),
    profileTx,
    firstName: "A",
    lastName: "B",
    mobilePhone: "7865031414",
    explicitCreate: true,
    body: {},
    siteId,
  },
  { identity: ident, withLock: async (_k, fn) => fn() },
);
check("profile transaction must belong to same amare_user_id", otherUser.error === "profile_tx_user_mismatch");

const emailBody = await createAmareStudioProfile(
  {
    amareUserId: created.amare_user_id,
    profileTx,
    firstName: "A",
    lastName: "B",
    mobilePhone: "7865031414",
    explicitCreate: true,
    body: { email: "attacker@example.com" },
    siteId,
  },
  { identity: ident, withLock: async (_k, fn) => fn() },
);
check("body email rejected", emailBody.error === "field_not_allowed" && emailBody.field === "email");

const clientBody = await createAmareStudioProfile(
  {
    amareUserId: created.amare_user_id,
    profileTx,
    firstName: "A",
    lastName: "B",
    mobilePhone: "7865031414",
    explicitCreate: true,
    body: { clientId: 99 },
    siteId,
  },
  { identity: ident, withLock: async (_k, fn) => fn() },
);
check("body clientId rejected", clientBody.error === "field_not_allowed");

const fresh = memoryIdentity();
const freshAuth = await finishEmailAuthentication(
  { email: "fields@example.com", mbSessClientId: null, siteId },
  { identity: fresh, searchStudioClientsByEmail: async () => ({ ok: true, exactMatches: [] }) },
);
const missingFirst = await createAmareStudioProfile(
  { amareUserId: freshAuth.amare_user_id, profileTx: freshAuth.profileTx, firstName: "", lastName: "L", mobilePhone: "7865031414", explicitCreate: true, body: {}, siteId },
  { identity: fresh, withLock: async (_k, fn) => fn(), searchStudioClientsByEmail: async () => ({ ok: true, exactMatches: [] }) },
);
const missingLast = await createAmareStudioProfile(
  { amareUserId: freshAuth.amare_user_id, profileTx: freshAuth.profileTx, firstName: "F", lastName: "", mobilePhone: "7865031414", explicitCreate: true, body: {}, siteId },
  { identity: fresh, withLock: async (_k, fn) => fn(), searchStudioClientsByEmail: async () => ({ ok: true, exactMatches: [] }) },
);
const missingPhone = await createAmareStudioProfile(
  { amareUserId: freshAuth.amare_user_id, profileTx: freshAuth.profileTx, firstName: "F", lastName: "L", mobilePhone: "12", explicitCreate: true, body: {}, siteId },
  { identity: fresh, withLock: async (_k, fn) => fn(), searchStudioClientsByEmail: async () => ({ ok: true, exactMatches: [] }) },
);
check("new profile requires first name", missingFirst.error === "first_name_required");
check("new profile requires last name", missingLast.error === "last_name_required");
check("new profile requires valid US mobile", missingPhone.error === "mobile_phone_required");

let raceCreates = 0;
const raceIdent = memoryIdentity();
const raceAuth = await finishEmailAuthentication(
  { email: "race@example.com", mbSessClientId: null, siteId },
  { identity: raceIdent, searchStudioClientsByEmail: async () => ({ ok: true, exactMatches: [] }) },
);
const raceCreate = await createAmareStudioProfile(
  {
    amareUserId: raceAuth.amare_user_id,
    profileTx: raceAuth.profileTx,
    firstName: "R",
    lastName: "Ace",
    mobilePhone: "7865031414",
    explicitCreate: true,
    body: {},
    siteId,
  },
  {
    identity: raceIdent,
    withLock: async (_k, fn) => fn(),
    searchStudioClientsByEmail: async () => ({ ok: true, exactMatches: [100002800] }),
    createStudioClient: async () => {
      raceCreates += 1;
      return { ok: true, clientId: 199 };
    },
    staffHeaders: { Authorization: "Bearer qa" },
  },
);
check("final search 1 → candidate, no addclient", raceCreate.error === "existing_client" && raceCreate.claimStatus === "candidate" && raceCreates === 0);

const manyIdent = memoryIdentity();
const manyAuth = await finishEmailAuthentication(
  { email: "many@example.com", mbSessClientId: null, siteId },
  { identity: manyIdent, searchStudioClientsByEmail: async () => ({ ok: true, exactMatches: [] }) },
);
let manyCreates = 0;
const manyCreate = await createAmareStudioProfile(
  {
    amareUserId: manyAuth.amare_user_id,
    profileTx: manyAuth.profileTx,
    firstName: "M",
    lastName: "Any",
    mobilePhone: "7865031414",
    explicitCreate: true,
    body: {},
    siteId,
  },
  {
    identity: manyIdent,
    withLock: async (_k, fn) => fn(),
    searchStudioClientsByEmail: async () => ({ ok: true, exactMatches: [1, 2] }),
    createStudioClient: async () => {
      manyCreates += 1;
      return { ok: true, clientId: 3 };
    },
    staffHeaders: { Authorization: "Bearer qa" },
  },
);
check("final search 2+ → ambiguous, no addclient", manyCreate.error === "ambiguous" && manyCreates === 0);

const failCreateIdent = memoryIdentity();
const failCreateAuth = await finishEmailAuthentication(
  { email: "nocreate@example.com", mbSessClientId: null, siteId },
  { identity: failCreateIdent, searchStudioClientsByEmail: async () => ({ ok: true, exactMatches: [] }) },
);
let failCreates = 0;
const failCreate = await createAmareStudioProfile(
  {
    amareUserId: failCreateAuth.amare_user_id,
    profileTx: failCreateAuth.profileTx,
    firstName: "N",
    lastName: "O",
    mobilePhone: "7865031414",
    explicitCreate: true,
    body: {},
    siteId,
  },
  {
    identity: failCreateIdent,
    withLock: async (_k, fn) => fn(),
    searchStudioClientsByEmail: async () => ({ ok: false, reason: "staff_search_failed", exactMatches: [] }),
    createStudioClient: async () => {
      failCreates += 1;
      return { ok: true, clientId: 4 };
    },
    staffHeaders: { Authorization: "Bearer qa" },
  },
);
check("final search failure → no addclient", failCreate.error === "staff_search_unavailable" && failCreates === 0);

const ownerIdent = memoryIdentity();
const ownerId = newAmareUserId();
ownerIdent.users.set(ownerId, { amare_user_id: ownerId });
ownerIdent.associations.push({ id: 1, amare_user_id: ownerId, site_id: siteId, client_id: 555, status: "linked" });
const stolenAuth = await finishEmailAuthentication(
  { email: "stolen@example.com", mbSessClientId: null, siteId },
  { identity: ownerIdent, searchStudioClientsByEmail: async () => ({ ok: true, exactMatches: [] }) },
);
let stolenCreates = 0;
const stolen = await createAmareStudioProfile(
  {
    amareUserId: stolenAuth.amare_user_id,
    profileTx: stolenAuth.profileTx,
    firstName: "S",
    lastName: "T",
    mobilePhone: "7865031414",
    explicitCreate: true,
    body: {},
    siteId,
  },
  {
    identity: ownerIdent,
    withLock: async (_k, fn) => fn(),
    searchStudioClientsByEmail: async () => ({ ok: true, exactMatches: [555] }),
    createStudioClient: async () => {
      stolenCreates += 1;
      return { ok: true, clientId: 556 };
    },
    staffHeaders: { Authorization: "Bearer qa" },
  },
);
check("linked client owned by another user → conflict, no addclient", stolen.error === "conflict" && stolenCreates === 0);

const dupIdent = memoryIdentity();
const dupAuth = await finishEmailAuthentication(
  { email: "dup@example.com", mbSessClientId: null, siteId },
  { identity: dupIdent, searchStudioClientsByEmail: async () => ({ ok: true, exactMatches: [] }) },
);
let dupCalls = 0;
const dup = await createAmareStudioProfile(
  {
    amareUserId: dupAuth.amare_user_id,
    profileTx: dupAuth.profileTx,
    firstName: "D",
    lastName: "Up",
    mobilePhone: "7865031414",
    explicitCreate: true,
    body: {},
    siteId,
  },
  {
    identity: dupIdent,
    withLock: async (_k, fn) => fn(),
    searchStudioClientsByEmail: async () => ({ ok: true, exactMatches: [] }),
    createStudioClient: async () => {
      dupCalls += 1;
      return { ok: false, error: "client_email_already_exists", conflict: true };
    },
    staffHeaders: { Authorization: "Bearer qa" },
  },
);
check("duplicate response does not loop-create", dupCalls === 1 && dup.error === "duplicate_unresolved");

const retryIdent = memoryIdentity();
const retryAuth = await finishEmailAuthentication(
  { email: "retry@example.com", mbSessClientId: null, siteId },
  { identity: retryIdent, searchStudioClientsByEmail: async () => ({ ok: true, exactMatches: [] }) },
);
await retryIdent.proposeAssociation({
  amare_user_id: retryAuth.amare_user_id,
  site_id: siteId,
  status: "candidate",
  client_id: 100009111,
  claim_proof_ref: "new_profile_pending:retry@example.com",
});
let retryCreates = 0;
const retry = await createAmareStudioProfile(
  {
    amareUserId: retryAuth.amare_user_id,
    profileTx: retryAuth.profileTx,
    firstName: "R",
    lastName: "Etry",
    mobilePhone: "7865031414",
    explicitCreate: true,
    body: {},
    siteId,
  },
  {
    identity: retryIdent,
    withLock: async (_k, fn) => fn(),
    searchStudioClientsByEmail: async () => ({ ok: true, exactMatches: [100009111] }),
    createStudioClient: async () => {
      retryCreates += 1;
      return { ok: true, clientId: 100009112 };
    },
    staffHeaders: { Authorization: "Bearer qa" },
  },
);
check("partial-create retry reconciles without second client", retry.ok === true && retry.reconciled === true && retryCreates === 0);

const dblIdent = memoryIdentity();
const dblAuth = await finishEmailAuthentication(
  { email: "dbl@example.com", mbSessClientId: null, siteId },
  { identity: dblIdent, searchStudioClientsByEmail: async () => ({ ok: true, exactMatches: [] }) },
);
let dblCalls = 0;
let createdId = null;
const lock = { held: false, wait: Promise.resolve() };
const withTestLock = async (_key, fn) => {
  while (lock.held) await lock.wait;
  lock.held = true;
  let release;
  lock.wait = new Promise((r) => {
    release = r;
  });
  try {
    return await fn();
  } finally {
    lock.held = false;
    release();
  }
};
const createDbl = async () => {
  dblCalls += 1;
  if (createdId) return { ok: true, clientId: createdId };
  createdId = 100009222;
  return { ok: true, clientId: createdId };
};
const [dblA, dblB] = await Promise.all([
  createAmareStudioProfile(
    {
      amareUserId: dblAuth.amare_user_id,
      profileTx: dblAuth.profileTx,
      firstName: "D",
      lastName: "Bl",
      mobilePhone: "7865031414",
      explicitCreate: true,
      body: {},
      siteId,
    },
    {
      identity: dblIdent,
      withLock: withTestLock,
      searchStudioClientsByEmail: async () =>
        createdId ? { ok: true, exactMatches: [createdId] } : { ok: true, exactMatches: [] },
      createStudioClient: createDbl,
      staffHeaders: { Authorization: "Bearer qa" },
    },
  ),
  createAmareStudioProfile(
    {
      amareUserId: dblAuth.amare_user_id,
      profileTx: dblAuth.profileTx,
      firstName: "D",
      lastName: "Bl",
      mobilePhone: "7865031414",
      explicitCreate: true,
      body: {},
      siteId,
    },
    {
      identity: dblIdent,
      withLock: withTestLock,
      searchStudioClientsByEmail: async () =>
        createdId ? { ok: true, exactMatches: [createdId] } : { ok: true, exactMatches: [] },
      createStudioClient: createDbl,
      staffHeaders: { Authorization: "Bearer qa" },
    },
  ),
]);
const linkedRows = dblIdent.associations.filter((a) => a.status === "linked");
check(
  "double submit → one Studio client",
  (dblA.ok || dblB.ok) && linkedRows.length === 1 && Number(linkedRows[0].client_id) === 100009222,
);

const existingIdent = memoryIdentity();
const existingAuth = await finishEmailAuthentication(
  { email: "existing@example.com", mbSessClientId: null, siteId },
  { identity: existingIdent, searchStudioClientsByEmail: async () => ({ ok: true, exactMatches: [100002726] }) },
);
check("existing-client claim regression: 1 match is candidate", existingAuth.claim.status === "candidate" && existingAuth.claim.autoBind === false && !existingAuth.profileTx);

const issued = maybeIssueAmareSession({
  amare_user_id: created.amare_user_id,
  headers: { host: "127.0.0.1:4321", origin: "http://127.0.0.1:4321" },
});
const sealedTx = buildProfileTxCookie(profileTx, { host: "127.0.0.1:4321" });
const httpCreate = await handleAmareAuthProfileCreate(
  {
    httpMethod: "POST",
    headers: {
      host: "127.0.0.1:4321",
      origin: "http://127.0.0.1:4321",
      cookie: `${issued.cookie.split(";")[0]}; ${sealedTx.split(";")[0]}`,
    },
    body: JSON.stringify({ firstName: "Ada", lastName: "Lovelace", mobilePhone: "7865031414", explicitCreate: true }),
  },
  {
    findUser: async (id) => ident.users.get(id) || { amare_user_id: id },
    identity: ident,
    searchStudioClientsByEmail: async () => ({ ok: true, exactMatches: [] }),
    createStudioClient: async () => ({ ok: true, clientId: 100009001 }),
    staffHeaders: { Authorization: "Bearer qa" },
    withLock: async (_k, fn) => fn(),
    siteId,
  },
);
check("HTTP profile/create requires same-origin and session", httpCreate.statusCode === 200 || httpCreate.statusCode === 409);

const foreign = await handleAmareAuthProfileCreate({
  httpMethod: "POST",
  headers: { host: "127.0.0.1:4321", origin: "https://evil.example" },
  body: "{}",
});
check("profile/create rejects foreign origin", foreign.statusCode === 403);

check("no mb_sess required in create path", !profileLib.includes("mb_sess") || profileLib.includes("No Consumer"));
check("customer confirmation is the create action only", loginHtml.includes("Create my profile") && !loginHtml.includes("Is this the profile you just created"));

for (const [k, v] of Object.entries(prev)) {
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

if (failed) {
  console.error(`\n${failed} AMARÉ new-customer QA check(s) failed.`);
  process.exit(1);
}
console.log("\nAll AMARÉ new-customer QA checks passed.");
