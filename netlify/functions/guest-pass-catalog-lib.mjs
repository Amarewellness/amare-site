import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CATALOG_FILENAME = "stripe-mindbody-catalog.config.json";

function resolveCatalogPath() {
  /** @type {string[]} */
  const candidates = [];
  if (typeof __dirname === "string" && __dirname) {
    candidates.push(path.join(__dirname, "_embedded", CATALOG_FILENAME));
  }
  if (typeof import.meta?.url === "string" && import.meta.url) {
    candidates.push(path.join(path.dirname(fileURLToPath(import.meta.url)), "_embedded", CATALOG_FILENAME));
  }
  candidates.push(path.join(process.cwd(), "netlify", "functions", "_embedded", CATALOG_FILENAME));
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0] || path.join(process.cwd(), "netlify", "functions", "_embedded", CATALOG_FILENAME);
}

const CATALOG_PATH = resolveCatalogPath();

/** @typedef {{
 *   mindbodyServiceId: number;
 *   mindbodyServiceName: string;
 *   unitPriceUsd: number;
 *   eligibleMemberSkus: string[];
 *   eligibleFlexiblePackSkus: string[];
 *   eligibleFlexiblePackMindbodyServiceIds: number[];
 *   allocationPerPeriod: number;
 *   periodModes: { monthlyMembership: string; flexiblePack: string };
 *   studioTimezone: string;
 *   memberMustBeInClass: boolean;
 *   bookingConsentContractVersion: string;
 * }} GuestPassConfig */

/** @type {GuestPassConfig | null} */
let cache = null;

/** @returns {GuestPassConfig} */
export function loadGuestPassConfig() {
  if (cache) return cache;
  const raw = fs.readFileSync(CATALOG_PATH, "utf8");
  const root = /** @type {Record<string, unknown>} */ (JSON.parse(raw));
  const gp = root.guestPass;
  if (!gp || typeof gp !== "object") {
    throw new Error("guest_pass_config_missing");
  }
  const o = /** @type {Record<string, unknown>} */ (gp);
  const serviceId = Number(o.mindbodyServiceId);
  if (!Number.isFinite(serviceId) || serviceId <= 0) {
    throw new Error("guest_pass_invalid_mindbodyServiceId");
  }
  cache = {
    mindbodyServiceId: Math.trunc(serviceId),
    mindbodyServiceName: String(o.mindbodyServiceName || "Guest Pass - 1 Class"),
    unitPriceUsd: Number(o.unitPriceUsd) === 0 ? 0 : Number(o.unitPriceUsd) || 0,
    eligibleMemberSkus: Array.isArray(o.eligibleMemberSkus)
      ? o.eligibleMemberSkus.map((s) => String(s))
      : [],
    eligibleFlexiblePackSkus: Array.isArray(o.eligibleFlexiblePackSkus)
      ? o.eligibleFlexiblePackSkus.map((s) => String(s))
      : [],
    eligibleFlexiblePackMindbodyServiceIds: Array.isArray(o.eligibleFlexiblePackMindbodyServiceIds)
      ? o.eligibleFlexiblePackMindbodyServiceIds.map((n) => Math.trunc(Number(n))).filter((n) => n > 0)
      : [],
    allocationPerPeriod: Number(o.allocationPerPeriod) || 1,
    periodModes: {
      monthlyMembership: String(o.periodModes?.monthlyMembership || "calendarMonth"),
      flexiblePack: String(o.periodModes?.flexiblePack || "packLifetime"),
    },
    studioTimezone: String(o.studioTimezone || "America/New_York"),
    memberMustBeInClass: o.memberMustBeInClass !== false,
    bookingConsentContractVersion: String(o.bookingConsentContractVersion || "guestPass-bookingConsent-v1-2026-05"),
  };
  return cache;
}

/** @returns {Map<number, string>} Mindbody ProductId → monthly localSku */
export function monthlyMindbodyProductIdToSkuMap() {
  const gp = loadGuestPassConfig();
  const raw = fs.readFileSync(CATALOG_PATH, "utf8");
  const root = /** @type {Record<string, unknown>} */ (JSON.parse(raw));
  const items = Array.isArray(root.items) ? root.items : [];
  /** @type {Map<number, string>} */
  const map = new Map();
  for (const rawRow of items) {
    if (!rawRow || typeof rawRow !== "object") continue;
    const r = /** @type {Record<string, unknown>} */ (rawRow);
    const localSku = String(r.localSku || "");
    if (!gp.eligibleMemberSkus.includes(localSku)) continue;
    if (r.kind !== "monthlyMembership") continue;
    for (const key of ["mindbodyServiceId", "mindbodyDisplayServiceId"]) {
      const n = Number(r[key]);
      if (Number.isFinite(n) && n > 0) map.set(Math.trunc(n), localSku);
    }
  }
  return map;
}
