/**
 * Store reviewer access — Google Play + Apple App Review only.
 * Static review codes for allowlisted emails; never exposed to clients.
 * Play: AMARE_PLAY_REVIEW_CODE (preferred) or AMARE_PLAY_REVIEW_CODE_HASH fallback.
 * Apple: AMARE_APPLE_REVIEW_CODE_HASH only.
 */

import crypto from "node:crypto";
import { emailOtpRoutesEnabled, hashOtpCode, normalizeAmareEmail, requireOtpPepper } from "./amare-auth-lib.mjs";

export const STORE_REVIEW_PLATFORM = Object.freeze({
  GOOGLE_PLAY: "google_play",
  APPLE_APP_REVIEW: "apple_app_review",
});

function envEnabled(name) {
  return (process.env[name] || "").trim() === "1";
}

function storeReviewMasterEnabled() {
  return envEnabled("ENABLE_AMARE_STORE_REVIEW_AUTH");
}

function isValidCodeHash(raw) {
  return /^[0-9a-f]{64}$/.test(String(raw || "").trim().toLowerCase());
}

function isValidPlainReviewCode(raw) {
  return /^\d{6}$/.test(String(raw || "").trim());
}

function playPlatformConfig() {
  if (!envEnabled("ENABLE_AMARE_PLAY_REVIEW_AUTH")) return null;
  const email = normalizeAmareEmail(process.env.AMARE_PLAY_REVIEW_EMAIL);
  if (!email) return null;
  const plainCode = String(process.env.AMARE_PLAY_REVIEW_CODE || "").trim();
  const codeHash = String(process.env.AMARE_PLAY_REVIEW_CODE_HASH || "").trim().toLowerCase();
  const hasPlain = isValidPlainReviewCode(plainCode);
  const hasHash = isValidCodeHash(codeHash);
  if (!hasPlain && !hasHash) return null;
  /** @type {{ platform: string, email: string, plainCode?: string, codeHash?: string }} */
  const cfg = {
    platform: STORE_REVIEW_PLATFORM.GOOGLE_PLAY,
    email,
  };
  if (hasPlain) cfg.plainCode = plainCode;
  if (hasHash) cfg.codeHash = codeHash;
  return cfg;
}

function applePlatformConfig() {
  if (!envEnabled("ENABLE_AMARE_APPLE_REVIEW_AUTH")) return null;
  const email = normalizeAmareEmail(process.env.AMARE_APPLE_REVIEW_EMAIL);
  const codeHash = String(process.env.AMARE_APPLE_REVIEW_CODE_HASH || "").trim().toLowerCase();
  if (!email || !isValidCodeHash(codeHash)) return null;
  return {
    platform: STORE_REVIEW_PLATFORM.APPLE_APP_REVIEW,
    email,
    codeHash,
  };
}

/** @returns {Array<{ platform: string, email: string, plainCode?: string, codeHash?: string }>} */
export function listActiveStoreReviewPlatforms() {
  if (!storeReviewMasterEnabled() || !emailOtpRoutesEnabled()) return [];
  return [playPlatformConfig(), applePlatformConfig()].filter(Boolean);
}

/** @returns {{ platform: string, email: string } | null} */
export function resolveStoreReviewPlatform(email) {
  const normalized = normalizeAmareEmail(email);
  if (!normalized) return null;
  for (const cfg of listActiveStoreReviewPlatforms()) {
    if (cfg.email === normalized) {
      return { platform: cfg.platform, email: cfg.email };
    }
  }
  return null;
}

export function isStoreReviewEmail(email) {
  return resolveStoreReviewPlatform(email) !== null;
}

function timingSafeEqualUtf8(a, b) {
  const left = Buffer.from(String(a || ""), "utf8");
  const right = Buffer.from(String(b || ""), "utf8");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function timingSafeEqualHex(a, b) {
  return timingSafeEqualUtf8(a, b);
}

/**
 * @returns {string | null} platform tag on success
 */
export function verifyStoreReviewCode(email, code) {
  const profile = resolveStoreReviewPlatform(email);
  if (!profile) return null;
  const normalizedCode = String(code || "").trim();
  if (!/^\d{6}$/.test(normalizedCode)) return null;

  const cfg = listActiveStoreReviewPlatforms().find((row) => row.email === profile.email);
  if (!cfg) return null;

  if (cfg.plainCode) {
    if (!timingSafeEqualUtf8(normalizedCode, cfg.plainCode)) return null;
    return profile.platform;
  }

  if (cfg.codeHash) {
    const computed = hashOtpCode(profile.email, normalizedCode, requireOtpPepper());
    if (!timingSafeEqualHex(computed, cfg.codeHash)) return null;
    return profile.platform;
  }

  return null;
}

/** @returns {string | null} */
export function emailDomainForAudit(email) {
  const normalized = normalizeAmareEmail(email);
  if (!normalized) return null;
  const parts = normalized.split("@");
  return parts.length === 2 ? parts[1] : null;
}

export function hashAuditIp(ip) {
  const raw = String(ip || "unknown").trim() || "unknown";
  return crypto.createHash("sha256").update(`amare-store-review-ip:${raw}`).digest("hex").slice(0, 16);
}

export function logStoreReviewEvent(event, { platform, email, ip } = {}) {
  /** @type {Record<string, string>} */
  const payload = { event: String(event || "store_review_event").slice(0, 64) };
  if (platform) payload.platform = String(platform).slice(0, 32);
  const domain = emailDomainForAudit(email);
  if (domain) payload.email_domain = domain;
  if (ip != null) payload.ip_hash = hashAuditIp(ip);
  console.log(JSON.stringify(payload));
}

/** Offline operator/QA helper — same hash scheme as OTP challenges. */
export function hashStoreReviewCode(email, code, pepper = requireOtpPepper()) {
  const normalized = normalizeAmareEmail(email);
  if (!normalized) throw new Error("invalid_review_email");
  const normalizedCode = String(code || "").trim();
  if (!/^\d{6}$/.test(normalizedCode)) throw new Error("invalid_review_code");
  return hashOtpCode(normalized, normalizedCode, pepper);
}
