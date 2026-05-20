import crypto from "node:crypto";

import { jsonResponse } from "./mindbody-consumer-lib.mjs";
import {
  SCHEDULE_CACHE_TAG,
  SCHEDULE_WEBHOOK_EVENT_IDS,
  claimWebhookMessageId,
  tryOpenWebhookDedupeStore,
} from "./mindbody-webhook-schedule-dedupe.mjs";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Mindbody-Signature",
};

/** Fallback when Netlify Blobs are unavailable (local `npm run dev`). */
const memoryDedupe = new Map();
const MEMORY_DEDUPE_MAX = 5000;

/**
 * @param {string} messageId
 * @returns {boolean} true if duplicate
 */
function memoryDedupeIsDuplicate(messageId) {
  if (memoryDedupe.has(messageId)) return true;
  memoryDedupe.set(messageId, Date.now());
  if (memoryDedupe.size > MEMORY_DEDUPE_MAX) {
    const cutoff = Date.now() - 86400000;
    for (const [id, ts] of memoryDedupe) {
      if (ts < cutoff) memoryDedupe.delete(id);
    }
  }
  return false;
}

/** @param {Record<string, unknown> | undefined} headers */
function headerValue(headers, name) {
  if (!headers || typeof headers !== "object") return "";
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === want) return String(v ?? "").trim();
  }
  return "";
}

/** @param {{ body?: string | null; isBase64Encoded?: boolean; headers?: Record<string, unknown> }} event */
function rawBodyFromEvent(event) {
  if (!event || typeof event !== "object") return "";
  const e = /** @type {{ body?: string | null; isBase64Encoded?: boolean }} */ (event);
  if (e.body == null) return "";
  if (e.isBase64Encoded) {
    return Buffer.from(/** @type {string} */ (e.body), "base64").toString("utf8");
  }
  return typeof e.body === "string" ? e.body : String(e.body);
}

/**
 * Mindbody Webhooks: HMAC-SHA256 of raw body, compare to `X-Mindbody-Signature` (`sha256=<hex>`).
 * @see https://developers.mindbodyonline.com/WebhooksDocumentation
 *
 * @param {string} rawBody
 * @param {string} headerSignature
 * @param {string} secret messageSignatureKey from subscription creation
 */
function verifyMindbodyWebhookSignature(rawBody, headerSignature, secret) {
  if (!secret || !headerSignature) return false;
  const mac = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const expected = `sha256=${mac}`;
  const got = headerSignature.trim();
  if (got.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(got, "utf8"), Buffer.from(expected, "utf8"));
  } catch {
    return false;
  }
}

/**
 * @returns {Promise<{ ok: boolean; purged?: boolean; reason?: string }>}
 */
async function purgeScheduleEdgeCache() {
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
}

/** @returns {number | null} Studio site id from env when configured and not sandbox -99. */
function configuredMindbodySiteId() {
  const raw = (process.env.MINDBODY_SITE_ID || "").trim();
  if (!raw || raw === "-99") return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

/** @param {unknown} body */
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

/**
 * Safe structured log — never includes secrets, raw body, or full event payloads.
 * @param {Record<string, unknown>} fields
 */
function logWebhook(fields) {
  console.log(JSON.stringify({ ...fields }));
}

export async function handler(event) {
  const method = (event.httpMethod || "GET").toUpperCase();

  if (method === "OPTIONS") {
    return { statusCode: 204, headers: { ...CORS, "Cache-Control": "no-store" }, body: "" };
  }

  /** Mindbody probes webhook URLs with HEAD when creating a subscription. */
  if (method === "HEAD") {
    return {
      statusCode: 200,
      headers: { ...CORS, "Cache-Control": "no-store" },
      body: "",
    };
  }

  if (method !== "POST") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" }, CORS);
  }

  const rawBody = rawBodyFromEvent(event);
  const signatureHeader = headerValue(
    /** @type {Record<string, unknown> | undefined} */ (event.headers),
    "X-Mindbody-Signature",
  );

  const secret = (process.env.MINDBODY_WEBHOOK_SIGNATURE_KEY || "").trim();
  const skipVerify =
    (process.env.MINDBODY_WEBHOOK_SKIP_VERIFY || "").trim() === "1" ||
    (process.env.MINDBODY_WEBHOOK_SKIP_VERIFY || "").trim().toLowerCase() === "true";

  if (!secret && !skipVerify) {
    logWebhook({
      event: "mindbody_webhook_missing_signature_key",
      signatureValid: false,
      bodyBytes: rawBody.length,
    });
    return jsonResponse(503, { ok: false, error: "webhook_not_configured" }, CORS);
  }

  const signatureValid =
    skipVerify || verifyMindbodyWebhookSignature(rawBody, signatureHeader, secret);
  if (!signatureValid) {
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
  if (rawBody) {
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return jsonResponse(400, { ok: false, error: "invalid_json" }, CORS);
    }
  }

  const { messageId, eventId, siteId } = parseWebhookPayload(payload);
  const expectedSiteId = configuredMindbodySiteId();
  const siteMatch =
    expectedSiteId == null || siteId == null ? null : siteId === expectedSiteId;
  const scheduleEvent = eventId != null && SCHEDULE_WEBHOOK_EVENT_IDS.has(eventId);

  logWebhook({
    event: "mindbody_webhook_accepted",
    eventId,
    messageId,
    siteId,
    expectedSiteId,
    siteMatch,
    signatureValid: true,
    signatureVerifySkipped: skipVerify,
    scheduleEvent,
    bodyBytes: rawBody.length,
  });

  if (!scheduleEvent) {
    logWebhook({ event: "mindbody_webhook_ignored", eventId, messageId, siteId, siteMatch });
    return jsonResponse(200, { ok: true, ignored: true, eventId }, CORS);
  }

  if (expectedSiteId != null && siteId != null && siteId !== expectedSiteId) {
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

  if (!messageId) {
    const purge = await purgeScheduleEdgeCache();
    logWebhook({
      event: "mindbody_webhook_missing_message_id",
      eventId,
      siteId,
      siteMatch,
      purged: purge.ok && purge.purged === true,
      purgeOk: purge.ok,
      purgeReason: purge.reason ?? null,
    });
    return jsonResponse(
      200,
      { ok: true, eventId, purged: purge.ok && purge.purged === true, dedupe: "skipped_no_message_id" },
      CORS,
    );
  }

  const store = tryOpenWebhookDedupeStore(event);
  if (store) {
    const claim = await claimWebhookMessageId(store, messageId, { eventId: eventId ?? undefined });
    if (claim.kind === "duplicate") {
      logWebhook({
        event: "mindbody_webhook_duplicate",
        messageId,
        eventId,
        siteId,
        siteMatch,
        dedupe: "blobs",
      });
      return jsonResponse(200, { ok: true, duplicate: true, eventId, messageId }, CORS);
    }
  } else if (memoryDedupeIsDuplicate(messageId)) {
    logWebhook({
      event: "mindbody_webhook_duplicate",
      messageId,
      eventId,
      siteId,
      siteMatch,
      dedupe: "memory",
    });
    return jsonResponse(200, { ok: true, duplicate: true, eventId, messageId }, CORS);
  }

  const purge = await purgeScheduleEdgeCache();
  logWebhook({
    event: "mindbody_webhook_schedule_purged",
    messageId,
    eventId,
    siteId,
    siteMatch,
    signatureValid: true,
    purged: purge.ok && purge.purged === true,
    purgeOk: purge.ok,
    purgeReason: purge.reason ?? null,
    dedupeStore: Boolean(store),
  });

  return jsonResponse(
    200,
    {
      ok: true,
      eventId,
      messageId,
      tag: SCHEDULE_CACHE_TAG,
      purged: purge.ok && purge.purged === true,
    },
    CORS,
  );
}
