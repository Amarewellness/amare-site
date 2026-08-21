/** CORS for AMARÉ mobile app (Capacitor / Vite dev on another origin). Web site uses same-origin cookies — unaffected. */
export const MOBILE_API_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, ngrok-skip-browser-warning",
  "Access-Control-Expose-Headers": "X-Amare-Access-Token, X-Amare-Refresh-Token",
};

/** Preference PATCH is the only mobile mutation that is not GET/POST/PUT/DELETE. */
export const MOBILE_PREF_CORS = {
  ...MOBILE_API_CORS,
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
};

/**
 * Reflect Capacitor / local Vite origins. Independent of ENABLE_MOBILE_BEARER_AUTH
 * so OPTIONS can succeed before the flag is on.
 * @param {string} origin
 */
export function isMobileCorsReflectOrigin(origin) {
  const raw = String(origin || "").trim();
  if (!raw) return false;
  try {
    const u = new URL(raw);
    if (u.protocol === "capacitor:" || u.protocol === "ionic:") return true;
    if (
      (u.hostname === "localhost" || u.hostname === "127.0.0.1") &&
      (u.protocol === "http:" || u.protocol === "https:")
    ) {
      return true;
    }
    const extra = String(process.env.AMARE_MOBILE_ALLOWED_ORIGINS || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    return extra.includes(raw.toLowerCase());
  } catch {
    return false;
  }
}

function eventOrigin(event) {
  const headers = event?.headers || {};
  return String(headers.origin || headers.Origin || "").trim();
}

/**
 * @param {string} origin
 * @param {Record<string, string>} [cors]
 */
export function mobileCorsHeadersForOrigin(origin, cors = MOBILE_API_CORS) {
  const reflect = isMobileCorsReflectOrigin(origin);
  return {
    ...cors,
    "Access-Control-Allow-Origin": reflect ? origin : cors["Access-Control-Allow-Origin"] || "*",
    Vary: "Origin",
  };
}

/** @param {import('@netlify/functions').HandlerEvent} event */
export function mobileApiPreflight(event, cors = MOBILE_API_CORS) {
  if (String(event?.httpMethod || "").toUpperCase() !== "OPTIONS") return null;
  return {
    statusCode: 204,
    headers: { ...mobileCorsHeadersForOrigin(eventOrigin(event), cors), "Cache-Control": "no-store" },
    body: "",
  };
}

/**
 * @param {{ statusCode?: number, headers?: Record<string, string>, body?: string } | null | undefined} res
 */
export function withMobileApiCors(res, cors = MOBILE_API_CORS) {
  if (!res) return res;
  return {
    ...res,
    headers: { ...(res.headers || {}), ...cors },
  };
}

/** @param {import('@netlify/functions').Handler} fn */
export function withMobileCorsHandler(fn, cors = MOBILE_API_CORS) {
  return async (/** @type {import('@netlify/functions').HandlerEvent} */ event) => {
    const pre = mobileApiPreflight(event, cors);
    if (pre) return pre;
    const headers = mobileCorsHeadersForOrigin(eventOrigin(event), cors);
    try {
      return withMobileApiCors(await fn(event), headers);
    } catch {
      return withMobileApiCors({
        statusCode: 500,
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
        body: JSON.stringify({ ok: false, error: "server_error" }),
      }, headers);
    }
  };
}
