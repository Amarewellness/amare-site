/**
 * Regression: catalog-driven Stripe Product resolution for membership subscription updates.
 * No live Stripe calls.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getCatalogItem } from "../netlify/functions/stripe-catalog-lib.mjs";
import {
  membershipStripeProductCreateParamsFromCatalog,
  membershipStripeProductMetadataFromCatalog,
  subscriptionItemPriceDataFromCatalog,
} from "../netlify/functions/stripe-membership-stripe-product-lib.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkoutPath = path.join(root, "netlify/functions/stripe-create-checkout-session.mjs");
const amandaPath = path.join(root, "amare-app/qa-output/_amanda-upgrade-execute.mjs");

const checkoutSrc = fs.readFileSync(checkoutPath, "utf8");
const amandaSrc = fs.readFileSync(amandaPath, "utf8");

const unlimited = getCatalogItem("monthly_unlimited");
const monthly5 = getCatalogItem("monthly_5");
assert.ok(unlimited);
assert.ok(monthly5);
assert.equal(unlimited.amountCents, 22900);
assert.equal(unlimited.mindbodyServiceId, 100135);
assert.equal(String(unlimited.mindbodyContractProductId), "100");

const meta = membershipStripeProductMetadataFromCatalog(unlimited);
assert.equal(meta.localSku, "monthly_unlimited");
assert.equal(meta.mindbodyServiceId, "100135");
assert.equal(meta.kind, "monthlyMembership");
assert.equal(meta.billingCadence, "monthly");

const createParams = membershipStripeProductCreateParamsFromCatalog(unlimited);
assert.equal(createParams.name, unlimited.displayName);
assert.equal(createParams.active, true);
assert.deepEqual(createParams.metadata, meta);

const priceData = subscriptionItemPriceDataFromCatalog(unlimited, "prod_test123");
assert.equal(priceData.unit_amount, 22900);
assert.equal(priceData.currency, "usd");
assert.equal(priceData.product, "prod_test123");
assert.equal(priceData.recurring.interval, "month");
assert.equal("product_data" in priceData, false);

assert.match(
  checkoutSrc,
  /product_data:\s*\{[\s\S]*metadata:\s*\{[\s\S]*localSku:\s*item\.localSku/,
  "checkout must use inline product_data with localSku metadata",
);
assert.match(
  checkoutSrc,
  /mode:\s*"subscription"/,
  "membership checkout uses subscription mode",
);

assert.doesNotMatch(
  amandaSrc,
  /prod_VU2Zh9bD3ZDRxY/,
  "Amanda execute script must not hardcode historical checkout product id",
);
assert.match(
  amandaSrc,
  /stripe-membership-stripe-product-lib/,
  "Amanda execute script must use shared catalog product resolver",
);

console.log(
  JSON.stringify({
    ok: true,
    test: "qa-stripe-membership-product-architecture",
    catalogSkus: ["monthly_unlimited", "monthly_5"],
    unlimitedAmountCents: unlimited.amountCents,
    mindbodyServiceId: unlimited.mindbodyServiceId,
  }),
);
