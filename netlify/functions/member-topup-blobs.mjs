import { connectLambda, getStore } from "@netlify/blobs";

const STORE_NAME = "member-topup-records";
const BLOBS_EVENTUAL = /** @type {const} */ ("eventual");

export function memberTopUpEnabled() {
  return (process.env.ENABLE_MEMBER_TOPUP || "").trim() === "1";
}

export function memberTopUpBlobsEnabled() {
  const explicit = (process.env.MEMBER_TOPUP_BLOBS ?? "").trim();
  if (explicit) return explicit === "1" || /^true$/i.test(explicit);
  return memberTopUpEnabled();
}

/** @type {Map<string, unknown> | null} */
let memorySingleton = null;

function shouldUseLocalMemory() {
  if ((process.env.NETLIFY || "").trim()) return false;
  return (process.env.MEMBER_TOPUP_BLOBS_LOCAL_MEMORY || "").trim() === "1";
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

export function resetMemberTopUpMemoryForTests() {
  if (memorySingleton) memorySingleton.clear();
}

/** @param {{ blobs?: string } | unknown} event */
export function tryOpenMemberTopUpBlobStore(event) {
  if (!memberTopUpBlobsEnabled()) return null;
  if (shouldUseLocalMemory()) {
    if (!memorySingleton) memorySingleton = new Map();
    return makeMemoryStore(memorySingleton);
  }
  try {
    if (event && typeof event === "object" && typeof /** @type {{ blobs?: string }} */ (event).blobs === "string") {
      connectLambda(/** @type {{ blobs: string }} */ (event));
    }
    return getStore({ name: STORE_NAME, consistency: BLOBS_EVENTUAL });
  } catch (e) {
    console.warn(
      JSON.stringify({
        event: "member_topup_blobs_unavailable",
        detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 300),
      }),
    );
    return null;
  }
}
