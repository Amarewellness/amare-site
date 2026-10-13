/**
 * Unlimited daily session limit (2 per class date, America/New_York).
 * Run: node scripts/qa-unlimited-daily-limit.mjs
 */
import {
  UNLIMITED_DAILY_SESSIONS_PER_CLASS_DATE,
  classifyVerifyFailureAsUnlimitedDailyLimit,
  countUnlimitedDailyConsumedSessions,
  evaluateUnlimitedDailyLimitFromVisits,
  isCanonicalUnlimitedProductId,
  unlimitedClientServiceIdSetFromPolicyRows,
  resolvePrimaryUnlimitedClientServiceIdForBooking,
  resolveIntendedBookClientServiceId,
  visitConsumesUnlimitedDailySession,
  visitIsTimelyCancelledReleased,
} from "../netlify/functions/unlimited-daily-limit-lib.mjs";
import { mindbodyStudioCalendarDay } from "../netlify/functions/member-topup-lib.mjs";

let failed = 0;

function check(name, ok, detail = "") {
  if (!ok) {
    failed += 1;
    console.log(`FAIL — ${name}`);
    if (detail) console.log(`  ${detail}`);
    return;
  }
  console.log(`PASS — ${name}`);
}

const UNLIMITED_CS = 34497;
const PACK_CS = 22378;
const unlimitedIds = new Set([UNLIMITED_CS]);
const policyRows = [
  { Id: UNLIMITED_CS, ProductId: 100135, Remaining: 99997 },
  { Id: PACK_CS, ProductId: 100134, Remaining: 8 },
];
const unlimitedSet = unlimitedClientServiceIdSetFromPolicyRows(policyRows);

check("canonical product ids", isCanonicalUnlimitedProductId(100135) && isCanonicalUnlimitedProductId(100056));
check("unlimited CS set", unlimitedSet.has(UNLIMITED_CS) && !unlimitedSet.has(PACK_CS));

const OCT12 = "2026-10-12";
const OCT20 = "2026-10-20";

function visit(partial) {
  return {
    Id: partial.Id,
    ClassId: partial.ClassId ?? 12885,
    StartDateTime: partial.StartDateTime ?? "2026-10-12T19:00:00",
    ServiceId: partial.ServiceId ?? UNLIMITED_CS,
    ProductId: partial.ProductId ?? 100135,
    AppointmentStatus: partial.AppointmentStatus ?? "Booked",
    LateCancelled: partial.LateCancelled ?? false,
    Missed: partial.Missed ?? false,
    Waitlist: partial.Waitlist ?? false,
    ...partial,
  };
}

check("1 — 0 same-day → allow", evaluateUnlimitedDailyLimitFromVisits({
  clientId: 1,
  classId: 1,
  targetClassDate: OCT12,
  selectedClientServiceId: UNLIMITED_CS,
  productId: 100135,
  unlimitedClientServiceIds: unlimitedSet,
  visits: [],
}).decision === "allow");

check(
  "2 — 1 active same-day → allow",
  evaluateUnlimitedDailyLimitFromVisits({
    clientId: 1,
    classId: 1,
    targetClassDate: OCT12,
    selectedClientServiceId: UNLIMITED_CS,
    productId: 100135,
    unlimitedClientServiceIds: unlimitedSet,
    visits: [visit({ Id: 1, AppointmentStatus: "Booked" })],
  }).decision === "allow",
);

check(
  "3 — 2 active same-day → block",
  evaluateUnlimitedDailyLimitFromVisits({
    clientId: 1,
    classId: 1,
    targetClassDate: OCT12,
    selectedClientServiceId: UNLIMITED_CS,
    productId: 100135,
    unlimitedClientServiceIds: unlimitedSet,
    visits: [
      visit({ Id: 1, ClassId: 100, AppointmentStatus: "Booked" }),
      visit({ Id: 2, ClassId: 101, AppointmentStatus: "Booked" }),
    ],
  }).decision === "block",
);

check(
  "4 — 1 active + 1 late cancel → block",
  evaluateUnlimitedDailyLimitFromVisits({
    clientId: 1,
    classId: 1,
    targetClassDate: OCT12,
    selectedClientServiceId: UNLIMITED_CS,
    productId: 100135,
    unlimitedClientServiceIds: unlimitedSet,
    visits: [
      visit({ Id: 1, AppointmentStatus: "Booked" }),
      visit({ Id: 2, AppointmentStatus: "Cancelled", LateCancelled: true, Missed: true }),
    ],
  }).decision === "block",
);

check(
  "5 — 2 late cancelled → block",
  evaluateUnlimitedDailyLimitFromVisits({
    clientId: 1,
    classId: 1,
    targetClassDate: OCT12,
    selectedClientServiceId: UNLIMITED_CS,
    productId: 100135,
    unlimitedClientServiceIds: unlimitedSet,
    visits: [
      visit({ Id: 49750, AppointmentStatus: "Cancelled", LateCancelled: true, Missed: true }),
      visit({ Id: 49753, AppointmentStatus: "Cancelled", LateCancelled: true, Missed: true }),
    ],
  }).decision === "block",
);

check(
  "6 — 1 noshow + 1 active → block",
  evaluateUnlimitedDailyLimitFromVisits({
    clientId: 1,
    classId: 1,
    targetClassDate: OCT12,
    selectedClientServiceId: UNLIMITED_CS,
    productId: 100135,
    unlimitedClientServiceIds: unlimitedSet,
    visits: [
      visit({ Id: 1, AppointmentStatus: "NoShow", Missed: true }),
      visit({ Id: 2, AppointmentStatus: "Booked" }),
    ],
  }).decision === "block",
);

check(
  "7 — timely cancelled released → not consumed",
  !visitConsumesUnlimitedDailySession(
    visit({ Id: 9, AppointmentStatus: "Cancelled", LateCancelled: false }),
    OCT12,
    unlimitedIds,
  ),
);

check(
  "8 — waitlist → not consumed",
  !visitConsumesUnlimitedDailySession(visit({ Id: 10, Waitlist: true, AppointmentStatus: "Waitlist" }), OCT12, unlimitedIds),
);

check(
  "9 — unpaid temp → not consumed",
  !visitConsumesUnlimitedDailySession(
    visit({ Id: 11, ServiceName: "Unpaid Visit", ServiceId: UNLIMITED_CS }),
    OCT12,
    unlimitedIds,
  ),
);

check(
  "10 — other class date → not counted",
  countUnlimitedDailyConsumedSessions(
    [visit({ Id: 49752, StartDateTime: "2026-10-20T06:00:00", ClassId: 14359 })],
    OCT12,
    unlimitedIds,
  ).count === 0,
);

check(
  "11 — two pack visits do not exhaust unlimited quota",
  countUnlimitedDailyConsumedSessions(
    [
      visit({ Id: 20, ServiceId: PACK_CS, ProductId: 100134 }),
      visit({ Id: 21, ServiceId: PACK_CS, ProductId: 100134, ClassId: 999 }),
    ],
    OCT12,
    unlimitedIds,
  ).count === 0,
);

check(
  "12 — one unlimited + one pack → count 1",
  countUnlimitedDailyConsumedSessions(
    [
      visit({ Id: 30, ServiceId: UNLIMITED_CS }),
      visit({ Id: 31, ServiceId: PACK_CS, ProductId: 100134, ClassId: 888 }),
    ],
    OCT12,
    unlimitedIds,
  ).count === 1,
);

check(
  "13 — third unlimited attempt blocked at 2 prior",
  evaluateUnlimitedDailyLimitFromVisits({
    clientId: 100002726,
    classId: 8939,
    targetClassDate: OCT12,
    selectedClientServiceId: UNLIMITED_CS,
    productId: 100135,
    unlimitedClientServiceIds: unlimitedSet,
    visits: [
      visit({ Id: 49750, AppointmentStatus: "Cancelled", LateCancelled: true, Missed: true }),
      visit({ Id: 49753, AppointmentStatus: "Cancelled", LateCancelled: true, Missed: true }),
    ],
  }).decision === "block",
);

check(
  "explicit pack id skips unlimited precheck service",
  resolvePrimaryUnlimitedClientServiceIdForBooking(PACK_CS, [UNLIMITED_CS, PACK_CS], unlimitedSet) === null,
);

check(
  "auto-select pack when unlimited quota exhausted",
  resolveIntendedBookClientServiceId(null, [UNLIMITED_CS, PACK_CS], unlimitedSet, {
    unlimitedQuotaConsumed: 2,
  }) === PACK_CS,
);

check(
  "auto-select unlimited when quota not exhausted",
  resolveIntendedBookClientServiceId(null, [UNLIMITED_CS, PACK_CS], unlimitedSet, {
    unlimitedQuotaConsumed: 1,
  }) === UNLIMITED_CS,
);

check(
  "quota 2 + only unlimited → intended unlimited (precheck blocks)",
  resolveIntendedBookClientServiceId(null, [UNLIMITED_CS], unlimitedSet, { unlimitedQuotaConsumed: 2 }) ===
    UNLIMITED_CS,
);

check(
  "explicit pack selection skips unlimited cap",
  evaluateUnlimitedDailyLimitFromVisits({
    clientId: 1,
    classId: 1,
    targetClassDate: OCT12,
    selectedClientServiceId: PACK_CS,
    productId: 100134,
    unlimitedClientServiceIds: unlimitedSet,
    visits: [
      visit({ Id: 49750, LateCancelled: true, Missed: true, AppointmentStatus: "Cancelled" }),
      visit({ Id: 49753, LateCancelled: true, Missed: true, AppointmentStatus: "Cancelled" }),
    ],
  }).decision === "not_applicable",
);

check(
  "14 — finite member not applicable",
  evaluateUnlimitedDailyLimitFromVisits({
    clientId: 1,
    classId: 1,
    targetClassDate: OCT12,
    selectedClientServiceId: PACK_CS,
    productId: 100134,
    unlimitedClientServiceIds: unlimitedSet,
    visits: [
      visit({ Id: 1, ServiceId: PACK_CS, ProductId: 100134 }),
      visit({ Id: 2, ServiceId: PACK_CS, ProductId: 100134, ClassId: 2 }),
    ],
  }).decision === "not_applicable",
);

check(
  "15 — ambiguous failure consumed < 2 → no reclassify",
  !classifyVerifyFailureAsUnlimitedDailyLimit({
    verify: { ok: false, reason: "remaining_unchanged", detail: { visitServiceId: null } },
    usedServiceId: UNLIMITED_CS,
    policyRows,
    targetClassDate: OCT12,
    visits: [visit({ Id: 49750, LateCancelled: true, Missed: true, AppointmentStatus: "Cancelled" })],
    rollingBackVisitId: 49755,
  }),
);

check(
  "16 — quota proven after rollback → reclassify",
  classifyVerifyFailureAsUnlimitedDailyLimit({
    verify: { ok: false, reason: "remaining_unchanged", detail: { visitServiceId: null } },
    usedServiceId: UNLIMITED_CS,
    policyRows,
    targetClassDate: OCT12,
    visits: [
      visit({ Id: 49750, LateCancelled: true, Missed: true, AppointmentStatus: "Cancelled" }),
      visit({ Id: 49753, LateCancelled: true, Missed: true, AppointmentStatus: "Cancelled" }),
    ],
    rollingBackVisitId: 49755,
  }),
);

const etDay = mindbodyStudioCalendarDay("2026-10-13T01:30:00");
check("17 — ET class date from naive wall time", etDay === "2026-10-13");

check(
  "snir5 Oct 12 fixture blocks third",
  evaluateUnlimitedDailyLimitFromVisits({
    clientId: 100002726,
    classId: 8939,
    targetClassDate: OCT12,
    selectedClientServiceId: UNLIMITED_CS,
    productId: 100135,
    unlimitedClientServiceIds: unlimitedSet,
    visits: [
      visit({ Id: 49750, ClassId: 12885, LateCancelled: true, Missed: true, AppointmentStatus: "Cancelled" }),
      visit({ Id: 49753, ClassId: 12885, LateCancelled: true, Missed: true, AppointmentStatus: "Cancelled" }),
    ],
  }).decision === "block",
);

check(
  "Oct 20 booking not blocked by Oct 12 quota",
  evaluateUnlimitedDailyLimitFromVisits({
    clientId: 100002726,
    classId: 14359,
    targetClassDate: OCT20,
    selectedClientServiceId: UNLIMITED_CS,
    productId: 100135,
    unlimitedClientServiceIds: unlimitedSet,
    visits: [
      visit({ Id: 49750, LateCancelled: true, Missed: true, AppointmentStatus: "Cancelled" }),
      visit({ Id: 49753, LateCancelled: true, Missed: true, AppointmentStatus: "Cancelled" }),
    ],
  }).decision === "allow",
);

check("daily limit constant", UNLIMITED_DAILY_SESSIONS_PER_CLASS_DATE === 2);

check(
  "timely cancel helper",
  visitIsTimelyCancelledReleased(visit({ AppointmentStatus: "Cancelled", LateCancelled: false })),
);

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nAll unlimited daily limit checks passed.");
