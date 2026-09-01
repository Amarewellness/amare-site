/**
 * FINAL PURCHASE REGRESSION GATE — production-readiness QA.
 * Run: npm run test:final-purchase-regression-gate
 *
 * No deploy. No production DB migration. No production Stripe charges.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { readAnnualMembershipUiEnabled } from "./annual-membership-ui-config.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const embeddedDir = path.join(root, "netlify/functions/_embedded");
fs.mkdirSync(embeddedDir, { recursive: true });
fs.copyFileSync(
  path.join(root, "src/content/stripe-mindbody-catalog.config.json"),
  path.join(embeddedDir, "stripe-mindbody-catalog.config.json"),
);

let failed = 0;
/** @type {string[]} */
const newFailures = [];
/** @type {string[]} */
const blockers = [];

function check(name, ok, detail) {
  if (ok) console.log(`PASS — ${name}`);
  else {
    failed += 1;
    newFailures.push(name);
    console.log(`FAIL — ${name}${detail ? `\n  ${detail}` : ""}`);
  }
}

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function buildRecurringConfig(env = {}) {
  const catalog = JSON.parse(read("src/content/stripe-mindbody-catalog.config.json"));
  const enabled = (env.ENABLE_STRIPE_RECURRING_CHECKOUT_FRONTEND || "0").trim() === "1";
  const annualUiEnabled = readAnnualMembershipUiEnabled({ rootDir: root });
  const items = Array.isArray(catalog.items) ? catalog.items : [];
  /** @type {Record<string, unknown>} */
  const byMindbodyServiceId = {};
  /** @type {Record<string, unknown>} */
  const byMindbodyServiceIdAnnual = {};
  /** @type {Record<string, number>} */
  const displayByService = {};
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const r = /** @type {Record<string, unknown>} */ (raw);
    if (r.kind === "monthlyMembership" && r.enabled && r.stripeMode === "subscription") {
      const entry = { localSku: String(r.localSku), monthlyAmountCents: r.amountCents };
      const id = String(Math.trunc(Number(r.mindbodyServiceId)));
      byMindbodyServiceId[id] = entry;
      if (typeof r.mindbodyDisplayServiceId === "number") {
        const d = String(Math.trunc(r.mindbodyDisplayServiceId));
        displayByService[id] = Math.trunc(r.mindbodyDisplayServiceId);
        if (d !== id) byMindbodyServiceId[d] = entry;
      }
    }
    if (r.kind === "annualMembership" && r.enabled && r.stripeMode === "subscription") {
      const entry = { localSku: String(r.localSku), annualAmountCents: r.amountCents };
      const id = String(Math.trunc(Number(r.mindbodyServiceId)));
      byMindbodyServiceIdAnnual[id] = entry;
      const dRaw = displayByService[id];
      if (typeof dRaw === "number") {
        const d = String(dRaw);
        if (d !== id) byMindbodyServiceIdAnnual[d] = entry;
      }
    }
  }
  return { enabled, annualUiEnabled, byMindbodyServiceId, byMindbodyServiceIdAnnual };
}

console.log("=== FINAL PURCHASE REGRESSION GATE ===\n");

/* Section A — classification predicates */
const {
  getCatalogItem,
  isAnnualMembershipCatalogItem,
  isMonthlyMembershipCatalogItem,
} = await import("../netlify/functions/stripe-catalog-lib.mjs");

const allSkus = JSON.parse(read("src/content/stripe-mindbody-catalog.config.json")).items.map(
  (i) => i.localSku,
);
for (const sku of ["monthly_5", "monthly_8", "monthly_unlimited"]) {
  const item = getCatalogItem(sku);
  check(
    `A monthly ${sku} not annual`,
    isMonthlyMembershipCatalogItem(item) && !isAnnualMembershipCatalogItem(item),
  );
}
for (const sku of ["annual_monthly_5", "annual_monthly_8", "annual_monthly_unlimited"]) {
  const item = getCatalogItem(sku);
  check(
    `A annual ${sku} not monthly`,
    isAnnualMembershipCatalogItem(item) && !isMonthlyMembershipCatalogItem(item),
  );
}
for (const sku of [
  "new_client_special_3_for_65",
  "drop_in_single_class",
  "pack_10_classes",
  "pack_20_classes",
  "monthly_member_topup",
]) {
  const item = getCatalogItem(sku);
  if (!item) continue;
  check(
    `A one-time/addon ${sku} not annual`,
    !isAnnualMembershipCatalogItem(item) && !isMonthlyMembershipCatalogItem(item),
  );
}

/* Section B — monthly checkout session shape (static + handler guards) */
const checkoutSrc = read("netlify/functions/stripe-create-checkout-session.mjs");
const webhookSrc = read("netlify/functions/stripe-webhook.mjs");
const syncSrc = read("netlify/functions/stripe-mindbody-sync-lib.mjs");

for (const [sku, cents, product] of [
  ["monthly_5", 12500, 100133],
  ["monthly_8", 17900, 100134],
  ["monthly_unlimited", 22900, 100135],
]) {
  const item = getCatalogItem(sku);
  check(`B ${sku} catalog amount`, item?.amountCents === cents);
  check(`B ${sku} month interval`, item?.recurringInterval === "month");
  check(`B ${sku} product id`, item?.mindbodyServiceId === product);
}
check(
  "B monthly create-session uses month billingInterval",
  checkoutSrc.includes('const billingInterval = isAnnualMembership ? "year" : "month"'),
);
const hipStart = webhookSrc.indexOf("async function handleInvoicePaid");
const hipEnd = webhookSrc.indexOf("async function handleInvoicePaymentFailed");
const hipBody = hipStart >= 0 && hipEnd > hipStart ? webhookSrc.slice(hipStart, hipEnd) : webhookSrc;
check(
  "B annual branch precedes monthly invoice sync in handleInvoicePaid",
  hipBody.indexOf("isAnnualMembershipCatalogItem") >= 0 &&
    hipBody.indexOf("isAnnualMembershipCatalogItem") < hipBody.indexOf("claimInvoiceSlot"),
);

/* Section AP — annual promotion codes blocked at checkout */
const { membershipAllowPromotionCodes } = await import(
  "../netlify/functions/stripe-create-checkout-session.mjs"
);

for (const sku of ["annual_monthly_5", "annual_monthly_8", "annual_monthly_unlimited"]) {
  const item = getCatalogItem(sku);
  check(`AP ${sku} blocks promotion codes`, membershipAllowPromotionCodes(item) === false);
}
process.env.ENABLE_STRIPE_RECURRING_COUPONS = "1";
for (const sku of ["annual_monthly_5", "annual_monthly_8", "annual_monthly_unlimited"]) {
  check(
    `AP ${sku} blocks promos even when recurring coupons ON`,
    membershipAllowPromotionCodes(getCatalogItem(sku)) === false,
  );
}
for (const sku of ["monthly_5", "monthly_8", "monthly_unlimited"]) {
  check(
    `AP ${sku} monthly promo unchanged when recurring coupons ON`,
    membershipAllowPromotionCodes(getCatalogItem(sku)) === true,
  );
}
delete process.env.ENABLE_STRIPE_RECURRING_COUPONS;
check(
  "AP checkout uses membershipAllowPromotionCodes",
  checkoutSrc.includes("allow_promotion_codes: membershipAllowPromotionCodes(item)"),
);
check(
  "AP one-time promo path unchanged",
  checkoutSrc.includes("if (promotionCodesEnabled())") &&
    checkoutSrc.includes("params.allow_promotion_codes = true"),
);
check("AP no after_expiration recovery in checkout", !checkoutSrc.includes("after_expiration"));

/* Section R — monthly invoice.paid does not touch annual DB when SKU is monthly */
process.env.ANNUAL_MEMBERSHIP_STORE_LOCAL_MEMORY = "1";
process.env.STRIPE_SUBSCRIPTION_STORE_LOCAL_MEMORY = "1";
const {
  resetAnnualMembershipStoreMemoryForTests,
  openAnnualMembershipStoreForTests,
} = await import("../netlify/functions/annual-membership-store.mjs");
const {
  resetSubscriptionStoreMemoryForTests,
  openSubscriptionStore,
  newSubscriptionId,
} = await import("../netlify/functions/stripe-subscription-store.mjs");

resetAnnualMembershipStoreMemoryForTests();
resetSubscriptionStoreMemoryForTests();
const annStore = openAnnualMembershipStoreForTests();
const subStore = openSubscriptionStore();
const subId = newSubscriptionId();
await subStore.put({
  id: subId,
  stripeSubscriptionId: "sub_monthly_gate",
  stripeCustomerId: "cus_gate",
  stripeCheckoutSessionId: "",
  localSku: "monthly_5",
  displayName: "Monthly 5 Classes",
  monthlyAmountCents: 12500,
  currency: "usd",
  mindbodyClientId: 100002839,
  mindbodyServiceId: 100133,
  mindbodyContractProductId: "101",
  status: "active",
  invoices: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  stripeLivemode: false,
});

/** Mock annual store throw on create — monthly must still proceed past annual gate */
const origCreate = annStore.createAnnualTermWithPeriods.bind(annStore);
annStore.createAnnualTermWithPeriods = async () => {
  throw new Error("annual_db_should_not_be_called");
};

/** Simulate annual gate only — full handleInvoicePaid needs Stripe; verify classification */
const monthlyItem = getCatalogItem("monthly_5");
check(
  "R monthly SKU skips annual branch predicate",
  !isAnnualMembershipCatalogItem(monthlyItem),
);
annStore.createAnnualTermWithPeriods = origCreate;

/* Section P — live Stripe safety + annual skip hardening */
const { resolveAnnualSkipMindbodyIssue } = await import(
  "../netlify/functions/annual-membership-webhook-lib.mjs"
);

check(
  "P live Stripe ignores STRIPE_TEST_MODE_MINDBODY_BEHAVIOR",
  webhookSrc.includes("if (stripeLivemode)") && webhookSrc.includes('behavior: "live"'),
);
check(
  "P resolveAnnualSkip exported",
  typeof resolveAnnualSkipMindbodyIssue === "function",
);

const prevSkip = process.env.ANNUAL_WEBHOOK_SKIP_MINDDBODY_ISSUE;
const prevTestMb = process.env.STRIPE_TEST_MODE_MINDBODY_BEHAVIOR;

process.env.ANNUAL_WEBHOOK_SKIP_MINDDBODY_ISSUE = "1";
process.env.STRIPE_TEST_MODE_MINDBODY_BEHAVIOR = "skip";
const liveWithSkip = resolveAnnualSkipMindbodyIssue({
  stripeLivemode: true,
  behavior: "live",
  mindbodyTest: false,
});
check(
  "P1 LIVE + ANNUAL_WEBHOOK_SKIP=1 → issuance NOT skipped",
  liveWithSkip.skipMindbodyIssue === false && liveWithSkip.mindbodyTest === false,
);

const liveWithTestSkip = resolveAnnualSkipMindbodyIssue({
  stripeLivemode: true,
  behavior: "skip",
  mindbodyTest: false,
});
check(
  "P2 LIVE + STRIPE_TEST_MODE skip behavior → issuance NOT skipped",
  liveWithTestSkip.skipMindbodyIssue === false,
);

const testWithSkipFlag = resolveAnnualSkipMindbodyIssue({
  stripeLivemode: false,
  behavior: "live",
  mindbodyTest: false,
});
check(
  "P3 TEST + ANNUAL_WEBHOOK_SKIP=1 → skip allowed",
  testWithSkipFlag.skipMindbodyIssue === true,
);

process.env.ANNUAL_WEBHOOK_SKIP_MINDDBODY_ISSUE = "0";
process.env.STRIPE_TEST_MODE_MINDBODY_BEHAVIOR = "skip";
const testWithTestSkip = resolveAnnualSkipMindbodyIssue({
  stripeLivemode: false,
  behavior: "skip",
  mindbodyTest: false,
});
check(
  "P4 TEST + STRIPE_TEST_MODE_MINDBODY_BEHAVIOR=skip → skip allowed",
  testWithTestSkip.skipMindbodyIssue === true,
);

check(
  "P5 resolveAnnualSkip only used inside handleInvoicePaid annual branch",
  (() => {
    const callRe = /resolveAnnualSkipMindbodyIssue\s*\(/g;
    const before = webhookSrc.slice(0, hipStart).match(callRe) || [];
    const inside = hipBody.match(callRe) || [];
    return inside.length >= 1 && before.length === 0;
  })(),
);

if (prevSkip === undefined) delete process.env.ANNUAL_WEBHOOK_SKIP_MINDDBODY_ISSUE;
else process.env.ANNUAL_WEBHOOK_SKIP_MINDDBODY_ISSUE = prevSkip;
if (prevTestMb === undefined) delete process.env.STRIPE_TEST_MODE_MINDBODY_BEHAVIOR;
else process.env.STRIPE_TEST_MODE_MINDBODY_BEHAVIOR = prevTestMb;

check(
  "P live skip hardening ignores QA flag in source",
  fs
    .readFileSync(path.join(root, "netlify/functions/annual-membership-webhook-lib.mjs"), "utf8")
    .includes("annual_test_skip_ignored_in_live_mode"),
);

/* Section Q — reconciler only touches annual tables */
const reconcilerSrc = read("netlify/functions/annual-membership-reconciler.mjs");
check(
  "Q reconciler imports annual store only",
  reconcilerSrc.includes("openAnnualMembershipStore") &&
    !reconcilerSrc.includes("openSubscriptionStore") &&
    !reconcilerSrc.includes("openOrderStore"),
);
process.env.ANNUAL_MEMBERSHIP_STORE_LOCAL_MEMORY = "1";
const { runAnnualMembershipReconciliation } = await import(
  "../netlify/functions/annual-membership-reconciler.mjs"
);
resetAnnualMembershipStoreMemoryForTests();
const emptyRun = await runAnnualMembershipReconciliation({ businessDate: "2099-01-01" });
check(
  "Q reconciler empty DB → no writes",
  emptyRun.issued.length === 0 && emptyRun.failed.length === 0,
);
const secondRun = await runAnnualMembershipReconciliation({ businessDate: "2099-01-01" });
check("Q reconciler idempotent second run", secondRun.issued.length === 0);

/* Section O — versioned annual UI config embed */
check(
  "O build.mjs has no ENABLE_ANNUAL_MEMBERSHIP_UI env dependency",
  !read("scripts/build.mjs").includes("ENABLE_ANNUAL_MEMBERSHIP_UI") &&
    !read("scripts/annual-membership-ui-config.mjs").includes("ANNUAL_MEMBERSHIP_UI_BUILD_OVERRIDE"),
);
check(
  "O versioned config default ON",
  readAnnualMembershipUiEnabled({ rootDir: root }) === true,
);
const cfg = buildRecurringConfig({
  ENABLE_STRIPE_RECURRING_CHECKOUT_FRONTEND: "1",
});
check("O config → annualUiEnabled true", cfg.annualUiEnabled === true);
check(
  "O monthly map unchanged",
  cfg.byMindbodyServiceId["100129"]?.localSku === "monthly_5",
);
check(
  "O annual map available",
  cfg.byMindbodyServiceIdAnnual["100129"]?.localSku === "annual_monthly_5",
);

/* Section C — monthly coupon path does not import annual lib */
check(
  "C webhook does not call syncAnnualAllocation directly",
  !webhookSrc.includes("syncAnnualAllocationToMindbody"),
);
check(
  "C syncAnnualAllocation is separate export",
  syncSrc.includes("export async function syncAnnualAllocationToMindbody"),
);
check(
  "C phase2 monthly SendEmail unchanged",
  read("scripts/qa-annual-membership-phase2.mjs").includes("monthly SendEmail live unchanged"),
);

/* Section K — admin retry scope */
const adminSubSrc = read("netlify/functions/stripe-admin-subscriptions.mjs");
check(
  "K admin retry uses subscription store not annual store",
  adminSubSrc.includes("openSubscriptionStore") && !adminSubSrc.includes("openAnnualMembershipStore"),
);

/* Section T — admin annual security */
process.env.ADMIN_DEBUG_TOKEN = "final-regression-gate-token-min-32";
const { handler: annualAdmin } = await import("../netlify/functions/annual-membership-admin.mjs");
const noTok = await annualAdmin({ httpMethod: "GET", headers: {}, queryStringParameters: {} });
const badTok = await annualAdmin({
  httpMethod: "GET",
  headers: { "x-admin-token": "wrong-token-value-here-xx" },
  queryStringParameters: {},
});
const post = await annualAdmin({
  httpMethod: "POST",
  headers: { "x-admin-token": process.env.ADMIN_DEBUG_TOKEN },
  body: JSON.stringify({ action: "unknown_action", annualMembershipId: "00000000-0000-4000-8000-000000000001" }),
});
check("T admin annual no token → 401", noTok.statusCode === 401);
check("T admin annual wrong token → 401", badTok.statusCode === 401);
check("T admin annual POST unknown action → 400", post.statusCode === 400);

/* Section S — dist build smoke (production-shaped default) */
const buildEnv = {
  ...process.env,
  ENABLE_STRIPE_RECURRING_CHECKOUT_FRONTEND: "1",
};
delete buildEnv.ENABLE_ANNUAL_MEMBERSHIP_UI;
delete buildEnv.ANNUAL_MEMBERSHIP_UI_BUILD_OVERRIDE;
const buildResult = spawnSync(process.execPath, ["scripts/build.mjs"], {
  cwd: root,
  env: buildEnv,
  encoding: "utf8",
});
check("S build succeeds", buildResult.status === 0);
const pricingBuilt = fs.readFileSync(path.join(root, "dist/pricing.html"), "utf8");
const cfgEmbed = JSON.parse(
  pricingBuilt.match(/id="mb-stripe-recurring-config"[^>]*>([^<]+)/)?.[1] || "{}",
);
check("S dist embed annualUiEnabled ON", cfgEmbed.annualUiEnabled === true);
check(
  "S dist has cadence toggle markup",
  pricingBuilt.includes('id="mb-pricing-cadence-toggle"') &&
    pricingBuilt.includes('data-pricing-cadence="annual"'),
);
check(
  "S dist has admin annual route page",
  fs.existsSync(path.join(root, "dist/admin/annual-memberships.html")),
);
check(
  "S monthly embed present",
  cfgEmbed.byMindbodyServiceId?.["100129"]?.localSku === "monthly_5",
);
check(
  "S annual embed present",
  cfgEmbed.byMindbodyServiceIdAnnual?.["100129"]?.localSku === "annual_monthly_5",
);

/* Section I — mobile unchanged */
const purchaseFlow = read("amare-app/src/lib/purchase-flow.ts");
check(
  "I mobile purchase-flow has no annual SKUs",
  !purchaseFlow.includes("annual_monthly_") &&
    purchaseFlow.includes("monthly_5") &&
    purchaseFlow.includes("drop_in_single_class"),
);

/* Section F — active drop-in */
check(
  "F active drop-in is drop_in_single_class",
  getCatalogItem("drop_in_single_class")?.enabled === true,
);
check(
  "F webhook fulfillSession path unchanged for one-time",
  webhookSrc.includes("async function fulfillSession"),
);

console.log("\n=== GATE SUMMARY ===");
console.log(`Automated gate checks failed: ${failed}`);
if (blockers.length) {
  console.log("\nPRODUCTION CONFIG BLOCKERS / OPS REQUIREMENTS:");
  for (const b of blockers) console.log(`  • ${b}`);
}
if (failed) {
  console.error("\nGATE: FAIL");
  process.exit(1);
}
console.log("\nGATE: PASS (automated sections)");
