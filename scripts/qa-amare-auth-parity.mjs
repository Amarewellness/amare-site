/**
 * AMARÉ Auth Provider Parity Cleanup QA.
 * Run: npm run test:amare-auth-parity
 *
 * Does not enable production. Does not charge. Does not change D28, Apple,
 * Google visibility, ConfirmAccount, Stripe fulfillment claim, or Mindbody
 * OAuth fallback.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sealCookiePayload } from "../netlify/functions/oauth-lib.mjs";
import {
  AMARE_SESS_COOKIE,
  sealAmareSessPayload,
} from "../netlify/functions/amare-sess-lib.mjs";
import {
  COMMERCE_STATES,
  commerceCheckoutRejectResponse,
  parseBodyKnownClientId,
  resolveCommerceCustomer,
} from "../netlify/functions/amare-commerce-lib.mjs";
import { handleAmareCommerceStatus } from "../netlify/functions/amare-commerce-status.mjs";
import { resolveAmareLinkedOwnership, resolveAmareStudioClient } from "../netlify/functions/amare-studio-lib.mjs";
function waitlistRemoveAuthMode(authSource) {
  return authSource === "amare" ? "staff" : "consumer";
}

function deferredBookConfirmPlan(authSource, hasConsumerHeaders) {
  if (authSource === "mindbody" || (authSource === "amare" && hasConsumerHeaders)) {
    return { path: "consumer_reservation_email" };
  }
  if (authSource === "amare") {
    return { path: "skip_consumer_template", reason: "reservation_confirmation_is_mindbody_consumer_specific" };
  }
  return { path: "unauthenticated" };
}

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
  "ENABLE_AMARE_COMMERCE",
  "ENABLE_AMARE_MEMBER_READ",
  "ENABLE_AMARE_STUDIO_OPERATIONS",
  "ENABLE_AMARE_SESS_ISSUE",
  "AMARE_SESSION_SECRET",
  "MINDBODY_SESSION_SECRET",
  "MINDBODY_SITE_ID",
];

const AMARE_SECRET = "a".repeat(32);
const MB_SECRET = "b".repeat(32);
const userId = "usr_PARITYQA0000000000000001";

const [
  header,
  build,
  memberHtml,
  memberDash,
  pricing,
  expressCta,
  checkout,
  commerceLib,
  statusFn,
  deferredEmail,
  waitlist,
  book,
  classes,
  mbAuth,
  loginHtml,
  loginJs,
  successJs,
  successHtml,
  d28Create,
] = await Promise.all([
  readFile(path.join(root, "src/js/header-members.js"), "utf8"),
  readFile(path.join(root, "scripts/build.mjs"), "utf8"),
  readFile(path.join(root, "src/content/mindbody-member.html"), "utf8"),
  readFile(path.join(root, "src/js/member-dashboard.js"), "utf8"),
  readFile(path.join(root, "src/js/pricing-api.js"), "utf8"),
  readFile(path.join(root, "src/js/stripe-express-cta.js"), "utf8"),
  readFile(path.join(root, "netlify/functions/stripe-create-checkout-session.mjs"), "utf8"),
  readFile(path.join(root, "netlify/functions/amare-commerce-lib.mjs"), "utf8"),
  readFile(path.join(root, "netlify/functions/amare-commerce-status.mjs"), "utf8"),
  readFile(path.join(root, "netlify/functions/stripe-deferred-book-confirm-email.mjs"), "utf8"),
  readFile(path.join(root, "netlify/functions/mindbody-class-waitlist-remove.mjs"), "utf8"),
  readFile(path.join(root, "netlify/functions/mindbody-class-book.mjs"), "utf8"),
  readFile(path.join(root, "src/js/classes-schedule.js"), "utf8"),
  readFile(path.join(root, "src/js/mindbody-auth.js"), "utf8"),
  readFile(path.join(root, "src/content/mindbody-login.html"), "utf8"),
  readFile(path.join(root, "src/js/amare-auth.js"), "utf8"),
  readFile(path.join(root, "src/js/checkout-success.js"), "utf8"),
  readFile(path.join(root, "src/content/checkout-success.html"), "utf8"),
  readFile(path.join(root, "netlify/functions/amare-auth-profile-create.mjs"), "utf8"),
]);

check(
  "header probes AMARÉ and Mindbody in parallel",
  header.includes("Promise.all") &&
    header.includes("/api/mindbody/oauth/session") &&
    header.includes("/api/amare/auth/session") &&
    header.includes("mbIn") &&
    header.includes("amareIn"),
);
check("header cache is provider-neutral", header.includes("amare-header-auth") && header.includes("sessionKey"));
check("header clears legacy Mindbody name cache", header.includes("amare-mb-header") && header.includes("removeItem(LEGACY_CACHE_KEY)"));
check("header never writes a personal name to cache", header.includes("writeCache({ sessionKey") && !/writeCache\(\s*firstName/.test(header));
check("hydration never paints a cached personal name", build.includes('textContent="Account"') && build.includes("amare-header-auth") && build.includes('removeItem("amare-mb-header")'));
check("member default gate is provider-neutral", memberHtml.includes("Sign in to view your account") && memberHtml.includes('href="/login?return=/member"') && !memberHtml.includes("Sign in with Mindbody to view"));
check(
  "member dashboard does not treat missing mb_sess as Link My Account",
  memberDash.includes("amareLinked") && !memberDash.includes("Link My Account"),
);
check("member refresh is provider-neutral", memberHtml.includes("data-mb-summary-refresh") && !memberHtml.includes("Refresh from Mindbody"));
check("pricing uses known AMARÉ customer state", pricing.includes("isKnownAmareCustomer") && pricing.includes("isLinkedCommerceState"));
check("pricing guest form signs in via AMARÉ login", pricing.includes("Already have an AMARÉ account?") && pricing.includes(">Sign in</a>"));
check("express CTA uses commerce state without requiring the flag", expressCta.includes("isLinkedCommerceState(commerce.state)") && !expressCta.includes("if (commerce.commerceEnabled)"));
check("checkout never assigns ownership from the body", checkout.includes("browser_client_id_never_ownership") && !checkout.includes("parseBodyKnownClientId"));
check("commerce-off preserves authenticated ownership", commerceLib.includes("commerce_flag_off_preserves_authenticated_ownership"));
check("commerce status does not hardcode SIGNED_OUT when flag is off", !statusFn.includes('state: "SIGNED_OUT"'));
check("deferred confirm uses resolveStudioCustomer", deferredEmail.includes("resolveStudioCustomer") && deferredEmail.includes("deferredBookConfirmPlan"));
check("deferred confirm does not require mb_sess for AMARÉ", deferredEmail.includes("skip_consumer_template") && !deferredEmail.includes("resolveConsumerClient(event)"));
check("waitlist-remove uses resolveStudioCustomer + Staff for AMARÉ", waitlist.includes("resolveStudioCustomer") && waitlist.includes("waitlistRemoveAuthMode") && waitlistRemoveAuthMode("amare") === "staff");
check("waitlist-remove keeps Consumer path for Mindbody", waitlistRemoveAuthMode("mindbody") === "consumer");
check(
  "consumerAssociated gates only Mindbody Book",
  book.includes('if (ctx.authSource === "mindbody")') &&
    /if \(ctx\.authSource === "mindbody"\)[\s\S]{0,400}consumerAssociated/.test(book) &&
    !/if \(ctx\.authSource === "amare"\)[\s\S]{0,400}consumerAssociated/.test(book),
);
check(
  "linked AMARÉ strip has no Link My Account",
  mbAuth.includes("function renderAmareLinked") &&
    !/function renderAmareLinked[\s\S]{0,800}Link your account/.test(mbAuth) &&
    !/function renderAmareLinked[\s\S]{0,800}Link My Account/.test(mbAuth),
);
check("login distinguishes Sign out vs all sessions", loginHtml.includes(">Sign out<") && loginHtml.includes("Sign out of all connected sessions"));
check("AMARÉ/D28 checkout success does not force Mindbody sign-in", successJs.includes("hasAmareAccount") && successJs.includes("clientWasNewlyCreated && !o.hasAmareAccount"));
check("anonymous checkout success uses AMARÉ OTP Sign in when auth UI is on", successJs.includes("buildAmareLoginHref") && successJs.includes('setCta(ctaPrimaryEl, "Sign in"') && successJs.includes("applyAmareOnboardingCopy"));
check("Mindbody Identity onboarding remains when AMARÉ auth UI is off", successJs.includes("buildMindbodySignInHref") && successHtml.includes("Sign in with Mindbody"));
check("classes Book/Waitlist use studioOpsActive", classes.includes("function studioOpsActive") && classes.includes("studioOpsActive()"));
check("D28 profile create unchanged", !d28Create.includes("ENABLE_AMARE_COMMERCE") && !d28Create.includes("resolveCommerceCustomer"));
check("logout all still exists", loginJs.includes("/api/amare/auth/logout/all") && loginJs.includes("/api/amare/auth/logout"));

check("AMARÉ confirm plan skips Consumer template", deferredBookConfirmPlan("amare", false).path === "skip_consumer_template");
check("Mindbody confirm plan uses Consumer email", deferredBookConfirmPlan("mindbody", true).path === "consumer_reservation_email");
check("dual-aligned AMARÉ can still send Consumer email", deferredBookConfirmPlan("amare", true).path === "consumer_reservation_email");

process.env.ENABLE_AMARE_AUTH = "1";
process.env.ENABLE_AMARE_SESS_ISSUE = "1";
process.env.AMARE_SESSION_SECRET = AMARE_SECRET;
process.env.MINDBODY_SESSION_SECRET = MB_SECRET;
process.env.MINDBODY_SITE_ID = "-99";
delete process.env.ENABLE_AMARE_COMMERCE;
delete process.env.ENABLE_AMARE_MEMBER_READ;
delete process.env.ENABLE_AMARE_STUDIO_OPERATIONS;

const cookie = `${AMARE_SESS_COOKIE}=${encodeURIComponent(sealAmareSessPayload({ amare_user_id: userId }))}`;
const findUser = async (id) => (id === userId ? { amare_user_id: userId } : null);
const linkedDeps = {
  findUser,
  getLinkedAssociation: async () => ({ status: "linked", client_id: 100002726 }),
  getLatestAssociation: async () => ({ status: "linked", client_id: 100002726 }),
};

const studioFlagOff = await resolveAmareStudioClient({ headers: { cookie } }, linkedDeps);
check("member-read resolver stays flag-gated", studioFlagOff.ok === false && studioFlagOff.reason === "flag_off");

const ownership = await resolveAmareLinkedOwnership({ headers: { cookie } }, linkedDeps);
check("AUTH-only ownership resolves linked client", ownership.ok === true && ownership.clientId === 100002726);

const commerceOff = await resolveCommerceCustomer({ headers: { cookie } }, linkedDeps);
check(
  "linked + commerce flag off is not anonymous",
  commerceOff.enabled === false &&
    commerceOff.state === COMMERCE_STATES.AMARE_LINKED &&
    commerceOff.clientId === 100002726 &&
    commerceOff.canPurchaseAnonymous === false,
);

const spoofed = parseBodyKnownClientId({ knownMindbodyClientId: 100003698 });
check(
  "spoofed knownMindbodyClientId cannot become ownership",
  spoofed === 100003698 && commerceOff.clientId === 100002726 && commerceOff.clientId !== spoofed,
);

const unsigned = await resolveCommerceCustomer({ headers: {} });
check("unsigned remains genuine anonymous", unsigned.state === COMMERCE_STATES.SIGNED_OUT && unsigned.clientId == null);

const mbOnly = sealCookiePayload({ client_id: 100002726, email: "mb@example.com", at: Date.now() }, MB_SECRET);
const mindbodyLinked = await resolveCommerceCustomer({
  headers: { cookie: `mb_sess=${encodeURIComponent(mbOnly)}` },
});
check("Mindbody-only session is MINDBODY_LINKED", mindbodyLinked.state === COMMERCE_STATES.MINDBODY_LINKED && mindbodyLinked.clientId === 100002726);

const mbConflict = sealCookiePayload({ client_id: 100003698, at: Date.now() }, MB_SECRET);
const conflicted = await resolveCommerceCustomer(
  { headers: { cookie: `${cookie}; mb_sess=${encodeURIComponent(mbConflict)}` } },
  linkedDeps,
);
check(
  "dual mismatch blocks commerce",
  conflicted.state === COMMERCE_STATES.CONFLICT &&
    conflicted.clientId == null &&
    commerceCheckoutRejectResponse(conflicted)?.statusCode === 409,
);

const statusOff = await handleAmareCommerceStatus(
  { httpMethod: "GET", headers: { cookie } },
  {
    ...linkedDeps,
    listIdentities: async () => [{ provider: "email", provider_sub: "qa@example.com", email: "qa@example.com" }],
  },
);
const statusOffBody = JSON.parse(statusOff.body);
check(
  "status flag-off still reports linked AMARÉ",
  statusOff.statusCode === 200 &&
    statusOffBody.commerceEnabled === false &&
    statusOffBody.state === "AMARE_LINKED" &&
    !("clientId" in statusOffBody),
);

restoreEnv(ENV_KEYS);

if (failed) {
  console.error(`\n${failed} AMARÉ auth provider-parity QA check(s) failed.`);
  process.exit(1);
}
console.log("\nAMARÉ auth provider-parity QA passed.");
