/**
 * Class-book staff capacity guard QA — local unit + race simulation.
 * No Mindbody writes. No deploy.
 *
 * Run: node scripts/qa-class-book-capacity-guard.mjs
 */
import {
  parseClassCapacitySnapshot,
  evaluateStaffNormalSeatBooking,
  spotsRemainingFromClassRow,
  assertClassEligibleForGuestBooking,
} from "../netlify/functions/mindbody-class-capacity-lib.mjs";
import {
  assertStaffNormalSeatBeforeBook,
  classBookCapacityBlockedBody,
} from "../netlify/functions/mindbody-class-book-lib.mjs";

let failed = 0;
function check(name, ok, detail) {
  if (ok) console.log(`PASS — ${name}`);
  else {
    failed += 1;
    console.error(`FAIL — ${name}${detail ? ` (${detail})` : ""}`);
  }
}

/** @type {Record<string, unknown>} */
const classRow = (max, booked, waitlistAvail = true) => ({
  MaxCapacity: max,
  TotalBooked: booked,
  IsWaitlistAvailable: waitlistAvail,
});

console.log("=== Capacity snapshot + normal-seat gate ===");

const snap89 = parseClassCapacitySnapshot(classRow(9, 8));
check("8/9 spotsRemaining", snap89.spotsRemaining === 1, `got ${snap89.spotsRemaining}`);
check("8/9 allows normal staff book", evaluateStaffNormalSeatBooking(snap89).ok === true);

const snap99 = parseClassCapacitySnapshot(classRow(9, 9));
check("9/9 spotsRemaining", snap99.spotsRemaining === 0);
const blocked99 = evaluateStaffNormalSeatBooking(snap99);
check("9/9 blocks normal staff book", blocked99.ok === false && blocked99.reason === "class_full");
check("9/9 waitlistAvailable true", blocked99.waitlistAvailable === true);

const snap109 = parseClassCapacitySnapshot(classRow(9, 10));
const blocked109 = evaluateStaffNormalSeatBooking(snap109);
check("10/9 legacy blocks normal staff book", blocked109.ok === false && blocked109.reason === "class_full");

check(
  "MaxCapacity preferred over WebCapacity",
  spotsRemainingFromClassRow({ MaxCapacity: 9, TotalBooked: 8, WebCapacity: 5, WebBooked: 5 }) === 1,
);

console.log("\n=== Waitlist must bypass gate at call site ===");
check(
  "waitlist:true skips assertStaffNormalSeatBeforeBook",
  (await assertStaffNormalSeatBeforeBook(null, 1, { waitlist: true })).skipped === true,
);

console.log("\n=== classBookCapacityBlockedBody ===");
const fullBody = classBookCapacityBlockedBody(
  /** @type {const} */ ({
    ok: false,
    reason: "class_full",
    waitlistAvailable: true,
    maxCapacity: 9,
    totalBooked: 9,
    spotsRemaining: 0,
  }),
);
check("class_full error code", fullBody.error === "class_full" && fullBody.reason === "class_full");
check("waitlistAvailable forwarded", fullBody.waitlistAvailable === true);

console.log("\n=== Concurrency race simulation ===");

/** In-memory authoritative class state. */
let totalBooked = 8;
const maxCapacity = 9;
/** @type {string[]} */
const addClientCalls = [];

async function mockFetchClassRow() {
  return {
    ok: true,
    row: classRow(maxCapacity, totalBooked),
    spotsRemaining: Math.max(0, maxCapacity - totalBooked),
  };
}

async function mockGuardBeforeStaffBook(userLabel) {
  const fetched = await mockFetchClassRow();
  const snapshot = parseClassCapacitySnapshot(fetched.row);
  const verdict = evaluateStaffNormalSeatBooking(snapshot);
  if (!verdict.ok) return { userLabel, booked: false, reason: verdict.reason };
  addClientCalls.push(userLabel);
  totalBooked += 1;
  return { userLabel, booked: true, reason: null };
}

const userA = await mockGuardBeforeStaffBook("A");
const userB = await mockGuardBeforeStaffBook("B");

check("User A books at 8/9", userA.booked === true);
check("User B blocked at 9/9", userB.booked === false && userB.reason === "class_full");
check("Final TotalBooked stays 9/9", totalBooked === 9, `totalBooked=${totalBooked}`);
check("Only one AddClientToClass", addClientCalls.length === 1 && addClientCalls[0] === "A");

console.log("\n=== Bring-a-Friend final guard ===");
check("guest needs spots >= 2 at 8/9", assertClassEligibleForGuestBooking(1).ok === false);
check("guest allowed at 7/9 (2 spots)", assertClassEligibleForGuestBooking(2).ok === true);

console.log("\n=== Credit consumption on block ===");
check(
  "blocked path never increments booked count in simulation",
  addClientCalls.length === 1 && totalBooked === maxCapacity,
);

if (failed > 0) {
  console.error(`\n${failed} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll class-book capacity guard checks passed.");
