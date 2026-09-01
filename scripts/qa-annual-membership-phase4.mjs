/**
 * AMARÉ Annual Membership Phase 4 — pricing UI, admin read API, regression inventory prep.
 * Run: npm run test:annual-membership-phase4
 *
 * No production deploy. No production DB migration. No live Stripe charges.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readAnnualMembershipUiEnabled } from "./annual-membership-ui-config.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const embeddedDir = path.join(root, "netlify/functions/_embedded");
fs.mkdirSync(embeddedDir, { recursive: true });
fs.copyFileSync(
  path.join(root, "src/content/stripe-mindbody-catalog.config.json"),
  path.join(embeddedDir, "stripe-mindbody-catalog.config.json"),
);

let failed = 0;

function check(name, ok, detail) {
  if (ok) console.log(`PASS — ${name}`);
  else {
    failed += 1;
    console.log(`FAIL — ${name}${detail ? `\n  ${detail}` : ""}`);
  }
}

/** @param {string} rel */
function readText(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

const catalog = JSON.parse(
  readText("src/content/stripe-mindbody-catalog.config.json"),
);
const pricingJs = readText("src/js/pricing-api.js");
const pricingHtml = readText("src/content/pricing.html");
const webhookJs = readText("netlify/functions/stripe-webhook.mjs");
const annualWebhookLibJs = readText("netlify/functions/annual-membership-webhook-lib.mjs");
const checkoutJs = readText("netlify/functions/stripe-create-checkout-session.mjs");
const architectureDoc = readText("docs/ANNUAL-MEMBERSHIP-ARCHITECTURE.md");

/** Build-time recurring config mirror (matches scripts/build.mjs). */
function buildRecurringConfig(env = {}) {
  const enabled = (env.ENABLE_STRIPE_RECURRING_CHECKOUT_FRONTEND || "0").trim() === "1";
  const annualUiEnabled = readAnnualMembershipUiEnabled({ rootDir: root });
  const items = Array.isArray(catalog.items) ? catalog.items : [];
  /** @type {Record<string, { localSku: string }>} */
  const byMindbodyServiceId = {};
  /** @type {Record<string, { localSku: string; annualAmountCents: number; monthlyEquivalentCents: number }>} */
  const byMindbodyServiceIdAnnual = {};
  /** @type {Record<string, number>} */
  const monthlyDisplayServiceIdByMindbodyServiceId = {};
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const r = /** @type {Record<string, unknown>} */ (raw);
    if (r.kind === "monthlyMembership") {
      if (r.stripeMode !== "subscription" || !r.enabled) continue;
      if (typeof r.mindbodyServiceId !== "number") continue;
      const entry = {
        localSku: String(r.localSku || ""),
        monthlyAmountCents: Math.trunc(Number(r.amountCents)),
      };
      const newId = String(Math.trunc(r.mindbodyServiceId));
      byMindbodyServiceId[newId] = entry;
      if (typeof r.mindbodyDisplayServiceId === "number") {
        const displayId = String(Math.trunc(r.mindbodyDisplayServiceId));
        monthlyDisplayServiceIdByMindbodyServiceId[newId] = Math.trunc(r.mindbodyDisplayServiceId);
        if (displayId !== newId) byMindbodyServiceId[displayId] = entry;
      }
      continue;
    }
    if (r.kind !== "annualMembership" || r.stripeMode !== "subscription" || !r.enabled) continue;
    if (typeof r.mindbodyServiceId !== "number") continue;
    const annualAmountCents = Math.trunc(Number(r.amountCents));
    const annualEntry = {
      localSku: String(r.localSku || ""),
      annualAmountCents,
      monthlyEquivalentCents: Math.round(annualAmountCents / 12),
    };
    const newId = String(Math.trunc(r.mindbodyServiceId));
    byMindbodyServiceIdAnnual[newId] = annualEntry;
    const displayIdRaw = monthlyDisplayServiceIdByMindbodyServiceId[newId];
    if (typeof displayIdRaw === "number") {
      const displayId = String(displayIdRaw);
      if (displayId !== newId) byMindbodyServiceIdAnnual[displayId] = annualEntry;
    }
  }
  return { enabled, annualUiEnabled, byMindbodyServiceId, byMindbodyServiceIdAnnual };
}

/** Catalog-driven SKU resolution mirroring pricing-api.js cadence rules. */
function resolveSkuForCadence(cfg, svcId, cadence) {
  if (!cfg.enabled) return null;
  const map =
    cadence === "annual" && cfg.annualUiEnabled
      ? cfg.byMindbodyServiceIdAnnual
      : cfg.byMindbodyServiceId;
  const entry = map?.[String(svcId)];
  return entry?.localSku || null;
}

const { getCatalogItem } = await import("../netlify/functions/stripe-catalog-lib.mjs");
const { handler: adminHandler } = await import("../netlify/functions/annual-membership-admin.mjs");
const {
  resetAnnualMembershipStoreMemoryForTests,
  openAnnualMembershipStoreForTests,
} = await import("../netlify/functions/annual-membership-store.mjs");

const DISPLAY_IDS = { monthly_5: "100129", monthly_8: "100130", monthly_unlimited: "100056" };
const APPROVED_ANNUAL = {
  annual_monthly_5: { annualCents: 127500, equivCents: 10625 },
  annual_monthly_8: { annualCents: 182580, equivCents: 15215 },
  annual_monthly_unlimited: { annualCents: 233580, equivCents: 19465 },
};
const APPROVED_MONTHLY = {
  monthly_5: 12500,
  monthly_8: 17900,
  monthly_unlimited: 22900,
};

const cfg = buildRecurringConfig({
  ENABLE_STRIPE_RECURRING_CHECKOUT_FRONTEND: "1",
});
check("1 annual UI config ON by default", cfg.annualUiEnabled === true);
check(
  "1b versioned config file present",
  fs.existsSync(path.join(root, "src/content/annual-membership-ui.config.json")),
);
check(
  "1c build.mjs has no ENABLE_ANNUAL_MEMBERSHIP_UI env dependency",
  readText("scripts/build.mjs").includes("readAnnualMembershipUiEnabled") &&
    !readText("scripts/build.mjs").includes("ENABLE_ANNUAL_MEMBERSHIP_UI") &&
    !readText("scripts/annual-membership-ui-config.mjs").includes("ANNUAL_MEMBERSHIP_UI_BUILD_OVERRIDE"),
);
check(
  "2 pricing cadence toggle markup present",
  pricingHtml.includes('id="mb-pricing-cadence-toggle"') &&
    pricingHtml.includes('data-pricing-cadence="monthly"') &&
    pricingHtml.includes('data-pricing-cadence="annual"'),
);
check(
  "3 default cadence is monthly on load",
  pricingJs.includes('membershipPricingCadence = "monthly"'),
);
check(
  "4 pricing-api wires cadence toggle",
  pricingJs.includes("setupMembershipCadenceToggle") &&
    pricingJs.includes("byMindbodyServiceIdAnnual") &&
    pricingJs.includes("dataset.cadenceBound"),
);

for (const [tier, svcId] of Object.entries(DISPLAY_IDS)) {
  const monthlySku = tier;
  const annualSku = tier.replace("monthly_", "annual_monthly_");
  check(`5 monthly selected → ${monthlySku}`, resolveSkuForCadence(cfg, svcId, "monthly") === monthlySku);
  check(`6 annual selected → ${annualSku}`, resolveSkuForCadence(cfg, svcId, "annual") === annualSku);
}

check(
  "7 annual SKU cannot come from monthly map when annual cadence active",
  resolveSkuForCadence(cfg, DISPLAY_IDS.monthly_5, "annual") !== "monthly_5",
);
check(
  "8 monthly cadence never returns annual SKU",
  resolveSkuForCadence(cfg, DISPLAY_IDS.monthly_5, "monthly") === "monthly_5",
);

for (const [sku, cents] of Object.entries(APPROVED_MONTHLY)) {
  const item = getCatalogItem(sku);
  check(`monthly catalog ${sku} amount`, item?.amountCents === cents, `got ${item?.amountCents}`);
}
for (const [sku, spec] of Object.entries(APPROVED_ANNUAL)) {
  const item = getCatalogItem(sku);
  check(`annual catalog ${sku} amount`, item?.amountCents === spec.annualCents, `got ${item?.amountCents}`);
  check(
    `annual catalog ${sku} interval`,
    item?.recurringInterval === "year",
    String(item?.recurringInterval),
  );
}
const embed5 = cfg.byMindbodyServiceIdAnnual?.["100129"];
check("annual embed display id 100129", embed5?.localSku === "annual_monthly_5");
check("annual embed monthly equivalent 5", embed5?.monthlyEquivalentCents === 10625);
check("annual embed annual amount 5", embed5?.annualAmountCents === 127500);

check(
  "10 annual checkout requires year interval in create-session",
  checkoutJs.includes('item.recurringInterval !== "year"') &&
    checkoutJs.includes("sku_not_an_annual_subscription"),
);
check(
  "11 monthly checkout requires month interval",
  checkoutJs.includes('!isAnnualMembership && item.recurringInterval !== "month"'),
);
check(
  "12 recurring checkout disables submit while in flight",
  pricingJs.includes("runBtn.disabled = true") &&
    pricingJs.includes("Preparing secure Stripe checkout"),
);

process.env.ADMIN_DEBUG_TOKEN = "phase4-admin-token-32chars-min";
process.env.ANNUAL_MEMBERSHIP_STORE_LOCAL_MEMORY = "1";
const unauth = await adminHandler({
  httpMethod: "GET",
  headers: {},
  queryStringParameters: { limit: "1" },
});
check("13 admin annual endpoint rejects missing token", unauth.statusCode === 401);
const badMethod = await adminHandler({
  httpMethod: "POST",
  headers: { "x-admin-token": process.env.ADMIN_DEBUG_TOKEN },
  body: JSON.stringify({ action: "not_a_real_action", annualMembershipId: "00000000-0000-4000-8000-000000000001" }),
});
check("14 admin annual POST unknown action → 400", badMethod.statusCode === 400);
const badPostNoId = await adminHandler({
  httpMethod: "POST",
  headers: { "x-admin-token": process.env.ADMIN_DEBUG_TOKEN },
  body: JSON.stringify({ action: "revoke_term", confirmStop: "STOP" }),
});
check("14b admin annual POST requires membership id", badPostNoId.statusCode === 400);

resetAnnualMembershipStoreMemoryForTests();
const store = openAnnualMembershipStoreForTests();
const term = await store.createAnnualTermWithPeriods({
  sku: "annual_monthly_5",
  mindbodyClientId: 100002839,
  stripeSubscriptionId: "sub_phase4_admin",
  stripeInvoiceId: "in_phase4_admin",
  termStartDate: "2026-09-01",
  termEndDate: "2027-09-01",
  annualAmountCents: 127500,
});
const membershipId = term.membership.id;
const period0 = term.periods.find((p) => Number(p.period_index) === 0);
const period1 = term.periods.find((p) => Number(p.period_index) === 1);
const period2 = term.periods.find((p) => Number(p.period_index) === 2);
const period3 = term.periods.find((p) => Number(p.period_index) === 3);
await store.claimPeriod(period0.id);
await store.markPeriodIssued(period0.id, {
  mindbodySaleId: 36934,
  mindbodyClientServiceId: 32933,
});
await store.markPeriodFailed(period1.id, { error: "mindbody_timeout" });
await store.claimPeriod(period2.id);
await store.markPeriodAmbiguous(period2.id, { error: "duplicate_client_service" });
await store.markPeriodManualReview(period3.id, { error: "needs_staff_review" });

const okAdmin = await adminHandler({
  httpMethod: "GET",
  headers: { "x-admin-token": process.env.ADMIN_DEBUG_TOKEN },
  queryStringParameters: { id: membershipId },
});
/** @type {{ memberships?: Array<Record<string, unknown>>; ok?: boolean }} */
const adminBody = JSON.parse(okAdmin.body || "{}");
const view = adminBody.memberships?.[0];
check("15 admin lookup authorized", okAdmin.statusCode === 200 && adminBody.ok === true);
check(
  "16 admin view surfaces blocking failed period as current",
  view?.current_period &&
    /** @type {{ status?: string }} */ (view.current_period).status === "failed",
);
check(
  "17 admin highlights failed/ambiguous/manual_review",
  Array.isArray(view?.attention) &&
    view.attention.includes("failed") &&
    view.attention.includes("ambiguous") &&
    view.attention.includes("manual_review"),
);

check(
  "STRIPE_TEST_MODE live events ignore env override",
  webhookJs.includes("if (stripeLivemode)") && webhookJs.includes('behavior: "live"'),
);
check(
  "STRIPE_TEST_MODE skip only applies in test mode branch",
  webhookJs.includes("process.env.STRIPE_TEST_MODE_MINDBODY_BEHAVIOR") &&
    webhookJs.includes("Stripe test-mode event"),
);
check(
  "ANNUAL_WEBHOOK_SKIP gated to test mode in source",
  annualWebhookLibJs.includes("annual_test_skip_ignored_in_live_mode") &&
    annualWebhookLibJs.includes("resolveAnnualSkipMindbodyIssue") &&
    webhookJs.includes("resolveAnnualSkipMindbodyIssue("),
);

for (const f of [
  "netlify/functions/stripe-catalog-lib.mjs",
  "netlify/functions/stripe-create-checkout-session.mjs",
  "netlify/functions/stripe-webhook.mjs",
  "netlify/functions/stripe-mindbody-sync-lib.mjs",
]) {
  check(`shared file present: ${f}`, fs.existsSync(path.join(root, f)));
}
check(
  "regression matrix doc section present",
  architectureDoc.includes("Final purchase regression matrix"),
);
check(
  "monthly UI regression: monthly policy copy present",
  pricingHtml.includes('data-pricing-policy="monthly"') &&
    pricingHtml.includes("3-month minimum commitment"),
);
check(
  "toggle buttons not disabled in markup",
  !pricingHtml.includes('data-pricing-cadence="annual"') ||
    (!pricingHtml.includes('data-pricing-cadence="annual" disabled') &&
      !pricingHtml.includes('aria-disabled="true"')),
);
check(
  "toggle CSS has no pointer-events block on options",
  !readText("src/css/components-pricing.css").match(
    /\.pricing-cadence-toggle__option[^}]*pointer-events:\s*none/,
  ),
);
check(
  "annual price formatting helpers present",
  pricingJs.includes("formatAnnualPriceDollars") &&
    pricingJs.includes("formatAnnualEquivalentDollars") &&
    pricingJs.includes("plan-price__cadence"),
);
check(
  "annual features omit redundant member benefits bullet",
  pricingJs.includes('"5 class credits refresh monthly"') &&
    !pricingJs.includes('"5 class credits refresh monthly", "Member benefits included"'),
);

const mbTerms = JSON.parse(readText("src/content/mb-contract-terms.config.json"));
const consentJs = readText("netlify/functions/mindbody-membership-electronic-consent.mjs");

check(
  "purchase modal terms keyed by authoritative SKU",
  pricingJs.includes("function membershipSkuCadence(") &&
    pricingJs.includes("resolveRecurringMembershipTerms(row, localSku)") &&
    !pricingJs.match(/if \(isAnnualCadenceActive\(\)\) \{\s*return \{\s*\.\.\.resolved,/),
);
check(
  "SKU / agreement match guarded before Stripe submit",
  pricingJs.includes("membershipTermsMatchCheckoutSku") &&
    pricingJs.includes("Membership agreement does not match the selected plan"),
);
check(
  "annual consent version resolved server-side by localSku",
  consentJs.includes("resolveAnnualContractEntryByLocalSku") &&
    consentJs.includes("bodyObj.localSku"),
);

const ANNUAL_MODAL_REQUIRED = [
  "prepaid annual membership",
  "automatically renew once per year",
  "contacting the studio before your renewal date",
  "non-refundable and are not prorated",
];
const ANNUAL_MODAL_FORBIDDEN = [
  "monthly membership charged automatically each billing cycle",
  "3\u2011month commitment",
  "50% of one month",
];

for (const sku of ["annual_monthly_5", "annual_monthly_8", "annual_monthly_unlimited"]) {
  const entry = mbTerms.annualByLocalSku?.[sku];
  check(`annual agreement config present: ${sku}`, !!entry?.termsHtml);
  check(`annual agreement title: ${sku}`, entry?.title === "Annual Membership Agreement");
  check(
    `annual agreement billing auth yearly: ${sku}`,
    String(entry?.checkboxBillingAuthLabel || "").includes("once per year"),
  );
  const html = String(entry?.termsHtml || "");
  for (const phrase of ANNUAL_MODAL_REQUIRED) {
    check(`annual ${sku} contains "${phrase}"`, html.includes(phrase));
  }
  for (const phrase of ANNUAL_MODAL_FORBIDDEN) {
    check(`annual ${sku} excludes "${phrase}"`, !html.includes(phrase));
  }
}

check(
  "annual 8 plan label",
  mbTerms.annualByLocalSku?.annual_monthly_8?.marketingPlanName === "8 Classes Annual Membership",
);
check(
  "annual price formatting helper used in modal lead",
  pricingJs.includes("buildMembershipModalPriceLine") &&
    pricingJs.includes("formatAnnualPriceDollars(annualDollars)"),
);
check(
  "annual modal shows billed upfront annually",
  pricingJs.includes("Billed upfront annually"),
);

const adminAnnualJs = readText("src/js/admin-annual-memberships.js");
const adminActionsJs = readText("netlify/functions/annual-membership-admin-actions.mjs");
const issueJs = readText("netlify/functions/annual-membership-issue.mjs");
const storeJs = readText("netlify/functions/annual-membership-store.mjs");

check(
  "admin UI exposes cancel renewal and stop term actions",
  adminAnnualJs.includes('data-annual-action="cancel_renewal"') &&
    adminAnnualJs.includes('data-annual-action="revoke_term"') &&
    adminAnnualJs.includes("Cancel renewal") &&
    adminAnnualJs.includes("Stop current annual membership"),
);
check(
  "admin revoke requires STOP confirmation",
  adminAnnualJs.includes('confirmStop = "STOP"') && adminActionsJs.includes("confirm_stop_required"),
);
check(
  "cancel renewal uses Stripe cancel_at_period_end",
  adminActionsJs.includes("cancel_at_period_end: true"),
);
check(
  "issue engine re-checks membership before Mindbody sync",
  issueJs.includes("MEMBERSHIP_REVOKED_BEFORE_SYNC") && issueJs.includes("membershipRecheck"),
);
check(
  "store supports revoke and filters due periods by parent status",
  storeJs.includes("revokeAnnualMembershipTerm") && storeJs.includes("eligibleMembershipStatuses"),
);
check(
  "manual_review not in unconditional revoke skip list",
  readText("netlify/functions/annual-membership-lib.mjs").includes("manual_review_requires_resolution") &&
    /ANNUAL_REVOKE_SKIPPABLE_PERIOD_STATUSES = Object\.freeze\(\[\s*"pending"\s*\]\)/.test(
      readText("netlify/functions/annual-membership-lib.mjs"),
    ),
);

for (const [productKey, phrase] of [
  ["102", "monthly membership charged automatically each billing cycle"],
  ["102", "3\u2011month commitment"],
  ["101", "minimum commitment of"],
]) {
  const html = String(mbTerms.byMindbodyProductId?.[productKey]?.termsHtml || "");
  check(`monthly product ${productKey} retains "${phrase}"`, html.includes(phrase));
}
check(
  "monthly unlimited summary retains 3-month minimum",
  Array.isArray(mbTerms.byMindbodyProductId?.["100"]?.summaryLines) &&
    mbTerms.byMindbodyProductId["100"].summaryLines.some((line) => String(line).includes("3")),
);

check(
  "monthly agreement not inferred from cadence toggle in terms builder",
  !pricingJs.includes("isAnnualCadenceActive() ? \"/year\" : \"/month\""),
);

console.log("");
if (failed) {
  console.error(`${failed} failure(s)`);
  process.exit(1);
}
console.log("Phase 4 local QA — all checks passed.");
