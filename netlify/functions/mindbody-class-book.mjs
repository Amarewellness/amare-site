import {
  MB_API_VERSION,
  fetchMb,
  jsonResponse,
  resolveConsumerClient,
  consumerAuthExtraHeaders,
  resolveSessionStudioLinkFlags,
  getMindbodyStaffAccessTokenCached,
  visitsList,
} from "./mindbody-consumer-lib.mjs";
import { mindbodyStaffApiHeaders, mindbodyStaffBearerHeaders } from "./mindbody-upstream.mjs";
import { withMobileCorsHandler } from "./mobile-api-cors.mjs";

function parseJsonBody(event) {
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

/**
 * @param {Record<string, unknown>} s
 * @returns {number | null}
 */
function clientServiceRemainingFromRow(s) {
  const rem = s.Remaining ?? s.remaining;
  if (typeof rem === "number" && Number.isFinite(rem)) return rem;
  if (rem != null && rem !== "" && Number.isFinite(Number(rem))) return Number(rem);
  return null;
}

/**
 * @param {Record<string, unknown>} s
 * @returns {number | null}
 */
function clientServiceIdFromRow(s) {
  const sid = s.Id ?? s.id;
  if (typeof sid === "number" && Number.isFinite(sid) && sid > 0) return Math.trunc(sid);
  if (typeof sid === "string" && /^\d+$/.test(sid.trim())) return parseInt(sid.trim(), 10);
  return null;
}

/**
 * @returns {Promise<number[]>} Active ClientService ids with visits left, highest remaining first.
 */
async function listActiveClientServiceIds(clientId, authHeaders) {
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
async function listBookableClientServiceIds(clientId, consumerHeaders, staffHeaders) {
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
async function fetchClientServiceRemainingMap(clientId, authHeaders) {
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
function mergeRemainingMaps(consumerMap, staffMap) {
  const merged = new Map(consumerMap);
  for (const [id, rem] of staffMap) {
    const cur = merged.get(id);
    if (cur == null || rem < cur) merged.set(id, rem);
  }
  return merged;
}

async function fetchMergedClientServiceRemainingMap(clientId, consumerHeaders, staffHeaders) {
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
function summarizeMindbodyBookError(data) {
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
function isPaymentRequiredError(summary) {
  if (!summary) return false;
  const blob = `${summary.code ?? ""} ${summary.message ?? ""}`;
  return (
    /ClassRequiresPayment/i.test(blob) ||
    /\bno available payments?\b/i.test(blob) ||
    /\bhas no available payments?\b/i.test(blob)
  );
}

const NO_BOOKABLE_CREDITS_MESSAGE =
  "You don't have class credits or a package that applies to this class. Buy a drop-in, class pack, or membership first — then come back and book.";

/**
 * @param {Record<string, string | string[]>} [cookieHdr]
 * @param {Record<string, unknown>} [extra]
 */
function noBookableCreditsResponse(cookieHdr, extra = {}) {
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
function paymentVerificationFailedResponse(cookieHdr, errorCode, extra = {}) {
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

async function resolveStaffAuthHeaders() {
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
function extractVisitIdFromBookResponse(data, classId) {
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
function extractVisitRowsFromBookResponse(data, classId) {
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
function visitRowLooksUnpaid(row) {
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
function bookResponseLooksUnpaid(classId, data, clientServiceIdUsed) {
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
async function rollbackBookedVisit(opts) {
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

/** @param {Record<string, unknown>} row */
function visitIdFromRow(row) {
  const id = row.Id ?? row.id ?? row.VisitId ?? row.visitId;
  if (id != null && Number.isFinite(Number(id)) && Number(id) > 0) return Number(id);
  return null;
}

/** @param {Record<string, unknown>} row */
function visitClassIdFromRow(row) {
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
async function fetchClientVisitsWindow(clientId, authHeaders) {
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
function findVisitRow(visits, visitId, classId) {
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
function anyBookableRemainingDecreased(beforeMap, afterMap, bookableIds, usedServiceId) {
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
async function verifyBookPaymentApplied(opts) {
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
async function rollbackFailedPaymentBooking(opts) {
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
function extractWaitlistEntryIdFromBookResponse(data, classId) {
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

async function classBookHandler(event) {
  if (event.httpMethod !== "POST") {
    console.warn(JSON.stringify({ event: "class_book_method_not_allowed", httpMethod: event.httpMethod }));
    return jsonResponse(405, { ok: false, error: "method_not_allowed" });
  }

  const body = parseJsonBody(event);
  if (body === null) {
    console.warn(JSON.stringify({ event: "class_book_invalid_json" }));
    return jsonResponse(400, { ok: false, error: "invalid_json" });
  }

  const classIdRaw = body.classId ?? body.ClassId;
  const classId =
    typeof classIdRaw === "number" ? classIdRaw : typeof classIdRaw === "string" ? parseInt(classIdRaw, 10) : NaN;
  if (!Number.isFinite(classId) || classId <= 0) {
    console.warn(JSON.stringify({ event: "class_book_missing_class_id", classIdRaw }));
    return jsonResponse(400, { ok: false, error: "missing_class_id" });
  }

  const svcRaw = body.clientServiceId ?? body.ClientServiceId;
  let clientServiceId =
    typeof svcRaw === "number"
      ? svcRaw
      : typeof svcRaw === "string" && svcRaw.trim()
        ? parseInt(svcRaw, 10)
        : null;
  if (clientServiceId != null && !Number.isFinite(clientServiceId)) clientServiceId = null;

  const waitlistRaw = body.waitlist ?? body.Waitlist;
  const waitlist =
    waitlistRaw === true || waitlistRaw === "true" || waitlistRaw === 1 || waitlistRaw === "1";

  console.log(
    JSON.stringify({
      event: "class_book_request",
      classId,
      clientServiceIdProvided: clientServiceId,
      waitlist,
    }),
  );

  const ctx = await resolveConsumerClient(event);
  if (!ctx.ok) {
    /**
     * Resolution failures are logged in detail by `resolveConsumerClient` itself
     * (`consumer_resolve_client_not_linked` / `not_authenticated` / `token_refresh_failed`).
     * Re-emit a slim correlation log so the booking attempt is traceable end-to-end.
     */
    const status = typeof ctx.response.statusCode === "number" ? ctx.response.statusCode : 500;
    console.warn(
      JSON.stringify({
        event: "class_book_resolve_failed",
        classId,
        status,
      }),
    );
    return ctx.response;
  }

  console.log(
    JSON.stringify({
      event: "class_book_resolved_client",
      classId,
      clientId: ctx.clientId,
      email: ctx.email,
    }),
  );

  const link = await resolveSessionStudioLinkFlags(ctx.session, ctx.authHeaders);
  if (!link.bookingAllowed) {
    console.warn(
      JSON.stringify({
        event: "class_book_studio_not_linked",
        classId,
        clientId: ctx.clientId,
        email: ctx.email,
        linkStatus: link.linkStatus,
        consumerAssociated: link.consumerAssociated,
      }),
    );
    const cookieHdr = consumerAuthExtraHeaders(ctx);
    return jsonResponse(
      403,
      {
        ok: false,
        error: "studio_not_linked",
        message:
          "Your Mindbody account is connected, but it is not fully linked to AMARÉ yet. Please contact the studio and we can connect your account or book the class for you.",
        linkStatus: link.linkStatus,
        clientId: ctx.clientId,
        consumerAssociated: link.consumerAssociated,
        bookingAllowed: false,
      },
      cookieHdr,
    );
  }

  const v = MB_API_VERSION;
  const path = `/public/v${v}/class/addclienttoclass`;

  /** @param {Record<string, string>} authHeaders @param {number | null} cs @param {"consumer" | "staff"} authMode @param {boolean} [sendEmail] */
  async function tryBookWith(authHeaders, cs, authMode, sendEmail = authMode === "consumer") {
    /** @type {Record<string, unknown>} */
    const payload = {
      ClientId: ctx.clientId,
      ClassId: classId,
      SendEmail: sendEmail,
      Waitlist: waitlist,
      Test: false,
    };
    /** Production never sent RequirePayment — Mindbody applies credits/membership without a card on file. */
    if (cs != null) payload.ClientServiceId = cs;
    console.log(
      JSON.stringify({
        event: "class_book_addclienttoclass_attempt",
        classId,
        clientId: ctx.clientId,
        authMode,
        clientServiceId: cs,
        requirePayment: false,
        sendEmail,
      }),
    );
    return fetchMb("POST", path, authHeaders, payload);
  }

  const staffHeadersForBook = await resolveStaffAuthHeaders();
  const { bookableIds, consumerIds, staffIds } = await listBookableClientServiceIds(
    ctx.clientId,
    ctx.authHeaders,
    staffHeadersForBook,
  );

  const beforeRemainingMap = await fetchMergedClientServiceRemainingMap(
    ctx.clientId,
    ctx.authHeaders,
    staffHeadersForBook,
  );
  console.log(
    JSON.stringify({
      event: "class_book_entitlement_before",
      classId,
      clientId: ctx.clientId,
      bookableIds,
      consumerIds,
      staffIds,
      services: bookableIds.map((id) => ({
        clientServiceId: id,
        remaining: beforeRemainingMap.get(id) ?? null,
      })),
    }),
  );

  const hasEntitlement =
    bookableIds.length > 0 ||
    (clientServiceId != null && bookableIds.includes(clientServiceId));

  if (!hasEntitlement) {
    console.warn(
      JSON.stringify({
        event: "class_book_no_bookable_credits",
        classId,
        clientId: ctx.clientId,
        email: ctx.email,
        consumerActiveServiceCount: consumerIds.length,
        staffActiveServiceCount: staffIds.length,
        clientServiceIdProvided: clientServiceId,
      }),
    );
    const cookieHdr = consumerAuthExtraHeaders(ctx);
    return noBookableCreditsResponse(cookieHdr, {
      clientId: ctx.clientId,
      activeClientServiceCount: bookableIds.length,
      consumerActiveServiceCount: consumerIds.length,
      staffActiveServiceCount: staffIds.length,
    });
  }

  const explicitServiceId =
    clientServiceId != null && bookableIds.includes(clientServiceId) ? clientServiceId : null;

  let attemptedClientServiceFallback = false;
  let attemptedStaffPaymentFallback = false;
  /** @type {number[]} */
  let triedServiceIds = [];
  /** @type {number | null} */
  let usedServiceId = null;

  /**
   * Production parity: consumer first without ClientServiceId (Mindbody may auto-apply payment).
   * Phase 1.2 keeps explicit body ClientServiceId when provided.
   */
  let r =
    explicitServiceId != null
      ? await tryBookWith(ctx.authHeaders, explicitServiceId, "consumer")
      : await tryBookWith(ctx.authHeaders, null, "consumer");
  if (explicitServiceId != null) {
    usedServiceId = explicitServiceId;
    triedServiceIds.push(explicitServiceId);
  }

  if (!r.ok) {
    const consumerIdsToTry = consumerIds.length > 0 ? consumerIds : bookableIds;
    for (const picked of consumerIdsToTry) {
      if (usedServiceId === picked) continue;
      attemptedClientServiceFallback = true;
      triedServiceIds.push(picked);
      console.log(
        JSON.stringify({
          event: "class_book_client_service_fallback_try",
          classId,
          clientId: ctx.clientId,
          clientServiceId: picked,
        }),
      );
      r = await tryBookWith(ctx.authHeaders, picked, "consumer");
      if (r.ok) {
        usedServiceId = picked;
        break;
      }
    }
  }

  let summary = summarizeMindbodyBookError(r.data);
  if (!r.ok && isPaymentRequiredError(summary)) {
    /**
     * Production retried with staff + ClientServiceId on payment errors (never without CS).
     * Post-book verification rolls back if staff creates an Unpaid Visit or skips credit consumption.
     */
    if (staffHeadersForBook && bookableIds.length > 0) {
      attemptedStaffPaymentFallback = true;
      const idsToTry =
        triedServiceIds.length > 0
          ? [...new Set([...triedServiceIds, ...bookableIds])]
          : bookableIds;

      console.log(
        JSON.stringify({
          event: "class_book_staff_payment_fallback_start",
          classId,
          clientId: ctx.clientId,
          serviceIds: idsToTry,
          reason: "payment_required_after_consumer",
          consumerTriedServiceIds: triedServiceIds,
        }),
      );

      for (const picked of idsToTry) {
        if (picked == null) continue;
        /** Tentative roster — no Mindbody email until post-book payment verification passes. */
        r = await tryBookWith(staffHeadersForBook, picked, "staff", false);
        if (r.ok) {
          usedServiceId = picked;
          if (!triedServiceIds.includes(picked)) triedServiceIds.push(picked);
          console.log(
            JSON.stringify({
              event: "class_book_staff_payment_fallback_ok",
              classId,
              clientId: ctx.clientId,
              clientServiceId: picked,
            }),
          );
          break;
        }
      }
      summary = summarizeMindbodyBookError(r.data);
    } else if (staffHeadersForBook && bookableIds.length === 0) {
      /** Emergency guard: never staff-book without a ClientServiceId (Unpaid Visit). */
      console.warn(
        JSON.stringify({
          event: "class_book_staff_fallback_blocked",
          reason: "no_bookable_client_service_ids",
          classId,
          clientId: ctx.clientId,
          serviceIds: [],
        }),
      );
      const cookieHdr = consumerAuthExtraHeaders(ctx);
      return noBookableCreditsResponse(cookieHdr, {
        clientId: ctx.clientId,
        mindbodyMessage: summary?.message ?? null,
      });
    }

    if (!r.ok) {
      const cookieHdr = consumerAuthExtraHeaders(ctx);
      if (bookableIds.length === 0) {
        return noBookableCreditsResponse(cookieHdr, {
          clientId: ctx.clientId,
          mindbodyMessage: summary?.message ?? null,
        });
      }
      return paymentVerificationFailedResponse(cookieHdr, "payment_not_applied", {
        clientId: ctx.clientId,
        hasBookableCredits: true,
        mindbodyMessage: summary?.message ?? null,
        consumerIdsVisible: consumerIds.length,
        staffFallbackAttempted: attemptedStaffPaymentFallback,
        mindbody: r.data,
        status: r.status,
      });
    }
  }

  let visitId = r.ok && !waitlist ? extractVisitIdFromBookResponse(r.data, classId) : null;
  const waitlistEntryId =
    r.ok && waitlist ? extractWaitlistEntryIdFromBookResponse(r.data, classId) : null;

  /** @type {boolean | null} */
  let paymentVerified = waitlist ? null : false;

  if (r.ok && !waitlist) {
    console.log(
      JSON.stringify({
        event: "class_book_payment_verify_start",
        classId,
        clientId: ctx.clientId,
        visitId,
        usedServiceId,
        attemptedStaffPaymentFallback,
      }),
    );
    const verify = await verifyBookPaymentApplied({
      clientId: ctx.clientId,
      classId,
      visitId,
      usedServiceId,
      bookableIds,
      beforeMap: beforeRemainingMap,
      bookResponseData: r.data,
      consumerHeaders: ctx.authHeaders,
      staffHeaders: staffHeadersForBook,
      attemptedStaffPaymentFallback,
    });
    console.log(
      JSON.stringify({
        event: "class_book_payment_verify_result",
        classId,
        clientId: ctx.clientId,
        visitId,
        paymentVerified: verify.ok,
        verifyReason: verify.reason ?? null,
        ...(verify.detail ?? {}),
      }),
    );
    if (!verify.ok) {
      const cookieHdr = consumerAuthExtraHeaders(ctx);
      return rollbackFailedPaymentBooking({
        classId,
        clientId: ctx.clientId,
        visitId,
        verify,
        consumerHeaders: ctx.authHeaders,
        staffHeaders: staffHeadersForBook,
        cookieHdr,
      });
    }
    paymentVerified = true;
    console.log(
      JSON.stringify({
        event: "class_book_payment_verified",
        classId,
        clientId: ctx.clientId,
        visitId,
        usedServiceId,
        attemptedStaffPaymentFallback,
        verifyReason: verify.reason ?? null,
        mindbodyConfirmationEmail:
          attemptedStaffPaymentFallback === true ? false : true,
      }),
    );
  } else if (r.ok && waitlist) {
    paymentVerified = null;
  }

  console.log(
    JSON.stringify({
      event: "class_book_response",
      classId,
      clientId: ctx.clientId,
      ok: r.ok,
      status: r.status,
      waitlist,
      attemptedClientServiceFallback,
      attemptedStaffPaymentFallback,
      triedServiceIds,
      visitIdReturned: visitId,
      waitlistEntryIdReturned: waitlistEntryId,
      paymentVerified,
      mindbodyErrorMessage: summary?.message ?? null,
      mindbodyErrorCode: summary?.code ?? null,
    }),
  );

  const cookieHdr = consumerAuthExtraHeaders(ctx);
  return jsonResponse(
    r.ok ? 200 : r.status,
    {
      ok: r.ok,
      status: r.status,
      mindbody: r.data,
      /**
       * Surfacing visitId at the top level lets the schedule page flip the slot to
       * "Cancel booking" instantly off this single response — no second round-trip
       * to `/api/mindbody/member/summary`. When extraction misses (older Mindbody
       * payload shape), the field is `null` and the client falls back to refresh.
       */
      ...(r.ok
        ? {
            visitId,
            waitlistEntryId,
            onWaitlist: waitlist,
            classId,
            paymentVerified,
            mindbodyConfirmationEmail:
              attemptedStaffPaymentFallback === true ? false : true,
          }
        : {
            error: "mindbody_book_failed",
            ...(summary && isPaymentRequiredError(summary)
              ? { suggestPackages: true, message: NO_BOOKABLE_CREDITS_MESSAGE }
              : {}),
          }),
    },
    cookieHdr,
  );
}

export const handler = withMobileCorsHandler(classBookHandler);
