import assert from "node:assert/strict";
import {
  assertEventLiveStripeBlocked,
  canArchiveReservation,
  canPermanentlyDeleteReservation,
  eventCheckoutIdempotencyKey,
  reservationHasAnyRecordedPayment,
  validateEventReservationInput,
} from "../netlify/functions/event-booking-lib.mjs";
import { fulfillEventDepositSession } from "../netlify/functions/event-reservation-fulfill.mjs";

/** @param {Partial<import("../netlify/functions/event-reservation-store.mjs").EventReservation>} o */
function rec(o) {
  return {
    id: "evt_qa",
    status: "deposit_pending",
    firstName: "QA",
    lastName: "Guest",
    email: "qa@example.invalid",
    eventDate: "2099-08-20",
    eventTime: "12:00",
    guests: 8,
    room: "reformer",
    packageCents: 55000,
    depositCents: 20000,
    stylingCents: 15000,
    remainingCents: 54900,
    cleaningCents: 4900,
    ...o,
  };
}

assert.equal(reservationHasAnyRecordedPayment(rec({})), false);
assert.equal(reservationHasAnyRecordedPayment(rec({ depositPaid: true })), true);
assert.equal(reservationHasAnyRecordedPayment(rec({ remainingPaid: true })), true);
assert.equal(reservationHasAnyRecordedPayment(rec({ overtimeCentsTotal: 5000 })), true);
assert.equal(reservationHasAnyRecordedPayment(rec({ customCentsTotal: 2500 })), true);
assert.equal(reservationHasAnyRecordedPayment(rec({ remainingStripeInvoiceId: "in_qa" })), true);

assert.equal(canPermanentlyDeleteReservation(rec({})), true);
assert.equal(canPermanentlyDeleteReservation(rec({ depositPaid: true })), false);
assert.equal(canPermanentlyDeleteReservation(rec({ status: "confirmed" })), false);
assert.equal(canPermanentlyDeleteReservation(rec({ archived: true })), false);

assert.equal(canArchiveReservation(rec({ depositPaid: true, status: "canceled" })), true);
assert.equal(canArchiveReservation(rec({ depositPaid: true, eventDate: "2020-01-01" })), true);
assert.equal(
  canArchiveReservation(rec({ depositPaid: true, status: "confirmed", eventDate: "2099-08-20" })),
  false,
);
assert.equal(canArchiveReservation(rec({})), false);
assert.equal(canArchiveReservation(rec({ depositPaid: true, archived: true })), false);

assert.equal(eventCheckoutIdempotencyKey("evt_1", 0, false), "event-deposit-evt_1-g0");
assert.equal(eventCheckoutIdempotencyKey("evt_1", 2, true), "event-remaining-checkout-evt_1-g2");

const prevCtx = process.env.CONTEXT;
const prevSk = process.env.STRIPE_SECRET_KEY;
process.env.CONTEXT = "deploy-preview";
process.env.STRIPE_SECRET_KEY = "sk_live_test";
const blocked = assertEventLiveStripeBlocked();
assert.equal(blocked.ok, false);
assert.equal(blocked.error, "live_stripe_blocked");
process.env.CONTEXT = "production";
assert.equal(assertEventLiveStripeBlocked().ok, true);
process.env.CONTEXT = prevCtx;
process.env.STRIPE_SECRET_KEY = prevSk;

const priced549 = validateEventReservationInput(
  {
    firstName: "QA",
    lastName: "Guest",
    email: "qa@example.invalid",
    phone: "+15555550100",
    eventDate: "2099-08-20",
    eventTime: "12:00",
    guests: 8,
    room: "reformer",
    styling: true,
    consent: true,
  },
  { packageCents: 55000, depositCents: 20000, cleaningCents: 4900 },
);
assert.equal(priced549.ok, true);
assert.equal(priced549.remainingCents, 54900);

const unpaidStored = rec({ id: "evt_unpaid", status: "deposit_pending", stripeCheckoutSessionId: "cs_unpaid" });
const unpaidStore = {
  available: true,
  async get(id) {
    return id === unpaidStored.id ? { ...unpaidStored } : null;
  },
  async getByCheckoutSessionId(id) {
    return id === unpaidStored.stripeCheckoutSessionId ? { ...unpaidStored } : null;
  },
  async patch(id, patch) {
    Object.assign(unpaidStored, patch);
    return { ok: true };
  },
};
const unpaidOutcome = await fulfillEventDepositSession(
  { paymentIntents: { async retrieve() { return { id: "pi_x", payment_method: "pm_x" }; } }, customers: { async update() { return {}; } } },
  {
    id: "cs_unpaid",
    mode: "payment",
    payment_status: "unpaid",
    metadata: { flow: "event_deposit", reservationId: unpaidStored.id },
    customer: "cus_x",
    payment_intent: "pi_x",
    livemode: false,
    customer_details: {},
  },
  null,
  { reservationStore: unpaidStore, offerStore: { available: false }, async sendDepositEmails() { return { client: { ok: true }, admin: { ok: true } }; } },
);
assert.equal(unpaidOutcome.noop, true);
assert.equal(unpaidStored.depositPaid, undefined);

const canceledStored = rec({
  id: "evt_canceled",
  status: "canceled",
  stripeCheckoutSessionId: "cs_canceled",
});
const canceledStore = {
  available: true,
  async get(id) {
    return id === canceledStored.id ? { ...canceledStored } : null;
  },
  async getByCheckoutSessionId(id) {
    return id === canceledStored.stripeCheckoutSessionId ? { ...canceledStored } : null;
  },
  async patch(id, patch) {
    Object.assign(canceledStored, patch);
    return { ok: true };
  },
};
const canceledOutcome = await fulfillEventDepositSession(
  { paymentIntents: { async retrieve() { return { id: "pi_c", payment_method: "pm_c" }; } }, customers: { async update() { return {}; } } },
  {
    id: "cs_canceled",
    mode: "payment",
    payment_status: "paid",
    metadata: { flow: "event_deposit", reservationId: canceledStored.id },
    customer: "cus_c",
    payment_intent: "pi_c",
    livemode: false,
    customer_details: {},
  },
  null,
  { reservationStore: canceledStore, offerStore: { available: false }, async sendDepositEmails() { return { client: { ok: true }, admin: { ok: true } }; } },
);
assert.equal(canceledOutcome.ok, true);
assert.equal(canceledStored.status, "canceled");
assert.equal(canceledStored.depositPaid, true);

console.log("event lean hardening QA: PASS");
