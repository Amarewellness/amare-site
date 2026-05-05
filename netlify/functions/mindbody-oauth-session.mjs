import {
  parseCookies,
  sessionSecret,
  unsealCookiePayload,
} from "./oauth-lib.mjs";

export async function handler(event) {
  try {
    const secret = sessionSecret();
    const cookieHeader = event.headers.cookie || event.headers.Cookie || "";
    const raw = parseCookies(cookieHeader).mb_sess;
    if (!raw) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
        body: JSON.stringify({ authenticated: false, loggedIn: false }),
      };
    }

    let data;
    try {
      data = unsealCookiePayload(raw, secret);
    } catch {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
        body: JSON.stringify({ authenticated: false, loggedIn: false }),
      };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      body: JSON.stringify({
        authenticated: true,
        loggedIn: true,
        email: data.email || null,
        name: data.name || null,
        sub: data.sub || null,
      }),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ ok: false, error: String(e?.message ?? e) }),
    };
  }
}
