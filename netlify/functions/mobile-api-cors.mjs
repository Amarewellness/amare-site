/** CORS for AMARÉ mobile app (Capacitor / Vite dev on another origin). Web site uses same-origin cookies — unaffected. */
export const MOBILE_API_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization",
  "Access-Control-Expose-Headers": "X-Amare-Access-Token, X-Amare-Refresh-Token",
};

/** @param {import('@netlify/functions').HandlerEvent} event */
export function mobileApiPreflight(event) {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: { ...MOBILE_API_CORS, "Cache-Control": "no-store" },
      body: "",
    };
  }
  return null;
}

/**
 * @param {{ statusCode?: number, headers?: Record<string, string>, body?: string } | null | undefined} res
 */
export function withMobileApiCors(res) {
  if (!res) return res;
  return {
    ...res,
    headers: { ...(res.headers || {}), ...MOBILE_API_CORS },
  };
}

/** @param {import('@netlify/functions').Handler} fn */
export function withMobileCorsHandler(fn) {
  return async (/** @type {import('@netlify/functions').HandlerEvent} */ event) => {
    const pre = mobileApiPreflight(event);
    if (pre) return pre;
    return withMobileApiCors(await fn(event));
  };
}
