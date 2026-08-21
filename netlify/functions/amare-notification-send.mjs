/**
 * FCM sender for AMARÉ notification candidates.
 * Not imported by the Mindbody webhook handler.
 * Production sending stays OFF unless ENABLE_AMARE_PUSH=1.
 */

import { CANDIDATE_KINDS, openNotificationStore } from "./amare-notification-store.mjs";
import { CANDIDATE_PREF_MAP, pushPathForCandidate, renderPushCopy } from "./amare-notification-copy.mjs";
import { relayConfigured, sendViaPushRelay } from "./amare-push-relay-lib.mjs";

export function fcmProductionSendingEnabled() {
  return (process.env.ENABLE_AMARE_PUSH || "").trim() === "1";
}

export function fcmTestSendingEnabled() {
  return (process.env.ENABLE_AMARE_PUSH_TEST || "").trim() === "1";
}

export function pushTestHttpAllowed() {
  if (!fcmTestSendingEnabled()) return false;
  const site = `${process.env.URL || ""} ${process.env.SITE_URL || ""} ${process.env.DEPLOY_PRIME_URL || ""}`.toLowerCase();
  if (site.includes("www.amarewellness.com")) return false;
  if ((process.env.CONTEXT || "") === "production" && site.includes("amarewellness.com")) return false;
  return true;
}

const UNREGISTERED = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
]);

export function preferenceKeyForCandidate(kind) {
  return CANDIDATE_PREF_MAP[kind] || null;
}

export function decideCandidateDelivery(prefs, candidate) {
  if (!candidate || !candidate.kind) return { allowed: false, reason: "missing_candidate" };
  if (!CANDIDATE_KINDS.includes(candidate.kind) && candidate.kind !== "studio_news") {
    return { allowed: false, reason: "unknown_kind" };
  }
  if (candidate.suppressPush === true) return { allowed: false, reason: "suppressed" };
  if (!candidate.amareUserId) return { allowed: false, reason: "no_recipient" };
  const key = preferenceKeyForCandidate(candidate.kind);
  if (!key) return { allowed: false, reason: "unmapped_kind" };
  if (key === "studio_news" && prefs?.studio_news !== true) {
    return { allowed: false, reason: "studio_news_off" };
  }
  if (prefs && prefs[key] === false) return { allowed: false, reason: `pref_${key}_off` };
  return { allowed: true, reason: null, preferenceKey: key };
}

function firebaseServiceAccount() {
  const raw = (process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function defaultFcmSend(token, message) {
  if (relayConfigured()) return sendViaPushRelay(token, message);
  const { default: admin } = await import("firebase-admin");
  if (!admin.apps.length) {
    const cred = firebaseServiceAccount();
    if (cred) admin.initializeApp({ credential: admin.credential.cert(cred) });
    else admin.initializeApp();
  }
  return admin.messaging().send({
    token,
    notification: { title: message.title, body: message.body },
    data: {
      path: String(message.path || "/"),
      kind: String(message.kind || ""),
      classId: message.classId != null ? String(message.classId) : "",
    },
    android: {
      priority: "high",
      notification: {
        channelId: "amare-class",
        icon: "ic_stat_amare",
        color: "#1A1816",
      },
    },
  });
}

function isUnregisteredError(err) {
  const code = String(err?.code || err?.errorInfo?.code || "");
  const msg = String(err?.message || err || "").toLowerCase();
  return UNREGISTERED.has(code) || msg.includes("requested entity was not found") || msg.includes("not a valid fcm");
}

/**
 * @param {{
 *   kind: string,
 *   amareUserId: string,
 *   classId?: number | null,
 *   suppressPush?: boolean,
 *   payload?: Record<string, unknown>,
 * }} candidate
 * @param {{
 *   store?: object,
 *   send?: Function,
 *   allowTest?: boolean,
 * }} [deps]
 */
export async function deliverNotificationCandidate(candidate, deps = {}) {
  const store = deps.store || openNotificationStore();
  const prefs = candidate.amareUserId ? await store.ensurePreferences(candidate.amareUserId) : null;
  const decision = decideCandidateDelivery(prefs, candidate);
  if (!decision.allowed) {
    return { ok: true, sent: 0, skipped: decision.reason, installations: 0 };
  }

  const installations = await store.listActiveInstallations(candidate.amareUserId);
  if (!installations.length) {
    return { ok: true, sent: 0, skipped: "no_active_installations", installations: 0 };
  }

  const copy = renderPushCopy(candidate.kind, candidate.payload || {});
  const path = pushPathForCandidate(candidate.kind, { ...(candidate.payload || {}), classId: candidate.classId });
  const message = {
    title: copy.title,
    body: copy.body,
    path,
    kind: candidate.kind,
    classId: candidate.classId ?? candidate.payload?.classId ?? null,
  };

  const canSendReal = fcmProductionSendingEnabled() || (deps.allowTest === true && fcmTestSendingEnabled());
  if (!deps.send && !canSendReal) {
    return { ok: true, sent: 0, skipped: "sending_disabled", installations: installations.length, dryRun: message };
  }

  const send = deps.send || defaultFcmSend;
  let sent = 0;
  const revoked = [];
  for (const inst of installations) {
    if (inst.amareUserId && candidate.amareUserId && inst.amareUserId !== candidate.amareUserId) {
      continue;
    }
    try {
      await send(inst.pushToken, message);
      sent += 1;
    } catch (err) {
      if (isUnregisteredError(err)) {
        await store.revokeInstallation(inst.installationId);
        revoked.push(inst.installationId);
      } else {
        console.warn(
          JSON.stringify({
            event: "amare_fcm_send_failed",
            installationId: inst.installationId,
            message: String(/** @type {{ message?: string }} */ (err)?.message ?? err).slice(0, 300),
          }),
        );
      }
    }
  }
  return { ok: true, sent, skipped: sent ? null : "send_failed", installations: installations.length, revoked };
}

/**
 * One explicit QA push. Not used by the webhook or candidate pipeline.
 * Requires ENABLE_AMARE_PUSH_TEST=1. Sends only to the resolved user's
 * active installations, optionally a single owned installationId.
 */
export async function deliverExplicitPushTest(input = {}, deps = {}) {
  if (!fcmTestSendingEnabled()) {
    return { ok: false, sent: 0, skipped: "test_sending_disabled" };
  }
  const amareUserId = String(input.amareUserId || "").trim();
  if (!amareUserId.startsWith("usr_")) {
    return { ok: false, sent: 0, skipped: "invalid_amare_user_id" };
  }
  const wantedInstallation = String(input.installationId || "").trim();
  const store = deps.store || openNotificationStore();
  let installations = await store.listActiveInstallations(amareUserId);
  if (wantedInstallation) {
    installations = installations.filter((inst) => inst.installationId === wantedInstallation);
  }
  installations = installations.filter((inst) => inst.amareUserId === amareUserId && inst.pushToken);
  if (!installations.length) {
    return { ok: false, sent: 0, skipped: "no_owned_active_installation", installations: 0 };
  }

  const message = {
    title: String(input.title || "AMARÉ").trim() || "AMARÉ",
    body: String(input.body || "Push notifications are ready ✨").trim() || "Push notifications are ready ✨",
    path: String(input.path || "/my-classes").trim() || "/my-classes",
    kind: String(input.kind || "push_test").trim() || "push_test",
    classId: null,
  };

  const canSendReal = fcmTestSendingEnabled();
  if (!deps.send && !canSendReal) {
    return { ok: true, sent: 0, skipped: "sending_disabled", installations: installations.length, dryRun: message };
  }

  const send = deps.send || defaultFcmSend;
  let sent = 0;
  const revoked = [];
  for (const inst of installations) {
    if (inst.amareUserId !== amareUserId) continue;
    try {
      await send(inst.pushToken, message);
      sent += 1;
    } catch (err) {
      if (isUnregisteredError(err)) {
        await store.revokeInstallation(inst.installationId);
        revoked.push(inst.installationId);
      } else {
        console.warn(
          JSON.stringify({
            event: "amare_fcm_test_send_failed",
            installationId: inst.installationId,
            message: String(/** @type {{ message?: string }} */ (err)?.message ?? err).slice(0, 300),
          }),
        );
      }
    }
  }
  return { ok: sent > 0, sent, skipped: sent ? null : "send_failed", installations: installations.length, revoked };
}
