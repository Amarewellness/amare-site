/**
 * Shared admin token gate for New Client SMS admin endpoints.
 */

/** @param {unknown} event */
export function adminAuthorized(event) {
  const expected = (process.env.ADMIN_DEBUG_TOKEN || "").trim();
  if (!expected || expected.length < 16) return false;
  if (!event || typeof event !== "object") return false;
  const headers = /** @type {{ headers?: Record<string, string | undefined> }} */ (event).headers || {};
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === "x-admin-token") {
      const got = String(headers[k] || "").trim();
      if (got.length !== expected.length) return false;
      let mismatch = 0;
      for (let i = 0; i < got.length; i += 1) {
        mismatch |= got.charCodeAt(i) ^ expected.charCodeAt(i);
      }
      return mismatch === 0;
    }
  }
  return false;
}

/** @param {Record<string, string>} [extra] */
export function adminCorsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-admin-token",
    ...extra,
  };
}
