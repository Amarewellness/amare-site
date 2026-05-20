import { connectLambda, getStore } from "@netlify/blobs";

import { atomicCreateJSON } from "./blobs-conditional-create.mjs";

const STORE_NAME = "mindbody-webhook-schedule-dedupe";

/** Schedule-shape events that should invalidate `mindbody-schedule` (see docs/MINDBODY.md PR-2). */
export const SCHEDULE_WEBHOOK_EVENT_IDS = new Set([
  "class.updated",
  "classSchedule.created",
  "classSchedule.updated",
  "classSchedule.cancelled",
  "classDescription.updated",
]);

export const SCHEDULE_CACHE_TAG = "mindbody-schedule";

export function webhookDedupeBlobsEnabled() {
  const v = (process.env.MINDBODY_WEBHOOK_DEDUPE_BLOBS || "").trim();
  if (v === "1" || v.toLowerCase() === "true") return true;
  /** On Netlify, default to dedupe when Blobs are available unless explicitly disabled. */
  if (v === "0" || v.toLowerCase() === "false") return false;
  return Boolean(process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME);
}

/**
 * @param {{ blobs?: string } | unknown} event
 */
export function tryOpenWebhookDedupeStore(event) {
  if (!webhookDedupeBlobsEnabled()) return null;
  try {
    if (
      event &&
      typeof event === "object" &&
      typeof /** @type {{ blobs?: string }} */ (event).blobs === "string"
    ) {
      connectLambda(/** @type {{ blobs: string }} */ (event));
    }
    return getStore({ name: STORE_NAME });
  } catch (e) {
    console.warn(
      JSON.stringify({
        event: "mindbody_webhook_dedupe_blobs_unavailable",
        detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 300),
      }),
    );
    return null;
  }
}

/**
 * @param {string} messageId
 */
export function webhookDedupeBlobKey(messageId) {
  return `v1/${messageId}`;
}

/**
 * @param {import("@netlify/blobs").Store} store
 * @param {string} messageId
 * @param {{ eventId?: string }} meta
 */
export async function claimWebhookMessageId(store, messageId, meta) {
  const key = webhookDedupeBlobKey(messageId);
  const initial = {
    messageId,
    eventId: meta.eventId ?? null,
    receivedAt: new Date().toISOString(),
  };
  const wr = await atomicCreateJSON(store, key, initial);
  if (wr.modified) return { kind: /** @type {const} */ ("claimed") };
  return { kind: /** @type {const} */ ("duplicate") };
}
