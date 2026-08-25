/**
 * Webhook Push delivery: QA auto (snir5) and production transactional rollout.
 * Global ENABLE_AMARE_PUSH gates production paths. Reminders use a separate flag.
 */

import { enrichClassName } from "./amare-notification-class-name.mjs";
import {
  decideCandidateDelivery,
  fcmProductionWebhooksEnabled,
} from "./amare-notification-send.mjs";
import { formatClassWhen, renderPushCopy } from "./amare-notification-copy.mjs";
import { relayConfigured, sendViaPushRelay } from "./amare-push-relay-lib.mjs";

export const QA_AUTO_PUSH_USER_ID = "usr_WHB3H2RMWAMGC7S8YYTXTG";
export const QA_AUTO_PUSH_KINDS = Object.freeze(["booking_created", "booking_cancelled"]);

/** MVP production webhook kinds — expand after book/cancel rollout is stable. */
export const PRODUCTION_WEBHOOK_KINDS = Object.freeze(["booking_created", "booking_cancelled"]);

export function qaPushStartedAt() {
  const raw = (process.env.AMARE_PUSH_QA_STARTED_AT || "").trim();
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function productionWebhookStartedAt() {
  const raw = (process.env.AMARE_PUSH_WEBHOOKS_STARTED_AT || "").trim();
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function qaAutoPushTestEnabled() {
  return (process.env.ENABLE_AMARE_PUSH_TEST || "").trim() === "1";
}

export function qaAutoPushEligible(candidate, nowIso = new Date().toISOString()) {
  if (fcmProductionWebhooksEnabled()) return { ok: false, reason: "production_webhooks_enabled" };
  if (!qaAutoPushTestEnabled()) return { ok: false, reason: "test_sending_disabled" };
  if (!candidate || !QA_AUTO_PUSH_KINDS.includes(candidate.kind)) {
    return { ok: false, reason: "kind_not_in_qa_auto" };
  }
  if (candidate.amareUserId !== QA_AUTO_PUSH_USER_ID) {
    return { ok: false, reason: "not_qa_user" };
  }
  const boundary = qaPushStartedAt();
  if (!boundary) return { ok: false, reason: "qa_boundary_unset" };
  const created = candidate.createdAt || nowIso;
  if (Date.parse(created) < Date.parse(boundary)) {
    return { ok: false, reason: "before_qa_boundary" };
  }
  return { ok: true, reason: null };
}

export function productionWebhookEligible(candidate, nowIso = new Date().toISOString()) {
  if (!fcmProductionWebhooksEnabled()) {
    return { ok: false, reason: "production_webhooks_disabled" };
  }
  if (!candidate || !PRODUCTION_WEBHOOK_KINDS.includes(candidate.kind)) {
    return { ok: false, reason: "kind_not_in_production_webhook" };
  }
  const boundary = productionWebhookStartedAt();
  if (!boundary) return { ok: false, reason: "production_boundary_unset" };
  const created = candidate.createdAt || nowIso;
  if (Date.parse(created) < Date.parse(boundary)) {
    return { ok: false, reason: "before_production_boundary" };
  }
  return { ok: true, reason: null };
}

async function defaultSend(token, message) {
  if (!relayConfigured()) throw new Error("push_relay_unconfigured");
  return sendViaPushRelay(token, message);
}

const SKIP_MARK_REASONS = new Set([
  "before_qa_boundary",
  "before_production_boundary",
  "not_qa_user",
  "kind_not_in_qa_auto",
  "kind_not_in_production_webhook",
  "production_webhooks_enabled",
]);

/**
 * @param {object} candidate
 * @param {{
 *   store: object,
 *   send?: Function,
 *   fetchClassName?: Function,
 *   now?: string,
 *   gate: Function,
 *   claimBoundary: string | null,
 *   sentEvent: string,
 *   failedEvent: string,
 *   disabledReason?: string,
 * }} deps
 */
async function deliverWebhookCandidateWithGate(candidate, deps) {
  const store = deps.store;
  const gate = deps.gate(candidate, deps.now);
  if (!gate.ok) {
    if (
      store.markCandidateDelivery &&
      candidate.candidateId &&
      gate.reason !== deps.disabledReason
    ) {
      if (SKIP_MARK_REASONS.has(gate.reason)) {
        await store.markCandidateDelivery(candidate.candidateId, "skipped", gate.reason);
      }
    }
    return { ok: true, sent: 0, skipped: gate.reason, candidateId: candidate.candidateId || null };
  }

  const claimed = store.claimCandidate
    ? await store.claimCandidate(candidate.candidateId, deps.claimBoundary)
    : candidate;
  if (!claimed) {
    return { ok: true, sent: 0, skipped: "already_claimed_or_old", candidateId: candidate.candidateId || null };
  }

  const prefs = claimed.amareUserId ? await store.ensurePreferences(claimed.amareUserId) : null;
  const decision = decideCandidateDelivery(prefs, claimed);
  if (!decision.allowed) {
    await store.markCandidateDelivery?.(claimed.candidateId, "skipped", decision.reason);
    return { ok: true, sent: 0, skipped: decision.reason, candidateId: claimed.candidateId };
  }

  const installations = (await store.listActiveInstallations(claimed.amareUserId)).filter(
    (inst) => inst.amareUserId === claimed.amareUserId && inst.pushToken && !inst.revokedAt,
  );
  if (!installations.length) {
    await store.markCandidateDelivery?.(claimed.candidateId, "skipped", "no_owned_active_installation");
    return { ok: true, sent: 0, skipped: "no_owned_active_installation", candidateId: claimed.candidateId };
  }

  const payload = { ...(claimed.payload || {}) };
  if (!payload.className || String(payload.className).toLowerCase() === "your class") {
    const booking =
      claimed.classRosterBookingId != null && store.getBooking
        ? await store.getBooking(claimed.siteId, claimed.classRosterBookingId)
        : null;
    const enriched = await enrichClassName(store, {
      siteId: claimed.siteId,
      classId: claimed.classId ?? booking?.classId,
      existingName: booking?.className || payload.className,
      classStartAt: booking?.classStartAt || payload.classStartAt,
      fetchClassName: deps.fetchClassName,
    });
    payload.className = enriched.displayName;
    payload.classNameSource = enriched.source;
    payload.classNameFallback = enriched.fallbackUsed === true;
    if (enriched.className && booking && store.upsertBooking) {
      await store.upsertBooking({
        ...booking,
        className: enriched.className,
      });
    }
  }
  payload.classId = claimed.classId ?? payload.classId ?? null;

  const copy = renderPushCopy(claimed.kind, payload);
  const message = {
    title: copy.title,
    body: copy.body,
    path: "/my-classes",
    kind: claimed.kind,
    classId: claimed.classId ?? payload.classId ?? null,
  };

  const send = deps.send || defaultSend;
  let sent = 0;
  const revoked = [];
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
        revoked.push(inst.installationId);
      } else {
        console.warn(
          JSON.stringify({
            event: deps.failedEvent,
            candidateId: claimed.candidateId,
            kind: claimed.kind,
            message: String(/** @type {{ message?: string }} */ (err)?.message ?? err).slice(0, 300),
          }),
        );
      }
    }
  }

  if (sent > 0) {
    await store.markCandidateDelivery?.(claimed.candidateId, "delivered", null);
    console.log(
      JSON.stringify({
        event: deps.sentEvent,
        candidateId: claimed.candidateId,
        kind: claimed.kind,
        sent,
        classNameSource: payload.classNameSource || null,
        classNameFallback: payload.classNameFallback === true,
        when: formatClassWhen(payload.classStartAt) ? "set" : "missing",
      }),
    );
    return {
      ok: true,
      sent,
      skipped: null,
      candidateId: claimed.candidateId,
      classNameSource: payload.classNameSource || null,
      classNameFallback: payload.classNameFallback === true,
      revoked,
    };
  }

  await store.markCandidateDelivery?.(claimed.candidateId, "skipped", sent ? null : "send_failed");
  return { ok: true, sent: 0, skipped: "send_failed", candidateId: claimed.candidateId, revoked };
}

/**
 * @param {object} candidate
 * @param {{
 *   store: object,
 *   send?: Function,
 *   fetchClassName?: Function,
 *   now?: string,
 * }} deps
 */
export async function deliverQaAutoCandidate(candidate, deps) {
  const result = await deliverWebhookCandidateWithGate(candidate, {
    ...deps,
    gate: qaAutoPushEligible,
    claimBoundary: qaPushStartedAt(),
    sentEvent: "amare_qa_auto_push_sent",
    failedEvent: "amare_qa_auto_push_failed",
    disabledReason: "test_sending_disabled",
  });
  return { ...result, deliveryPath: "qa" };
}

/**
 * @param {object} candidate
 * @param {{
 *   store: object,
 *   send?: Function,
 *   fetchClassName?: Function,
 *   now?: string,
 * }} deps
 */
export async function deliverProductionWebhookCandidate(candidate, deps) {
  const result = await deliverWebhookCandidateWithGate(candidate, {
    ...deps,
    gate: productionWebhookEligible,
    claimBoundary: productionWebhookStartedAt(),
    sentEvent: "amare_production_webhook_push_sent",
    failedEvent: "amare_production_webhook_push_failed",
    disabledReason: "production_webhooks_disabled",
  });
  return { ...result, deliveryPath: "production" };
}

/**
 * @param {object[]} candidates
 * @param {{ store: object, send?: Function, fetchClassName?: Function }} deps
 */
export async function deliverQaAutoCandidates(candidates, deps) {
  const results = [];
  for (const candidate of candidates || []) {
    results.push(await deliverQaAutoCandidate(candidate, deps));
  }
  return results;
}

/**
 * @param {object[]} candidates
 * @param {{ store: object, send?: Function, fetchClassName?: Function }} deps
 */
export async function deliverProductionWebhookCandidates(candidates, deps) {
  const results = [];
  for (const candidate of candidates || []) {
    results.push(await deliverProductionWebhookCandidate(candidate, deps));
  }
  return results;
}

/**
 * Routes webhook candidates to production or QA delivery — never both.
 * @param {object[]} candidates
 * @param {{ store: object, send?: Function, fetchClassName?: Function }} deps
 */
export async function deliverWebhookCandidates(candidates, deps) {
  if (fcmProductionWebhooksEnabled()) {
    return deliverProductionWebhookCandidates(candidates, deps);
  }
  return deliverQaAutoCandidates(candidates, deps);
}
