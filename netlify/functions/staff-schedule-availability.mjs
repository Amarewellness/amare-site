/**
 * Public staff shift availability submissions (no admin token).
 * GET/POST /api/staff-schedule/availability
 */

import { jsonResponse } from "./mindbody-consumer-lib.mjs";
import {
  availabilityWindowStatus,
  canSubmitAvailabilityForWeek,
  computeAutoAvailabilityWeekStart,
  resolveStaffAvailabilityWeekStart,
  staffAvailabilityRedirectMessage,
} from "./staff-schedule-availability-window.mjs";
import { fetchWeekClassCoverage } from "./staff-schedule-class-hours.mjs";
import {
  buildAvailabilityFormDays,
  buildAvailabilityOthersByCell,
  currentWeekStart,
  emptyAvailabilityDoc,
  formatWeekOfLabel,
  isValidStaffPin,
  isValidYmd,
  normalizeAvailabilitySelections,
  parseJsonBody,
  staffAvailabilitySlots,
  staffPinMatches,
  weekStartForYmd,
} from "./staff-schedule-lib.mjs";
import { openStaffScheduleStore } from "./staff-schedule-store.mjs";
import { sendStaffAvailabilitySubmittedAdminEmail } from "./staff-schedule-email.mjs";

/** @param {Record<string, string>} [extra] */
function publicCorsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    ...extra,
  };
}

/**
 * @param {ReturnType<typeof openStaffScheduleStore>} store
 * @param {string} weekStart
 * @param {string} staffId
 * @param {string} pin
 * @param {{ redirectedFrom?: string | null; autoTargetWeek?: string }} [opts]
 */
async function loadFormContext(store, weekStart, staffId, pin, opts = {}) {
  const config = await store.getConfig();
  const staffList = (await store.listStaff()).filter((s) => s.active);
  const weekDoc = await store.getWeek(weekStart);
  const { coverage: classCoverage, mindbodyOk: scheduleAvailable } =
    await fetchWeekClassCoverage(weekStart, config);
  const days = buildAvailabilityFormDays(weekStart, config, classCoverage, scheduleAvailable);
  const requestableSlots = new Set(staffAvailabilitySlots(config));
  const doc = (await store.getAvailability(weekStart)) || emptyAvailabilityDoc(weekStart);
  const autoTargetWeek =
    opts.autoTargetWeek || (await computeAutoAvailabilityWeekStart(store, config));
  const status = availabilityWindowStatus(weekDoc, doc, config, weekStart, autoTargetWeek);
  const canSubmit = status === "open";

  /** @type {import("./staff-schedule-lib.mjs").AvailabilitySelection[]} */
  let existingSelections = [];
  /** @type {string | null} */
  let existingSubmittedAt = null;
  if (staffId && pin) {
    const staff = staffList.find((s) => s.id === staffId);
    if (staff && staffPinMatches(staff, pin)) {
      const existing = doc.submissions?.[staffId];
      if (existing && Array.isArray(existing.selections)) {
        existingSelections = existing.selections.filter((sel) =>
          requestableSlots.has(/** @type {import("./staff-schedule-lib.mjs").ShiftSlot} */ (sel.slot)),
        );
        existingSubmittedAt =
          typeof existing.submittedAt === "string" ? existing.submittedAt : null;
      }
    }
  }

  const redirectMessage = staffAvailabilityRedirectMessage(
    status,
    opts.redirectedFrom || null,
    autoTargetWeek,
  );

  return {
    weekStart,
    weekLabel: formatWeekOfLabel(weekStart),
    timezone: config.timezone,
    days,
    staff: staffList.map((s) => ({ id: s.id, name: s.name })),
    scheduleAvailable,
    existingSelections,
    existingSubmittedAt,
    otherSelectionsByCell: buildAvailabilityOthersByCell(doc, staffId || null),
    submissionCount: Object.keys(doc.submissions || {}).length,
    currentWeekStart: currentWeekStart(config.timezone, config.weekStartsOn),
    autoTargetWeek,
    availabilityStatus: status,
    canSubmit,
    redirectedFrom: opts.redirectedFrom || null,
    redirectMessage: redirectMessage || null,
    readOnly: !canSubmit,
    staffAvailabilityEarlyMorning: config.staffAvailabilityEarlyMorning === true,
  };
}

/** @param {import("@netlify/functions").HandlerEvent} event */
export async function handler(event) {
  const method = (event.httpMethod || "GET").toUpperCase();
  if (method === "OPTIONS") {
    return jsonResponse(204, "", publicCorsHeaders());
  }

  const path = String(event.path || "").replace(/\/$/, "");
  if (path !== "/api/staff-schedule/availability") {
    return jsonResponse(404, { ok: false, error: "not_found" }, publicCorsHeaders());
  }

  const store = openStaffScheduleStore(event);
  if (!store.available) {
    return jsonResponse(503, { ok: false, error: "store_unavailable" }, publicCorsHeaders());
  }

  try {
    if (method === "GET") {
      const q = event.queryStringParameters || {};
      const requestedRaw = String(q.weekStart || q.week || "").trim();
      const resolved = await resolveStaffAvailabilityWeekStart(store, requestedRaw || null);
      const staffId = String(q.staffId || "").trim();
      const pin = String(q.pin || "").trim();
      const context = await loadFormContext(store, resolved.weekStart, staffId, pin, {
        redirectedFrom: resolved.redirectedFrom,
        autoTargetWeek: resolved.autoTargetWeek,
      });
      return jsonResponse(200, { ok: true, ...context }, publicCorsHeaders());
    }

    if (method === "POST") {
      const body = parseJsonBody(event);
      if (body === null) {
        return jsonResponse(400, { ok: false, error: "invalid_json" }, publicCorsHeaders());
      }

      const config = await store.getConfig();
      let weekStart = String(body.weekStart || "").trim();
      if (!weekStart || !isValidYmd(weekStart)) {
        const resolved = await resolveStaffAvailabilityWeekStart(store, null);
        weekStart = resolved.weekStart;
      } else {
        weekStart = weekStartForYmd(weekStart, config.weekStartsOn);
      }

      const weekDoc = await store.getWeek(weekStart);
      const availabilityDoc = await store.getAvailability(weekStart);
      const autoTargetWeek = await computeAutoAvailabilityWeekStart(store, config);
      if (
        !canSubmitAvailabilityForWeek(weekDoc, availabilityDoc, config, weekStart, autoTargetWeek)
      ) {
        const status = availabilityWindowStatus(
          weekDoc,
          availabilityDoc,
          config,
          weekStart,
          autoTargetWeek,
        );
        return jsonResponse(
          422,
          {
            ok: false,
            error: status === "locked" ? "availability_locked" : "availability_closed",
            hint:
              status === "locked"
                ? "The schedule for this week has been published. Submissions are closed."
                : "Availability is not open for this week.",
          },
          publicCorsHeaders(),
        );
      }

      const staffId = String(body.staffId || "").trim();
      const pin = String(body.pin || "").trim();
      const staff = (await store.listStaff()).find((s) => s.id === staffId && s.active);
      if (!staff) {
        return jsonResponse(422, { ok: false, error: "staff_not_found" }, publicCorsHeaders());
      }
      if (!isValidStaffPin(pin) || !staffPinMatches(staff, pin)) {
        return jsonResponse(
          422,
          { ok: false, error: "pin_mismatch", hint: "Incorrect PIN for this staff member." },
          publicCorsHeaders(),
        );
      }

      const { coverage: classCoverage, mindbodyOk: scheduleAvailable } =
        await fetchWeekClassCoverage(weekStart, config);
      const selections = normalizeAvailabilitySelections(
        body.selections,
        weekStart,
        config,
        classCoverage,
        scheduleAvailable,
      );

      const doc = (await store.getAvailability(weekStart)) || emptyAvailabilityDoc(weekStart);
      doc.submissions = doc.submissions && typeof doc.submissions === "object" ? doc.submissions : {};
      const isUpdate = Boolean(doc.submissions[staffId]);
      if (doc.availabilityStatus !== "open") {
        doc.availabilityStatus = "open";
      }
      doc.submissions[staffId] = {
        staffId,
        staffName: staff.name,
        email: staff.email,
        submittedAt: new Date().toISOString(),
        selections,
      };
      doc.updatedAt = new Date().toISOString();
      await store.putAvailability(doc);

      const notifyResult = await sendStaffAvailabilitySubmittedAdminEmail({
        staffName: String(staff.name || "Staff"),
        weekStart,
        selections,
        isUpdate,
      });
      if (!notifyResult.ok && !notifyResult.skipped) {
        console.log(
          JSON.stringify({
            event: "staff_availability_admin_notify_failed",
            staffId,
            weekStart,
            error: notifyResult.error,
            hint: notifyResult.hint,
          }),
        );
      }

      return jsonResponse(
        200,
        {
          ok: true,
          weekStart,
          weekLabel: formatWeekOfLabel(weekStart),
          selectionCount: selections.length,
          submittedAt: doc.submissions[staffId].submittedAt,
        },
        publicCorsHeaders(),
      );
    }

    return jsonResponse(405, { ok: false, error: "method_not_allowed" }, publicCorsHeaders());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.startsWith("invalid_selection") ||
      msg === "selection_slot_not_applicable"
    ) {
      return jsonResponse(422, { ok: false, error: msg }, publicCorsHeaders());
    }
    console.error(JSON.stringify({ event: "staff_schedule_availability_error", error: msg }));
    return jsonResponse(500, { ok: false, error: "internal_error" }, publicCorsHeaders());
  }
}
