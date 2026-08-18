import { MOBILE_API_CORS } from "./mobile-api-cors.mjs";
import { handleNotificationPreferences } from "./amare-notification-http.mjs";

const PREF_CORS = {
  ...MOBILE_API_CORS,
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
};

export async function handler(event) {
  const method = String(event?.httpMethod || "GET").toUpperCase();
  if (method === "OPTIONS") {
    return { statusCode: 204, headers: { ...PREF_CORS, "Cache-Control": "no-store" }, body: "" };
  }
  try {
    const res = await handleNotificationPreferences(event);
    if (!res) return res;
    return { ...res, headers: { ...(res.headers || {}), ...PREF_CORS } };
  } catch {
    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        ...PREF_CORS,
      },
      body: JSON.stringify({ ok: false, error: "server_error" }),
    };
  }
}
