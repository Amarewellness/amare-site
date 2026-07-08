/**
 * Static QA for Phase 1 Deferred Book Intent.
 * Run: node scripts/qa-deferred-book-logic.mjs
 */

import fs from "node:fs/promises";

let failed = 0;

function pass(msg) {
  console.log(`PASS — ${msg}`);
}

function fail(msg) {
  failed += 1;
  console.log(`FAIL — ${msg}`);
}

const root = new URL("../", import.meta.url);

async function read(rel) {
  return fs.readFile(new URL(rel, root), "utf8");
}

const intentLib = await read("netlify/functions/mindbody-pending-book-intent-lib.mjs");
const syncLib = await read("netlify/functions/stripe-mindbody-sync-lib.mjs");
if (
  syncLib.includes("CLIENT_TRANSACTIONAL_EMAIL_FIELDS") &&
  syncLib.includes("...CLIENT_TRANSACTIONAL_EMAIL_FIELDS,")
)
  pass("addclient sets transactional email opt-in on Client row");
else fail("addclient missing SendScheduleEmails inside Client row");

if (syncLib.includes("ensureStudioClientTransactionalEmailOptIn"))
  pass("existing clients get transactional email opt-in on OAuth/Stripe touch");
else fail("missing ensureStudioClientTransactionalEmailOptIn");

if (intentLib.includes("classes_anonymous_book_packages"))
  pass("anonymous classes CTA allowlisted for deferred book");
else fail("missing classes_anonymous_book_packages CTA");

if (intentLib.includes("validateAnonymousPendingBookForCheckout"))
  pass("anonymous book intent validates pendingBook without OAuth 402 cookie");
else fail("missing validateAnonymousPendingBookForCheckout");

const anonIntentFn = await read("netlify/functions/mindbody-anonymous-book-intent.mjs");
if (anonIntentFn.includes("anonymous_book_intent_sealed"))
  pass("anonymous-book-intent endpoint seals guest cookie");
else fail("missing mindbody-anonymous-book-intent.mjs");

const scheduleEarly = await read("src/js/classes-schedule.js");
if (
  scheduleEarly.includes("openGuestBookDialog") &&
  scheduleEarly.includes("classes_anonymous_book_packages")
)
  pass("classes schedule guest flow with anonymous express checkout");
else fail("classes schedule missing guest anonymous express flow");

const deferredLib = await read("netlify/functions/mindbody-deferred-class-book.mjs");
const bookLib = await read("netlify/functions/mindbody-class-book-lib.mjs");
const classBook = await read("netlify/functions/mindbody-class-book.mjs");
const createSession = await read("netlify/functions/stripe-create-checkout-session.mjs");
const webhook = await read("netlify/functions/stripe-webhook.mjs");
const orderStatus = await read("netlify/functions/stripe-order-status.mjs");
const schedule = await read("src/js/classes-schedule.js");
const success = await read("src/js/checkout-success.js");

const requiredSkus = [
  "new_client_special_3_for_65",
  "drop_in_single_class",
  "pack_10_classes",
  "pack_20_classes",
];

for (const sku of requiredSkus) {
  if (!intentLib.includes(`"${sku}"`)) fail(`SKU missing from intent allowlist: ${sku}`);
  else pass(`SKU allowlisted: ${sku}`);
}

if (intentLib.includes("drop_in_same_day")) fail("same-day drop-in must not be in Phase 1 allowlist");
else pass("same-day drop-in excluded from allowlist");

if (intentLib.includes('reason: "no_bookable_credits"')) pass("intent sealed only for no_bookable_credits");
else fail("intent reason guard missing");

if (classBook.includes("withBookFailIntentCookie") && classBook.includes("!waitlist"))
  pass("402 intent cookie set only on no-credits book path (not waitlist)");
else fail("class-book missing 402 intent cookie wiring");

if (createSession.includes("validatePendingBookForCheckout") && createSession.includes("readBookFailIntentFromEvent"))
  pass("create-session validates sealed intent before pendingBook");
else fail("create-session missing intent validation");

if (createSession.includes("deferredBookRecord") && createSession.includes('status: "pending"'))
  pass("create-session initializes deferredBook pending");
else fail("create-session missing deferredBook init");

if (webhook.includes("orderNeedsDeferredBookAttempt") && webhook.includes("maybeAttemptDeferredClassBook"))
  pass("webhook attempts deferred book after sync and on redelivery");
else fail("webhook missing deferred book integration");

if (
  webhook.includes("mindbody_synced") &&
  webhook.includes("orderNeedsDeferredBookAttempt(order)") &&
  !webhook.match(/mindbody_synced[\s\S]{0,120}return \{ ok: true, status: order\.mindbodySyncStatus, noop: true \};/)
)
  pass("mindbody_synced early-return runs deferred book when pending");
else fail("webhook idempotency may skip deferred book");

if (deferredLib.includes("listBookableClientServiceIds") && deferredLib.includes("ClientServiceId"))
  pass("deferred book uses listBookableClientServiceIds + explicit ClientServiceId");
else fail("deferred book missing safe entitlement path");

if (deferredLib.includes("verifyBookPaymentApplied") && deferredLib.includes("rollbackBookedVisit"))
  pass("deferred book verifies payment and rolls back on failure");
else fail("deferred book missing verify/rollback");

if (createSession.includes("deferredBookConsumerAuthSealed"))
  pass("create-session captures sealed consumer auth for reservation email");
else fail("create-session missing deferredBookConsumerAuthSealed");

if (deferredLib.includes("consumerHeadersFromOrderAuth") || deferredLib.includes("readDeferredBookConsumerAuth"))
  pass("deferred book prefers consumer token for confirmation email");
else fail("deferred book missing consumer auth for email");

const confirmEmail = await read("netlify/functions/stripe-deferred-book-confirm-email.mjs");
if (confirmEmail.includes("sendDeferredBookReservationEmail"))
  pass("success-page confirm-email endpoint exists");
else fail("missing stripe-deferred-book-confirm-email.mjs");

if (success.includes("/api/stripe/deferred-book/confirm-email"))
  pass("checkout-success requests consumer confirmation email");
else fail("checkout-success missing confirm-email call");

if (deferredLib.includes("already_enrolled")) pass("duplicate webhook idempotency via existing visit check");
else fail("missing already-enrolled guard for duplicate webhooks");

if (deferredLib.includes("class_past") && deferredLib.includes("class_full")) pass("class_past and class_full statuses");
else fail("missing class_past/class_full handling");

if (orderStatus.includes("deferredBook") && orderStatus.includes("pendingBook"))
  pass("order-status exposes deferredBook + pendingBook");
else fail("order-status missing public deferred fields");

if (success.includes("formatStudioClassWhen") && success.includes("classStartIso"))
  pass("checkout-success shows class date/time from pendingBook");
else fail("checkout-success missing class date/time formatting");

if (success.includes('status === "booked"') && success.includes("class_full") && success.includes("class_past"))
  pass("checkout-success renders deferred book statuses");
else fail("checkout-success missing deferred status UX");

if (schedule.includes("pendingBookPayloadFromCls") && schedule.includes("classes_booking_fail_packages"))
  pass("schedule sends pendingBook on booking-fail express checkout");
else fail("schedule missing pendingBook payload");

if (schedule.includes("bookFailCls: cls")) pass("pendingBook only wired from confirm-book fail (not waitlist-only)");
else fail("bookFailCls not passed from confirm-book path");

if (schedule.includes("appendBookFailPackagesExtras(wrap, fb);"))
  pass("waitlist package embed does not pass bookFailCls");
else fail("waitlist path should not pass bookFailCls");

if (bookLib.includes("export async function verifyBookPaymentApplied"))
  pass("shared verifyBookPaymentApplied exported from book lib");
else fail("book lib missing verify export");

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll deferred-book QA checks passed.");
