import {
  fetchMb,
  getMindbodyStaffAccessTokenCached,
  jsonResponse,
  resolveConsumerClient,
  MB_API_VERSION,
} from "./mindbody-consumer-lib.mjs";
import { mindbodyStaffApiHeaders, mindbodyStaffBearerHeaders } from "./mindbody-upstream.mjs";

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
 * Pull `LateCancelled` from the Mindbody `removeclientfromclass` payload so the
 * dialog can switch its "you've been cancelled" copy to a friendlier message
 * acknowledging the studio's 12-hour policy + thanking the user for freeing
 * the spot. Mindbody nests the visit one of several ways depending on site
 * config — accept all known shapes, return `null` when unknown so the frontend
 * can fall back to its own clock-based heuristic.
 *
 * @param {unknown} data
 * @param {number} classId
 * @returns {boolean | null}
 */
function extractLateCancelledFromMindbody(data, classId) {
  if (!data || typeof data !== "object") return null;
  const d = /** @type {Record<string, unknown>} */ (data);

  /** @param {unknown} row */
  function readLate(row) {
    if (!row || typeof row !== "object") return null;
    const v = /** @type {Record<string, unknown>} */ (row);
    const raw = v.LateCancelled ?? v.lateCancelled ?? v.LateCancel ?? v.lateCancel;
    if (typeof raw === "boolean") return raw;
    return null;
  }

  /** @param {unknown} row */
  function visitMatchesClass(row) {
    if (!row || typeof row !== "object") return true;
    const v = /** @type {Record<string, unknown>} */ (row);
    const cid = v.ClassId ?? v.classId;
    if (cid == null) return true;
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
        if (visitMatchesClass(row)) {
          const v = readLate(row);
          if (v != null) return v;
        }
      }
      for (const row of visitsRaw) {
        const v = readLate(row);
        if (v != null) return v;
      }
    }
  }

  for (const k of ["Visit", "visit", "ClassVisit", "classVisit"]) {
    const v = readLate(d[k]);
    if (v != null) return v;
  }

  return readLate(d);
}

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: { "Cache-Control": "no-store" }, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" });
  }

  const body = parseJsonBody(event);
  if (body === null) {
    return jsonResponse(400, { ok: false, error: "invalid_json" });
  }

  const classIdRaw = body.classId ?? body.ClassId;
  const visitIdRaw = body.visitId ?? body.VisitId;

  const classId =
    typeof classIdRaw === "number" ? classIdRaw : typeof classIdRaw === "string" ? parseInt(classIdRaw, 10) : NaN;
  const visitId =
    typeof visitIdRaw === "number"
      ? visitIdRaw
      : typeof visitIdRaw === "string"
        ? parseInt(visitIdRaw, 10)
        : NaN;

  if (!Number.isFinite(classId) || classId <= 0) {
    return jsonResponse(400, { ok: false, error: "missing_class_id" });
  }
  if (!Number.isFinite(visitId) || visitId <= 0) {
    return jsonResponse(400, { ok: false, error: "missing_visit_id" });
  }

  const ctx = await resolveConsumerClient(event);
  if (!ctx.ok) return ctx.response;

  const v = MB_API_VERSION;
  const path = `/public/v${v}/class/removeclientfromclass`;

  /** @param {boolean} late */
  function buildPayload(late) {
    /** @type {Record<string, unknown>} */
    const p = {
      ClientId: ctx.clientId,
      ClassId: classId,
      VisitId: visitId,
      SendEmail: true,
    };
    if (late) p.LateCancel = true;
    return p;
  }

  /**
   * Studios configure a self-service cancellation window in Mindbody (currently 12h).
   * When a consumer attempts to cancel inside that window with a `consumer-identity-token`,
   * Mindbody rejects with HTTP 400 + a body whose error message contains "outside…
   * allowed window" / "late cancel". The studio still wants the spot freed and the credit
   * forfeited (mirrors what staff does over the phone), so we retry with a Staff Bearer
   * token + explicit `LateCancel: true` — Mindbody honors that combination and stamps
   * `LateCancelled: true` on the visit.
   *
   * @param {unknown} data
   */
  function cancelRejectedAsOutsideWindow(data) {
    if (!data || typeof data !== "object") return false;
    const d = /** @type {Record<string, unknown>} */ (data);
    /** @type {string[]} */
    const messageBucket = [];
    /** @param {unknown} val */
    function harvest(val) {
      if (typeof val === "string") {
        messageBucket.push(val);
      } else if (val && typeof val === "object") {
        const o = /** @type {Record<string, unknown>} */ (val);
        for (const k of ["Message", "message", "Code", "code"]) {
          const inner = o[k];
          if (typeof inner === "string") messageBucket.push(inner);
        }
      }
    }
    harvest(d.Error);
    harvest(d.error);
    harvest(d.Message);
    harvest(d.message);
    const joined = messageBucket.join(" ").toLowerCase();
    if (!joined) return false;
    return (
      /\boutside\b.*\b(allowed|cancel(?:lation)?)\b.*\bwindow\b/.test(joined) ||
      /\bcancellation is outside\b/.test(joined) ||
      /\blate\s+cancel\b/.test(joined) ||
      /\bcancel(?:lation)?\s+window\b/.test(joined)
    );
  }

  let r = await fetchMb("POST", path, ctx.authHeaders, buildPayload(false));

  let staffLateRetry = false;
  let staffRetryError = null;
  if (!r.ok && r.status === 400 && cancelRejectedAsOutsideWindow(r.data)) {
    const staffIssued = await getMindbodyStaffAccessTokenCached({ issueTimeoutMs: 8000 });
    /** @type {Record<string, string> | null} */
    let staffHeaders = staffIssued.ok === true ? mindbodyStaffBearerHeaders(staffIssued.accessToken) : null;
    if (!staffHeaders) staffHeaders = mindbodyStaffApiHeaders();
    if (staffHeaders) {
      staffLateRetry = true;
      const r2 = await fetchMb("POST", path, staffHeaders, buildPayload(true));
      console.log(
        JSON.stringify({
          event: "class_cancel_late_retry",
          classId,
          visitId,
          consumerHttpStatus: r.status,
          retryHttpStatus: r2.status,
          retryOk: r2.ok,
          staffTokenFromCache: staffIssued.ok === true ? staffIssued.fromCache === true : null,
        }),
      );
      r = r2;
    } else {
      staffRetryError = staffIssued.ok === false ? staffIssued.error : "no_staff_headers";
      console.warn(
        JSON.stringify({
          event: "class_cancel_late_retry_unavailable",
          classId,
          visitId,
          reason: staffRetryError,
        }),
      );
    }
  }

  const lateCancelled = r.ok
    ? (extractLateCancelledFromMindbody(r.data, classId) ?? (staffLateRetry ? true : null))
    : null;

  console.log(
    JSON.stringify({
      event: "class_cancel_response",
      classId,
      visitId,
      clientId: ctx.clientId,
      ok: r.ok,
      status: r.status,
      lateCancelled,
      staffLateRetry,
      staffRetryError,
    }),
  );

  const cookieHdr = ctx.setCookie ? { "Set-Cookie": ctx.setCookie } : {};
  return jsonResponse(
    r.ok ? 200 : r.status,
    {
      ok: r.ok,
      status: r.status,
      mindbody: r.data,
      /**
       * `lateCancelled` is the studio's authoritative answer (per Mindbody site config:
       * 12-hour window today, but the studio could change it). When `null`, Mindbody
       * didn't surface the field and the frontend falls back to its own clock-based
       * estimate — see `LATE_CANCEL_HOURS` in `classes-schedule.js`.
       */
      ...(r.ok ? { lateCancelled, classId, visitId } : { error: "mindbody_cancel_failed" }),
    },
    cookieHdr,
  );
}
