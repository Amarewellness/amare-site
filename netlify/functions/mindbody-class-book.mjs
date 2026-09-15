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
  loadMergedClientServiceRows,
  persistUnlimitedFeeAcknowledgment,
  publicCancellationPolicy,
  resolveBookingCancellationPolicy,
  unlimitedFeeAcknowledgmentFromBody,
} from "./booking-cancellation-policy-lib.mjs";
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
  noCreditsValidForClassDateResponse,
  paymentVerificationFailedResponse,
  rollbackFailedPaymentBooking,
  NO_BOOKABLE_CREDITS_MESSAGE,
  MB_API_VERSION,
  fetchMb,
  assertStaffNormalSeatBeforeBook,
  classBookCapacityBlockedBody,
  resolveBookConfirmationEmailFields,
  resolveBookingConfirmationRecipient,
  fetchMindbodyClientEmailById,
  resolveAuthoritativeClassStartForBooking,
  filterBookableIdsForClassDate,
} from "./mindbody-class-book-lib.mjs";
import { sendMemberClassBookingConfirmationEmail } from "./guest-pass-emails.mjs";

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

/**
 * Normal non-waitlist bookings must not trigger Mindbody reservation email before payment verify.
 * Waitlist behavior is unchanged: consumer waitlist may still use Mindbody Added-to-Waitlist mail.
 *
 * @param {"consumer" | "staff"} authMode
 * @param {boolean} waitlistBooking
 */
function tentativeBookSendEmail(authMode, waitlistBooking) {
  if (waitlistBooking) return authMode === "consumer";
  return false;
}

/** @param {Record<string, unknown>} ctx @param {Record<string, unknown>} body */
function resolveMemberFirstNameForEmail(ctx, body) {
  const fromBody = body.memberFirstName ?? body.firstName;
  if (typeof fromBody === "string" && fromBody.trim()) return fromBody.trim().slice(0, 80);
  const sess = ctx.session && typeof ctx.session === "object" ? ctx.session : {};
  const fromSess =
    /** @type {Record<string, unknown>} */ (sess).FirstName ??
    sess.firstName ??
    sess.given_name ??
    sess.name;
  if (typeof fromSess === "string" && fromSess.trim()) {
    const trimmed = fromSess.trim();
    return trimmed.split(/\s+/)[0]?.slice(0, 80) || trimmed.slice(0, 80);
  }
  return "";
}

/**
 * Shared post-verify confirmation for normal (non-waitlist) bookings.
 * Email failure must not roll back the verified visit.
 *
 * @param {{
 *   classId: number;
 *   clientId: number;
 *   visitId: number | null;
 *   memberEmail: string | null | undefined;
 *   recipientSource?: string | null;
 *   memberFirstName: string;
 *   className: string;
 *   classStartIso: string;
 *   instructor?: string | null;
 * }} opts
 */
async function sendVerifiedClassBookingConfirmationEmail(opts) {
  const started = Date.now();
  /** @type {{ ok: boolean; error?: string }} */
  let emailResult = { ok: false, error: "missing_member_email" };
  if (typeof opts.memberEmail === "string" && opts.memberEmail.includes("@")) {
    emailResult = await sendMemberClassBookingConfirmationEmail({
      memberEmail: opts.memberEmail.trim(),
      memberFirstName: opts.memberFirstName,
      className: opts.className,
      classStartDateTime: opts.classStartIso || new Date().toISOString(),
      instructor: opts.instructor,
    });
  }
  console.log(
    JSON.stringify({
      event: "class_book_confirmation_email_result",
      classId: opts.classId,
      clientId: opts.clientId,
      visitId: opts.visitId,
      provider: "resend",
      recipientSource: opts.recipientSource ?? null,
      ok: emailResult.ok === true,
      errorCode: emailResult.ok ? null : emailResult.error ?? "send_failed",
      elapsedMs: Date.now() - started,
    }),
  );
  return emailResult;
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
  async function tryBookWith(
    authHeaders,
    cs,
    authMode,
    sendEmail = tentativeBookSendEmail(authMode, waitlist),
  ) {
    /** @type {Record<string, unknown>} */
    const payload = {
      ClientId: ctx.clientId,
      ClassId: classId,
      SendEmail: sendEmail,
      Waitlist: waitlist,
      Test: false,
    };
    const requirePayment = cs != null && !waitlist;
    if (cs != null) payload.ClientServiceId = cs;
    if (requirePayment) payload.RequirePayment = true;
    console.log(
      JSON.stringify({
        event: "class_book_addclienttoclass_attempt",
        classId,
        clientId: ctx.clientId,
        authMode,
        clientServiceId: cs,
        requirePayment,
        sendEmail,
      }),
    );
    return fetchMb("POST", path, authHeaders, payload);
  }

  const staffHeadersForBook =
    ctx.authSource === "amare" ? ctx.authHeaders : await resolveStaffAuthHeaders();

  const policyRows = await loadMergedClientServiceRows(
    ctx.clientId,
    ctx.authHeaders,
    ctx.authSource === "amare" ? null : staffHeadersForBook,
  );
  const cancellationPolicy = resolveBookingCancellationPolicy(policyRows);
  const policyAck = unlimitedFeeAcknowledgmentFromBody(body, cancellationPolicy);
  if (!policyAck.ok) {
    console.warn(
      JSON.stringify({
        event: "class_book_unlimited_policy_ack_required",
        classId,
        clientId: ctx.clientId,
        waitlist,
        policyVersion: policyAck.policyVersion,
      }),
    );
    return jsonResponse(
      400,
      {
        ok: false,
        error: "unlimited_policy_ack_required",
        message:
          "Please confirm the Unlimited member late-cancellation and no-show fee policy before booking.",
        cancellationPolicy: publicCancellationPolicy(cancellationPolicy),
      },
      cookieHdrFor(),
    );
  }

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

  /** @type {{ ok: boolean; classStartIso: string | null; classDayKey: string | null; row: Record<string, unknown> | null }} */
  let authoritativeClass = { ok: false, classStartIso: null, classDayKey: null, row: null };
  if (!waitlist && staffHeadersForBook) {
    authoritativeClass = await resolveAuthoritativeClassStartForBooking(
      staffHeadersForBook,
      classId,
      classStartIso,
    );
    if (!authoritativeClass.ok || !authoritativeClass.classDayKey) {
      console.warn(
        JSON.stringify({
          event: "class_book_authoritative_class_lookup_failed",
          classId,
          clientId: ctx.clientId,
        }),
      );
      const classLookupRetryMessage =
        "We couldn't verify class availability right now. Please refresh the schedule and try again.";
      return jsonResponse(
        503,
        {
          ok: false,
          error: "capacity_check_failed",
          reason: "class_lookup_failed",
          message: classLookupRetryMessage,
          /** Released iOS/Android read `detail` for human-readable copy (not `message`). */
          detail: classLookupRetryMessage,
        },
        cookieHdrFor(),
      );
    }
  }

  const classDateBookableIds =
    !waitlist && authoritativeClass.classDayKey
      ? filterBookableIdsForClassDate(policyRows, bookableIds, authoritativeClass.classDayKey)
      : bookableIds;

  if (!waitlist && authoritativeClass.classDayKey) {
    console.log(
      JSON.stringify({
        event: "class_book_service_date_eligibility",
        classId,
        authoritativeClassStart: authoritativeClass.classStartIso,
        candidateServiceCount: bookableIds.length,
        eligibleServiceCount: classDateBookableIds.length,
        selectedClientServiceId: null,
        rejectionReason:
          bookableIds.length > 0 && classDateBookableIds.length === 0
            ? "service_not_valid_for_class_date"
            : null,
      }),
    );
  }

  if (!waitlist && bookableIds.length > 0 && classDateBookableIds.length === 0) {
    return noCreditsValidForClassDateResponse(cookieHdrFor(), {
      clientId: ctx.clientId,
      classId,
      authoritativeClassStart: authoritativeClass.classStartIso,
    });
  }

  const bookingServiceIds = !waitlist ? classDateBookableIds : bookableIds;

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
    clientServiceId != null && bookingServiceIds.includes(clientServiceId) ? clientServiceId : null;

  let attemptedClientServiceFallback = false;
  let attemptedStaffPaymentFallback = false;
  /** @type {number[]} */
  let triedServiceIds = [];
  /** @type {number | null} */
  let usedServiceId = null;

  const amareStaffOnly = ctx.authSource === "amare";

  /** @param {"amare_direct" | "staff_payment_fallback"} bookingPath @param {Record<string, string>} staffHeaders */
  async function guardStaffNormalSeat(bookingPath, staffHeaders) {
    if (waitlist) return null;
    const cap = await assertStaffNormalSeatBeforeBook(staffHeaders, classId, {
      waitlist,
      startDateTime: authoritativeClass.classStartIso ?? classStartIso,
      clientId: ctx.clientId,
      authSource: ctx.authSource,
      authMode: "staff",
      bookingPath,
      prefetchedRow: authoritativeClass.row,
    });
    if (cap.ok) return null;
    const status = cap.reason === "capacity_fetch_failed" ? 503 : 409;
    return jsonResponse(status, classBookCapacityBlockedBody(cap), cookieHdrFor());
  }

  let r;
  if (amareStaffOnly) {
    const blocked = await guardStaffNormalSeat("amare_direct", ctx.authHeaders);
    if (blocked) return blocked;

    const first = explicitServiceId ?? bookingServiceIds[0] ?? null;
    r = await tryBookWith(ctx.authHeaders, first, "staff", tentativeBookSendEmail("staff", waitlist));
    if (first != null) {
      usedServiceId = first;
      triedServiceIds.push(first);
    }
    if (!r.ok) {
      for (const picked of bookingServiceIds) {
        if (usedServiceId === picked) continue;
        triedServiceIds.push(picked);
        r = await tryBookWith(ctx.authHeaders, picked, "staff", tentativeBookSendEmail("staff", waitlist));
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
    const consumerIdsToTry = consumerIds.length > 0 ? consumerIds.filter((id) => bookingServiceIds.includes(id)) : bookingServiceIds;
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
    if (staffHeadersForBook && bookingServiceIds.length > 0) {
      const blocked = await guardStaffNormalSeat("staff_payment_fallback", staffHeadersForBook);
      if (blocked) return blocked;

      attemptedStaffPaymentFallback = true;
      const idsToTry =
        triedServiceIds.length > 0
          ? [...new Set([...triedServiceIds, ...bookingServiceIds])]
          : bookingServiceIds;

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
    } else if (staffHeadersForBook && bookingServiceIds.length === 0) {
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
      if (bookingServiceIds.length === 0) {
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
        hasBookableCredits: bookableIds.length > 0,
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
  /**
   * Legacy response field name retained for released iOS/Android/Web clients.
   * Operationally means "booking confirmation email was successfully sent" (AMARÉ/Resend).
   */
  let mindbodyConfirmationEmail = false;

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
      bookableIds: bookingServiceIds,
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
    const emailFields = resolveBookConfirmationEmailFields({
      bookData: r.data,
      classId,
      bodyClassName: className,
      bodyStartIso: classStartIso,
      bodyInstructor:
        typeof (body.instructorName ?? body.instructor) === "string"
          ? String(body.instructorName ?? body.instructor)
          : undefined,
    });
    const recipient = await resolveBookingConfirmationRecipient({
      clientId: ctx.clientId,
      amareUserId: ctx.amareUserId ?? null,
      amareLinkedClientId: ctx.amareLinkedClientId ?? null,
      amareSessionEmail: ctx.amareSessionEmail ?? null,
      consumerEmail: ctx.consumerEmail ?? null,
      lookupMindbodyClientEmail: ctx.authHeaders
        ? async (id) => fetchMindbodyClientEmailById(id, ctx.authHeaders)
        : null,
    });
    const emailResult = await sendVerifiedClassBookingConfirmationEmail({
      classId,
      clientId: ctx.clientId,
      visitId,
      memberEmail: recipient.email,
      recipientSource: recipient.source,
      memberFirstName: resolveMemberFirstNameForEmail(ctx, body),
      className: emailFields.className,
      classStartIso: emailFields.classStartIso,
      instructor: emailFields.instructor,
    });
    mindbodyConfirmationEmail = emailResult.ok === true;
    console.log(
      JSON.stringify({
        event: "class_book_payment_verified",
        classId,
        clientId: ctx.clientId,
        visitId,
        usedServiceId,
        attemptedStaffPaymentFallback,
        verifyReason: verify.reason ?? null,
        mindbodyConfirmationEmail,
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
      mindbodyConfirmationEmail: r.ok && !waitlist ? mindbodyConfirmationEmail : undefined,
      mindbodyErrorMessage: summary?.message ?? null,
      mindbodyErrorCode: summary?.code ?? null,
      cancellationPolicyKind: cancellationPolicy.kind,
      policyVersion: policyAck.ok ? policyAck.policyVersion : null,
    }),
  );

  /** @type {string | null} */
  let recordedPolicyVersion = null;
  if (r.ok && cancellationPolicy.kind === "unlimited_fee" && policyAck.ok) {
    const acknowledgedAt = new Date().toISOString();
    const ackRecord = {
      amareUserId: ctx.amareUserId || null,
      mindbodyClientId: ctx.clientId,
      classId,
      visitId: visitId || null,
      waitlistEntryId: waitlistEntryId || null,
      acknowledgedAt,
      policyVersion: policyAck.policyVersion,
    };
    const persisted = await persistUnlimitedFeeAcknowledgment(event, ackRecord);
    recordedPolicyVersion = policyAck.policyVersion;
    console.log(
      JSON.stringify({
        event: "class_book_unlimited_policy_ack_recorded",
        classId,
        clientId: ctx.clientId,
        visitId,
        waitlistEntryId,
        policyVersion: recordedPolicyVersion,
        persisted: persisted.ok,
        ackKey: persisted.key,
      }),
    );
  }

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
            mindbodyConfirmationEmail,
            ...(recordedPolicyVersion ? { policyVersion: recordedPolicyVersion } : {}),
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
