import {
  fetchMb,
  getMindbodyStaffAccessTokenCached,
  jsonResponse,
  consumerAuthExtraHeaders,
  MB_API_VERSION,
} from "./mindbody-consumer-lib.mjs";
import { resolveStudioCustomer } from "./amare-studio-lib.mjs";
import { visitOwnedByClient } from "./mindbody-class-book-lib.mjs";
import { mindbodyStaffApiHeaders, mindbodyStaffBearerHeaders } from "./mindbody-upstream.mjs";
import { tryOpenGuestPassBlobStore, guestPassBlobsEnabled } from "./guest-pass-blobs.mjs";
import {
  cancelGuestPassSlot,
  guestLastInitial,
  guestPassCancelTiming,
  loadConfirmedGuestPassForMemberAndClass,
  restoreGuestPassSlotAfterEarlyCancel,
} from "./guest-pass-lib.mjs";
import { cancelGuestVisit, isGuestAlreadyBookedToClass } from "./mindbody-guest-client-lib.mjs";
import { resolveGuestPassStaffHeaders } from "./mindbody-guest-pass-sale.mjs";
import {
  sendGuestCancellationEmail,
  sendGuestPassStudioAlert,
  sendMemberCancellationEmail,
} from "./guest-pass-emails.mjs";
import { withLambdaMobileCors } from "./amare-lambda-mobile-cors.mjs";
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
 * @param {unknown} data
 */
function summarizeMindbodyCancelError(data) {
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

/**
 * @param {Record<string, string>} staffHeaders
 * @param {number} guestClientId
 * @param {number} classId
 */
async function resolveGuestClassVisitState(staffHeaders, guestClientId, classId) {
  const q = new URLSearchParams({
    "request.clientId": String(guestClientId),
    "request.classId": String(classId),
    "request.limit": "20",
  });
  const r = await fetchMb(
    "GET",
    `/public/v${MB_API_VERSION}/client/clientvisits?${q}`,
    staffHeaders,
    null,
  );
  if (!r.ok) return { ok: false, reason: "visit_lookup_failed" };
  const d = r.data && typeof r.data === "object" ? /** @type {Record<string, unknown>} */ (r.data) : {};
  const visits = d.Visits ?? d.visits;
  if (!Array.isArray(visits)) return { ok: true, booked: false, attended: false, visitId: null };

  for (const raw of visits) {
    if (!raw || typeof raw !== "object") continue;
    const v = /** @type {Record<string, unknown>} */ (raw);
    const cancelled =
      v.Cancelled === true ||
      v.cancelled === true ||
      v.LateCancelled === true ||
      v.lateCancelled === true;
    const status = String(v.AppointmentStatus ?? v.appointmentStatus ?? v.Action ?? v.action ?? "").toLowerCase();
    if (cancelled || /cancel|no.?show|missed/.test(status)) continue;
    const cid = v.ClassId ?? v.classId;
    if (cid != null && Number(cid) !== classId) continue;
    const signedIn = v.SignedIn ?? v.signedIn;
    const vid = v.Id ?? v.id ?? v.VisitId ?? v.visitId;
    const visitId =
      typeof vid === "number" ? vid : typeof vid === "string" && /^\d+$/.test(vid) ? parseInt(vid, 10) : null;
    if (signedIn === true) {
      return { ok: true, booked: false, attended: true, visitId };
    }
    return { ok: true, booked: true, attended: false, visitId };
  }
  return { ok: true, booked: false, attended: false, visitId: null };
}

/**
 * @param {{
 *   staffHeaders: Record<string, string>;
 *   guestClientId: number;
 *   classId: number;
 *   guestVisitId?: number | null;
 *   lateCancel: boolean;
 * }} opts
 */
async function cancelGuestFromClassOrVerifyRemoved(opts) {
  const state = await resolveGuestClassVisitState(opts.staffHeaders, opts.guestClientId, opts.classId);
  if (!state.ok) return { ok: false, reason: state.reason || "visit_lookup_failed" };
  if (state.attended) return { ok: false, reason: "guest_already_attended" };
  if (!state.booked) {
    return { ok: true, guestAlsoCancelled: false, alreadyRemoved: true, visitId: null };
  }

  const visitId = opts.guestVisitId ?? state.visitId;
  if (!visitId) return { ok: false, reason: "guest_visit_id_missing" };

  const gc = await cancelGuestVisit({
    guestClientId: opts.guestClientId,
    classId: opts.classId,
    guestVisitId: visitId,
    lateCancel: opts.lateCancel,
    staffHeaders: opts.staffHeaders,
  });
  if (!gc.ok) {
    const recheck = await isGuestAlreadyBookedToClass({
      guestClientId: opts.guestClientId,
      classId: opts.classId,
      staffHeaders: opts.staffHeaders,
    });
    if (!recheck.booked) {
      return { ok: true, guestAlsoCancelled: false, alreadyRemoved: true, visitId };
    }
    return { ok: false, reason: "mindbody_guest_cancel_failed" };
  }
  return { ok: true, guestAlsoCancelled: true, alreadyRemoved: false, visitId };
}

async function classCancelHandler(event) {
  if (event.httpMethod === "GET") {
    const qs = event.queryStringParameters || {};
    const preflight = qs.preflight === "1";
    if (!preflight) {
      console.warn(
        JSON.stringify({ event: "class_cancel_method_not_allowed", httpMethod: event.httpMethod }),
      );
      return jsonResponse(405, { ok: false, error: "method_not_allowed" });
    }
    const classId = qs.classId ? parseInt(qs.classId, 10) : NaN;
    const period = qs.period || undefined;
    console.log(
      JSON.stringify({
        event: "class_cancel_preflight_request",
        classId: Number.isFinite(classId) ? classId : null,
        period: period ?? null,
      }),
    );
    if (!Number.isFinite(classId) || classId <= 0) {
      console.warn(JSON.stringify({ event: "class_cancel_preflight_missing_class_id", classIdRaw: qs.classId }));
      return jsonResponse(400, { ok: false, error: "missing_class_id" });
    }
    const ctx = await resolveStudioCustomer(event);
    if (!ctx.ok) {
      const status = typeof ctx.response.statusCode === "number" ? ctx.response.statusCode : 500;
      console.warn(
        JSON.stringify({
          event: "class_cancel_preflight_resolve_failed",
          classId,
          status,
          reason: ctx.reason || null,
        }),
      );
      return ctx.response;
    }
    console.log(
      JSON.stringify({
        event: "class_cancel_preflight_resolved_client",
        classId,
        clientId: ctx.clientId,
        email: ctx.email,
      }),
    );
    const store = guestPassBlobsEnabled() ? tryOpenGuestPassBlobStore(event) : null;
    const guest = await loadConfirmedGuestPassForMemberAndClass(store, {
      memberClientId: ctx.clientId,
      classId,
      periodKey: period,
    });
    const hasGuest = Boolean(guest.hasGuest && guest.record);
    console.log(
      JSON.stringify({
        event: "class_cancel_preflight_response",
        classId,
        clientId: ctx.clientId,
        hasGuest,
        period: hasGuest ? guest.periodKey || period || guest.record?.period || null : null,
      }),
    );
    const cookieHdr = ctx.authSource === "mindbody" && ctx.consumerCtx ? consumerAuthExtraHeaders(ctx.consumerCtx) : {};
    if (!hasGuest) {
      return jsonResponse(200, { hasGuest: false }, cookieHdr);
    }
    const timing = guestPassCancelTiming({
      classDateTime: guest.record.classDateTime || null,
    });
    return jsonResponse(
      200,
      {
        hasGuest: true,
        guestFirstName: guest.record.guestFirstName || "",
        guestLastInitial: guestLastInitial(String(guest.record.guestLastName || "")),
        classDateTime: guest.record.classDateTime || null,
        period: guest.periodKey || period || guest.record.period,
        guestPassWillRestore: timing.eligibleForEarlyRestore,
      },
      cookieHdr,
    );
  }

  if (event.httpMethod !== "POST") {
    console.warn(JSON.stringify({ event: "class_cancel_method_not_allowed", httpMethod: event.httpMethod }));
    return jsonResponse(405, { ok: false, error: "method_not_allowed" });
  }

  const body = parseJsonBody(event);
  if (body === null) {
    console.warn(JSON.stringify({ event: "class_cancel_invalid_json" }));
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
    console.warn(JSON.stringify({ event: "class_cancel_missing_class_id", classIdRaw }));
    return jsonResponse(400, { ok: false, error: "missing_class_id" });
  }
  if (!Number.isFinite(visitId) || visitId <= 0) {
    console.warn(JSON.stringify({ event: "class_cancel_missing_visit_id", visitIdRaw }));
    return jsonResponse(400, { ok: false, error: "missing_visit_id" });
  }

  const periodRaw = body.period ?? body.Period;
  const period = typeof periodRaw === "string" ? periodRaw.trim() : undefined;
  const confirmCancelGuest =
    body.confirmCancelGuest === true ||
    body.confirmCancelGuest === "true" ||
    body.confirmCancelGuest === 1;

  console.log(
    JSON.stringify({
      event: "class_cancel_request",
      classId,
      visitId,
      confirmCancelGuest,
      period: period ?? null,
    }),
  );

  const ctx = await resolveStudioCustomer(event);
  if (!ctx.ok) {
    const status = typeof ctx.response.statusCode === "number" ? ctx.response.statusCode : 500;
    console.warn(
      JSON.stringify({
        event: "class_cancel_resolve_failed",
        classId,
        visitId,
        status,
        reason: ctx.reason || null,
      }),
    );
    return ctx.response;
  }

  const cookieHdrFor = () =>
    ctx.authSource === "mindbody" && ctx.consumerCtx ? consumerAuthExtraHeaders(ctx.consumerCtx) : {};

  console.log(
    JSON.stringify({
      event: "class_cancel_resolved_client",
      classId,
      visitId,
      clientId: ctx.clientId,
      email: ctx.email,
      authSource: ctx.authSource,
    }),
  );

  const owned = await visitOwnedByClient({
    clientId: ctx.clientId,
    classId,
    visitId,
    authHeaders: ctx.authHeaders,
  });
  if (!owned) {
    console.warn(
      JSON.stringify({
        event: "class_cancel_visit_not_owned",
        classId,
        visitId,
        clientId: ctx.clientId,
        authSource: ctx.authSource,
      }),
    );
    return jsonResponse(403, { ok: false, error: "visit_not_owned" }, cookieHdrFor());
  }

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
    console.log(
      JSON.stringify({
        event: "class_cancel_guest_confirmation_required",
        classId,
        visitId,
        clientId: ctx.clientId,
        period: guestPreflight.periodKey || rec.period || null,
      }),
    );
    const cookieHdr = cookieHdrFor();
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
      console.warn(
        JSON.stringify({
          event: "class_cancel_missing_period",
          classId,
          visitId,
          clientId: ctx.clientId,
        }),
      );
      return jsonResponse(400, { ok: false, error: "missing_period" });
    }
    const fresh = await loadConfirmedGuestPassForMemberAndClass(store, {
      memberClientId: ctx.clientId,
      classId,
      periodKey,
    });
    if (!fresh.hasGuest || !fresh.record || fresh.record.status !== "confirmed") {
      console.warn(
        JSON.stringify({
          event: "class_cancel_guest_pass_state_changed",
          classId,
          visitId,
          clientId: ctx.clientId,
          periodKey,
        }),
      );
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
  /** @type {boolean | null} */
  let guestPassReturned = null;

  if (r.ok && guestPreflight.hasGuest && guestPreflight.record && confirmCancelGuest && store) {
    const rec = guestPreflight.record;
    const periodKey = period || guestPreflight.periodKey || rec.period || "";
    const staffHeaders = await resolveGuestPassStaffHeaders();
    const guestClientId = rec.guestClientId;
    const memberLate = lateCancelled === true || staffLateRetry === true;
    const timing = guestPassCancelTiming({
      classDateTime: rec.classDateTime,
      memberLateCancel: memberLate,
    });

    if (!staffHeaders || !guestClientId) {
      guestCancelFailed = true;
    } else if (timing.classAlreadyPassed) {
      const guestOutcome = await cancelGuestFromClassOrVerifyRemoved({
        staffHeaders,
        guestClientId,
        classId,
        guestVisitId: rec.guestVisitId,
        lateCancel: true,
      });
      if (!guestOutcome.ok) {
        guestCancelFailed = true;
      } else {
        guestAlsoCancelled = guestOutcome.guestAlsoCancelled === true;
        lateCancelledGuest = memberLate ? true : lateCancelled === false ? false : null;
        const slot = await cancelGuestPassSlot(store, {
          memberClientId: ctx.clientId,
          periodKey,
          cancelLateMember: true,
          cancelLateGuest: memberLate,
          cancelledByMemberClientId: ctx.clientId,
        });
        if (!slot.ok && slot.currentStatus !== "confirmed_cancelled") {
          guestCancelFailed = true;
        } else {
          guestPassReturned = false;
        }
      }
    } else {
      const guestOutcome = await cancelGuestFromClassOrVerifyRemoved({
        staffHeaders,
        guestClientId,
        classId,
        guestVisitId: rec.guestVisitId,
        lateCancel: timing.effectiveLate,
      });
      if (!guestOutcome.ok) {
        guestCancelFailed = true;
      } else {
        guestAlsoCancelled = guestOutcome.guestAlsoCancelled === true;
        lateCancelledGuest = timing.effectiveLate ? true : timing.mindbodyLate ? true : false;

        if (timing.eligibleForEarlyRestore) {
          const restored = await restoreGuestPassSlotAfterEarlyCancel(store, {
            memberClientId: ctx.clientId,
            periodKey,
            cancelledByMemberClientId: ctx.clientId,
          });
          guestPassReturned = restored.ok && (restored.restored === true || restored.alreadyRestored === true);
        } else {
          const slot = await cancelGuestPassSlot(store, {
            memberClientId: ctx.clientId,
            periodKey,
            cancelLateMember: timing.effectiveLate,
            cancelLateGuest: timing.effectiveLate,
            cancelledByMemberClientId: ctx.clientId,
          });
          if (!slot.ok && slot.currentStatus !== "confirmed_cancelled") {
            guestCancelFailed = true;
          } else {
            guestPassReturned = false;
          }
        }

        if (!guestCancelFailed) {
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
        }
      }
    }
  }

  const summary = summarizeMindbodyCancelError(r.data);
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
      confirmCancelGuest,
      hadGuestPass: Boolean(guestPreflight.hasGuest && guestPreflight.record),
      guestAlsoCancelled,
      guestCancelFailed,
      guestPassReturned,
      mindbodyErrorMessage: summary?.message ?? null,
      mindbodyErrorCode: summary?.code ?? null,
    }),
  );

  const cookieHdr = cookieHdrFor();
  if (guestCancelFailed) {
    const alertTo = (process.env.SMS_ADMIN_REPORT_TO || "").trim();
    if (alertTo && guestPreflight.record?.guestClientId) {
      void sendGuestPassStudioAlert({
        to: alertTo,
        subject: `[AMARÉ] Guest cancel failed — member ${ctx.clientId}`,
        html: `<p>Member ${ctx.clientId} cancelled class ${classId} but guest ${guestPreflight.record.guestClientId} could not be safely removed.</p><p>Support: BFP-${period || guestPreflight.record?.period}-${ctx.clientId}</p>`,
      });
    }
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
                  guestPassReturned: guestPassReturned === true,
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

export const lambdaHandler = withMobileCorsHandler(classCancelHandler);
export default withLambdaMobileCors(lambdaHandler);
