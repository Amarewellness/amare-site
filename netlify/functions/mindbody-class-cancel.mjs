import {
  fetchMb,
  getMindbodyStaffAccessTokenCached,
  jsonResponse,
  resolveConsumerClient,
  MB_API_VERSION,
} from "./mindbody-consumer-lib.mjs";
import { mindbodyStaffApiHeaders, mindbodyStaffBearerHeaders } from "./mindbody-upstream.mjs";
import { tryOpenGuestPassBlobStore, guestPassBlobsEnabled } from "./guest-pass-blobs.mjs";
import {
  cancelGuestPassSlot,
  guestLastInitial,
  loadConfirmedGuestPassForMemberAndClass,
} from "./guest-pass-lib.mjs";
import { cancelGuestVisit } from "./mindbody-guest-client-lib.mjs";
import { resolveGuestPassStaffHeaders } from "./mindbody-guest-pass-sale.mjs";
import {
  sendGuestCancellationEmail,
  sendGuestPassStudioAlert,
  sendMemberCancellationEmail,
} from "./guest-pass-emails.mjs";

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

/**
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

/**
 * @param {{
 *   classId: number;
 *   visitId: number;
 *   clientId: number;
 *   authHeaders: Record<string, string>;
 * }} opts
 */
async function cancelMemberVisit(opts) {
  const path = `/public/v${MB_API_VERSION}/class/removeclientfromclass`;
  /** @param {boolean} late */
  function buildPayload(late) {
    /** @type {Record<string, unknown>} */
    const p = {
      ClientId: opts.clientId,
      ClassId: opts.classId,
      VisitId: opts.visitId,
      SendEmail: true,
    };
    if (late) p.LateCancel = true;
    return p;
  }

  let r = await fetchMb("POST", path, opts.authHeaders, buildPayload(false));
  let staffLateRetry = false;
  let staffRetryError = null;
  if (!r.ok && r.status === 400 && cancelRejectedAsOutsideWindow(r.data)) {
    const staffIssued = await getMindbodyStaffAccessTokenCached({ issueTimeoutMs: 8000 });
    /** @type {Record<string, string> | null} */
    let staffHeaders = staffIssued.ok === true ? mindbodyStaffBearerHeaders(staffIssued.accessToken) : null;
    if (!staffHeaders) staffHeaders = mindbodyStaffApiHeaders();
    if (staffHeaders) {
      staffLateRetry = true;
      r = await fetchMb("POST", path, staffHeaders, buildPayload(true));
    } else {
      staffRetryError = staffIssued.ok === false ? staffIssued.error : "no_staff_headers";
    }
  }
  const lateCancelled = r.ok
    ? (extractLateCancelledFromMindbody(r.data, opts.classId) ?? (staffLateRetry ? true : null))
    : null;
  return { r, lateCancelled, staffLateRetry, staffRetryError };
}

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: { "Cache-Control": "no-store" }, body: "" };
  }

  if (event.httpMethod === "GET") {
    const qs = event.queryStringParameters || {};
    const preflight = qs.preflight === "1";
    if (!preflight) {
      return jsonResponse(405, { ok: false, error: "method_not_allowed" });
    }
    const classId = qs.classId ? parseInt(qs.classId, 10) : NaN;
    const period = qs.period || undefined;
    if (!Number.isFinite(classId) || classId <= 0) {
      return jsonResponse(400, { ok: false, error: "missing_class_id" });
    }
    const ctx = await resolveConsumerClient(event);
    if (!ctx.ok) return ctx.response;
    const store = guestPassBlobsEnabled() ? tryOpenGuestPassBlobStore(event) : null;
    const guest = await loadConfirmedGuestPassForMemberAndClass(store, {
      memberClientId: ctx.clientId,
      classId,
      periodKey: period,
    });
    const cookieHdr = ctx.setCookie ? { "Set-Cookie": ctx.setCookie } : {};
    if (!guest.hasGuest || !guest.record) {
      return jsonResponse(200, { hasGuest: false }, cookieHdr);
    }
    return jsonResponse(
      200,
      {
        hasGuest: true,
        guestFirstName: guest.record.guestFirstName || "",
        guestLastInitial: guestLastInitial(String(guest.record.guestLastName || "")),
        classDateTime: guest.record.classDateTime || null,
        period: guest.periodKey || period || guest.record.period,
      },
      cookieHdr,
    );
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

  const periodRaw = body.period ?? body.Period;
  const period = typeof periodRaw === "string" ? periodRaw.trim() : undefined;
  const confirmCancelGuest =
    body.confirmCancelGuest === true ||
    body.confirmCancelGuest === "true" ||
    body.confirmCancelGuest === 1;

  const store = guestPassBlobsEnabled() ? tryOpenGuestPassBlobStore(event) : null;
  const guestPreflight = store
    ? await loadConfirmedGuestPassForMemberAndClass(store, {
        memberClientId: ctx.clientId,
        classId,
        periodKey: period,
      })
    : { hasGuest: false };

  if (guestPreflight.hasGuest && guestPreflight.record && !confirmCancelGuest) {
    const rec = guestPreflight.record;
    const cookieHdr = ctx.setCookie ? { "Set-Cookie": ctx.setCookie } : {};
    return jsonResponse(
      409,
      {
        ok: false,
        error: "guest_cancel_confirmation_required",
        hasGuest: true,
        guestFirstName: rec.guestFirstName || "",
        guestLastInitial: guestLastInitial(String(rec.guestLastName || "")),
        period: guestPreflight.periodKey || rec.period,
      },
      cookieHdr,
    );
  }

  if (guestPreflight.hasGuest && guestPreflight.record && confirmCancelGuest) {
    const rec = guestPreflight.record;
    const periodKey = period || guestPreflight.periodKey || rec.period;
    if (!periodKey) {
      return jsonResponse(400, { ok: false, error: "missing_period" });
    }
    const fresh = await loadConfirmedGuestPassForMemberAndClass(store, {
      memberClientId: ctx.clientId,
      classId,
      periodKey,
    });
    if (!fresh.hasGuest || !fresh.record || fresh.record.status !== "confirmed") {
      return jsonResponse(409, { ok: false, error: "guest_pass_state_changed" });
    }
  }

  const { r, lateCancelled, staffLateRetry, staffRetryError } = await cancelMemberVisit({
    classId,
    visitId,
    clientId: ctx.clientId,
    authHeaders: ctx.authHeaders,
  });

  /** @type {boolean} */
  let guestAlsoCancelled = false;
  /** @type {boolean | null} */
  let lateCancelledGuest = null;
  let guestCancelFailed = false;

  if (r.ok && guestPreflight.hasGuest && guestPreflight.record && confirmCancelGuest && store) {
    const rec = guestPreflight.record;
    const periodKey = period || guestPreflight.periodKey || rec.period || "";
    const staffHeaders = await resolveGuestPassStaffHeaders();
    const guestVisitId = rec.guestVisitId;
    const guestClientId = rec.guestClientId;
    const memberLate = lateCancelled === true || staffLateRetry === true;
    if (staffHeaders && guestClientId && guestVisitId) {
      const gc = await cancelGuestVisit({
        guestClientId,
        classId,
        guestVisitId,
        lateCancel: memberLate,
        staffHeaders,
      });
      if (gc.ok) {
        guestAlsoCancelled = true;
        lateCancelledGuest = memberLate ? true : lateCancelled === false ? false : null;
        await cancelGuestPassSlot(store, {
          memberClientId: ctx.clientId,
          periodKey,
          cancelLateMember: memberLate,
          cancelLateGuest: memberLate,
          cancelledByMemberClientId: ctx.clientId,
        });
        const gInitial = guestLastInitial(String(rec.guestLastName || ""));
        if (rec.guestEmailLower) {
          void sendGuestCancellationEmail({
            guestEmail: String(rec.guestEmailLower),
            guestFirstName: String(rec.guestFirstName || "Guest"),
            className: String(rec.className || "your class"),
            classStartDateTime: String(rec.classDateTime || ""),
          });
        }
        if (ctx.email) {
          void sendMemberCancellationEmail({
            memberEmail: ctx.email,
            guestFirstName: String(rec.guestFirstName || ""),
            guestLastInitial: gInitial,
            className: String(rec.className || "your class"),
            classStartDateTime: String(rec.classDateTime || ""),
            periodMode: String(rec.periodMode || "calendarMonth"),
            resetsAt: null,
          });
        }
      } else {
        guestCancelFailed = true;
        const alertTo = (process.env.SMS_ADMIN_REPORT_TO || "").trim();
        if (alertTo) {
          void sendGuestPassStudioAlert({
            to: alertTo,
            subject: `[AMARÉ] Guest cancel failed — member ${ctx.clientId}`,
            html: `<p>Member ${ctx.clientId} cancelled class ${classId} but guest ${guestClientId} visit ${guestVisitId} could not be cancelled.</p><p>Support: BFP-${periodKey}-${ctx.clientId}</p>`,
          });
        }
      }
    }
  }

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
      guestAlsoCancelled,
      guestCancelFailed,
    }),
  );

  const cookieHdr = ctx.setCookie ? { "Set-Cookie": ctx.setCookie } : {};
  if (guestCancelFailed) {
    return jsonResponse(
      502,
      {
        ok: false,
        error: "mindbody_guest_cancel_failed",
        status: r.status,
        lateCancelled,
        classId,
        visitId,
        supportContext: `BFP-${period || guestPreflight.record?.period}-${ctx.clientId}`,
      },
      cookieHdr,
    );
  }
  return jsonResponse(
    r.ok ? 200 : r.status,
    {
      ok: r.ok,
      status: r.status,
      mindbody: r.data,
      ...(r.ok
        ? {
            lateCancelled,
            classId,
            visitId,
            ...(guestPreflight.hasGuest && confirmCancelGuest
              ? {
                  guestAlsoCancelled,
                  guestPassReturned: false,
                  lateCancelledGuest,
                  guestFirstName: guestPreflight.record?.guestFirstName || "",
                  guestLastInitial: guestLastInitial(String(guestPreflight.record?.guestLastName || "")),
                }
              : {}),
          }
        : { error: "mindbody_cancel_failed" }),
    },
    cookieHdr,
  );
}
