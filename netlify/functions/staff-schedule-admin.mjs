/**
 * Front desk roster admin API.
 * Routes under /api/admin/staff-schedule/*
 */

import { jsonResponse } from "./mindbody-consumer-lib.mjs";
import { adminAuthorized, adminCorsHeaders } from "./new-client-sms-admin-auth.mjs";
import {
  appendChangeLog,
  buildStaffPeriodSummary,
  buildStaffSummaryCsv,
  buildWeekCsv,
  clearAvailabilitySubmission,
  daysBetweenYmd,
  defaultConfig,
  emptyAvailabilityDoc,
  enrichWeekResponse,
  formatWeekOfLabel,
  formatWeekRangeLabel,
  isValidYmd,
  listWeekStartsOverlappingRange,
  newId,
  normalizeWeekPayload,
  parseJsonBody,
  parseStaffFields,
  parseStaffSchedulePath,
  sanitizeInapplicableShifts,
  staffPinMatches,
  summarizeAvailabilityForAdmin,
  weekStartForYmd,
} from "./staff-schedule-lib.mjs";
import {
  buildAvailabilityWindowMeta,
  closeAvailabilityForWeek,
  isAvailabilityWeekLocked,
  lockAvailabilityForWeek,
  openAvailabilityForWeek,
  staffAvailabilityTargetWeekStart,
  availabilityWindowStatus,
} from "./staff-schedule-availability-window.mjs";
import { fetchWeekClassCoverage } from "./staff-schedule-class-hours.mjs";
import { openStaffScheduleStore } from "./staff-schedule-store.mjs";
import {
  sendStaffAvailabilityReminderEmails,
  sendStaffScheduleEmails,
  sendStaffLoginEmail,
  staffScheduleEmailConfigured,
} from "./staff-schedule-email.mjs";

/** @param {import("@netlify/functions").HandlerEvent} event */
export async function handler(event) {
  const method = (event.httpMethod || "GET").toUpperCase();
  if (method === "OPTIONS") {
    return jsonResponse(204, "", adminCorsHeaders({
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    }));
  }

  if (!adminAuthorized(event)) {
    return jsonResponse(401, { ok: false, error: "unauthorized" }, adminCorsHeaders());
  }

  const route = parseStaffSchedulePath(event.path || "");
  if (!route) {
    return jsonResponse(404, { ok: false, error: "not_found" }, adminCorsHeaders());
  }

  const store = openStaffScheduleStore(event);
  if (!store.available) {
    return jsonResponse(503, { ok: false, error: "store_unavailable" }, adminCorsHeaders());
  }

  try {
    if (route.kind === "staff_collection") {
      return handleStaffCollection(event, method, store);
    }
    if (route.kind === "staff_item") {
      return handleStaffItem(event, method, store, route.staffId);
    }
    if (route.kind === "staff_send_login") {
      return handleStaffSendLogin(method, store, route.staffId);
    }
    if (route.kind === "week") {
      return handleWeek(event, method, store, route.weekStart);
    }
    if (route.kind === "week_publish") {
      return handleWeekPublish(method, store, route.weekStart);
    }
    if (route.kind === "week_unpublish") {
      return handleWeekUnpublish(method, store, route.weekStart);
    }
    if (route.kind === "week_export") {
      return handleWeekExport(method, store, route.weekStart);
    }
    if (route.kind === "week_availability") {
      return handleWeekAvailability(method, store, route.weekStart);
    }
    if (route.kind === "week_availability_open") {
      return handleWeekAvailabilityOpen(method, store, route.weekStart);
    }
    if (route.kind === "week_availability_close") {
      return handleWeekAvailabilityClose(method, store, route.weekStart);
    }
    if (route.kind === "week_availability_reset") {
      return handleWeekAvailabilityResetSubmission(method, store, route.weekStart, route.staffId);
    }
    if (route.kind === "week_availability_send_reminder") {
      return handleWeekAvailabilitySendReminder(event, method, store, route.weekStart);
    }
    if (route.kind === "availability_settings") {
      return handleAvailabilitySettings(event, method, store);
    }
    if (route.kind === "week_email") {
      return handleWeekEmail(method, store, route.weekStart);
    }
    if (route.kind === "staff_summary") {
      return handleStaffSummary(event, method, store);
    }
    if (route.kind === "staff_summary_export") {
      return handleStaffSummaryExport(event, method, store);
    }
    return jsonResponse(404, { ok: false, error: "not_found" }, adminCorsHeaders());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith("invalid_") || msg === "assigned_requires_staff" || msg === "shift_slot_not_applicable") {
      return jsonResponse(422, { ok: false, error: msg }, adminCorsHeaders());
    }
    console.error(JSON.stringify({ event: "staff_schedule_admin_error", error: msg }));
    return jsonResponse(500, { ok: false, error: "internal_error" }, adminCorsHeaders());
  }
}

/** @param {import("@netlify/functions").HandlerEvent} event @param {string} method @param {ReturnType<typeof openStaffScheduleStore>} store */
async function handleStaffCollection(event, method, store) {
  if (method === "GET") {
    const activeOnly = (event.queryStringParameters?.active || "").trim() === "1";
    let staff = await store.listStaff();
    if (activeOnly) staff = staff.filter((s) => s.active);
    return jsonResponse(
      200,
      {
        ok: true,
        staff,
        emailStaffAvailable: staffScheduleEmailConfigured(),
        storeMode: store.mode,
      },
      adminCorsHeaders(),
    );
  }

  if (method === "POST") {
    const body = parseJsonBody(event);
    if (body === null) {
      return jsonResponse(400, { ok: false, error: "invalid_json" }, adminCorsHeaders());
    }
    let fields;
    try {
      fields = parseStaffFields(body);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "invalid_staff_fields";
      return jsonResponse(
        422,
        {
          ok: false,
          error: msg,
          hint:
            msg === "invalid_staff_pin"
              ? "PIN must be 4–6 digits."
              : msg === "invalid_staff_hourly_rate"
                ? "Hourly rate must be a non-negative number."
                : "Name and valid email are required.",
        },
        adminCorsHeaders(),
      );
    }
    const now = new Date().toISOString();
    const staff = {
      id: newId("st"),
      ...fields,
      createdAt: now,
      updatedAt: now,
    };
    await store.putStaff(staff);
    return jsonResponse(201, { ok: true, staff, storeMode: store.mode }, adminCorsHeaders());
  }

  return jsonResponse(405, { ok: false, error: "method_not_allowed" }, adminCorsHeaders());
}

/** @param {import("@netlify/functions").HandlerEvent} event @param {string} method @param {ReturnType<typeof openStaffScheduleStore>} store @param {string} staffId */
async function handleStaffItem(event, method, store, staffId) {
  const existing = await store.getStaff(staffId);
  if (!existing && method !== "PUT") {
    return jsonResponse(404, { ok: false, error: "staff_not_found" }, adminCorsHeaders());
  }

  if (method === "PUT") {
    const body = parseJsonBody(event);
    if (body === null) {
      return jsonResponse(400, { ok: false, error: "invalid_json" }, adminCorsHeaders());
    }
    const base = existing || {
      id: staffId,
      name: "",
      email: "",
      pin: "",
      active: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    let fields;
    try {
      fields = parseStaffFields(body, base);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "invalid_staff_fields";
      return jsonResponse(
        422,
        {
          ok: false,
          error: msg,
          hint:
            msg === "invalid_staff_pin"
              ? "PIN must be 4–6 digits."
              : msg === "invalid_staff_hourly_rate"
                ? "Hourly rate must be a non-negative number."
                : "Name and valid email are required.",
        },
        adminCorsHeaders(),
      );
    }
    const staff = {
      ...base,
      ...fields,
      updatedAt: new Date().toISOString(),
    };
    await store.putStaff(staff);
    return jsonResponse(200, { ok: true, staff, storeMode: store.mode }, adminCorsHeaders());
  }

  if (method === "DELETE") {
    if (!existing) {
      return jsonResponse(404, { ok: false, error: "staff_not_found" }, adminCorsHeaders());
    }
    await store.deleteStaff(staffId);
    return jsonResponse(200, { ok: true, deleted: staffId, storeMode: store.mode }, adminCorsHeaders());
  }

  return jsonResponse(405, { ok: false, error: "method_not_allowed" }, adminCorsHeaders());
}

/** @param {string} method @param {ReturnType<typeof openStaffScheduleStore>} store @param {string} staffId */
async function handleStaffSendLogin(method, store, staffId) {
  if (method !== "POST") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" }, adminCorsHeaders());
  }

  const staff = await store.getStaff(staffId);
  if (!staff) {
    return jsonResponse(404, { ok: false, error: "staff_not_found" }, adminCorsHeaders());
  }

  const sendResult = await sendStaffLoginEmail(staff);
  if (!sendResult.ok) {
    return jsonResponse(
      422,
      { ok: false, error: sendResult.error, hint: sendResult.hint },
      adminCorsHeaders(),
    );
  }

  return jsonResponse(
    200,
    {
      ok: true,
      to: sendResult.to,
      messageId: sendResult.messageId,
      storeMode: store.mode,
    },
    adminCorsHeaders(),
  );
}

/** @param {string} weekStart */
function resolveWeekStartOrError(weekStart) {
  if (!isValidYmd(weekStart)) {
    return {
      error: jsonResponse(
        422,
        { ok: false, error: "invalid_week_start", hint: "Use a valid date (YYYY-MM-DD)." },
        adminCorsHeaders(),
      ),
    };
  }
  const weekStartsOn = defaultConfig().weekStartsOn;
  const resolved = weekStartForYmd(weekStart, weekStartsOn);
  return { resolved, normalized: resolved !== weekStart };
}

/** @param {import("@netlify/functions").HandlerEvent} event @param {string} method @param {ReturnType<typeof openStaffScheduleStore>} store @param {string} weekStart */
async function handleWeek(event, method, store, weekStart) {
  const resolvedWeek = resolveWeekStartOrError(weekStart);
  if (resolvedWeek.error) return resolvedWeek.error;
  const resolvedWeekStart = resolvedWeek.resolved;

  const config = await store.getConfig();

  const staffList = await store.listStaff();
  const { coverage: classCoverage, mindbodyOk: scheduleAvailable } = await fetchWeekClassCoverage(
    resolvedWeekStart,
    config,
  );

  if (method === "GET") {
    const week = await store.getOrCreateWeek(resolvedWeekStart);
    if (sanitizeInapplicableShifts(week, classCoverage, scheduleAvailable)) {
      await store.putWeek(week);
    }
    const availabilityWindow = await buildAvailabilityWindowMeta(store, resolvedWeekStart);
    return jsonResponse(
      200,
      {
        ok: true,
        week: enrichWeekResponse(week, config, staffList, classCoverage, scheduleAvailable),
        emailStaffAvailable: staffScheduleEmailConfigured(),
        availabilityWindow,
        resolvedWeekStart: resolvedWeek.normalized ? resolvedWeekStart : undefined,
        storeMode: store.mode,
      },
      adminCorsHeaders(),
    );
  }

  if (method === "PUT") {
    const body = parseJsonBody(event);
    if (body === null) {
      return jsonResponse(400, { ok: false, error: "invalid_json" }, adminCorsHeaders());
    }
    const existing = await store.getOrCreateWeek(resolvedWeekStart);
    if (existing.status === "published") {
      return jsonResponse(
        422,
        {
          ok: false,
          error: "week_published",
          hint: "Unpublish the week before editing assignments.",
        },
        adminCorsHeaders(),
      );
    }
    const staffMap = new Map(staffList.filter((s) => s.active).map((s) => [s.id, s]));
    const shifts = normalizeWeekPayload(
      body,
      existing,
      staffMap,
      classCoverage,
      scheduleAvailable,
    );
    appendChangeLog(existing, "save_draft", {
      shiftCount: shifts.length,
    });
    existing.shifts = shifts;
    existing.updatedAt = new Date().toISOString();
    existing.updatedBy = "admin_token";
    await store.putWeek(existing);
    return jsonResponse(
      200,
      {
        ok: true,
        week: enrichWeekResponse(existing, config, staffList, classCoverage, scheduleAvailable),
        emailStaffAvailable: staffScheduleEmailConfigured(),
        resolvedWeekStart: resolvedWeek.normalized ? resolvedWeekStart : undefined,
        storeMode: store.mode,
      },
      adminCorsHeaders(),
    );
  }

  return jsonResponse(405, { ok: false, error: "method_not_allowed" }, adminCorsHeaders());
}

/** @param {ReturnType<typeof openStaffScheduleStore>} store @param {string} weekStart */
async function loadWeekContext(store, weekStart) {
  const config = await store.getConfig();
  const staffList = await store.listStaff();
  const { coverage: classCoverage, mindbodyOk: scheduleAvailable } = await fetchWeekClassCoverage(
    weekStart,
    config,
  );
  return { config, staffList, classCoverage, scheduleAvailable };
}

/** @param {string} method @param {ReturnType<typeof openStaffScheduleStore>} store @param {string} weekStart */
async function handleWeekPublish(method, store, weekStart) {
  if (method !== "POST") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" }, adminCorsHeaders());
  }
  const resolvedWeek = resolveWeekStartOrError(weekStart);
  if (resolvedWeek.error) return resolvedWeek.error;
  const resolvedWeekStart = resolvedWeek.resolved;

  const { config, staffList, classCoverage, scheduleAvailable } = await loadWeekContext(
    store,
    resolvedWeekStart,
  );
  const week = await store.getOrCreateWeek(resolvedWeekStart);
  week.status = "published";
  week.publishedAt = new Date().toISOString();
  week.publishedBy = "admin_token";
  week.updatedAt = week.publishedAt;
  week.updatedBy = "admin_token";
  appendChangeLog(week, "publish", { weekStart: resolvedWeekStart });
  await store.putWeek(week);
  await lockAvailabilityForWeek(store, resolvedWeekStart);

  const availabilityWindow = await buildAvailabilityWindowMeta(store, resolvedWeekStart);

  return jsonResponse(
    200,
    {
      ok: true,
      week: enrichWeekResponse(week, config, staffList, classCoverage, scheduleAvailable),
      availabilityWindow,
      storeMode: store.mode,
    },
    adminCorsHeaders(),
  );
}

/** @param {string} method @param {ReturnType<typeof openStaffScheduleStore>} store @param {string} weekStart */
async function handleWeekUnpublish(method, store, weekStart) {
  if (method !== "POST") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" }, adminCorsHeaders());
  }
  const resolvedWeek = resolveWeekStartOrError(weekStart);
  if (resolvedWeek.error) return resolvedWeek.error;
  const resolvedWeekStart = resolvedWeek.resolved;

  const { config, staffList, classCoverage, scheduleAvailable } = await loadWeekContext(
    store,
    resolvedWeekStart,
  );
  const week = await store.getOrCreateWeek(resolvedWeekStart);
  week.status = "draft";
  week.updatedAt = new Date().toISOString();
  week.updatedBy = "admin_token";
  appendChangeLog(week, "unpublish", { weekStart: resolvedWeekStart });
  await store.putWeek(week);

  return jsonResponse(
    200,
    {
      ok: true,
      week: enrichWeekResponse(week, config, staffList, classCoverage, scheduleAvailable),
      storeMode: store.mode,
    },
    adminCorsHeaders(),
  );
}

/** @param {string} method @param {ReturnType<typeof openStaffScheduleStore>} store @param {string} weekStart */
async function handleWeekExport(method, store, weekStart) {
  if (method !== "GET") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" }, adminCorsHeaders());
  }
  const resolvedWeek = resolveWeekStartOrError(weekStart);
  if (resolvedWeek.error) return resolvedWeek.error;
  const resolvedWeekStart = resolvedWeek.resolved;

  const { config, staffList, classCoverage, scheduleAvailable } = await loadWeekContext(
    store,
    resolvedWeekStart,
  );
  const week = await store.getOrCreateWeek(resolvedWeekStart);
  const csv = buildWeekCsv(week, config, staffList, classCoverage, scheduleAvailable);

  return {
    statusCode: 200,
    headers: {
      ...adminCorsHeaders(),
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="amare-front-desk-${resolvedWeekStart}.csv"`,
    },
    body: csv,
  };
}

/** @param {string} method @param {ReturnType<typeof openStaffScheduleStore>} store @param {string} weekStart */
async function handleWeekAvailability(method, store, weekStart) {
  if (method !== "GET") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" }, adminCorsHeaders());
  }
  const resolvedWeek = resolveWeekStartOrError(weekStart);
  if (resolvedWeek.error) return resolvedWeek.error;
  const resolvedWeekStart = resolvedWeek.resolved;

  const staffList = await store.listStaff();
  const doc = await store.getAvailability(resolvedWeekStart);
  const summary = summarizeAvailabilityForAdmin(doc, staffList);
  const config = await store.getConfig();
  const availabilityWindow = await buildAvailabilityWindowMeta(store, resolvedWeekStart);

  return jsonResponse(
    200,
    {
      ok: true,
      availability: summary,
      availabilityWindow,
      formUrl: availabilityWindow.staffFormUrl,
      staffAvailabilityEarlyMorning: config.staffAvailabilityEarlyMorning === true,
      storeMode: store.mode,
    },
    adminCorsHeaders(),
  );
}

/** @param {string} method @param {ReturnType<typeof openStaffScheduleStore>} store @param {string} weekStart @param {string} staffId */
async function handleWeekAvailabilityResetSubmission(method, store, weekStart, staffId) {
  if (method !== "POST") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" }, adminCorsHeaders());
  }
  const resolvedWeek = resolveWeekStartOrError(weekStart);
  if (resolvedWeek.error) return resolvedWeek.error;
  const resolvedWeekStart = resolvedWeek.resolved;

  const week = await store.getWeek(resolvedWeekStart);
  const doc = (await store.getAvailability(resolvedWeekStart)) || emptyAvailabilityDoc(resolvedWeekStart);
  if (isAvailabilityWeekLocked(week, doc)) {
    return jsonResponse(
      422,
      {
        ok: false,
        error: "availability_locked",
        hint: "Published weeks cannot be reset. Unpublish the week first.",
      },
      adminCorsHeaders(),
    );
  }

  const cleared = clearAvailabilitySubmission(doc, staffId);
  if (!cleared) {
    return jsonResponse(
      404,
      { ok: false, error: "submission_not_found", hint: "No submission found for this staff member." },
      adminCorsHeaders(),
    );
  }

  await store.putAvailability(doc);
  const staffList = await store.listStaff();
  const summary = summarizeAvailabilityForAdmin(doc, staffList);
  const availabilityWindow = await buildAvailabilityWindowMeta(store, resolvedWeekStart);

  return jsonResponse(
    200,
    {
      ok: true,
      availability: summary,
      availabilityWindow,
      storeMode: store.mode,
    },
    adminCorsHeaders(),
  );
}

/** @param {import("@netlify/functions").HandlerEvent} event @param {string} method @param {ReturnType<typeof openStaffScheduleStore>} store @param {string} weekStart */
async function handleWeekAvailabilitySendReminder(event, method, store, weekStart) {
  if (method !== "POST") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" }, adminCorsHeaders());
  }
  if (!staffScheduleEmailConfigured()) {
    return jsonResponse(
      503,
      {
        ok: false,
        error: "email_not_configured",
        hint: "Set ENABLE_STAFF_SCHEDULE_ADMIN_EMAIL=1, RESEND_API_KEY, and STAFF_SCHEDULE_EMAIL_FROM (or SMS_ADMIN_REPORT_FROM).",
      },
      adminCorsHeaders(),
    );
  }

  const body = parseJsonBody(event);
  if (body === null) {
    return jsonResponse(400, { ok: false, error: "invalid_json" }, adminCorsHeaders());
  }

  const staffIds = Array.isArray(body.staffIds)
    ? body.staffIds.map((id) => String(id || "").trim()).filter(Boolean)
    : [];
  if (!staffIds.length) {
    return jsonResponse(
      422,
      { ok: false, error: "no_staff_selected", hint: "Select at least one staff member." },
      adminCorsHeaders(),
    );
  }

  const openIfClosed = body.openIfClosed === true;
  const config = await store.getConfig();
  const targetWeek = staffAvailabilityTargetWeekStart(config);
  const resolvedWeek = resolveWeekStartOrError(weekStart);
  if (resolvedWeek.error) return resolvedWeek.error;
  const resolvedWeekStart = resolvedWeek.resolved;

  if (resolvedWeekStart !== targetWeek) {
    return jsonResponse(
      422,
      {
        ok: false,
        error: "availability_not_next_week",
        hint: "Availability reminders are only for the upcoming week.",
        targetWeek,
      },
      adminCorsHeaders(),
    );
  }

  const week = await store.getWeek(resolvedWeekStart);
  const availabilityDoc = (await store.getAvailability(resolvedWeekStart)) || emptyAvailabilityDoc(resolvedWeekStart);
  let status = availabilityWindowStatus(week, availabilityDoc, config, resolvedWeekStart, targetWeek);
  const wasClosed = status === "closed";

  if (status === "locked") {
    return jsonResponse(
      422,
      {
        ok: false,
        error: "availability_locked",
        hint: "This week is published. Unpublish before asking staff to submit availability.",
      },
      adminCorsHeaders(),
    );
  }

  if (status === "closed") {
    if (!openIfClosed) {
      return jsonResponse(
        422,
        {
          ok: false,
          error: "availability_closed",
          needsOpen: true,
          hint: "Availability is closed. Confirm opening registration before sending.",
        },
        adminCorsHeaders(),
      );
    }
    try {
      await openAvailabilityForWeek(store, resolvedWeekStart);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "week_published") {
        return jsonResponse(
          422,
          { ok: false, error: msg, hint: "Unpublish the week before opening availability." },
          adminCorsHeaders(),
        );
      }
      throw e;
    }
    status = "open";
  }

  const staffList = await store.listStaff();
  const byId = new Map(staffList.map((s) => [s.id, s]));
  const selected = staffIds.map((id) => byId.get(id)).filter(Boolean);
  if (!selected.length) {
    return jsonResponse(
      422,
      { ok: false, error: "staff_not_found", hint: "None of the selected staff were found." },
      adminCorsHeaders(),
    );
  }

  const sendResult = await sendStaffAvailabilityReminderEmails(selected, resolvedWeekStart);
  if (!sendResult.ok) {
    return jsonResponse(
      422,
      {
        ok: false,
        error: sendResult.error,
        hint: sendResult.hint,
        sent: sendResult.sent || 0,
        recipients: sendResult.recipients || [],
      },
      adminCorsHeaders(),
    );
  }

  const availabilityWindow = await buildAvailabilityWindowMeta(store, resolvedWeekStart);
  const summary = summarizeAvailabilityForAdmin(
    await store.getAvailability(resolvedWeekStart),
    staffList,
  );

  return jsonResponse(
    200,
    {
      ok: true,
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
    },
    adminCorsHeaders(),
  );
}

/** @param {import("@netlify/functions").HandlerEvent} event @param {string} method @param {ReturnType<typeof openStaffScheduleStore>} store */
async function handleAvailabilitySettings(event, method, store) {
  const config = await store.getConfig();

  if (method === "GET") {
    return jsonResponse(
      200,
      {
        ok: true,
        staffAvailabilityEarlyMorning: config.staffAvailabilityEarlyMorning === true,
        storeMode: store.mode,
      },
      adminCorsHeaders(),
    );
  }

  if (method === "PUT") {
    const body = parseJsonBody(event);
    if (body === null) {
      return jsonResponse(400, { ok: false, error: "invalid_json" }, adminCorsHeaders());
    }
    if (typeof body.staffAvailabilityEarlyMorning !== "boolean") {
      return jsonResponse(
        422,
        { ok: false, error: "invalid_staff_availability_early_morning" },
        adminCorsHeaders(),
      );
    }
    config.staffAvailabilityEarlyMorning = body.staffAvailabilityEarlyMorning;
    await store.putConfig(config);
    return jsonResponse(
      200,
      {
        ok: true,
        staffAvailabilityEarlyMorning: config.staffAvailabilityEarlyMorning,
        storeMode: store.mode,
      },
      adminCorsHeaders(),
    );
  }

  return jsonResponse(405, { ok: false, error: "method_not_allowed" }, adminCorsHeaders());
}

/** @param {string} method @param {ReturnType<typeof openStaffScheduleStore>} store @param {string} weekStart */
async function handleWeekAvailabilityOpen(method, store, weekStart) {
  if (method !== "POST") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" }, adminCorsHeaders());
  }
  const resolvedWeek = resolveWeekStartOrError(weekStart);
  if (resolvedWeek.error) return resolvedWeek.error;
  const resolvedWeekStart = resolvedWeek.resolved;

  try {
    await openAvailabilityForWeek(store, resolvedWeekStart);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "week_published") {
      return jsonResponse(
        422,
        { ok: false, error: msg, hint: "Unpublish the week before opening availability." },
        adminCorsHeaders(),
      );
    }
    if (msg === "availability_not_next_week") {
      return jsonResponse(
        422,
        {
          ok: false,
          error: msg,
          hint: "Staff availability is only for the upcoming week. Move Week planner to next week, then open availability.",
        },
        adminCorsHeaders(),
      );
    }
    throw e;
  }

  const availabilityWindow = await buildAvailabilityWindowMeta(store, resolvedWeekStart);
  return jsonResponse(
    200,
    { ok: true, availabilityWindow, storeMode: store.mode },
    adminCorsHeaders(),
  );
}

/** @param {string} method @param {ReturnType<typeof openStaffScheduleStore>} store @param {string} weekStart */
async function handleWeekAvailabilityClose(method, store, weekStart) {
  if (method !== "POST") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" }, adminCorsHeaders());
  }
  const resolvedWeek = resolveWeekStartOrError(weekStart);
  if (resolvedWeek.error) return resolvedWeek.error;
  const resolvedWeekStart = resolvedWeek.resolved;

  await closeAvailabilityForWeek(store, resolvedWeekStart);
  const availabilityWindow = await buildAvailabilityWindowMeta(store, resolvedWeekStart);
  return jsonResponse(
    200,
    { ok: true, availabilityWindow, storeMode: store.mode },
    adminCorsHeaders(),
  );
}

/** @param {string} method @param {ReturnType<typeof openStaffScheduleStore>} store @param {string} weekStart */
async function handleWeekEmail(method, store, weekStart) {
  if (method !== "POST") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" }, adminCorsHeaders());
  }
  if (!staffScheduleEmailConfigured()) {
    return jsonResponse(
      503,
      {
        ok: false,
        error: "email_not_configured",
        hint: "Set ENABLE_STAFF_SCHEDULE_ADMIN_EMAIL=1, RESEND_API_KEY, and STAFF_SCHEDULE_EMAIL_FROM (or SMS_ADMIN_REPORT_FROM).",
      },
      adminCorsHeaders(),
    );
  }

  const resolvedWeek = resolveWeekStartOrError(weekStart);
  if (resolvedWeek.error) return resolvedWeek.error;
  const resolvedWeekStart = resolvedWeek.resolved;

  const { config, staffList, classCoverage, scheduleAvailable } = await loadWeekContext(
    store,
    resolvedWeekStart,
  );
  const week = await store.getOrCreateWeek(resolvedWeekStart);
  if (week.status !== "published") {
    return jsonResponse(
      422,
      {
        ok: false,
        error: "week_not_published",
        hint: "Publish the week before emailing staff.",
      },
      adminCorsHeaders(),
    );
  }

  const enriched = enrichWeekResponse(week, config, staffList, classCoverage, scheduleAvailable);
  const sendResult = await sendStaffScheduleEmails(enriched);
  if (!sendResult.ok) {
    return jsonResponse(
      422,
      {
        ok: false,
        error: sendResult.error,
        hint: sendResult.hint,
      },
      adminCorsHeaders(),
    );
  }

  appendChangeLog(week, "email_staff", {
    weekStart: resolvedWeekStart,
    sent: sendResult.sent,
    recipients: sendResult.recipients,
  });
  week.updatedAt = new Date().toISOString();
  week.updatedBy = "admin_token";
  await store.putWeek(week);

  return jsonResponse(
    200,
    {
      ok: true,
      sent: sendResult.sent,
      recipients: sendResult.recipients,
      storeMode: store.mode,
    },
    adminCorsHeaders(),
  );
}

/** @param {import("@netlify/functions").HandlerEvent} event */
function parseStaffSummaryQuery(event) {
  const q = event.queryStringParameters || {};
  const from = String(q.from || "").trim();
  const to = String(q.to || "").trim();
  const publishedOnly = String(q.publishedOnly ?? "1").trim() !== "0";

  if (!isValidYmd(from) || !isValidYmd(to)) {
    return {
      error: jsonResponse(
        422,
        {
          ok: false,
          error: "invalid_date_range",
          hint: "Use from and to query params as YYYY-MM-DD.",
        },
        adminCorsHeaders(),
      ),
    };
  }
  if (from > to) {
    return {
      error: jsonResponse(
        422,
        {
          ok: false,
          error: "invalid_date_range",
          hint: "from must be on or before to.",
        },
        adminCorsHeaders(),
      ),
    };
  }
  if (daysBetweenYmd(from, to) > 62) {
    return {
      error: jsonResponse(
        422,
        {
          ok: false,
          error: "date_range_too_long",
          hint: "Maximum range is 62 days.",
        },
        adminCorsHeaders(),
      ),
    };
  }

  return { from, to, publishedOnly };
}

/** @param {ReturnType<typeof openStaffScheduleStore>} store @param {string} from @param {string} to @param {boolean} publishedOnly */
async function loadStaffSummaryData(store, from, to, publishedOnly) {
  const config = await store.getConfig();
  const staffList = await store.listStaff();
  const weekStarts = listWeekStartsOverlappingRange(from, to, config.weekStartsOn || "sunday");

  const weekBundles = await Promise.all(
    weekStarts.map(async (weekStart) => {
      const week = await store.getWeek(weekStart);
      if (!week) {
        return { weekStart, status: null, enriched: null, missing: true };
      }
      const { coverage: classCoverage, mindbodyOk: scheduleAvailable } =
        await fetchWeekClassCoverage(weekStart, config);
      if (sanitizeInapplicableShifts(week, classCoverage, scheduleAvailable)) {
        await store.putWeek(week);
      }
      return {
        weekStart,
        status: week.status,
        enriched: enrichWeekResponse(week, config, staffList, classCoverage, scheduleAvailable),
        missing: false,
      };
    }),
  );

  const summary = buildStaffPeriodSummary({
    from,
    to,
    publishedOnly,
    staffList,
    weekBundles,
  });

  return { config, summary, storeMode: store.mode };
}

/** @param {import("@netlify/functions").HandlerEvent} event @param {string} method @param {ReturnType<typeof openStaffScheduleStore>} store */
async function handleStaffSummary(event, method, store) {
  if (method !== "GET") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" }, adminCorsHeaders());
  }

  const parsed = parseStaffSummaryQuery(event);
  if (parsed.error) return parsed.error;

  const { summary, storeMode } = await loadStaffSummaryData(
    store,
    parsed.from,
    parsed.to,
    parsed.publishedOnly,
  );

  return jsonResponse(
    200,
    {
      ok: true,
      summary,
      storeMode,
    },
    adminCorsHeaders(),
  );
}

/** @param {import("@netlify/functions").HandlerEvent} event @param {string} method @param {ReturnType<typeof openStaffScheduleStore>} store */
async function handleStaffSummaryExport(event, method, store) {
  if (method !== "GET") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" }, adminCorsHeaders());
  }

  const parsed = parseStaffSummaryQuery(event);
  if (parsed.error) return parsed.error;

  const { summary } = await loadStaffSummaryData(
    store,
    parsed.from,
    parsed.to,
    parsed.publishedOnly,
  );
  const csv = buildStaffSummaryCsv(summary);
  const filename = `amare-staff-summary-${parsed.from}_to_${parsed.to}.csv`;

  return {
    statusCode: 200,
    headers: {
      ...adminCorsHeaders(),
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
    body: csv,
  };
}
