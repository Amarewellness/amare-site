import {
  cookieSecureFlag,
  decodeJwtPayload,
  parseCookies,
  pickMindbodyClientId,
  refreshAccessToken,
  scanMindbodyClientIdFromClaims,
  sealCookiePayload,
  sessionSecret,
  unsealCookiePayload,
} from "./oauth-lib.mjs";
import { mindbodyConsumerHeaders, mindbodyHeaders, mindbodyHost } from "./mindbody-upstream.mjs";

export const MB_API_VERSION = 6;

export function jsonResponse(statusCode, body, extraHeaders) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...(extraHeaders && typeof extraHeaders === "object" ? extraHeaders : {}),
    },
    body: JSON.stringify(body),
  };
}

/** Updated `mb_sess` after Mindbody returns a rotated refresh token (must be sent as Set-Cookie). */
function mbSessionCookieValue(payload, event) {
  const secret = sessionSecret();
  const sealed = sealCookiePayload(payload, secret);
  const ttl = 60 * 60 * 24 * 30;
  return `mb_sess=${encodeURIComponent(sealed)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ttl}${cookieSecureFlag(event.headers)}`;
}

/** @param {unknown} data */
export function clientsList(data) {
  if (!data || typeof data !== "object") return [];
  const d = /** @type {Record<string, unknown>} */ (data);
  if (Array.isArray(d.Clients)) return d.Clients;
  const pag = d.Pagination;
  if (pag && typeof pag === "object") {
    const pc = /** @type {Record<string, unknown>} */ (pag).Clients;
    if (Array.isArray(pc)) return pc;
  }
  return [];
}

/** @param {unknown[]} clients @param {string | null} email */
export function pickClientByEmail(clients, email) {
  if (!clients.length) return null;
  if (!email) return /** @type {Record<string, unknown>} */ (clients[0]);
  const e = email.trim().toLowerCase();
  for (const raw of clients) {
    const c = /** @type {Record<string, unknown>} */ (raw);
    const em = String(c.Email ?? c.email ?? "").trim().toLowerCase();
    if (em && em === e) return c;
  }
  return null;
}

/**
 * GET/POST to Mindbody Public API.
 * @param {string} method
 * @param {string} pathQuery path + query
 * @param {Record<string,string>} headers
 * @param {Record<string, unknown>|null} bodyObj POST JSON or null
 */
export async function fetchMb(method, pathQuery, headers, bodyObj) {
  const url = `https://${mindbodyHost()}${pathQuery}`;
  /** @type {RequestInit} */
  const init = {
    method,
    headers: { ...headers },
  };
  if (bodyObj != null && method !== "GET") {
    /** @type {Record<string,string>} */ (init.headers)["Content-Type"] = "application/json";
    init.body = JSON.stringify(bodyObj);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { _raw: text };
  }
  return { ok: res.ok, status: res.status, data };
}

/**
 * Authenticated cookie + refresh → Public API headers with `consumer-identity-token`.
 * @returns {{ ok: true, session: Record<string, unknown>, email: string | null, authHeaders: Record<string,string>, accessToken: string, setCookie?: string } | { ok: false, response: import('@netlify/functions').HandlerResponse }}
 */
export async function getSessionWithConsumerHeaders(event) {
  if (!mindbodyHeaders()) {
    return {
      ok: false,
      response: jsonResponse(503, {
        ok: false,
        error: "MindbodyProxyNotConfigured",
        message: "Set MINDBODY_API_KEY (and MINDBODY_SITE_ID) in Netlify environment variables.",
      }),
    };
  }

  /** @type {Record<string, unknown>} */
  let session;
  try {
    const secret = sessionSecret();
    const cookieHeader = event.headers.cookie || event.headers.Cookie || "";
    const raw = parseCookies(cookieHeader).mb_sess;
    if (!raw) return { ok: false, response: jsonResponse(401, { ok: false, error: "not_authenticated" }) };
    session = unsealCookiePayload(raw, secret);
  } catch {
    return { ok: false, response: jsonResponse(401, { ok: false, error: "invalid_session" }) };
  }

  const refresh = session.refresh_token;
  if (typeof refresh !== "string" || !refresh.trim()) {
    return { ok: false, response: jsonResponse(401, { ok: false, error: "missing_refresh_token" }) };
  }

  let accessToken;
  /** @type {string|undefined} */
  let setCookie;
  try {
    const tokens = await refreshAccessToken(refresh);
    accessToken = tokens.access_token;
    if (!accessToken) throw new Error("no_access_token");
    if (typeof tokens.refresh_token === "string" && tokens.refresh_token.trim()) {
      session = { ...session, refresh_token: tokens.refresh_token.trim() };
      setCookie = mbSessionCookieValue(session, event);
    }
  } catch (e) {
    return {
      ok: false,
      response: jsonResponse(401, {
        ok: false,
        error: "token_refresh_failed",
        detail: String(e?.message ?? e).slice(0, 200),
      }),
    };
  }

  const authHeaders = mindbodyConsumerHeaders(accessToken);
  if (!authHeaders) {
    return { ok: false, response: jsonResponse(503, { ok: false, error: "MindbodyProxyNotConfigured" }) };
  }

  const email = typeof session.email === "string" ? session.email : null;
  return { ok: true, session, email, authHeaders, accessToken, setCookie };
}

/**
 * @param {string | undefined} accessToken - fresh access JWT (Mindbody often puts client id only here).
 */
export async function tryResolveClientId(session, email, authHeaders, accessToken) {
  const v = MB_API_VERSION;

  async function verifyClientId(candidate) {
    if (candidate == null || !Number.isFinite(Number(candidate)) || Number(candidate) <= 0) return null;
    const id = Number(candidate);
    const q = new URLSearchParams();
    q.set("request.clientIDs", String(id));
    q.set("request.limit", "5");
    const r = await fetchMb("GET", `/public/v${v}/client/clients?${q}`, authHeaders, null);
    if (r.ok && clientsList(r.data).length) return id;
    return null;
  }

  if (typeof accessToken === "string" && accessToken.includes(".")) {
    const atClaims = decodeJwtPayload(accessToken);
    let tid = pickMindbodyClientId(atClaims);
    if (tid == null) tid = scanMindbodyClientIdFromClaims(atClaims);
    const verified = await verifyClientId(tid);
    if (verified != null) return verified;
  }

  let clientId = null;
  const rawSid = session.client_id;
  if (typeof rawSid === "number" && rawSid > 0) clientId = rawSid;
  else if (typeof rawSid === "string" && /^\d+$/.test(rawSid.trim())) {
    const n = parseInt(rawSid.trim(), 10);
    if (n > 0) clientId = n;
  }

  if (clientId != null) {
    const verified = await verifyClientId(clientId);
    if (verified != null) return verified;
  }

  if (email) {
    const q = new URLSearchParams();
    q.set("request.searchText", email.trim());
    q.set("request.limit", "100");
    const r = await fetchMb("GET", `/public/v${v}/client/clients?${q}`, authHeaders, null);
    if (r.ok) {
      const list = clientsList(r.data);
      const c = pickClientByEmail(list, email);
      let candidate =
        c != null ? (c.Id ?? c.id) : list.length === 1 ? (/** @type {Record<string, unknown>} */ (list[0]).Id ?? /** @type {Record<string, unknown>} */ (list[0]).id) : null;
      if (candidate != null && Number.isFinite(Number(candidate))) {
        const verified = await verifyClientId(Number(candidate));
        if (verified != null) return verified;
      }
    }
  }

  const name = typeof session.name === "string" ? session.name.trim() : "";
  if (name.length >= 2) {
    const q = new URLSearchParams();
    q.set("request.searchText", name);
    q.set("request.limit", "100");
    const r = await fetchMb("GET", `/public/v${v}/client/clients?${q}`, authHeaders, null);
    if (r.ok) {
      const list = clientsList(r.data);
      const c = email ? pickClientByEmail(list, email) : null;
      let candidate =
        c != null
          ? (c.Id ?? c.id)
          : list.length === 1
            ? (/** @type {Record<string, unknown>} */ (list[0]).Id ?? /** @type {Record<string, unknown>} */ (list[0]).id)
            : null;
      if (candidate != null && Number.isFinite(Number(candidate))) {
        const verified = await verifyClientId(Number(candidate));
        if (verified != null) return verified;
      }
    }
  }

  return null;
}

/**
 * Cookie session + refresh token → consumer headers (`consumer-identity-token`), then resolve Mindbody `clientId`.
 * @returns {{ ok: true, session: Record<string, unknown>, email: string | null, authHeaders: Record<string,string>, clientId: number, setCookie?: string } | { ok: false, response: import('@netlify/functions').HandlerResponse }}
 */
export async function resolveConsumerClient(event) {
  const a = await getSessionWithConsumerHeaders(event);
  if (!a.ok) return a;
  const cookieHeaders = a.setCookie ? { "Set-Cookie": a.setCookie } : {};
  const clientId = await tryResolveClientId(a.session, a.email, a.authHeaders, a.accessToken);
  if (clientId == null) {
    return {
      ok: false,
      response: jsonResponse(400, { ok: false, error: "client_not_linked" }, cookieHeaders),
    };
  }
  return {
    ok: true,
    session: a.session,
    email: a.email,
    authHeaders: a.authHeaders,
    clientId,
    setCookie: a.setCookie,
  };
}
