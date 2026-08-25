/**
 * Bring a Friend schedule guest indicator QA (attachment helpers + response shape).
 * Run: node scripts/qa-guest-pass-schedule-guest-indicator.mjs
 */
import {
  attachGuestToUpcomingBookedClasses,
  classDateTimesMatch,
  guestLastInitial,
  __testing,
} from "../netlify/functions/guest-pass-lib.mjs";

let failed = 0;
function check(name, ok, detail) {
  if (ok) console.log(`PASS — ${name}`);
  else {
    failed += 1;
    console.error(`FAIL — ${name}${detail ? ` (${detail})` : ""}`);
  }
}

const CLASS_A = "2026-09-15T18:00:00-04:00";
const CLASS_B = "2026-09-16T10:00:00-04:00";
const CLASS_A_ALT = "2026-09-15T18:00:30-04:00";

/** @type {import("../netlify/functions/guest-pass-lib.mjs").GuestPassUsageRecord} */
const confirmedUsage = {
  status: "confirmed",
  period: "2026-09",
  classId: 9001,
  classDateTime: CLASS_A,
  className: "Power Pilates",
  guestFirstName: "Alex",
  guestLastName: "Rivera",
  guestEmailLower: "alex@example.com",
  guestPhoneNorm: "+15551234567",
};

check("classDateTimesMatch exact iso", classDateTimesMatch(CLASS_A, CLASS_A));
check("classDateTimesMatch within 60s", classDateTimesMatch(CLASS_A, CLASS_A_ALT));
check("classDateTimesMatch different class", !classDateTimesMatch(CLASS_A, CLASS_B));
check("guestLastInitial formats", guestLastInitial("Rivera") === "R.");

const baseUpcoming = [
  {
    classId: 9001,
    name: "Power Pilates",
    instructor: "Jamie",
    startDateTime: CLASS_A,
    spotsRemaining: 3,
  },
  {
    classId: 9002,
    name: "Reformer",
    instructor: "Sam",
    startDateTime: CLASS_B,
    spotsRemaining: 4,
  },
];

const withGuest = attachGuestToUpcomingBookedClasses(
  baseUpcoming,
  confirmedUsage,
  "confirmed",
);
check("confirmed guest attaches to matching class only", withGuest.length === 2);
check(
  "matching row has guestAttached",
  withGuest[0]?.guestAttached?.guestFirstName === "Alex" &&
    withGuest[0]?.guestAttached?.guestLastInitial === "R." &&
    withGuest[0]?.guestAttached?.status === "confirmed",
);
check("other row has no guestAttached", withGuest[1]?.guestAttached == null);
check(
  "guestAttached omits email/phone",
  !JSON.stringify(withGuest[0]?.guestAttached || {}).includes("alex@") &&
    !JSON.stringify(withGuest[0]?.guestAttached || {}).includes("1555"),
);

const appended = attachGuestToUpcomingBookedClasses([], confirmedUsage, "confirmed");
check("guest class appended when missing from dropdown list", appended.length === 1);
check(
  "appended row includes guestAttached",
  appended[0]?.classId === 9001 && appended[0]?.guestAttached?.status === "confirmed",
);

const restored = attachGuestToUpcomingBookedClasses(baseUpcoming, null, null);
check(
  "restored early cancel (no usage) strips guestAttached",
  restored.every((row) => row.guestAttached == null),
);

const cancelled = attachGuestToUpcomingBookedClasses(
  baseUpcoming,
  { ...confirmedUsage, status: "confirmed_cancelled" },
  "confirmed_cancelled",
);
check(
  "confirmed_cancelled omits guestAttached",
  cancelled.every((row) => row.guestAttached == null),
);

const wrongClass = attachGuestToUpcomingBookedClasses(
  [{ classId: 9002, name: "Other", startDateTime: CLASS_B, spotsRemaining: 2 }],
  confirmedUsage,
  "confirmed",
);
check(
  "multiple upcoming classes — badge only on matched classId+time",
  wrongClass.length === 2 &&
    wrongClass.some((r) => r.classId === 9001 && r.guestAttached) &&
    wrongClass.every((r) => r.classId !== 9002 || !r.guestAttached),
);

check(
  "__testing exports schedule helpers",
  typeof __testing.classDateTimesMatch === "function" &&
    typeof __testing.attachGuestToUpcomingBookedClasses === "function",
);

console.log("");
if (failed) {
  console.error(`${failed} check(s) failed.`);
  process.exit(1);
}
console.log("All schedule guest indicator QA checks passed.");
