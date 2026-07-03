/**
 * Shared logic for staff shift availability reminder emails (manual admin + scheduled).
 */

import {
  defaultConfig,
  emptyAvailabilityDoc,
  formatWeekOfLabel,
  formatWeekRangeLabel,
  isValidYmd,
  summarizeAvailabilityForAdmin,
  weekStartForYmd,
} from "./staff-schedule-lib.mjs";
import {
  availabilityWindowStatus,
  buildAvailabilityWindowMeta,
  openAvailabilityForWeek,
  staffAvailabilityTargetWeekStart,
} from "./staff-schedule-availability-window.mjs";
import { sendStaffAvailabilityReminderEmails, staffScheduleEmailConfigured } from "./staff-schedule-email.mjs";

/** @param {string} name */
export function envTruthy(name) {
  const v = (process.env[name] || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** @returns {boolean} */
export function staffAvailabilityAutoReminderEnabled() {
  return envTruthy("ENABLE_STAFF_AVAILABILITY_AUTO_REMINDER");
}

/** @param {string} weekStart */
function resolveWeekStart(weekStart) {
  if (!isValidYmd(weekStart)) {
    return {
      ok: false,
      error: "invalid_week_start",
      hint: "Use a valid date (YYYY-MM-DD).",
    };
  }
  const weekStartsOn = defaultConfig().weekStartsOn;
  return { ok: true, resolved: weekStartForYmd(weekStart, weekStartsOn) };
}

/** @param {string} [tz] */
export function isTuesdayInTz(tz) {
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
  }).format(new Date());
  return day === "Tuesday";
}

/**
 * @param {import("./staff-schedule-store.mjs").ReturnType<typeof import("./staff-schedule-store.mjs").openStaffScheduleStore>} store
 * @param {{
 *   weekStart: string;
 *   staffIds?: string[] | null;
 *   openIfClosed?: boolean;
 * }} options
 */
export async function runStaffAvailabilityReminder(store, options) {
  const { weekStart, staffIds = null, openIfClosed = false } = options;

  if (!staffScheduleEmailConfigured()) {
    return {
      ok: false,
      statusCode: 503,
      error: "email_not_configured",
      hint: "Set ENABLE_STAFF_SCHEDULE_ADMIN_EMAIL=1, RESEND_API_KEY, and STAFF_SCHEDULE_EMAIL_FROM (or SMS_ADMIN_REPORT_FROM).",
    };
  }

  const config = await store.getConfig();
  const targetWeek = staffAvailabilityTargetWeekStart(config);
  const resolvedWeek = resolveWeekStart(weekStart);
  if (!resolvedWeek.ok) {
    return {
      ok: false,
      statusCode: 422,
      error: resolvedWeek.error,
      hint: resolvedWeek.hint,
    };
  }
  const resolvedWeekStart = resolvedWeek.resolved;

  if (resolvedWeekStart !== targetWeek) {
    return {
      ok: false,
      statusCode: 422,
      error: "availability_not_next_week",
      hint: "Availability reminders are only for the upcoming week.",
      targetWeek,
    };
  }

  const week = await store.getWeek(resolvedWeekStart);
  const availabilityDoc = (await store.getAvailability(resolvedWeekStart)) || emptyAvailabilityDoc(resolvedWeekStart);
  let status = availabilityWindowStatus(week, availabilityDoc, config, resolvedWeekStart, targetWeek);
  const wasClosed = status === "closed";

  if (status === "locked") {
    return {
      ok: false,
      statusCode: 422,
      error: "availability_locked",
      hint: "This week is published. Unpublish before asking staff to submit availability.",
      weekStart: resolvedWeekStart,
      skipped: true,
    };
  }

  if (status === "closed") {
    if (!openIfClosed) {
      return {
        ok: false,
        statusCode: 422,
        error: "availability_closed",
        needsOpen: true,
        hint: "Availability is closed. Confirm opening registration before sending.",
        weekStart: resolvedWeekStart,
      };
    }
    try {
      await openAvailabilityForWeek(store, resolvedWeekStart);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "week_published") {
        return {
          ok: false,
          statusCode: 422,
          error: msg,
          hint: "Unpublish the week before opening availability.",
          weekStart: resolvedWeekStart,
        };
      }
      throw e;
    }
    status = "open";
  }

  const staffList = await store.listStaff();
  const byId = new Map(staffList.map((s) => [s.id, s]));
  /** @type {Array<{ id?: string; name?: string; email?: string; pin?: string; active?: boolean }>} */
  let selected;
  if (Array.isArray(staffIds) && staffIds.length) {
    selected = staffIds.map((id) => byId.get(id)).filter(Boolean);
    if (!selected.length) {
      return {
        ok: false,
        statusCode: 422,
        error: "staff_not_found",
        hint: "None of the selected staff were found.",
        weekStart: resolvedWeekStart,
      };
    }
  } else {
    selected = staffList.filter((s) => s.active !== false);
  }

  const sendResult = await sendStaffAvailabilityReminderEmails(selected, resolvedWeekStart);
  if (!sendResult.ok) {
    return {
      ok: false,
      statusCode: 422,
      error: sendResult.error,
      hint: sendResult.hint,
      sent: sendResult.sent || 0,
      recipients: sendResult.recipients || [],
      skipped: sendResult.skipped || [],
      weekStart: resolvedWeekStart,
      openedAvailability: openIfClosed && wasClosed,
    };
  }

  const availabilityWindow = await buildAvailabilityWindowMeta(store, resolvedWeekStart);
  const summary = summarizeAvailabilityForAdmin(await store.getAvailability(resolvedWeekStart), staffList);

  return {
    ok: true,
    statusCode: 200,
    sent: sendResult.sent,
    recipients: sendResult.recipients,
    skipped: sendResult.skipped || [],
    weekStart: resolvedWeekStart,
    weekLabel: formatWeekOfLabel(resolvedWeekStart),
    weekRangeLabel: formatWeekRangeLabel(resolvedWeekStart),
    availability: summary,
    availabilityWindow,
    openedAvailability: openIfClosed && wasClosed,
    storeMode: store.mode,
  };
}

/**
 * Scheduled Tuesday run — next week's availability, all active staff, open if closed.
 * @param {import("./staff-schedule-store.mjs").ReturnType<typeof import("./staff-schedule-store.mjs").openStaffScheduleStore>} store
 */
export async function runScheduledStaffAvailabilityReminder(store) {
  if (!staffAvailabilityAutoReminderEnabled()) {
    return {
      ok: true,
      statusCode: 200,
      skipped: true,
      reason: "automation_disabled",
      hint: "Set ENABLE_STAFF_AVAILABILITY_AUTO_REMINDER=1 on Netlify to enable weekly Tuesday emails.",
    };
  }

  const config = await store.getConfig();
  const tz = config.timezone || "America/New_York";

  if (!isTuesdayInTz(tz)) {
    return {
      ok: true,
      statusCode: 200,
      skipped: true,
      reason: "not_tuesday",
      timezone: tz,
    };
  }

  const targetWeek = staffAvailabilityTargetWeekStart(config);
  if (!isValidYmd(targetWeek)) {
    return {
      ok: false,
      statusCode: 500,
      error: "invalid_target_week",
      targetWeek,
    };
  }

  const result = await runStaffAvailabilityReminder(store, {
    weekStart: targetWeek,
    staffIds: null,
    openIfClosed: true,
  });

  return {
    ...result,
    trigger: "scheduled",
    timezone: tz,
  };
}
