/**
 * Front desk roster — dates, validation, CSV, week helpers.
 */

import { randomBytes } from "node:crypto";

export const STUDIO_TZ = "America/New_York";
export const SLOTS = /** @type {const} */ (["early_morning", "morning", "evening"]);
/** Classes starting before this wall time (ET) belong in early_morning, not morning. */
export const EARLY_MORNING_CLASS_CUTOFF = "08:00";
/** Arrival buffer before each assigned front-desk shift (minutes). */
export const STAFF_SHIFT_PRE_BUFFER_MINUTES = 30;
/** Departure buffer after each assigned front-desk shift (minutes). */
export const STAFF_SHIFT_POST_BUFFER_MINUTES = 15;
export const STAFF_PIN_MIN_LEN = 4;
export const STAFF_PIN_MAX_LEN = 6;

/** @typedef {"draft"|"published"} WeekStatus */
/** @typedef {"open"|"assigned"|"cancelled"} ShiftStatus */
/** @typedef {"early_morning"|"morning"|"evening"} ShiftSlot */

/**
 * @typedef {Object} ShiftTemplate
 * @property {string} label
 * @property {string} start
 * @property {string} end
 */

/**
 * @typedef {Object} StaffScheduleConfig
 * @property {string} timezone
 * @property {"sunday"|"monday"} weekStartsOn
 * @property {Record<ShiftSlot, ShiftTemplate>} shiftTemplates
 * @property {string | null} [availabilityOpenWeekStart]
 * @property {boolean} [staffAvailabilityEarlyMorning]
 */

/**
 * @typedef {Object} StaffMember
 * @property {string} id
 * @property {string} name
 * @property {string} email
 * @property {string} pin
 * @property {boolean} active
 * @property {number | null} hourlyRate
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * @typedef {Object} WeekShift
 * @property {string} id
 * @property {string} date
 * @property {ShiftSlot} slot
 * @property {string | null} staffId
 * @property {ShiftStatus} status
 * @property {string} note
 */

/**
 * @typedef {Object} ChangeLogEntry
 * @property {string} at
 * @property {string | null} by
 * @property {string} action
 * @property {Record<string, unknown>} details
 */

/**
 * @typedef {Object} WeekDocument
 * @property {string} weekStart
 * @property {WeekStatus} status
 * @property {string | null} publishedAt
 * @property {string | null} publishedBy
 * @property {WeekShift[]} shifts
 * @property {string} updatedAt
 * @property {string | null} updatedBy
 * @property {ChangeLogEntry[]} changeLog
 */

/** @returns {StaffScheduleConfig} */
export function defaultConfig() {
  return {
    timezone: STUDIO_TZ,
    weekStartsOn: "sunday",
    shiftTemplates: {
      early_morning: { label: "Early Morning", start: "06:00", end: "08:00" },
      morning: { label: "Morning", start: "08:00", end: "14:00" },
      evening: { label: "Evening", start: "15:00", end: "20:00" },
    },
    availabilityOpenWeekStart: null,
    staffAvailabilityEarlyMorning: false,
  };
}

/**
 * Shift slots staff may request on the availability form (manager planner always uses all SLOTS).
 * @param {StaffScheduleConfig | null | undefined} config
 * @returns {ShiftSlot[]}
 */
export function staffAvailabilitySlots(config) {
  if (config?.staffAvailabilityEarlyMorning) return [...SLOTS];
  return SLOTS.filter((slot) => slot !== "early_morning");
}

/** @param {ShiftSlot | string} slot */
export function slotDisplayLabel(slot) {
  switch (slot) {
    case "early_morning":
      return "Early Morning";
    case "morning":
      return "Morning";
    case "evening":
      return "Evening";
    default:
      return String(slot);
  }
}

/** @param {unknown} raw */
export function normalizeStaffPin(raw) {
  return String(raw ?? "").trim().replace(/\D/g, "");
}

/** @param {unknown} pin */
export function isValidStaffPin(pin) {
  const p = normalizeStaffPin(pin);
  return p.length >= STAFF_PIN_MIN_LEN && p.length <= STAFF_PIN_MAX_LEN;
}

/**
 * @param {StaffMember | null | undefined} staff
 * @param {unknown} pin
 */
export function staffPinMatches(staff, pin) {
  if (!staff || !staff.pin) return false;
  const expected = normalizeStaffPin(staff.pin);
  if (!isValidStaffPin(expected)) return false;
  const got = normalizeStaffPin(pin);
  if (got.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < got.length; i += 1) {
    mismatch |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}

/** @param {unknown} raw @returns {number | null} */
export function normalizeStaffHourlyRate(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = typeof raw === "number" ? raw : parseFloat(String(raw).trim());
  if (!Number.isFinite(n) || n < 0) {
    throw new Error("invalid_staff_hourly_rate");
  }
  return Math.round(n * 100) / 100;
}

/**
 * @param {number | null | undefined} hourlyRate
 * @param {number | null | undefined} totalHours
 * @returns {number | null}
 */
export function staffPayFromHourlyRate(hourlyRate, totalHours) {
  const rate = Number(hourlyRate);
  const hours = Number(totalHours);
  if (!Number.isFinite(rate) || rate <= 0 || !Number.isFinite(hours) || hours <= 0) return null;
  return Math.round(rate * hours * 100) / 100;
}

/**
 * @param {Record<string, unknown>} body
 * @param {StaffMember | null} [existing]
 */
export function parseStaffFields(body, existing = null) {
  const name = String(body.name ?? existing?.name ?? "").trim();
  const email = String(body.email ?? existing?.email ?? "").trim().toLowerCase();
  const active = body.active !== undefined ? Boolean(body.active) : (existing?.active ?? true);

  let pin = existing?.pin ? normalizeStaffPin(existing.pin) : "";
  if (body.pin !== undefined && body.pin !== null && String(body.pin).trim() !== "") {
    pin = normalizeStaffPin(body.pin);
  }
  if (!existing && !isValidStaffPin(pin)) {
    throw new Error("invalid_staff_pin");
  }
  if (existing && body.pin !== undefined && body.pin !== null && String(body.pin).trim() !== "") {
    if (!isValidStaffPin(pin)) throw new Error("invalid_staff_pin");
  }
  if (!existing && !pin) throw new Error("invalid_staff_pin");

  if (!name || !email || !email.includes("@")) {
    throw new Error("invalid_staff_fields");
  }
  if (!existing && !isValidStaffPin(pin)) {
    throw new Error("invalid_staff_pin");
  }

  let hourlyRate =
    existing && typeof existing.hourlyRate === "number" ? existing.hourlyRate : null;
  if (body.hourlyRate !== undefined) {
    hourlyRate = normalizeStaffHourlyRate(body.hourlyRate);
  }

  return { name, email, pin, active, hourlyRate };
}

/** @param {WeekDocument} week */
export function ensureWeekSlots(week) {
  const dates = weekDatesFromStart(week.weekStart);
  /** @type {Map<string, WeekShift>} */
  const byKey = new Map();
  for (const s of week.shifts || []) {
    byKey.set(`${s.date}:${s.slot}`, s);
  }
  /** @type {WeekShift[]} */
  const shifts = [];
  for (const date of dates) {
    for (const slot of SLOTS) {
      const key = `${date}:${slot}`;
      shifts.push(
        byKey.get(key) || {
          id: newId("sh"),
          date,
          slot,
          staffId: null,
          status: "open",
          note: "",
        },
      );
    }
  }
  week.shifts = shifts;
  return week;
}

/** @param {string} ymd @param {number} days */
export function addDaysYmd(ymd, days) {
  const [y, m, d] = ymd.split("-").map((x) => parseInt(x, 10));
  const dt = new Date(Date.UTC(y, m - 1, d + days, 12, 0, 0));
  return dt.toISOString().slice(0, 10);
}

/** @param {string} ymd */
export function isValidYmd(ymd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ymd || ""))) return false;
  const [y, m, d] = ymd.split("-").map((x) => parseInt(x, 10));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** @param {string} ymd */
export function isMondayYmd(ymd) {
  if (!isValidYmd(ymd)) return false;
  const [y, m, d] = ymd.split("-").map((x) => parseInt(x, 10));
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay() === 1;
}

/** @param {string} ymd */
export function isSundayYmd(ymd) {
  if (!isValidYmd(ymd)) return false;
  const [y, m, d] = ymd.split("-").map((x) => parseInt(x, 10));
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay() === 0;
}

/** @param {string} ymd @param {"sunday"|"monday"} [weekStartsOn] */
export function isWeekStartYmd(ymd, weekStartsOn = "sunday") {
  return weekStartsOn === "monday" ? isMondayYmd(ymd) : isSundayYmd(ymd);
}

/** @param {string} [tz] */
export function todayYmdInTz(tz = STUDIO_TZ) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  return `${y}-${m}-${d}`;
}

/** @param {string} ymd @param {"sunday"|"monday"} [weekStartsOn] */
export function weekStartForYmd(ymd, weekStartsOn = "sunday") {
  const [y, m, d] = ymd.split("-").map((x) => parseInt(x, 10));
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  if (weekStartsOn === "monday") {
    const diff = dow === 0 ? -6 : 1 - dow;
    return addDaysYmd(ymd, diff);
  }
  return addDaysYmd(ymd, -dow);
}

/** @param {string} ymd */
export function mondayOfWeekForYmd(ymd) {
  return weekStartForYmd(ymd, "monday");
}

/** @param {string} ymd */
export function sundayOfWeekForYmd(ymd) {
  return weekStartForYmd(ymd, "sunday");
}

/** @param {string} [tz] @param {"sunday"|"monday"} [weekStartsOn] */
export function currentWeekStart(tz = STUDIO_TZ, weekStartsOn = "sunday") {
  return weekStartForYmd(todayYmdInTz(tz), weekStartsOn);
}

/** @param {string} [tz] @param {"sunday"|"monday"} [weekStartsOn] */
export function nextWeekStart(tz = STUDIO_TZ, weekStartsOn = "sunday") {
  return addDaysYmd(currentWeekStart(tz, weekStartsOn), 7);
}

/** @param {string} weekStart */
export function weekDatesFromStart(weekStart) {
  /** @type {string[]} */
  const out = [];
  for (let i = 0; i < 7; i += 1) {
    out.push(addDaysYmd(weekStart, i));
  }
  return out;
}

/** @param {string} ymd @param {string} [tz] */
export function weekdayLongForYmd(ymd, tz = STUDIO_TZ) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
  }).format(new Date(`${ymd}T12:00:00`));
}

/** @param {string} prefix */
export function newId(prefix) {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

/** @param {string} weekStart @param {string} [nowIso] */
export function buildEmptyWeek(weekStart, nowIso = new Date().toISOString()) {
  /** @type {WeekShift[]} */
  const shifts = [];
  for (const date of weekDatesFromStart(weekStart)) {
    for (const slot of SLOTS) {
      shifts.push({
        id: newId("sh"),
        date,
        slot,
        staffId: null,
        status: "open",
        note: "",
      });
    }
  }
  return /** @type {WeekDocument} */ ({
    weekStart,
    status: "draft",
    publishedAt: null,
    publishedBy: null,
    shifts,
    updatedAt: nowIso,
    updatedBy: null,
    changeLog: [],
  });
}

/**
 * @param {WeekDocument} week
 * @param {string} action
 * @param {Record<string, unknown>} details
 * @param {string | null} [by]
 */
/**
 * Mid-week switch: reassign one shift, or swap/move two shifts.
 * Works on published weeks so payroll follows the updated assignments.
 * @param {WeekDocument} week
 * @param {Record<string, unknown>} body
 * @param {StaffMember[]} staffList
 */
export function applyShiftSwitch(week, body, staffList) {
  const fromDate = String(body?.fromDate || "").trim();
  const fromSlot = String(body?.fromSlot || "").trim();
  if (!isValidYmd(fromDate) || !SLOTS.includes(/** @type {ShiftSlot} */ (fromSlot))) {
    throw new Error("invalid_from_shift");
  }
  const from = (week.shifts || []).find((s) => s.date === fromDate && s.slot === fromSlot);
  if (!from) throw new Error("shift_not_found");

  const swapDate = String(body?.swapDate || "").trim();
  const swapSlot = String(body?.swapSlot || "").trim();
  if (swapDate || swapSlot) {
    if (!isValidYmd(swapDate) || !SLOTS.includes(/** @type {ShiftSlot} */ (swapSlot))) {
      throw new Error("invalid_swap_shift");
    }
    if (swapDate === fromDate && swapSlot === fromSlot) throw new Error("same_shift");
    const other = (week.shifts || []).find((s) => s.date === swapDate && s.slot === swapSlot);
    if (!other) throw new Error("shift_not_found");
    const aStaff = from.staffId;
    const aStatus = from.status;
    from.staffId = other.staffId;
    from.status = other.staffId ? "assigned" : other.status === "cancelled" ? "cancelled" : "open";
    other.staffId = aStaff;
    other.status = aStaff ? "assigned" : aStatus === "cancelled" ? "cancelled" : "open";
    return { kind: "swap", from, other };
  }

  const toStaffId = String(body?.toStaffId || "").trim();
  if (!toStaffId || toStaffId === "__open__") {
    from.staffId = null;
    from.status = "open";
    return { kind: "open", from };
  }
  if (!staffList.some((s) => s.id === toStaffId)) throw new Error("invalid_staff");
  from.staffId = toStaffId;
  from.status = "assigned";
  return { kind: "reassign", from };
}

export function appendChangeLog(week, action, details, by = "admin_token") {
  if (!Array.isArray(week.changeLog)) week.changeLog = [];
  week.changeLog.push({
    at: new Date().toISOString(),
    by,
    action,
    details,
  });
  if (week.changeLog.length > 100) {
    week.changeLog = week.changeLog.slice(-100);
  }
}

/**
 * @typedef {Object} SlotCoverage
 * @property {string} start
 * @property {string} end
 * @property {number} [classCount]
 * @property {"classes"|"template"} [source]
 */

/**
 * @param {Record<string, Partial<Record<ShiftSlot, SlotCoverage>> | undefined> | null | undefined} classCoverageByDate
 * @param {string} date
 * @param {ShiftSlot} slot
 * @param {boolean} [scheduleAvailable] When false (Mindbody fetch failed), all slots stay assignable.
 */
export function shiftSlotApplicable(classCoverageByDate, date, slot, scheduleAvailable = true) {
  if (!scheduleAvailable || !classCoverageByDate) return true;
  const cov = classCoverageByDate[date]?.[slot];
  return cov?.source === "classes" && (cov.classCount ?? 0) > 0;
}

/**
 * @param {Record<string, Partial<Record<ShiftSlot, SlotCoverage>> | undefined> | null | undefined} classCoverageByDate
 * @param {string} date
 */
export function earlyMorningApplicable(classCoverageByDate, date) {
  return shiftSlotApplicable(classCoverageByDate, date, "early_morning");
}

/**
 * @param {WeekDocument} week
 * @param {Record<string, Partial<Record<ShiftSlot, SlotCoverage>> | undefined> | null | undefined} [classCoverageByDate]
 * @param {boolean} [scheduleAvailable]
 */
export function sanitizeInapplicableShifts(week, classCoverageByDate, scheduleAvailable = true) {
  if (!scheduleAvailable) return false;
  let changed = false;
  for (const s of week.shifts) {
    if (shiftSlotApplicable(classCoverageByDate, s.date, s.slot, scheduleAvailable)) continue;
    if (s.status !== "cancelled" || s.staffId || s.note) {
      s.status = "cancelled";
      s.staffId = null;
      s.note = "";
      changed = true;
    }
  }
  return changed;
}

/** @deprecated use sanitizeInapplicableShifts */
export function sanitizeEarlyMorningShifts(week, classCoverageByDate, scheduleAvailable = true) {
  return sanitizeInapplicableShifts(week, classCoverageByDate, scheduleAvailable);
}

/**
 * @param {unknown} raw
 * @param {WeekDocument} existing
 * @param {Map<string, StaffMember>} staffMap
 * @param {Record<string, Partial<Record<ShiftSlot, SlotCoverage>> | undefined> | null | undefined} [classCoverageByDate]
 * @param {boolean} [scheduleAvailable]
 */
export function normalizeWeekPayload(raw, existing, staffMap, classCoverageByDate = null, scheduleAvailable = true) {
  if (!raw || typeof raw !== "object") {
    throw new Error("invalid_body");
  }
  const body = /** @type {Record<string, unknown>} */ (raw);
  if (!Array.isArray(body.shifts)) {
    throw new Error("invalid_shifts");
  }

  /** @type {Map<string, WeekShift>} */
  const byKey = new Map();
  for (const s of existing.shifts) {
    byKey.set(`${s.date}:${s.slot}`, s);
  }

  /** @type {WeekShift[]} */
  const shifts = [];
  /** @type {Set<string>} */
  const seen = new Set();

  for (const item of body.shifts) {
    if (!item || typeof item !== "object") continue;
    const row = /** @type {Record<string, unknown>} */ (item);
    const date = String(row.date || "").trim();
    const slot = String(row.slot || "").trim();
    if (!SLOTS.includes(/** @type {ShiftSlot} */ (slot))) {
      throw new Error("invalid_slot");
    }
    const allowedDates = new Set(weekDatesFromStart(existing.weekStart));
    if (!allowedDates.has(date)) {
      throw new Error("invalid_shift_date");
    }
    const key = `${date}:${slot}`;
    if (seen.has(key)) throw new Error("duplicate_shift");
    seen.add(key);

    const prev = byKey.get(key);
    let status = String(row.status || "open").trim();
    if (!["open", "assigned", "cancelled"].includes(status)) {
      throw new Error("invalid_status");
    }
    let staffId = row.staffId == null || row.staffId === "" ? null : String(row.staffId).trim();
    const note = typeof row.note === "string" ? row.note.trim().slice(0, 500) : "";

    if (!shiftSlotApplicable(classCoverageByDate, date, /** @type {ShiftSlot} */ (slot), scheduleAvailable)) {
      if (status === "assigned") {
        throw new Error("shift_slot_not_applicable");
      }
      status = "cancelled";
      staffId = null;
    }

    if (status === "assigned") {
      if (!staffId) throw new Error("assigned_requires_staff");
      const staff = staffMap.get(staffId);
      if (!staff || !staff.active) throw new Error("invalid_staff_id");
    } else {
      staffId = null;
      if (status !== "open" && status !== "cancelled") {
        throw new Error("invalid_status");
      }
    }

    shifts.push({
      id: prev?.id || newId("sh"),
      date,
      slot: /** @type {ShiftSlot} */ (slot),
      staffId,
      status: /** @type {ShiftStatus} */ (status),
      note,
    });
  }

  const expected = weekDatesFromStart(existing.weekStart).length * SLOTS.length;
  if (shifts.length !== expected) {
    throw new Error("incomplete_week");
  }

  return shifts;
}

/**
 * @param {WeekDocument} week
 * @param {StaffScheduleConfig} config
 * @param {StaffMember[]} staffList
 * @param {Record<string, Partial<Record<ShiftSlot, SlotCoverage>>> | null} [classCoverageByDate]
 * @param {boolean} [scheduleAvailable]
 */
export function enrichWeekResponse(week, config, staffList, classCoverageByDate = null, scheduleAvailable = true) {
  const staffById = new Map(staffList.map((s) => [s.id, s]));
  const templates = config.shiftTemplates;

  const shifts = week.shifts.map((s) => {
    const staff = s.staffId ? staffById.get(s.staffId) : null;
    const tmpl = templates[s.slot];
    const fromClasses = classCoverageByDate?.[s.date]?.[s.slot];
    return {
      ...s,
      staffName: staff?.name || null,
      staffEmail: staff?.email || null,
      start: fromClasses?.start || tmpl?.start || null,
      end: fromClasses?.end || tmpl?.end || null,
      coverageSource: fromClasses?.source || "template",
      slotActive: shiftSlotApplicable(classCoverageByDate, s.date, s.slot, scheduleAvailable),
      day: weekdayLongForYmd(s.date, config.timezone),
    };
  });

  /** @type {Record<string, { name: string; email: string; totalShifts: number; assignments: object[] }>} */
  const byStaff = {};
  for (const s of shifts) {
    if (s.status !== "assigned" || !s.staffId) continue;
    if (!shiftSlotApplicable(classCoverageByDate, s.date, s.slot, scheduleAvailable)) continue;
    const staff = staffById.get(s.staffId);
    if (!staff) continue;
    if (!byStaff[s.staffId]) {
      byStaff[s.staffId] = {
        name: staff.name,
        email: staff.email,
        totalShifts: 0,
        assignments: [],
      };
    }
    byStaff[s.staffId].totalShifts += 1;
    byStaff[s.staffId].assignments.push({
      date: s.date,
      day: s.day,
      slot: s.slot,
      start: s.start,
      end: s.end,
      note: s.note,
    });
  }

  return {
    ...week,
    classScheduleAvailable: scheduleAvailable,
    config: {
      timezone: config.timezone,
      shiftTemplates: config.shiftTemplates,
    },
    classCoverage: classCoverageByDate || undefined,
    shifts,
    byStaff,
  };
}

/**
 * @param {WeekDocument} week
 * @param {StaffScheduleConfig} config
 * @param {StaffMember[]} staffList
 * @param {Record<string, Partial<Record<ShiftSlot, SlotCoverage>>> | null} [classCoverageByDate]
 */
export function buildWeekCsv(week, config, staffList, classCoverageByDate = null, scheduleAvailable = true) {
  const enriched = enrichWeekResponse(week, config, staffList, classCoverageByDate, scheduleAvailable);
  const headers = ["date", "day", "slot", "start", "end", "staffName", "staffEmail", "status", "note"];
  const lines = [headers.join(",")];
  for (const s of enriched.shifts) {
    const row = [
      s.date,
      s.day,
      s.slot,
      s.start || "",
      s.end || "",
      s.staffName || "",
      s.staffEmail || "",
      s.status,
      s.note || "",
    ];
    lines.push(row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","));
  }
  return lines.join("\n");
}

/**
 * @param {WeekDocument} week
 * @param {StaffScheduleConfig} config
 * @param {StaffMember[]} staffList
 * @param {Record<string, Partial<Record<ShiftSlot, SlotCoverage>>> | null} [classCoverageByDate]
 */
export function buildWhatsAppText(week, config, staffList, classCoverageByDate = null, scheduleAvailable = true) {
  const enriched = enrichWeekResponse(week, config, staffList, classCoverageByDate, scheduleAvailable);
  const startLabel = formatWeekOfLabel(week.weekStart);
  const lines = [`AMARÉ Front Desk Schedule — Week of ${startLabel}`, ""];

  let currentDay = "";
  for (const s of enriched.shifts) {
    if (!shiftSlotApplicable(classCoverageByDate, s.date, s.slot, scheduleAvailable)) {
      continue;
    }
    if (s.day !== currentDay) {
      currentDay = s.day || "";
      lines.push(currentDay);
    }
    const slotLabel = slotDisplayLabel(s.slot);
    const time = formatTimeRange(s.start, s.end);
    let who = "Open";
    if (s.status === "cancelled") who = "No coverage";
    else if (s.status === "assigned") who = s.staffName || "Assigned";
    lines.push(`${slotLabel} ${time} — ${who}`);
  }
  return lines.join("\n");
}

/** @param {string | null | undefined} start @param {string | null | undefined} end */
export function shiftDurationMinutes(start, end) {
  if (!start || !end) return 0;
  const [sh, sm] = start.split(":").map((x) => parseInt(x, 10));
  const [eh, em] = end.split(":").map((x) => parseInt(x, 10));
  if (Number.isNaN(sh) || Number.isNaN(eh)) return 0;
  let startM = sh * 60 + (sm || 0);
  let endM = eh * 60 + (em || 0);
  if (endM <= startM) endM += 24 * 60;
  return Math.max(0, endM - startM);
}

/** @param {number} minutes */
export function formatPlannedHours(minutes) {
  return Math.round((minutes / 60) * 10) / 10;
}

/** @param {number} shiftMinutes */
export function shiftTotalMinutes(shiftMinutes) {
  return (
    Math.max(0, shiftMinutes) +
    STAFF_SHIFT_PRE_BUFFER_MINUTES +
    STAFF_SHIFT_POST_BUFFER_MINUTES
  );
}

/** @param {number} plannedMinutes @param {number} totalShifts */
export function staffTotalMinutesFromPlanned(plannedMinutes, totalShifts) {
  const planned = Math.max(0, Number(plannedMinutes) || 0);
  const shifts = Math.max(0, Number(totalShifts) || 0);
  return planned + shifts * (STAFF_SHIFT_PRE_BUFFER_MINUTES + STAFF_SHIFT_POST_BUFFER_MINUTES);
}

/** @param {number} plannedMinutes @param {number} totalShifts */
export function staffTotalHoursFromPlanned(plannedMinutes, totalShifts) {
  return formatPlannedHours(staffTotalMinutesFromPlanned(plannedMinutes, totalShifts));
}

/** @param {string} fromYmd @param {string} toYmd @param {"sunday"|"monday"} [weekStartsOn] */
export function listWeekStartsOverlappingRange(fromYmd, toYmd, weekStartsOn = "sunday") {
  if (!isValidYmd(fromYmd) || !isValidYmd(toYmd) || fromYmd > toYmd) return [];
  let ws = weekStartForYmd(fromYmd, weekStartsOn);
  const endWs = weekStartForYmd(toYmd, weekStartsOn);
  /** @type {string[]} */
  const out = [];
  while (ws <= endWs) {
    out.push(ws);
    ws = addDaysYmd(ws, 7);
    if (out.length > 8) break;
  }
  return out;
}

/** @param {string} fromYmd @param {string} toYmd */
export function daysBetweenYmd(fromYmd, toYmd) {
  const a = new Date(`${fromYmd}T12:00:00Z`);
  const b = new Date(`${toYmd}T12:00:00Z`);
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

/**
 * @typedef {Object} StaffPeriodSummaryRow
 * @property {string} staffId
 * @property {string} name
 * @property {string} email
 * @property {boolean} active
 * @property {number} totalShifts
 * @property {number} plannedMinutes
 * @property {number} plannedHours
 * @property {number} totalMinutes
 * @property {number} totalHours
 * @property {number | null} hourlyRate
 * @property {number | null} totalPay
 * @property {number} [commissionTotal]
 * @property {number} [combinedPay]
 * @property {Record<ShiftSlot, number>} bySlot
 * @property {object[]} assignments
 */

/**
 * @param {object} opts
 * @param {string} opts.from
 * @param {string} opts.to
 * @param {boolean} opts.publishedOnly
 * @param {StaffMember[]} opts.staffList
 * @param {Array<{ weekStart: string; status: import("./staff-schedule-lib.mjs").WeekStatus | null; enriched: ReturnType<typeof enrichWeekResponse> | null; missing?: boolean }>} opts.weekBundles
 */
export function buildStaffPeriodSummary(opts) {
  const { from, to, publishedOnly, staffList, weekBundles } = opts;

  /** @type {Map<string, StaffPeriodSummaryRow>} */
  const byStaffId = new Map();
  for (const staff of staffList) {
    byStaffId.set(staff.id, {
      staffId: staff.id,
      name: staff.name,
      email: staff.email,
      active: staff.active,
      totalShifts: 0,
      plannedMinutes: 0,
      plannedHours: 0,
      totalMinutes: 0,
      totalHours: 0,
      hourlyRate:
        typeof staff.hourlyRate === "number" && staff.hourlyRate > 0 ? staff.hourlyRate : null,
      totalPay: null,
      bySlot: { early_morning: 0, morning: 0, evening: 0 },
      assignments: [],
    });
  }

  /** @type {string[]} */
  const weeksIncluded = [];
  /** @type {{ weekStart: string; reason: string }[]} */
  const weeksSkipped = [];
  let openSlots = 0;

  for (const bundle of weekBundles) {
    if (bundle.missing || !bundle.enriched) {
      weeksSkipped.push({ weekStart: bundle.weekStart, reason: "no_data" });
      continue;
    }
    if (publishedOnly && bundle.status !== "published") {
      weeksSkipped.push({ weekStart: bundle.weekStart, reason: "draft" });
      continue;
    }
    weeksIncluded.push(bundle.weekStart);

    for (const shift of bundle.enriched.shifts) {
      const date = String(shift.date || "");
      if (date < from || date > to) continue;
      if (!shift.slotActive) continue;

      if (shift.status === "open") {
        openSlots += 1;
        continue;
      }
      if (shift.status !== "assigned" || !shift.staffId) continue;

      const row = byStaffId.get(String(shift.staffId));
      if (!row) continue;

      const mins = shiftDurationMinutes(shift.start, shift.end);
      row.totalShifts += 1;
      row.plannedMinutes += mins;
      const slot = /** @type {ShiftSlot} */ (shift.slot);
      if (slot in row.bySlot) row.bySlot[slot] += 1;
      row.assignments.push({
        weekStart: bundle.weekStart,
        date,
        day: shift.day,
        slot,
        start: shift.start,
        end: shift.end,
        note: shift.note || "",
      });
    }
  }

  const staff = [...byStaffId.values()]
    .filter((row) => row.totalShifts > 0 || row.active)
    .map((row) => {
      const totalMinutes = staffTotalMinutesFromPlanned(row.plannedMinutes, row.totalShifts);
      const totalHours = formatPlannedHours(totalMinutes);
      const totalPay = staffPayFromHourlyRate(row.hourlyRate, totalHours);
      return {
        ...row,
        plannedHours: formatPlannedHours(row.plannedMinutes),
        totalMinutes,
        totalHours,
        totalPay,
        assignments: row.assignments.sort((a, b) => {
          const dateCmp = String(a.date).localeCompare(String(b.date));
          if (dateCmp !== 0) return dateCmp;
          return slotOrder(String(a.slot)) - slotOrder(String(b.slot));
        }),
      };
    })
    .sort(
      (a, b) =>
        b.plannedMinutes - a.plannedMinutes ||
        String(a.name).localeCompare(String(b.name)),
    );

  const totalShifts = staff.reduce((sum, row) => sum + row.totalShifts, 0);
  const plannedMinutes = staff.reduce((sum, row) => sum + row.plannedMinutes, 0);
  const totalMinutes = staffTotalMinutesFromPlanned(plannedMinutes, totalShifts);
  const totalHours = formatPlannedHours(totalMinutes);
  const totalPay = staff.reduce((sum, row) => sum + (Number(row.totalPay) || 0), 0);

  return {
    from,
    to,
    publishedOnly,
    weeksIncluded,
    weeksSkipped,
    openSlots,
    totalShifts,
    plannedMinutes,
    plannedHours: formatPlannedHours(plannedMinutes),
    totalMinutes,
    totalHours,
    totalPay: totalPay > 0 ? Math.round(totalPay * 100) / 100 : null,
    bufferMinutesPerShift: STAFF_SHIFT_PRE_BUFFER_MINUTES + STAFF_SHIFT_POST_BUFFER_MINUTES,
    staff,
    disclaimer:
      "Planned hours are shift time only. Total adds 30 min before and 15 min after each shift (arrival/departure). Est. pay uses each staff member's hourly rate × total hours. Combined adds sales commissions for the same dates. Verify against Mindbody Time Clock for payroll.",
  };
}

/**
 * @typedef {Object} CommissionPackage
 * @property {string} id
 * @property {string} label
 * @property {number} amountUsd
 */

/**
 * @typedef {Object} CommissionEntry
 * @property {string} id
 * @property {string} staffId
 * @property {string} packageId
 * @property {string} packageLabel
 * @property {number} amountUsd
 * @property {string} [clientName]
 * @property {string} soldDate
 * @property {string} [soldTime]
 * @property {string} createdAt
 */

/**
 * @typedef {Object} CommissionDocument
 * @property {CommissionPackage[]} packages
 * @property {CommissionEntry[]} entries
 * @property {string} updatedAt
 */

export const DEFAULT_COMMISSION_PACKAGES = [
  { id: "unlimited", label: "Unlimited", amountUsd: 50 },
  { id: "monthly_8", label: "Monthly 8", amountUsd: 40 },
  { id: "monthly_5", label: "Monthly 5", amountUsd: 30 },
  { id: "ncs", label: "NCS", amountUsd: 15 },
];

/** @returns {CommissionDocument} */
export function emptyCommissionDoc() {
  return {
    packages: DEFAULT_COMMISSION_PACKAGES.map((p) => ({ ...p })),
    entries: [],
    updatedAt: new Date().toISOString(),
  };
}

/** @param {unknown} raw */
export function normalizeCommissionAmount(raw) {
  const n = typeof raw === "number" ? raw : parseFloat(String(raw ?? "").replace(/[$,]/g, ""));
  if (!Number.isFinite(n) || n < 0 || n > 2000) {
    throw new Error("invalid_commission_amount");
  }
  return Math.round(n * 100) / 100;
}

/** @param {unknown} raw */
export function normalizeCommissionPackages(raw) {
  if (!Array.isArray(raw) || !raw.length) {
    return DEFAULT_COMMISSION_PACKAGES.map((p) => ({ ...p }));
  }
  /** @type {CommissionPackage[]} */
  const out = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const r = /** @type {Record<string, unknown>} */ (row);
    const id = String(r.id || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .slice(0, 32);
    const label = String(r.label || "").trim().slice(0, 40);
    if (!id || label.length < 2) continue;
    out.push({ id, label, amountUsd: normalizeCommissionAmount(r.amountUsd) });
  }
  return out.length ? out : DEFAULT_COMMISSION_PACKAGES.map((p) => ({ ...p }));
}

/**
 * @param {unknown} doc
 * @returns {CommissionDocument}
 */
export function normalizeCommissionDoc(doc) {
  if (!doc || typeof doc !== "object") return emptyCommissionDoc();
  const d = /** @type {Record<string, unknown>} */ (doc);
  const packages = normalizeCommissionPackages(d.packages);
  const entries = Array.isArray(d.entries)
    ? d.entries.filter((e) => e && typeof e === "object" && e.id && e.staffId && e.soldDate)
    : [];
  return {
    packages,
    entries: /** @type {CommissionEntry[]} */ (entries),
    updatedAt: typeof d.updatedAt === "string" ? d.updatedAt : new Date().toISOString(),
  };
}

/**
 * @param {object} body
 * @param {CommissionPackage[]} packages
 * @param {StaffMember[]} staffList
 */
export function parseCommissionEntryInput(body, packages, staffList) {
  if (!body || typeof body !== "object") throw new Error("invalid_body");
  const b = /** @type {Record<string, unknown>} */ (body);
  const staffId = String(b.staffId || "").trim();
  if (!staffList.some((s) => s.id === staffId)) throw new Error("invalid_staff");
  const packageId = String(b.packageId || "").trim();
  const pack = packages.find((p) => p.id === packageId);
  if (!pack) throw new Error("invalid_package");
  const amountUsd =
    b.amountUsd === undefined || b.amountUsd === ""
      ? pack.amountUsd
      : normalizeCommissionAmount(b.amountUsd);
  const soldDate = String(b.soldDate || "").trim();
  if (!isValidYmd(soldDate)) throw new Error("invalid_sold_date");
  const soldTime = String(b.soldTime || "").trim();
  if (soldTime && !/^\d{2}:\d{2}$/.test(soldTime)) throw new Error("invalid_sold_time");
  const clientName = String(b.clientName || "").trim().slice(0, 80);
  return {
    staffId,
    packageId: pack.id,
    packageLabel: pack.label,
    amountUsd,
    clientName,
    soldDate,
    soldTime,
  };
}

/**
 * @param {CommissionEntry[]} entries
 * @param {string} from
 * @param {string} to
 */
export function filterCommissionsInRange(entries, from, to) {
  return entries
    .filter((e) => e.soldDate >= from && e.soldDate <= to)
    .sort((a, b) => {
      const dateCmp = String(b.soldDate).localeCompare(String(a.soldDate));
      if (dateCmp !== 0) return dateCmp;
      return String(b.soldTime || "").localeCompare(String(a.soldTime || ""));
    });
}

/**
 * @param {ReturnType<typeof buildStaffPeriodSummary>} summary
 * @param {CommissionEntry[]} entries
 */
export function attachCommissionsToSummary(summary, entries) {
  /** @type {Map<string, number>} */
  const byStaff = new Map();
  for (const e of entries) {
    byStaff.set(e.staffId, (byStaff.get(e.staffId) || 0) + Number(e.amountUsd || 0));
  }
  let commissionTotal = 0;
  for (const row of summary.staff) {
    const commission = Math.round((byStaff.get(row.staffId) || 0) * 100) / 100;
    row.commissionTotal = commission;
    const shiftPay = Number(row.totalPay) || 0;
    row.combinedPay = Math.round((shiftPay + commission) * 100) / 100;
    commissionTotal += commission;
  }
  summary.commissionTotal = Math.round(commissionTotal * 100) / 100;
  summary.combinedPay = Math.round(((Number(summary.totalPay) || 0) + commissionTotal) * 100) / 100;
  return summary;
}

/** @param {ReturnType<typeof buildStaffPeriodSummary>} summary */
export function buildStaffSummaryCsv(summary) {
  const headers = [
    "staffName",
    "staffEmail",
    "active",
    "totalShifts",
    "plannedHours",
    "totalHours",
    "hourlyRate",
    "totalPay",
    "commissions",
    "combinedPay",
    "earlyMorning",
    "morning",
    "evening",
  ];
  const lines = [headers.join(",")];
  for (const row of summary.staff) {
    const totalHours =
      typeof row.totalHours === "number" && row.totalHours > 0
        ? row.totalHours
        : staffTotalHoursFromPlanned(row.plannedMinutes, row.totalShifts);
    const csvRow = [
      row.name,
      row.email,
      row.active ? "yes" : "no",
      row.totalShifts,
      row.plannedHours,
      totalHours,
      row.hourlyRate ?? "",
      row.totalPay ?? "",
      row.commissionTotal ?? 0,
      row.combinedPay ?? row.totalPay ?? "",
      row.bySlot.early_morning,
      row.bySlot.morning,
      row.bySlot.evening,
    ];
    lines.push(csvRow.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","));
  }
  lines.push("");
  lines.push(`"Period","${summary.from}","${summary.to}"`);
  lines.push(`"Total shifts","${summary.totalShifts}",""`);
  lines.push(`"Total planned hours","${summary.plannedHours}",""`);
  lines.push(`"Total hours (incl. buffers)","${summary.totalHours}",""`);
  lines.push(`"Total est. pay","${summary.totalPay ?? ""}",""`);
  lines.push(`"Total commissions","${summary.commissionTotal ?? 0}",""`);
  lines.push(`"Total combined pay","${summary.combinedPay ?? summary.totalPay ?? ""}",""`);
  lines.push(`"Buffer per shift (minutes)","${summary.bufferMinutesPerShift}",""`);
  lines.push(`"Open slots","${summary.openSlots}",""`);
  return lines.join("\n");
}

/** @param {ShiftSlot} slot */
function slotOrder(slot) {
  if (slot === "early_morning") return 0;
  if (slot === "morning") return 1;
  if (slot === "evening") return 2;
  return 9;
}

/** @param {string} weekStart */
export function formatWeekOfLabel(weekStart) {
  const [y, m, d] = weekStart.split("-").map((x) => parseInt(x, 10));
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${months[m - 1]} ${d}, ${y}`;
}

/** @param {string} weekStart */
export function formatWeekRangeLabel(weekStart) {
  const dates = weekDatesFromStart(weekStart);
  const end = dates[6] || weekStart;
  const [y1, m1, d1] = weekStart.split("-").map((x) => parseInt(x, 10));
  const [y2, m2, d2] = end.split("-").map((x) => parseInt(x, 10));
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  if (y1 === y2 && m1 === m2) {
    return `${months[m1 - 1]} ${d1}–${d2}, ${y1}`;
  }
  return `${formatWeekOfLabel(weekStart)} – ${formatWeekOfLabel(end)}`;
}

/** @param {string | null | undefined} start @param {string | null | undefined} end */
function formatTimeRange(start, end) {
  const fmt = (t) => {
    if (!t) return "";
    const [hh, mm] = t.split(":").map((x) => parseInt(x, 10));
    const h12 = hh % 12 || 12;
    const ap = hh >= 12 ? "PM" : "AM";
    return mm ? `${h12}:${String(mm).padStart(2, "0")} ${ap}` : `${h12} ${ap}`;
  };
  return `${fmt(start)}–${fmt(end)}`;
}

/**
 * @typedef {Object} AvailabilitySelection
 * @property {string} date
 * @property {ShiftSlot} slot
 */

/**
 * @typedef {Object} AvailabilitySubmission
 * @property {string} staffId
 * @property {string} staffName
 * @property {string} email
 * @property {string} submittedAt
 * @property {AvailabilitySelection[]} selections
 */

/**
 * @typedef {Object} AvailabilityDocument
 * @property {string} weekStart
 * @property {string} updatedAt
 * @property {"open"|"closed"|"locked"|null} [availabilityStatus]
 * @property {Record<string, AvailabilitySubmission>} submissions
 */

/** @param {string} weekStart */
export function emptyAvailabilityDoc(weekStart) {
  return {
    weekStart,
    updatedAt: new Date().toISOString(),
    submissions: {},
  };
}

/**
 * Remove one staff member's availability submission for a week.
 * @param {AvailabilityDocument} doc
 * @param {string} staffId
 * @returns {boolean}
 */
export function clearAvailabilitySubmission(doc, staffId) {
  const id = String(staffId || "").trim();
  if (!id) return false;
  if (!doc.submissions || typeof doc.submissions !== "object") return false;
  if (!doc.submissions[id]) return false;
  delete doc.submissions[id];
  doc.updatedAt = new Date().toISOString();
  return true;
}

/**
 * @param {string} weekStart
 * @param {StaffScheduleConfig} config
 * @param {Record<string, Partial<Record<ShiftSlot, { start?: string; end?: string }>>> | null} classCoverageByDate
 * @param {boolean} [scheduleAvailable]
 */
export function buildAvailabilityFormDays(weekStart, config, classCoverageByDate, scheduleAvailable = true) {
  const requestableSlots = staffAvailabilitySlots(config);
  return weekDatesFromStart(weekStart).map((date) => {
    const slots = requestableSlots.filter((slot) =>
      shiftSlotApplicable(classCoverageByDate, date, slot, scheduleAvailable),
    ).map((slot) => {
      const tmpl = config.shiftTemplates[slot];
      const fromClasses = classCoverageByDate?.[date]?.[slot];
      return {
        slot,
        label: slotDisplayLabel(slot),
        start: fromClasses?.start || tmpl?.start || null,
        end: fromClasses?.end || tmpl?.end || null,
      };
    });
    return {
      date,
      day: weekdayLongForYmd(date, config.timezone),
      slots,
    };
  });
}

/** @param {AvailabilitySelection[]} selections */
function selectionKey(date, slot) {
  return `${date}|${slot}`;
}

/**
 * @param {unknown} raw
 * @param {string} weekStart
 * @param {StaffScheduleConfig} config
 * @param {Record<string, Partial<Record<ShiftSlot, unknown>>> | null} classCoverageByDate
 * @param {boolean} scheduleAvailable
 * @returns {AvailabilitySelection[]}
 */
export function normalizeAvailabilitySelections(
  raw,
  weekStart,
  config,
  classCoverageByDate,
  scheduleAvailable = true,
) {
  if (!Array.isArray(raw)) {
    throw new Error("invalid_selections");
  }
  const allowedDates = new Set(weekDatesFromStart(weekStart));
  const requestableSlots = new Set(staffAvailabilitySlots(config));
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {AvailabilitySelection[]} */
  const out = [];

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const date = String(/** @type {{ date?: string }} */ (item).date || "");
    const slot = String(/** @type {{ slot?: string }} */ (item).slot || "");
    if (!allowedDates.has(date)) throw new Error("invalid_selection_date");
    if (!SLOTS.includes(/** @type {ShiftSlot} */ (slot))) throw new Error("invalid_selection_slot");
    if (!requestableSlots.has(/** @type {ShiftSlot} */ (slot))) {
      throw new Error("selection_slot_not_applicable");
    }
    if (!shiftSlotApplicable(classCoverageByDate, date, /** @type {ShiftSlot} */ (slot), scheduleAvailable)) {
      throw new Error("selection_slot_not_applicable");
    }
    const key = selectionKey(date, slot);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ date, slot: /** @type {ShiftSlot} */ (slot) });
  }

  out.sort((a, b) => {
    const dateCmp = a.date.localeCompare(b.date);
    if (dateCmp !== 0) return dateCmp;
    return slotOrder(a.slot) - slotOrder(b.slot);
  });
  return out;
}

/**
 * Staff names who requested each date|slot, excluding one staff member (for public form).
 * @param {AvailabilityDocument | null | undefined} doc
 * @param {string | null | undefined} excludeStaffId
 * @returns {Record<string, string[]>}
 */
export function buildAvailabilityOthersByCell(doc, excludeStaffId) {
  /** @type {Record<string, string[]>} */
  const byCell = {};
  const submissions = doc?.submissions && typeof doc.submissions === "object" ? doc.submissions : {};
  for (const [staffId, row] of Object.entries(submissions)) {
    if (excludeStaffId && staffId === excludeStaffId) continue;
    const name = String(row?.staffName || "").trim();
    if (!name) continue;
    const selections = Array.isArray(row?.selections) ? row.selections : [];
    for (const sel of selections) {
      const date = String(sel?.date || "");
      const slot = String(sel?.slot || "");
      if (!date || !slot) continue;
      const key = selectionKey(date, slot);
      const list = byCell[key] || [];
      if (!list.includes(name)) list.push(name);
      byCell[key] = list;
    }
  }
  for (const list of Object.values(byCell)) {
    list.sort((a, b) => a.localeCompare(b));
  }
  return byCell;
}

/**
 * @param {AvailabilityDocument | null | undefined} doc
 * @param {StaffMember[]} staffList
 */
export function summarizeAvailabilityForAdmin(doc, staffList) {
  const submissions = doc?.submissions && typeof doc.submissions === "object" ? doc.submissions : {};
  const rows = Object.values(submissions).sort((a, b) =>
    String(a.staffName).localeCompare(String(b.staffName)),
  );
  const staffIds = new Set(staffList.filter((s) => s.active).map((s) => s.id));
  return {
    weekStart: doc?.weekStart || null,
    updatedAt: doc?.updatedAt || null,
    submissionCount: rows.length,
    submissions: rows.map((row) => ({
      staffId: row.staffId,
      staffName: row.staffName,
      email: row.email,
      submittedAt: row.submittedAt,
      selectionCount: Array.isArray(row.selections) ? row.selections.length : 0,
      selections: (Array.isArray(row.selections) ? row.selections : []).map((sel) => ({
        date: sel.date,
        slot: sel.slot,
        day: weekdayLongForYmd(String(sel.date || ""), STUDIO_TZ),
      })),
      activeStaff: staffIds.has(row.staffId),
    })),
  };
}

/** @param {unknown} event */
export function parseJsonBody(event) {
  if (!event || typeof event !== "object") return {};
  const e = /** @type {{ body?: string | null; isBase64Encoded?: boolean }} */ (event);
  if (!e.body) return {};
  const raw = e.isBase64Encoded ? Buffer.from(e.body, "base64").toString("utf8") : e.body;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** @param {string} path */
export function parseStaffSchedulePath(path) {
  const clean = String(path || "").replace(/\/$/, "");
  const prefix = "/api/admin/staff-schedule";
  if (!clean.startsWith(prefix)) return null;

  const rest = clean.slice(prefix.length);
  if (rest === "/staff" || rest === "/staff/") {
    return { kind: "staff_collection" };
  }
  const staffSendLoginMatch = rest.match(/^\/staff\/([^/]+)\/send-login$/);
  if (staffSendLoginMatch) {
    return { kind: "staff_send_login", staffId: decodeURIComponent(staffSendLoginMatch[1]) };
  }
  const staffMatch = rest.match(/^\/staff\/([^/]+)$/);
  if (staffMatch) {
    return { kind: "staff_item", staffId: decodeURIComponent(staffMatch[1]) };
  }

  const weekMatch = rest.match(/^\/weeks\/(\d{4}-\d{2}-\d{2})$/);
  if (weekMatch) {
    return { kind: "week", weekStart: weekMatch[1] };
  }
  const switchMatch = rest.match(/^\/weeks\/(\d{4}-\d{2}-\d{2})\/switch$/);
  if (switchMatch) {
    return { kind: "week_switch", weekStart: switchMatch[1] };
  }
  const publishMatch = rest.match(/^\/weeks\/(\d{4}-\d{2}-\d{2})\/publish$/);
  if (publishMatch) {
    return { kind: "week_publish", weekStart: publishMatch[1] };
  }
  const unpublishMatch = rest.match(/^\/weeks\/(\d{4}-\d{2}-\d{2})\/unpublish$/);
  if (unpublishMatch) {
    return { kind: "week_unpublish", weekStart: unpublishMatch[1] };
  }
  const exportMatch = rest.match(/^\/weeks\/(\d{4}-\d{2}-\d{2})\/export\.csv$/);
  if (exportMatch) {
    return { kind: "week_export", weekStart: exportMatch[1] };
  }
  const availabilityMatch = rest.match(/^\/weeks\/(\d{4}-\d{2}-\d{2})\/availability$/);
  if (availabilityMatch) {
    return { kind: "week_availability", weekStart: availabilityMatch[1] };
  }
  const availabilityOpenMatch = rest.match(/^\/weeks\/(\d{4}-\d{2}-\d{2})\/availability\/open$/);
  if (availabilityOpenMatch) {
    return { kind: "week_availability_open", weekStart: availabilityOpenMatch[1] };
  }
  const availabilityCloseMatch = rest.match(/^\/weeks\/(\d{4}-\d{2}-\d{2})\/availability\/close$/);
  if (availabilityCloseMatch) {
    return { kind: "week_availability_close", weekStart: availabilityCloseMatch[1] };
  }
  const availabilityResetMatch = rest.match(
    /^\/weeks\/(\d{4}-\d{2}-\d{2})\/availability\/submissions\/([^/]+)\/reset$/,
  );
  if (availabilityResetMatch) {
    return {
      kind: "week_availability_reset",
      weekStart: availabilityResetMatch[1],
      staffId: decodeURIComponent(availabilityResetMatch[2]),
    };
  }
  const availabilitySendReminderMatch = rest.match(
    /^\/weeks\/(\d{4}-\d{2}-\d{2})\/availability\/send-reminder$/,
  );
  if (availabilitySendReminderMatch) {
    return { kind: "week_availability_send_reminder", weekStart: availabilitySendReminderMatch[1] };
  }
  if (rest === "/availability-settings" || rest === "/availability-settings/") {
    return { kind: "availability_settings" };
  }
  const emailMatch = rest.match(/^\/weeks\/(\d{4}-\d{2}-\d{2})\/email$/);
  if (emailMatch) {
    return { kind: "week_email", weekStart: emailMatch[1] };
  }

  if (rest === "/commission-packages" || rest === "/commission-packages/") {
    return { kind: "commission_packages" };
  }
  if (rest === "/commissions" || rest === "/commissions/") {
    return { kind: "commissions" };
  }
  const commissionMatch = rest.match(/^\/commissions\/([^/]+)$/);
  if (commissionMatch) {
    return { kind: "commission_item", commissionId: decodeURIComponent(commissionMatch[1]) };
  }

  if (rest === "/reports/staff-summary" || rest === "/reports/staff-summary/") {
    return { kind: "staff_summary" };
  }
  if (rest === "/reports/staff-summary/export.csv") {
    return { kind: "staff_summary_export" };
  }

  return null;
}
