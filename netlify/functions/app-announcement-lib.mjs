/**
 * AMARÉ in-app announcement MVP — shared validation and mapping.
 */

import { STUDIO_TIMEZONE, mindbodyWallTimeToUtcMs } from "./mindbody-studio-time.mjs";

export const STUDIO_TZ = STUDIO_TIMEZONE;
export const TITLE_MAX = 120;
export const MESSAGE_MAX = 2000;

const CTA_URL_HOSTS = new Set([
  "play.google.com",
  "apps.apple.com",
  "www.amarewellness.com",
  "amarewellness.com",
]);

/** @param {unknown} raw */
export function trimText(raw, maxLen) {
  if (typeof raw !== "string") return "";
  return raw.trim().slice(0, maxLen);
}

/** @param {unknown} url */
export function validateCtaUrl(url) {
  if (url == null || url === "") return { ok: true, value: null };
  const s = typeof url === "string" ? url.trim() : "";
  if (!s) return { ok: true, value: null };
  let u;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, error: "invalid_cta_url" };
  }
  if (u.protocol !== "https:") return { ok: false, error: "invalid_cta_url" };
  const host = u.hostname.toLowerCase();
  if (!CTA_URL_HOSTS.has(host)) return { ok: false, error: "invalid_cta_url" };
  return { ok: true, value: u.toString() };
}

/** @param {Record<string, unknown>} row */
export function mapAnnouncementRow(row) {
  if (!row || typeof row !== "object") return null;
  return {
    id: String(row.id),
    title: String(row.title ?? ""),
    message: String(row.message ?? ""),
    isActive: row.is_active === true,
    startsAt: row.starts_at instanceof Date ? row.starts_at.toISOString() : String(row.starts_at ?? ""),
    expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : String(row.expires_at ?? ""),
    requireAcknowledgment: row.require_acknowledgment === true,
    ctaLabel: String(row.cta_label ?? "Got it").trim() || "Got it",
    ctaUrl: row.cta_url != null && row.cta_url !== "" ? String(row.cta_url) : null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at ?? ""),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at ?? ""),
  };
}

/** @param {ReturnType<typeof mapAnnouncementRow>} ann */
export function publicMobileAnnouncement(ann) {
  if (!ann) return null;
  return {
    id: ann.id,
    title: ann.title,
    message: ann.message,
    requireAcknowledgment: ann.requireAcknowledgment,
    ctaLabel: ann.ctaLabel,
    ctaUrl: ann.ctaUrl,
  };
}

/**
 * @param {ReturnType<typeof mapAnnouncementRow>} ann
 * @param {{ first_seen_at?: Date | string | null; acknowledged_at?: Date | string | null } | null | undefined} receipt
 * @param {number} [nowMs]
 */
export function shouldShowAnnouncementToUser(ann, receipt, nowMs = Date.now()) {
  if (!ann || !ann.isActive) return false;
  const startMs = Date.parse(ann.startsAt);
  const endMs = Date.parse(ann.expiresAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return false;
  if (startMs > nowMs || endMs <= nowMs) return false;
  const firstSeen = receipt?.first_seen_at ?? null;
  const ack = receipt?.acknowledged_at ?? null;
  if (ann.requireAcknowledgment) return ack == null;
  return firstSeen == null;
}

/**
 * Admin datetime-local value in studio TZ, e.g. 2026-10-14T09:30
 * @param {Date | string} isoUtc
 */
export function formatEtDatetimeLocalInput(isoUtc) {
  const d = isoUtc instanceof Date ? isoUtc : new Date(String(isoUtc));
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: STUDIO_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const pick = (t) => parts.find((p) => p.type === t)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")}T${pick("hour")}:${pick("minute")}`;
}

/**
 * Parse admin `YYYY-MM-DDTHH:mm` as America/New_York wall time → UTC Date.
 * @param {unknown} raw
 */
export function parseEtDatetimeLocalInput(raw) {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return null;
  const ms = mindbodyWallTimeToUtcMs(s.length === 16 ? `${s}:00` : s);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms);
}

/** @param {unknown} body */
export function parseAnnouncementSaveBody(body) {
  if (!body || typeof body !== "object") return { ok: false, error: "invalid_body" };
  const b = /** @type {Record<string, unknown>} */ (body);
  const title = trimText(b.title, TITLE_MAX);
  const message = trimText(b.message, MESSAGE_MAX);
  if (!title) return { ok: false, error: "title_required" };
  if (!message) return { ok: false, error: "message_required" };
  const startsAt = parseEtDatetimeLocalInput(b.startsAt ?? b.starts_at);
  const expiresAt = parseEtDatetimeLocalInput(b.expiresAt ?? b.expires_at);
  if (!startsAt || !expiresAt) return { ok: false, error: "invalid_dates" };
  if (expiresAt.getTime() <= startsAt.getTime()) return { ok: false, error: "expires_must_be_after_start" };
  const cta = validateCtaUrl(b.ctaUrl ?? b.cta_url);
  if (!cta.ok) return { ok: false, error: cta.error };
  const ctaLabel = trimText(b.ctaLabel ?? b.cta_label ?? "Got it", 64) || "Got it";
  return {
    ok: true,
    value: {
      id: typeof b.id === "string" && b.id.trim() ? b.id.trim().slice(0, 64) : null,
      title,
      message,
      startsAt,
      expiresAt,
      requireAcknowledgment: b.requireAcknowledgment === true || b.require_acknowledgment === true,
      ctaLabel,
      ctaUrl: cta.value,
    },
  };
}
