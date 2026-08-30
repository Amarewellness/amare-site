import { jsonResponse } from "./mindbody-consumer-lib.mjs";
import { resolveStudioCustomer } from "./amare-studio-lib.mjs";
import { MB_API_VERSION, fetchMb } from "./mindbody-consumer-lib.mjs";
import { tryOpenGuestPassBlobStore, guestPassBlobsEnabled } from "./guest-pass-blobs.mjs";
import { loadGuestPassConfig } from "./guest-pass-catalog-lib.mjs";
import { loadGuestPassLib } from "./guest-pass-lib-loader.mjs";
import {
  extractGuestVisitIdFromBookResponse,
  findOrCreateGuestClient,
  isGuestAlreadyBookedToClass,
} from "./mindbody-guest-client-lib.mjs";
import {
  issueGuestPassCompSale,
  pickFreshlyIssuedGuestPassServiceId,
  resolveGuestPassStaffHeaders,
} from "./mindbody-guest-pass-sale.mjs";
import {
  memberDisplayFirstName,
  sendGuestBookingConfirmationEmail,
  sendMemberBookingConfirmationEmail,
} from "./guest-pass-emails.mjs";
import { withLambdaMobileCors } from "./amare-lambda-mobile-cors.mjs";
import { withMobileCorsHandler } from "./mobile-api-cors.mjs";
import { parseClassCapacitySnapshot } from "./mindbody-class-capacity-lib.mjs";

/** @param {import("@netlify/functions").HandlerEvent} event */
function parseJsonBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function trimField(val, maxLen) {
  if (typeof val !== "string") return "";
  return val.trim().slice(0, maxLen);
}

function isReasonableEmail(email) {
  if (!email || email.length > 254) return false;
  return /^[^\s@]{1,200}@[^\s@]{1,64}\.[A-Za-z0-9.-]{2,24}$/.test(email);
}

/** @param {import("@netlify/functions").HandlerEvent} event */
function clientIp(event) {
  const xff = event.headers["x-forwarded-for"] || event.headers["X-Forwarded-For"];
  if (typeof xff === "string" && xff.trim()) return xff.split(",")[0].trim();
  return event.headers["client-ip"] || null;
}

async function bringFriendHandler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: { "Cache-Control": "no-store" }, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" });
  }

  if (!guestPassBlobsEnabled()) {
    return jsonResponse(503, { ok: false, error: "guest_pass_blobs_disabled" });
  }

  const gpg = await loadGuestPassLib();
  const {
    assertClassEligibleForGuestBooking,
    classMetaFromRow,
    confirmGuestPassSlot,
    failGuestPassSlot,
    findExistingGuestSlotConflict,
    findMemberBookedVisitForClass,
    loadGuestBookingConsentText,
    normalizeEmail,
    normalizePhone,
    resolveGuestPassEntitlement,
    reserveGuestPassSlot,
    fetchClassRowForCapacity,
    guestLastInitial,
    visitStartMsFromRow,
  } = gpg;

  const body = parseJsonBody(event);
  if (body === null) {
    return jsonResponse(400, { ok: false, error: "invalid_json" });
  }

  const classIdRaw = body.classId ?? body.ClassId;
  const classId =
    typeof classIdRaw === "number" ? classIdRaw : typeof classIdRaw === "string" ? parseInt(classIdRaw, 10) : NaN;
  const guestFirstName = trimField(body.guestFirstName ?? body.GuestFirstName, 80);
  const guestLastName = trimField(body.guestLastName ?? body.GuestLastName, 80);
  const guestEmail = trimField(body.guestEmail ?? body.GuestEmail, 254);
  const guestPhone = trimField(body.guestPhone ?? body.GuestPhone ?? body.guestMobilePhone, 32);
  const bookingConsentAccepted =
    body.bookingConsentAccepted === true ||
    body.bookingConsentAccepted === "true" ||
    body.bookingConsentAccepted === 1;

  if (!Number.isFinite(classId) || classId <= 0 || !guestFirstName || !guestLastName || !isReasonableEmail(guestEmail)) {
    return jsonResponse(400, { ok: false, error: "invalid_fields" });
  }
  if (!bookingConsentAccepted) {
    return jsonResponse(400, { ok: false, error: "booking_consent_required" });
  }

  const ctx = await resolveStudioCustomer(event);
  if (!ctx.ok) return ctx.response;

  const guestEmailLower = normalizeEmail(guestEmail);
  const guestPhoneNorm = normalizePhone(guestPhone);
  const memberEmailLower = normalizeEmail(ctx.email || "");

  if (memberEmailLower && guestEmailLower === memberEmailLower) {
    return jsonResponse(400, { ok: false, error: "cannot_invite_self" });
  }

  const staffHeaders = await resolveGuestPassStaffHeaders();
  if (!staffHeaders) {
    return jsonResponse(502, { ok: false, error: "staff_not_configured" });
  }

  const entitlement = await gpg.resolveGuestPassEntitlement(ctx.clientId, event, {
    consumerAuthHeaders: ctx.authHeaders,
    staffHeaders,
  });
  if (!entitlement.ok) {
    return jsonResponse(403, { ok: false, error: entitlement.reason || "tier_not_eligible" });
  }

  const memberBooked = await findMemberBookedVisitForClass(ctx.authHeaders, ctx.clientId, classId, {
    staffHeaders,
  });
  if (!memberBooked) {
    return jsonResponse(409, { ok: false, error: "member_not_booked_to_class" });
  }

  const visitStart =
    String(memberBooked.StartDateTime ?? memberBooked.startDateTime ?? "").trim() ||
    (visitStartMsFromRow(memberBooked) != null
      ? new Date(visitStartMsFromRow(memberBooked)).toISOString()
      : "");

  const classFetch = await fetchClassRowForCapacity(staffHeaders, classId, { startDateTime: visitStart });
  const spotsRemaining = classFetch.ok ? classFetch.spotsRemaining : null;
  const capCheck = assertClassEligibleForGuestBooking(spotsRemaining);
  if (!capCheck.ok) {
    return jsonResponse(409, {
      ok: false,
      error: capCheck.reason,
      spotsRemaining: capCheck.spotsRemaining,
      classId,
    });
  }
  const classMeta = classFetch.ok ? classMetaFromRow(classFetch.row) : { name: null, startDateTime: null, instructor: null };

  const store = tryOpenGuestPassBlobStore(event);
  if (!store) {
    return jsonResponse(503, { ok: false, error: "guest_pass_blobs_unavailable" });
  }

  const conflict = await findExistingGuestSlotConflict(store, {
    emailLower: guestEmailLower,
    phoneNorm: guestPhoneNorm,
    periodKey: entitlement.periodKey,
    memberClientId: ctx.clientId,
  });
  if (conflict.conflict) {
    return jsonResponse(409, {
      ok: false,
      error: conflict.reason,
      resetsAt: entitlement.resetsAt,
    });
  }

  const reserve = await reserveGuestPassSlot(store, {
    memberClientId: ctx.clientId,
    periodKey: entitlement.periodKey,
    periodMode: entitlement.periodMode,
    entitlementSku: entitlement.tier,
    guestEmailLower,
    guestPhoneNorm,
    guestFirstName,
    guestLastName,
    classId,
    classDateTime: classMeta.startDateTime,
    className: classMeta.name,
  });
  if (!reserve.ok) {
    return jsonResponse(409, { ok: false, error: reserve.reason, resetsAt: entitlement.resetsAt });
  }

  const guestLookup = await findOrCreateGuestClient({
    firstName: guestFirstName,
    lastName: guestLastName,
    emailLower: guestEmailLower,
    phoneNorm: guestPhoneNorm,
    staffHeaders,
  });

  if (!guestLookup.ok) {
    await failGuestPassSlot(store, {
      memberClientId: ctx.clientId,
      periodKey: entitlement.periodKey,
      reservedKeys: reserve.reservedKeys,
      restore: guestLookup.reason !== "mindbody_guest_create_failed",
      reason: guestLookup.reason,
    });
    if (guestLookup.reason === "guest_lookup_ambiguous") {
      return jsonResponse(409, { ok: false, error: "guest_lookup_ambiguous" });
    }
    if (guestLookup.reason === "mindbody_guest_create_failed") {
      return jsonResponse(502, { ok: false, error: "mindbody_guest_create_failed" });
    }
    return jsonResponse(409, { ok: false, error: guestLookup.reason });
  }

  if (guestLookup.guestClientId === ctx.clientId) {
    await failGuestPassSlot(store, {
      memberClientId: ctx.clientId,
      periodKey: entitlement.periodKey,
      reservedKeys: reserve.reservedKeys,
      restore: true,
      reason: "cannot_invite_self",
    });
    return jsonResponse(400, { ok: false, error: "cannot_invite_self" });
  }

  const alreadyBooked = await isGuestAlreadyBookedToClass({
    guestClientId: guestLookup.guestClientId,
    classId,
    staffHeaders,
  });
  if (alreadyBooked.booked) {
    await failGuestPassSlot(store, {
      memberClientId: ctx.clientId,
      periodKey: entitlement.periodKey,
      reservedKeys: reserve.reservedKeys,
      restore: true,
      reason: "guest_already_booked_to_class",
    });
    return jsonResponse(409, { ok: false, error: "guest_already_booked_to_class" });
  }

  const gpCfg = loadGuestPassConfig();
  const sale = await issueGuestPassCompSale({
    guestClientId: guestLookup.guestClientId,
    staffHeaders,
    test: false,
  });
  if (!sale.ok) {
    await failGuestPassSlot(store, {
      memberClientId: ctx.clientId,
      periodKey: entitlement.periodKey,
      reservedKeys: reserve.reservedKeys,
      restore: false,
      guestClientId: guestLookup.guestClientId,
      reason: "mindbody_sale_failed",
    });
    return jsonResponse(502, { ok: false, error: "mindbody_sale_failed" });
  }

  const creditPick = await pickFreshlyIssuedGuestPassServiceId({
    guestClientId: guestLookup.guestClientId,
    guestPassServiceId: gpCfg.mindbodyServiceId,
    guestPassServiceName: gpCfg.mindbodyServiceName,
    issuedAtIso: sale.issuedAtIso || new Date().toISOString(),
    staffHeaders,
  });
  if (!creditPick.ok) {
    await failGuestPassSlot(store, {
      memberClientId: ctx.clientId,
      periodKey: entitlement.periodKey,
      reservedKeys: reserve.reservedKeys,
      restore: false,
      guestClientId: guestLookup.guestClientId,
      reason: creditPick.reason,
    });
    return jsonResponse(502, { ok: false, error: "mindbody_sale_failed" });
  }

  const bookPayload = {
    ClientId: guestLookup.guestClientId,
    ClassId: classId,
    ClientServiceId: creditPick.clientServiceId,
    SendEmail: false,
    Waitlist: false,
    Test: false,
  };

  const finalClassFetch = await fetchClassRowForCapacity(staffHeaders, classId, { startDateTime: visitStart });
  const finalSpots = finalClassFetch.ok ? finalClassFetch.spotsRemaining : null;
  const finalCapCheck = assertClassEligibleForGuestBooking(finalSpots);
  if (!finalCapCheck.ok) {
    await failGuestPassSlot(store, {
      memberClientId: ctx.clientId,
      periodKey: entitlement.periodKey,
      reservedKeys: reserve.reservedKeys,
      restore: true,
      guestClientId: guestLookup.guestClientId,
      reason: finalCapCheck.reason,
    });
    console.warn(
      JSON.stringify({
        event: "class_book_capacity_blocked",
        classId,
        clientId: guestLookup.guestClientId,
        authSource: "bring_a_friend",
        authMode: "staff",
        waitlist: false,
        bookingPath: "bring_a_friend_guest",
        maxCapacity: finalClassFetch.ok
          ? parseClassCapacitySnapshot(finalClassFetch.row).maxCapacity
          : null,
        totalBooked: finalClassFetch.ok
          ? parseClassCapacitySnapshot(finalClassFetch.row).totalBooked
          : null,
        waitlistAvailable: false,
        spotsRemaining: finalCapCheck.spotsRemaining,
      }),
    );
    return jsonResponse(409, {
      ok: false,
      error: finalCapCheck.reason,
      spotsRemaining: finalCapCheck.spotsRemaining,
      classId,
    });
  }

  const book = await fetchMb(
    "POST",
    `/public/v${MB_API_VERSION}/class/addclienttoclass`,
    staffHeaders,
    bookPayload,
  );
  if (!book.ok) {
    await failGuestPassSlot(store, {
      memberClientId: ctx.clientId,
      periodKey: entitlement.periodKey,
      reservedKeys: reserve.reservedKeys,
      restore: false,
      guestClientId: guestLookup.guestClientId,
      reason: "mindbody_booking_failed",
    });
    return jsonResponse(502, { ok: false, error: "mindbody_booking_failed" });
  }

  const guestVisitId = extractGuestVisitIdFromBookResponse(book.data, classId, guestLookup.guestClientId);
  const requiresInStudioWaiver = guestLookup.matchedBy === "created";

  const confirm = await confirmGuestPassSlot(store, {
    memberClientId: ctx.clientId,
    periodKey: entitlement.periodKey,
    reservedKeys: reserve.reservedKeys,
    guestClientId: guestLookup.guestClientId,
    confirm: {
      period: entitlement.periodKey,
      periodMode: entitlement.periodMode,
      entitlementSku: entitlement.tier,
      memberClientId: ctx.clientId,
      guestClientId: guestLookup.guestClientId,
      guestClientServiceId: creditPick.clientServiceId,
      guestVisitId: guestVisitId ?? undefined,
      guestBookingId: reserve.guestBookingId,
      saleId: sale.saleId ?? undefined,
      classId,
      classDateTime: classMeta.startDateTime || undefined,
      className: classMeta.name || undefined,
      guestFirstName,
      guestLastName,
      guestEmailLower,
      guestPhoneNorm,
      guestResolvedBy: guestLookup.matchedBy,
      requiresInStudioWaiver,
    },
    consentMeta: {
      acceptedByMemberClientId: ctx.clientId,
      ip: clientIp(event) || undefined,
      userAgent: event.headers["user-agent"] || event.headers["User-Agent"] || undefined,
    },
  });

  const classLabel = classMeta.name || "your class";
  const classWhen = classMeta.startDateTime || "";
  const memberFirstName = memberDisplayFirstName(
    typeof ctx.session?.name === "string" ? ctx.session.name : "",
  );
  void sendGuestBookingConfirmationEmail({
    guestEmail: guestEmailLower,
    guestFirstName,
    memberFirstName: memberFirstName || undefined,
    className: classLabel,
    classStartDateTime: classWhen,
    instructor: classMeta.instructor,
    requiresInStudioWaiver,
  });
  if (ctx.email) {
    void sendMemberBookingConfirmationEmail({
      memberEmail: ctx.email,
      guestFirstName,
      guestLastInitial: guestLastInitial(guestLastName),
      className: classLabel,
      classStartDateTime: classWhen,
      instructor: classMeta.instructor,
      periodMode: entitlement.periodMode,
      resetsAt: entitlement.resetsAt,
    });
  }

  const cookieHdr = ctx.setCookie ? { "Set-Cookie": ctx.setCookie } : {};
  return jsonResponse(
    200,
    {
      ok: true,
      status: "booked",
      period: entitlement.periodKey,
      guestClientId: guestLookup.guestClientId,
      guestBookingId: reserve.guestBookingId,
      guestVisitId,
      periodResetsAt: entitlement.resetsAt,
      guestResolvedBy: guestLookup.matchedBy,
      requiresInStudioWaiver,
      bookingConsentText: loadGuestBookingConsentText(),
      ...(confirm.manualReview
        ? { needsManualGuestCapResolution: true, reason: confirm.reason }
        : {}),
    },
    cookieHdr,
  );
}

export const lambdaHandler = withMobileCorsHandler(bringFriendHandler);
export default withLambdaMobileCors(lambdaHandler);
