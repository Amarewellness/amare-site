import {
  MB_API_VERSION,
  fetchMb,
  getMindbodyStaffAccessTokenCached,
  visitsList,
  jsonResponse,
} from "./mindbody-consumer-lib.mjs";
import { mindbodyStaffApiHeaders, mindbodyStaffBearerHeaders } from "./mindbody-upstream.mjs";
import { fetchClassRowForCapacity } from "./guest-pass-lib.mjs";
import {
  parseClassCapacitySnapshot,
  evaluateStaffNormalSeatBooking,
} from "./mindbody-class-capacity-lib.mjs";
import { mindbodyStudioCalendarDay } from "./member-topup-lib.mjs";

export { MB_API_VERSION, fetchMb };

export function parseJsonBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function clientServiceRemainingFromRow(s) {
  const rem = s.Remaining ?? s.remaining;
  if (typeof rem === "number" && Number.isFinite(rem)) return rem;
  if (rem != null && rem !== "" && Number.isFinite(Number(rem))) return Number(rem);
  return null;
}

/**
 * @param {Record<string, unknown>} s
 * @returns {number | null}
 */
export function clientServiceIdFromRow(s) {
  const sid = s.Id ?? s.id;
  if (typeof sid === "number" && Number.isFinite(sid) && sid > 0) return Math.trunc(sid);
  if (typeof sid === "string" && /^\d+$/.test(sid.trim())) return parseInt(sid.trim(), 10);
  return null;
}

/**
 * @returns {Promise<number[]>} Active ClientService ids with visits left, highest remaining first.
 */
export async function listActiveClientServiceIds(clientId, authHeaders) {
  const v = MB_API_VERSION;
  const q = new URLSearchParams({
    "request.clientId": String(clientId),
    /** Align with `/member/summary` — monthly membership visit buckets may be omitted when true. */
    "request.showActiveOnly": "false",
    "request.limit": "100",
  });
  const r = await fetchMb("GET", `/public/v${v}/client/clientservices?${q}`, authHeaders, null);
  if (!r.ok || !r.data || typeof r.data !== "object") return [];
  const d = /** @type {Record<string, unknown>} */ (r.data);
  const arr = /** @type {unknown[]} */ (
    Array.isArray(d.ClientServices) ? d.ClientServices : Array.isArray(d.clientServices) ? d.clientServices : []
  );
  /** @type {{ id: number; remaining: number }[]} */
  const out = [];
  const todayDay = new Date();
  const todayMs = new Date(todayDay.getFullYear(), todayDay.getMonth(), todayDay.getDate()).getTime();

  for (const raw of arr) {
    const s = /** @type {Record<string, unknown>} */ (raw);
    const rem = clientServiceRemainingFromRow(s);
    if (rem == null || rem <= 0) continue;
    const sid = clientServiceIdFromRow(s);
    if (sid == null) continue;

    const exp = s.ExpirationDate ?? s.expirationDate ?? s.End ?? s.endDate;
    if (exp != null && exp !== "") {
      const dExp = new Date(String(exp));
      if (!Number.isNaN(dExp.getTime())) {
        const expDay = new Date(dExp.getFullYear(), dExp.getMonth(), dExp.getDate()).getTime();
        if (expDay < todayMs) continue;
      }
    }

    out.push({ id: sid, remaining: rem });
  }

  out.sort((a, b) => b.remaining - a.remaining);
  return out.map((x) => x.id);
}

/**
 * Union consumer + staff active ClientService ids (matches member-summary staff merge).
 * @param {number} clientId
 * @param {Record<string, string>} consumerHeaders
 * @param {Record<string, string> | null} staffHeaders
 */
export async function listBookableClientServiceIds(clientId, consumerHeaders, staffHeaders) {
  const consumerIds = await listActiveClientServiceIds(clientId, consumerHeaders);
  if (!staffHeaders) {
    return { bookableIds: consumerIds, consumerIds, staffIds: [] };
  }
  const staffIds = await listActiveClientServiceIds(clientId, staffHeaders);
  const staffOnly = staffIds.filter((id) => !consumerIds.includes(id));
  return {
    bookableIds: [...consumerIds, ...staffOnly],
    consumerIds,
    staffIds,
  };
}

/**
 * @returns {Promise<Map<number, number>>} ClientServiceId → Remaining visits
 */
export async function fetchClientServiceRemainingMap(clientId, authHeaders) {
  const v = MB_API_VERSION;
  const q = new URLSearchParams({
    "request.clientId": String(clientId),
    "request.showActiveOnly": "false",
    "request.limit": "100",
  });
  const r = await fetchMb("GET", `/public/v${v}/client/clientservices?${q}`, authHeaders, null);
  /** @type {Map<number, number>} */
  const map = new Map();
  if (!r.ok || !r.data || typeof r.data !== "object") return map;
  const d = /** @type {Record<string, unknown>} */ (r.data);
  const arr = /** @type {unknown[]} */ (
    Array.isArray(d.ClientServices) ? d.ClientServices : Array.isArray(d.clientServices) ? d.clientServices : []
  );
  const todayMs = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).getTime();
  for (const raw of arr) {
    const s = /** @type {Record<string, unknown>} */ (raw);
    const sid = clientServiceIdFromRow(s);
    const rem = clientServiceRemainingFromRow(s);
    if (sid == null || rem == null || rem <= 0) continue;
    const exp = s.ExpirationDate ?? s.expirationDate ?? s.End ?? s.endDate;
    if (exp != null && exp !== "") {
      const dExp = new Date(String(exp));
      if (!Number.isNaN(dExp.getTime())) {
        const expDay = new Date(dExp.getFullYear(), dExp.getMonth(), dExp.getDate()).getTime();
        if (expDay < todayMs) continue;
      }
    }
    map.set(sid, rem);
  }
  return map;
}

/** @param {Map<number, number>} consumerMap @param {Map<number, number>} staffMap */
export function mergeRemainingMaps(consumerMap, staffMap) {
  const merged = new Map(consumerMap);
  for (const [id, rem] of staffMap) {
    const cur = merged.get(id);
    if (cur == null || rem < cur) merged.set(id, rem);
  }
  return merged;
}

export async function fetchMergedClientServiceRemainingMap(clientId, consumerHeaders, staffHeaders) {
  const consumerMap = await fetchClientServiceRemainingMap(clientId, consumerHeaders);
  if (!staffHeaders) return consumerMap;
  const staffMap = await fetchClientServiceRemainingMap(clientId, staffHeaders);
  return mergeRemainingMaps(consumerMap, staffMap);
}

/**
 * Trims a Mindbody response down to just the operator-relevant message + status hint, so
 * production logs aren't polluted with the full PascalCase body for every booking attempt.
 * @param {unknown} data
 */
export function summarizeMindbodyBookError(data) {
  if (!data || typeof data !== "object") return null;
  const d = /** @type {Record<string, unknown>} */ (data);
  const inner = d.Error && typeof d.Error === "object" ? /** @type {Record<string, unknown>} */ (d.Error) : null;
  const message =
    (inner && typeof inner.Message === "string" ? inner.Message : null) ??
    (typeof d.Message === "string" ? d.Message : null) ??
    null;
  const code = inner && typeof inner.Code === "string" ? inner.Code : null;
  return { message: message ? message.slice(0, 200) : null, code };
}

/** @param {{ message: string | null; code: string | null } | null} summary */
export function isPaymentRequiredError(summary) {
  if (!summary) return false;
  const blob = `${summary.code ?? ""} ${summary.message ?? ""}`;
  return (
    /ClassRequiresPayment/i.test(blob) ||
    /\bno available payments?\b/i.test(blob) ||
    /\bhas no available payments?\b/i.test(blob)
  );
}

export const NO_BOOKABLE_CREDITS_MESSAGE =
  "You don't have class credits or a package that applies to this class. Buy a drop-in, class pack, or membership first — then come back and book.";

export const NO_CREDITS_VALID_FOR_CLASS_DATE_MESSAGE =
  "Your current class credits aren't valid for this class date.";

/** @param {Record<string, unknown>} row @param {string[]} keys */
function pickClientServiceField(row, keys) {
  for (const k of keys) {
    const v = row[k];
    if (v != null && v !== "") return v;
  }
  return null;
}

/**
 * ClientService valid for a specific class studio calendar day (not "today").
 *
 * @param {Record<string, unknown>} row
 * @param {string} classDayKey YYYY-MM-DD America/New_York
 */
export function isClientServiceValidForClassDate(row, classDayKey) {
  if (!classDayKey) return false;
  const rem = clientServiceRemainingFromRow(row);
  if (rem == null || rem <= 0) return false;

  const startDay = mindbodyStudioCalendarDay(
    pickClientServiceField(row, [
      "ActiveDate",
      "activeDate",
      "PaymentDate",
      "paymentDate",
      "SaleDate",
      "saleDate",
    ]),
  );
  const endDay = mindbodyStudioCalendarDay(
    pickClientServiceField(row, ["ExpirationDate", "expirationDate", "End", "endDate"]),
  );

  if (startDay && classDayKey < startDay) return false;
  if (endDay && classDayKey > endDay) return false;
  return true;
}

/**
 * @param {Record<string, unknown>[]} rows
 * @param {number[]} candidateIds highest-remaining order preserved
 * @param {string} classDayKey
 */
export function filterBookableIdsForClassDate(rows, candidateIds, classDayKey) {
  /** @type {Map<number, Record<string, unknown>>} */
  const byId = new Map();
  for (const row of rows) {
    const id = clientServiceIdFromRow(row);
    if (id != null) byId.set(id, row);
  }
  return candidateIds.filter((id) => {
    const row = byId.get(id);
    return row != null && isClientServiceValidForClassDate(row, classDayKey);
  });
}

/** @param {unknown} row */
export function authoritativeClassStartIsoFromRow(row) {
  if (!row || typeof row !== "object") return null;
  const o = /** @type {Record<string, unknown>} */ (row);
  const start = o.StartDateTime ?? o.startDateTime;
  return typeof start === "string" && start.trim() ? start.trim().slice(0, 40) : null;
}

/**
 * Authoritative class StartDateTime for booking entitlement (Mindbody class row).
 * `hintStartIso` only narrows the lookup window — never used for entitlement.
 *
 * @param {Record<string, string>} staffHeaders
 * @param {number} classId
 * @param {string | undefined} hintStartIso
 */
export async function resolveAuthoritativeClassStartForBooking(staffHeaders, classId, hintStartIso) {
  const fetched = await fetchClassRowForCapacity(staffHeaders, classId, {
    startDateTime: hintStartIso,
  });
  if (!fetched.ok || !fetched.row) {
    return { ok: false, classStartIso: null, classDayKey: null, row: null };
  }
  const classStartIso = authoritativeClassStartIsoFromRow(fetched.row);
  const classDayKey = classStartIso ? mindbodyStudioCalendarDay(classStartIso) : null;
  if (!classStartIso || !classDayKey) {
    return { ok: false, classStartIso: null, classDayKey: null, row: fetched.row };
  }
  return { ok: true, classStartIso, classDayKey, row: fetched.row };
}

/**
 * @param {Record<string, string | string[]>} [cookieHdr]
 * @param {Record<string, unknown>} [extra]
 */
export function noCreditsValidForClassDateResponse(cookieHdr, extra = {}) {
  return jsonResponse(
    402,
    {
      ok: false,
      error: "payment_not_applied",
      suggestPackages: false,
      hasBookableCredits: true,
      message: NO_CREDITS_VALID_FOR_CLASS_DATE_MESSAGE,
      /** Released iOS/Android read `detail` for human-readable copy (not `message`). */
      detail: NO_CREDITS_VALID_FOR_CLASS_DATE_MESSAGE,
      rejectionReason: "service_not_valid_for_class_date",
      ...extra,
    },
    cookieHdr,
  );
}

/**
 * @param {Record<string, string | string[]>} [cookieHdr]
 * @param {Record<string, unknown>} [extra]
 */
export function noBookableCreditsResponse(cookieHdr, extra = {}) {
  return jsonResponse(
    402,
    {
      ok: false,
      error: "no_bookable_credits",
      suggestPackages: true,
      message: NO_BOOKABLE_CREDITS_MESSAGE,
      ...extra,
    },
    cookieHdr,
  );
}

const PAYMENT_NOT_APPLIED_MESSAGE =
  "We couldn't apply your class credits to this booking. Nothing was charged — please try again or contact the studio if it keeps happening.";

const UNPAID_VISIT_MESSAGE =
  "This booking would have been recorded as unpaid in Mindbody, so we cancelled it. Please try again or contact the studio.";

/**
 * @param {Record<string, string | string[]>} [cookieHdr]
 * @param {"payment_not_applied" | "unpaid_visit_detected"} errorCode
 * @param {Record<string, unknown>} [extra]
 */
export function paymentVerificationFailedResponse(cookieHdr, errorCode, extra = {}) {
  const hasCredits = extra.hasBookableCredits === true;
  const humanMessage =
    errorCode === "unpaid_visit_detected" ? UNPAID_VISIT_MESSAGE : PAYMENT_NOT_APPLIED_MESSAGE;
  return jsonResponse(
    402,
    {
      ok: false,
      error: errorCode,
      /** Only steer to Pricing when the member truly has no bookable credits. */
      suggestPackages: errorCode === "no_bookable_credits" || (extra.suggestPackages === true && !hasCredits),
      message: humanMessage,
      /** Released iOS/Android read `detail` for human-readable copy (not `message`). */
      detail: humanMessage,
      ...extra,
    },
    cookieHdr,
  );
}

export async function resolveStaffAuthHeaders() {
  const staffIssued = await getMindbodyStaffAccessTokenCached({ issueTimeoutMs: 8000 });
  if (staffIssued.ok === true) {
    const h = mindbodyStaffBearerHeaders(staffIssued.accessToken);
    if (h) return h;
  }
  return mindbodyStaffApiHeaders();
}

function classIdFromVisitRow(row) {
  const raw = row?.ClassId ?? row?.classId;
  if (raw != null && Number.isFinite(Number(raw))) return Number(raw);
  const cls = row?.Class ?? row?.class;
  if (cls && typeof cls === "object") {
    const cid = cls.Id ?? cls.id ?? cls.ClassId ?? cls.classId;
    if (cid != null && Number.isFinite(Number(cid))) return Number(cid);
  }
  return null;
}

/**
 * Server-side ownership check. Do not trust frontend visitId alone.
 * @param {{ clientId: number; classId: number; visitId: number; authHeaders: Record<string, string> }} opts
 */
export async function visitOwnedByClient(opts) {
  const start = new Date();
  start.setUTCFullYear(start.getUTCFullYear() - 1);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date();
  end.setUTCDate(end.getUTCDate() + 400);
  end.setUTCHours(23, 59, 59, 999);
  const q = new URLSearchParams({
    "request.clientId": String(opts.clientId),
    "request.startDate": start.toISOString(),
    "request.endDate": end.toISOString(),
    "request.limit": "200",
    "request.offset": "0",
  });
  const r = await fetchMb("GET", `/public/v${MB_API_VERSION}/client/clientvisits?${q}`, opts.authHeaders, null);
  if (!r.ok) return false;
  const rows = visitsList(r.data);
  return rows.some((raw) => {
    if (!raw || typeof raw !== "object") return false;
    const row = /** @type {Record<string, unknown>} */ (raw);
    return visitIdFromRow(row) === opts.visitId && classIdFromVisitRow(row) === opts.classId;
  });
}

function waitlistEntryIdFromRow(row) {
  const raw = row?.Id ?? row?.id ?? row?.WaitlistEntryId ?? row?.waitlistEntryId;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * @param {{ clientId: number; waitlistEntryId: number; authHeaders: Record<string, string> }} opts
 */
export async function waitlistEntryOwnedByClient(opts) {
  const q = new URLSearchParams({
    "request.clientIds": String(opts.clientId),
    "request.hidePastEntries": "true",
    "request.limit": "200",
    "request.offset": "0",
  });
  const r = await fetchMb("GET", `/public/v${MB_API_VERSION}/class/waitlistentries?${q}`, opts.authHeaders, null);
  if (!r.ok || !r.data || typeof r.data !== "object") return false;
  const d = /** @type {Record<string, unknown>} */ (r.data);
  const rows = Array.isArray(d.WaitlistEntries)
    ? d.WaitlistEntries
    : Array.isArray(d.waitlistEntries)
      ? d.waitlistEntries
      : [];
  return rows.some((raw) => {
    if (!raw || typeof raw !== "object") return false;
    return waitlistEntryIdFromRow(/** @type {Record<string, unknown>} */ (raw)) === opts.waitlistEntryId;
  });
}

/**
 * Pull the freshly-created visit id out of `addclienttoclass` so the browser can flip
 * the slot to "Cancel booking" without round-tripping `member/summary` again. Mindbody
 * v6 typically nests the visit inside `Class.Visits[]` (one or more rows), but some
 * sites surface a top-level `Visit` object — accept both, and prefer the row whose
 * `ClassId` matches the request to avoid picking a sibling visit if the response ever
 * batches multiple class instances.
 *
 * @param {unknown} data
 * @param {number} classId
 * @returns {number | null}
 */
export function extractVisitIdFromBookResponse(data, classId) {
  if (!data || typeof data !== "object") return null;
  const d = /** @type {Record<string, unknown>} */ (data);

  /** @param {unknown} row */
  function pickIdFromVisitRow(row) {
    if (!row || typeof row !== "object") return null;
    const v = /** @type {Record<string, unknown>} */ (row);
    const id = v.Id ?? v.id ?? v.VisitId ?? v.visitId;
    if (id != null && Number.isFinite(Number(id)) && Number(id) > 0) return Number(id);
    return null;
  }

  /** @param {unknown} row */
  function visitRowMatchesClass(row) {
    if (!row || typeof row !== "object") return false;
    const v = /** @type {Record<string, unknown>} */ (row);
    const cid = v.ClassId ?? v.classId;
    if (cid == null) return true; // unknown — let caller decide
    return Number.isFinite(Number(cid)) && Number(cid) === classId;
  }

  const wrappedClass =
    d.Class && typeof d.Class === "object"
      ? /** @type {Record<string, unknown>} */ (d.Class)
      : d.class && typeof d.class === "object"
        ? /** @type {Record<string, unknown>} */ (d.class)
        : null;
  if (wrappedClass) {
    const visitsRaw = wrappedClass.Visits ?? wrappedClass.visits;
    if (Array.isArray(visitsRaw)) {
      for (const row of visitsRaw) {
        if (visitRowMatchesClass(row)) {
          const id = pickIdFromVisitRow(row);
          if (id != null) return id;
        }
      }
      for (const row of visitsRaw) {
        const id = pickIdFromVisitRow(row);
        if (id != null) return id;
      }
    }
  }

  for (const k of ["Visit", "visit", "ClassVisit", "classVisit"]) {
    const id = pickIdFromVisitRow(d[k]);
    if (id != null) return id;
  }

  return pickIdFromVisitRow(d);
}

/**
 * Visit rows from a successful `addclienttoclass` body (for payment validation).
 * @param {unknown} data
 * @param {number} classId
 * @returns {Record<string, unknown>[]}
 */
export function extractVisitRowsFromBookResponse(data, classId) {
  if (!data || typeof data !== "object") return [];
  const d = /** @type {Record<string, unknown>} */ (data);

  /** @param {unknown} row */
  function visitRowMatchesClass(row) {
    if (!row || typeof row !== "object") return false;
    const v = /** @type {Record<string, unknown>} */ (row);
    const cid = v.ClassId ?? v.classId;
    if (cid == null) return true;
    return Number.isFinite(Number(cid)) && Number(cid) === classId;
  }

  /** @type {Record<string, unknown>[]} */
  const out = [];
  const wrappedClass =
    d.Class && typeof d.Class === "object"
      ? /** @type {Record<string, unknown>} */ (d.Class)
      : d.class && typeof d.class === "object"
        ? /** @type {Record<string, unknown>} */ (d.class)
        : null;
  if (wrappedClass) {
    const visitsRaw = wrappedClass.Visits ?? wrappedClass.visits;
    if (Array.isArray(visitsRaw)) {
      for (const row of visitsRaw) {
        if (row && typeof row === "object" && visitRowMatchesClass(row)) {
          out.push(/** @type {Record<string, unknown>} */ (row));
        }
      }
    }
  }
  for (const k of ["Visit", "visit", "ClassVisit", "classVisit"]) {
    const row = d[k];
    if (row && typeof row === "object") out.push(/** @type {Record<string, unknown>} */ (row));
  }
  return out;
}

/** @param {Record<string, unknown>} row */
export function visitRowLooksUnpaid(row) {
  /** @param {unknown} val */
  function str(val) {
    return typeof val === "string" && val.trim() ? val.trim() : "";
  }
  const blob = [
    str(row.ServiceName ?? row.serviceName),
    str(row.Name ?? row.name),
    str(row.ServiceCategory ?? row.serviceCategory),
    str(row.ServiceCategoryName ?? row.serviceCategoryName),
    str(row.ProductName ?? row.productName),
    str(row.Type ?? row.type),
  ].join(" ");
  return /\bunpaid\b/i.test(blob);
}

/**
 * Staff `addclienttoclass` without `RequirePayment: true` can return HTTP 200 while
 * ignoring `ClientServiceId` and creating an Unpaid Visit — roll back and fail closed.
 * @param {number} classId
 * @param {unknown} data
 * @param {number | null} clientServiceIdUsed
 */
export function bookResponseLooksUnpaid(classId, data, clientServiceIdUsed) {
  const rows = extractVisitRowsFromBookResponse(data, classId);
  if (!rows.length) return false;
  return rows.some((row) => visitRowLooksUnpaid(row));
}

/**
 * @param {{
 *   clientId: number;
 *   classId: number;
 *   visitId: number;
 *   consumerHeaders: Record<string, string>;
 *   staffHeaders: Record<string, string> | null;
 * }} opts
 */
export async function rollbackBookedVisit(opts) {
  const path = `/public/v${MB_API_VERSION}/class/removeclientfromclass`;
  const payload = {
    ClientId: opts.clientId,
    ClassId: opts.classId,
    VisitId: opts.visitId,
    SendEmail: false,
    Test: false,
  };
  let r = await fetchMb("POST", path, opts.consumerHeaders, payload);
  if (!r.ok && opts.staffHeaders) {
    r = await fetchMb("POST", path, opts.staffHeaders, payload);
  }
  return r;
}

/**
 * Mindbody sends the studio "Reservation for …" email only when `addclienttoclass`
 * runs with `SendEmail: true`. Deferred/staff paths book with `SendEmail: false` so
 * failed payment verify can roll back without a false confirmation — after verify
 * passes, remove the tentative visit and re-book once with email enabled.
 *
 * @param {{
 *   clientId: number;
 *   classId: number;
 *   visitId: number;
 *   clientServiceId: number;
 *   staffHeaders: Record<string, string>;
 *   bookHeaders: Record<string, string>;
 *   rollbackHeaders: Record<string, string>;
 * }} opts
 */
export async function rebookClassVisitWithConfirmationEmail(opts) {
  const remove = await rollbackBookedVisit({
    clientId: opts.clientId,
    classId: opts.classId,
    visitId: opts.visitId,
    consumerHeaders: opts.rollbackHeaders,
    staffHeaders: opts.staffHeaders,
  });
  if (!remove.ok) {
    return {
      ok: false,
      reason: "remove_before_email_rebook_failed",
      status: remove.status,
      mindbodyConfirmationEmail: false,
      visitId: opts.visitId,
    };
  }

  const path = `/public/v${MB_API_VERSION}/class/addclienttoclass`;
  /** @type {Record<string, unknown>} */
  const emailPayload = {
    ClientId: opts.clientId,
    ClassId: opts.classId,
    ClientServiceId: opts.clientServiceId,
    SendEmail: true,
    Waitlist: false,
    Test: false,
  };
  const r = await fetchMb("POST", path, opts.bookHeaders, emailPayload);
  if (r.ok) {
    return {
      ok: true,
      reason: "rebook_with_email_ok",
      visitId: extractVisitIdFromBookResponse(r.data, opts.classId) ?? opts.visitId,
      mindbodyConfirmationEmail: true,
    };
  }

  /** Email failed — restore the paid booking without email so the client keeps the spot. */
  const restore = await fetchMb("POST", path, opts.bookHeaders, {
    ...emailPayload,
    SendEmail: false,
  });
  const restoredVisitId = restore.ok
    ? extractVisitIdFromBookResponse(restore.data, opts.classId) ?? opts.visitId
    : opts.visitId;
  return {
    ok: false,
    reason: restore.ok ? "rebook_with_email_failed_restored" : "rebook_with_email_failed_restore_failed",
    status: r.status,
    restoreOk: restore.ok,
    visitId: restoredVisitId,
    mindbodyConfirmationEmail: false,
  };
}

/** @param {Record<string, unknown>} row */
export function visitIdFromRow(row) {
  const id = row.Id ?? row.id ?? row.VisitId ?? row.visitId;
  if (id != null && Number.isFinite(Number(id)) && Number(id) > 0) return Number(id);
  return null;
}

/** @param {Record<string, unknown> | null | undefined} clsRow */
export function classNameFromMindbodyClassRow(clsRow) {
  if (!clsRow || typeof clsRow !== "object") return "";
  const desc = clsRow.ClassDescription ?? clsRow.classDescription;
  if (desc && typeof desc === "object") {
    const d = /** @type {Record<string, unknown>} */ (desc);
    const nested = d.Name ?? d.name;
    if (typeof nested === "string" && nested.trim()) return nested.trim().slice(0, 160);
  }
  if (typeof desc === "string" && desc.trim()) return desc.trim().slice(0, 160);
  for (const key of ["ClassName", "className", "Name", "name"]) {
    const raw = clsRow[key];
    if (typeof raw === "string" && raw.trim()) return raw.trim().slice(0, 160);
  }
  return "";
}

/** @param {Record<string, unknown> | null | undefined} clsRow */
export function instructorFromMindbodyClassRow(clsRow) {
  if (!clsRow || typeof clsRow !== "object") return null;
  const staffRaw = clsRow.Staff ?? clsRow.staff ?? clsRow.Instructor ?? clsRow.instructor;
  /** @param {Record<string, unknown>} person */
  function personName(person) {
    const fn = typeof person.FirstName === "string" ? person.FirstName.trim() : "";
    const ln = typeof person.LastName === "string" ? person.LastName.trim() : "";
    const combined = `${fn} ${ln}`.trim();
    if (combined) return combined.slice(0, 120);
    for (const key of ["DisplayName", "displayName", "Name", "name"]) {
      const raw = person[key];
      if (typeof raw === "string" && raw.trim()) return raw.trim().slice(0, 120);
    }
    return null;
  }
  if (Array.isArray(staffRaw) && staffRaw[0] && typeof staffRaw[0] === "object") {
    return personName(/** @type {Record<string, unknown>} */ (staffRaw[0]));
  }
  if (staffRaw && typeof staffRaw === "object") {
    return personName(/** @type {Record<string, unknown>} */ (staffRaw));
  }
  for (const key of ["StaffName", "staffName", "InstructorName", "instructorName"]) {
    const raw = clsRow[key];
    if (typeof raw === "string" && raw.trim()) return raw.trim().slice(0, 120);
  }
  return null;
}

/** @param {Record<string, unknown> | null | undefined} clsRow */
export function startIsoFromMindbodyClassRow(clsRow) {
  if (!clsRow || typeof clsRow !== "object") return "";
  for (const key of ["StartDateTime", "startDateTime"]) {
    const raw = clsRow[key];
    if (typeof raw === "string" && raw.trim()) return raw.trim().slice(0, 40);
  }
  return "";
}

/**
 * Resolve confirmation email fields from Mindbody book response (authoritative) with optional client hints.
 *
 * @param {{
 *   bookData: unknown;
 *   classId: number;
 *   bodyClassName?: string;
 *   bodyStartIso?: string;
 *   bodyInstructor?: string;
 * }} opts
 */
export function resolveBookConfirmationEmailFields(opts) {
  const bodyClassName =
    typeof opts.bodyClassName === "string" && opts.bodyClassName.trim()
      ? opts.bodyClassName.trim().slice(0, 160)
      : undefined;
  const bodyStartIso =
    typeof opts.bodyStartIso === "string" && opts.bodyStartIso.trim()
      ? opts.bodyStartIso.trim().slice(0, 40)
      : undefined;
  const bodyInstructor =
    typeof opts.bodyInstructor === "string" && opts.bodyInstructor.trim()
      ? opts.bodyInstructor.trim().slice(0, 120)
      : undefined;

  let className = bodyClassName || "";
  let classStartIso = bodyStartIso || "";
  let instructor = bodyInstructor || null;

  if (opts.bookData && typeof opts.bookData === "object") {
    const d = /** @type {Record<string, unknown>} */ (opts.bookData);
    const cls =
      d.Class && typeof d.Class === "object"
        ? /** @type {Record<string, unknown>} */ (d.Class)
        : d.class && typeof d.class === "object"
          ? /** @type {Record<string, unknown>} */ (d.class)
          : null;
    if (!className) className = classNameFromMindbodyClassRow(cls);
    if (!classStartIso) classStartIso = startIsoFromMindbodyClassRow(cls);
    if (!instructor) instructor = instructorFromMindbodyClassRow(cls);
    for (const row of extractVisitRowsFromBookResponse(opts.bookData, opts.classId)) {
      const nestedClass =
        row.Class && typeof row.Class === "object"
          ? /** @type {Record<string, unknown>} */ (row.Class)
          : row.class && typeof row.class === "object"
            ? /** @type {Record<string, unknown>} */ (row.class)
            : null;
      if (!className) className = classNameFromMindbodyClassRow(nestedClass);
      if (!classStartIso) {
        const rowStart = row.StartDateTime ?? row.startDateTime;
        if (typeof rowStart === "string" && rowStart.trim()) classStartIso = rowStart.trim().slice(0, 40);
        else classStartIso = startIsoFromMindbodyClassRow(nestedClass);
      }
      if (!instructor) instructor = instructorFromMindbodyClassRow(nestedClass);
    }
  }

  return {
    className: className || "your class",
    classStartIso,
    instructor,
  };
}

/** @param {Record<string, unknown>} row */
export function visitClassIdFromRow(row) {
  const cls = row.Class ?? row.class;
  if (cls && typeof cls === "object") {
    const c = /** @type {Record<string, unknown>} */ (cls);
    const id = c.Id ?? c.id ?? c.ClassId ?? c.classId;
    if (id != null && Number.isFinite(Number(id)) && Number(id) > 0) return Number(id);
  }
  const raw = row.ClassId ?? row.classId;
  if (raw != null && Number.isFinite(Number(raw)) && Number(raw) > 0) return Number(raw);
  return null;
}

/** @param {Record<string, unknown>} row */
export function visitServiceIdFromRow(row) {
  const svc = row.Service ?? row.service;
  if (svc && typeof svc === "object") {
    const s = /** @type {Record<string, unknown>} */ (svc);
    const id = s.Id ?? s.id ?? s.ClientServiceId ?? s.clientServiceId;
    if (id != null && Number.isFinite(Number(id)) && Number(id) > 0) return Number(id);
  }
  const raw =
    row.ServiceId ??
    row.serviceId ??
    row.ClientServiceId ??
    row.clientServiceId;
  if (raw != null && Number.isFinite(Number(raw)) && Number(raw) > 0) return Number(raw);
  return null;
}

/** Milliseconds to wait before payment-verify retry attempts 2–4 (after attempt 1). */
export const PAYMENT_VERIFY_RETRY_WAIT_MS = [600, 900, 1000];

/**
 * Bounded retry is only for ambiguous `remaining_unchanged` when the visit looks paid
 * and the booked service matches the entitlement used for the book call.
 *
 * @param {Record<string, unknown> | null} visitRow
 * @param {number | null} usedServiceId
 */
export function isRemainingUnchangedRetryEligible(visitRow, usedServiceId) {
  if (!visitRow || visitRowLooksUnpaid(visitRow)) return false;
  if (usedServiceId == null || !Number.isFinite(usedServiceId) || usedServiceId <= 0) return false;
  const visitServiceId = visitServiceIdFromRow(visitRow);
  return visitServiceId != null && visitServiceId === usedServiceId;
}

/** @param {number} ms */
function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {number} clientId
 * @param {Record<string, string>} authHeaders
 */
export async function fetchClientVisitsWindow(clientId, authHeaders) {
  const visitStart = new Date();
  visitStart.setUTCDate(visitStart.getUTCDate() - 1);
  visitStart.setUTCHours(0, 0, 0, 0);
  const visitEnd = new Date();
  visitEnd.setUTCDate(visitEnd.getUTCDate() + 366);
  visitEnd.setUTCHours(23, 59, 59, 999);
  /** @type {Record<string, unknown>[]} */
  const merged = [];
  const seen = new Set();
  for (let offset = 0; offset < 300; offset += 100) {
    const q = new URLSearchParams({
      "request.clientId": String(clientId),
      "request.startDate": visitStart.toISOString(),
      "request.endDate": visitEnd.toISOString(),
      "request.limit": "100",
      "request.offset": String(offset),
    });
    const r = await fetchMb(
      "GET",
      `/public/v${MB_API_VERSION}/client/clientvisits?${q}`,
      authHeaders,
      null,
    );
    if (!r.ok) return { ok: false, visits: merged };
    for (const raw of visitsList(r.data)) {
      if (!raw || typeof raw !== "object") continue;
      const row = /** @type {Record<string, unknown>} */ (raw);
      const vid = visitIdFromRow(row);
      const key = vid != null ? `id:${vid}` : `row:${String(row.StartDateTime ?? "")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(row);
    }
    if (visitsList(r.data).length < 100) break;
  }
  return { ok: true, visits: merged };
}

/** @param {Record<string, unknown>[]} visits @param {number | null} visitId @param {number} classId */
export function findVisitRow(visits, visitId, classId) {
  if (visitId != null && visitId > 0) {
    for (const row of visits) {
      if (visitIdFromRow(row) === visitId) return row;
    }
  }
  for (const row of visits) {
    if (visitClassIdFromRow(row) === classId) return row;
  }
  return null;
}

/**
 * @param {Map<number, number>} beforeMap
 * @param {Map<number, number>} afterMap
 * @param {number[]} bookableIds
 * @param {number | null} usedServiceId
 */
export function anyBookableRemainingDecreased(beforeMap, afterMap, bookableIds, usedServiceId) {
  const ids =
    usedServiceId != null && bookableIds.includes(usedServiceId)
      ? [usedServiceId]
      : bookableIds;
  /** @type {number | null} */
  let snapshotId = null;
  /** @type {number | null} */
  let snapshotBefore = null;
  /** @type {number | null} */
  let snapshotAfter = null;
  for (const id of ids) {
    const before = beforeMap.get(id);
    const after = afterMap.get(id);
    if (before != null && snapshotBefore == null) {
      snapshotId = id;
      snapshotBefore = before;
      snapshotAfter = after ?? null;
    }
    if (before != null && after != null && after < before) {
      return { ok: true, id, before, after, exhausted: false };
    }
    /** Last credit: Mindbody omits ClientServices with Remaining=0 from active lists. */
    if (before === 1 && after == null) {
      return { ok: true, id, before, after: 0, exhausted: true };
    }
  }
  return { ok: false, id: snapshotId, before: snapshotBefore, after: snapshotAfter, exhausted: false };
}

/**
 * @param {{
 *   clientId: number;
 *   classId: number;
 *   visitId: number | null;
 *   usedServiceId: number | null;
 *   bookableIds: number[];
 *   beforeMap: Map<number, number>;
 *   bookResponseData: unknown;
 *   consumerHeaders: Record<string, string>;
 *   staffHeaders: Record<string, string> | null;
 *   attemptedStaffPaymentFallback: boolean;
 * }} opts
 */
export async function verifyBookPaymentApplied(opts) {
  const detail = {
    usedServiceId: opts.usedServiceId,
    visitId: opts.visitId,
    attemptedStaffPaymentFallback: opts.attemptedStaffPaymentFallback,
    bookableIds: opts.bookableIds,
  };

  if (bookResponseLooksUnpaid(opts.classId, opts.bookResponseData, opts.usedServiceId)) {
    return { ok: false, errorCode: /** @type {const} */ ("unpaid_visit_detected"), reason: "book_response_unpaid", detail };
  }

  let visitsResult = await fetchClientVisitsWindow(opts.clientId, opts.consumerHeaders);
  if (opts.staffHeaders && (!visitsResult.ok || visitsResult.visits.length === 0)) {
    const staffVisits = await fetchClientVisitsWindow(opts.clientId, opts.staffHeaders);
    if (staffVisits.ok) visitsResult = staffVisits;
  }

  /** @type {Record<string, unknown> | null} */
  const visitRow = visitsResult.ok
    ? findVisitRow(visitsResult.visits, opts.visitId, opts.classId)
    : null;
  detail.visitFound = visitRow != null;
  if (visitRow && visitRowLooksUnpaid(visitRow)) {
    return { ok: false, errorCode: /** @type {const} */ ("unpaid_visit_detected"), reason: "clientvisits_unpaid", detail };
  }

  const retryEligible = isRemainingUnchangedRetryEligible(visitRow, opts.usedServiceId);
  /** @type {ReturnType<typeof anyBookableRemainingDecreased> | null} */
  let remCheck = null;
  /** @type {Map<number, number>} */
  let lastAfterMap = new Map();
  const maxAttempts = retryEligible ? 1 + PAYMENT_VERIFY_RETRY_WAIT_MS.length : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 1) {
      await sleepMs(PAYMENT_VERIFY_RETRY_WAIT_MS[attempt - 2]);
      console.log(
        JSON.stringify({
          event: "class_book_payment_verify_retry",
          classId: opts.classId,
          clientId: opts.clientId,
          visitId: opts.visitId,
          usedServiceId: opts.usedServiceId,
          attempt,
          maxAttempts,
          waitMs: PAYMENT_VERIFY_RETRY_WAIT_MS[attempt - 2],
        }),
      );
    }

    lastAfterMap = await fetchMergedClientServiceRemainingMap(
      opts.clientId,
      opts.consumerHeaders,
      opts.staffHeaders,
    );
    remCheck = anyBookableRemainingDecreased(
      opts.beforeMap,
      lastAfterMap,
      opts.bookableIds,
      opts.usedServiceId,
    );
    detail.remainingBefore = remCheck.before;
    detail.remainingAfter = remCheck.after;
    detail.remainingServiceId = remCheck.id;
    detail.remainingDecreased = remCheck.ok;
    detail.remainingExhausted = remCheck.exhausted === true;
    detail.verifyAttempt = attempt;
    detail.verifyMaxAttempts = maxAttempts;

    if (remCheck.ok) {
      if (attempt > 1) {
        console.log(
          JSON.stringify({
            event: "class_book_payment_verify_final",
            classId: opts.classId,
            clientId: opts.clientId,
            visitId: opts.visitId,
            usedServiceId: opts.usedServiceId,
            attempt,
            maxAttempts,
            outcome: "success_after_retry",
            verifyReason: remCheck.exhausted ? "remaining_exhausted" : "remaining_decreased",
            remainingBefore: remCheck.before,
            remainingAfter: remCheck.after,
          }),
        );
      }
      return {
        ok: true,
        reason: remCheck.exhausted ? "remaining_exhausted" : "remaining_decreased",
        detail,
      };
    }

    if (!retryEligible || attempt >= maxAttempts) break;
  }

  /** Paid visit but Remaining unchanged (e.g. 5→5) — staff roster without credit (snir5). */
  if (visitRow && !visitRowLooksUnpaid(visitRow)) {
    for (const id of opts.bookableIds) {
      const before = opts.beforeMap.get(id);
      const after = lastAfterMap.get(id);
      if (before != null && after != null && after === before) {
        detail.remainingUnchangedId = id;
        break;
      }
    }
  }

  const failureReason = visitRow ? "remaining_unchanged" : "no_remaining_or_visit_proof";
  if (retryEligible) {
    console.warn(
      JSON.stringify({
        event: "class_book_payment_verify_final",
        classId: opts.classId,
        clientId: opts.clientId,
        visitId: opts.visitId,
        usedServiceId: opts.usedServiceId,
        attempt: maxAttempts,
        maxAttempts,
        outcome: "failed_after_retry",
        verifyReason: failureReason,
        remainingBefore: remCheck?.before ?? null,
        remainingAfter: remCheck?.after ?? null,
      }),
    );
  }

  return {
    ok: false,
    errorCode: /** @type {const} */ ("payment_not_applied"),
    reason: failureReason,
    detail,
  };
}

/**
 * @param {{
 *   classId: number;
 *   clientId: number;
 *   visitId: number | null;
 *   verify: { ok: boolean; errorCode?: string; reason?: string; detail?: Record<string, unknown> };
 *   consumerHeaders: Record<string, string>;
 *   staffHeaders: Record<string, string> | null;
 *   cookieHdr: Record<string, string | string[]>;
 * }} opts
 */
export async function rollbackFailedPaymentBooking(opts) {
  const errorCode =
    opts.verify.errorCode === "unpaid_visit_detected" ? "unpaid_visit_detected" : "payment_not_applied";

  if (errorCode === "unpaid_visit_detected") {
    console.warn(
      JSON.stringify({
        event: "class_book_unpaid_visit_detected",
        classId: opts.classId,
        clientId: opts.clientId,
        visitId: opts.visitId,
        verifyReason: opts.verify.reason ?? null,
        ...(opts.verify.detail ?? {}),
      }),
    );
  }

  if (opts.visitId != null && opts.visitId > 0) {
    console.warn(
      JSON.stringify({
        event: "class_book_payment_rollback_start",
        classId: opts.classId,
        clientId: opts.clientId,
        visitId: opts.visitId,
        errorCode,
      }),
    );
    const rollback = await rollbackBookedVisit({
      clientId: opts.clientId,
      classId: opts.classId,
      visitId: opts.visitId,
      consumerHeaders: opts.consumerHeaders,
      staffHeaders: opts.staffHeaders,
    });
    console.warn(
      JSON.stringify({
        event: "class_book_payment_rollback_result",
        classId: opts.classId,
        clientId: opts.clientId,
        visitId: opts.visitId,
        errorCode,
        rollbackOk: rollback.ok,
        rollbackStatus: rollback.status,
      }),
    );
  }

  return paymentVerificationFailedResponse(opts.cookieHdr, errorCode, {
    clientId: opts.clientId,
    verifyReason: opts.verify.reason ?? null,
    paymentVerified: false,
    hasBookableCredits: true,
  });
}

/**
 * @param {unknown} data
 * @param {number} classId
 * @returns {number | null}
 */
export function extractWaitlistEntryIdFromBookResponse(data, classId) {
  if (!data || typeof data !== "object") return null;
  const d = /** @type {Record<string, unknown>} */ (data);

  /** @param {unknown} row */
  function pickId(row) {
    if (!row || typeof row !== "object") return null;
    const o = /** @type {Record<string, unknown>} */ (row);
    const id = o.Id ?? o.id ?? o.WaitlistEntryId ?? o.waitlistEntryId;
    if (id != null && Number.isFinite(Number(id)) && Number(id) > 0) return Number(id);
    return null;
  }

  for (const k of ["WaitlistEntry", "waitlistEntry"]) {
    const id = pickId(d[k]);
    if (id != null) return id;
  }

  const wrappedClass =
    d.Class && typeof d.Class === "object"
      ? /** @type {Record<string, unknown>} */ (d.Class)
      : d.class && typeof d.class === "object"
        ? /** @type {Record<string, unknown>} */ (d.class)
        : null;
  if (wrappedClass) {
    for (const k of ["WaitlistEntry", "waitlistEntry"]) {
      const id = pickId(wrappedClass[k]);
      if (id != null) return id;
    }
    const visitsRaw = wrappedClass.Visits ?? wrappedClass.visits;
    if (Array.isArray(visitsRaw)) {
      for (const row of visitsRaw) {
        const id = pickId(row);
        if (id != null) return id;
      }
    }
  }

  const entries = d.WaitlistEntries ?? d.waitlistEntries;
  if (Array.isArray(entries)) {
    for (const row of entries) {
      const o = row && typeof row === "object" ? /** @type {Record<string, unknown>} */ (row) : null;
      if (!o) continue;
      const cid = o.ClassId ?? o.classId;
      if (cid != null && Number.isFinite(Number(cid)) && Number(cid) !== classId) continue;
      const id = pickId(o);
      if (id != null) return id;
    }
  }

  return null;
}

/**
 * Live authoritative gate immediately before staff `AddClientToClass` with `Waitlist: false`.
 * Skips waitlist bookings — callers must not invoke for `waitlist: true`.
 *
 * @param {Record<string, string>} staffHeaders
 * @param {number} classId
 * @param {{
 *   waitlist?: boolean;
 *   startDateTime?: string;
 *   clientId?: number;
 *   authSource?: string | null;
 *   authMode?: string;
 *   bookingPath?: string;
 *   prefetchedRow?: Record<string, unknown> | null;
 * }} opts
 */
export async function assertStaffNormalSeatBeforeBook(staffHeaders, classId, opts = {}) {
  if (opts.waitlist === true) {
    return { ok: true, skipped: true };
  }
  if (!staffHeaders) {
    return {
      ok: false,
      reason: "capacity_fetch_failed",
      waitlistAvailable: false,
      maxCapacity: null,
      totalBooked: null,
      spotsRemaining: null,
    };
  }

  /** @type {Record<string, unknown> | null} */
  let classRow = opts.prefetchedRow ?? null;
  if (!classRow) {
    const fetched = await fetchClassRowForCapacity(staffHeaders, classId, {
      startDateTime: opts.startDateTime,
    });
    if (!fetched.ok || !fetched.row) {
      return {
        ok: false,
        reason: "capacity_fetch_failed",
        waitlistAvailable: false,
        maxCapacity: null,
        totalBooked: null,
        spotsRemaining: null,
      };
    }
    classRow = fetched.row;
  }

  const snapshot = parseClassCapacitySnapshot(classRow);
  const verdict = evaluateStaffNormalSeatBooking(snapshot);
  if (!verdict.ok) {
    const blockReason =
      verdict.reason === "capacity_unavailable" ? "capacity_fetch_failed" : verdict.reason;
    console.warn(
      JSON.stringify({
        event: "class_book_capacity_blocked",
        classId,
        clientId: opts.clientId ?? null,
        authSource: opts.authSource ?? null,
        authMode: opts.authMode ?? "staff",
        waitlist: false,
        bookingPath: opts.bookingPath ?? null,
        maxCapacity: verdict.maxCapacity ?? null,
        totalBooked: verdict.totalBooked ?? null,
        waitlistAvailable: verdict.waitlistAvailable ?? false,
        blockReason,
      }),
    );
    return { ...verdict, reason: blockReason };
  }
  return { ok: true, ...snapshot };
}

/**
 * @param {Extract<Awaited<ReturnType<typeof assertStaffNormalSeatBeforeBook>>, { ok: false }>} blocked
 */
export function classBookCapacityBlockedBody(blocked) {
  if (blocked.reason === "capacity_fetch_failed") {
    return {
      ok: false,
      error: "capacity_check_failed",
      reason: "capacity_fetch_failed",
      message:
        "We couldn't verify class availability right now. Please refresh the schedule and try again.",
    };
  }
  return {
    ok: false,
    error: "class_full",
    reason: "class_full",
    waitlistAvailable: blocked.waitlistAvailable === true,
    maxCapacity: blocked.maxCapacity,
    totalBooked: blocked.totalBooked,
    message: blocked.waitlistAvailable
      ? "This class is full. Join the waitlist if you'd like to be notified when a spot opens."
      : "This class is full. Please choose another time.",
  };
}

/** @param {unknown} value @returns {string | null} */
export function normalizeBookingConfirmationEmail(value) {
  if (typeof value !== "string" || !value.includes("@")) return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/**
 * Read-only Mindbody client email for an already-resolved Studio clientId.
 *
 * @param {number} clientId
 * @param {Record<string, string>} authHeaders
 */
export async function fetchMindbodyClientEmailById(clientId, authHeaders) {
  if (!Number.isFinite(clientId) || clientId <= 0 || !authHeaders) return null;
  const q = new URLSearchParams({ ClientIds: String(Math.trunc(clientId)) });
  const r = await fetchMb("GET", `/public/v${MB_API_VERSION}/client/clients?${q}`, authHeaders, null);
  if (!r.ok) return null;
  const row = (r.data?.Clients || r.data?.clients || [])[0];
  if (!row || typeof row !== "object") return null;
  const o = /** @type {Record<string, unknown>} */ (row);
  return normalizeBookingConfirmationEmail(String(o.Email ?? o.email ?? ""));
}

/**
 * Resolve the booked member's confirmation email without trusting request-body email.
 *
 * Priority:
 * 1. AMARÉ session email when linked to the same resolved clientId
 * 2. Mindbody consumer OAuth email
 * 3. Read-only Mindbody client lookup by clientId
 *
 * @param {{
 *   clientId: number;
 *   amareUserId?: string | null;
 *   amareLinkedClientId?: number | null;
 *   amareSessionEmail?: string | null;
 *   consumerEmail?: string | null;
 *   lookupMindbodyClientEmail?: ((clientId: number) => Promise<string | null>) | null;
 * }} opts
 * @returns {Promise<{ email: string | null; source: string | null }>}
 */
export async function resolveBookingConfirmationRecipient(opts) {
  const clientId = Number(opts.clientId);
  if (!Number.isFinite(clientId) || clientId <= 0) {
    return { email: null, source: null };
  }

  const linkedId =
    opts.amareLinkedClientId != null && Number.isFinite(Number(opts.amareLinkedClientId))
      ? Number(opts.amareLinkedClientId)
      : null;
  const amareLinkedToClient = linkedId != null && linkedId > 0 && linkedId === clientId;

  if (amareLinkedToClient) {
    const amareEmail = normalizeBookingConfirmationEmail(opts.amareSessionEmail);
    if (amareEmail) return { email: amareEmail, source: "amare_session" };
  }

  const oauthEmail = normalizeBookingConfirmationEmail(opts.consumerEmail);
  if (oauthEmail) return { email: oauthEmail, source: "consumer_oauth" };

  if (typeof opts.lookupMindbodyClientEmail === "function") {
    const looked = normalizeBookingConfirmationEmail(await opts.lookupMindbodyClientEmail(clientId));
    if (looked) return { email: looked, source: "mindbody_client" };
  }

  return { email: null, source: null };
}

