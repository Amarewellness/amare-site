import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** @typedef {{ byMindbodyProductId?: Record<string, Record<string, unknown>>, byCheckoutServiceId?: Record<string, unknown>, aliasesByNormalizedName?: Record<string, string> }} MbTermsCfg */

let _cache;

/**
 * Resolve this module's directory in a way that survives Netlify's esbuild
 * bundler. See the long comment in `stripe-catalog-lib.mjs` for the full
 * rationale — short version: `import.meta.url` is `undefined` in Netlify's
 * bundled CJS output, while `__dirname` is auto-injected; pure ESM is the
 * opposite. Prefer the production-safe one first.
 */
function resolveModuleDir() {
  if (typeof __dirname === "string" && __dirname) return __dirname;
  if (typeof import.meta?.url === "string" && import.meta.url) {
    return dirname(fileURLToPath(import.meta.url));
  }
  return join(process.cwd(), "netlify", "functions");
}

/**
 * Canonical membership terms JSON for server-side verification + audit snapshots (mirrors repo `src/content/mb-contract-terms.config.json`).
 * Uses `build.mjs`-copied `_embedded`; falls back for local dev paths.
 */
export function loadMbContractTermsConfig() {
  if (_cache) return /** @type {MbTermsCfg} */ (_cache);
  const here = resolveModuleDir();
  const candidates = [
    join(here, "_embedded/mb-contract-terms.config.json"),
    join(here, "../../src/content/mb-contract-terms.config.json"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      _cache = JSON.parse(readFileSync(p, "utf8"));
      return /** @type {MbTermsCfg} */ (_cache);
    }
  }
  _cache = {};
  return /** @type {MbTermsCfg} */ (_cache);
}

/**
 * Resolve manual contract entry for checkout `serviceId` (Mindbody Checkout service Id).
 * @param {MbTermsCfg} cfg
 * @param {number} serviceId
 * @returns {{ productKey: string; manual: Record<string, unknown> } | null}
 */
export function resolveManualContractEntryByServiceId(cfg, serviceId) {
  const byP = cfg.byMindbodyProductId;
  const byS = cfg.byCheckoutServiceId;
  if (!byS || typeof byS !== "object") return null;
  const ref = /** @type {Record<string, unknown>} */ (byS)[String(serviceId)];
  if (typeof ref !== "string" || !byP?.[ref]) return null;
  return { productKey: ref, manual: /** @type {Record<string, unknown>} */ (byP[ref]) };
}
