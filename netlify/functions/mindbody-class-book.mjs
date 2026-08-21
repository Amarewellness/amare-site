import {
  jsonResponse,
  consumerAuthExtraHeaders,
  resolveSessionStudioLinkFlags,
} from "./mindbody-consumer-lib.mjs";
import { resolveStudioCustomer } from "./amare-studio-lib.mjs";
import { withLambdaMobileCors } from "./amare-lambda-mobile-cors.mjs";
import { withMobileCorsHandler } from "./mobile-api-cors.mjs";
import {
  buildBookFailIntentPayload,
  bookFailIntentSetCookieHeader,
} from "./mindbody-pending-book-intent-lib.mjs";
import {
  parseJsonBody,
  listBookableClientServiceIds,
  fetchMergedClientServiceRemainingMap,
  verifyBookPaymentApplied,
  extractVisitIdFromBookResponse,
  extractWaitlistEntryIdFromBookResponse,
  summarizeMindbodyBookError,
  isPaymentRequiredError,
  resolveStaffAuthHeaders,
  noBookableCreditsResponse,
  paymentVerificationFailedResponse,
  rollbackFailedPaymentBooking,
  NO_BOOKABLE_CREDITS_MESSAGE,
  MB_API_VERSION,
  fetchMb,
} from "./mindbody-class-book-lib.mjs";

/**
 * Attach sealed book-fail intent cookie when returning 402 no_bookable_credits.
 * @param {Record<string, string | string[]>} cookieHdr
 * @param {{ classId: number; clientId: number; classStartIso?: string; className?: string; selectedDayKey?: string }} intentFields
 * @param {Record<string, string | string[] | undefined>} eventHeaders
 */
function withBookFailIntentCookie(cookieHdr, intentFields, eventHeaders) {
  const classStartIso =
    typeof intentFields.classStartIso === "string" && intentFields.classStartIso.trim()
      ? intentFields.classStartIso.trim()
      : new Date().toISOString();
  const payload = buildBookFailIntentPayload({
    classId: intentFields.classId,
    clientId: intentFields.clientId,
    classStartIso,
    className: intentFields.className,
    selectedDayKey: intentFields.selectedDayKey,
  });
  const setCookie = bookFailIntentSetCookieHeader(payload, eventHeaders);
  const existing = cookieHdr["Set-Cookie"];
  if (Array.isArray(existing)) {
    cookieHdr["Set-Cookie"] = [...existing, setCookie];
  } else if (typeof existing === "string" && existing) {
    cookieHdr["Set-Cookie"] = [existing, setCookie];
  } else {
    cookieHdr["Set-Cookie"] = setCookie;
  }
  return cookieHdr;
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

  const classStartIsoRaw = body.classStartIso ?? body.classStart;
  const classStartIso =
    typeof classStartIsoRaw === "string" && classStartIsoRaw.trim() ? classStartIsoRaw.trim().slice(0, 40) : undefined;
  const classNameRaw = body.className ?? body.classTitle;
  const className =
    typeof classNameRaw === "string" && classNameRaw.trim() ? classNameRaw.trim().slice(0, 160) : undefined;
  const selectedDayKeyRaw = body.selectedDayKey;
  const selectedDayKey =
    typeof selectedDayKeyRaw === "string" && selectedDayKeyRaw.trim()
      ? selectedDayKeyRaw.trim().slice(0, 32)
      : undefined;

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

  const ctx = await resolveStudioCustomer(event);
  if (!ctx.ok) {
    const status = typeof ctx.response.statusCode === "number" ? ctx.response.statusCode : 500;
    console.warn(
      JSON.stringify({
        event: "class_book_resolve_failed",
        classId,
        status,
        reason: ctx.reason || null,
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
      authSource: ctx.authSource,
    }),
  );

  const cookieHdrFor = () =>
    ctx.authSource === "mindbody" && ctx.consumerCtx ? consumerAuthExtraHeaders(ctx.consumerCtx) : {};

  if (ctx.authSource === "mindbody") {
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
    const cookieHdr = cookieHdrFor();
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

  const staffHeadersForBook =
    ctx.authSource === "amare" ? ctx.authHeaders : await resolveStaffAuthHeaders();
  const { bookableIds, consumerIds, staffIds } = await listBookableClientServiceIds(
    ctx.clientId,
    ctx.authHeaders,
    ctx.authSource === "amare" ? null : staffHeadersForBook,
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
    bookableIds.length > 0 || (clientServiceId != null && bookableIds.includes(clientServiceId));

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
    let cookieHdr = cookieHdrFor();
    if (!waitlist) {
      cookieHdr = withBookFailIntentCookie(
        cookieHdr,
        { classId, clientId: ctx.clientId, classStartIso, className, selectedDayKey },
        event.headers,
      );
    }
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

  const amareStaffOnly = ctx.authSource === "amare";
  /**
   * Final /classes AMARÉ credit book (hasEntitlement already passed).
   * Waitlist stays silent — do not change Added-to-Waitlist mail here.
   * Consumer payment-fallback and Stripe deferred keep SendEmail: false.
   */
  const amareSendReservationEmail = amareStaffOnly && waitlist !== true;
  let r;
  if (amareStaffOnly) {
    const first = explicitServiceId ?? bookableIds[0] ?? null;
    r = await tryBookWith(ctx.authHeaders, first, "staff", amareSendReservationEmail);
    if (first != null) {
      usedServiceId = first;
      triedServiceIds.push(first);
    }
    if (!r.ok) {
      for (const picked of bookableIds) {
        if (usedServiceId === picked) continue;
        triedServiceIds.push(picked);
        r = await tryBookWith(ctx.authHeaders, picked, "staff", amareSendReservationEmail);
        if (r.ok) {
          usedServiceId = picked;
          break;
        }
      }
    }
  } else {
  r =
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
    if (staffHeadersForBook && bookableIds.length > 0) {
      attemptedStaffPaymentFallback = true;
      const idsToTry =
        triedServiceIds.length > 0 ? [...new Set([...triedServiceIds, ...bookableIds])] : bookableIds;

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
      console.warn(
        JSON.stringify({
          event: "class_book_staff_fallback_blocked",
          reason: "no_bookable_client_service_ids",
          classId,
          clientId: ctx.clientId,
          serviceIds: [],
        }),
      );
      let cookieHdr = cookieHdrFor();
      if (!waitlist) {
        cookieHdr = withBookFailIntentCookie(
          cookieHdr,
          { classId, clientId: ctx.clientId, classStartIso, className, selectedDayKey },
          event.headers,
        );
      }
      return noBookableCreditsResponse(cookieHdr, {
        clientId: ctx.clientId,
        mindbodyMessage: summary?.message ?? null,
      });
    }

    if (!r.ok) {
      const cookieHdr = cookieHdrFor();
      if (bookableIds.length === 0) {
        let hdr = cookieHdr;
        if (!waitlist) {
          hdr = withBookFailIntentCookie(
            hdr,
            { classId, clientId: ctx.clientId, classStartIso, className, selectedDayKey },
            event.headers,
          );
        }
        return noBookableCreditsResponse(hdr, {
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
  }

  const summary = summarizeMindbodyBookError(r.data);

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
      const cookieHdr = cookieHdrFor();
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
        mindbodyConfirmationEmail: amareStaffOnly
          ? amareSendReservationEmail
          : attemptedStaffPaymentFallback !== true,
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

  const cookieHdr = cookieHdrFor();
  return jsonResponse(
    r.ok ? 200 : r.status,
    {
      ok: r.ok,
      status: r.status,
      mindbody: r.data,
      ...(r.ok
        ? {
            visitId,
            waitlistEntryId,
            onWaitlist: waitlist,
            classId,
            paymentVerified,
            mindbodyConfirmationEmail: amareStaffOnly
              ? amareSendReservationEmail
              : attemptedStaffPaymentFallback !== true,
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

export const lambdaHandler = withMobileCorsHandler(classBookHandler);
export default withLambdaMobileCors(lambdaHandler);
