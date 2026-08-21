/**
 * AMARÉ provider-neutral commerce QA.
 * Run: npm run test:amare-commerce
 *
 * Does not enable production. Does not charge. Does not touch Apple / mobile
 * auth / ConfirmAccount / Mindbody Notifications.
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
  amareCommerceEnabled,
  bodyHasBrowserClientId,
  commerceCheckoutRejectResponse,
  commercePublicStatus,
  COMMERCE_STATES,
  isSafeCommerceSku,
  maskCommerceEmail,
  parseBodyKnownClientId,
  pickStripeCustomerFromCandidates,
  resolveCommerceCustomer,
  SAFE_COMMERCE_SKUS,
} from "../netlify/functions/amare-commerce-lib.mjs";
import { handleAmareCommerceStatus } from "../netlify/functions/amare-commerce-status.mjs";
import { decideKnownClientTrust } from "../netlify/functions/stripe-mindbody-sync-lib.mjs";

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
const userId = "usr_COMMERCEQA00000000000001";

const [
  envExample,
  toml,
  localDev,
  pricing,
  stripeCta,
  checkout,
  webhook,
  syncLib,
  commerceLib,
  statusFn,
  book,
  d28Create,
  mobileExchange,
  appleLib,
  confirmAccountSearch,
] = await Promise.all([
  readFile(path.join(root, ".env.example"), "utf8"),
  readFile(path.join(root, "netlify.toml"), "utf8"),
  readFile(path.join(root, "scripts/unified-local-dev.mjs"), "utf8"),
  readFile(path.join(root, "src/js/pricing-api.js"), "utf8"),
  readFile(path.join(root, "src/js/stripe-express-cta.js"), "utf8"),
  readFile(path.join(root, "netlify/functions/stripe-create-checkout-session.mjs"), "utf8"),
  readFile(path.join(root, "netlify/functions/stripe-webhook.mjs"), "utf8"),
  readFile(path.join(root, "netlify/functions/stripe-mindbody-sync-lib.mjs"), "utf8"),
  readFile(path.join(root, "netlify/functions/amare-commerce-lib.mjs"), "utf8"),
  readFile(path.join(root, "netlify/functions/amare-commerce-status.mjs"), "utf8"),
  readFile(path.join(root, "netlify/functions/mindbody-class-book.mjs"), "utf8"),
  readFile(path.join(root, "netlify/functions/amare-auth-profile-create.mjs"), "utf8"),
  readFile(path.join(root, "netlify/functions/mindbody-oauth-mobile-exchange.mjs"), "utf8"),
  readFile(path.join(root, "netlify/functions/amare-identity-policy.mjs"), "utf8"),
  readFile(path.join(root, "netlify/functions/amare-auth-profile-lib.mjs"), "utf8"),
]);

check("ENABLE_AMARE_COMMERCE is documented and default-off", envExample.includes("# ENABLE_AMARE_COMMERCE=0"));
check("recurring production flags stay off", envExample.includes("ENABLE_STRIPE_RECURRING_CHECKOUT=0") && envExample.includes("ENABLE_STRIPE_RECURRING_CHECKOUT_FRONTEND=0"));
check("commerce route is wired", toml.includes("/api/amare/commerce/status") && localDev.includes("/api/amare/commerce/status"));
check(
  "app catalog route is wired",
  toml.includes("/api/amare/commerce/catalog") && localDev.includes("/api/amare/commerce/catalog"),
);
check("commerce flag requires ENABLE_AMARE_AUTH", commerceLib.includes("amareAuthEnabled()") && commerceLib.includes("ENABLE_AMARE_COMMERCE"));
check("compatibility documents ignore browser ids", commerceLib.includes("Browser-supplied knownMindbodyClientId") && checkout.includes("browser_client_id_never_ownership"));

delete process.env.ENABLE_AMARE_AUTH;
delete process.env.ENABLE_AMARE_COMMERCE;
check("ENABLE_AMARE_COMMERCE default off", amareCommerceEnabled() === false);

process.env.ENABLE_AMARE_COMMERCE = "1";
check("commerce flag alone is not enough", amareCommerceEnabled() === false);

process.env.ENABLE_AMARE_AUTH = "1";
check("commerce flag on with auth", amareCommerceEnabled() === true);

check("safe SKU allowlist includes packs and monthlies", isSafeCommerceSku("pack_10_classes") && isSafeCommerceSku("monthly_5") && !isSafeCommerceSku("https://evil.example"));
check("NCS sku is allowlisted", SAFE_COMMERCE_SKUS.includes("new_client_special_3_for_65"));
check("email mask hides local part", maskCommerceEmail("snir@pic-smart.com") === "sn***@pic-smart.com");
check("browser clientId fields detected", bodyHasBrowserClientId({ knownMindbodyClientId: 99 }) && bodyHasBrowserClientId({ client_id: "12" }));
check("legacy body parser still works", parseBodyKnownClientId({ knownMindbodyClientId: "84521" }) === 84521);

const picker = pickStripeCustomerFromCandidates(
  [
    { id: "cus_b", metadata: { mindbodyClientId: "10" }, created: 20 },
    { id: "cus_a", metadata: { mindbodyClientId: "10" }, created: 10, hasActiveSubscription: true },
  ],
  10,
);
check("Stripe picker prefers exact metadata + active sub", picker.customer?.id === "cus_a" && picker.duplicates === true);

const pickerOldest = pickStripeCustomerFromCandidates(
  [
    { id: "cus_z", metadata: { mindbodyClientId: "10" }, created: 50 },
    { id: "cus_y", metadata: { mindbodyClientId: "10" }, created: 5 },
  ],
  10,
);
check("Stripe picker is deterministic on duplicates", pickerOldest.customer?.id === "cus_y" && pickerOldest.reason === "exact_metadata_oldest");

check(
  "trusted known client ignores email mismatch",
  decideKnownClientTrust({
    knownId: 100,
    requestEmail: "otp@example.com",
    rowExists: true,
    rowEmail: "legacy@example.com",
    trustKnownClientId: true,
  }).use === true,
);
check(
  "trusted missing client blocks AddClient",
  decideKnownClientTrust({
    knownId: 100,
    requestEmail: "otp@example.com",
    rowExists: false,
    trustKnownClientId: true,
  }).blockCreate === true,
);
check(
  "legacy email mismatch still falls through",
  decideKnownClientTrust({
    knownId: 100,
    requestEmail: "otp@example.com",
    rowExists: true,
    rowEmail: "legacy@example.com",
    trustKnownClientId: false,
  }).use === false,
);

check("pricing uses commerce status not mb_sess-only", pricing.includes("fetchCommerceStatus") && pricing.includes("isLinkedCommerceState"));
check("linked AMARÉ skips identity form", pricing.includes("showLinkedCommercePurchaseDialog") && pricing.includes("Continue to Express checkout"));
const linkedDialogFn = pricing.slice(
  pricing.indexOf("function showLinkedCommercePurchaseDialog"),
  pricing.indexOf("function showCommerceRecoveryDialog"),
);
check(
  "linked AMARÉ has no Mindbody CTA in linked dialog",
  linkedDialogFn.includes("showLinkedCommercePurchaseDialog") && !linkedDialogFn.includes("Sign in with Mindbody"),
);
check("signed-out guest form retained", pricing.includes("function showExpressDetailsDialog") && pricing.includes('name="firstName"') && pricing.includes("Sign in with Mindbody"));
check("needs_profile does not become anonymous", pricing.includes("commerce_needs_profile") && pricing.includes("Complete your AMARÉ profile"));
check("candidate does not create client", pricing.includes("commerce_claim_required") && pricing.includes("Confirm your studio profile"));
check("conflict blocks purchase", pricing.includes("session_conflict") && pricing.includes("two different studio accounts"));
check("pricing never posts browser clientId as ownership", !pricing.includes("payload.knownMindbodyClientId") && pricing.includes("isKnownAmareCustomer"));
check("monthly linked skips mb_sess gate", pricing.includes("commerceLinkedForMembership") && pricing.includes("amare_commerce"));
check("recurring frontend remains flag-gated", pricing.includes("stripeRecurringCfg.enabled"));

check("create-session never uses body clientId as ownership", checkout.includes("browser_client_id_never_ownership") && !checkout.includes("parseBodyKnownClientId"));
check("create-session uses resolveCommerceCustomer", checkout.includes("resolveCommerceCustomer"));
check("NCS uses server clientId", checkout.includes("ncsDuplicateDryRun") && checkout.includes("knownMindbodyClientId"));
check("trusted linked client avoids AddClient", checkout.includes("trustKnownClientId") && syncLib.includes("trusted_client_unresolved"));
check("Stripe customer search by Studio metadata", checkout.includes("metadata['mindbodyClientId']"));
check("checkout metadata includes amareUserId after server resolve", checkout.includes("metadata.amareUserId") && checkout.includes("amareUserId: commerceCustomer?.amareUserId"));
check("webhook trusts stored order clientId", webhook.includes("trustKnownClientId: trustedOrderClientId != null"));
check("webhook still noops on mindbody_synced", webhook.includes('order.mindbodySyncStatus === "mindbody_synced"') && webhook.includes("noop: true"));
const onetimeFulfill = await readFile(path.join(root, "netlify/functions/stripe-onetime-fulfillment.mjs"), "utf8");
check("webhook claims one-time fulfillment before CheckoutShoppingCart", webhook.includes("fulfillOneTimeMindbodySale") && onetimeFulfill.includes("claimOneTimeFulfillment"));
check("one-time unknown does not auto-retry cart", onetimeFulfill.includes("mindbody_sync_unknown") && onetimeFulfill.includes("isUncertainPostRequestFailure"));
const listenLocal = await readFile(path.join(root, "scripts/start-stripe-listen-local.mjs"), "utf8");
check("managed stripe listen warns on a second process", listenLocal.includes("stripe_listen_multiple_managed_listeners") && listenLocal.includes("amare-stripe-listen-local.lock"));
check("status endpoint omits clientId", statusFn.includes("commercePublicStatus") && !statusFn.includes("clientId:") && !statusFn.includes("client_id"));

check("D28 profile create unchanged by commerce import", !d28Create.includes("resolveCommerceCustomer") && !d28Create.includes("ENABLE_AMARE_COMMERCE"));
check("Book still uses resolveStudioCustomer", book.includes("resolveStudioCustomer"));
check("mobile exchange unchanged", !mobileExchange.includes("ENABLE_AMARE_COMMERCE") && !mobileExchange.includes("resolveCommerceCustomer"));
check("Apple policy file unchanged by commerce", !appleLib.includes("ENABLE_AMARE_COMMERCE"));
check("ConfirmAccount / profile-lib not commerce-gated", !confirmAccountSearch.includes("ENABLE_AMARE_COMMERCE"));
check("email opt-in helper is not rewritten", syncLib.includes("export async function ensureStudioClientTransactionalEmailOptIn") && syncLib.includes("mindbody_client_transactional_email_opt_in"));
check("mb_sess cookie name unchanged", commerceLib.includes("parseCookies(cookieHeader || \"\").mb_sess") && !commerceLib.includes("mb_sess="));

process.env.ENABLE_AMARE_AUTH = "1";
process.env.ENABLE_AMARE_COMMERCE = "1";
process.env.ENABLE_AMARE_MEMBER_READ = "1";
process.env.ENABLE_AMARE_SESS_ISSUE = "1";
process.env.AMARE_SESSION_SECRET = AMARE_SECRET;
process.env.MINDBODY_SESSION_SECRET = MB_SECRET;
process.env.MINDBODY_SITE_ID = "-99";

const cookie = `${AMARE_SESS_COOKIE}=${encodeURIComponent(sealAmareSessPayload({ amare_user_id: userId }))}`;
const findUser = async (id) => (id === userId ? { amare_user_id: userId } : null);

const signedOut = await resolveCommerceCustomer({ headers: {} });
check("signed-out is anonymous", signedOut.state === COMMERCE_STATES.SIGNED_OUT && signedOut.canPurchaseAnonymous === true && signedOut.clientId == null);

const linked = await resolveCommerceCustomer(
  { headers: { cookie } },
  {
    findUser,
    getLinkedAssociation: async () => ({ status: "linked", client_id: 84521 }),
    getLatestAssociation: async () => ({ status: "linked", client_id: 84521 }),
  },
);
check("linked amare recognized", linked.state === COMMERCE_STATES.AMARE_LINKED && linked.clientId === 84521 && linked.amareUserId === userId);

const mbAlign = sealCookiePayload({ client_id: 84521, at: Date.now() }, MB_SECRET);
const aligned = await resolveCommerceCustomer(
  { headers: { cookie: `${cookie}; mb_sess=${encodeURIComponent(mbAlign)}` } },
  {
    findUser,
    getLinkedAssociation: async () => ({ status: "linked", client_id: 84521 }),
  },
);
check("dual-session aligned", aligned.state === COMMERCE_STATES.DUAL_ALIGNED && aligned.clientId === 84521);

const mbConflict = sealCookiePayload({ client_id: 99999, at: Date.now() }, MB_SECRET);
const conflicted = await resolveCommerceCustomer(
  { headers: { cookie: `${cookie}; mb_sess=${encodeURIComponent(mbConflict)}` } },
  {
    findUser,
    getLinkedAssociation: async () => ({ status: "linked", client_id: 84521 }),
  },
);
check(
  "dual-session conflict blocks checkout",
  conflicted.state === COMMERCE_STATES.CONFLICT &&
    conflicted.clientId == null &&
    commerceCheckoutRejectResponse(conflicted)?.statusCode === 409,
);

const needsProfile = await resolveCommerceCustomer(
  { headers: { cookie } },
  {
    findUser,
    getLinkedAssociation: async () => null,
    getLatestAssociation: async () => ({ status: "unlinked", block_reason: "staff_zero_match" }),
  },
);
check("needs_profile is not anonymous", needsProfile.state === COMMERCE_STATES.NEEDS_PROFILE && needsProfile.canPurchaseAnonymous === false);

const candidate = await resolveCommerceCustomer(
  { headers: { cookie } },
  {
    findUser,
    getLinkedAssociation: async () => null,
    getLatestAssociation: async () => ({ status: "candidate" }),
  },
);
check("candidate does not create client", candidate.state === COMMERCE_STATES.CANDIDATE && candidate.clientId == null);

const ambiguous = await resolveCommerceCustomer(
  { headers: { cookie } },
  {
    findUser,
    getLinkedAssociation: async () => null,
    getLatestAssociation: async () => ({ status: "ambiguous" }),
  },
);
check("ambiguous does not create client", ambiguous.state === COMMERCE_STATES.AMBIGUOUS && ambiguous.clientId == null);

const mbOnly = sealCookiePayload({ client_id: 777, email: "mb@example.com", at: Date.now() }, MB_SECRET);
const mindbodyLinked = await resolveCommerceCustomer({
  headers: { cookie: `mb_sess=${encodeURIComponent(mbOnly)}` },
});
check("existing mb_sess is MINDBODY_LINKED", mindbodyLinked.state === COMMERCE_STATES.MINDBODY_LINKED && mindbodyLinked.clientId === 777);

const publicLinked = commercePublicStatus(linked, { maskedEmail: "qa***@example.com" });
check("public status omits clientId", !("clientId" in publicLinked) && !("client_id" in publicLinked) && publicLinked.state === "AMARE_LINKED");

const statusLinked = await handleAmareCommerceStatus(
  { httpMethod: "GET", headers: { cookie } },
  {
    findUser,
    getLinkedAssociation: async () => ({ status: "linked", client_id: 84521 }),
    getLatestAssociation: async () => ({ status: "linked", client_id: 84521 }),
    listIdentities: async () => [{ provider: "email", provider_sub: "qa@example.com", email: "qa@example.com" }],
  },
);
const statusBody = JSON.parse(statusLinked.body);
check(
  "commerce status linked omits clientId",
  statusLinked.statusCode === 200 &&
    statusBody.commerceEnabled === true &&
    statusBody.state === "AMARE_LINKED" &&
    !("clientId" in statusBody) &&
    !("client_id" in statusBody),
);

delete process.env.ENABLE_AMARE_COMMERCE;
const statusOff = await handleAmareCommerceStatus(
  { httpMethod: "GET", headers: { cookie } },
  {
    findUser,
    getLinkedAssociation: async () => ({ status: "linked", client_id: 84521 }),
    getLatestAssociation: async () => ({ status: "linked", client_id: 84521 }),
    listIdentities: async () => [{ provider: "email", provider_sub: "qa@example.com", email: "qa@example.com" }],
  },
);
const statusOffBody = JSON.parse(statusOff.body);
check(
  "commerce flag off preserves linked ownership",
  statusOff.statusCode === 200 &&
    statusOffBody.commerceEnabled === false &&
    statusOffBody.state === "AMARE_LINKED" &&
    statusOffBody.signedIn === true &&
    statusOffBody.studioAccess === "linked",
);

const offLinked = await resolveCommerceCustomer(
  { headers: { cookie } },
  {
    findUser,
    getLinkedAssociation: async () => ({ status: "linked", client_id: 84521 }),
    getLatestAssociation: async () => ({ status: "linked", client_id: 84521 }),
  },
);
check(
  "commerce-off linked is not anonymous",
  offLinked.enabled === false &&
    offLinked.state === COMMERCE_STATES.AMARE_LINKED &&
    offLinked.clientId === 84521 &&
    offLinked.canPurchaseAnonymous === false,
);
check(
  "commerce-off spoofed body id is not ownership",
  parseBodyKnownClientId({ knownMindbodyClientId: 99999999 }) === 99999999 &&
    offLinked.clientId === 84521 &&
    offLinked.clientId !== 99999999,
);

delete process.env.ENABLE_AMARE_MEMBER_READ;
delete process.env.ENABLE_AMARE_STUDIO_OPERATIONS;
const offNoMemberRead = await resolveCommerceCustomer(
  { headers: { cookie } },
  {
    findUser,
    getLinkedAssociation: async () => ({ status: "linked", client_id: 84521 }),
    getLatestAssociation: async () => ({ status: "linked", client_id: 84521 }),
  },
);
check(
  "commerce-off + member-read off still resolves linked client",
  offNoMemberRead.state === COMMERCE_STATES.AMARE_LINKED && offNoMemberRead.clientId === 84521,
);

const unsignedSpoof = await resolveCommerceCustomer({ headers: {} });
check(
  "unsigned + spoofed clientId stays anonymous",
  unsignedSpoof.state === COMMERCE_STATES.SIGNED_OUT &&
    unsignedSpoof.clientId == null &&
    unsignedSpoof.canPurchaseAnonymous === true,
);

delete process.env.ENABLE_AMARE_AUTH;
const statusAuthOff = await handleAmareCommerceStatus({ httpMethod: "GET", headers: {} });
check("commerce status 404 when auth off", statusAuthOff.statusCode === 404);

check("home/first-visit CTA uses commerce status", stripeCta.includes("/api/amare/commerce/status"));
check("home/first-visit still has guest form", stripeCta.includes("function showExpressDetailsDialog") && stripeCta.includes("Sign in with Mindbody"));
check(
  "create-session app origins return to site checkout pages",
  checkout.includes("function hostedCheckoutReturnOrigin") && checkout.includes("isAppOrLoopbackOrigin"),
);
check("create-session still does not handle payment_intent.succeeded", !checkout.includes("payment_intent.succeeded"));

const { handleAmareCommerceCatalog } = await import("../netlify/functions/amare-commerce-catalog.mjs");
const catalogRes = handleAmareCommerceCatalog({ httpMethod: "GET", headers: {} });
const catalogBody = JSON.parse(catalogRes.body || "{}");
const catalogSkus = (catalogBody.groups || []).flatMap((g) => (g.items || []).map((i) => i.localSku));
check("catalog endpoint returns 200", catalogRes.statusCode === 200 && catalogBody.ok === true);
check(
  "catalog includes one-time and monthly allowlist",
  catalogSkus.includes("new_client_special_3_for_65") &&
    catalogSkus.includes("drop_in_single_class") &&
    catalogSkus.includes("drop_in_same_day") &&
    catalogSkus.includes("pack_10_classes") &&
    catalogSkus.includes("pack_20_classes") &&
    catalogSkus.includes("monthly_5") &&
    catalogSkus.includes("monthly_8") &&
    catalogSkus.includes("monthly_unlimited"),
);
check("catalog omits disabled 5-pack", !catalogSkus.includes("pack_5_classes"));
check("catalog omits member top-up from public/app groups", !catalogSkus.includes("monthly_member_topup"));
check(
  "catalog prices are server integers",
  (catalogBody.groups || []).every((g) =>
    (g.items || []).every((i) => Number.isInteger(i.amountCents) && i.amountCents > 0),
  ),
);

restoreEnv(ENV_KEYS);

if (failed) {
  console.error(`\n${failed} AMARÉ commerce QA check(s) failed.`);
  process.exit(1);
}
console.log("\nAMARÉ provider-neutral commerce QA passed.");
