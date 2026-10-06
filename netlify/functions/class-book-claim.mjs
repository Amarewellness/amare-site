/**
 * Duplicate-booking guard for one paid seat: clientId + classId.
 *
 * Three layers:
 * 1. Active Mindbody visit preflight — long-term guard once clientvisits
 *    shows the Visit.
 * 2. Atomic in-progress claim — one invocation owns AddClientToClass.
 * 3. Completed claim — after payment verification, the same key keeps visitId
 *    for a short TTL so a retry is safe while clientvisits is still stale.
 *
 * Atomic primitive: Netlify Blobs conditional create via `atomicCreateJSON`
 * (`Store.set` + `onlyIfNew: true` → `If-None-Match: *`). That is the
 * cross-invocation CAS this repo already proved after the 2026-05-15
 * duplicate-sale incident (`blobs-conditional-create.mjs`). `setJSON({ onlyIfNew })`
 * is NOT used — the SDK drops that condition.
 *
 * Postgres was evaluated first and not used:
 * - `amare-identity-store.mjs` forbids live booking from calling identity writes.
 * - `pg_advisory_lock` holds a pooled session for the whole Mindbody round trip.
 * - A new UNIQUE table needs a migration on that same database before it is safe.
 *
 * Expired or released claims are taken over with `atomicUpdateJSON` (`onlyIfMatch`
 * etag CAS), not with get-if-missing-then-set.
 */
import { randomUUID } from "node:crypto";
import { connectLambda, getStore } from "@netlify/blobs";
import { atomicCreateJSON, atomicUpdateJSON } from "./blobs-conditional-create.mjs";
import { fetchClientVisitsWindow, visitClassIdFromRow, visitIdFromRow } from "./mindbody-class-book-lib.mjs";

/**
 * Observed successful `mindbody-class-book` runs finish in about 3–5s.
 * Payment-verify retries add 600+900+1000 ms. This repo's longest configured
 * synchronous function timeout is 26s; `mindbody-class-book` itself has no
 * override (platform default, not longer than that 26s ceiling).
 * 45s outlives a killed invocation, then lets a crashed-before-commit client retry.
 */
export const CLASS_BOOK_CLAIM_TTL_MS = 45_000;

/**
 * How long a verified booking keeps blocking a second AddClientToClass after
 * the in-progress claim would otherwise be released.
 *
 * Muriel's second request arrived 11.7s after the first HTTP 200. A mobile
 * summary refresh can also lag a few seconds behind the new Visit. 45s is
 * about four times that observed retry, and it matches the in-progress crash
 * bound so the completed record cannot outlive the window we already accept
 * for a dead Lambda. The clock starts at payment verification, not at acquire,
 * so the full 45s remains after the response. It is not permanent.
 * After expiry, the active-visit preflight is the long-term guard.
 * A successful member cancel releases this state immediately.
 */
export const CLASS_BOOK_COMPLETED_TTL_MS = 45_000;

const STORE_NAME = "class-book-claims";

/** @type {import("./blobs-conditional-create.mjs").BlobsLikeStore | null} */
let testStore = null;

/**
 * @param {import("./blobs-conditional-create.mjs").BlobsLikeStore | null} store
 */
export function setClassBookClaimStoreForTests(store) {
  testStore = store;
}

/**
 * In-memory CAS store. `onlyIfNew` / `onlyIfMatch` are applied synchronously
 * inside `set`, so two overlapping async acquires cannot both observe a miss.
 *
 * @returns {import("./blobs-conditional-create.mjs").BlobsLikeStore}
 */
export function createMemoryClassBookClaimStore() {
  /** @type {Map<string, { body: string, etag: string }>} */
  const backing = new Map();
  let seq = 1;
  return {
    async get(key, opts) {
      const row = backing.get(key);
      if (!row) return null;
      if (opts?.type === "json") return JSON.parse(row.body);
      return row.body;
    },
    async getWithMetadata(key, opts) {
      const row = backing.get(key);
      if (!row) return null;
      const data = opts?.type === "json" ? JSON.parse(row.body) : row.body;
      return { data, etag: row.etag };
    },
    async set(key, body, opts) {
      const cur = backing.get(key);
      if (opts?.onlyIfNew && cur) return { modified: false };
      if (opts?.onlyIfMatch && (!cur || cur.etag !== opts.onlyIfMatch)) return { modified: false };
      const etag = `mem-${seq++}`;
      backing.set(key, { body, etag });
      return { modified: true, etag };
    },
    async setJSON(key, value, opts) {
      return this.set(key, JSON.stringify(value), opts);
    },
  };
}

/**
 * @param {{ blobs?: string } | null | undefined} [event]
 * @returns {import("./blobs-conditional-create.mjs").BlobsLikeStore | null}
 */
export function openClassBookClaimStore(event) {
  if (testStore) return testStore;
  try {
    if (event && typeof event === "object" && typeof event.blobs === "string") {
      connectLambda(/** @type {{ blobs: string }} */ (event));
    }
    return /** @type {import("./blobs-conditional-create.mjs").BlobsLikeStore} */ (
      getStore({ name: STORE_NAME, consistency: "eventual" })
    );
  } catch {
    return null;
  }
}

/** @param {number} clientId @param {number} classId */
export function classBookClaimKey(clientId, classId) {
  return `class-book:${Math.trunc(clientId)}:${Math.trunc(classId)}`;
}

/**
 * An active enrolled visit for this exact class instance.
 * Not active: late-cancelled, cancelled/removed status, waitlist rows, other classes.
 * Booked, signed-in, missed, and no-show rows for this classId still occupy the seat.
 * Mindbody omits a removed visit from clientvisits entirely.
 *
 * @param {Record<string, unknown>} row
 * @param {number} classId
 */
export function isActiveEnrolledClassVisit(row, classId) {
  if (!row || typeof row !== "object") return false;
  if (visitClassIdFromRow(row) !== classId) return false;
  if (row.LateCancelled === true || row.lateCancelled === true) return false;
  if (row.Waitlist === true || row.waitlist === true) return false;
  const status = String(row.AppointmentStatus ?? row.appointmentStatus ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
  if (
    status === "cancelled" ||
    status === "canceled" ||
    status === "latecancelled" ||
    status === "latecancel" ||
    status === "waitlist" ||
    status === "waitlisted"
  ) {
    return false;
  }
  const action = String(row.Action ?? row.action ?? "")
    .trim()
    .toLowerCase();
  if (action === "cancelled" || action === "canceled" || action === "late cancel" || action === "latecancelled") {
    return false;
  }
  return visitIdFromRow(row) != null;
}

/**
 * @param {number} clientId
 * @param {number} classId
 * @param {Record<string, string>} headers
 */
export async function readActiveClassEnrollment(clientId, classId, headers) {
  const res = await fetchClientVisitsWindow(clientId, headers);
  if (!res.ok) return { ok: false, visitId: null, visit: null };
  for (const row of res.visits) {
    if (isActiveEnrolledClassVisit(row, classId)) {
      return { ok: true, visitId: visitIdFromRow(row), visit: row };
    }
  }
  return { ok: true, visitId: null, visit: null };
}

/**
 * @param {import("./blobs-conditional-create.mjs").BlobsLikeStore} store
 * @param {number} clientId
 * @param {number} classId
 * @param {{ ttlMs?: number, nowMs?: number }} [opts]
 */
export async function acquireClassBookClaim(store, clientId, classId, opts) {
  const key = classBookClaimKey(clientId, classId);
  const owner = randomUUID();
  const now = opts?.nowMs ?? Date.now();
  const ttl = opts?.ttlMs ?? CLASS_BOOK_CLAIM_TTL_MS;
  /** @type {Record<string, unknown>} */
  const record = {
    state: "in_progress",
    clientId: Math.trunc(clientId),
    classId: Math.trunc(classId),
    owner,
    visitId: null,
    acquiredAtMs: now,
    expiresAtMs: now + ttl,
    released: false,
  };

  const created = await atomicCreateJSON(store, key, record);
  if (created?.modified) return { ok: true, key, owner, record };

  const taken = await atomicUpdateJSON(
    store,
    key,
    (current) => {
      if (!current || typeof current !== "object") return record;
      const cur = /** @type {Record<string, unknown>} */ (current);
      const exp = Number(cur.expiresAtMs);
      const expired = !Number.isFinite(exp) || exp <= Date.now();
      const released = cur.released === true || cur.state === "released";
      if (expired || released) {
        return {
          ...record,
          acquiredAtMs: Date.now(),
          expiresAtMs: Date.now() + ttl,
        };
      }
      return null;
    },
    { readConsistency: "eventual" },
  );

  if (taken.ok && taken.modified && taken.record && typeof taken.record === "object") {
    const ownerNow = /** @type {Record<string, unknown>} */ (taken.record).owner;
    if (ownerNow === owner) return { ok: true, key, owner, record: taken.record };
  }

  if (!taken.ok && taken.reason === "not_found") {
    const again = await atomicCreateJSON(store, key, record);
    if (again?.modified) return { ok: true, key, owner, record };
  }

  const existing =
    taken.ok && taken.record && typeof taken.record === "object" ? taken.record : null;
  return { ok: false, reason: "conflict", record: existing };
}

/**
 * Verified booking. Same owner, CAS. A later release cannot downgrade this
 * back to an unprotected record.
 *
 * @param {import("./blobs-conditional-create.mjs").BlobsLikeStore} store
 * @param {{ key: string, owner: string }} lease
 * @param {number} visitId
 * @param {{ ttlMs?: number, nowMs?: number }} [opts]
 */
export async function completeClassBookClaim(store, lease, visitId, opts) {
  if (!store || !lease?.key || !lease?.owner) return { ok: false, modified: false };
  const vid = Number(visitId);
  if (!Number.isFinite(vid) || vid <= 0) return { ok: false, modified: false, reason: "missing_visit" };
  const now = opts?.nowMs ?? Date.now();
  const ttl = opts?.ttlMs ?? CLASS_BOOK_COMPLETED_TTL_MS;
  return atomicUpdateJSON(
    store,
    lease.key,
    (current) => {
      if (!current || typeof current !== "object") return null;
      const cur = /** @type {Record<string, unknown>} */ (current);
      if (cur.owner !== lease.owner) return null;
      if (cur.released === true || cur.state === "released") return null;
      return {
        ...cur,
        state: "completed",
        released: false,
        visitId: vid,
        completedAtMs: now,
        expiresAtMs: now + ttl,
      };
    },
    { readConsistency: "eventual" },
  );
}

/**
 * @param {unknown} record
 * @param {number} [nowMs]
 * @returns {number | null}
 */
export function completedVisitIdFromRecord(record, nowMs = Date.now()) {
  if (!record || typeof record !== "object") return null;
  const cur = /** @type {Record<string, unknown>} */ (record);
  if (cur.state !== "completed" || cur.released === true) return null;
  const exp = Number(cur.expiresAtMs);
  if (!Number.isFinite(exp) || exp <= nowMs) return null;
  const vid = Number(cur.visitId);
  if (!Number.isFinite(vid) || vid <= 0) return null;
  return vid;
}

/**
 * @param {import("./blobs-conditional-create.mjs").BlobsLikeStore} store
 * @param {{ key: string, owner: string }} lease
 */
export async function releaseClassBookClaim(store, lease) {
  if (!store || !lease?.key || !lease?.owner) return;
  await atomicUpdateJSON(
    store,
    lease.key,
    (current) => {
      if (!current || typeof current !== "object") return null;
      const cur = /** @type {Record<string, unknown>} */ (current);
      if (cur.owner !== lease.owner) return null;
      if (cur.state === "completed") return null;
      return { ...cur, state: "released", released: true, expiresAtMs: 0 };
    },
    { readConsistency: "eventual" },
  );
}

/**
 * After a successful member cancel, drop only a completed claim for this
 * clientId + classId so a legitimate rebook is not blocked. An in-progress
 * claim owned by a live booking is left alone. A different visitId is left
 * alone. Guest-only and unpaid-rollback paths must not call this.
 *
 * @param {import("./blobs-conditional-create.mjs").BlobsLikeStore | null} store
 * @param {number} clientId
 * @param {number} classId
 * @param {{ visitId?: number | null }} [opts]
 */
export async function releaseCompletedClassBookClaim(store, clientId, classId, opts) {
  if (!store) return { ok: false, reason: "no_store" };
  const key = classBookClaimKey(clientId, classId);
  const visitId = opts?.visitId != null ? Number(opts.visitId) : null;
  const result = await atomicUpdateJSON(
    store,
    key,
    (current) => {
      if (!current || typeof current !== "object") return null;
      const cur = /** @type {Record<string, unknown>} */ (current);
      if (cur.state !== "completed" || cur.released === true) return null;
      const exp = Number(cur.expiresAtMs);
      if (!Number.isFinite(exp) || exp <= Date.now()) return null;
      if (visitId != null && Number.isFinite(visitId) && Number(cur.visitId) !== visitId) return null;
      return { ...cur, state: "released", released: true, expiresAtMs: 0 };
    },
    { readConsistency: "eventual" },
  );
  const outcome = result.ok && result.modified
    ? "released_after_cancel"
    : result.ok
      ? "skipped_not_completed"
      : result.reason === "not_found"
        ? "not_found"
        : "skipped_not_completed";
  console.log(
    JSON.stringify({
      event: "class_book_completed_claim_released",
      classId,
      clientId,
      existingVisitId: visitId,
      claimOutcome: outcome,
    }),
  );
  return result;
}

/**
 * Non-2xx / thrown transport where Mindbody may already have committed a Visit.
 * A normal Mindbody 4xx business rejection is not ambiguous.
 *
 * @param {{ ok?: boolean, status?: number, data?: unknown } | null | undefined} result
 */
export function isAmbiguousClassBookTransportFailure(result) {
  if (!result || result.ok) return false;
  const data = result.data && typeof result.data === "object" ? /** @type {Record<string, unknown>} */ (result.data) : {};
  if (data._mbFetchTimeout === true || data._mbTransportError === true) return true;
  const status = Number(result.status) || 0;
  if (status === 0 || status === 408 || status === 502 || status === 503 || status === 504) return true;
  return status >= 500;
}

/**
 * @param {{
 *   store: import("./blobs-conditional-create.mjs").BlobsLikeStore | null,
 *   clientId: number,
 *   classId: number,
 *   authSource?: string | null,
 *   readVisits: () => Promise<{ ok: boolean, visitId: number | null }>,
 * }} opts
 */
export async function guardNormalSeatBeforeMutation(opts) {
  const first = await opts.readVisits();
  if (!first.ok) {
    console.warn(
      JSON.stringify({
        event: "class_book_duplicate_preflight",
        classId: opts.classId,
        clientId: opts.clientId,
        existingVisitId: null,
        claimOutcome: "visit_lookup_failed",
        authSource: opts.authSource ?? null,
      }),
    );
    return { action: /** @type {const} */ ("unavailable"), reason: "visit_lookup_failed", claim: null, visitId: null };
  }
  if (first.visitId) {
    console.log(
      JSON.stringify({
        event: "class_book_duplicate_preflight",
        classId: opts.classId,
        clientId: opts.clientId,
        existingVisitId: first.visitId,
        claimOutcome: "skipped_existing_visit",
        authSource: opts.authSource ?? null,
      }),
    );
    return {
      action: /** @type {const} */ ("already_booked"),
      reason: "existing_visit",
      claim: null,
      visitId: first.visitId,
    };
  }
  if (!opts.store) {
    console.warn(
      JSON.stringify({
        event: "class_book_claim_conflict",
        classId: opts.classId,
        clientId: opts.clientId,
        existingVisitId: null,
        claimOutcome: "store_unavailable",
        authSource: opts.authSource ?? null,
      }),
    );
    return { action: /** @type {const} */ ("unavailable"), reason: "claim_store_unavailable", claim: null, visitId: null };
  }

  const claim = await acquireClassBookClaim(opts.store, opts.clientId, opts.classId);
  if (!claim.ok) {
    let existing = claim.record;
    if (!existing && typeof opts.store.get === "function") {
      const raw = await opts.store.get(classBookClaimKey(opts.clientId, opts.classId), { type: "json" });
      if (raw && typeof raw === "object") existing = /** @type {Record<string, unknown>} */ (raw);
    }
    const completedVisitId = completedVisitIdFromRecord(existing);
    if (completedVisitId) {
      console.log(
        JSON.stringify({
          event: "class_book_duplicate_preflight",
          classId: opts.classId,
          clientId: opts.clientId,
          existingVisitId: completedVisitId,
          claimOutcome: "completed_claim",
          authSource: opts.authSource ?? null,
        }),
      );
      return {
        action: /** @type {const} */ ("already_booked"),
        reason: "completed_claim",
        claim: null,
        visitId: completedVisitId,
      };
    }
    const second = await opts.readVisits();
    if (second.ok && second.visitId) {
      console.log(
        JSON.stringify({
          event: "class_book_duplicate_preflight",
          classId: opts.classId,
          clientId: opts.clientId,
          existingVisitId: second.visitId,
          claimOutcome: "conflict_then_existing_visit",
          authSource: opts.authSource ?? null,
        }),
      );
      return {
        action: /** @type {const} */ ("already_booked"),
        reason: "existing_visit",
        claim: null,
        visitId: second.visitId,
      };
    }
    console.log(
      JSON.stringify({
        event: "class_book_claim_conflict",
        classId: opts.classId,
        clientId: opts.clientId,
        existingVisitId: null,
        claimOutcome: "conflict",
        authSource: opts.authSource ?? null,
      }),
    );
    return { action: /** @type {const} */ ("in_progress"), reason: "claim_conflict", claim: null, visitId: null };
  }

  const third = await opts.readVisits();
  if (!third.ok) {
    await releaseClassBookClaim(opts.store, claim);
    return { action: /** @type {const} */ ("unavailable"), reason: "visit_lookup_failed", claim: null, visitId: null };
  }
  if (third.visitId) {
    await releaseClassBookClaim(opts.store, claim);
    console.log(
      JSON.stringify({
        event: "class_book_duplicate_preflight",
        classId: opts.classId,
        clientId: opts.clientId,
        existingVisitId: third.visitId,
        claimOutcome: "acquired_then_existing_visit",
        authSource: opts.authSource ?? null,
      }),
    );
    return {
      action: /** @type {const} */ ("already_booked"),
      reason: "existing_visit",
      claim: null,
      visitId: third.visitId,
    };
  }

  console.log(
    JSON.stringify({
      event: "class_book_claim_acquired",
      classId: opts.classId,
      clientId: opts.clientId,
      existingVisitId: null,
      claimOutcome: "acquired",
      authSource: opts.authSource ?? null,
    }),
  );
  return { action: /** @type {const} */ ("proceed"), reason: null, claim, visitId: null };
}
