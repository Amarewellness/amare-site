/**
 * Staff availability window — open / closed / locked (published) per week.
 */

import {
  emptyAvailabilityDoc,
  formatWeekOfLabel,
  isValidYmd,
  nextWeekStart,
  weekStartForYmd,
} from "./staff-schedule-lib.mjs";

/** @typedef {'closed'|'open'|'locked'} AvailabilityWindowStatus */

/**
 * @param {import("./staff-schedule-lib.mjs").WeekDocument | null | undefined} weekDoc
 * @param {import("./staff-schedule-lib.mjs").AvailabilityDocument | null | undefined} availabilityDoc
 */
export function isAvailabilityWeekLocked(weekDoc, availabilityDoc) {
  if (weekDoc?.status === "published") return true;
  if (availabilityDoc?.availabilityStatus === "locked") return true;
  return false;
}

/** @param {import("./staff-schedule-lib.mjs").AvailabilityDocument | null | undefined} availabilityDoc */
export function isAvailabilityWeekExplicitlyClosed(availabilityDoc) {
  return availabilityDoc?.availabilityStatus === "closed";
}

/**
 * The only week staff may submit availability for — always the calendar week after the current one.
 * @param {import("./staff-schedule-lib.mjs").StaffScheduleConfig} config
 */
export function staffAvailabilityTargetWeekStart(config) {
  return nextWeekStart(config.timezone, config.weekStartsOn || "sunday");
}

/**
 * Admin may pin availability open only when it matches the next-week target (ignores stale config).
 * @param {import("./staff-schedule-lib.mjs").StaffScheduleConfig} config
 * @param {string} autoTargetWeek
 */
export function effectiveAvailabilityOpenWeekStart(config, autoTargetWeek) {
  const open = config?.availabilityOpenWeekStart;
  if (typeof open === "string" && isValidYmd(open) && open === autoTargetWeek) {
    return open;
  }
  return null;
}

/**
 * @param {import("./staff-schedule-lib.mjs").WeekDocument | null | undefined} weekDoc
 * @param {import("./staff-schedule-lib.mjs").AvailabilityDocument | null | undefined} availabilityDoc
 * @param {import("./staff-schedule-lib.mjs").StaffScheduleConfig} config
 * @param {string} weekStart
 * @param {string} autoTargetWeek
 * @returns {AvailabilityWindowStatus}
 */
export function availabilityWindowStatus(weekDoc, availabilityDoc, config, weekStart, autoTargetWeek) {
  if (weekStart !== autoTargetWeek) return "closed";
  if (isAvailabilityWeekLocked(weekDoc, availabilityDoc)) return "locked";
  const pinnedOpen = effectiveAvailabilityOpenWeekStart(config, autoTargetWeek);
  if (pinnedOpen === weekStart) return "open";
  if (isAvailabilityWeekExplicitlyClosed(availabilityDoc)) return "closed";
  if (!pinnedOpen) return "open";
  return "closed";
}

/**
 * @param {import("./staff-schedule-lib.mjs").WeekDocument | null | undefined} weekDoc
 * @param {import("./staff-schedule-lib.mjs").AvailabilityDocument | null | undefined} availabilityDoc
 * @param {import("./staff-schedule-lib.mjs").StaffScheduleConfig} config
 * @param {string} weekStart
 * @param {string} autoTargetWeek
 */
export function canSubmitAvailabilityForWeek(weekDoc, availabilityDoc, config, weekStart, autoTargetWeek) {
  return availabilityWindowStatus(weekDoc, availabilityDoc, config, weekStart, autoTargetWeek) === "open";
}

/**
 * @param {import("./staff-schedule-store.mjs").ReturnType<typeof import("./staff-schedule-store.mjs").openStaffScheduleStore>} store
 * @param {import("./staff-schedule-lib.mjs").StaffScheduleConfig} config
 */
export async function computeAutoAvailabilityWeekStart(store, config) {
  void store;
  return staffAvailabilityTargetWeekStart(config);
}

/**
 * @param {import("./staff-schedule-store.mjs").ReturnType<typeof import("./staff-schedule-store.mjs").openStaffScheduleStore>} store
 * @param {string | null | undefined} requestedRaw
 */
export async function resolveStaffAvailabilityWeekStart(store, requestedRaw) {
  const config = await store.getConfig();
  const autoTargetWeek = staffAvailabilityTargetWeekStart(config);
  const targetWeek = autoTargetWeek;

  /** @type {string | null} */
  let requestedWeekStart = null;
  if (requestedRaw && isValidYmd(String(requestedRaw).trim())) {
    requestedWeekStart = weekStartForYmd(String(requestedRaw).trim(), config.weekStartsOn);
  }

  if (requestedWeekStart) {
    const week = await store.getWeek(requestedWeekStart);
    const avail = await store.getAvailability(requestedWeekStart);
    if (canSubmitAvailabilityForWeek(week, avail, config, requestedWeekStart, autoTargetWeek)) {
      return {
        weekStart: requestedWeekStart,
        autoTargetWeek,
        redirectedFrom: null,
      };
    }
    return {
      weekStart: targetWeek,
      autoTargetWeek,
      redirectedFrom: requestedWeekStart,
    };
  }

  return {
    weekStart: targetWeek,
    autoTargetWeek,
    redirectedFrom: null,
  };
}

/**
 * @param {import("./staff-schedule-store.mjs").ReturnType<typeof import("./staff-schedule-store.mjs").openStaffScheduleStore>} store
 * @param {string} weekStart
 */
export async function buildAvailabilityWindowMeta(store, weekStart) {
  const config = await store.getConfig();
  const week = await store.getWeek(weekStart);
  const availabilityDoc = await store.getAvailability(weekStart);
  const autoTargetWeek = await computeAutoAvailabilityWeekStart(store, config);
  const status = availabilityWindowStatus(week, availabilityDoc, config, weekStart, autoTargetWeek);
  const staffTarget = await resolveStaffAvailabilityWeekStart(store, null);

  return {
    weekStart,
    status,
    autoTargetWeek,
    staffTargetWeekStart: staffTarget.weekStart,
    isStaffTargetWeek: weekStart === autoTargetWeek,
    canSubmit: status === "open",
    canOpen: weekStart === autoTargetWeek && status !== "locked" && status !== "open",
    canClose: status === "open",
    staffFormUrl: "/staff/availability",
    weekLabel: formatWeekOfLabel(weekStart),
    staffTargetLabel: formatWeekOfLabel(staffTarget.weekStart),
  };
}

/**
 * @param {import("./staff-schedule-store.mjs").ReturnType<typeof import("./staff-schedule-store.mjs").openStaffScheduleStore>} store
 * @param {string} weekStart
 */
export async function lockAvailabilityForWeek(store, weekStart) {
  const doc = (await store.getAvailability(weekStart)) || emptyAvailabilityDoc(weekStart);
  doc.availabilityStatus = "locked";
  doc.updatedAt = new Date().toISOString();
  await store.putAvailability(doc);

  const config = await store.getConfig();
  if (config.availabilityOpenWeekStart === weekStart) {
    config.availabilityOpenWeekStart = null;
    await store.putConfig(config);
  }
}

/**
 * @param {import("./staff-schedule-store.mjs").ReturnType<typeof import("./staff-schedule-store.mjs").openStaffScheduleStore>} store
 * @param {string} weekStart
 */
export async function openAvailabilityForWeek(store, weekStart) {
  const week = await store.getWeek(weekStart);
  if (week?.status === "published") {
    throw new Error("week_published");
  }

  const config = await store.getConfig();
  const targetWeek = staffAvailabilityTargetWeekStart(config);
  if (weekStart !== targetWeek) {
    throw new Error("availability_not_next_week");
  }

  config.availabilityOpenWeekStart = weekStart;
  await store.putConfig(config);

  const doc = (await store.getAvailability(weekStart)) || emptyAvailabilityDoc(weekStart);
  doc.availabilityStatus = "open";
  doc.updatedAt = new Date().toISOString();
  await store.putAvailability(doc);
}

/**
 * @param {import("./staff-schedule-store.mjs").ReturnType<typeof import("./staff-schedule-store.mjs").openStaffScheduleStore>} store
 * @param {string} weekStart
 */
export async function closeAvailabilityForWeek(store, weekStart) {
  const config = await store.getConfig();
  if (config.availabilityOpenWeekStart === weekStart) {
    config.availabilityOpenWeekStart = null;
    await store.putConfig(config);
  }

  const doc = (await store.getAvailability(weekStart)) || emptyAvailabilityDoc(weekStart);
  doc.availabilityStatus = "closed";
  doc.updatedAt = new Date().toISOString();
  await store.putAvailability(doc);
}

/** @param {AvailabilityWindowStatus} status @param {string | null | undefined} redirectedFrom @param {string | null | undefined} [autoTargetWeek] */
export function staffAvailabilityRedirectMessage(status, redirectedFrom, autoTargetWeek) {
  if (redirectedFrom) {
    const targetLabel = autoTargetWeek ? formatWeekOfLabel(autoTargetWeek) : "next week";
    return `The schedule for week of ${formatWeekOfLabel(redirectedFrom)} is not open — showing ${targetLabel} instead.`;
  }
  if (status === "locked") {
    return "The schedule for next week has been published. Submissions are closed.";
  }
  if (status === "closed") {
    return "Availability for next week is not open yet. Check back when your manager opens the form.";
  }
  return "";
}
