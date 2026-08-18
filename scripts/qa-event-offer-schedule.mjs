import assert from "node:assert/strict";
import fs from "node:fs";
import {
  eventScheduleBlocks,
  formatEventSchedule,
  parseEventCleaningCents,
  parseEventScheduleInput,
  validateEventReservationInput,
} from "../netlify/functions/event-booking-lib.mjs";
import { toPublicOffer } from "../netlify/functions/event-offer-store.mjs";
import { eventEmailSummary } from "../netlify/functions/event-reservation-emails.mjs";
import { fulfillEventDepositSession } from "../netlify/functions/event-reservation-fulfill.mjs";

const cases = [
  [{ beforeMinutes: 30, sessionMinutes: 60, afterMinutes: 30, sessionLabel: "Workout" }, ["17:00", "17:30", "18:30", "19:00"]],
  [{ beforeMinutes: 0, sessionMinutes: 60, afterMinutes: 60, sessionLabel: "Session" }, ["17:00", "18:00", "19:00"]],
  [{ beforeMinutes: 0, sessionMinutes: 300, afterMinutes: 0, sessionLabel: "Rental" }, ["12:00", "17:00"]],
  [{ beforeMinutes: 30, sessionMinutes: 90, afterMinutes: 30, sessionLabel: "Training" }, ["17:00", "17:30", "19:00", "19:30"]],
];

for (const [schedule, expected] of cases) {
  assert.deepEqual(parseEventScheduleInput({ schedule }), { ok: true, schedule });
  const { blocks } = eventScheduleBlocks(expected[0], schedule);
  assert.deepEqual([blocks[0].startHhmm, ...blocks.map((b) => b.endHhmm)], expected);
}

assert.deepEqual(parseEventCleaningCents("75", false), { ok: true, cents: 0 });
assert.deepEqual(parseEventCleaningCents("75.25", true), { ok: true, cents: 7525 });

const schedule = cases[2][0];
const offer = {
  id: "off_qa",
  firstName: "QA",
  lastName: "Guest",
  email: "qa@example.invalid",
  phone: "",
  eventDate: "2099-08-20",
  eventTime: "12:00",
  lockDateTime: true,
  lockName: true,
  lockEmail: true,
  lockPhone: false,
  packageCents: 55000,
  depositCents: 20000,
  cleaningCents: 7525,
  schedule,
  status: "sent",
  expiresAt: "2099-08-21T00:00:00.000Z",
  createdAt: "2099-08-19T00:00:00.000Z",
};
const publicOffer = toPublicOffer(offer);
assert.deepEqual(publicOffer.schedule, schedule);
assert.equal(publicOffer.cleaningCents, 7525);

const priced = validateEventReservationInput(
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
  { packageCents: 55000, depositCents: 20000, cleaningCents: 7525 },
);
assert.equal(priced.ok, true);
assert.equal(priced.remainingCents, 55000 + 15000 + 7525 - 20000);

const rec = {
  ...offer,
  styling: true,
  stylingCents: 15000,
  remainingCents: priced.remainingCents,
  room: "reformer",
  guests: 8,
};
const email = eventEmailSummary(rec);
assert.equal(email.total, 55000 + 15000 + 7525);
assert.equal(email.cleaning, "$75.25");
assert.equal(email.when.rangeLine, "Rental 12:00 PM–5:00 PM");

const stored = { ...rec, id: "evt_qa", offerId: offer.id, status: "deposit_pending", stripeCheckoutSessionId: "cs_qa", emailsSent: false };
const reservationStore = {
  available: true,
  async get(id) { return id === stored.id ? { ...stored } : null; },
  async getByCheckoutSessionId(id) { return id === stored.stripeCheckoutSessionId ? { ...stored } : null; },
  async patch(id, patch) { assert.equal(id, stored.id); Object.assign(stored, patch); return { ok: true }; },
};
let persistedOffer = { ...offer };
const offerStore = {
  available: true,
  async get(id) { return id === offer.id ? { ...persistedOffer } : null; },
  async put(next) { persistedOffer = { ...next }; return { ok: true }; },
};
let emailed;
const stripe = {
  paymentIntents: { async retrieve() { return { id: "pi_qa", payment_method: "pm_qa" }; } },
  customers: { async update() { return {}; } },
};
const fulfilled = await fulfillEventDepositSession(
  stripe,
  { id: "cs_qa", metadata: { flow: "event_deposit", reservationId: stored.id, offerId: offer.id }, customer: "cus_qa", payment_intent: "pi_qa", livemode: false, customer_details: {} },
  null,
  { reservationStore, offerStore, async sendDepositEmails(latest) { emailed = latest; return { client: { ok: true }, admin: { ok: true } }; } },
);
assert.equal(fulfilled.ok, true);
assert.deepEqual(emailed.schedule, schedule);
assert.equal(emailed.cleaningCents, 7525);
assert.deepEqual(persistedOffer.schedule, schedule);
assert.equal(persistedOffer.cleaningCents, 7525);
assert.equal(persistedOffer.status, "used");

const adminJs = fs.readFileSync(new URL("../src/js/admin-events.js", import.meta.url), "utf8");
const reserveJs = fs.readFileSync(new URL("../src/js/event-reserve.js", import.meta.url), "utf8");
assert.match(adminJs, /schedule:\s*currentOfferSchedule\(\)/);
assert.match(adminJs, /addCleaning:/);
assert.match(reserveJs, /offer\.schedule/);
assert.match(reserveJs, /offer\.cleaningCents/);
assert.doesNotMatch(reserveJs, /addMinutesHhmm\(eventTime,\s*(?:-30|60|90|120)\)/);

const expiredSnapshot = { ...offer, status: "superseded" };
assert.deepEqual(expiredSnapshot.schedule, schedule);
assert.equal(expiredSnapshot.cleaningCents, 7525);

console.log("event offer schedule QA: PASS");
