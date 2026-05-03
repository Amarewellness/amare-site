/**
 * Shared helpers for Mindbody local tooling (aligned with Developer Portal docs:
 * HTTPS, JSON, API-Key header; SiteId commonly passed as header for V6 REST).
 */

export function pickHost() {
  const h = process.env.MINDBODY_API_HOST?.trim() || "api.mindbodyonline.com";
  if (!/^[\w.-]+$/.test(h)) throw new Error("Invalid MINDBODY_API_HOST.");
  return h;
}

export function requireApiKey() {
  const key = process.env.MINDBODY_API_KEY?.trim();
  if (!key) {
    console.error(
      "Missing MINDBODY_API_KEY. Copy .env.example to .env and add your Developer Portal API Key."
    );
    process.exit(1);
  }
  return key;
}

export function siteId() {
  const raw =
    process.env.MINDBODY_SITE_ID?.trim() ??
    "-99";
  return raw || "-99";
}

export function mbHeaders(extra = {}) {
  return {
    "API-Key": requireApiKey(),
    SiteId: siteId(),
    Accept: "application/json",
    "Content-Type": "application/json",
    ...extra,
  };
}
