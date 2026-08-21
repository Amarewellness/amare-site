import { jsonResponse } from "./mindbody-consumer-lib.mjs";
import { resolveStudioCustomer } from "./amare-studio-lib.mjs";
import { tryOpenGuestPassBlobStore, guestPassBlobsEnabled } from "./guest-pass-blobs.mjs";
import { loadGuestPassLib } from "./guest-pass-lib-loader.mjs";
import { resolveGuestPassStaffHeaders } from "./mindbody-guest-pass-sale.mjs";
import { loadGuestPassConfig } from "./guest-pass-catalog-lib.mjs";
import { withLambdaMobileCors } from "./amare-lambda-mobile-cors.mjs";
import { withMobileCorsHandler } from "./mobile-api-cors.mjs";

/** @param {import("@netlify/functions").HandlerEvent} event */
function bringFriendStatusDebugEnabled(event) {
  const isLocalDev = !(process.env.NETLIFY || "").trim();
  const qs = event.queryStringParameters || {};
  if (process.env.NODE_ENV !== "production") return true;
  return isLocalDev && qs.debug === "1";
}

/** @param {string} studioTimezone */
function serverNowStudioTz(studioTimezone) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: studioTimezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(new Date());
  } catch {
    return new Date().toISOString();
  }
}

/**
 * @param {Record<string, unknown>} debug
 * @returns {Record<string, unknown>}
 */
function sanitizeBringFriendStatusDebug(debug) {
  return {
    resolvedClientId: debug.resolvedClientId ?? null,
    resolvedEmail: debug.resolvedEmail ?? null,
    siteId: debug.siteId ?? null,
    authMode: debug.authMode ?? null,
    staffFallbackUsed: debug.staffFallbackUsed === true,
    consumerClientServicesCount:
      typeof debug.consumerClientServicesCount === "number" ? debug.consumerClientServicesCount : null,
    staffClientServicesCount:
      typeof debug.staffClientServicesCount === "number" ? debug.staffClientServicesCount : null,
    activeMembershipsCount:
      typeof debug.activeMembershipsCount === "number" ? debug.activeMembershipsCount : null,
    stripeFallbackChecked: debug.stripeFallbackChecked === true,
    matchedEntitlementSource: debug.matchedEntitlementSource ?? null,
    matchedProductId: debug.matchedProductId ?? null,
    matchedServiceName: debug.matchedServiceName ?? null,
    matchedSku: debug.matchedSku ?? null,
    periodKey: debug.periodKey ?? null,
    usageBlobKey: debug.usageBlobKey ?? null,
    usageBlobStatus: debug.usageBlobStatus ?? null,
    shortCircuitReason: debug.shortCircuitReason ?? null,
    serverNowStudioTz: debug.serverNowStudioTz ?? null,
    classStartDate: debug.classStartDate ?? null,
    visitsCount: typeof debug.visitsCount === "number" ? debug.visitsCount : null,
    matchedVisitIds: Array.isArray(debug.matchedVisitIds) ? debug.matchedVisitIds : [],
    matchedClassIds: Array.isArray(debug.matchedClassIds) ? debug.matchedClassIds : [],
    capacityLookupMode: debug.capacityLookupMode ?? null,
    capacityRowsFound: typeof debug.capacityRowsFound === "number" ? debug.capacityRowsFound : null,
    spotsRemainingByClassId:
      debug.spotsRemainingByClassId && typeof debug.spotsRemainingByClassId === "object"
        ? debug.spotsRemainingByClassId
        : {},
    upcomingBookedClassesCount:
      typeof debug.upcomingBookedClassesCount === "number" ? debug.upcomingBookedClassesCount : null,
  };
}

/**
 * @param {Record<string, unknown>} payload
 * @param {Record<string, unknown> | null} debug
 */
function withDebug(payload, debug) {
  if (!debug) return payload;
  const clean = sanitizeBringFriendStatusDebug(debug);
  console.info("bring_friend_status_debug", clean);
  return { ...payload, debug: clean };
}

/** @param {import("@netlify/functions").HandlerEvent} event */
async function bringFriendStatusHandler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: { "Cache-Control": "no-store" }, body: "" };
  }
  if (event.httpMethod !== "GET") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" });
  }

  const gpg = await loadGuestPassLib();
  const {
    buildUpcomingBookedClassesForMember,
    guestLastInitial,
    loadGuestBookingConsentText,
    readGuestPassUsage,
    resolveGuestPassEntitlement,
    usageKey,
  } = gpg;

  const debugEnabled = bringFriendStatusDebugEnabled(event);
  const gp = loadGuestPassConfig();
  /** @type {Record<string, unknown> | null} */
  let debug = debugEnabled
    ? {
        serverNowStudioTz: serverNowStudioTz(gp.studioTimezone),
      }
    : null;

  const ctx = await resolveStudioCustomer(event);
  if (!ctx.ok) return ctx.response;

  if (debug) {
    debug.resolvedClientId = ctx.clientId;
    debug.resolvedEmail = ctx.email || null;
  }

  const staffHeaders = await resolveGuestPassStaffHeaders();
  const entitlement = await resolveGuestPassEntitlement(ctx.clientId, event, {
    consumerAuthHeaders: ctx.authHeaders,
    staffHeaders,
    debug: debug ?? undefined,
  });

  const periodKey = entitlement.ok ? entitlement.periodKey : debug?.periodKey ?? null;
  if (debug && periodKey) {
    debug.periodKey = periodKey;
    debug.usageBlobKey = usageKey(ctx.clientId, periodKey);
  }

  if (!entitlement.ok) {
    if (debug) debug.shortCircuitReason = "tier_not_eligible";
    const cookieHdr = ctx.setCookie ? { "Set-Cookie": ctx.setCookie } : {};
    return jsonResponse(
      200,
      withDebug({ eligible: false, status: "ineligible", error: "tier_not_eligible" }, debug),
      cookieHdr,
    );
  }

  const store = guestPassBlobsEnabled() ? tryOpenGuestPassBlobStore(event) : null;
  const usage = store ? await readGuestPassUsage(store, ctx.clientId, entitlement.periodKey) : null;
  const usageStatus = usage ? String(usage.status || "") : null;
  if (debug) debug.usageBlobStatus = usageStatus || null;

  /** @type {Record<string, unknown>} */
  const base = {
    eligible: true,
    tier: entitlement.tier,
    periodMode: entitlement.periodMode,
    period: entitlement.periodKey,
    resetsAt: entitlement.resetsAt,
  };
  if (entitlement.memberPackClientServiceId) {
    base.memberPackClientServiceId = entitlement.memberPackClientServiceId;
  }

  const cookieHdr = ctx.setCookie ? { "Set-Cookie": ctx.setCookie } : {};

  if (usageStatus === "confirmed") {
    if (debug) debug.shortCircuitReason = "confirmed";
    return jsonResponse(
      200,
      withDebug(
        {
          ...base,
          status: "used",
          usedFor: {
            guestFirstName: usage?.guestFirstName || "",
            guestLastInitial: guestLastInitial(String(usage?.guestLastName || "")),
            classId: usage?.classId,
            className: usage?.className || null,
            classStartDateTime: usage?.classDateTime || null,
          },
        },
        debug,
      ),
      cookieHdr,
    );
  }

  if (usageStatus === "confirmed_cancelled") {
    return jsonResponse(
      200,
      withDebug(
        {
          ...base,
          status: "confirmed_cancelled",
          cancelledFor: {
            guestFirstName: usage?.guestFirstName || "",
            guestLastInitial: guestLastInitial(String(usage?.guestLastName || "")),
            classId: usage?.classId,
            className: usage?.className || null,
            classStartDateTime: usage?.classDateTime || null,
            lateCancel: usage?.cancelLateMember === true,
          },
        },
        debug,
      ),
      cookieHdr,
    );
  }

  if (usageStatus === "failed_manual_review") {
    if (debug) debug.shortCircuitReason = "failed_manual_review";
    return jsonResponse(
      200,
      withDebug(
        {
          ...base,
          status: "failed_manual_review",
          supportContext: `BFP-${entitlement.periodKey}-${ctx.clientId}`,
        },
        debug,
      ),
      cookieHdr,
    );
  }

  if (usageStatus === "pending" && usage?.expiresAt && Date.parse(String(usage.expiresAt)) > Date.now()) {
    if (debug) debug.shortCircuitReason = "pending";
    return jsonResponse(200, withDebug({ ...base, status: "pending" }, debug), cookieHdr);
  }

  const upcomingBookedClasses = await buildUpcomingBookedClassesForMember({
    memberClientId: ctx.clientId,
    consumerAuthHeaders: ctx.authHeaders,
    staffHeaders,
    debug: debug ?? undefined,
  });

  if (debug) {
    const upcomingBeforeCap = debug._upcomingVisitsBeforeCapacity;
    if (upcomingBookedClasses.length === 0) {
      debug.shortCircuitReason =
        typeof upcomingBeforeCap === "number" && upcomingBeforeCap > 0
          ? "no_capacity"
          : "no_upcoming_classes";
    } else {
      debug.shortCircuitReason = null;
    }
  }

  return jsonResponse(
    200,
    withDebug(
      {
        ...base,
        status: "available",
        upcomingBookedClasses,
        bookingConsentText: loadGuestBookingConsentText(),
      },
      debug,
    ),
    cookieHdr,
  );
}

export const lambdaHandler = withMobileCorsHandler(bringFriendStatusHandler);
export default withLambdaMobileCors(lambdaHandler);
