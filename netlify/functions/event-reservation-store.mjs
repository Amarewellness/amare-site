/**
 * Private-event reservation store (Netlify Blobs + local-memory fallback).
 * Not a Mindbody order — deposits and later charges stay on this record.
 */

import { randomUUID } from "node:crypto";
import { connectLambda, getStore } from "@netlify/blobs";

import { atomicCreateJSON, atomicUpdateJSON } from "./blobs-conditional-create.mjs";

const RESERVATIONS_STORE_NAME = "amare-event-reservations";
const SESSION_INDEX_STORE_NAME = "amare-event-reservations-by-session";
const BLOBS_EVENTUAL = /** @type {const} */ ("eventual");

/** @type {{ reservations: Map<string, unknown>; sessionIndex: Map<string, unknown> } | null} */
let memoryStoresSingleton = null;

function shouldUseLocalMemoryFallback() {
  if ((process.env.NETLIFY || "").trim()) return false;
  return (process.env.STRIPE_ORDER_STORE_LOCAL_MEMORY || "").trim() === "1";
}

/** @param {Map<string, unknown>} backing */
function makeMemoryStoreShim(backing) {
  /** @type {Map<string, string>} */
  const etags = new Map();
  /** @param {Map<string, unknown>} map @param {string} key */
  function bumpEtag(map, key) {
    const etag = `mem-${map.size}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    etags.set(key, etag);
    return etag;
  }
  return /** @type {import("@netlify/blobs").Store} */ (
    /** @type {unknown} */ ({
      /** @param {string} key */
      async get(key, opts) {
        const v = backing.get(key);
        if (v == null) return null;
        const clone = JSON.parse(JSON.stringify(v));
        if (opts?.type === "json") return clone;
        return clone;
      },
      /** @param {string} key @param {{ type?: string }} [opts] */
      async getWithMetadata(key, opts) {
        const v = backing.get(key);
        if (v == null) return null;
        const etag = etags.get(key) || bumpEtag(backing, key);
        const clone = JSON.parse(JSON.stringify(v));
        if (opts?.type === "json") return { data: clone, etag };
        return { data: clone, etag };
      },
      /** @param {string} key @param {string} body @param {{ onlyIfNew?: boolean; onlyIfMatch?: string }} [opts] */
      async set(key, body, opts) {
        if (opts?.onlyIfNew && backing.has(key)) {
          return /** @type {{ modified: boolean }} */ ({ modified: false });
        }
        if (opts?.onlyIfMatch != null) {
          const cur = etags.get(key);
          if (cur !== opts.onlyIfMatch) {
            return /** @type {{ modified: boolean }} */ ({ modified: false });
          }
        }
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          parsed = body;
        }
        backing.set(key, parsed);
        return { modified: true, etag: bumpEtag(backing, key) };
      },
      /** @param {string} key @param {unknown} value @param {{ onlyIfNew?: boolean; onlyIfMatch?: string }} [opts] */
      async setJSON(key, value, opts) {
        if (opts?.onlyIfNew && backing.has(key)) {
          return /** @type {{ modified: boolean }} */ ({ modified: false });
        }
        if (opts?.onlyIfMatch != null) {
          const cur = etags.get(key);
          if (cur !== opts.onlyIfMatch) {
            return /** @type {{ modified: boolean }} */ ({ modified: false });
          }
        }
        backing.set(key, JSON.parse(JSON.stringify(value)));
        return { modified: true, etag: bumpEtag(backing, key) };
      },
      /** @param {{ paginate?: boolean }} [_opts] */
      list(_opts) {
        const keys = Array.from(backing.keys());
        return /** @type {AsyncIterable<{ blobs: { key: string }[] }>} */ ({
          [Symbol.asyncIterator]() {
            let yielded = false;
            return {
              async next() {
                if (yielded) return { done: true, value: undefined };
                yielded = true;
                return { done: false, value: { blobs: keys.map((key) => ({ key })) } };
              },
            };
          },
        });
      },
    })
  );
}

function openMemoryStores() {
  if (!shouldUseLocalMemoryFallback()) return null;
  if (!memoryStoresSingleton) {
    memoryStoresSingleton = {
      reservations: new Map(),
      sessionIndex: new Map(),
    };
    console.warn(
      JSON.stringify({
        event: "event_reservation_store_memory_fallback_active",
        detail: "Using in-memory event reservation store for local dev.",
      }),
    );
  }
  return {
    reservations: makeMemoryStoreShim(memoryStoresSingleton.reservations),
    sessionIndex: makeMemoryStoreShim(memoryStoresSingleton.sessionIndex),
    readConsistency: BLOBS_EVENTUAL,
  };
}

/**
 * @param {{ blobs?: string } | unknown} [event]
 */
function openStores(event) {
  try {
    if (
      event &&
      typeof event === "object" &&
      typeof /** @type {{ blobs?: string }} */ (event).blobs === "string"
    ) {
      connectLambda(/** @type {{ blobs: string }} */ (event));
    }
    return {
      reservations: getStore({ name: RESERVATIONS_STORE_NAME, consistency: BLOBS_EVENTUAL }),
      sessionIndex: getStore({ name: SESSION_INDEX_STORE_NAME, consistency: BLOBS_EVENTUAL }),
      readConsistency: BLOBS_EVENTUAL,
    };
  } catch (e) {
    const mem = openMemoryStores();
    if (mem) return mem;
    console.warn(
      JSON.stringify({
        event: "event_reservation_store_unavailable",
        detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 240),
      }),
    );
    return null;
  }
}

const VALID_STATUSES = new Set([
  "deposit_pending",
  "deposit_paid_pending_confirm",
  "confirmed",
  "canceled",
  "expired",
]);

/**
 * @typedef {Object} EventReservation
 * @property {string} id
 * @property {"deposit_pending"|"deposit_paid_pending_confirm"|"confirmed"|"canceled"|"expired"} status
 * @property {string} firstName
 * @property {string} lastName
 * @property {string} email
 * @property {string} phone
 * @property {string} eventDate
 * @property {string} eventTime
 * @property {number} guests
 * @property {"reformer"|"mat"|"kangoo"} room
 * @property {boolean} styling
 * @property {number} packageCents
 * @property {number} depositCents
 * @property {number} stylingCents
 * @property {number} remainingCents
 * @property {number} [cleaningCents]
 * @property {{ beforeMinutes: number, sessionMinutes: number, afterMinutes: number, sessionLabel: string }} [schedule]
 * @property {number} overtimeBlockCents
 * @property {number} [overtimeCentsTotal]
 * @property {{ id: string, minutes: number, cents: number, stripeInvoiceId?: string, stripePaymentIntentId?: string, chargedAt: string, status: string }[]} [overtimeCharges]
 * @property {number} [customCentsTotal]
 * @property {{ id: string, description: string, cents: number, stripeInvoiceId?: string, stripePaymentIntentId?: string, chargedAt: string, status: string }[]} [customCharges]
 * @property {string} currency
 * @property {string} consentText
 * @property {string} consentAcceptedAt
 * @property {string} [consentIp]
 * @property {string} [stripeCustomerId]
 * @property {string} [stripeCheckoutSessionId]
 * @property {string} [stripePaymentIntentId]
 * @property {string} [stripePaymentMethodId]
 * @property {boolean} [stripeLivemode]
 * @property {boolean} [emailsSent]
 * @property {boolean} [confirmEmailSent]
 * @property {string} [confirmedAt]
 * @property {string} [canceledAt]
 * @property {string} [cancelNote]
 * @property {string} [previousEventDate]
 * @property {string} [previousEventTime]
 * @property {boolean} [remainingPaid]
 * @property {string} [remainingPaidAt]
 * @property {string} [remainingStripeInvoiceId]
 * @property {string} [offerId]
 * @property {boolean} [manualEntry]
 * @property {string} [staffNotes]
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/** @param {unknown} event */
export function openEventReservationStore(event) {
  const stores = openStores(event);
  const available = !!stores;

  /** @param {string} id */
  async function get(id) {
    if (!stores || !id) return null;
    const cur = await stores.reservations.get(id, {
      type: "json",
      consistency: stores.readConsistency,
    });
    if (!cur || typeof cur !== "object") return null;
    return /** @type {EventReservation} */ (cur);
  }

  /** @param {string} sessionId */
  async function getByCheckoutSessionId(sessionId) {
    if (!stores || !sessionId) return null;
    const idx = await stores.sessionIndex.get(sessionId, {
      type: "json",
      consistency: stores.readConsistency,
    });
    const id =
      idx && typeof idx === "object" && "id" in idx
        ? String(/** @type {{ id?: unknown }} */ (idx).id || "")
        : "";
    return id ? get(id) : null;
  }

  /**
   * @param {EventReservation} record
   * @param {{ onlyIfNew?: boolean }} [opts]
   */
  async function put(record, opts) {
    if (!stores) return { ok: false, reason: "store_unavailable" };
    if (!record?.id) return { ok: false, reason: "missing_id" };
    if (!VALID_STATUSES.has(record.status)) return { ok: false, reason: "invalid_status" };
    const now = new Date().toISOString();
    /** @type {EventReservation} */
    const toWrite = { ...record, createdAt: record.createdAt || now, updatedAt: now };
    if (opts?.onlyIfNew) {
      const wr = await atomicCreateJSON(stores.reservations, record.id, toWrite);
      if (!wr.modified) return { ok: false, reason: "exists" };
      return { ok: true };
    }
    await stores.reservations.setJSON(record.id, toWrite);
    return { ok: true };
  }

  /**
   * @param {string} id
   * @param {Partial<EventReservation>} patch
   */
  async function patch(id, patch) {
    if (!stores) return { ok: false, reason: "store_unavailable" };
    const wr = await atomicUpdateJSON(
      stores.reservations,
      id,
      (/** @type {EventReservation} */ cur) => {
        if (!cur || typeof cur !== "object") return cur;
        return { ...cur, ...patch, id: cur.id, createdAt: cur.createdAt, updatedAt: new Date().toISOString() };
      },
      { readConsistency: stores.readConsistency },
    );
    return wr.modified ? { ok: true } : { ok: false, reason: "not_found" };
  }

  /** @param {string} sessionId @param {string} id */
  async function indexSession(sessionId, id) {
    if (!stores || !sessionId || !id) return;
    await stores.sessionIndex.setJSON(sessionId, { id });
  }

  /**
   * @param {{ limit?: number }} [opts]
   * @returns {Promise<EventReservation[]>}
   */
  async function list(opts) {
    if (!stores) return [];
    const limit = Math.min(Math.max(Number(opts?.limit) || 200, 1), 500);
    /** @type {EventReservation[]} */
    const out = [];
    const pages = stores.reservations.list({ paginate: true });
    let scanned = 0;
    const SCAN_CAP = 2000;
    for await (const page of pages) {
      const blobs = page?.blobs ?? [];
      for (const b of blobs) {
        if (out.length >= limit) break;
        scanned += 1;
        if (scanned > SCAN_CAP) break;
        const key = b?.key;
        if (typeof key !== "string") continue;
        const cur = await stores.reservations.get(key, {
          type: "json",
          consistency: stores.readConsistency,
        });
        if (cur && typeof cur === "object" && "id" in cur) {
          out.push(/** @type {EventReservation} */ (cur));
        }
      }
      if (out.length >= limit || scanned > SCAN_CAP) break;
    }
    return out;
  }

  return { available, get, getByCheckoutSessionId, put, patch, indexSession, list };
}

export function newEventReservationId() {
  return `evt_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}
