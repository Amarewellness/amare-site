/**
 * Class reminder worker. Sends only through the Cloud Run relay.
 * Production reminders require ENABLE_AMARE_PUSH=1 and ENABLE_AMARE_PUSH_REMINDERS=1.
 * During QA only the configured QA user is eligible.
 * Does not change booking/cancel/class-cancelled pipelines.
 */

import { enrichClassName } from "./amare-notification-class-name.mjs";
import { qaReminderUserId } from "./amare-notification-lib.mjs";
import { decideCandidateDelivery, fcmProductionRemindersEnabled } from "./amare-notification-send.mjs";
import { renderPushCopy } from "./amare-notification-copy.mjs";
import { openNotificationStore } from "./amare-notification-store.mjs";
import { relayConfigured, sendViaPushRelay } from "./amare-push-relay-lib.mjs";

function testPushEnabled() {
  return (process.env.ENABLE_AMARE_PUSH_TEST || "").trim() === "1";
}

export function reminderSendAllowedForUser(amareUserId) {
  if (fcmProductionRemindersEnabled()) return { ok: true, reason: null };
  if (!testPushEnabled()) return { ok: false, reason: "sending_disabled" };
  const qaUser = qaReminderUserId();
  if (!qaUser) return { ok: false, reason: "qa_reminder_user_unset" };
  if (amareUserId !== qaUser) return { ok: false, reason: "not_qa_user" };
  return { ok: true, reason: null };
}

function reminderCandidateId(reminderId) {
  return `cand_${String(reminderId || "").replace(/^rem_/, "r_")}`;
}

async function defaultSend(token, message) {
  if (!relayConfigured()) throw new Error("push_relay_unconfigured");
  return sendViaPushRelay(token, message);
}

function isCancelStatus(status) {
  return status === "cancelled" || status === "early_cancelled" || status === "late_cancelled";
}

/**
 * @param {object} reminder
 * @param {{ store: object, send?: Function, fetchClassName?: Function, now?: string }} deps
 */
export async function processDueReminder(reminder, deps) {
  const store = deps.store;
  const gate = reminderSendAllowedForUser(reminder.amareUserId);
  if (!gate.ok) return { ok: true, sent: 0, skipped: gate.reason, reminderId: reminder.reminderId };

  const claimed = await store.claimReminder(reminder.reminderId, deps.now || new Date().toISOString());
  if (!claimed) {
    const current = await store.getReminder(
      reminder.amareUserId,
      reminder.siteId,
      reminder.classRosterBookingId,
    );
    if (current?.status === "sent") {
      return { ok: true, sent: 0, skipped: "already_sent", reminderId: reminder.reminderId };
    }
    return { ok: true, sent: 0, skipped: "already_claimed_or_not_due", reminderId: reminder.reminderId };
  }

  const booking = await store.getBooking(claimed.siteId, claimed.classRosterBookingId);
  if (!booking || isCancelStatus(booking.status)) {
    await store.upsertReminder({
      ...claimed,
      status: "cancelled",
      lastEventOriginationAt: deps.now || new Date().toISOString(),
    });
    return { ok: true, sent: 0, skipped: "booking_not_active", reminderId: claimed.reminderId };
  }
  if (booking.amareUserId && booking.amareUserId !== claimed.amareUserId) {
    await store.upsertReminder({
      ...claimed,
      status: "cancelled",
      lastEventOriginationAt: deps.now || new Date().toISOString(),
    });
    return { ok: true, sent: 0, skipped: "owner_mismatch", reminderId: claimed.reminderId };
  }

  const classState = claimed.classId != null ? await store.getClassState(claimed.siteId, claimed.classId) : null;
  if (classState?.isCancelled === true) {
    await store.upsertReminder({
      ...claimed,
      status: "cancelled",
      lastEventOriginationAt: deps.now || new Date().toISOString(),
    });
    return { ok: true, sent: 0, skipped: "class_cancelled", reminderId: claimed.reminderId };
  }

  const prefs = await store.ensurePreferences(claimed.amareUserId);
  const decision = decideCandidateDelivery(prefs, {
    kind: "class_reminder_due",
    amareUserId: claimed.amareUserId,
    suppressPush: false,
  });
  if (!decision.allowed) {
    await store.upsertReminder({
      ...claimed,
      status: "suppressed",
      lastEventOriginationAt: deps.now || new Date().toISOString(),
    });
    return { ok: true, sent: 0, skipped: decision.reason, reminderId: claimed.reminderId };
  }

  const installations = (await store.listActiveInstallations(claimed.amareUserId)).filter(
    (inst) => inst.amareUserId === claimed.amareUserId && inst.pushToken && !inst.revokedAt,
  );
  if (!installations.length) {
    await store.releaseReminderClaim(claimed.reminderId);
    return { ok: true, sent: 0, skipped: "no_owned_active_installation", reminderId: claimed.reminderId };
  }

  const enriched = await enrichClassName(store, {
    siteId: claimed.siteId,
    classId: claimed.classId ?? booking.classId,
    existingName: booking.className,
    classStartAt: booking.classStartAt || claimed.classStartAt,
    fetchClassName: deps.fetchClassName,
  });
  if (enriched.className && booking.className !== enriched.className && store.upsertBooking) {
    await store.upsertBooking({ ...booking, className: enriched.className });
  }

  const payload = {
    className: enriched.displayName,
    classNameSource: enriched.source,
    classNameFallback: enriched.fallbackUsed === true,
    classStartAt: booking.classStartAt || claimed.classStartAt,
    classId: claimed.classId ?? booking.classId ?? null,
    reminderId: claimed.reminderId,
  };
  const copy = renderPushCopy("class_reminder", payload);
  const message = {
    title: copy.title,
    body: copy.body,
    path: "/my-classes",
    kind: "class_reminder",
    classId: payload.classId,
  };

  const candidateId = reminderCandidateId(claimed.reminderId);
  let candidate = store.getCandidate ? await store.getCandidate(candidateId) : null;
  if (candidate?.deliveryStatus === "delivered") {
    await store.markReminderSent(claimed.reminderId);
    return { ok: true, sent: 0, skipped: "already_sent", reminderId: claimed.reminderId };
  }
  if (!candidate) {
    candidate = await store.addCandidate({
      candidateId,
      kind: "class_reminder_due",
      amareUserId: claimed.amareUserId,
      siteId: claimed.siteId,
      classId: claimed.classId,
      classRosterBookingId: claimed.classRosterBookingId,
      payload,
    });
  }
  const claimedCandidate = store.claimCandidate ? await store.claimCandidate(candidateId) : candidate;
  if (!claimedCandidate) {
    const again = store.getCandidate ? await store.getCandidate(candidateId) : candidate;
    if (again?.deliveryStatus === "delivered") {
      await store.markReminderSent(claimed.reminderId);
      return { ok: true, sent: 0, skipped: "already_sent", reminderId: claimed.reminderId };
    }
    await store.releaseReminderClaim(claimed.reminderId);
    return { ok: true, sent: 0, skipped: "candidate_already_claimed", reminderId: claimed.reminderId };
  }

  const send = deps.send || defaultSend;
  let sent = 0;
  for (const inst of installations) {
    if (inst.amareUserId !== claimed.amareUserId) continue;
    try {
      await send(inst.pushToken, message);
      sent += 1;
    } catch (err) {
      const code = String(err?.code || err?.errorInfo?.code || "");
      const msg = String(err?.message || err || "").toLowerCase();
      if (code.includes("registration-token-not-registered") || msg.includes("requested entity was not found")) {
        await store.revokeInstallation?.(inst.installationId);
      } else {
        console.warn(
          JSON.stringify({
            event: "amare_class_reminder_send_failed",
            reminderId: claimed.reminderId,
            message: String(/** @type {{ message?: string }} */ (err)?.message ?? err).slice(0, 300),
          }),
        );
      }
    }
  }

  if (sent > 0) {
    await store.markCandidateDelivery?.(candidateId, "delivered", null);
    await store.markReminderSent(claimed.reminderId);
    console.log(
      JSON.stringify({
        event: "amare_class_reminder_sent",
        reminderId: claimed.reminderId,
        candidateId,
        sent,
        classNameSource: payload.classNameSource,
        classNameFallback: payload.classNameFallback,
      }),
    );
    return {
      ok: true,
      sent,
      skipped: null,
      reminderId: claimed.reminderId,
      candidateId,
      classNameSource: payload.classNameSource,
      classNameFallback: payload.classNameFallback,
    };
  }

  await store.markCandidateDelivery?.(candidateId, "skipped", "send_failed");
  await store.releaseReminderClaim(claimed.reminderId);
  return { ok: true, sent: 0, skipped: "send_failed", reminderId: claimed.reminderId };
}

/**
 * @param {{
 *   store?: object,
 *   send?: Function,
 *   fetchClassName?: Function,
 *   now?: string,
 * }} [deps]
 */
export async function runClassReminderScan(deps = {}) {
  if (!fcmProductionRemindersEnabled() && !testPushEnabled()) {
    return { ok: true, scanned: 0, sent: 0, skipped: "sending_disabled" };
  }
  const store = deps.store || openNotificationStore();
  const qaOnly = !fcmProductionRemindersEnabled();
  const qaUser = qaReminderUserId();
  if (qaOnly && !qaUser) {
    return { ok: true, scanned: 0, sent: 0, skipped: "qa_reminder_user_unset" };
  }
  const due = await store.listDueReminders({
    amareUserId: qaOnly ? qaUser : null,
    now: deps.now || new Date().toISOString(),
  });
  const results = [];
  for (const reminder of due) {
    results.push(await processDueReminder(reminder, { ...deps, store }));
  }
  const sent = results.reduce((n, r) => n + (r.sent || 0), 0);
  return { ok: true, scanned: due.length, sent, results };
}
