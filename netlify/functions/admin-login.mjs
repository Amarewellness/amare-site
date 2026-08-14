/**
 * Staff login for /admin pages.
 * POST /api/admin/login  { username, password } → { token: ADMIN_DEBUG_TOKEN }
 * APIs keep using x-admin-token. Cron / curl still use the long token directly.
 */

import { adminCorsHeaders } from "./new-client-sms-admin-auth.mjs";

/** @param {string} a @param {string} b */
function timingSafeEq(a, b) {
  const x = String(a);
  const y = String(b);
  const max = Math.max(x.length, y.length, 1);
  let mismatch = x.length === y.length ? 0 : 1;
  for (let i = 0; i < max; i += 1) {
    mismatch |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  }
  return mismatch === 0;
}

/** @param {number} status @param {unknown} body */
function json(status, body) {
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...adminCorsHeaders(),
    },
    body: JSON.stringify(body),
  };
}

/** @param {import("@netlify/functions").HandlerEvent} event */
function parseBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** @param {import("@netlify/functions").HandlerEvent} event */
export async function handler(event) {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "method_not_allowed" });

  const expectedUser = (process.env.ADMIN_USERNAME || "").trim();
  const expectedPass = (process.env.ADMIN_PASSWORD || "").trim();
  const token = (process.env.ADMIN_DEBUG_TOKEN || "").trim();
  if (!expectedUser || expectedUser.length < 3 || !expectedPass || expectedPass.length < 8 || !token || token.length < 16) {
    return json(503, {
      ok: false,
      error: "password_login_unconfigured",
      message: "Username/password login is not set. Use the admin token, or add ADMIN_USERNAME and ADMIN_PASSWORD.",
    });
  }

  const body = parseBody(event);
  if (body == null) return json(400, { ok: false, error: "invalid_json" });
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  if (!timingSafeEq(username, expectedUser) || !timingSafeEq(password, expectedPass)) {
    return json(401, { ok: false, error: "invalid_credentials", message: "Wrong username or password." });
  }

  return json(200, { ok: true, token });
}
