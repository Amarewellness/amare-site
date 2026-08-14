/**
 * Netlify Blob store for front desk staff roster.
 * Keys: v1/config, v1/staff/{id}, v1/staff/index, v1/weeks/{weekStart}
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectLambda, getStore } from "@netlify/blobs";
import {
  buildEmptyWeek,
  defaultConfig,
  ensureWeekSlots,
  normalizeCommissionDoc,
  isValidYmd,
  isWeekStartYmd,
} from "./staff-schedule-lib.mjs";

/** @type {Map<string, string> | null} */
let memorySingleton = null;

const LOCAL_STORE_REL = path.join("data", "staff-schedule", "local-store.json");

/** Resolve local dev store path without throwing when `import.meta.url` is missing (Netlify bundle). */
function resolveLocalStoreFile() {
  if (typeof __dirname === "string" && __dirname) {
    return path.join(__dirname, "..", "..", LOCAL_STORE_REL);
  }
  if (typeof import.meta?.url === "string" && import.meta.url) {
    return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", LOCAL_STORE_REL);
  }
  return path.join(process.cwd(), LOCAL_STORE_REL);
}

/** @returns {Map<string, string>} */
function loadLocalStoreFromDisk() {
  /** @type {Map<string, string>} */
  const backing = new Map();
  const localStoreFile = resolveLocalStoreFile();
  try {
    const raw = fs.readFileSync(localStoreFile, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return backing;
    for (const [key, value] of Object.entries(parsed)) {
      backing.set(key, JSON.stringify(value));
    }
  } catch {
    /* missing or invalid file — start empty */
  }
  return backing;
}

/** @param {Map<string, string>} backing */
function persistLocalStoreToDisk(backing) {
  const localStoreFile = resolveLocalStoreFile();
  try {
    fs.mkdirSync(path.dirname(localStoreFile), { recursive: true });
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [key, raw] of backing.entries()) {
      try {
        out[key] = JSON.parse(raw);
      } catch {
        out[key] = raw;
      }
    }
    fs.writeFileSync(localStoreFile, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  } catch (err) {
    console.log(
      JSON.stringify({
        event: "staff_schedule_local_store_persist_failed",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

function useLocalMemory() {
  if ((process.env.NETLIFY || "").trim()) return false;
  return (process.env.STAFF_SCHEDULE_STORE_LOCAL_MEMORY || "").trim() === "1";
}

/** @param {unknown} event */
function connectBlob(event) {
  if (event && typeof event === "object") {
    connectLambda(/** @type {import("@netlify/functions").HandlerEvent} */ (event));
  }
}

/**
 * @param {Map<string, string>} backing
 * @param {string} key
 */
async function memGet(backing, key) {
  const raw = backing.get(key);
  return raw ? JSON.parse(raw) : null;
}

/**
 * @param {Map<string, string>} backing
 * @param {string} key
 * @param {unknown} value
 */
async function memSet(backing, key, value) {
  backing.set(key, JSON.stringify(value));
  persistLocalStoreToDisk(backing);
}

/** @param {Map<string, string>} backing @param {string} key */
async function memDelete(backing, key) {
  backing.delete(key);
  persistLocalStoreToDisk(backing);
}

/** @param {unknown} event */
export function openStaffScheduleStore(event) {
  if (useLocalMemory()) {
    if (!memorySingleton) memorySingleton = loadLocalStoreFromDisk();
    const backing = memorySingleton;
    return createStoreApi(backing, memGet, memSet, memDelete, "local_file");
  }

  try {
    connectBlob(event);
    const store = getStore("staff-schedule");
    return createStoreApi(
      store,
      async (s, key) => {
        const raw = await s.get(key, { type: "text" });
        if (!raw) return null;
        try {
          return JSON.parse(String(raw));
        } catch {
          return null;
        }
      },
      async (s, key, value) => {
        await s.set(key, JSON.stringify(value));
      },
      async (s, key) => {
        await s.delete(key);
      },
      "netlify_blobs",
    );
  } catch (err) {
    console.log(
      JSON.stringify({
        event: "staff_schedule_store_unavailable",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return {
      mode: "unavailable",
      available: false,
      getConfig: async () => defaultConfig(),
      putConfig: async () => {},
      listStaff: async () => [],
      getStaff: async () => null,
      putStaff: async () => {},
      getWeek: async () => null,
      putWeek: async () => {},
      getAvailability: async () => null,
      putAvailability: async () => {},
      getOrCreateWeek: async () => null,
      deleteStaff: async () => {},
    };
  }
}

/**
 * @template T
 * @param {Map<string, string> | import("@netlify/blobs").Store} storage
 * @param {(s: typeof storage, key: string) => Promise<T|null>} getFn
 * @param {(s: typeof storage, key: string, value: unknown) => Promise<void>} setFn
 * @param {(s: typeof storage, key: string) => Promise<void>} deleteFn
 * @param {string} mode
 */
function createStoreApi(storage, getFn, setFn, deleteFn, mode) {
  const configKey = "v1/config";
  const indexKey = "v1/staff/index";

  return {
    mode,
    available: true,

    async getConfig() {
      const existing = await getFn(storage, configKey);
      const defaults = defaultConfig();
      if (existing && typeof existing === "object") {
        const merged = {
          ...defaults,
          ...existing,
          weekStartsOn: defaults.weekStartsOn,
          shiftTemplates: {
            ...defaults.shiftTemplates,
            ...(existing.shiftTemplates || {}),
          },
          availabilityOpenWeekStart:
            typeof existing.availabilityOpenWeekStart === "string"
              ? existing.availabilityOpenWeekStart
              : null,
          staffAvailabilityEarlyMorning: existing.staffAvailabilityEarlyMorning === true,
        };
        if (existing.weekStartsOn !== defaults.weekStartsOn) {
          await setFn(storage, configKey, merged);
        }
        return merged;
      }
      await setFn(storage, configKey, defaults);
      return defaults;
    },

    async putConfig(config) {
      await setFn(storage, configKey, config);
    },

    async listStaff() {
      const index = await getFn(storage, indexKey);
      const ids = Array.isArray(index?.ids) ? index.ids : [];
      /** @type {import("./staff-schedule-lib.mjs").StaffMember[]} */
      const out = [];
      for (const id of ids) {
        const row = await getFn(storage, `v1/staff/${id}`);
        if (row && typeof row === "object") out.push(row);
      }
      out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      return out;
    },

    async getStaff(staffId) {
      return getFn(storage, `v1/staff/${staffId}`);
    },

    /** @param {import("./staff-schedule-lib.mjs").StaffMember} staff */
    async putStaff(staff) {
      await setFn(storage, `v1/staff/${staff.id}`, staff);
      const index = (await getFn(storage, indexKey)) || { ids: [] };
      const ids = new Set(Array.isArray(index.ids) ? index.ids : []);
      ids.add(staff.id);
      await setFn(storage, indexKey, { ids: [...ids] });
    },

    /** @param {string} weekStart */
    async getWeek(weekStart) {
      if (!isValidYmd(weekStart)) return null;
      const config = await this.getConfig();
      if (!isWeekStartYmd(weekStart, config.weekStartsOn || "sunday")) return null;
      return getFn(storage, `v1/weeks/${weekStart}`);
    },

    /** @param {import("./staff-schedule-lib.mjs").WeekDocument} week */
    async putWeek(week) {
      await setFn(storage, `v1/weeks/${week.weekStart}`, week);
    },

    /** @param {string} weekStart */
    async getOrCreateWeek(weekStart) {
      const existing = await getFn(storage, `v1/weeks/${weekStart}`);
      if (!existing) {
        const week = buildEmptyWeek(weekStart);
        await setFn(storage, `v1/weeks/${weekStart}`, week);
        return week;
      }
      const before = Array.isArray(existing.shifts) ? existing.shifts.length : 0;
      ensureWeekSlots(existing);
      if (existing.shifts.length !== before) {
        await setFn(storage, `v1/weeks/${weekStart}`, existing);
      }
      return existing;
    },

    /** @param {string} weekStart */
    async getAvailability(weekStart) {
      if (!isValidYmd(weekStart)) return null;
      const config = await this.getConfig();
      if (!isWeekStartYmd(weekStart, config.weekStartsOn || "sunday")) return null;
      return getFn(storage, `v1/availability/${weekStart}`);
    },

    /** @param {import("./staff-schedule-lib.mjs").AvailabilityDocument} doc */
    async putAvailability(doc) {
      await setFn(storage, `v1/availability/${doc.weekStart}`, doc);
    },

    async getCommissions() {
      const raw = await getFn(storage, "v1/commissions");
      return normalizeCommissionDoc(raw);
    },

    /** @param {import("./staff-schedule-lib.mjs").CommissionDocument} doc */
    async putCommissions(doc) {
      await setFn(storage, "v1/commissions", {
        ...doc,
        updatedAt: new Date().toISOString(),
      });
    },

    /** @param {string} staffId */
    async deleteStaff(staffId) {
      const index = (await getFn(storage, indexKey)) || { ids: [] };
      const ids = (Array.isArray(index.ids) ? index.ids : []).filter((id) => id !== staffId);
      await deleteFn(storage, `v1/staff/${staffId}`);
      await setFn(storage, indexKey, { ids });
    },
  };
}
