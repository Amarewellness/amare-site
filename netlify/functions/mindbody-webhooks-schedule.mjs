import crypto from "node:crypto";

import { withLambda } from "@netlify/aws-lambda-compat";
import { jsonResponse } from "./mindbody-consumer-lib.mjs";
import {
  ingestAndProcessWebhook,
  PROCESSABLE_EVENT_IDS,
} from "./amare-notification-lib.mjs";
import { openNotificationStore } from "./amare-notification-store.mjs";
import {
  SCHEDULE_CACHE_TAG,
  SCHEDULE_WEBHOOK_EVENT_IDS,
} from "./mindbody-webhook-schedule-dedupe.mjs";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Mindbody-Signature",
};

const PROBE = JSON.stringify({ ok: true });
const PURGE_BUDGET_MS = 1500;

/** @param {Record<string, unknown> | undefined} headers */
function headerValue(headers, name) {
  if (!headers || typeof headers !== "object") return "";
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === want) return String(v ?? "").trim();
  }
  return "";
}

/**
 * Exact raw POST bytes. Do not JSON parse/stringify before HMAC.
 * @param {{ body?: string | null; isBase64Encoded?: boolean }} event
 */
export function rawBodyBufferFromEvent(event) {
  if (!event || typeof event !== "object" || event.body == null) return Buffer.alloc(0);
  if (event.isBase64Encoded) return Buffer.from(String(event.body), "base64");
  return Buffer.from(typeof event.body === "string" ? event.body : String(event.body), "utf8");
}

/**
 * Official Mindbody signature: sha256= + Base64(HMAC-SHA256(rawBody, messageSignatureKey)).
 * @param {Buffer | string} rawBody
 * @param {string} secret
 */
export function mindbodyWebhookSignatureHeader(rawBody, secret) {
  const bytes = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), "utf8");
  return `sha256=${crypto.createHmac("sha256", secret).update(bytes).digest("base64")}`;
}

/**
 * Timing-safe compare of the official Base64 HMAC. Hex is not accepted.
 * @param {Buffer | string} rawBody
 * @param {string} headerSignature
 * @param {string} secret
 */
export function verifyMindbodyWebhookSignature(rawBody, headerSignature, secret) {
  if (!secret || !headerSignature) return false;
  const expected = mindbodyWebhookSignatureHeader(rawBody, secret);
  const got = headerSignature.trim();
  if (got.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(got, "utf8"), Buffer.from(expected, "utf8"));
  } catch {
    return false;
  }
}

async function purgeScheduleEdgeCache() {
  const work = (async () => {
    try {
      const mod = await import("@netlify/functions");
      if (typeof mod.purgeCache !== "function") {
        return { ok: false, reason: "purge_cache_not_available" };
      }
      await mod.purgeCache({ tags: [SCHEDULE_CACHE_TAG] });
      return { ok: true, purged: true };
    } catch (e) {
      const msg = String(/** @type {{ message?: string }} */ (e)?.message ?? e);
      console.warn(JSON.stringify({ event: "mindbody_webhook_purge_failed", message: msg.slice(0, 300) }));
      return { ok: false, reason: "purge_error" };
    }
  })();
  return Promise.race([
    work,
    new Promise((resolve) => {
      setTimeout(() => resolve({ ok: false, reason: "purge_timeout" }), PURGE_BUDGET_MS);
    }),
  ]);
}

function configuredMindbodySiteId() {
  const raw = (process.env.MINDBODY_SITE_ID || "").trim();
  if (!raw || raw === "-99") return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

function parseWebhookPayload(body) {
  if (!body || typeof body !== "object") {
    return { messageId: null, eventId: null, siteId: null };
  }
  const o = /** @type {Record<string, unknown>} */ (body);
  const messageId =
    typeof o.messageId === "string"
      ? o.messageId.trim()
      : typeof o.MessageId === "string"
        ? o.MessageId.trim()
        : null;
  const eventId =
    typeof o.eventId === "string"
      ? o.eventId.trim()
      : typeof o.EventId === "string"
        ? o.EventId.trim()
        : null;
  let siteId = null;
  const eventData = o.eventData ?? o.EventData;
  if (eventData && typeof eventData === "object") {
    const ed = /** @type {Record<string, unknown>} */ (eventData);
    const siteRaw = ed.siteId ?? ed.SiteId;
    if (siteRaw != null && siteRaw !== "") {
      const n = typeof siteRaw === "number" ? siteRaw : parseInt(String(siteRaw), 10);
      if (Number.isFinite(n)) siteId = n;
    }
  }
  return { messageId: messageId || null, eventId: eventId || null, siteId };
}

function logWebhook(fields) {
  console.log(JSON.stringify({ ...fields }));
}

async function openInboxStore(deps) {
  if (deps.notificationStore) return deps.notificationStore;
  try {
    return openNotificationStore();
  } catch (e) {
    console.warn(
      JSON.stringify({
        event: "amare_notification_store_unavailable",
        message: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 300),
      }),
    );
    return null;
  }
}

/**
 * Durable ingest: HMAC → persist/dedupe by messageId → process required state → 2xx.
 * Does not fire-and-forget after the response. Does not send FCM.
 * @param {import("@netlify/functions").HandlerEvent} event
 */
export async function handleMindbodyScheduleWebhook(event, deps = {}) {
  const method = (event.httpMethod || "GET").toUpperCase();

  if (method === "OPTIONS" || method === "HEAD" || method === "GET") {
    return {
      statusCode: 200,
      headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      body: PROBE,
    };
  }

  if (method !== "POST") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" }, CORS);
  }

  const rawBody = rawBodyBufferFromEvent(event);
  const signatureHeader = headerValue(
    /** @type {Record<string, unknown> | undefined} */ (event.headers),
    "X-Mindbody-Signature",
  );
  const secret = (process.env.MINDBODY_WEBHOOK_SIGNATURE_KEY || "").trim();

  if (!secret) {
    logWebhook({
      event: "mindbody_webhook_missing_signature_key",
      signatureValid: false,
      bodyBytes: rawBody.length,
    });
    return jsonResponse(503, { ok: false, error: "webhook_not_configured" }, CORS);
  }

  if (!verifyMindbodyWebhookSignature(rawBody, signatureHeader, secret)) {
    logWebhook({
      event: "mindbody_webhook_signature_invalid",
      signatureValid: false,
      hasSignatureHeader: Boolean(signatureHeader),
      bodyBytes: rawBody.length,
    });
    return jsonResponse(401, { ok: false, error: "invalid_signature" }, CORS);
  }

  /** @type {Record<string, unknown>} */
  let payload = {};
  if (rawBody.length) {
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return jsonResponse(400, { ok: false, error: "invalid_json" }, CORS);
    }
  }

  const { messageId, eventId, siteId } = parseWebhookPayload(payload);
  const expectedSiteId =
    deps.expectedSiteId !== undefined ? deps.expectedSiteId : configuredMindbodySiteId();
  const siteMatch =
    expectedSiteId == null || siteId == null ? null : siteId === expectedSiteId;
  const scheduleEvent = eventId != null && SCHEDULE_WEBHOOK_EVENT_IDS.has(eventId);
  const processable = eventId != null && PROCESSABLE_EVENT_IDS.includes(eventId);

  logWebhook({
    event: "mindbody_webhook_accepted",
    eventId,
    messageId,
    siteId,
    expectedSiteId,
    siteMatch,
    signatureValid: true,
    scheduleEvent,
    processable,
    bodyBytes: rawBody.length,
  });

  const store = await openInboxStore(deps);

  if (expectedSiteId != null && siteId != null && siteId !== expectedSiteId) {
    if (store?.claimInbox) {
      await store.claimInbox({
        messageId,
        eventId,
        siteId,
        payload,
      }).catch(() => null);
      if (messageId) await store.markInbox(String(messageId), "ignored").catch(() => null);
    }
    logWebhook({
      event: "mindbody_webhook_site_mismatch",
      eventId,
      messageId,
      siteId,
      expectedSiteId,
      siteMatch: false,
    });
    return jsonResponse(200, { ok: true, ignored: true, reason: "site_mismatch", eventId }, CORS);
  }

  let duplicate = false;
  let processed = false;
  if (store && processable) {
    try {
      const result = await ingestAndProcessWebhook(store, payload, {
        findActiveAssociationByClientId: deps.findActiveAssociationByClientId,
      });
      duplicate = result?.duplicate === true;
      processed = result?.ok !== false && !result?.ignored;
      if (result?.duplicate) {
        logWebhook({ event: "amare_notification_inbox_duplicate", eventId, messageId });
      }
    } catch (e) {
      logWebhook({
        event: "amare_notification_process_failed",
        eventId,
        messageId,
        message: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 300),
      });
    }
  } else if (store && messageId) {
    try {
      const claim = await store.claimInbox({
        messageId,
        eventId,
        siteId,
        payload,
      });
      duplicate = claim.kind === "duplicate";
      if (messageId) await store.markInbox(String(messageId), "ignored");
    } catch {
      /* still ACK */
    }
  }

  let purged = false;
  let purgeReason = null;
  if (scheduleEvent) {
    const purge = await purgeScheduleEdgeCache();
    purged = purge.ok === true && purge.purged === true;
    purgeReason = purge.reason ?? null;
    logWebhook({
      event: "mindbody_webhook_schedule_purged",
      messageId,
      eventId,
      siteId,
      siteMatch,
      purged,
      purgeReason,
    });
  } else if (!processable) {
    logWebhook({ event: "mindbody_webhook_ignored", eventId, messageId, siteId, siteMatch });
    return jsonResponse(200, { ok: true, ignored: true, eventId, messageId, duplicate }, CORS);
  }

  return jsonResponse(
    200,
    {
      ok: true,
      eventId,
      messageId,
      duplicate,
      processed,
      purged,
      tag: scheduleEvent ? SCHEDULE_CACHE_TAG : undefined,
    },
    CORS,
  );
}

export async function lambdaHandler(event) {
  return handleMindbodyScheduleWebhook(event);
}

export default withLambda(lambdaHandler);
