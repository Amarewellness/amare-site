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
import { connectLambda, getStore, setEnvironmentContext } from "@netlify/blobs";
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
/**
 * `@netlify/blobs` 10.7.9 `connectLambda` stores `data.url` and drops
 * `uncachedEdgeURL`. Strong reads then throw, so every claim read falls
 * through to the edge cache (`stale-while-revalidate=60` on PUT). A cancel
 * about 19s after completion can observe a stale `in_progress` snapshot,
 * treat it as a final no-op, and leave the real `completed` record in place.
 * Copy the uncached URL through when the platform sends it.
 *
 * @param {{ blobs?: string, headers?: Record<string, string | undefined> } | null | undefined} event
 */
function enableStrongBlobReads(event) {
  if (!event || typeof event.blobs !== "string") return;
  connectLambda(/** @type {{ blobs: string, headers: Record<string, string> }} */ (event));
  let data = null;
  try {
    data = JSON.parse(Buffer.from(event.blobs, "base64").toString("utf8"));
  } catch {
    return;
  }
  if (!data || typeof data !== "object") return;
  const row = /** @type {Record<string, unknown>} */ (data);
  const uncached = [row.uncachedEdgeURL, row.uncached_url, row.uncachedURL].find(
    (value) => typeof value === "string" && value.trim(),
  );
  if (typeof uncached !== "string" || typeof row.url !== "string" || typeof row.token !== "string") return;
  const headers = event.headers || {};
  setEnvironmentContext({
    deployID: headers["x-nf-deploy-id"] || headers["X-Nf-Deploy-Id"],
    edgeURL: row.url,
    siteID: headers["x-nf-site-id"] || headers["X-Nf-Site-Id"],
    token: row.token,
    uncachedEdgeURL: uncached.trim(),
  });
}

export function openClassBookClaimStore(event) {
  if (testStore) return testStore;
  try {
    enableStrongBlobReads(event);
    return /** @type {import("./blobs-conditional-create.mjs").BlobsLikeStore} */ (
      getStore({ name: STORE_NAME, consistency: "eventual" })
    );
  } catch {
    return null;
  }
}

function isStrongReadUnavailable(err) {
  const name = err && typeof err === "object" && "name" in err ? String(/** @type {{ name?: unknown }} */ (err).name) : "";
  const message = err instanceof Error ? err.message : "";
  return name === "BlobsConsistencyError" || message.includes("uncachedEdgeURL");
}

/**
 * Prefer a strong read so a just-released claim is not still served as
 * `completed` from the edge cache. Fall back when this runtime has no
 * uncached blob URL. Decision rules stay the same.
 *
 * @param {import("./blobs-conditional-create.mjs").BlobsLikeStore} store
 * @param {string} key
 * @param {(current: Record<string, unknown> | null) => Record<string, unknown> | null | Promise<Record<string, unknown> | null>} mutator
 */
async function atomicUpdateClaim(store, key, mutator) {
  try {
    return await atomicUpdateJSON(store, key, mutator, { readConsistency: "strong" });
  } catch (err) {
    if (!isStrongReadUnavailable(err)) throw err;
    return await atomicUpdateJSON(store, key, mutator, { readConsistency: "eventual" });
  }
}

/**
 * @param {import("./blobs-conditional-create.mjs").BlobsLikeStore} store
 * @param {string} key
 */
async function readClaimRecord(store, key) {
  if (typeof store.getWithMetadata === "function") {
    try {
      const head = await store.getWithMetadata(key, { type: "json", consistency: "strong" });
      if (head && head.data && typeof head.data === "object") return /** @type {Record<string, unknown>} */ (head.data);
      if (head) return null;
    } catch (err) {
      if (!isStrongReadUnavailable(err)) throw err;
    }
  }
  if (typeof store.get !== "function") return null;
  try {
    const raw = await store.get(key, { type: "json", consistency: "strong" });
    return raw && typeof raw === "object" ? /** @type {Record<string, unknown>} */ (raw) : null;
  } catch (err) {
    if (!isStrongReadUnavailable(err)) throw err;
  }
  const raw = await store.get(key, { type: "json" });
  return raw && typeof raw === "object" ? /** @type {Record<string, unknown>} */ (raw) : null;
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

  const taken = await atomicUpdateClaim(
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
 * Cancellation clear. Identity is the key plus completed state plus the
 * cancelled visitId plus If-Match. The original booking owner is not required:
 * cancel is a later invocation and does not have that owner.
 * An in_progress claim, including one acquired for a newer rebook, is left
 * alone. A CAS miss is re-read by atomicUpdateClaim; it is never a blind set.
 *
 * @param {import("./blobs-conditional-create.mjs").BlobsLikeStore | null} store
 * @param {number} clientId
 * @param {number} classId
 * @param {number | null | undefined} visitId
 */
export async function clearCompletedClassBookClaimForCancelledVisit(store, clientId, classId, visitId) {
  if (!store) {
    console.warn(
      JSON.stringify({
        event: "class_book_completed_claim_clear_failed",
        classId,
        clientId,
        visitId: visitId ?? null,
        reason: "no_store",
      }),
    );
    return { ok: false, modified: false, reason: "no_store" };
  }
  const vid = Number(visitId);
  if (!Number.isFinite(vid) || vid <= 0) {
    return { ok: false, modified: false, reason: "missing_visit" };
  }
  const key = classBookClaimKey(clientId, classId);
  /** @type {Record<string, unknown> | null} */
  let observed = null;
  let result;
  try {
    result = await atomicUpdateClaim(store, key, (current) => {
      if (!current || typeof current !== "object") return null;
      observed = current;
      if (current.state !== "completed" || current.released === true) return null;
      if (Number(current.visitId) !== vid) return null;
      return { ...current, state: "released", released: true, expiresAtMs: 0 };
    });
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "class_book_completed_claim_clear_failed",
        classId,
        clientId,
        visitId: vid,
        reason: "clear_failed",
      }),
    );
    return {
      ok: false,
      modified: false,
      reason: "clear_failed",
      message: err instanceof Error ? err.name : "clear_failed",
    };
  }

  const latest =
    result.record && typeof result.record === "object"
      ? /** @type {Record<string, unknown>} */ (result.record)
      : observed;
  let reason = "not_cleared";
  if (result.ok && result.modified) reason = "released";
  else if (!result.ok && result.reason === "not_found") reason = "not_found";
  else if (!result.ok && result.reason === "max_retries_exhausted") reason = "cas_conflict";
  else if (latest?.state === "in_progress") reason = "state_mismatch";
  else if (latest?.state === "completed" && Number(latest.visitId) !== vid) reason = "visit_mismatch";
  else if (latest?.state === "released" || latest?.released === true) reason = "already_released";
  else if (latest?.state === "completed" && Number(latest.visitId) === vid) reason = "cas_conflict";

  const prior = reason === "released" ? observed : latest;
  if (reason === "cas_conflict" || reason === "clear_failed") {
    console.warn(
      JSON.stringify({
        event: "class_book_completed_claim_clear_failed",
        classId,
        clientId,
        visitId: vid,
        reason,
      }),
    );
  } else {
    console.log(
      JSON.stringify({
        event: "class_book_completed_claim_released",
        classId,
        clientId,
        existingVisitId: vid,
        priorState: typeof prior?.state === "string" ? prior.state : null,
        priorVisitId: prior?.visitId ?? null,
        priorExpiresAtMs: prior?.expiresAtMs ?? null,
        hasOwner: typeof prior?.owner === "string" && prior.owner.length > 0,
        claimOutcome: reason === "released" ? "released_after_cancel" : reason,
      }),
    );
  }
  return { ...result, reason, modified: result.modified === true };
}

/**
 * @param {import("./blobs-conditional-create.mjs").BlobsLikeStore | null} store
 * @param {number} clientId
 * @param {number} classId
 * @param {{ visitId?: number | null }} [opts]
 */
export async function releaseCompletedClassBookClaim(store, clientId, classId, opts) {
  return clearCompletedClassBookClaimForCancelledVisit(store, clientId, classId, opts?.visitId);
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
    if (!existing) {
      existing = await readClaimRecord(opts.store, classBookClaimKey(opts.clientId, opts.classId));
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
