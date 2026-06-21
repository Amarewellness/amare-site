import {
  MB_API_VERSION,
  fetchMb,
  jsonResponse,
  resolveConsumerClient,
  consumerAuthExtraHeaders,
  resolveSessionStudioLinkFlags,
  getMindbodyStaffAccessTokenCached,
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
 * @returns {Promise<number[]>} Active ClientService ids with visits left, highest remaining first.
 */
async function listActiveClientServiceIds(clientId, authHeaders) {
  const v = MB_API_VERSION;
  const q = new URLSearchParams({
    "request.clientId": String(clientId),
    "request.showActiveOnly": "true",
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
    const rem = s.Remaining ?? s.remaining;
    if (typeof rem !== "number" || rem <= 0) continue;
    const sid = s.Id ?? s.id;
    if (sid == null || !Number.isFinite(Number(sid))) continue;

    const exp = s.ExpirationDate ?? s.expirationDate ?? s.End ?? s.endDate;
    if (exp != null && exp !== "") {
      const dExp = new Date(String(exp));
      if (!Number.isNaN(dExp.getTime())) {
        const expDay = new Date(dExp.getFullYear(), dExp.getMonth(), dExp.getDate()).getTime();
        if (expDay < todayMs) continue;
      }
    }

    out.push({ id: Number(sid), remaining: rem });
  }

  out.sort((a, b) => b.remaining - a.remaining);
  return out.map((x) => x.id);
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

  /** @param {Record<string, string>} authHeaders @param {number | undefined} cs */
  async function tryBookWith(authHeaders, cs) {
    /** @type {Record<string, unknown>} */
    const payload = {
      ClientId: ctx.clientId,
      ClassId: classId,
      SendEmail: true,
      Waitlist: waitlist,
      Test: false,
    };
    if (cs != null) payload.ClientServiceId = cs;
    return fetchMb("POST", path, authHeaders, payload);
  }

  let r = await tryBookWith(ctx.authHeaders, clientServiceId ?? undefined);
  let attemptedClientServiceFallback = false;
  let attemptedStaffPaymentFallback = false;
  /** @type {number[]} */
  let triedServiceIds = [];
  if (!r.ok && clientServiceId == null) {
    const serviceIds = await listActiveClientServiceIds(ctx.clientId, ctx.authHeaders);
    for (const picked of serviceIds) {
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
      r = await tryBookWith(ctx.authHeaders, picked);
      if (r.ok) break;
    }
  }

  let summary = summarizeMindbodyBookError(r.data);
  if (!r.ok && isPaymentRequiredError(summary)) {
    const staffHeaders = await resolveStaffAuthHeaders();
    if (staffHeaders) {
      attemptedStaffPaymentFallback = true;
      const staffServiceIds =
        triedServiceIds.length > 0
          ? triedServiceIds
          : await listActiveClientServiceIds(ctx.clientId, staffHeaders);
      const idsToTry =
        clientServiceId != null
          ? [clientServiceId, ...staffServiceIds.filter((id) => id !== clientServiceId)]
          : staffServiceIds;

      console.log(
        JSON.stringify({
          event: "class_book_staff_payment_fallback_start",
          classId,
          clientId: ctx.clientId,
          serviceIds: idsToTry,
        }),
      );

      for (const picked of idsToTry) {
        r = await tryBookWith(staffHeaders, picked);
        if (r.ok) {
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
      if (!r.ok) {
        r = await tryBookWith(staffHeaders, clientServiceId ?? undefined);
      }
      summary = summarizeMindbodyBookError(r.data);
    }
  }

  const visitId = r.ok && !waitlist ? extractVisitIdFromBookResponse(r.data, classId) : null;
  const waitlistEntryId =
    r.ok && waitlist ? extractWaitlistEntryIdFromBookResponse(r.data, classId) : null;
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
          }
        : { error: "mindbody_book_failed" }),
    },
    cookieHdr,
  );
}

export const handler = withMobileCorsHandler(classBookHandler);
