/**
 * Unit checks for staff-schedule-lib.mjs (run: node scripts/staff-schedule-lib-test.mjs)
 */
import assert from "node:assert/strict";
import {
  addDaysYmd,
  buildAvailabilityFormDays,
  buildAvailabilityOthersByCell,
  buildEmptyWeek,
  clearAvailabilitySubmission,
  buildStaffPeriodSummary,
  buildStaffSummaryCsv,
  buildWeekCsv,
  buildWhatsAppText,
  enrichWeekResponse,
  ensureWeekSlots,
  earlyMorningApplicable,
  shiftSlotApplicable,
  shiftDurationMinutes,
  shiftTotalMinutes,
  staffAvailabilitySlots,
  staffPinMatches,
  staffTotalHoursFromPlanned,
  staffTotalMinutesFromPlanned,
  formatPlannedHours,
  formatWeekRangeLabel,
  formatWeekOfLabel,
  listWeekStartsOverlappingRange,
  nextWeekStart,
  normalizeAvailabilitySelections,
  normalizeStaffHourlyRate,
  summarizeAvailabilityForAdmin,
  staffPayFromHourlyRate,
  isValidStaffPin,
  isSundayYmd,
  isValidYmd,
  isWeekStartYmd,
  weekStartForYmd,
  currentWeekStart,
  normalizeWeekPayload,
  parseStaffSchedulePath,
  slotDisplayLabel,
  weekDatesFromStart,
} from "../netlify/functions/staff-schedule-lib.mjs";
import {
  availabilityWindowStatus,
  canSubmitAvailabilityForWeek,
  effectiveAvailabilityOpenWeekStart,
  isAvailabilityWeekLocked,
  staffAvailabilityTargetWeekStart,
} from "../netlify/functions/staff-schedule-availability-window.mjs";
import { computeClassCoverageFromRows } from "../netlify/functions/staff-schedule-class-hours.mjs";
import { buildStaffScheduleEmailContent, buildStaffEmailTargets, buildStaffLoginEmailContent, buildStaffAvailabilityReminderEmailContent, buildStaffAvailabilitySubmittedAdminEmailContent, formatAvailabilitySelectionLabel } from "../netlify/functions/staff-schedule-email.mjs";

const testConfig = {
  timezone: "America/New_York",
  weekStartsOn: "sunday",
  shiftTemplates: {
    early_morning: { label: "Early Morning", start: "06:00", end: "08:00" },
    morning: { label: "Morning", start: "08:00", end: "14:00" },
    evening: { label: "Evening", start: "15:00", end: "20:00" },
  },
};

assert.equal(isValidYmd("2026-05-26"), true);
assert.equal(isValidYmd("2026-13-01"), false);
assert.equal(isSundayYmd("2026-05-24"), true);
assert.equal(isSundayYmd("2026-05-25"), false);
assert.equal(isWeekStartYmd("2026-05-24", "sunday"), true);
assert.equal(isWeekStartYmd("2026-05-25", "sunday"), false);
assert.equal(weekStartForYmd("2026-05-28", "sunday"), "2026-05-24");
assert.equal(nextWeekStart("America/New_York", "sunday"), addDaysYmd(currentWeekStart("America/New_York", "sunday"), 7));
assert.equal(slotDisplayLabel("early_morning"), "Early Morning");
assert.deepEqual(weekDatesFromStart("2026-05-24"), [
  "2026-05-24",
  "2026-05-25",
  "2026-05-26",
  "2026-05-27",
  "2026-05-28",
  "2026-05-29",
  "2026-05-30",
]);

const week = buildEmptyWeek("2026-05-24");
assert.equal(week.shifts.length, 21);
assert.equal(week.status, "draft");

const legacyWeek = buildEmptyWeek("2026-05-24");
legacyWeek.shifts = legacyWeek.shifts.filter((s) => s.slot !== "early_morning");
assert.equal(legacyWeek.shifts.length, 14);
ensureWeekSlots(legacyWeek);
assert.equal(legacyWeek.shifts.length, 21);

const staffMap = new Map([
  [
    "st_test",
    {
      id: "st_test",
      name: "Sophie",
      email: "sophie@example.com",
      pin: "1234",
      hourlyRate: 20,
      active: true,
      createdAt: "",
      updatedAt: "",
    },
  ],
]);

week.shifts.find((s) => s.date === "2026-05-25" && s.slot === "morning").status = "assigned";
week.shifts.find((s) => s.date === "2026-05-25" && s.slot === "morning").staffId = "st_test";

const normalized = normalizeWeekPayload(
  {
    shifts: week.shifts.map((s) => ({
      date: s.date,
      slot: s.slot,
      staffId: s.staffId,
      status: s.status,
      note: s.note,
    })),
  },
  week,
  staffMap,
  null,
);
assert.equal(normalized.length, 21);

const enriched = enrichWeekResponse(week, testConfig, [staffMap.get("st_test")]);
assert.equal(enriched.byStaff.st_test.totalShifts, 1);

const csv = buildWeekCsv(week, enriched.config, [staffMap.get("st_test")]);
assert.match(csv, /staffName/);
assert.match(csv, /Sophie/);

const wa = buildWhatsAppText(week, enriched.config, [staffMap.get("st_test")], enriched.classCoverage);
assert.match(wa, /AMARÉ Front Desk Schedule/);
assert.match(wa, /Sophie/);

const coverage = computeClassCoverageFromRows(
  [
    {
      StartDateTime: "2026-05-25T07:30:00",
      EndDateTime: "2026-05-25T08:30:00",
    },
    {
      StartDateTime: "2026-05-25T09:00:00",
      EndDateTime: "2026-05-25T10:00:00",
    },
    {
      StartDateTime: "2026-05-25T18:00:00",
      EndDateTime: "2026-05-25T19:00:00",
    },
  ],
  "2026-05-24",
  testConfig,
);
assert.equal(coverage["2026-05-25"].early_morning.start, "07:30");
assert.equal(coverage["2026-05-25"].early_morning.end, "08:30");
assert.equal(coverage["2026-05-25"].early_morning.source, "classes");
assert.equal(coverage["2026-05-25"].morning.start, "09:00");
assert.equal(coverage["2026-05-25"].morning.end, "10:00");
assert.equal(coverage["2026-05-25"].evening.start, "18:00");
assert.equal(coverage["2026-05-25"].evening.end, "19:00");

const badMorningStartConfig = {
  ...testConfig,
  shiftTemplates: {
    ...testConfig.shiftTemplates,
    morning: { label: "Morning", start: "06:00", end: "14:00" },
  },
};
const splitCheck = computeClassCoverageFromRows(
  [{ StartDateTime: "2026-06-04T06:00:00", EndDateTime: "2026-06-04T07:00:00" }],
  "2026-05-31",
  badMorningStartConfig,
);
assert.equal(splitCheck["2026-06-04"].early_morning.source, "classes");
assert.equal(splitCheck["2026-06-04"].early_morning.start, "06:00");
assert.equal(splitCheck["2026-06-04"].morning.source, "template");

const classCoverage = coverage;
assert.equal(earlyMorningApplicable(classCoverage, "2026-05-25"), true);
assert.equal(earlyMorningApplicable(classCoverage, "2026-05-30"), false);
assert.equal(shiftSlotApplicable(classCoverage, "2026-05-25", "evening"), true);
assert.equal(shiftSlotApplicable(classCoverage, "2026-05-29", "evening"), false);

assert.throws(
  () =>
    normalizeWeekPayload(
      {
        shifts: week.shifts.map((s) => ({
          date: s.date,
          slot: s.slot,
          staffId:
            s.date === "2026-05-30" && s.slot === "morning" ? "st_test" : s.staffId,
          status:
            s.date === "2026-05-30" && s.slot === "morning" ? "assigned" : s.status,
          note: s.note,
        })),
      },
      week,
      staffMap,
      classCoverage,
      true,
    ),
  /shift_slot_not_applicable/,
);

assert.deepEqual(parseStaffSchedulePath("/api/admin/staff-schedule/staff"), {
  kind: "staff_collection",
});
assert.deepEqual(parseStaffSchedulePath("/api/admin/staff-schedule/staff/st_abc"), {
  kind: "staff_item",
  staffId: "st_abc",
});
assert.deepEqual(parseStaffSchedulePath("/api/admin/staff-schedule/weeks/2026-05-24/publish"), {
  kind: "week_publish",
  weekStart: "2026-05-24",
});
assert.deepEqual(parseStaffSchedulePath("/api/admin/staff-schedule/weeks/2026-05-24/email"), {
  kind: "week_email",
  weekStart: "2026-05-24",
});
assert.deepEqual(parseStaffSchedulePath("/api/admin/staff-schedule/reports/staff-summary"), {
  kind: "staff_summary",
});
assert.deepEqual(parseStaffSchedulePath("/api/admin/staff-schedule/reports/staff-summary/export.csv"), {
  kind: "staff_summary_export",
});
assert.deepEqual(parseStaffSchedulePath("/api/admin/staff-schedule/weeks/2026-05-24/availability"), {
  kind: "week_availability",
  weekStart: "2026-05-24",
});
assert.deepEqual(parseStaffSchedulePath("/api/admin/staff-schedule/weeks/2026-05-24/availability/open"), {
  kind: "week_availability_open",
  weekStart: "2026-05-24",
});
assert.deepEqual(parseStaffSchedulePath("/api/admin/staff-schedule/weeks/2026-05-24/availability/close"), {
  kind: "week_availability_close",
  weekStart: "2026-05-24",
});

const windowConfig = { ...testConfig, availabilityOpenWeekStart: null };
assert.equal(
  availabilityWindowStatus(null, null, windowConfig, "2026-05-31", "2026-05-31"),
  "open",
);
assert.equal(
  availabilityWindowStatus(null, null, windowConfig, "2026-06-07", "2026-05-31"),
  "closed",
);
assert.equal(
  availabilityWindowStatus({ status: "published" }, null, windowConfig, "2026-05-31", "2026-05-31"),
  "locked",
);
assert.equal(
  availabilityWindowStatus({ status: "published" }, null, windowConfig, "2026-05-24", "2026-05-31"),
  "closed",
);
assert.equal(
  availabilityWindowStatus(null, { availabilityStatus: "closed" }, windowConfig, "2026-05-31", "2026-05-31"),
  "closed",
);
assert.equal(
  canSubmitAvailabilityForWeek(null, null, { ...windowConfig, availabilityOpenWeekStart: "2026-06-07" }, "2026-06-07", "2026-05-31"),
  false,
);
assert.equal(
  canSubmitAvailabilityForWeek(null, null, { ...windowConfig, availabilityOpenWeekStart: "2026-05-31" }, "2026-05-31", "2026-05-31"),
  true,
);
assert.equal(
  effectiveAvailabilityOpenWeekStart({ availabilityOpenWeekStart: "2026-06-07" }, "2026-05-31"),
  null,
);
assert.equal(isAvailabilityWeekLocked({ status: "published" }, null), true);

const availabilitySelections = normalizeAvailabilitySelections(
  [
    { date: "2026-05-25", slot: "morning" },
    { date: "2026-05-25", slot: "evening" },
  ],
  "2026-05-24",
  testConfig,
  null,
  true,
);
assert.equal(availabilitySelections.length, 2);

assert.deepEqual(staffAvailabilitySlots(testConfig), ["morning", "evening"]);
assert.deepEqual(
  staffAvailabilitySlots({ ...testConfig, staffAvailabilityEarlyMorning: true }),
  ["early_morning", "morning", "evening"],
);

const formDaysDefault = buildAvailabilityFormDays("2026-05-24", testConfig, null, true);
const mondaySlotsDefault = formDaysDefault.find((d) => d.date === "2026-05-25")?.slots.map((s) => s.slot);
assert.deepEqual(mondaySlotsDefault, ["morning", "evening"]);

const formDaysWithEarly = buildAvailabilityFormDays(
  "2026-05-24",
  { ...testConfig, staffAvailabilityEarlyMorning: true },
  null,
  true,
);
const mondaySlotsEarly = formDaysWithEarly.find((d) => d.date === "2026-05-25")?.slots.map((s) => s.slot);
assert.deepEqual(mondaySlotsEarly, ["early_morning", "morning", "evening"]);

assert.throws(
  () =>
    normalizeAvailabilitySelections(
      [{ date: "2026-05-25", slot: "early_morning" }],
      "2026-05-24",
      testConfig,
      null,
      true,
    ),
  /selection_slot_not_applicable/,
);

const availabilitySummary = summarizeAvailabilityForAdmin(
  {
    weekStart: "2026-05-24",
    updatedAt: "2026-05-20T12:00:00.000Z",
    submissions: {
      st_test: {
        staffId: "st_test",
        staffName: "Sophie",
        email: "sophie@example.com",
        submittedAt: "2026-05-20T12:00:00.000Z",
        selections: [{ date: "2026-05-25", slot: "morning" }],
      },
    },
  },
  [staffMap.get("st_test")],
);
assert.equal(availabilitySummary.submissionCount, 1);
assert.equal(availabilitySummary.submissions[0].selections[0].day, "Monday");

const availabilityDoc = {
  weekStart: "2026-05-24",
  updatedAt: "2026-05-20T12:00:00.000Z",
  submissions: {
    st_test: {
      staffId: "st_test",
      staffName: "Sophie",
      email: "sophie@example.com",
      submittedAt: "2026-05-20T12:00:00.000Z",
      selections: [{ date: "2026-05-25", slot: "morning" }],
    },
  },
};
assert.equal(clearAvailabilitySubmission(availabilityDoc, "st_test"), true);
assert.equal(availabilityDoc.submissions.st_test, undefined);
assert.equal(clearAvailabilitySubmission(availabilityDoc, "st_test"), false);

assert.deepEqual(parseStaffSchedulePath("/api/admin/staff-schedule/weeks/2026-05-24/availability/submissions/st_test/reset"), {
  kind: "week_availability_reset",
  weekStart: "2026-05-24",
  staffId: "st_test",
});
assert.deepEqual(parseStaffSchedulePath("/api/admin/staff-schedule/weeks/2026-05-24/availability/send-reminder"), {
  kind: "week_availability_send_reminder",
  weekStart: "2026-05-24",
});

assert.equal(formatWeekRangeLabel("2026-05-24"), "May 24–30, 2026");
assert.equal(formatWeekOfLabel("2026-05-24"), "May 24, 2026");

const reminderEmail = buildStaffAvailabilityReminderEmailContent(
  { name: "Alex", email: "alex@example.com", pin: "1234" },
  "2026-05-24",
);
assert.match(reminderEmail.subject, /May 24–30, 2026/);
assert.match(reminderEmail.text, /PIN: 1234/);
assert.match(reminderEmail.text, /alex@example.com/);

assert.equal(formatAvailabilitySelectionLabel("2026-05-25", "morning"), "Mon May 25, 2026 — Morning");
const adminNotifyEmail = buildStaffAvailabilitySubmittedAdminEmailContent({
  staffName: "Alex",
  weekStart: "2026-05-24",
  selections: [{ date: "2026-05-25", slot: "morning" }],
});
assert.match(adminNotifyEmail.subject, /Alex submitted shift availability/);
assert.match(adminNotifyEmail.text, /Mon May 25, 2026 — Morning/);

const othersByCell = buildAvailabilityOthersByCell(
  {
    weekStart: "2026-05-24",
    submissions: {
      st_a: {
        staffId: "st_a",
        staffName: "Sophie",
        selections: [{ date: "2026-05-25", slot: "morning" }],
      },
      st_b: {
        staffId: "st_b",
        staffName: "Shirley",
        selections: [
          { date: "2026-05-25", slot: "morning" },
          { date: "2026-05-26", slot: "evening" },
        ],
      },
    },
  },
  "st_a",
);
assert.deepEqual(othersByCell["2026-05-25|morning"], ["Shirley"]);
assert.deepEqual(othersByCell["2026-05-26|evening"], ["Shirley"]);
assert.equal(othersByCell["2026-05-25|morning"]?.includes("Sophie"), false);

assert.equal(isValidStaffPin("1234"), true);
assert.equal(isValidStaffPin("12"), false);
assert.equal(staffPinMatches(staffMap.get("st_test"), "1234"), true);
assert.equal(staffPinMatches(staffMap.get("st_test"), "9999"), false);

assert.equal(shiftDurationMinutes("09:00", "12:30"), 210);
assert.equal(shiftTotalMinutes(210), 255);
assert.equal(staffTotalMinutesFromPlanned(660, 2), 750);
assert.equal(staffTotalHoursFromPlanned(660, 2), 12.5);
assert.equal(formatPlannedHours(210), 3.5);
assert.deepEqual(listWeekStartsOverlappingRange("2026-05-26", "2026-06-02", "sunday"), [
  "2026-05-24",
  "2026-05-31",
]);

const summaryWeek = buildEmptyWeek("2026-05-24");
summaryWeek.status = "published";
summaryWeek.shifts.find((s) => s.date === "2026-05-25" && s.slot === "morning").status = "assigned";
summaryWeek.shifts.find((s) => s.date === "2026-05-25" && s.slot === "morning").staffId = "st_test";
summaryWeek.shifts.find((s) => s.date === "2026-05-26" && s.slot === "evening").status = "assigned";
summaryWeek.shifts.find((s) => s.date === "2026-05-26" && s.slot === "evening").staffId = "st_test";
const summaryEnriched = enrichWeekResponse(summaryWeek, testConfig, [staffMap.get("st_test")]);
const periodSummary = buildStaffPeriodSummary({
  from: "2026-05-24",
  to: "2026-05-30",
  publishedOnly: true,
  staffList: [staffMap.get("st_test")],
  weekBundles: [{ weekStart: "2026-05-24", status: "published", enriched: summaryEnriched }],
});
assert.equal(periodSummary.staff.length, 1);
assert.equal(periodSummary.staff[0].totalShifts, 2);
assert.equal(periodSummary.staff[0].bySlot.morning, 1);
assert.equal(periodSummary.staff[0].bySlot.evening, 1);
assert.equal(periodSummary.staff[0].plannedHours, 11);
assert.equal(periodSummary.staff[0].totalHours, 12.5);
assert.equal(periodSummary.staff[0].hourlyRate, 20);
assert.equal(periodSummary.staff[0].totalPay, 250);
assert.equal(periodSummary.totalHours, 12.5);
assert.equal(periodSummary.totalPay, 250);
assert.equal(periodSummary.bufferMinutesPerShift, 45);
assert.equal(normalizeStaffHourlyRate("18.5"), 18.5);
assert.equal(normalizeStaffHourlyRate(""), null);
assert.equal(staffPayFromHourlyRate(20, 12.5), 250);
assert.throws(() => normalizeStaffHourlyRate("abc"), /invalid_staff_hourly_rate/);
assert.throws(() => normalizeStaffHourlyRate(-1), /invalid_staff_hourly_rate/);
assert.match(buildStaffSummaryCsv(periodSummary), /Sophie/);
assert.match(buildStaffSummaryCsv(periodSummary), /totalPay/);

const sample = buildStaffScheduleEmailContent("Sophie", "2026-05-24", [
  { day: "Monday", date: "2026-05-25", slot: "morning", start: "09:00", end: "14:00", note: "" },
]);
assert.match(sample.subject, /AMARÉ Front Desk Schedule/);
assert.match(sample.text, /Sophie/);
assert.match(sample.html, /Sophie/);
assert.match(sample.html, /Front desk schedule/);
assert.match(sample.html, /View update schedule/);
assert.match(sample.html, /href="https:\/\/www\.amarewellness\.com\/classes"/);
assert.match(sample.html, /white-space:nowrap/);
assert.match(sample.text, /View update schedule:/);

const loginEmail = buildStaffLoginEmailContent({
  name: "Sophie",
  email: "sophie@example.com",
  pin: "1234",
});
assert.match(loginEmail.subject, /Shift availability login/);
assert.match(loginEmail.text, /sophie@example.com/);
assert.match(loginEmail.text, /PIN: 1234/);
assert.match(loginEmail.text, /\/staff\/availability/);
assert.match(loginEmail.html, /Submit your shifts/);
assert.match(loginEmail.html, /1234/);

const emailTargets = buildStaffEmailTargets({
  weekStart: "2026-05-31",
  shifts: [
    {
      date: "2026-06-03",
      day: "Wednesday",
      slot: "early_morning",
      start: "06:30",
      end: "07:45",
      status: "assigned",
      staffId: "st_snir",
      staffName: "snir",
      staffEmail: "snir@example.com",
      slotActive: false,
      note: "",
    },
    {
      date: "2026-06-04",
      day: "Thursday",
      slot: "morning",
      start: "08:00",
      end: "12:05",
      status: "assigned",
      staffId: "st_snir",
      staffName: "snir",
      staffEmail: "snir@example.com",
      slotActive: true,
      note: "",
    },
  ],
  byStaff: {},
});
assert.equal(emailTargets.length, 1);
assert.equal(emailTargets[0].assignments.length, 2);
assert.equal(emailTargets[0].assignments[0].slot, "early_morning");
const earlyEmail = buildStaffScheduleEmailContent("snir", "2026-05-31", emailTargets[0].assignments);
assert.match(earlyEmail.text, /Early Morning/);

console.log("staff-schedule-lib-test: ok");
