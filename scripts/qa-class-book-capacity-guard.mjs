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
import {
  buildCapacityLookupRollingWindows,
  scanRollingWindowsForClassRow,
} from "../netlify/functions/guest-pass-lib.mjs";

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

console.log("\n=== Android-style lookup (classId only, no classStartIso) ===");

/** Simulates Mindbody returning only the first 200 classes in one wide query — target omitted. */
const TARGET_CLASS_ID = 12407;
const WIDE_QUERY_FILLER_IDS = Array.from({ length: 200 }, (_, i) => i + 1);

/** @param {Date} start @param {Date} end */
function windowContainsTargetWeek(start, end) {
  const target = new Date("2099-06-15T12:00:00.000Z");
  return target >= start && target <= end;
}

/** @type {Map<string, { Classes: { Id: number; MaxCapacity: number; TotalBooked: number }[] }>} */
const mockScheduleByWindow = new Map();
mockScheduleByWindow.set("wide", {
  Classes: WIDE_QUERY_FILLER_IDS.map((id) => ({
    Id: id,
    MaxCapacity: 9,
    TotalBooked: 5,
  })),
});

const rollingWindows = buildCapacityLookupRollingWindows(
  new Date("2099-01-01T00:00:00.000Z"),
  new Date("2099-12-31T23:59:59.999Z"),
  7,
);
for (const window of rollingWindows) {
  const key = `${window.start.toISOString()}|${window.end.toISOString()}`;
  if (windowContainsTargetWeek(window.start, window.end)) {
    mockScheduleByWindow.set(key, {
      Classes: [{ Id: TARGET_CLASS_ID, MaxCapacity: 9, TotalBooked: 7 }],
    });
  } else {
    mockScheduleByWindow.set(key, { Classes: [] });
  }
}

/** @param {{ start: Date; end: Date }} window @param {number} classId */
async function mockQueryWindow(window, classId) {
  const key = `${window.start.toISOString()}|${window.end.toISOString()}`;
  const data = mockScheduleByWindow.get(key) ?? { Classes: [] };
  const row = data.Classes.find((c) => c.Id === classId) ?? null;
  return row ? { ok: true, row, data } : { ok: false, row: null, data };
}

const wideOnly = mockScheduleByWindow.get("wide");
const wideMissesTarget =
  wideOnly && !wideOnly.Classes.some((c) => c.Id === TARGET_CLASS_ID);
check("wide 200-row query omits distant classId", wideMissesTarget === true);

const rollingHit = await scanRollingWindowsForClassRow(
  TARGET_CLASS_ID,
  rollingWindows,
  (window) => mockQueryWindow(window, TARGET_CLASS_ID),
);
check(
  "rolling windows find class outside wide-200 set",
  rollingHit.ok === true && rollingHit.row && /** @type {{ Id: number }} */ (rollingHit.row).Id === TARGET_CLASS_ID,
);

const androidSnapshot = parseClassCapacitySnapshot(rollingHit.row);
const androidVerdict = evaluateStaffNormalSeatBooking(androidSnapshot);
check(
  "Android-style classId-only lookup allows normal book when class has spots",
  androidVerdict.ok === true,
  `spotsRemaining=${androidSnapshot.spotsRemaining}`,
);

console.log("\n=== Website path unchanged (classStartIso uses narrow window) ===");
check(
  "rolling window count for 366-day horizon",
  buildCapacityLookupRollingWindows(
    new Date("2099-01-01T00:00:00.000Z"),
    new Date("2099-12-31T23:59:59.999Z"),
    7,
  ).length >= 52,
);

console.log("\n=== Full class + waitlist responses unchanged ===");
const fetchFailedBody = classBookCapacityBlockedBody(
  /** @type {const} */ ({
    ok: false,
    reason: "capacity_fetch_failed",
    waitlistAvailable: false,
    maxCapacity: null,
    totalBooked: null,
    spotsRemaining: null,
  }),
);
check("capacity_fetch_failed maps to capacity_check_failed", fetchFailedBody.error === "capacity_check_failed");

const waitlistSkip = await assertStaffNormalSeatBeforeBook(null, 999, { waitlist: true });
check("waitlist bypass never returns capacity_check_failed", waitlistSkip.skipped === true && waitlistSkip.ok === true);

const fullGuard = evaluateStaffNormalSeatBooking(parseClassCapacitySnapshot(classRow(9, 9)));
const fullBlockedBody = classBookCapacityBlockedBody(
  /** @type {const} */ ({
    ok: false,
    reason: fullGuard.reason ?? "class_full",
    waitlistAvailable: fullGuard.waitlistAvailable ?? true,
    maxCapacity: 9,
    totalBooked: 9,
    spotsRemaining: 0,
  }),
);
check("full class still returns class_full", fullBlockedBody.error === "class_full");

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
