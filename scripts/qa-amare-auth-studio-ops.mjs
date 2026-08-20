/**
 * AMARÉ provider-neutral Studio operations QA.
 * Run: npm run test:amare-auth-studio-ops
 *
 * Does not enable production.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { newAmareUserId } from "../netlify/functions/amare-identity-policy.mjs";
import { sealCookiePayload } from "../netlify/functions/oauth-lib.mjs";
import { AMARE_SESS_COOKIE, sealAmareSessPayload } from "../netlify/functions/amare-sess-lib.mjs";
import {
  amareStudioOperationsEnabled,
  resolveAmareStudioClient,
  resolveStudioCustomer,
} from "../netlify/functions/amare-studio-lib.mjs";
import { handleAmareAuthMemberAccess } from "../netlify/functions/amare-auth-member-access.mjs";

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

const AMARE_SECRET = "qa-ops-amare-session-secret-key!!";
const MB_SECRET = "qa-ops-mindbody-session-secret!!";
const userId = newAmareUserId();

const envExample = await readFile(path.join(root, ".env.example"), "utf8");
const localDev = await readFile(path.join(root, "scripts/unified-local-dev.mjs"), "utf8");
const studio = await readFile(path.join(root, "netlify/functions/amare-studio-lib.mjs"), "utf8");
const memberAccessFn = await readFile(path.join(root, "netlify/functions/amare-auth-member-access.mjs"), "utf8");
const book = await readFile(path.join(root, "netlify/functions/mindbody-class-book.mjs"), "utf8");
const cancel = await readFile(path.join(root, "netlify/functions/mindbody-class-cancel.mjs"), "utf8");
const waitlist = await readFile(path.join(root, "netlify/functions/mindbody-class-waitlist-remove.mjs"), "utf8");
const bookLib = await readFile(path.join(root, "netlify/functions/mindbody-class-book-lib.mjs"), "utf8");
const classes = await readFile(path.join(root, "src/js/classes-schedule.js"), "utf8");
const member = await readFile(path.join(root, "src/js/member-dashboard.js"), "utf8");
const mbAuth = await readFile(path.join(root, "src/js/mindbody-auth.js"), "utf8");
const loginHtml = await readFile(path.join(root, "src/content/mindbody-login.html"), "utf8");
const stripe = await readFile(path.join(root, "src/js/stripe-express-cta.js"), "utf8");
const stripeCheckout = await readFile(path.join(root, "netlify/functions/stripe-create-checkout-session.mjs"), "utf8");
const mobileExchange = await readFile(path.join(root, "netlify/functions/mindbody-oauth-mobile-exchange.mjs"), "utf8");
const saleCheckout = await readFile(path.join(root, "netlify/functions/mindbody-sale-checkout.mjs"), "utf8");

check("ENABLE_AMARE_STUDIO_OPERATIONS is documented and default-off", envExample.includes("# ENABLE_AMARE_STUDIO_OPERATIONS=0"));
check("local-dev logs studio operations flag", localDev.includes("ENABLE_AMARE_STUDIO_OPERATIONS"));
check("resolveStudioCustomer exists", studio.includes("export async function resolveStudioCustomer"));
check("AMARÉ ops path uses Staff headers", studio.includes('authSource: "amare"') && studio.includes("resolveStaffAuthHeaders"));
check("legacy Mindbody path remains", studio.includes('authSource: "mindbody"') && studio.includes("resolveConsumerClient"));
check("resolver does not read frontend clientId", !studio.includes("queryStringParameters"));
check("member-access exposes studioOperations without clientId", memberAccessFn.includes("studioOperations") && !memberAccessFn.includes("clientId:") && !memberAccessFn.includes('"clientId"'));
check("class-book does not read amare_sess", !book.includes("amare_sess"));
check("class-cancel does not read amare_sess", !cancel.includes("amare_sess"));
check("waitlist-remove does not read amare_sess", !waitlist.includes("amare_sess"));
check("class-book uses resolveStudioCustomer", book.includes("resolveStudioCustomer") && book.includes("amareStaffOnly"));
check("Mindbody book still gates bookingAllowed", book.includes("authSource === \"mindbody\"") && book.includes("bookingAllowed"));
check("AMARÉ book skips Consumer link gate", book.includes("amareStaffOnly") && book.includes('authSource === "amare"'));
check(
  "AMARÉ credit book requests Reservation Confirmation",
  book.includes("amareSendReservationEmail") &&
    book.includes("amareStaffOnly && waitlist !== true") &&
    /tryBookWith\(ctx\.authHeaders, first, "staff", amareSendReservationEmail\)/.test(book),
);
check(
  "AMARÉ waitlist does not request reservation email",
  book.includes("Waitlist stays silent") && book.includes("amareStaffOnly && waitlist !== true"),
);
check(
  "Consumer payment fallback stays SendEmail false",
  book.includes('tryBookWith(staffHeadersForBook, picked, "staff", false)'),
);
check("cancel still requests Mindbody cancellation email", cancel.includes("SendEmail: true"));
check("cancel verifies visit ownership", cancel.includes("visitOwnedByClient") && cancel.includes("visit_not_owned"));
check("waitlist verifies entry ownership", waitlist.includes("waitlistEntryOwnedByClient") && waitlist.includes("waitlist_entry_not_owned"));
check("ownership helpers exist", bookLib.includes("export async function visitOwnedByClient") && bookLib.includes("export async function waitlistEntryOwnedByClient"));
check("classes Book/Cancel/Waitlist use studioOpsActive", classes.includes("function studioOpsActive") && classes.includes("studioOpsActive()"));
check("linked AMARÉ can book without oauthLoggedIn", classes.includes("amareStudioOpsAuthorized") && classes.includes("oauthLoggedIn || amareStudioOpsAuthorized"));
check("Consumer bookingAllowed still exists as a gate", classes.includes("oauthLoggedIn && !oauthBookingAllowed"));
check("guest sign-in keeps Mindbody fallback", classes.includes("Sign in with Mindbody") && classes.includes("unifiedLoginHref"));
check("linked strip has no Mindbody booking requirement", mbAuth.includes("renderAmareLinked") && !/renderAmareLinked[\s\S]{0,400}Studio booking still uses Mindbody/.test(mbAuth));
check("login signed-in copy is provider-neutral", loginHtml.includes("Your AMARÉ account is ready.") && !loginHtml.includes("Booking still uses your studio sign-in"));
check("member cancel uses studioOperations", member.includes("studioOperations") && member.includes("mutationAuthorized"));
check("Stripe express CTA does not use member-access as purchase authority", !stripe.includes("/api/amare/auth/member-access"));
check("Stripe checkout does not use studio-ops mutation resolver", !stripeCheckout.includes("resolveStudioCustomer") && !stripeCheckout.includes("ENABLE_AMARE_STUDIO_OPERATIONS"));
check("Stripe checkout prefills from AMARÉ linked client", stripeCheckout.includes("resolveCommerceCustomer") && stripeCheckout.includes("isPurchaseLinkedState"));
check("Mindbody sale checkout remains Consumer", saleCheckout.includes("resolveConsumerClient") && !saleCheckout.includes("resolveStudioCustomer"));
check("mobile exchange unchanged", !mobileExchange.includes("ENABLE_AMARE_STUDIO_OPERATIONS") && !mobileExchange.includes("resolveStudioCustomer"));

delete process.env.ENABLE_AMARE_AUTH;
delete process.env.ENABLE_AMARE_STUDIO_OPERATIONS;
check("ENABLE_AMARE_STUDIO_OPERATIONS default off", amareStudioOperationsEnabled() === false);

process.env.ENABLE_AMARE_AUTH = "1";
process.env.ENABLE_AMARE_SESS_ISSUE = "1";
process.env.AMARE_SESSION_SECRET = AMARE_SECRET;
process.env.MINDBODY_SESSION_SECRET = MB_SECRET;
process.env.MINDBODY_SITE_ID = "-99";
delete process.env.ENABLE_AMARE_STUDIO_OPERATIONS;
delete process.env.ENABLE_AMARE_MEMBER_READ;
check("ops flag requires explicit enable", amareStudioOperationsEnabled() === false);

process.env.ENABLE_AMARE_STUDIO_OPERATIONS = "1";
check("ops flag requires master flag", amareStudioOperationsEnabled() === true);

const now = Date.now();
const cookie = `${AMARE_SESS_COOKIE}=${encodeURIComponent(
  sealAmareSessPayload({ amare_user_id: userId, at: now, exp: now + 86400000 }, AMARE_SECRET),
)}`;
const findUser = async (id) => (id === userId ? { amare_user_id: userId, status: "active" } : null);
const staffHeaders = { Authorization: "Bearer qa-staff" };

const linkedDeps = {
  findUser,
  getLinkedAssociation: async () => ({ status: "linked", client_id: 84521 }),
  getLatestAssociation: async () => ({ status: "linked", client_id: 84521 }),
  resolveConsumerClient: async () => ({ ok: false, response: { statusCode: 401, body: "no_mb" } }),
  resolveStaffAuthHeaders: async () => staffHeaders,
};

const amareOnly = await resolveStudioCustomer({ headers: { cookie } }, linkedDeps);
check(
  "AMARÉ linked + no mb_sess resolves Staff client",
  amareOnly.ok === true &&
    amareOnly.authSource === "amare" &&
    amareOnly.clientId === 84521 &&
    amareOnly.authHeaders === staffHeaders,
);

const access = await handleAmareAuthMemberAccess({ httpMethod: "GET", headers: { cookie } }, linkedDeps);
const accessBody = JSON.parse(access.body);
check(
  "member-access studioOperations true when linked and flag on",
  access.statusCode === 200 &&
    accessBody.signedIn === true &&
    accessBody.studioAccess === "linked" &&
    accessBody.studioOperations === true &&
    !("clientId" in accessBody),
);

delete process.env.ENABLE_AMARE_STUDIO_OPERATIONS;
const accessOpsOff = await handleAmareAuthMemberAccess({ httpMethod: "GET", headers: { cookie } }, linkedDeps);
const accessOpsOffBody = JSON.parse(accessOpsOff.body);
check(
  "member-access studioOperations false when ops flag off",
  accessOpsOffBody.studioOperations === false,
);

process.env.ENABLE_AMARE_STUDIO_OPERATIONS = "1";
const consumerOnly = await resolveStudioCustomer(
  { headers: { cookie: "" } },
  {
    findUser: async () => null,
    getLinkedAssociation: async () => null,
    resolveConsumerClient: async () => ({
      ok: true,
      clientId: 111,
      authHeaders: { Authorization: "Bearer qa-consumer" },
      session: { bookingAllowed: true },
      email: "mb@example.com",
    }),
    resolveStaffAuthHeaders: async () => staffHeaders,
  },
);
check(
  "Mindbody fallback still resolves when no AMARÉ session",
  consumerOnly.ok === true && consumerOnly.authSource === "mindbody" && consumerOnly.clientId === 111,
);

const aligned = await resolveStudioCustomer(
  { headers: { cookie } },
  {
    ...linkedDeps,
    resolveConsumerClient: async () => ({
      ok: true,
      clientId: 84521,
      authHeaders: { Authorization: "Bearer qa-consumer" },
      session: {},
      email: "same@example.com",
    }),
  },
);
check(
  "dual session same client aligns to AMARÉ ops",
  aligned.ok === true && aligned.authSource === "amare" && aligned.clientId === 84521,
);

const conflicted = await resolveStudioCustomer(
  { headers: { cookie } },
  {
    ...linkedDeps,
    resolveConsumerClient: async () => ({
      ok: true,
      clientId: 99999,
      authHeaders: { Authorization: "Bearer qa-other" },
      session: {},
      email: "other@example.com",
    }),
  },
);
check(
  "dual session different clients conflict",
  conflicted.ok === false && conflicted.reason === "session_conflict" && conflicted.response?.statusCode === 409,
);

const unlinkedShared = await resolveAmareStudioClient(
  {
    headers: {
      cookie: `${cookie}; mb_sess=${encodeURIComponent(sealCookiePayload({ client_id: 111, at: now }, MB_SECRET))}`,
    },
  },
  {
    findUser,
    getLinkedAssociation: async () => null,
    getLatestAssociation: async () => ({ status: "verified", client_id: 84521 }),
  },
);
check(
  "shared computer unlinked AMARÉ + other mb_sess conflicts",
  unlinkedShared.ok === false && unlinkedShared.reason === "session_conflict" && unlinkedShared.clientId == null,
);

const verifiedOnly = await resolveStudioCustomer(
  { headers: { cookie } },
  {
    findUser,
    getLinkedAssociation: async () => null,
    getLatestAssociation: async () => ({ status: "verified", client_id: 84521 }),
    resolveConsumerClient: async () => ({ ok: false, response: { statusCode: 401, body: "no_mb" } }),
    resolveStaffAuthHeaders: async () => staffHeaders,
  },
);
check(
  "verified-only AMARÉ cannot operate",
  verifiedOnly.ok === false && verifiedOnly.reason === "verified_pending_link",
);

restoreEnv(ENV_KEYS);

if (failed) {
  console.error(`\n${failed} AMARÉ studio-ops QA check(s) failed.`);
  process.exit(1);
}
console.log("\nAll AMARÉ studio-ops QA checks passed.");
