/**
 * Netlify Blob store for internal follow-up actions (contacted / snoozed / hidden).
 * Keys: v1/{category}/{mindbodyClientId}/{actionKey}
 */

import { connectLambda, getStore } from "@netlify/blobs";

/** @typedef {"contacted"|"snoozed"|"hidden"} FollowUpActionType */

/**
 * @typedef {Object} FollowUpActionRecord
 * @property {string} category
 * @property {number} mindbodyClientId
 * @property {FollowUpActionType} action
 * @property {string | null} note
 * @property {string} createdAt
 * @property {string | null} createdBy
 * @property {string | null} expiresAt
 * @property {string} actionKey
 */

/** @type {Map<string, string> | null} */
let memorySingleton = null;

function useLocalMemory() {
  if ((process.env.NETLIFY || "").trim()) return false;
  return (process.env.FOLLOWUP_ACTIONS_STORE_LOCAL_MEMORY || "").trim() === "1";
}

/** @param {unknown} event */
function connectBlob(event) {
  if (event && typeof event === "object") {
    connectLambda(/** @type {import("@netlify/functions").HandlerEvent} */ (event));
  }
}

/** @param {unknown} event */
export function openFollowUpActionsStore(event) {
  if (useLocalMemory()) {
    if (!memorySingleton) memorySingleton = new Map();
    const backing = memorySingleton;
    return {
      mode: "local_memory",
      available: true,
      async listByCategory(category) {
        const prefix = `v1/${category}/`;
        /** @type {FollowUpActionRecord[]} */
        const out = [];
        for (const [key, raw] of backing.entries()) {
          if (!key.startsWith(prefix)) continue;
          try {
            out.push(JSON.parse(raw));
          } catch {
            /* skip */
          }
        }
        return out;
      },
      async put(record) {
        const key = `v1/${record.category}/${record.mindbodyClientId}/${record.actionKey}`;
        backing.set(key, JSON.stringify(record));
      },
    };
  }

  try {
    connectBlob(event);
    const store = getStore("follow-up-actions");
    return {
      mode: "netlify_blobs",
      available: true,
      async listByCategory(category) {
        const prefix = `v1/${category}/`;
        /** @type {FollowUpActionRecord[]} */
        const out = [];
        for await (const entry of store.list({ prefix })) {
          const raw = await store.get(entry.key, { type: "text" });
          if (!raw) continue;
          try {
            out.push(JSON.parse(String(raw)));
          } catch {
            /* skip */
          }
        }
        return out;
      },
      async put(record) {
        const key = `v1/${record.category}/${record.mindbodyClientId}/${record.actionKey}`;
        await store.set(key, JSON.stringify(record));
      },
    };
  } catch (err) {
    console.log(
      JSON.stringify({
        event: "follow_up_actions_store_unavailable",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return { mode: "unavailable", available: false, listByCategory: async () => [], put: async () => {} };
  }
}

/** @param {number} clientId @param {string} [suffix] */
export function followUpActionKey(clientId, suffix) {
  const day = new Date().toISOString().slice(0, 10);
  return suffix ? `${day}-${suffix}` : day;
}

/** @param {FollowUpActionRecord} record */
export function isFollowUpActionActive(record) {
  if (!record) return false;
  if (record.action === "hidden") return true;
  if (record.action === "contacted") return true;
  if (record.action === "snoozed" && record.expiresAt) {
    return new Date(record.expiresAt).getTime() > Date.now();
  }
  return false;
}
