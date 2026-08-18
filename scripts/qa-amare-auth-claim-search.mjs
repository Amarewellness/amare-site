/**
 * AMARÉ Staff-backed Studio claim search QA.
 * Run: npm run test:amare-auth-claim-search
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { newAmareUserId } from "../netlify/functions/amare-identity-policy.mjs";
import {
  confirmAmareClaim,
  evaluateGoogleClaim,
  finishEmailAuthentication,
  searchStudioClientsByEmail,
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

const src = await readFile(path.join(root, "netlify/functions/amare-auth-lib.mjs"), "utf8");
const verifySrc = await readFile(path.join(root, "netlify/functions/amare-auth-email-verify.mjs"), "utf8");
const sessionSrc = await readFile(path.join(root, "netlify/functions/amare-auth-session.mjs"), "utf8");
const accessSrc = await readFile(path.join(root, "netlify/functions/amare-auth-member-access.mjs"), "utf8");
const book = await readFile(path.join(root, "netlify/functions/mindbody-class-book.mjs"), "utf8");
const stripe = await readFile(path.join(root, "src/js/stripe-express-cta.js"), "utf8");
const mobile = await readFile(path.join(root, "netlify/functions/mindbody-oauth-mobile-exchange.mjs"), "utf8");
const googleCb = await readFile(path.join(root, "netlify/functions/amare-auth-google-callback.mjs"), "utf8");

check("claim search uses Staff resolver", src.includes("resolveStaffAuthHeaders"));
check("Staff claim search logs exact count", src.includes("studio_claim_search_staff"));
check(
  "API-Key-only headers are not claim search authority",
  /export async function searchStudioClientsByEmail[\s\S]*?^export /m.test(src) &&
    !/export async function searchStudioClientsByEmail[\s\S]*mindbodyHeaders\(\)/.test(src),
);
check("Google claim uses the same search helper", googleCb.includes("searchStudioClientsByEmail") && src.includes("evaluateGoogleClaim"));
check("verify-code still does not write linked", !verifySrc.includes("promoteAssociationToLinked"));
check("session/member-access omit Staff tokens", !sessionSrc.includes("AccessToken") && !accessSrc.includes("Authorization"));
check("class-book still does not read amare_sess", !book.includes("amare_sess"));
check("Stripe express unchanged", !stripe.includes("searchStudioClientsByEmail"));
check("mobile exchange unchanged", !mobile.includes("searchStudioClientsByEmail") && !mobile.includes("ENABLE_AMARE_STUDIO_OPERATIONS"));

function staffRows(rows) {
  return {
    resolveStaffAuthHeaders: async () => ({ Authorization: "Bearer qa-staff" }),
    mindbodyHost: () => "api.example.test",
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ Clients: rows }),
    }),
  };
}

const exact = await searchStudioClientsByEmail("Ada@Example.com", staffRows([
  { Id: 11, Email: "other@example.com" },
  { Id: 100002726, Email: " ada@example.com " },
  { Id: 12, Email: "ada@example.com.other" },
]));
check("broad Staff results are filtered to exact normalized email", exact.ok === true && exact.exactMatches.length === 1 && exact.exactMatches[0] === 100002726);

const none = await searchStudioClientsByEmail("missing@example.com", staffRows([{ Id: 1, Email: "else@example.com" }]));
check("Staff 0 exact → successful empty list", none.ok === true && none.exactMatches.length === 0);

const two = await searchStudioClientsByEmail("dup@example.com", staffRows([
  { Id: 1, Email: "dup@example.com" },
  { Id: 2, Email: "DUP@example.com" },
]));
check("Staff 2+ exact → both ids", two.ok === true && two.exactMatches.length === 2 && two.exactMatches.includes(1) && two.exactMatches.includes(2));

const apiKeyWouldBeEmpty = await searchStudioClientsByEmail("real@example.com", {
  resolveStaffAuthHeaders: async () => ({ Authorization: "Bearer qa-staff" }),
  mindbodyHost: () => "api.example.test",
  fetch: async () => ({
    ok: true,
    status: 200,
    json: async () => ({ Clients: [{ Id: 100002726, Email: "real@example.com" }] }),
  }),
});
check(
  "API-Key empty no longer wins when Staff has one exact client",
  apiKeyWouldBeEmpty.ok === true && apiKeyWouldBeEmpty.exactMatches.length === 1 && apiKeyWouldBeEmpty.exactMatches[0] === 100002726,
);

const noStaff = await searchStudioClientsByEmail("real@example.com", {
  resolveStaffAuthHeaders: async () => null,
  fetch: async () => {
    throw new Error("api_key_path_must_not_run");
  },
});
check("missing Staff headers is search failure, not a successful zero", noStaff.ok === false && noStaff.reason === "staff_search_unavailable");

const upstreamFail = await searchStudioClientsByEmail("real@example.com", {
  resolveStaffAuthHeaders: async () => ({ Authorization: "Bearer qa-staff" }),
  mindbodyHost: () => "api.example.test",
  fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
});
check("Staff 5xx is search failure, not a successful zero", upstreamFail.ok === false && upstreamFail.exactMatches.length === 0);

const siteId = "amare-qa-claim-search";
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
    async listIdentities(amareUserId) {
      return identities.filter((i) => i.amare_user_id === amareUserId);
    },
    async createUserWithIdentity({ provider, provider_sub, email, email_verified }) {
      const amare_user_id = newAmareUserId();
      users.set(amare_user_id, { amare_user_id });
      identities.push({ amare_user_id, provider, provider_sub, email: email || null, email_verified: !!email_verified });
      return { amare_user_id, provider, provider_sub };
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
        associations.find(
          (a) => a.amare_user_id === amareUserId && a.site_id === sid && (a.status === "verified" || a.status === "linked"),
        ) || null
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
      associations.push({ id: assocId++, ...input, client_id: input.client_id ?? null });
    },
    async confirmAssociation(input) {
      associations.push({
        id: assocId++,
        amare_user_id: input.amare_user_id,
        site_id: input.site_id,
        status: "verified",
        client_id: input.client_id,
      });
    },
    async promoteAssociationToLinked(input) {
      if (input?.explicitPromote !== true) throw new Error("linked_requires_explicit_promote");
      const current = await this.getActiveAssociation(input.amare_user_id, input.site_id);
      if (!current || current.status !== "verified") throw new Error("linked_requires_verified");
      current.status = "linked";
      return { ok: true, status: "linked", already: false, client_id: current.client_id };
    },
  };
}

const zeroMem = memoryIdentity();
const zero = await finishEmailAuthentication(
  { email: "zero@example.com", mbSessClientId: null, siteId },
  { identity: zeroMem, searchStudioClientsByEmail: async () => [] },
);
check("Staff 0 exact → unlinked", zero.claim.status === "unlinked" && zero.claim.autoBind === false);
check("Staff successful 0 → needs_profile provenance", zero.claim.needsProfile === true && zero.profileTx?.provider_sub === "zero@example.com");

const failMem = memoryIdentity();
const failSearch = await finishEmailAuthentication(
  { email: "fail@example.com", mbSessClientId: null, siteId },
  { identity: failMem, searchStudioClientsByEmail: async () => ({ ok: false, reason: "staff_search_unavailable", exactMatches: [] }) },
);
check(
  "Staff failure does not become needs_profile",
  failSearch.claim.status === "unlinked" &&
    failSearch.claim.needsProfile !== true &&
    failSearch.claim.blockReason === "staff_search_unavailable" &&
    !failSearch.profileTx,
);

const oneMem = memoryIdentity();
const one = await finishEmailAuthentication(
  { email: "one@example.com", mbSessClientId: null, siteId },
  { identity: oneMem, searchStudioClientsByEmail: async () => [100002726] },
);
check("Staff 1 exact → candidate", one.claim.status === "candidate" && one.claim.clientId === 100002726 && one.claim.autoBind === false);
check("no automatic linked before explicit confirm", one.claim.status !== "linked" && one.claim.status !== "verified");

const manyMem = memoryIdentity();
const many = await finishEmailAuthentication(
  { email: "many@example.com", mbSessClientId: null, siteId },
  { identity: manyMem, searchStudioClientsByEmail: async () => [1, 2] },
);
check("Staff 2+ exact → ambiguous", many.claim.status === "ambiguous");

const googleMem = memoryIdentity();
const googleClaim = await evaluateGoogleClaim(
  {
    amare_user_id: (await googleMem.createUserWithIdentity({ provider: "google", provider_sub: "sub-1", email: "g@example.com", email_verified: true })).amare_user_id,
    siteId,
    mbSessValid: false,
    verifiedEmail: "g@example.com",
  },
  { identity: googleMem, searchStudioClientsByEmail: async () => [100002726] },
);
check("Google verified-email evidence uses Staff helper result", googleClaim.status === "candidate" && googleClaim.clientId === 100002726);

const prevAuth = process.env.ENABLE_AMARE_AUTH;
const prevRead = process.env.ENABLE_AMARE_MEMBER_READ;
const prevOps = process.env.ENABLE_AMARE_STUDIO_OPERATIONS;
process.env.ENABLE_AMARE_AUTH = "1";
process.env.ENABLE_AMARE_STUDIO_OPERATIONS = "1";
delete process.env.ENABLE_AMARE_MEMBER_READ;
const confirm = await confirmAmareClaim(
  { amare_user_id: one.amare_user_id, explicitConfirm: true, siteId },
  { identity: oneMem },
);
check("candidate confirmation reaches linked when Studio Operations is on", confirm.ok && confirm.status === "linked");
if (prevAuth === undefined) delete process.env.ENABLE_AMARE_AUTH;
else process.env.ENABLE_AMARE_AUTH = prevAuth;
if (prevRead === undefined) delete process.env.ENABLE_AMARE_MEMBER_READ;
else process.env.ENABLE_AMARE_MEMBER_READ = prevRead;
if (prevOps === undefined) delete process.env.ENABLE_AMARE_STUDIO_OPERATIONS;
else process.env.ENABLE_AMARE_STUDIO_OPERATIONS = prevOps;

if (failed) {
  console.error(`\n${failed} AMARÉ claim-search QA check(s) failed.`);
  process.exit(1);
}
console.log("\nAll AMARÉ claim-search QA checks passed.");
