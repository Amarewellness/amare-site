/**
 * Static QA: drop_in_single_class uses STRIPE_DROPIN_SINGLE_PRODUCT_ID (stable Product)
 * with dynamic unit_amount; other SKUs keep product_data; fail-fast when env missing.
 *
 * Run: node scripts/qa-dropin-single-product.mjs
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;

/** @param {string} msg */
function pass(msg) {
  console.log(`  PASS  ${msg}`);
}
/** @param {string} msg */
function fail(msg) {
  failed += 1;
  console.error(`  FAIL  ${msg}`);
}

/** @param {string} rel */
async function read(rel) {
  return fs.readFile(path.join(root, rel), "utf8");
}

const createSession = await read("netlify/functions/stripe-create-checkout-session.mjs");
const envExample = await read(".env.example");
const catalog = await read("src/content/stripe-mindbody-catalog.config.json");
const webhook = await read("netlify/functions/stripe-webhook.mjs");

console.log("qa-dropin-single-product\n");

if (createSession.includes('DROP_IN_SINGLE_CLASS_SKU = "drop_in_single_class"'))
  pass("SKU constant is drop_in_single_class only");
else fail("missing DROP_IN_SINGLE_CLASS_SKU constant");

if (createSession.includes("function dropInSingleProductId("))
  pass("dropInSingleProductId helper present");
else fail("missing dropInSingleProductId helper");

if (createSession.includes("STRIPE_DROPIN_SINGLE_PRODUCT_ID"))
  pass("reads STRIPE_DROPIN_SINGLE_PRODUCT_ID");
else fail("missing STRIPE_DROPIN_SINGLE_PRODUCT_ID env read");

if (createSession.includes("/^prod_[A-Za-z0-9]+$/"))
  pass("validates prod_… id shape");
else fail("missing prod_ id validation");

if (
  createSession.includes('item.localSku === DROP_IN_SINGLE_CLASS_SKU') &&
  createSession.includes("priceData.product = productId") &&
  createSession.includes("priceData.product_data =")
)
  pass("drop-in single uses product; others use product_data");
else fail("price_data product vs product_data branch missing");

if (createSession.includes("stripe_dropin_product_id_missing"))
  pass("fail-fast error stripe_dropin_product_id_missing");
else fail("missing fail-fast error code");

if (createSession.includes("no silent fallback") || createSession.includes("no silent fallback to `product_data`") || createSession.includes("fail-fast for this SKU (no silent fallback"))
  pass("documents no silent product_data fallback");
else fail("missing no-fallback documentation");

if (!createSession.match(/product:\s*[^\n]+,\s*\n\s*product_data:/))
  pass("no simultaneous product + product_data assignment pattern");
else fail("possible product + product_data together");

if (createSession.includes("stripeProductId: stripeProductIdForLog"))
  pass("logs stripeProductId on session create");
else fail("missing stripeProductId in session-created log");

if (envExample.includes("STRIPE_DROPIN_SINGLE_PRODUCT_ID"))
  pass(".env.example documents STRIPE_DROPIN_SINGLE_PRODUCT_ID");
else fail(".env.example missing STRIPE_DROPIN_SINGLE_PRODUCT_ID");

if (catalog.includes('"localSku": "drop_in_single_class"') && catalog.includes('"mindbodyServiceId": 100011'))
  pass("catalog still pins drop_in_single_class → Mindbody 100011");
else fail("catalog drop_in_single_class / 100011 changed unexpectedly");

if (webhook.includes("getCatalogItem(order.localSku)") && webhook.includes("session.metadata.localSku"))
  pass("webhook still identifies SKU via localSku (not Stripe Product id)");
else fail("webhook SKU identity path changed");

const sameDayProductBranch = /drop_in_same_day[\s\S]{0,120}priceData\.product|STRIPE_DROPIN_SAME_DAY/;
if (sameDayProductBranch.test(createSession))
  fail("create-session must not bind drop_in_same_day to a stable Product");
else pass("drop_in_same_day is not bound to STRIPE_DROPIN_SINGLE_PRODUCT_ID");

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll drop-in single product QA checks passed.");
