/**
 * Personalized /event-info offers (admin-sent links).
 * Token in the URL is the record id — unguessable, not a signed JWT.
 */

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { connectLambda, getStore } from "@netlify/blobs";
import { reservationDepositPaid } from "./event-booking-lib.mjs";

const STORE_NAME = "amare-event-offers";
const LOCAL_STORE_REL = path.join("data", "event-offers", "local-store.json");
const OFFER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** @type {Map<string, unknown> | null} */
let memorySingleton = null;

function resolveLocalStoreFile() {
  if (typeof import.meta?.url === "string" && import.meta.url) {
    return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", LOCAL_STORE_REL);
  }
  return process.cwd() === undefined ? LOCAL_STORE_REL : path.join(process.cwd(), LOCAL_STORE_REL);
}

/** @returns {Map<string, unknown>} */
function loadLocalFromDisk() {
  /** @type {Map<string, unknown>} */
  const backing = new Map();
  try {
    const parsed = JSON.parse(fs.readFileSync(resolveLocalStoreFile(), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return backing;
    for (const [key, value] of Object.entries(parsed)) backing.set(key, value);
  } catch {
    /* missing */
  }
  return backing;
}

/** @param {Map<string, unknown>} backing */
function persistLocal(backing) {
  try {
    const file = resolveLocalStoreFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [key, value] of backing.entries()) out[key] = value;
    fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "event_offer_local_store_persist_failed",
        detail: String(/** @type {{ message?: string }} */ (err)?.message ?? err).slice(0, 200),
      }),
    );
  }
}

/** @param {Map<string, unknown>} backing */
function makeMemoryStore(backing) {
  return /** @type {import("@netlify/blobs").Store} */ (
    /** @type {unknown} */ ({
      async get(key, opts) {
        const v = backing.get(key);
        if (v == null) return null;
        const clone = JSON.parse(JSON.stringify(v));
        return opts?.type === "json" ? clone : clone;
      },
      async setJSON(key, value) {
        backing.set(key, JSON.parse(JSON.stringify(value)));
        persistLocal(backing);
        return { modified: true };
      },
      list() {
        const keys = Array.from(backing.keys());
        return {
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
        };
      },
    })
  );
}

/**
 * @param {{ blobs?: string } | unknown} [event]
 */
function openBlobStore(event) {
  try {
    if (event && typeof event === "object" && typeof /** @type {{ blobs?: string }} */ (event).blobs === "string") {
      connectLambda(/** @type {{ blobs: string }} */ (event));
    }
    return getStore({ name: STORE_NAME });
  } catch (e) {
    if ((process.env.NETLIFY || "").trim()) {
      console.warn(
        JSON.stringify({
          event: "event_offer_store_unavailable",
          detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 240),
        }),
      );
      return null;
    }
    if (!memorySingleton) memorySingleton = loadLocalFromDisk();
    return makeMemoryStore(memorySingleton);
  }
}

/**
 * @typedef {Object} EventOffer
 * @property {string} id
 * @property {string} [inquiryId]
 * @property {string} firstName
 * @property {string} lastName
 * @property {string} email
 * @property {string} phone
 * @property {string} eventDate
 * @property {string} eventTime
 * @property {boolean} lockDateTime
 * @property {boolean} lockName
 * @property {boolean} lockEmail
 * @property {boolean} lockPhone
 * @property {number} [guests]
 * @property {string} [room]
 * @property {boolean} [lockGuestsRoom]
 * @property {number} [packageCents]
 * @property {number} [depositCents]
 * @property {boolean} [depositPaid]
 * @property {boolean} [styling]
 * @property {boolean} [lockStyling]
 * @property {number} [cleaningCents]
 * @property {{ beforeMinutes: number, sessionMinutes: number, afterMinutes: number, sessionLabel: string }} [schedule]
 * @property {"details"|"book"} [lastSentKind]
 * @property {string} [sentDetailsAt]
 * @property {string} [sentBookAt]
 * @property {"sent"|"used"|"superseded"} status
 * @property {string} [reservationId]
 * @property {string} expiresAt
 * @property {string} createdAt
 * @property {string} [sentAt]
 */

/** @param {unknown} event */
export function openEventOfferStore(event) {
  const store = openBlobStore(event);
  const available = !!store;

  /** @param {string} id */
  async function get(id) {
    if (!store || !id) return null;
    const cur = await store.get(id, { type: "json" });
    if (!cur || typeof cur !== "object" || !("id" in cur)) return null;
    return /** @type {EventOffer} */ (cur);
  }

  /** @param {EventOffer} record */
  async function put(record) {
    if (!store || !record?.id) return { ok: false };
    await store.setJSON(record.id, record);
    return { ok: true };
  }

  /**
   * @param {{ limit?: number }} [opts]
   * @returns {Promise<EventOffer[]>}
   */
  async function list(opts) {
    if (!store) return [];
    const limit = Math.min(Math.max(Number(opts?.limit) || 200, 1), 500);
    /** @type {EventOffer[]} */
    const out = [];
    const pages = store.list({ paginate: true });
    let scanned = 0;
    for await (const page of pages) {
      for (const b of page?.blobs ?? []) {
        if (out.length >= limit || scanned > 2000) break;
        scanned += 1;
        const key = b?.key;
        if (typeof key !== "string") continue;
        const cur = await store.get(key, { type: "json" });
        if (cur && typeof cur === "object" && "id" in cur && "email" in cur) {
          out.push(/** @type {EventOffer} */ (cur));
        }
      }
      if (out.length >= limit || scanned > 2000) break;
    }
    return out;
  }

  return { available, get, put, list };
}

export function newEventOfferId() {
  return `off_${randomBytes(18).toString("base64url")}`;
}

export function defaultOfferExpiryIso(from = new Date()) {
  return new Date(from.getTime() + OFFER_TTL_MS).toISOString();
}

/** @param {EventOffer | null | undefined} offer */
export function offerIsOpen(offer) {
  if (!offer || offer.status !== "sent") return false;
  if (offer.expiresAt && Date.parse(offer.expiresAt) <= Date.now()) return false;
  return true;
}

/**
 * @param {Record<string, unknown>} body
 * @param {EventOffer} offer
 */
export function applyOfferLocks(body, offer) {
  const next = { ...body };
  if (offer.lockDateTime) {
    next.eventDate = offer.eventDate;
    next.eventTime = offer.eventTime;
  }
  if (offer.lockName) {
    next.firstName = offer.firstName;
    next.lastName = offer.lastName;
  }
  if (offer.lockEmail) next.email = offer.email;
  if (offer.lockPhone) next.phone = offer.phone;
  if (offer.lockGuestsRoom) {
    if (offer.guests) next.guests = offer.guests;
    if (offer.room) next.room = offer.room;
  }
  if (offer.lockStyling || offer.styling === true) next.styling = offer.styling === true;
  return next;
}

/**
 * Booking links tied to a staff reservation use the reservation as pricing source of truth.
 * @param {Record<string, unknown>} body
 * @param {EventOffer | null | undefined} offer
 * @param {import("./event-reservation-store.mjs").EventReservation | null | undefined} rec
 */
export function applyReservationPricingLocks(body, offer, rec) {
  let next = offer ? applyOfferLocks(body, offer) : { ...body };
  if (!rec) return next;
  if (rec.styling === true) next.styling = true;
  if (rec.guests) next.guests = rec.guests;
  if (rec.room) next.room = rec.room;
  if (rec.eventDate) next.eventDate = rec.eventDate;
  if (rec.eventTime) next.eventTime = rec.eventTime;
  return next;
}

/**
 * @param {EventOffer | null | undefined} offer
 * @param {import("./event-reservation-store.mjs").EventReservation | null | undefined} rec
 * @param {{ packageDefault?: number, depositDefault?: number }} [defaults]
 */
export function eventPriceOverrideFrom(offer, rec, defaults = {}) {
  const packageDefault = defaults.packageDefault ?? 55000;
  const depositDefault = defaults.depositDefault ?? 20000;
  const packageCents = rec?.packageCents ?? offer?.packageCents ?? packageDefault;
  const depositCents = rec?.depositCents ?? offer?.depositCents ?? depositDefault;
  const cleaningRaw = rec?.cleaningCents ?? offer?.cleaningCents ?? 0;
  return {
    packageCents: Number.isInteger(packageCents) && packageCents > 0 ? packageCents : packageDefault,
    depositCents: Number.isInteger(depositCents) && depositCents >= 0 ? depositCents : depositDefault,
    cleaningCents: Number.isInteger(cleaningRaw) && cleaningRaw > 0 ? cleaningRaw : 0,
  };
}

/**
 * Rebuild a viewable offer from a paid reservation when the offer blob is missing.
 * @param {import("./event-reservation-store.mjs").EventReservation} rec
 * @param {string} offerId
 * @returns {EventOffer}
 */
export function offerFromReservation(rec, offerId) {
  const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  return {
    id: offerId,
    reservationId: rec.id,
    firstName: rec.firstName,
    lastName: rec.lastName,
    email: rec.email,
    phone: rec.phone || "",
    eventDate: rec.eventDate,
    eventTime: rec.eventTime,
    lockDateTime: true,
    lockName: true,
    lockEmail: true,
    lockPhone: true,
    guests: rec.guests,
    room: rec.room || "auto",
    lockGuestsRoom: true,
    packageCents: rec.packageCents,
    depositCents: rec.depositCents,
    depositPaid: reservationDepositPaid(rec),
    styling: rec.styling === true,
    stylingCents: rec.stylingCents,
    lockStyling: rec.styling === true,
    cleaningCents: rec.cleaningCents,
    schedule: rec.schedule,
    status: "used",
    expiresAt: farFuture,
    createdAt: rec.createdAt || new Date().toISOString(),
    sentAt: rec.bookingLinkSentAt || rec.createdAt,
    reservationStatus: rec.status || "",
  };
}

/** @param {EventOffer} offer */
export function toPublicOffer(offer) {
  return {
    id: offer.id,
    firstName: offer.firstName,
    lastName: offer.lastName,
    email: offer.email,
    phone: offer.phone,
    eventDate: offer.eventDate,
    eventTime: offer.eventTime,
    lockDateTime: offer.lockDateTime === true,
    lockName: offer.lockName === true,
    lockEmail: offer.lockEmail === true,
    lockPhone: offer.lockPhone === true,
    guests: Number.isInteger(offer.guests) ? offer.guests : 0,
    room: offer.room || "auto",
    lockGuestsRoom: offer.lockGuestsRoom === true,
    packageCents: Number.isInteger(offer.packageCents) ? offer.packageCents : 55000,
    depositCents: Number.isInteger(offer.depositCents) ? offer.depositCents : 20000,
    depositPaid: offer.depositPaid === true,
    remainingPaid: offer.remainingPaid === true,
    remainingCents: Number.isInteger(offer.remainingCents) ? offer.remainingCents : undefined,
    stylingCents: Number.isInteger(offer.stylingCents) ? offer.stylingCents : undefined,
    styling: offer.styling === true,
    lockStyling: offer.lockStyling === true,
    cleaningCents: Number.isInteger(offer.cleaningCents) ? offer.cleaningCents : 0,
    schedule: offer.schedule || undefined,
    expiresAt: offer.expiresAt,
    status: offer.status,
    reservationStatus: typeof offer.reservationStatus === "string" ? offer.reservationStatus : "",
  };
}
