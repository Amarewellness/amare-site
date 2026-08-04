/**
 * OpenAI Ads pixel + conversion measurement tests.
 * Run: node scripts/openai-conversion-measure-test.mjs
 */
import assert from "node:assert/strict";
import {
  openaiHeadSnippet,
  openaiPixelDebugEnabled,
} from "./openai-pixel-snippet.mjs";
import {
  buildGa4PurchasePayload,
  buildOpenAiMeasureCall,
  isMembershipOrder,
  measureOpenAiConversion,
  openAiAmountCents,
} from "./openai-conversion-measure.mjs";

/* -------------------------------------------------------------------------- */
/* Build-time pixel snippet                                                   */
/* -------------------------------------------------------------------------- */

assert.equal(openaiHeadSnippet(""), "");
assert.equal(openaiHeadSnippet("   "), "");
assert.equal(openaiHeadSnippet("bad id!"), "");

const withPixel = openaiHeadSnippet("testPixelId12345678");
assert.notEqual(withPixel, "");
assert.match(withPixel, /if \(w\.oaiq\) return/);
assert.match(withPixel, /bzrcdn\.openai\.com\/sdk\/oaiq\.min\.js/);
assert.match(withPixel, /pixelId: "testPixelId12345678"/);
assert.doesNotMatch(withPixel, /debug: true/);

const withDebug = openaiHeadSnippet("testPixelId12345678", true);
assert.match(withDebug, /debug: true/);

assert.equal(openaiPixelDebugEnabled(undefined), false);
assert.equal(openaiPixelDebugEnabled("false"), false);
assert.equal(openaiPixelDebugEnabled("FALSE"), false);
assert.equal(openaiPixelDebugEnabled("true"), true);
assert.equal(openaiPixelDebugEnabled("1"), false);

/* -------------------------------------------------------------------------- */
/* Conversion payloads                                                        */
/* -------------------------------------------------------------------------- */

const ncsOrder = {
  orderId: "ord_NCS_TEST_001",
  localSku: "new_client_special_3_for_65",
  displayName: "New Client Special — 3 Classes",
  amountCents: 6500,
  currency: "USD",
};

const ncsCall = buildOpenAiMeasureCall(ncsOrder);
assert.ok(ncsCall);
assert.equal(ncsCall.eventName, "order_created");
assert.equal(ncsCall.data.type, "contents");
assert.equal(ncsCall.data.amount, 6500);
assert.equal(ncsCall.data.currency, "USD");
assert.equal(ncsCall.data.contents[0].id, "new_client_special_3_for_65");
assert.equal(ncsCall.data.contents[0].content_type, "product");
assert.equal(ncsCall.options.event_id, "ord_NCS_TEST_001");
assert.equal(isMembershipOrder(ncsOrder), false);

const membershipOrder = {
  kind: "subscription",
  orderId: "sub_amare_monthly_5_abc",
  localSku: "monthly_5",
  displayName: "Monthly 5",
  amountCents: 12500,
  currency: "USD",
};

const membershipCall = buildOpenAiMeasureCall(membershipOrder);
assert.ok(membershipCall);
assert.equal(membershipCall.eventName, "subscription_created");
assert.equal(membershipCall.data.type, "plan_enrollment");
assert.equal(membershipCall.data.plan_id, "monthly_5");
assert.equal(membershipCall.data.amount, 12500);
assert.equal(membershipCall.data.contents[0].content_type, "plan");
assert.equal(membershipCall.options.event_id, "sub_amare_monthly_5_abc");
assert.equal(isMembershipOrder(membershipOrder), true);

assert.notEqual(ncsCall.eventName, membershipCall.eventName);

/* amount: USD dollars → integer cents via amountCents field */
assert.equal(openAiAmountCents({ amountCents: 65.4 }), 65);
assert.equal(openAiAmountCents({ amountCents: 0 }), null);
assert.equal(openAiAmountCents({ amountCents: -100 }), null);
assert.equal(openAiAmountCents({}), null);

/* event_id equals orderId */
assert.equal(buildOpenAiMeasureCall(ncsOrder)?.options.event_id, ncsOrder.orderId);

/* Missing / invalid orders */
assert.equal(buildOpenAiMeasureCall(null), null);
assert.equal(buildOpenAiMeasureCall({ orderId: "", amountCents: 6500 }), null);
assert.equal(buildOpenAiMeasureCall({ orderId: "ord_x", amountCents: 0 }), null);

/* -------------------------------------------------------------------------- */
/* measureOpenAiConversion side effects                                       */
/* -------------------------------------------------------------------------- */

/** @type {unknown[][]} */
const oaiqCalls = [];
function mockOaiq(...args) {
  oaiqCalls.push(args);
}

assert.equal(measureOpenAiConversion(ncsOrder, mockOaiq), true);
assert.equal(oaiqCalls.length, 1);
assert.deepEqual(oaiqCalls[0][0], "measure");
assert.equal(oaiqCalls[0][1], "order_created");
assert.equal(oaiqCalls[0][3].event_id, ncsOrder.orderId);

oaiqCalls.length = 0;
assert.equal(measureOpenAiConversion(membershipOrder, mockOaiq), true);
assert.equal(oaiqCalls[0][1], "subscription_created");

/* OpenAI unavailable — silent no-op */
assert.equal(measureOpenAiConversion(ncsOrder, undefined), false);
assert.equal(measureOpenAiConversion(ncsOrder, null), false);

/* oaiq throws — must not propagate */
function throwingOaiq() {
  throw new Error("blocked");
}
assert.equal(measureOpenAiConversion(ncsOrder, throwingOaiq), false);

/* Unsynced orders: conversion helper not invoked by checkout-success when bucket !== synced.
   Here we only verify the helper still builds valid calls when given order data. */
const pendingOrder = { ...ncsOrder, bucket: "pending" };
assert.ok(buildOpenAiMeasureCall(pendingOrder));

/* -------------------------------------------------------------------------- */
/* GA4 purchase payload unchanged (regression guard)                          */
/* -------------------------------------------------------------------------- */

const gaPayload = buildGa4PurchasePayload({
  orderId: "ord_NCS_TEST_001",
  localSku: "new_client_special_3_for_65",
  displayName: "New Client Special — 3 Classes",
  amountCents: 6500,
  currency: "USD",
  ctaLocation: "pricing_static_new_client",
  clientWasNewlyCreated: true,
  promotionCode: "",
});

assert.equal(gaPayload.transaction_id, "ord_NCS_TEST_001");
assert.equal(gaPayload.value, 65);
assert.equal(gaPayload.currency, "USD");
assert.equal(gaPayload.affiliation, "Stripe");
assert.equal(gaPayload.tax, 0);
assert.equal(gaPayload.shipping, 0);
assert.equal(gaPayload.items[0].item_id, "new_client_special_3_for_65");
assert.equal(gaPayload.items[0].item_category, "package");
assert.equal(gaPayload.items[0].price, 65);
assert.equal(gaPayload.items[0].quantity, 1);
assert.equal(gaPayload.cta_location, "pricing_static_new_client");
assert.equal(gaPayload.new_client, "1");
assert.equal(gaPayload.coupon, undefined);

console.log("PASS — openai-conversion-measure-test.mjs (" + 12 + " scenarios)");
