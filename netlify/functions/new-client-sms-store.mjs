/**
 * Idempotency store for New Client SMS conversion follow-up.
 *
 * Key: `v1/{segment}/{mindbodyClientId}/{ncsClientServiceId}`
 * One record per client + segment + NCS pricing-option instance.
 */

import { connectLambda, getStore } from "@netlify/blobs";

import { atomicCreateJSON } from "./blobs-conditional-create.mjs";

const STORE_NAME = "new-client-sms-records";

/** @typedef {"one_remaining"|"expiring_soon"|"completed_no_purchase"|"classpass_repeat"} SmsSegmentId */

/**
 * @typedef {Object} SmsSendRecord
 * @property {SmsSegmentId} segment
 * @property {number} mindbodyClientId
 * @property {number} ncsClientServiceId
 * @property {string} phoneLast4
 * @property {string} messagePreview
 * @property {"pending"|"sent"|"failed"} smsStatus
 * @property {string | null} twilioMessageSid
 * @property {string | null} errorMessage
 * @property {number} sendAttempts
 * @property {string} createdAt
 * @property {string | null} sentAt
 * @property {string} lastAttemptAt
 * @property {boolean} dryRun
 */

let memoryStoreSingleton = null;

function shouldUseLocalMemoryFallback() {
  if ((process.env.NETLIFY || "").trim()) return false;
  return (process.env.NEW_CLIENT_SMS_STORE_LOCAL_MEMORY || "").trim() === "1";
}

/** @param {Map<string, unknown>} backing */
function makeMemoryStoreShim(backing) {
  return /** @type {import("@netlify/blobs").Store} */ (
    /** @type {unknown} */ ({
      /** @param {string} key */
      async get(key) {
        const v = backing.get(key);
        return v == null ? null : JSON.parse(JSON.stringify(v));
      },
      /** @param {string} key @param {unknown} value @param {{ onlyIfNew?: boolean }} [opts] */
      async setJSON(key, value, opts) {
        if (opts?.onlyIfNew && backing.has(key)) {
          return /** @type {{ modified: boolean }} */ ({ modified: false });
        }
        backing.set(key, JSON.parse(JSON.stringify(value)));
        return /** @type {{ modified: boolean }} */ ({ modified: true });
      },
      /** @param {string} key @param {string} body @param {{ onlyIfNew?: boolean }} [opts] */
      async set(key, body, opts) {
        if (opts?.onlyIfNew && backing.has(key)) {
          return /** @type {{ modified: boolean }} */ ({ modified: false });
        }
        backing.set(key, JSON.parse(body));
        return /** @type {{ modified: boolean }} */ ({ modified: true });
      },
    })
  );
}

/** @param {unknown} event */
function openStores(event) {
  if (shouldUseLocalMemoryFallback()) {
    if (!memoryStoreSingleton) {
      memoryStoreSingleton = makeMemoryStoreShim(new Map());
    }
    return { records: memoryStoreSingleton, available: true, mode: "local_memory" };
  }
  try {
    if (event && typeof event === "object") {
      connectLambda(event);
    }
    const records = getStore(STORE_NAME);
    return { records, available: true, mode: "netlify_blobs" };
  } catch {
    return { records: null, available: false, mode: "unavailable" };
  }
}

/**
 * @param {SmsSegmentId} segment
 * @param {number} mindbodyClientId
 * @param {number} ncsClientServiceId
 */
export function smsRecordKey(segment, mindbodyClientId, ncsClientServiceId) {
  return `v1/${segment}/${Math.trunc(mindbodyClientId)}/${Math.trunc(ncsClientServiceId)}`;
}

/** @param {unknown} event */
export function openSmsFollowupStore(event) {
  const stores = openStores(event);

  /**
   * @param {SmsSegmentId} segment
   * @param {number} mindbodyClientId
   * @param {number} ncsClientServiceId
   * @returns {Promise<SmsSendRecord | null>}
   */
  async function get(segment, mindbodyClientId, ncsClientServiceId) {
    if (!stores.records) return null;
    const key = smsRecordKey(segment, mindbodyClientId, ncsClientServiceId);
    /** @type {unknown} */
    const cur = await stores.records.get(key, { type: "json" });
    return cur && typeof cur === "object" ? /** @type {SmsSendRecord} */ (cur) : null;
  }

  /**
   * @param {SmsSendRecord} record
   * @returns {Promise<{ ok: boolean; reason?: string }>}
   */
  async function putIfNew(record) {
    if (!stores.records) return { ok: false, reason: "store_unavailable" };
    const key = smsRecordKey(record.segment, record.mindbodyClientId, record.ncsClientServiceId);
    const wr = await atomicCreateJSON(stores.records, key, record);
    return wr.modified ? { ok: true } : { ok: false, reason: "exists" };
  }

  /**
   * @param {SmsSegmentId} segment
   * @param {number} mindbodyClientId
   * @param {number} ncsClientServiceId
   * @param {Partial<SmsSendRecord>} patch
   */
  async function patch(segment, mindbodyClientId, ncsClientServiceId, patch) {
    if (!stores.records) return null;
    const key = smsRecordKey(segment, mindbodyClientId, ncsClientServiceId);
    /** @type {unknown} */
    const cur = await stores.records.get(key, { type: "json" });
    if (!cur || typeof cur !== "object") return null;
    const before = /** @type {SmsSendRecord} */ (cur);
    /** @type {SmsSendRecord} */
    const next = {
      ...before,
      ...patch,
      segment: before.segment,
      mindbodyClientId: before.mindbodyClientId,
      ncsClientServiceId: before.ncsClientServiceId,
      lastAttemptAt: new Date().toISOString(),
    };
    await stores.records.setJSON(key, next);
    return next;
  }

  return {
    available: () => stores.available,
    mode: () => stores.mode,
    get,
    putIfNew,
    patch,
  };
}
