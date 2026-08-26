/**
 * Private-event reservation store (Netlify Blobs + local file fallback).
 * Not a Mindbody order — deposits and later charges stay on this record.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { connectLambda, getStore } from "@netlify/blobs";

import { atomicCreateJSON, atomicUpdateJSON } from "./blobs-conditional-create.mjs";

const RESERVATIONS_STORE_NAME = "amare-event-reservations";
const SESSION_INDEX_STORE_NAME = "amare-event-reservations-by-session";
const LOCAL_STORE_REL = path.join("data", "event-reservations", "local-store.json");
const BLOBS_EVENTUAL = /** @type {const} */ ("eventual");

/** @type {{ reservations: Map<string, unknown>; sessionIndex: Map<string, unknown> } | null} */
let memoryStoresSingleton = null;

function resolveLocalStoreFile() {
  if (typeof import.meta?.url === "string" && import.meta.url) {
    return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", LOCAL_STORE_REL);
  }
  return path.join(process.cwd(), LOCAL_STORE_REL);
}

/** @returns {{ reservations: Map<string, unknown>; sessionIndex: Map<string, unknown> }} */
function loadLocalFromDisk() {
  /** @type {Map<string, unknown>} */
  const reservations = new Map();
  /** @type {Map<string, unknown>} */
  const sessionIndex = new Map();
  try {
    const parsed = JSON.parse(fs.readFileSync(resolveLocalStoreFile(), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const recs = /** @type {Record<string, unknown>} */ (parsed).reservations;
      const idx = /** @type {Record<string, unknown>} */ (parsed).sessionIndex;
      if (recs && typeof recs === "object") {
        for (const [key, value] of Object.entries(recs)) reservations.set(key, value);
      }
      if (idx && typeof idx === "object") {
        for (const [key, value] of Object.entries(idx)) sessionIndex.set(key, value);
      }
    }
  } catch {
    /* missing or corrupt — start fresh */
  }
  return { reservations, sessionIndex };
}

function persistLocalSnapshot() {
  if (!memoryStoresSingleton) return;
  try {
    const file = resolveLocalStoreFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    /** @type {Record<string, unknown>} */
    const reservations = {};
    /** @type {Record<string, unknown>} */
    const sessionIndex = {};
    for (const [key, value] of memoryStoresSingleton.reservations.entries()) reservations[key] = value;
    for (const [key, value] of memoryStoresSingleton.sessionIndex.entries()) sessionIndex[key] = value;
    fs.writeFileSync(file, `${JSON.stringify({ reservations, sessionIndex }, null, 2)}\n`, "utf8");
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "event_reservation_local_store_persist_failed",
        detail: String(/** @type {{ message?: string }} */ (err)?.message ?? err).slice(0, 200),
      }),
    );
  }
}

function useLocalFallback() {
  if ((process.env.NETLIFY || "").trim()) return false;
  return true;
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
        persistLocalSnapshot();
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
        persistLocalSnapshot();
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
      /** @param {string} key */
      async delete(key) {
        const had = backing.delete(key);
        etags.delete(key);
        if (had) persistLocalSnapshot();
        return { deleted: had };
      },
    })
  );
}

function openMemoryStores() {
  if (!useLocalFallback()) return null;
  if (!memoryStoresSingleton) {
    memoryStoresSingleton = loadLocalFromDisk();
    console.warn(
      JSON.stringify({
        event: "event_reservation_store_local_fallback_active",
        detail: "Using local file event reservation store for dev.",
        file: LOCAL_STORE_REL,
        reservations: memoryStoresSingleton.reservations.size,
        sessionIndex: memoryStoresSingleton.sessionIndex.size,
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
 * @property {boolean} [depositPaid]
 * @property {string} [remainingPaidAt]
 * @property {string} [remainingStripeInvoiceId]
 * @property {string} [offerId]
 * @property {string} [bookingLinkSentAt]
 * @property {{ id: string, at: string, kind: string, label: string, amountCents?: number, offerId?: string, meta?: Record<string, unknown> }[]} [activityLog]
 * @property {boolean} [manualEntry]
 * @property {string} [staffNotes]
 * @property {boolean} [archived]
 * @property {string} [archivedAt]
 * @property {number} [checkoutGeneration]
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

  /** @param {string} offerId */
  async function findByOfferId(offerId) {
    if (!stores || !offerId) return null;
    const pages = stores.reservations.list({ paginate: true });
    let scanned = 0;
    const SCAN_CAP = 2000;
    for await (const page of pages) {
      const blobs = page?.blobs ?? [];
      for (const b of blobs) {
        scanned += 1;
        if (scanned > SCAN_CAP) return null;
        const key = b?.key;
        if (typeof key !== "string") continue;
        const cur = await stores.reservations.get(key, {
          type: "json",
          consistency: stores.readConsistency,
        });
        if (cur && typeof cur === "object" && /** @type {{ offerId?: string }} */ (cur).offerId === offerId) {
          return /** @type {EventReservation} */ (cur);
        }
      }
      if (scanned > SCAN_CAP) break;
    }
    return null;
  }

  /** @param {string} id */
  async function remove(id) {
    if (!stores || !id) return { ok: false, reason: "store_unavailable" };
    const rec = await get(id);
    if (!rec) return { ok: false, reason: "not_found" };
    const sessionId = String(rec.stripeCheckoutSessionId || "").trim();
    if (sessionId && typeof stores.sessionIndex.delete === "function") {
      await stores.sessionIndex.delete(sessionId);
    }
    if (typeof stores.reservations.delete === "function") {
      await stores.reservations.delete(id);
    } else {
      return { ok: false, reason: "delete_unavailable" };
    }
    return { ok: true };
  }

  return { available, get, getByCheckoutSessionId, put, patch, indexSession, list, findByOfferId, remove };
}

export function newEventReservationId() {
  return `evt_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}
