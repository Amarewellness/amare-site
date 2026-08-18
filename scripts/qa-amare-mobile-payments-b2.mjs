/**
 * Phase B2 Android PaymentSheet client checks (no physical card).
 * Run: node scripts/qa-amare-mobile-payments-b2.mjs
 */
process.env.NETLIFY = "";
process.env.ENABLE_AMARE_AUTH = "1";
process.env.ENABLE_AMARE_COMMERCE = "1";
process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_phase_b2_public";

const { paymentSheetPublicConfig } = await import(
  "../netlify/functions/amare-commerce-mobile-payments.mjs"
);
const fs = await import("node:fs");
const path = await import("node:path");

let failed = 0;
function check(name, ok, detail) {
  if (ok) console.log(`PASS — ${name}`);
  else {
    failed += 1;
    console.error(`FAIL — ${name}${detail ? ` (${detail})` : ""}`);
  }
}

function read(rel) {
  return fs.readFileSync(path.resolve(rel), "utf8");
}

const cfg = paymentSheetPublicConfig();
check("GOOGLE PAY CONFIG env TEST", cfg.googlePay.environment === "TEST");
check("GOOGLE PAY CONFIG US/USD", cfg.googlePay.country === "US" && cfg.googlePay.currency === "USD");
check("publishable key public only", cfg.publishableKey === "pk_test_phase_b2_public");
check("merchant AMARÉ", cfg.merchantDisplayName === "AMARÉ");

const gradle = read("amare-app/android/app/build.gradle");
check("STRIPE ANDROID SDK pin 21.19.0", gradle.includes('com.stripe:stripe-android:21.19.0'));

const purchaseScreen = read("amare-app/src/screens/PurchaseScreen.tsx");
check("ONE-TIME PAYMENT SHEET path", purchaseScreen.includes("startOneTimePaymentSheet") && purchaseScreen.includes("prepareMobilePayment"));
check("MONTHLY HOSTED CHECKOUT path", purchaseScreen.includes("startHostedMonthly") && purchaseScreen.includes("createHostedCheckoutSession"));
check("STATUS POLLING after completed", purchaseScreen.includes("pollForFulfillment") && purchaseScreen.includes("payment_completed_processing"));
check("success after mindbody_synced poll", purchaseScreen.includes('setUiState("success")') && purchaseScreen.includes("nextStateAfterStatusPoll"));
check("sync_unknown copy", purchaseScreen.includes("Your payment was received. We're confirming your class credits."));
check("sync_unknown blocks buy", purchaseScreen.includes('uiState === "sync_unknown"'));
check("recover owned order after reopen", purchaseScreen.includes("recoverOwnedPurchase") && purchaseScreen.includes("fetchMobilePendingOrders"));
check("shouldCreateNewChargeAfterRestart used", purchaseScreen.includes("shouldCreateNewChargeAfterRestart"));
check(
  "RAW PAYMENT_SHEET_BUSY not customer error",
  purchaseScreen.includes('raw === "payment_sheet_busy"') &&
    purchaseScreen.includes('sheet.status === "ignored"') &&
    purchaseScreen.includes('setError("Could not start checkout.")') &&
    !purchaseScreen.includes("setError(raw"),
);
check("duplicate presentation ignored", purchaseScreen.includes('sheet.status === "ignored"') && purchaseScreen.includes("presentingRef"));
check("buy locked while sheet active", purchaseScreen.includes("sheetActive") && purchaseScreen.includes("presentingRef.current"));

const plugin = read("amare-app/android/app/src/main/java/com/amarewellness/app/AmareStripePaymentPlugin.java");
check("CAPACITOR PAYMENT BRIDGE exists", plugin.includes('@CapacitorPlugin(name = "AmareStripePayment")'));
check("Google Pay TEST hardcoded", plugin.includes("GooglePayConfiguration.Environment.Test"));
check("Google Pay not Production", !plugin.includes("Environment.Production"));
check("Link disabled Display.Never", plugin.includes("LinkConfiguration.Display.Never"));
check("Link logout reset not required", !plugin.includes("resetCustomer"));
check("busy sheet resolves ignored", plugin.includes('ignored.put("status", "ignored")') && !plugin.includes('reject("payment_sheet_busy")'));
check("payment method order card+google_pay", plugin.includes('"card"') && plugin.includes('"google_pay"'));
check("no delayed payment methods", plugin.includes("allowsDelayedPaymentMethods(false)"));
check("bridge does not fulfill", !/mindbody|fulfill/i.test(plugin));

const main = read("amare-app/android/app/src/main/java/com/amarewellness/app/MainActivity.java");
check("PaymentSheet registered in Activity", main.includes("AmareStripePaymentPlugin") && main.includes("PaymentSheet.Builder"));

const manifest = read("amare-app/android/app/src/main/AndroidManifest.xml");
check("Google Pay Wallet meta-data", manifest.includes("com.google.android.gms.wallet.api.enabled"));

const attempt = read("amare-app/src/lib/purchase-attempt.ts");
check("PURCHASE ATTEMPT STABILITY helper", attempt.includes("purchaseAttemptIdForSku") && attempt.includes("attempts.get(sku)"));
check("attempt reused until success clear", attempt.includes("clearPurchaseAttemptId"));
check("restore attempt after process death", attempt.includes("restorePurchaseAttemptId"));

const flow = read("amare-app/src/lib/purchase-flow.ts");
check("ONE-TIME SKUS listed", flow.includes("drop_in_single_class") && flow.includes("pack_20_classes") && flow.includes("new_client_special_3_for_65"));
check(
  "monthly not in PaymentSheet SKUs",
  /MOBILE_PAYMENT_SHEET_SKUS = \[[^\]]+\]/s.test(flow) &&
    !/MOBILE_PAYMENT_SHEET_SKUS = \[[^\]]*monthly[^\]]*\]/s.test(flow),
);
check("COMPLETED ≠ FULFILLED helper", flow.includes("sheetCompletedIsFulfilled") && flow.includes("return false"));
check("MINDBODY_SYNCED SUCCESS GATE helper", flow.includes('return "success"') && flow.includes("mindbody_synced"));
check("SYNC_UNKNOWN SAFETY helper", flow.includes('return "sync_unknown"') && flow.includes("mindbody_sync_unknown"));
check("payment_succeeded is not success", flow.includes("payment_completed_processing") && !/payment_succeeded[\s\S]*return "success"/.test(flow));

const api = read("amare-app/src/api/mobile-payments.ts");
check("prepare body sku+attempt only", api.includes("sku: body.sku") && api.includes("purchaseAttemptId: body.purchaseAttemptId"));
check("status poll client", api.includes("/api/amare/commerce/mobile/status"));
check("pending discovery client", api.includes("/api/amare/commerce/mobile/pending"));
check("prepare does not send amount", !api.includes("amount: body") && !api.includes("clientId") && !api.includes("amare_user_id"));
const bridgeJs = read("amare-app/src/plugins/amare-stripe-payment.ts");
check("JS bridge android-only", bridgeJs.includes('getPlatform() === "android"') && bridgeJs.includes("presentPaymentSheet"));

if (failed) {
  console.error(`\nFAILED ${failed}`);
  process.exit(1);
}
console.log("\nPHASE B2 CHECKS PASSED");
console.log("PRODUCTION: OFF");
