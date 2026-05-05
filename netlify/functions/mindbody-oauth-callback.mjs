import {
  cookieSecureFlag,
  decodeJwtPayload,
  fetchUserInfo,
  issuerBase,
  oauthScopes,
  pickMindbodyClientId,
  profileFromClaims,
  redirectUri,
  requiredEnv,
  scanMindbodyClientIdFromClaims,
  sealCookiePayload,
  sessionSecret,
  subscriberId,
  verifyState,
  safeReturnPath,
} from "./oauth-lib.mjs";

async function exchangeAuthorizationCode(code) {
  const tokenUrl = `${issuerBase()}/connect/token`;
  const params = new URLSearchParams();
  params.set("grant_type", "authorization_code");
  params.set("client_id", requiredEnv("MINDBODY_OAUTH_CLIENT_ID"));
  params.set("client_secret", requiredEnv("MINDBODY_OAUTH_CLIENT_SECRET"));
  params.set("code", code);
  params.set("redirect_uri", redirectUri());
  params.set("scope", oauthScopes());
  const sub = subscriberId();
  if (sub) params.set("subscriberId", sub);

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(json.error_description || json.error || text || "token_error");
    /** @type {any} */ (err).status = res.status;
    /** @type {any} */ (err).body = json;
    throw err;
  }
  return json;
}

function parseFormBody(event) {
  /** @type {Record<string,string>} */
  const out = {};
  if (event.httpMethod === "POST" && event.body) {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body, "base64").toString("utf8")
      : event.body;
    const ct = (event.headers["content-type"] || event.headers["Content-Type"] || "").toLowerCase();
    if (ct.includes("application/x-www-form-urlencoded")) {
      for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
    }
  }
  if (event.queryStringParameters) {
    for (const [k, v] of Object.entries(event.queryStringParameters)) {
      if (v != null && v !== "") out[k] = v;
    }
  }
  return out;
}

export async function handler(event) {
  const secret = sessionSecret();
  const params = parseFormBody(event);
  const st = params.state ? verifyState(params.state, secret) : null;
  const fallbackReturn = safeReturnPath(st?.return || "/classes-api");

  try {
    if (params.error) {
      const loc = `${fallbackReturn}?oauth_err=${encodeURIComponent(params.error)}`;
      return { statusCode: 302, headers: { Location: loc, "Cache-Control": "no-store" } };
    }

    if (!st) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: "Invalid or expired OAuth state. Start sign-in again.",
      };
    }

    if (!params.code) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: "Missing authorization code.",
      };
    }

    const tokens = await exchangeAuthorizationCode(params.code);

    let raw = {};
    if (tokens.id_token) raw = { ...raw, ...decodeJwtPayload(tokens.id_token) };
    if (params.id_token) raw = { ...raw, ...decodeJwtPayload(params.id_token) };
    if (tokens.access_token) {
      const at = decodeJwtPayload(tokens.access_token);
      if (at && Object.keys(at).length) raw = { ...at, ...raw };
    }

    const userinfo = await fetchUserInfo(tokens.access_token);
    const merged = { ...raw, ...userinfo };
    const p = profileFromClaims(merged);
    const mbClientId = pickMindbodyClientId(merged) ?? scanMindbodyClientIdFromClaims(merged);

    const sessionPayload = {
      sub: p.sub,
      email: p.email,
      name: p.name,
      client_id: mbClientId,
      refresh_token: tokens.refresh_token || null,
      at: Date.now(),
    };

    const sealed = sealCookiePayload(sessionPayload, secret);
    const ttl = 60 * 60 * 24 * 30;
    const cookie = `mb_sess=${encodeURIComponent(sealed)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ttl}${cookieSecureFlag(event.headers)}`;

    return {
      statusCode: 302,
      headers: {
        Location: fallbackReturn,
        "Set-Cookie": cookie,
        "Cache-Control": "no-store",
      },
    };
  } catch (e) {
    const msg = String(e?.message ?? e).slice(0, 200);
    const loc = `${fallbackReturn}?oauth_err=${encodeURIComponent("token_exchange")}&detail=${encodeURIComponent(msg)}`;
    return {
      statusCode: 302,
      headers: { Location: loc, "Cache-Control": "no-store" },
    };
  }
}
