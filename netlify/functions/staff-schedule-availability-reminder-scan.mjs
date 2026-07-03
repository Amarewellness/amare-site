/**
 * Weekly staff shift availability reminder (automated).
 *
 * Scheduled: Tuesday ~10:00 AM US Eastern (14:00 UTC cron — same as new-client-sms-scan).
 * Manual test: POST /api/admin/staff-schedule/availability-reminder/run with `x-admin-token`.
 *
 * Requires ENABLE_STAFF_SCHEDULE_ADMIN_EMAIL=1 (Resend) and ENABLE_STAFF_AVAILABILITY_AUTO_REMINDER=1.
 */

import { jsonResponse } from "./mindbody-consumer-lib.mjs";
import { adminAuthorized, adminCorsHeaders } from "./new-client-sms-admin-auth.mjs";
import { runScheduledStaffAvailabilityReminder } from "./staff-schedule-availability-reminder-lib.mjs";
import { openStaffScheduleStore } from "./staff-schedule-store.mjs";

/** 14:00 UTC Tuesday ≈ 10:00 AM US Eastern (EDT). Day 2 = Tuesday. */
export const config = {
  schedule: "0 14 * * 2",
};

/** @param {unknown} event */
function isScheduledInvocation(event) {
  if (!event || typeof event !== "object") return false;
  const e = /** @type {{ headers?: Record<string, string | undefined>; source?: string }} */ (event);
  if (e.source === "netlify-scheduled-function") return true;
  const headers = e.headers || {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === "x-netlify-event" && String(v || "").toLowerCase() === "schedule") {
      return true;
    }
  }
  return false;
}

/** @param {import("@netlify/functions").HandlerEvent} event */
export async function handler(event) {
  const method = (event.httpMethod || "GET").toUpperCase();
  if (method === "OPTIONS") {
    return jsonResponse(204, "", {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, x-admin-token",
    });
  }

  const scheduled = isScheduledInvocation(event);
  const isManualHttp = !scheduled && (method === "POST" || method === "GET");

  if (isManualHttp && !adminAuthorized(event)) {
    return jsonResponse(401, { ok: false, error: "unauthorized" }, adminCorsHeaders());
  }

  if (!scheduled && !isManualHttp) {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" }, adminCorsHeaders());
  }

  const store = openStaffScheduleStore();
  const result = await runScheduledStaffAvailabilityReminder(store);
  const statusCode = result.statusCode || (result.ok ? 200 : 422);

  console.log(
    JSON.stringify({
      event: "staff_availability_auto_reminder",
      scheduled,
      manual: isManualHttp,
      ok: result.ok,
      skipped: result.skipped === true,
      reason: result.reason || result.error || null,
      weekStart: result.weekStart || null,
      sent: result.sent || 0,
      recipients: result.recipients || [],
    }),
  );

  return jsonResponse(statusCode, result, adminCorsHeaders());
}
