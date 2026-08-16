/**
 * Phase 0+1 identity contract checks. No live booking. No Google/Apple.
 * Run: node scripts/qa-amare-identity-phase01.mjs
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  assertAssociationTransition,
  canTransitionAssociation,
  isApplePrivateRelayEmail,
  newAmareUserId,
  resolveClaimCandidate,
} from "../netlify/functions/amare-identity-policy.mjs";
import {
  amareSessIssueEnabled,
  sealAmareSessPayload,
  unsealAmareSessPayload,
} from "../netlify/functions/amare-sess-lib.mjs";
import {
  assertIdentityProvider,
  assertProviderSub,
  promoteAssociationToLinked,
} from "../netlify/functions/amare-identity-store.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;

function check(name, ok, detail) {
  if (ok) console.log(`PASS — ${name}`);
  else {
    failed += 1;
    console.log(`FAIL — ${name}${detail ? `\n  ${detail}` : ""}`);
  }
}

const migration = await readFile(
  path.join(root, "netlify/database/migrations/20260816000100_amare_identity.sql"),
  "utf8",
);
check(
  "partial unique index site_id + client_id (verified/linked)",
  /amare_studio_assoc_site_client_active_uidx[\s\S]*\(site_id, client_id\)[\s\S]*status IN \('verified', 'linked'\)/.test(
    migration,
  ),
);
check(
  "partial unique index user + site (verified/linked)",
  /amare_studio_assoc_user_site_active_uidx[\s\S]*\(amare_user_id, system, site_id\)[\s\S]*status IN \('verified', 'linked'\)/.test(
    migration,
  ),
);
check("identities unique (provider, provider_sub)", /ON amare_identities \(provider, provider_sub\)/.test(migration));
check(
  "Phase 1 identities CHECK is still google|apple|email only",
  /CONSTRAINT amare_identities_provider_chk\s+CHECK \(provider IN \('google', 'apple', 'email'\)\)/.test(
    migration,
  ),
);

const migration2a1 = await readFile(
  path.join(root, "netlify/database/migrations/20260816083000_amare_identities_provider_mindbody.sql"),
  "utf8",
);
check(
  "2A.1 migration expands CHECK to mindbody",
  /CHECK \(provider IN \('google', 'apple', 'email', 'mindbody'\)\)/.test(migration2a1),
);
check(
  "2A.1 is a new file not an edit of 20260816000100",
  !/ADD CONSTRAINT amare_identities_provider_chk[\s\S]*mindbody/.test(migration),
);

check("unlinked → candidate allowed", canTransitionAssociation("unlinked", "candidate") === true);
check("unlinked → verified forbidden", canTransitionAssociation("unlinked", "verified") === false);
check("candidate → verified allowed (phase 1)", canTransitionAssociation("candidate", "verified", { phase: 1 }) === true);
check("verified → linked forbidden in phase 1", canTransitionAssociation("verified", "linked", { phase: 1 }) === false);
check("verified → linked allowed in phase 2", canTransitionAssociation("verified", "linked", { phase: 2 }) === true);

let threw = false;
try {
  assertAssociationTransition("candidate", "verified", { explicitConfirm: false });
} catch (e) {
  threw = String(e.message) === "verified_requires_explicit_confirm";
}
check("verified requires explicit confirm", threw);

threw = false;
try {
  assertAssociationTransition("unlinked", "candidate", { appleRelay: true });
} catch (e) {
  threw = String(e.message) === "apple_relay_cannot_bind";
}
check("apple relay cannot become candidate", threw);

check("relay email detected", isApplePrivateRelayEmail("abc@privaterelay.appleid.com") === true);
check("normal email not relay", isApplePrivateRelayEmail("sara@gmail.com") === false);

const existing = resolveClaimCandidate({
  existingStatus: "verified",
  existingClientId: 99,
  mbSessValid: true,
  mbSessClientId: 1,
  verifiedEmail: "a@b.com",
  emailMatchCount: 1,
});
check("rank 1 uses existing mapping", existing.rank === 1 && existing.action === "use_existing" && existing.autoBind === false);

const relay = resolveClaimCandidate({
  verifiedEmail: "x@privaterelay.appleid.com",
  emailMatchCount: 1,
});
check("rank 6 apple relay blocks", relay.rank === 6 && relay.status === "unlinked" && relay.autoBind === false);

const mb = resolveClaimCandidate({
  mbSessValid: true,
  mbSessClientId: 873921,
  verifiedEmail: "sara@gmail.com",
  emailMatchCount: 1,
});
check("rank 2 mb_sess is confirm_required not auto-bind", mb.rank === 2 && mb.autoBind === false && mb.status === "candidate");

const emailOnly = resolveClaimCandidate({
  verifiedEmail: "sara@gmail.com",
  emailMatchCount: 1,
});
check("rank 3 email unique is candidate not auto-bind", emailOnly.rank === 3 && emailOnly.autoBind === false);

const amb = resolveClaimCandidate({
  verifiedEmail: "sara@gmail.com",
  emailMatchCount: 2,
});
check("rank 5 duplicate email is ambiguous", amb.rank === 5 && amb.status === "ambiguous");

const id = newAmareUserId();
check("amare_user_id format", /^usr_[0-9A-HJKMNP-TV-Z]{22}$/.test(id));

const prevIssue = process.env.ENABLE_AMARE_SESS_ISSUE;
const prevSecret = process.env.AMARE_SESSION_SECRET;
delete process.env.ENABLE_AMARE_SESS_ISSUE;
check("ENABLE_AMARE_SESS_ISSUE default off", amareSessIssueEnabled() === false);

process.env.AMARE_SESSION_SECRET = "phase01-amare-session-secret-key!!";
const sealed = sealAmareSessPayload({ amare_user_id: id });
const opened = unsealAmareSessPayload(sealed);
check("amare_sess round-trip", opened && opened.amare_user_id === id);
check("amare_sess has no client_id", opened && !("client_id" in opened && opened.client_id));

threw = false;
try {
  await promoteAssociationToLinked();
} catch (e) {
  threw = String(e.message) === "linked_forbidden_in_phase1";
}
check("promote to linked throws in phase 1", threw);

if (prevIssue === undefined) delete process.env.ENABLE_AMARE_SESS_ISSUE;
else process.env.ENABLE_AMARE_SESS_ISSUE = prevIssue;
if (prevSecret === undefined) delete process.env.AMARE_SESSION_SECRET;
else process.env.AMARE_SESSION_SECRET = prevSecret;

const storeSrc = await readFile(path.join(root, "netlify/functions/amare-identity-store.mjs"), "utf8");
check("identity store has no HTTP handler", !/export async function handler/.test(storeSrc));
check("identity store documents no public HTTP", /No public HTTP/.test(storeSrc));
check("identity store uses native @netlify/database", storeSrc.includes('from "@netlify/database"'));
check("identity store uses getConnectionString", storeSrc.includes("getConnectionString"));
check("identity store has findIdentity", storeSrc.includes("export async function findIdentity"));
check("identity store has listIdentities", storeSrc.includes("export async function listIdentities"));
check("identity store has createUserWithIdentity", storeSrc.includes("export async function createUserWithIdentity"));
check("createUserWithIdentity uses BEGIN/COMMIT", /BEGIN/.test(storeSrc) && /COMMIT/.test(storeSrc));
check(
  "createUserWithIdentity does not write studio associations",
  /Does not write amare_studio_associations/.test(storeSrc) &&
    !/INSERT INTO amare_studio_associations[\s\S]{0,200}createUserWithIdentity/.test(storeSrc),
);

for (const p of ["google", "apple", "email", "mindbody"]) {
  let ok = false;
  try {
    ok = assertIdentityProvider(p) === p;
  } catch {
    ok = false;
  }
  check(`provider=${p} accepted`, ok);
}
let unknownThrew = false;
try {
  assertIdentityProvider("facebook");
} catch (e) {
  unknownThrew = String(e.message) === "unknown_identity_provider";
}
check("unknown provider rejected", unknownThrew);

let mbSubThrew = false;
try {
  assertProviderSub("mindbody", "84521");
} catch (e) {
  mbSubThrew = String(e.message) === "mindbody_provider_sub_must_not_be_client_id";
}
check("Mindbody provider_sub rejects clientId-shaped value", mbSubThrew);
mbSubThrew = false;
try {
  assertProviderSub("mindbody", "jane@gmail.com");
} catch (e) {
  mbSubThrew = String(e.message) === "mindbody_provider_sub_must_be_oidc_sub";
}
check("Mindbody provider_sub rejects email", mbSubThrew);
check("Mindbody OIDC-shaped sub accepted", assertProviderSub("mindbody", "mb-oidc-sub-abc") === "mb-oidc-sub-abc");

check(
  "2A.3 claim/confirm must not trust frontend client_id (plan note)",
  (await readFile(path.join(root, "docs/AMARE-AUTH-PHASE2A-IMPLEMENTATION-PLAN.md"), "utf8")).includes(
    "must NOT trust a frontend-provided `client_id`",
  ),
);

const toml = await readFile(path.join(root, "netlify.toml"), "utf8");
check("no /api/amare write redirect", !/\/api\/amare\//.test(toml));

const functionsDir = await readFile(path.join(root, "netlify/functions/amare-identity-store.mjs"), "utf8");
check("store write ceiling comment / verified", functionsDir.includes("verified"));

const sessionSrc = await readFile(path.join(root, "netlify/functions/mindbody-oauth-session.mjs"), "utf8");
check("oauth session logs dark amare_sess without changing JSON", sessionSrc.includes("logAmareSessVersusMbSess"));

const classesSrc = await readFile(path.join(root, "src/js/classes-schedule.js"), "utf8");
for (const field of [
  "book_block_variant",
  "clientExists",
  "hasPhone",
  "walletLoadState",
  "hasActiveCredits",
  "consumerAssociated",
  "selectedCTA",
  "resolveHasPhoneForLog",
]) {
  check(`classes-schedule log field ${field}`, classesSrc.includes(field));
}
check("classes-schedule still gates on oauthBookingAllowed", classesSrc.includes("oauthLoggedIn && !oauthBookingAllowed"));

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll Phase 0+1 + 2A.1 identity QA checks passed.");
