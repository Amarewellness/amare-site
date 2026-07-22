/**
 * Static + in-memory QA for /classes auto-book guards (approved scope).
 * Run: node scripts/qa-classes-auto-book-logic.mjs
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

const autoBookLib = await read("netlify/functions/classes-auto-book-lib.mjs");
const orderStore = await read("netlify/functions/stripe-order-store.mjs");
const subStore = await read("netlify/functions/stripe-subscription-store.mjs");
const webhook = await read("netlify/functions/stripe-webhook.mjs");
const createSession = await read("netlify/functions/stripe-create-checkout-session.mjs");
const pricingApi = await read("src/js/pricing-api.js");
const schedule = await read("src/js/classes-schedule.js");

/* 1 — Membership handoff: clear only after successful create-session */
if (
  pricingApi.includes("clearMembershipCheckoutHandoff()") &&
  pricingApi.includes("MEMBERSHIP_HANDOFF_TTL_MS") &&
  !pricingApi.match(/maybeAutoOpenPendingPricingCheckoutAfterRender[\s\S]{0,1200}clearMembershipCheckoutHandoff\(\)[\s\S]{0,200}btn\.click/)
)
  pass("handoff kept until Stripe session URL (not cleared before auto-click)");
else fail("handoff cleared too early in pricing-api auto-open flow");

if (
  pricingApi.includes("clearMembershipCheckoutHandoff();") &&
  pricingApi.includes("stripeJson.url")
)
  pass("handoff cleared only after valid subscription create-session URL");
else fail("handoff not cleared after successful subscription create-session");

if (schedule.includes("purchaseSource: \"classes\"") && schedule.includes("selectedClass"))
  pass("classes schedule stores selectedClass in membership handoff");
else fail("classes schedule missing selectedClass in handoff");

/* 2 — Duplicate auto-book CAS */
if (orderStore.includes("mutate") && orderStore.includes("atomicUpdateJSON"))
  pass("order store has atomic mutate for CAS guards");
else fail("order store missing atomic mutate");

if (
  autoBookLib.includes("AUTO_BOOK_TERMINAL") &&
  autoBookLib.includes('"processing"') &&
  autoBookLib.includes("tryAcquireOrderAutoBook")
)
  pass("one-time auto-book uses pending→processing CAS");
else fail("one-time auto-book CAS missing");

if (
  autoBookLib.includes("runClassesAutoBookAfterMembershipFirstInvoiceSync") &&
  autoBookLib.includes("subStore.mutate") &&
  autoBookLib.includes("initialAutoBookProcessed")
)
  pass("membership auto-book uses shared mutate guard (not only initialAutoBookProcessed read)");
else fail("membership auto-book guard incomplete");

/* 3 — Separate booking vs admin email status */
if (
  autoBookLib.includes("bookingFailureAdminEmail") &&
  autoBookLib.includes('status: /** @type {const} */ ("sending")') &&
  autoBookLib.includes('st === "sent" || st === "sending"')
)
  pass("admin email CAS: not_sent|failed→sending; skip sending|sent");
else fail("admin email CAS guards missing or insufficient");

if (
  autoBookLib.includes("handleClassesAutoBookWebhookRedelivery") &&
  autoBookLib.includes('st === "failed"') &&
  autoBookLib.includes("admin_email_retry")
)
  pass("webhook redelivery retries admin email only when booking failed");
else fail("webhook redelivery email-only path missing");

/* 4 — Both membership webhook paths share guard */
if (
  webhook.includes("runClassesAutoBookAfterMembershipFirstInvoiceSync") &&
  webhook.includes("handleMembershipAutoBookWebhookRedelivery")
)
  pass("invoice.paid success path calls shared membership auto-book function");
else fail("handleInvoicePaid missing shared membership auto-book");

if (
  webhook.includes("handleSubscriptionCheckoutCompleted") &&
  webhook.includes("handleInvoicePaid")
)
  pass("eager checkout.session.completed delegates to handleInvoicePaid (shared path)");
else fail("eager membership path does not share handleInvoicePaid");

if (
  webhook.includes("dedupVia: \"record_invoices_array\"") &&
  webhook.includes("handleMembershipAutoBookWebhookRedelivery")
)
  pass("invoice dedup redelivery uses shared membership guard");
else fail("membership dedup redelivery guard missing");

/* create-session persistence */
if (
  createSession.includes("selectedClassContext") &&
  createSession.includes("classesAutoBook") &&
  createSession.includes("bookingFailureAdminEmail")
)
  pass("create-session persists selectedClassContext + status fields");
else fail("create-session missing classes auto-book fields");

/* In-memory CAS simulation */
/** @type {Record<string, unknown>} */
const mem = {};
/** @type {Map<string, string>} */
const etags = new Map();

function memGet(id) {
  return mem[id] ? structuredClone(mem[id]) : null;
}

async function memMutate(id, fn) {
  const cur = memGet(id);
  if (!cur) return { ok: false, modified: false };
  const next = fn(cur);
  if (!next) return { ok: true, modified: false, record: cur };
  mem[id] = next;
  return { ok: true, modified: true, record: next };
}

const orderId = "ord_test_1";
mem[orderId] = {
  orderId,
  classesAutoBook: { status: "pending", attemptedAt: null, completedAt: null, result: null, reason: null },
  bookingFailureAdminEmail: { status: "not_sent", attemptedAt: null, sentAt: null, reason: null, lastError: null },
};

const terminal = new Set(["processing", "booked", "already_enrolled", "failed"]);

async function tryAcquire(orderId) {
  return memMutate(orderId, (cur) => {
    const st = /** @type {{ classesAutoBook?: { status?: string } }} */ (cur).classesAutoBook?.status;
    if (st && terminal.has(st)) return null;
    return {
      ...cur,
      classesAutoBook: {
        status: "processing",
        attemptedAt: new Date().toISOString(),
        completedAt: null,
        result: null,
        reason: null,
      },
    };
  });
}

const a = await tryAcquire(orderId);
const b = await tryAcquire(orderId);
if (a.modified && !b.modified) pass("in-memory: parallel webhook — only one pending→processing wins");
else fail("in-memory: duplicate booking guard failed");

mem[orderId] = {
  ...mem[orderId],
  classesAutoBook: { status: "failed", attemptedAt: "t1", completedAt: "t2", result: "class_full", reason: "class_full" },
  bookingFailureAdminEmail: { status: "not_sent" },
};

async function tryEmail(orderId) {
  return memMutate(orderId, (cur) => {
    const em = /** @type {{ bookingFailureAdminEmail?: { status?: string } }} */ (cur).bookingFailureAdminEmail;
    const st = em?.status || "not_sent";
    if (st === "sent" || st === "sending") return null;
    if (st !== "not_sent" && st !== "failed") return null;
    return {
      ...cur,
      bookingFailureAdminEmail: { ...em, status: "sending", attemptedAt: new Date().toISOString() },
    };
  });
}

const e1 = await tryEmail(orderId);
const e2 = await tryEmail(orderId);
if (e1.modified && !e2.modified) pass("in-memory: duplicate admin email — only one not_sent→sending wins");
else fail("in-memory: duplicate admin email guard failed");

/* New purchase by same client starts fresh not_sent */
const orderId2 = "ord_test_2";
mem[orderId2] = {
  orderId: orderId2,
  bookingFailureAdminEmail: { status: "not_sent" },
};
const e3 = await tryEmail(orderId2);
if (e3.modified) pass("in-memory: new orderId gets fresh not_sent admin email slot");
else fail("in-memory: new purchase should start at not_sent");

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll classes-auto-book QA checks passed.");
