import { connectLambda, getStore } from "@netlify/blobs";

const STORE_NAME = "guest-pass-records";
const BLOBS_STRONG = /** @type {const} */ ("strong");
const BLOBS_EVENTUAL = /** @type {const} */ ("eventual");
/** @type {WeakMap<object, "eventual" | "strong">} */
const READ_CONSISTENCY_BY_STORE = new WeakMap();

/** @param {import("@netlify/blobs").Store} store @param {"eventual" | "strong"} consistency */
function rememberReadConsistency(store, consistency) {
  READ_CONSISTENCY_BY_STORE.set(store, consistency);
  return store;
}

/** @param {import("@netlify/blobs").Store} store */
export function guestPassBlobReadConsistency(store) {
  return READ_CONSISTENCY_BY_STORE.get(store) || BLOBS_STRONG;
}

export function guestPassBlobsEnabled() {
  const v = (process.env.GUEST_PASS_BLOBS ?? "").trim();
  if (!v) return false;
  return v === "1" || /^true$/i.test(v);
}

/** @type {Map<string, unknown> | null} */
let memorySingleton = null;

function shouldUseLocalMemory() {
  if ((process.env.NETLIFY || "").trim()) return false;
  return (process.env.GUEST_PASS_BLOBS_LOCAL_MEMORY || "").trim() === "1";
}

/** @param {Map<string, unknown>} backing */
function makeMemoryStore(backing) {
  return /** @type {import("@netlify/blobs").Store} */ (
    /** @type {unknown} */ ({
      async get(key, opts) {
        const v = backing.get(key);
        if (v == null) return null;
        if (opts?.type === "json") return JSON.parse(JSON.stringify(v));
        return v;
      },
      async getWithMetadata(key, opts) {
        const v = backing.get(key);
        if (v == null) return null;
        const data = opts?.type === "json" ? JSON.parse(JSON.stringify(v)) : v;
        return { data, etag: "mem" };
      },
      async set(key, body, opts) {
        if (opts?.onlyIfNew && backing.has(key)) return { modified: false };
        if (opts?.onlyIfMatch) {
          const cur = backing.get(key);
          if (cur == null) return { modified: false };
        }
        try {
          backing.set(key, JSON.parse(body));
        } catch {
          backing.set(key, body);
        }
        return { modified: true, etag: "mem" };
      },
      async setJSON(key, value, opts) {
        if (opts?.onlyIfNew && backing.has(key)) return { modified: false };
        backing.set(key, JSON.parse(JSON.stringify(value)));
        return { modified: true };
      },
      async delete(key) {
        backing.delete(key);
      },
    })
  );
}

/** @param {{ blobs?: string } | unknown} event */
export function tryOpenGuestPassBlobStore(event) {
  if (!guestPassBlobsEnabled()) return null;
  try {
    if (event && typeof event === "object" && typeof /** @type {{ blobs?: string }} */ (event).blobs === "string") {
      connectLambda(/** @type {{ blobs: string }} */ (event));
    }
    return rememberReadConsistency(
      getStore({ name: STORE_NAME, consistency: BLOBS_EVENTUAL }),
      BLOBS_EVENTUAL,
    );
  } catch (e) {
    if (shouldUseLocalMemory()) {
      if (!memorySingleton) memorySingleton = new Map();
      return rememberReadConsistency(makeMemoryStore(memorySingleton), BLOBS_EVENTUAL);
    }
    console.warn(
      JSON.stringify({
        event: "guest_pass_blobs_unavailable",
        detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 300),
      }),
    );
    return null;
  }
}
