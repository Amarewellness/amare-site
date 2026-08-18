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

/** @param {import('@netlify/functions').HandlerEvent} event */
export function mobileApiPreflight(event, cors = MOBILE_API_CORS) {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: { ...cors, "Cache-Control": "no-store" },
      body: "",
    };
  }
  return null;
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
    try {
      return withMobileApiCors(await fn(event), cors);
    } catch {
      return withMobileApiCors({
        statusCode: 500,
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
        body: JSON.stringify({ ok: false, error: "server_error" }),
      }, cors);
    }
  };
}
