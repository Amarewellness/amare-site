import {
  MB_API_VERSION,
  fetchMb,
  getMindbodyStaffAccessTokenCached,
  visitsList,
  jsonResponse,
} from "./mindbody-consumer-lib.mjs";
import { mindbodyStaffApiHeaders, mindbodyStaffBearerHeaders } from "./mindbody-upstream.mjs";

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
  return jsonResponse(
    402,
    {
      ok: false,
      error: errorCode,
      /** Only steer to Pricing when the member truly has no bookable credits. */
      suggestPackages: errorCode === "no_bookable_credits" || (extra.suggestPackages === true && !hasCredits),
      message: errorCode === "unpaid_visit_detected" ? UNPAID_VISIT_MESSAGE : PAYMENT_NOT_APPLIED_MESSAGE,
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

  const afterMap = await fetchMergedClientServiceRemainingMap(
    opts.clientId,
    opts.consumerHeaders,
    opts.staffHeaders,
  );
  const remCheck = anyBookableRemainingDecreased(
    opts.beforeMap,
    afterMap,
    opts.bookableIds,
    opts.usedServiceId,
  );
  detail.remainingBefore = remCheck.before;
  detail.remainingAfter = remCheck.after;
  detail.remainingServiceId = remCheck.id;
  detail.remainingDecreased = remCheck.ok;
  detail.remainingExhausted = remCheck.exhausted === true;

  if (remCheck.ok) {
    return {
      ok: true,
      reason: remCheck.exhausted ? "remaining_exhausted" : "remaining_decreased",
      detail,
    };
  }

  /** Paid visit but Remaining unchanged (e.g. 5→5) — staff roster without credit (snir5). */
  if (visitRow && !visitRowLooksUnpaid(visitRow)) {
    for (const id of opts.bookableIds) {
      const before = opts.beforeMap.get(id);
      const after = afterMap.get(id);
      if (before != null && after != null && after === before) {
        detail.remainingUnchangedId = id;
        break;
      }
    }
  }

  return {
    ok: false,
    errorCode: /** @type {const} */ ("payment_not_applied"),
    reason: visitRow ? "remaining_unchanged" : "no_remaining_or_visit_proof",
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

