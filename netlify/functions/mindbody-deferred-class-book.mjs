/**
 * Staff deferred class booking after Stripe → Mindbody sync (Phase 1).
 * Reuses the same entitlement listing, explicit ClientServiceId staff book,
 * payment verification, and visit rollback as `mindbody-class-book.mjs`.
 */

import { randomUUID } from "node:crypto";

import { refreshAccessToken } from "./oauth-lib.mjs";
import { mindbodyConsumerHeaders } from "./mindbody-upstream.mjs";
import {
  readDeferredBookConsumerAuth,
  isDeferredBookEligibleCta,
  isDeferredBookEligibleSku,
  orderNeedsDeferredBookAttempt,
} from "./mindbody-pending-book-intent-lib.mjs";
import {
  MB_API_VERSION,
  fetchMb,
  listBookableClientServiceIds,
  fetchMergedClientServiceRemainingMap,
  verifyBookPaymentApplied,
  extractVisitIdFromBookResponse,
  summarizeMindbodyBookError,
  resolveStaffAuthHeaders,
  rollbackBookedVisit,
  fetchClientVisitsWindow,
  findVisitRow,
  rebookClassVisitWithConfirmationEmail,
} from "./mindbody-class-book-lib.mjs";

/** @param {string} raw */
function classNoLongerAvailable(raw) {
  const s = String(raw || "").toLowerCase().trim();
  if (!s) return false;
  return (
    /\bclass\s+is\s+full\b/.test(s) ||
    /\bno\s+(?:more\s+)?(?:spots?|seats?|openings?)\b/.test(s) ||
    /\b(?:max(?:imum)?\s+)?capacity\b/.test(s) ||
    /\bcancel(?:l)?ed\b/.test(s) ||
    /\bno\s+longer\s+available\b/.test(s) ||
    /\balready\s+started\b/.test(s) ||
    /\bclass\s+has\s+(?:already\s+)?(?:started|ended|passed)\b/.test(s) ||
    /\bclass\s+not\s+found\b/.test(s) ||
    /\binvalid\s+class\s+id\b/.test(s)
  );
}

/** @param {string} raw */
function classifyUnavailable(raw) {
  const s = String(raw || "").trim();
  const classFull = /\bfull\b|\bcapacity\b|\bno\s+(?:more\s+)?(?:spots?|seats?|openings?)\b/i.test(s);
  const classPast =
    /\balready\s+started\b/i.test(s) ||
    /\bclass\s+has\s+(?:already\s+)?(?:started|ended|passed)\b/i.test(s);
  if (classFull) return "class_full";
  if (classPast) return "class_past";
  if (classNoLongerAvailable(s)) return classPast ? "class_past" : "class_full";
  return "failed";
}

import { classStartInstantHasPassed } from "./mindbody-studio-time.mjs";

/**
 * @param {import("./stripe-order-store.mjs").OrderRecord} order
 * @param {number} clientId
 * @param {ReturnType<import("./stripe-order-store.mjs").openOrderStore>} store
 */
export async function attemptDeferredClassBookForOrder(order, clientId, store) {
  if (!orderNeedsDeferredBookAttempt(order)) {
    return { attempted: false, reason: "not_eligible" };
  }

  const pending = order.pendingBook;
  if (!pending || pending.source !== "book" || pending.waitlist !== false) {
    return { attempted: false, reason: "invalid_pending_book" };
  }

  const classId = pending.classId;
  const attemptId = randomUUID().slice(0, 12);
  const nowIso = new Date().toISOString();
  const prev = order.deferredBook || {};
  const attemptCount = (typeof prev.attemptCount === "number" ? prev.attemptCount : 0) + 1;

  /** @type {import("./stripe-order-store.mjs").OrderRecord["deferredBook"]} */
  const attempting = {
    status: "attempting",
    attemptCount,
    firstAttemptAt: prev.firstAttemptAt || nowIso,
    lastAttemptAt: nowIso,
    lastAttemptId: attemptId,
    mindbodySaleIdAtAttempt: order.mindbodySaleId || null,
  };
  await store.patch(order.orderId, { deferredBook: attempting });

  if (classStartInstantHasPassed(pending.classStartIso)) {
    const result = {
      status: /** @type {const} */ ("class_past"),
      attemptCount,
      firstAttemptAt: attempting.firstAttemptAt,
      lastAttemptAt: nowIso,
      lastAttemptId: attemptId,
      lastError: "class_past",
      lastErrorMessage: "Class already started before deferred book ran.",
    };
    await store.patch(order.orderId, { deferredBook: result });
    console.warn(
      JSON.stringify({
        event: "deferred_class_book_class_past",
        orderId: order.orderId,
        classId,
        clientId,
        classStartIso: pending.classStartIso,
      }),
    );
    return { attempted: true, status: "class_past" };
  }

  const staffHeaders = await resolveStaffAuthHeaders();
  if (!staffHeaders) {
    const result = {
      status: /** @type {const} */ ("failed"),
      attemptCount,
      firstAttemptAt: attempting.firstAttemptAt,
      lastAttemptAt: nowIso,
      lastAttemptId: attemptId,
      lastError: "staff_auth_unavailable",
      lastErrorMessage: "Staff credentials unavailable for deferred booking.",
    };
    await store.patch(order.orderId, { deferredBook: result });
    return { attempted: true, status: "failed" };
  }

  const existingVisits = await fetchClientVisitsWindow(clientId, staffHeaders);
  if (existingVisits.ok) {
    const existingRow = findVisitRow(existingVisits.visits, null, classId);
    if (existingRow) {
      const existingVisitId =
        typeof existingRow.Id === "number"
          ? existingRow.Id
          : typeof existingRow.VisitId === "number"
            ? existingRow.VisitId
            : null;
      const result = {
        status: /** @type {const} */ ("booked"),
        attemptCount,
        firstAttemptAt: attempting.firstAttemptAt,
        lastAttemptAt: nowIso,
        lastAttemptId: attemptId,
        visitId: existingVisitId ?? undefined,
        paymentVerified: true,
        lastError: "already_enrolled",
        lastErrorMessage: "Client already had a visit for this class.",
      };
      await store.patch(order.orderId, { deferredBook: result });
      console.log(
        JSON.stringify({
          event: "deferred_class_book_already_enrolled",
          orderId: order.orderId,
          classId,
          clientId,
          visitId: existingVisitId,
        }),
      );
      return { attempted: true, status: "booked", visitId: existingVisitId };
    }
  }

  const { bookableIds } = await listBookableClientServiceIds(clientId, staffHeaders, staffHeaders);
  if (!bookableIds.length) {
    const result = {
      status: /** @type {const} */ ("no_credits_yet"),
      attemptCount,
      firstAttemptAt: attempting.firstAttemptAt,
      lastAttemptAt: nowIso,
      lastAttemptId: attemptId,
      lastError: "no_bookable_credits_after_sync",
      lastErrorMessage: "No bookable ClientService ids visible after Mindbody sync.",
    };
    await store.patch(order.orderId, { deferredBook: result });
    console.warn(
      JSON.stringify({
        event: "deferred_class_book_no_credits_yet",
        orderId: order.orderId,
        classId,
        clientId,
        sku: order.localSku,
      }),
    );
    return { attempted: true, status: "no_credits_yet" };
  }

  const beforeMap = await fetchMergedClientServiceRemainingMap(clientId, staffHeaders, staffHeaders);
  const path = `/public/v${MB_API_VERSION}/class/addclienttoclass`;

  /** @type {number | null} */
  let usedServiceId = null;
  /** @type {{ ok: boolean; status: number; data: unknown } | null} */
  let bookRes = null;

  for (const picked of bookableIds) {
    console.log(
      JSON.stringify({
        event: "deferred_class_book_staff_attempt",
        orderId: order.orderId,
        classId,
        clientId,
        clientServiceId: picked,
        attemptId,
      }),
    );
    const payload = {
      ClientId: clientId,
      ClassId: classId,
      ClientServiceId: picked,
      SendEmail: false,
      Waitlist: false,
      Test: false,
    };
    const r = await fetchMb("POST", path, staffHeaders, payload);
    if (r.ok) {
      usedServiceId = picked;
      bookRes = r;
      break;
    }
    const summary = summarizeMindbodyBookError(r.data);
    const msg = summary?.message || "";
    if (classNoLongerAvailable(msg)) {
      const status = classifyUnavailable(msg);
      const result = {
        status,
        attemptCount,
        firstAttemptAt: attempting.firstAttemptAt,
        lastAttemptAt: nowIso,
        lastAttemptId: attemptId,
        lastError: status,
        lastErrorMessage: msg.slice(0, 240),
      };
      await store.patch(order.orderId, { deferredBook: result });
      console.warn(
        JSON.stringify({
          event: "deferred_class_book_unavailable",
          orderId: order.orderId,
          classId,
          clientId,
          status,
          mindbodyMessage: msg,
        }),
      );
      return { attempted: true, status };
    }
    bookRes = r;
  }

  if (!bookRes || !bookRes.ok || usedServiceId == null) {
    const summary = summarizeMindbodyBookError(bookRes?.data);
    const msg = summary?.message || "Mindbody book failed.";
    const status = classNoLongerAvailable(msg) ? classifyUnavailable(msg) : "failed";
    const result = {
      status: status === "class_full" || status === "class_past" ? status : "failed",
      attemptCount,
      firstAttemptAt: attempting.firstAttemptAt,
      lastAttemptAt: nowIso,
      lastAttemptId: attemptId,
      lastError: "mindbody_book_failed",
      lastErrorMessage: msg.slice(0, 240),
    };
    await store.patch(order.orderId, { deferredBook: result });
    console.warn(
      JSON.stringify({
        event: "deferred_class_book_failed",
        orderId: order.orderId,
        classId,
        clientId,
        status: result.status,
        mindbodyMessage: msg,
      }),
    );
    return { attempted: true, status: result.status };
  }

  const visitId = extractVisitIdFromBookResponse(bookRes.data, classId);
  const verify = await verifyBookPaymentApplied({
    clientId,
    classId,
    visitId,
    usedServiceId,
    bookableIds,
    beforeMap,
    bookResponseData: bookRes.data,
    consumerHeaders: staffHeaders,
    staffHeaders,
    attemptedStaffPaymentFallback: true,
  });

  if (!verify.ok) {
    if (visitId != null && visitId > 0) {
      const rollback = await rollbackBookedVisit({
        clientId,
        classId,
        visitId,
        consumerHeaders: staffHeaders,
        staffHeaders,
      });
      console.warn(
        JSON.stringify({
          event: "deferred_class_book_rollback",
          orderId: order.orderId,
          classId,
          clientId,
          visitId,
          verifyReason: verify.reason ?? null,
          rollbackOk: rollback.ok,
        }),
      );
    }
    const errorStatus =
      verify.errorCode === "unpaid_visit_detected" ? "payment_not_applied" : "payment_not_applied";
    const result = {
      status: /** @type {const} */ (errorStatus),
      attemptCount,
      firstAttemptAt: attempting.firstAttemptAt,
      lastAttemptAt: nowIso,
      lastAttemptId: attemptId,
      visitId: visitId ?? undefined,
      usedClientServiceId: usedServiceId,
      paymentVerified: false,
      lastError: verify.errorCode || "payment_not_applied",
      lastErrorMessage: (verify.reason || "payment verification failed").slice(0, 240),
    };
    await store.patch(order.orderId, { deferredBook: result });
    return { attempted: true, status: errorStatus };
  }

  /** @type {number | null | undefined} */
  let finalVisitId = visitId;
  let mindbodyConfirmationEmailSent = false;
  let confirmationEmailPending = false;
  if (visitId != null && visitId > 0 && usedServiceId != null) {
    const consumerHeaders = await consumerHeadersFromOrderAuth(order, clientId);
    const emailBookHeaders = consumerHeaders ?? staffHeaders;
    const authMode = consumerHeaders ? "consumer" : "staff";
    const emailRes = await rebookClassVisitWithConfirmationEmail({
      clientId,
      classId,
      visitId,
      clientServiceId: usedServiceId,
      bookHeaders: emailBookHeaders,
      rollbackHeaders: emailBookHeaders,
      staffHeaders,
    });
    if (emailRes.visitId != null) finalVisitId = emailRes.visitId;
    /** Staff token returns HTTP 200 but does not emit Reservation Confirmation emails. */
    mindbodyConfirmationEmailSent =
      authMode === "consumer" && emailRes.ok && emailRes.mindbodyConfirmationEmail === true;
    confirmationEmailPending = !mindbodyConfirmationEmailSent;
    console.log(
      JSON.stringify({
        event: mindbodyConfirmationEmailSent
          ? "deferred_class_book_confirmation_email_sent"
          : "deferred_class_book_confirmation_email_pending",
        orderId: order.orderId,
        classId,
        clientId,
        visitId: finalVisitId,
        emailReason: emailRes.reason ?? null,
        authMode,
        restoreOk: emailRes.restoreOk ?? null,
        hasCheckoutConsumerAuth: Boolean(order.deferredBookConsumerAuthSealed),
      }),
    );
  }

  const result = {
    status: /** @type {const} */ ("booked"),
    attemptCount,
    firstAttemptAt: attempting.firstAttemptAt,
    lastAttemptAt: nowIso,
    lastAttemptId: attemptId,
    visitId: finalVisitId ?? undefined,
    usedClientServiceId: usedServiceId,
    paymentVerified: true,
    mindbodyConfirmationEmailSent,
    confirmationEmailPending,
  };
  await store.patch(order.orderId, { deferredBook: result });
  console.log(
    JSON.stringify({
      event: "deferred_class_book_success",
      orderId: order.orderId,
      classId,
      clientId,
      visitId: finalVisitId,
      usedClientServiceId: usedServiceId,
      verifyReason: verify.reason ?? null,
      mindbodyConfirmationEmailSent,
    }),
  );
  return {
    attempted: true,
    status: "booked",
    visitId: finalVisitId,
    usedClientServiceId: usedServiceId,
    mindbodyConfirmationEmailSent,
  };
}

const DEFERRED_BOOK_ORDER_RELOAD_MS = 150;
const DEFERRED_BOOK_ORDER_RELOAD_ATTEMPTS = 3;

/**
 * Re-read the order from the store after Mindbody sync. Production Netlify Blobs can lag
 * behind an in-memory copy in the same webhook; merge `hints` so deferred book never sees a
 * stale `mindbodySyncStatus`.
 *
 * @param {ReturnType<import("./stripe-order-store.mjs").openOrderStore>} store
 * @param {string} orderId
 * @param {Partial<import("./stripe-order-store.mjs").OrderRecord>=} hints
 * @returns {Promise<import("./stripe-order-store.mjs").OrderRecord | null>}
 */
export async function reloadOrderForDeferredBook(store, orderId, hints) {
  /** @type {import("./stripe-order-store.mjs").OrderRecord | null} */
  let last = null;
  for (let attempt = 0; attempt < DEFERRED_BOOK_ORDER_RELOAD_ATTEMPTS; attempt += 1) {
    try {
      const row = await store.get(orderId);
      if (row && typeof row === "object") {
        last = {
          ...row,
          ...(hints || {}),
          orderId: row.orderId || orderId,
        };
        if (last.mindbodySyncStatus === "mindbody_synced") return last;
      }
    } catch {
      /* retry */
    }
    if (attempt + 1 < DEFERRED_BOOK_ORDER_RELOAD_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, DEFERRED_BOOK_ORDER_RELOAD_MS));
    }
  }
  if (last) {
    return {
      ...last,
      ...(hints || {}),
      orderId: last.orderId || orderId,
    };
  }
  return null;
}

/**
 * @param {string} orderId
 * @param {number} clientId
 * @param {string} reason
 * @param {Record<string, unknown>=} extra
 */
function logDeferredBookSkipped(orderId, clientId, reason, extra) {
  console.warn(
    JSON.stringify({
      event: "deferred_class_book_skipped",
      orderId,
      clientId,
      reason,
      ...extra,
    }),
  );
}

/**
 * Post-sync entry point: reload order, ensure deferredBook shell exists, attempt staff book.
 *
 * @param {ReturnType<import("./stripe-order-store.mjs").openOrderStore>} store
 * @param {string} orderId
 * @param {number} clientId
 */
export async function runDeferredBookAfterMindbodySync(store, orderId, clientId) {
  const hints = {
    mindbodySyncStatus: /** @type {const} */ ("mindbody_synced"),
    resolvedMindbodyClientId: clientId,
  };
  let order = await reloadOrderForDeferredBook(store, orderId, hints);
  if (!order) {
    logDeferredBookSkipped(orderId, clientId, "order_reload_failed");
    return { attempted: false, reason: "order_reload_failed" };
  }
  if (!order.pendingBook) {
    logDeferredBookSkipped(orderId, clientId, "no_pending_book", {
      ctaLocation: order.ctaLocation ?? null,
      localSku: order.localSku ?? null,
    });
    return { attempted: false, reason: "no_pending_book" };
  }
  if (!order.deferredBook) {
    await store.patch(orderId, {
      deferredBook: { status: "pending", attemptCount: 0 },
      resolvedMindbodyClientId: clientId,
    });
    order = (await reloadOrderForDeferredBook(store, orderId, hints)) || order;
  }
  if (!orderNeedsDeferredBookAttempt(order)) {
    logDeferredBookSkipped(orderId, clientId, "not_eligible", {
      mindbodySyncStatus: order.mindbodySyncStatus ?? null,
      deferredBookStatus: order.deferredBook?.status ?? null,
      ctaLocation: order.ctaLocation ?? null,
      localSku: order.localSku ?? null,
    });
    return { attempted: false, reason: "not_eligible" };
  }
  const result = await maybeAttemptDeferredClassBook(order, clientId, store);
  if (!result.attempted) {
    logDeferredBookSkipped(orderId, clientId, result.reason || "unknown", {
      mindbodySyncStatus: order.mindbodySyncStatus ?? null,
      hasPendingBook: Boolean(order.pendingBook),
      deferredBookStatus: order.deferredBook?.status ?? null,
    });
  }
  return result;
}

/**
 * @param {import("./stripe-order-store.mjs").OrderRecord} order
 * @param {number} clientId
 * @param {ReturnType<import("./stripe-order-store.mjs").openOrderStore>} store
 */
export async function maybeAttemptDeferredClassBook(order, clientId, store) {
  if (!isDeferredBookEligibleCta(order.ctaLocation) || !isDeferredBookEligibleSku(order.localSku)) {
    return { attempted: false, reason: "scope" };
  }
  if (order.mindbodySyncStatus !== "mindbody_synced") {
    return { attempted: false, reason: "sync_not_complete" };
  }
  return attemptDeferredClassBookForOrder(order, clientId, store);
}

export { orderNeedsDeferredBookAttempt };

/**
 * @param {import("./stripe-order-store.mjs").OrderRecord} order
 * @param {number} clientId
 * @returns {Promise<Record<string, string> | null>}
 */
async function consumerHeadersFromOrderAuth(order, clientId) {
  const sealed = order.deferredBookConsumerAuthSealed;
  if (typeof sealed !== "string" || !sealed.trim()) return null;
  const auth = readDeferredBookConsumerAuth(sealed, clientId);
  if (!auth) return null;
  try {
    const tokens = await refreshAccessToken(auth.refresh_token);
    const accessToken = tokens.access_token;
    if (!accessToken) return null;
    return mindbodyConsumerHeaders(accessToken);
  } catch {
    return null;
  }
}

/**
 * @param {{
 *   order: import("./stripe-order-store.mjs").OrderRecord;
 *   clientId: number;
 *   consumerHeaders: Record<string, string>;
 *   staffHeaders: Record<string, string>;
 * }} opts
 */
export async function sendDeferredBookReservationEmail(opts) {
  const order = opts.order;
  const db = order.deferredBook;
  const pending = order.pendingBook;
  if (!db || db.status !== "booked" || !pending) {
    return { ok: false, reason: "not_booked" };
  }
  if (db.mindbodyConfirmationEmailSent === true) {
    return { ok: true, noop: true, reason: "already_sent" };
  }
  const visitId = typeof db.visitId === "number" ? db.visitId : null;
  const usedServiceId = typeof db.usedClientServiceId === "number" ? db.usedClientServiceId : null;
  if (visitId == null || visitId <= 0 || usedServiceId == null) {
    return { ok: false, reason: "missing_visit_or_service" };
  }

  const emailRes = await rebookClassVisitWithConfirmationEmail({
    clientId: opts.clientId,
    classId: pending.classId,
    visitId,
    clientServiceId: usedServiceId,
    bookHeaders: opts.consumerHeaders,
    rollbackHeaders: opts.consumerHeaders,
    staffHeaders: opts.staffHeaders,
  });

  return {
    ok: emailRes.ok,
    reason: emailRes.reason ?? null,
    visitId: emailRes.visitId ?? visitId,
    mindbodyConfirmationEmail: emailRes.mindbodyConfirmationEmail === true,
    authMode: "consumer",
  };
}
