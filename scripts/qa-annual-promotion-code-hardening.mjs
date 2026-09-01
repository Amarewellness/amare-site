/**
 * Annual membership promotion-code hardening regression.
 * Run: node scripts/qa-annual-promotion-code-hardening.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  getCatalogItem,
  isAnnualMembershipCatalogItem,
  isMonthlyMembershipCatalogItem,
} from "../netlify/functions/stripe-catalog-lib.mjs";
import { membershipAllowPromotionCodes } from "../netlify/functions/stripe-create-checkout-session.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkoutSrc = fs.readFileSync(
  path.join(root, "netlify/functions/stripe-create-checkout-session.mjs"),
  "utf8",
);

let failed = 0;

function check(name, ok, detail) {
  if (ok) console.log(`PASS — ${name}`);
  else {
    failed += 1;
    console.log(`FAIL — ${name}${detail ? `\n  ${detail}` : ""}`);
  }
}

const annualSkus = ["annual_monthly_5", "annual_monthly_8", "annual_monthly_unlimited"];
const monthlySkus = ["monthly_5", "monthly_8", "monthly_unlimited"];

for (const sku of annualSkus) {
  const item = getCatalogItem(sku);
  check(`${sku} is annual catalog item`, isAnnualMembershipCatalogItem(item));
  check(`${sku} promotion codes blocked`, membershipAllowPromotionCodes(item) === false);
}

process.env.ENABLE_STRIPE_RECURRING_COUPONS = "1";
for (const sku of annualSkus) {
  const item = getCatalogItem(sku);
  check(
    `${sku} promotion codes blocked even when recurring coupons ON`,
    membershipAllowPromotionCodes(item) === false,
  );
}
delete process.env.ENABLE_STRIPE_RECURRING_COUPONS;

for (const sku of monthlySkus) {
  const item = getCatalogItem(sku);
  check(`${sku} is monthly catalog item`, isMonthlyMembershipCatalogItem(item));
  check(`${sku} promo follows recurring flag OFF`, membershipAllowPromotionCodes(item) === false);
}

process.env.ENABLE_STRIPE_RECURRING_COUPONS = "1";
for (const sku of monthlySkus) {
  const item = getCatalogItem(sku);
  check(`${sku} promo allowed when recurring coupons ON`, membershipAllowPromotionCodes(item) === true);
}
delete process.env.ENABLE_STRIPE_RECURRING_COUPONS;

check(
  "subscription checkout uses membershipAllowPromotionCodes(item)",
  checkoutSrc.includes("allow_promotion_codes: membershipAllowPromotionCodes(item)"),
);
check(
  "annual helper uses isAnnualMembershipCatalogItem",
  checkoutSrc.includes("isAnnualMembershipCatalogItem(catalogItem)"),
);
check(
  "subscription path does not set server-side discounts",
  !checkoutSrc.match(/handleMembershipSubscription[\s\S]*?params\s*=\s*\{[\s\S]*?discounts\s*:/),
);
check(
  "one-time promo path unchanged",
  checkoutSrc.includes("if (promotionCodesEnabled())") &&
    checkoutSrc.includes("params.allow_promotion_codes = true"),
);
check(
  "no after_expiration recovery path in repo",
  !fs.existsSync(path.join(root, "netlify/functions/stripe-create-checkout-session.mjs")) ||
    !checkoutSrc.includes("after_expiration"),
);

for (const sku of ["new_client_special_3_for_65", "drop_in_single_class", "pack_10_classes"]) {
  const item = getCatalogItem(sku);
  check(`${sku} is not annual`, !isAnnualMembershipCatalogItem(item));
}

if (failed) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
}
console.log("\nAnnual promotion-code hardening QA passed.");
