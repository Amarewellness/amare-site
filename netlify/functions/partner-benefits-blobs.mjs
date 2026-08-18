import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectLambda, getStore } from "@netlify/blobs";

const STORE_NAME = "partner-benefits";
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
export function partnerBenefitsBlobReadConsistency(store) {
  return READ_CONSISTENCY_BY_STORE.get(store) || BLOBS_STRONG;
}

/** Resolve repo root without throwing when `import.meta.url` is missing (Netlify bundle). */
function repoRoot() {
  if (typeof import.meta?.url === "string" && import.meta.url) {
    return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  }
  return process.cwd();
}

export function partnerBenefitsBlobsEnabled() {
  const v = (process.env.PARTNER_BENEFITS_BLOBS ?? process.env.GUEST_PASS_BLOBS ?? "").trim();
  if (!v) return false;
  return v === "1" || /^true$/i.test(v);
}

/** @type {Map<string, unknown> | null} */
let memorySingleton = null;

function shouldUseLocalMemory() {
  if ((process.env.NETLIFY || "").trim()) return false;
  const v = (process.env.PARTNER_BENEFITS_BLOBS_LOCAL_MEMORY ?? process.env.GUEST_PASS_BLOBS_LOCAL_MEMORY ?? "").trim();
  return v === "1";
}

function netlifyCliConfigPath() {
  if ((process.env.NETLIFY_CLI_CONFIG || "").trim()) return process.env.NETLIFY_CLI_CONFIG.trim();
  if (process.platform === "win32") {
    return path.join(
      process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
      "netlify",
      "Config",
      "config.json",
    );
  }
  return path.join(os.homedir(), ".config", "netlify", "config.json");
}

function readNetlifyCliAuthToken() {
  try {
    const raw = fs.readFileSync(netlifyCliConfigPath(), "utf8");
    const cfg = JSON.parse(raw);
    for (const user of Object.values(cfg?.users || {})) {
      const token = String(/** @type {{ auth?: { token?: string } }} */ (user)?.auth?.token || "").trim();
      if (token) return token;
    }
  } catch {
    /* not logged in locally */
  }
  return "";
}

function linkedSiteId() {
  const fromEnv = (process.env.NETLIFY_SITE_ID || process.env.SITE_ID || "").trim();
  if (fromEnv) return fromEnv;
  try {
    const statePath = path.join(repoRoot(), ".netlify", "state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return String(state.siteId || "").trim();
  } catch {
    return "";
  }
}

/** Local dev fallback: read production partner-benefits via Netlify API when Lambda context is absent. */
function tryOpenApiPartnerBenefitsStore() {
  if ((process.env.NETLIFY || "").trim()) return null;
  const siteID = linkedSiteId();
  const token = (process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_PAT || readNetlifyCliAuthToken()).trim();
  if (!siteID || !token) return null;
  try {
    return rememberReadConsistency(
      getStore({ name: STORE_NAME, siteID, token, consistency: BLOBS_STRONG }),
      BLOBS_STRONG,
    );
  } catch (e) {
    console.warn(
      JSON.stringify({
        event: "partner_benefits_blobs_api_fallback_failed",
        detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 300),
      }),
    );
    return null;
  }
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
          if (!backing.has(key)) return { modified: false };
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
      list(opts) {
        const prefix = opts?.prefix || "";
        const keys = [...backing.keys()].filter((k) => k.startsWith(prefix));
        return {
          async *[Symbol.asyncIterator]() {
            yield { blobs: keys.map((key) => ({ key })) };
          },
        };
      },
    })
  );
}

/** @param {{ blobs?: string } | unknown} event */
export function tryOpenPartnerBenefitsBlobStore(event) {
  if (!partnerBenefitsBlobsEnabled()) return null;
  try {
    if (event && typeof event === "object" && typeof /** @type {{ blobs?: string }} */ (event).blobs === "string") {
      connectLambda(/** @type {{ blobs: string }} */ (event));
    }
    return rememberReadConsistency(
      getStore({ name: STORE_NAME, consistency: BLOBS_EVENTUAL }),
      BLOBS_EVENTUAL,
    );
  } catch (e) {
    const apiStore = tryOpenApiPartnerBenefitsStore();
    if (apiStore) return apiStore;
    if (shouldUseLocalMemory()) {
      if (!memorySingleton) memorySingleton = new Map();
      return rememberReadConsistency(makeMemoryStore(memorySingleton), BLOBS_EVENTUAL);
    }
    console.warn(
      JSON.stringify({
        event: "partner_benefits_blobs_unavailable",
        detail: String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 300),
      }),
    );
    return null;
  }
}
