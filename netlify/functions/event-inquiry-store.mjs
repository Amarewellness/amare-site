/**
 * Private-event inquiry store (Netlify Blobs + local file fallback).
 * These are /privateevents form submissions — not Stripe deposits.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { connectLambda, getStore } from "@netlify/blobs";

const STORE_NAME = "amare-event-inquiries";
const LOCAL_STORE_REL = path.join("data", "event-inquiries", "local-store.json");

/** @type {Map<string, unknown> | null} */
let memorySingleton = null;

function resolveLocalStoreFile() {
  if (typeof import.meta?.url === "string" && import.meta.url) {
    return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", LOCAL_STORE_REL);
  }
  return path.join(process.cwd(), LOCAL_STORE_REL);
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
        event: "event_inquiry_local_store_persist_failed",
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
function makeMemoryStore(backing) {
  /** @type {Map<string, string>} */
  const etags = new Map();
  function bump(key) {
    const etag = `mem-${backing.size}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    etags.set(key, etag);
    return etag;
  }
  return /** @type {import("@netlify/blobs").Store} */ (
    /** @type {unknown} */ ({
      async get(key, opts) {
        const v = backing.get(key);
        if (v == null) return null;
        const clone = JSON.parse(JSON.stringify(v));
        return opts?.type === "json" ? clone : clone;
      },
      async getWithMetadata(key, opts) {
        const v = backing.get(key);
        if (v == null) return null;
        const etag = etags.get(key) || bump(key);
        const clone = JSON.parse(JSON.stringify(v));
        return { data: opts?.type === "json" ? clone : clone, etag };
      },
      async setJSON(key, value) {
        backing.set(key, JSON.parse(JSON.stringify(value)));
        persistLocal(backing);
        return { modified: true, etag: bump(key) };
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
    if (!useLocalFallback()) {
      console.warn(
        JSON.stringify({
          event: "event_inquiry_store_unavailable",
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
 * @typedef {Object} EventInquiry
 * @property {string} id
 * @property {string} firstName
 * @property {string} lastName
 * @property {string} email
 * @property {string} phone
 * @property {string} eventDate
 * @property {string} eventTime
 * @property {string} message
 * @property {"site"|"netlify"} source
 * @property {string} [netlifyId]
 * @property {string} createdAt
 */

/** @param {unknown} event */
export function openEventInquiryStore(event) {
  const store = openBlobStore(event);
  const available = !!store;

  /** @param {EventInquiry} record */
  async function put(record) {
    if (!store || !record?.id) return { ok: false };
    await store.setJSON(record.id, record);
    return { ok: true };
  }

  /**
   * @param {{ limit?: number }} [opts]
   * @returns {Promise<EventInquiry[]>}
   */
  async function list(opts) {
    if (!store) return [];
    const limit = Math.min(Math.max(Number(opts?.limit) || 200, 1), 500);
    /** @type {EventInquiry[]} */
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
          out.push(/** @type {EventInquiry} */ (cur));
        }
      }
      if (out.length >= limit || scanned > 2000) break;
    }
    return out;
  }

  return { available, put, list };
}

export function newEventInquiryId() {
  return `inq_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

/** @param {string} year @param {string} month @param {string} day */
export function composeInquiryDate(year, month, day) {
  const y = String(year || "").trim();
  const m = String(month || "").trim().padStart(2, "0");
  const d = String(day || "").trim().padStart(2, "0");
  if (!/^\d{4}$/.test(y) || !/^(0[1-9]|1[0-2])$/.test(m) || !/^(0[1-9]|[12]\d|3[01])$/.test(d)) {
    return "";
  }
  return `${y}-${m}-${d}`;
}

/** @param {Pick<EventInquiry, "email"|"eventDate"|"eventTime"|"message">} row */
export function inquiryFingerprint(row) {
  const email = String(row.email || "").trim().toLowerCase();
  const date = String(row.eventDate || "").trim();
  const time = String(row.eventTime || "").trim();
  const msg = String(row.message || "").trim().toLowerCase().slice(0, 80);
  return `${email}|${date}|${time}|${msg}`;
}
