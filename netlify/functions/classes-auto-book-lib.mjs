/**
 * /classes auto-book after successful Mindbody sync (webhook-only).
 * Booking uses Mindbody lookup at webhook time — never at create-session.
 */

import {
  fetchClassRowForCapacity,
  classMetaFromRow,
} from "./guest-pass-lib.mjs";
import { classStartInstantHasPassed, formatClassWhenEt } from "./mindbody-studio-time.mjs";
import { sendClassesBookingFailureAdminEmail } from "./deferred-book-admin-email.mjs";
import {
  isDeferredBookEligibleCta,
  isDeferredBookEligibleSku,
} from "./mindbody-pending-book-intent-lib.mjs";
import {
  attemptDeferredClassBookForOrder,
  reloadOrderForDeferredBook,
} from "./mindbody-deferred-class-book.mjs";
import {
  resolveStaffAuthHeaders,
  fetchClientVisitsWindow,
  findVisitRow,
} from "./mindbody-class-book-lib.mjs";
import { getCatalogItem } from "./stripe-catalog-lib.mjs";

/** @typedef {"pending"|"processing"|"booked"|"already_enrolled"|"failed"} ClassesAutoBookStatus */

const AUTO_BOOK_TERMINAL = new Set(["processing", "booked", "already_enrolled", "failed"]);

/**
 * @param {unknown} body
 */
export function parseSelectedClassFromBody(body) {
  if (!body || typeof body !== "object") return null;
  const b = /** @type {Record<string, unknown>} */ (body);
  const raw = b.selectedClass ?? b.selected_class;
  if (!raw || typeof raw !== "object") return null;
  const sc = /** @type {Record<string, unknown>} */ (raw);
  const classIdRaw = sc.classId ?? sc.ClassId;
  const classId =
    typeof classIdRaw === "number"
      ? classIdRaw
      : typeof classIdRaw === "string"
        ? parseInt(classIdRaw, 10)
        : NaN;
  if (!Number.isFinite(classId) || classId <= 0) return null;
  return {
    classId: Math.trunc(classId),
    classStartIso:
      typeof sc.classStartIso === "string"
        ? sc.classStartIso.trim().slice(0, 40)
        : typeof sc.classStart === "string"
          ? sc.classStart.trim().slice(0, 40)
          : "",
    className: typeof sc.className === "string" ? sc.className.trim().slice(0, 160) : null,
    instructorName:
      typeof sc.instructorName === "string" ? sc.instructorName.trim().slice(0, 120) : null,
    selectedDayKey: typeof sc.selectedDayKey === "string" ? sc.selectedDayKey.trim().slice(0, 32) : null,
  };
}

/**
 * @param {ReturnType<typeof parseSelectedClassFromBody>} selectedClass
 * @param {string} capturedAt
 */
export function buildSelectedClassContext(selectedClass, capturedAt) {
  if (!selectedClass) return null;
  return {
    classId: selectedClass.classId,
    reportedClassStartIso: selectedClass.classStartIso || null,
    className: selectedClass.className,
    instructorName: selectedClass.instructorName,
    selectedDayKey: selectedClass.selectedDayKey,
    capturedAt,
  };
}

/**
 * @param {unknown} body
 * @param {string | null} ctaLocation
 */
export function derivePurchaseSource(body, ctaLocation) {
  const b = body && typeof body === "object" ? /** @type {Record<string, unknown>} */ (body) : {};
  const ps = typeof b.purchaseSource === "string" ? b.purchaseSource.trim().toLowerCase() : "";
  if (ps === "classes") return "classes";
  if (ps === "pricing") return "pricing";
  if (
    ctaLocation === "classes_anonymous_book_packages" ||
    ctaLocation === "classes_booking_fail_packages"
  ) {
    return "classes";
  }
  if (typeof ctaLocation === "string" && ctaLocation.startsWith("pricing_")) return "pricing";
  return parseSelectedClassFromBody(body) ? "classes" : "unknown";
}

/**
 * @param {import("./stripe-order-store.mjs").OrderRecord} order
 */
export function orderExpectsClassesAutoBook(order) {
  if (order.purchaseSource === "classes") return true;
  if (order.selectedClassContext?.classId) return true;
  if (
    order.pendingBook &&
    isDeferredBookEligibleCta(order.ctaLocation) &&
    isDeferredBookEligibleSku(order.localSku)
  ) {
    return true;
  }
  return false;
}

/**
 * @param {ReturnType<typeof openOrderStore>} store
 * @param {string} orderId
 */
async function tryAcquireOrderAutoBook(store, orderId) {
  if (!store.mutate) {
    return { acquired: false, reason: "store_mutate_unavailable" };
  }
  const result = await store.mutate(orderId, (cur) => {
    const st = cur.classesAutoBook?.status;
    if (st && AUTO_BOOK_TERMINAL.has(st)) return null;
    const now = new Date().toISOString();
    return {
      ...cur,
      classesAutoBook: {
        status: /** @type {ClassesAutoBookStatus} */ ("processing"),
        attemptedAt: now,
        completedAt: null,
        result: null,
        reason: null,
      },
    };
  });
  if (!result.ok || !result.modified) {
    return { acquired: false, reason: result.ok ? "already_claimed" : result.reason };
  }
  return { acquired: true, record: result.record };
}

/**
 * @param {ReturnType<typeof openOrderStore>} store
 * @param {string} orderId
 * @param {ClassesAutoBookStatus} status
 * @param {string | null} result
 * @param {string | null} reason
 */
async function finalizeOrderAutoBook(store, orderId, status, result, reason) {
  const cur = await store.get(orderId);
  const now = new Date().toISOString();
  await store.patch(orderId, {
    classesAutoBook: {
      status,
      attemptedAt: cur?.classesAutoBook?.attemptedAt || now,
      completedAt: now,
      result,
      reason,
    },
  });
}

/**
 * @param {number} classId
 * @param {string | null | undefined} hintStartIso
 */
async function resolveClassFromMindbody(classId, hintStartIso) {
  const staffHeaders = await resolveStaffAuthHeaders();
  if (!staffHeaders) {
    return { ok: false, reason: "staff_auth_unavailable" };
  }
  const lookup = await fetchClassRowForCapacity(staffHeaders, classId, {
    startDateTime: hintStartIso || undefined,
  });
  if (!lookup.ok || !lookup.row) {
    return { ok: false, reason: "class_not_found" };
  }
  const meta = classMetaFromRow(lookup.row);
  const serverStart = meta.startDateTime;
  if (!serverStart) {
    return { ok: false, reason: "class_missing_start_time" };
  }
  if (classStartInstantHasPassed(serverStart)) {
    return {
      ok: false,
      reason: "class_past",
      serverStart,
      className: meta.name,
      instructorName: meta.instructor,
    };
  }
  return {
    ok: true,
    serverStart,
    className: meta.name,
    instructorName: meta.instructor,
  };
}

/**
 * @param {import("./stripe-order-store.mjs").OrderRecord} order
 * @param {number} clientId
 */
async function clientAlreadyEnrolled(order, clientId, classId) {
  const staffHeaders = await resolveStaffAuthHeaders();
  if (!staffHeaders) return false;
  const existingVisits = await fetchClientVisitsWindow(clientId, staffHeaders);
  if (!existingVisits.ok) return false;
  return Boolean(findVisitRow(existingVisits.visits, null, classId));
}

/**
 * @param {ReturnType<typeof openOrderStore>} store
 * @param {import("./stripe-order-store.mjs").OrderRecord} order
 * @param {string} reason
 * @param {{ paymentSucceeded?: boolean; mindbodySyncSucceeded?: boolean; mindbodySaleId?: string | null }} meta
 */
async function maybeSendOrderAdminEmail(store, order, reason, meta) {
  if (!store.mutate) return { skipped: true, reason: "store_mutate_unavailable" };

  const cab = order.classesAutoBook;
  if (cab?.status === "booked" || cab?.status === "already_enrolled") return { skipped: true };

  const classId = order.selectedClassContext?.classId ?? order.pendingBook?.classId ?? null;
  if (classId != null) {
    const clientId = order.resolvedMindbodyClientId ?? order.knownMindbodyClientId;
    if (typeof clientId === "number" && clientId > 0) {
      const enrolled = await clientAlreadyEnrolled(order, clientId, classId);
      if (enrolled) return { skipped: true, reason: "already_enrolled" };
    }
  }

  const acquire = await store.mutate(order.orderId, (cur) => {
    const em = cur.bookingFailureAdminEmail;
    const st = em?.status || "not_sent";
    if (st === "sent" || st === "sending") return null;
    if (st !== "not_sent" && st !== "failed") return null;
    return {
      ...cur,
      bookingFailureAdminEmail: {
        ...em,
        status: /** @type {const} */ ("sending"),
        attemptedAt: new Date().toISOString(),
        sentAt: em?.sentAt ?? null,
        reason,
        lastError: null,
        checkoutSessionId: cur.stripeCheckoutSessionId || null,
        firstInvoiceId: null,
      },
    };
  });
  if (!acquire.ok || !acquire.modified) {
    return { skipped: true, reason: acquire.ok ? "email_already_claimed" : acquire.reason };
  }

  const cur = acquire.record;
  const item = getCatalogItem(cur.localSku || "");
  const ctx = cur.selectedClassContext;
  const send = await sendClassesBookingFailureAdminEmail({
    clientName: cur.customerName || null,
    clientEmail: cur.customerEmail || null,
    clientPhone: cur.customerPhone || null,
    mindbodyClientId: cur.resolvedMindbodyClientId ?? cur.knownMindbodyClientId ?? null,
    productName: item?.displayName || cur.localSku || null,
    localSku: cur.localSku || null,
    orderId: cur.orderId,
    subscriptionId: null,
    checkoutSessionId: cur.stripeCheckoutSessionId || null,
    mindbodySaleId: meta.mindbodySaleId ?? cur.mindbodySaleId ?? null,
    className: ctx?.className ?? cur.pendingBook?.className ?? null,
    classId: ctx?.classId ?? cur.pendingBook?.classId ?? null,
    classStartIso: ctx?.reportedClassStartIso ?? cur.pendingBook?.classStartIso ?? null,
    instructorName: ctx?.instructorName ?? null,
    failureReason: reason,
    paymentSucceeded: meta.paymentSucceeded !== false,
    mindbodySyncSucceeded: meta.mindbodySyncSucceeded !== false,
  });

  await store.patch(cur.orderId, {
    bookingFailureAdminEmail: {
      status: send.ok ? "sent" : "failed",
      attemptedAt: cur.bookingFailureAdminEmail?.attemptedAt || new Date().toISOString(),
      sentAt: send.ok ? new Date().toISOString() : cur.bookingFailureAdminEmail?.sentAt ?? null,
      reason,
      lastError: send.ok ? null : send.reason || send.skipped ? String(send.reason) : "send_failed",
      checkoutSessionId: cur.stripeCheckoutSessionId || null,
      firstInvoiceId: null,
    },
  });

  console.log(
    JSON.stringify({
      event: send.ok ? "classes_auto_book_admin_email_sent" : "classes_auto_book_admin_email_failed",
      orderId: cur.orderId,
      reason,
      emailOk: send.ok,
      emailSkipped: send.skipped === true,
    }),
  );

  return send;
}

/**
 * @param {ReturnType<typeof openSubscriptionStore>} subStore
 * @param {import("./stripe-subscription-store.mjs").SubscriptionRecord} record
 * @param {string} reason
 * @param {string} firstInvoiceId
 * @param {{ mindbodySaleId?: string | null; paymentSucceeded?: boolean; mindbodySyncSucceeded?: boolean }} meta
 */
async function maybeSendSubscriptionAdminEmail(subStore, record, reason, firstInvoiceId, meta) {
  if (!subStore.mutate) return { skipped: true, reason: "store_mutate_unavailable" };

  const acquire = await subStore.mutate(record.id, (cur) => {
    const em = cur.bookingFailureAdminEmail;
    const st = em?.status || "not_sent";
    if (st === "sent" || st === "sending") return null;
    if (st !== "not_sent" && st !== "failed") return null;
    return {
      ...cur,
      bookingFailureAdminEmail: {
        ...em,
        status: /** @type {const} */ ("sending"),
        attemptedAt: new Date().toISOString(),
        sentAt: em?.sentAt ?? null,
        reason,
        lastError: null,
        checkoutSessionId: cur.stripeCheckoutSessionId || null,
        firstInvoiceId,
      },
    };
  });
  if (!acquire.ok || !acquire.modified) {
    return { skipped: true, reason: acquire.ok ? "email_already_claimed" : acquire.reason };
  }

  const cur = acquire.record;
  const item = getCatalogItem(cur.localSku || "");
  const ctx = cur.selectedClassContext;
  const send = await sendClassesBookingFailureAdminEmail({
    clientName: cur.customerName || null,
    clientEmail: cur.customerEmail || null,
    clientPhone: cur.customerPhone || null,
    mindbodyClientId: cur.mindbodyClientId ?? null,
    productName: item?.displayName || cur.displayName || cur.localSku || null,
    localSku: cur.localSku || null,
    orderId: null,
    subscriptionId: cur.id,
    checkoutSessionId: cur.stripeCheckoutSessionId || null,
    mindbodySaleId: meta.mindbodySaleId ?? null,
    className: ctx?.className ?? null,
    classId: ctx?.classId ?? null,
    classStartIso: ctx?.reportedClassStartIso ?? null,
    instructorName: ctx?.instructorName ?? null,
    failureReason: reason,
    paymentSucceeded: meta.paymentSucceeded !== false,
    mindbodySyncSucceeded: meta.mindbodySyncSucceeded !== false,
  });

  await subStore.patch(cur.id, {
    bookingFailureAdminEmail: {
      status: send.ok ? "sent" : "failed",
      attemptedAt: cur.bookingFailureAdminEmail?.attemptedAt || new Date().toISOString(),
      sentAt: send.ok ? new Date().toISOString() : cur.bookingFailureAdminEmail?.sentAt ?? null,
      reason,
      lastError: send.ok ? null : send.reason || "send_failed",
      checkoutSessionId: cur.stripeCheckoutSessionId || null,
      firstInvoiceId,
    },
  });

  return send;
}

/**
 * @param {ReturnType<typeof openOrderStore>} store
 * @param {string} orderId
 * @param {number} clientId
 */
export async function runClassesAutoBookAfterMindbodySync(store, orderId, clientId) {
  const hints = {
    mindbodySyncStatus: /** @type {const} */ ("mindbody_synced"),
    resolvedMindbodyClientId: clientId,
  };
  let order = await reloadOrderForDeferredBook(store, orderId, hints);
  if (!order) {
    return { attempted: false, reason: "order_reload_failed" };
  }
  if (order.mindbodySyncStatus !== "mindbody_synced") {
    return { attempted: false, reason: "sync_not_complete" };
  }
  if (!orderExpectsClassesAutoBook(order)) {
    return { attempted: false, reason: "not_classes_purchase" };
  }

  const acquire = await tryAcquireOrderAutoBook(store, orderId);
  if (!acquire.acquired) {
    return { attempted: false, reason: acquire.reason || "auto_book_not_acquired" };
  }
  order = (await store.get(orderId)) || order;

  /** @type {string} */
  let failureReason = "booking_failed";
  /** @type {import("./stripe-order-store.mjs").OrderRecord["pendingBook"]=} */
  let pendingForBook = order.pendingBook;

  if (order.selectedClassContext?.classId) {
    const ctx = order.selectedClassContext;
    const resolved = await resolveClassFromMindbody(ctx.classId, ctx.reportedClassStartIso);
    if (!resolved.ok) {
      failureReason = resolved.reason || "class_lookup_failed";
      await finalizeOrderAutoBook(store, orderId, "failed", failureReason, failureReason);
      await maybeSendOrderAdminEmail(store, order, failureReason, {
        paymentSucceeded: true,
        mindbodySyncSucceeded: true,
        mindbodySaleId: order.mindbodySaleId,
      });
      return { attempted: true, status: "failed", reason: failureReason };
    }

    const nowIso = new Date().toISOString();
    pendingForBook = {
      classId: ctx.classId,
      classStartIso: resolved.serverStart,
      className: resolved.className || ctx.className || undefined,
      selectedDayKey: ctx.selectedDayKey || undefined,
      source: "book",
      waitlist: false,
      capturedAt: nowIso,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    };
    await store.patch(orderId, {
      pendingBook: pendingForBook,
      deferredBook: order.deferredBook || { status: "pending", attemptCount: 0 },
      resolvedMindbodyClientId: clientId,
    });
    order = (await store.get(orderId)) || order;
  } else if (!pendingForBook) {
    failureReason = "missing_class_context";
    await finalizeOrderAutoBook(store, orderId, "failed", failureReason, failureReason);
    await maybeSendOrderAdminEmail(store, order, failureReason, {
      paymentSucceeded: true,
      mindbodySyncSucceeded: true,
      mindbodySaleId: order.mindbodySaleId,
    });
    return { attempted: true, status: "failed", reason: failureReason };
  }

  if (
    !isDeferredBookEligibleSku(order.localSku) &&
    !(order.pendingBook && isDeferredBookEligibleCta(order.ctaLocation))
  ) {
    failureReason = "product_not_eligible_for_auto_book";
    await finalizeOrderAutoBook(store, orderId, "failed", failureReason, failureReason);
    await maybeSendOrderAdminEmail(store, order, failureReason, {
      paymentSucceeded: true,
      mindbodySyncSucceeded: true,
      mindbodySaleId: order.mindbodySaleId,
    });
    return { attempted: true, status: "failed", reason: failureReason };
  }

  const bookResult = await attemptDeferredClassBookForOrder(
    { ...order, pendingBook: pendingForBook, resolvedMindbodyClientId: clientId },
    clientId,
    store,
  );

  const reloaded = (await store.get(orderId)) || order;
  const deferredStatus = reloaded.deferredBook?.status;

  if (deferredStatus === "booked" && reloaded.deferredBook?.lastError === "already_enrolled") {
    await finalizeOrderAutoBook(store, orderId, "already_enrolled", "already_enrolled", null);
    return { attempted: true, status: "already_enrolled" };
  }
  if (deferredStatus === "booked" || bookResult.status === "booked") {
    await finalizeOrderAutoBook(store, orderId, "booked", "booked", null);
    return { attempted: true, status: "booked" };
  }

  failureReason =
    reloaded.deferredBook?.lastError ||
    reloaded.deferredBook?.lastErrorMessage ||
    bookResult.reason ||
    "booking_failed";
  await finalizeOrderAutoBook(store, orderId, "failed", failureReason, failureReason);
  await maybeSendOrderAdminEmail(store, reloaded, failureReason, {
    paymentSucceeded: true,
    mindbodySyncSucceeded: true,
    mindbodySaleId: reloaded.mindbodySaleId,
  });
  return { attempted: true, status: "failed", reason: failureReason };
}

/**
 * Shared membership first-invoice auto-book (eager + invoice.paid).
 *
 * @param {ReturnType<typeof openSubscriptionStore>} subStore
 * @param {string} subscriptionId
 * @param {number} clientId
 * @param {string} firstInvoiceId
 * @param {string | null | undefined} billingReason
 * @param {{ mindbodySaleId?: string | null; mindbodySyncSucceeded?: boolean }} meta
 */
export async function runClassesAutoBookAfterMembershipFirstInvoiceSync(
  subStore,
  subscriptionId,
  clientId,
  firstInvoiceId,
  billingReason,
  meta,
) {
  if (billingReason !== "subscription_create") {
    return { attempted: false, reason: "not_initial_invoice" };
  }
  const record = await subStore.get(subscriptionId);
  if (!record) return { attempted: false, reason: "subscription_not_found" };
  if (record.purchaseSource !== "classes" && !record.selectedClassContext?.classId) {
    return { attempted: false, reason: "not_classes_purchase" };
  }
  if (!record.selectedClassContext?.classId) {
    return { attempted: false, reason: "missing_class_context" };
  }

  if (!subStore.mutate) {
    return { attempted: false, reason: "store_mutate_unavailable" };
  }

  const acquire = await subStore.mutate(subscriptionId, (cur) => {
    if (cur.initialAutoBookProcessed === true) return null;
    const st = cur.classesAutoBook?.status;
    if (st && AUTO_BOOK_TERMINAL.has(st)) return null;
    const now = new Date().toISOString();
    return {
      ...cur,
      classesAutoBook: {
        status: /** @type {ClassesAutoBookStatus} */ ("processing"),
        attemptedAt: now,
        completedAt: null,
        result: null,
        reason: null,
        firstInvoiceId,
      },
    };
  });
  if (!acquire.ok || !acquire.modified) {
    return { attempted: false, reason: acquire.ok ? "already_claimed" : acquire.reason };
  }

  let sub = acquire.record;
  const ctx = sub.selectedClassContext;
  const resolved = await resolveClassFromMindbody(ctx.classId, ctx.reportedClassStartIso);
  if (!resolved.ok) {
    const reason = resolved.reason || "class_lookup_failed";
    await subStore.patch(subscriptionId, {
      initialAutoBookProcessed: true,
      initialAutoBookProcessedAt: new Date().toISOString(),
      initialAutoBookResult: "failed",
      classesAutoBook: {
        status: "failed",
        attemptedAt: sub.classesAutoBook?.attemptedAt || new Date().toISOString(),
        completedAt: new Date().toISOString(),
        result: reason,
        reason,
        firstInvoiceId,
      },
    });
    await maybeSendSubscriptionAdminEmail(subStore, sub, reason, firstInvoiceId, {
      mindbodySaleId: meta.mindbodySaleId,
      mindbodySyncSucceeded: meta.mindbodySyncSucceeded !== false,
    });
    return { attempted: true, status: "failed", reason };
  }

  /** Ephemeral in-process store — never writes membership auto-book to production order blobs. */
  /** @type {import("./stripe-order-store.mjs").OrderRecord} */
  const tempOrder = {
    orderId: `mem_${sub.id}_${firstInvoiceId.slice(-12)}`,
    localSku: sub.localSku,
    amountCents: sub.monthlyAmountCents,
    currency: sub.currency,
    stripeCheckoutSessionId: sub.stripeCheckoutSessionId,
    mindbodySyncStatus: "mindbody_synced",
    mindbodySaleId: meta.mindbodySaleId ?? null,
    mindbodyServiceId: sub.mindbodyServiceId,
    ctaLocation:
      sub.purchaseSource === "classes"
        ? sub.ctaLocation === "classes_booking_fail_packages" ||
          sub.ctaLocation === "classes_anonymous_book_packages"
          ? sub.ctaLocation
          : "classes_anonymous_book_packages"
        : sub.ctaLocation || "classes_anonymous_book_packages",
    purchaseSource: "classes",
    selectedClassContext: ctx,
    pendingBook: {
      classId: ctx.classId,
      classStartIso: resolved.serverStart,
      className: resolved.className || ctx.className || undefined,
      selectedDayKey: ctx.selectedDayKey || undefined,
      source: /** @type {const} */ ("book"),
      waitlist: /** @type {const} */ (false),
      capturedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    },
    deferredBook: { status: /** @type {const} */ ("pending"), attemptCount: 0 },
    resolvedMindbodyClientId: clientId,
    customerEmail: sub.customerEmail,
    customerName: sub.customerName,
    customerPhone: sub.customerPhone,
    flow: "stripe_recurring_subscription",
    source: "amare_membership_classes_auto_book",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  /** @type {import("./stripe-order-store.mjs").OrderRecord} */
  let ephemeral = { ...tempOrder };
  const ephemeralStore = {
    available: true,
    /** @param {string} id */
    async get(id) {
      return ephemeral.orderId === id ? { ...ephemeral } : null;
    },
    /** @param {string} id @param {Partial<import("./stripe-order-store.mjs").OrderRecord>} partial */
    async patch(id, partial) {
      if (ephemeral.orderId !== id) return null;
      ephemeral = {
        ...ephemeral,
        ...partial,
        orderId: ephemeral.orderId,
        createdAt: ephemeral.createdAt,
        updatedAt: new Date().toISOString(),
      };
      return ephemeral;
    },
  };

  const bookResult = await attemptDeferredClassBookForOrder(tempOrder, clientId, ephemeralStore);
  let autoResult = "failed";
  let autoBookStatus = /** @type {ClassesAutoBookStatus} */ ("failed");
  let failureReason = "booking_failed";

  if (ephemeral.deferredBook?.status === "booked") {
    if (ephemeral.deferredBook.lastError === "already_enrolled") {
      autoResult = "already_enrolled";
      autoBookStatus = "already_enrolled";
    } else {
      autoResult = "booked";
      autoBookStatus = "booked";
    }
  } else {
    failureReason =
      ephemeral.deferredBook?.lastError ||
      ephemeral.deferredBook?.lastErrorMessage ||
      bookResult.reason ||
      "booking_failed";
  }

  await subStore.patch(subscriptionId, {
    initialAutoBookProcessed: true,
    initialAutoBookProcessedAt: new Date().toISOString(),
    initialAutoBookResult: autoResult,
    classesAutoBook: {
      status: autoBookStatus,
      attemptedAt: sub.classesAutoBook?.attemptedAt || new Date().toISOString(),
      completedAt: new Date().toISOString(),
      result: autoResult === "failed" ? failureReason : autoResult,
      reason: autoResult === "failed" ? failureReason : null,
      firstInvoiceId,
    },
  });

  sub = (await subStore.get(subscriptionId)) || sub;

  if (autoBookStatus === "failed") {
    await maybeSendSubscriptionAdminEmail(subStore, sub, failureReason, firstInvoiceId, {
      mindbodySaleId: meta.mindbodySaleId,
      mindbodySyncSucceeded: meta.mindbodySyncSucceeded !== false,
    });
  }

  console.log(
    JSON.stringify({
      event: "membership_classes_auto_book_complete",
      subscriptionId,
      firstInvoiceId,
      result: autoResult,
      bookStatus: autoBookStatus,
    }),
  );

  return { attempted: true, status: autoBookStatus, reason: failureReason };
}

/**
 * @param {ReturnType<typeof openOrderStore>} store
 * @param {string} orderId
 * @param {string} reason
 */
export async function notifyClassesPurchaseMindbodySyncFailure(store, orderId, reason) {
  const order = await store.get(orderId);
  if (!order || !orderExpectsClassesAutoBook(order)) return { skipped: true };
  await maybeSendOrderAdminEmail(store, order, reason, {
    paymentSucceeded: true,
    mindbodySyncSucceeded: false,
    mindbodySaleId: order.mindbodySaleId,
  });
  return { ok: true };
}

/**
 * Webhook redelivery: never re-book when terminal; retry admin email only when allowed.
 *
 * @param {ReturnType<typeof openOrderStore>} store
 * @param {string} orderId
 * @param {number} clientId
 */
export async function handleClassesAutoBookWebhookRedelivery(store, orderId, clientId) {
  const order = await store.get(orderId);
  if (!order || !orderExpectsClassesAutoBook(order)) {
    return { attempted: false, reason: "not_classes_purchase" };
  }
  const st = order.classesAutoBook?.status;
  if (!st || st === "pending") {
    return runClassesAutoBookAfterMindbodySync(store, orderId, clientId);
  }
  if (st === "processing") {
    return { attempted: false, reason: "processing" };
  }
  if (st === "booked" || st === "already_enrolled") {
    return { attempted: false, reason: st };
  }
  if (st === "failed") {
    const emSt = order.bookingFailureAdminEmail?.status || "not_sent";
    if (emSt === "sent" || emSt === "sending") {
      return { attempted: false, reason: "email_already_handled" };
    }
    await maybeSendOrderAdminEmail(
      store,
      order,
      order.classesAutoBook?.reason || order.classesAutoBook?.result || "booking_failed",
      {
        paymentSucceeded: true,
        mindbodySyncSucceeded: order.mindbodySyncStatus === "mindbody_synced",
        mindbodySaleId: order.mindbodySaleId,
      },
    );
    return { attempted: true, action: "admin_email_retry" };
  }
  return { attempted: false, reason: "unknown_status" };
}

/**
 * @param {ReturnType<typeof openSubscriptionStore>} subStore
 * @param {string} subscriptionId
 * @param {string} firstInvoiceId
 * @param {string | null | undefined} billingReason
 * @param {number} clientId
 * @param {{ mindbodySaleId?: string | null; mindbodySyncSucceeded?: boolean }} meta
 */
export async function handleMembershipAutoBookWebhookRedelivery(
  subStore,
  subscriptionId,
  firstInvoiceId,
  billingReason,
  clientId,
  meta,
) {
  if (billingReason !== "subscription_create") {
    return { attempted: false, reason: "not_initial_invoice" };
  }
  const record = await subStore.get(subscriptionId);
  if (!record) return { attempted: false, reason: "subscription_not_found" };
  if (record.purchaseSource !== "classes" && !record.selectedClassContext?.classId) {
    return { attempted: false, reason: "not_classes_purchase" };
  }

  const st = record.classesAutoBook?.status;
  if (!st || st === "pending") {
    return runClassesAutoBookAfterMembershipFirstInvoiceSync(
      subStore,
      subscriptionId,
      clientId,
      firstInvoiceId,
      billingReason,
      meta,
    );
  }
  if (st === "processing") {
    return { attempted: false, reason: "processing" };
  }
  if (st === "booked" || st === "already_enrolled") {
    return { attempted: false, reason: st };
  }
  if (st === "failed") {
    const emSt = record.bookingFailureAdminEmail?.status || "not_sent";
    if (emSt === "sent" || emSt === "sending") {
      return { attempted: false, reason: "email_already_handled" };
    }
    await maybeSendSubscriptionAdminEmail(
      subStore,
      record,
      record.classesAutoBook?.reason || record.classesAutoBook?.result || "booking_failed",
      firstInvoiceId,
      meta,
    );
    return { attempted: true, action: "admin_email_retry" };
  }
  return { attempted: false, reason: "unknown_status" };
}

/**
 * @param {ReturnType<typeof openSubscriptionStore>} subStore
 * @param {string} subscriptionId
 * @param {string} firstInvoiceId
 * @param {string} reason
 */
export async function notifyClassesMembershipMindbodySyncFailure(
  subStore,
  subscriptionId,
  firstInvoiceId,
  reason,
) {
  const record = await subStore.get(subscriptionId);
  if (!record) return { skipped: true };
  if (record.purchaseSource !== "classes" && !record.selectedClassContext?.classId) {
    return { skipped: true };
  }
  await maybeSendSubscriptionAdminEmail(subStore, record, reason, firstInvoiceId, {
    mindbodySaleId: null,
    mindbodySyncSucceeded: false,
  });
  return { ok: true };
}

/** @typedef {ReturnType<typeof import("./stripe-order-store.mjs").openOrderStore>} openOrderStore */
/** @typedef {ReturnType<typeof import("./stripe-subscription-store.mjs").openSubscriptionStore>} openSubscriptionStore */

export { formatClassWhenEt };
