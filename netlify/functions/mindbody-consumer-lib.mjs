import {
  decodeJwtPayload,
  parseCookies,
  pickMindbodyClientId,
  refreshAccessToken,
  scanMindbodyClientIdFromClaims,
  sessionSecret,
  unsealCookiePayload,
} from "./oauth-lib.mjs";
import { mindbodyConsumerHeaders, mindbodyHeaders, mindbodyHost } from "./mindbody-upstream.mjs";

export const MB_API_VERSION = 6;

export function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(body),
  };
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
  return /** @type {Record<string, unknown>} */ (clients[0]);
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
 * Authenticated cookie + refresh → Bearer for Public API.
 * @returns {{ ok: true, session: Record<string, unknown>, email: string | null, authHeaders: Record<string,string> } | { ok: false, response: import('@netlify/functions').HandlerResponse }}
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
  try {
    const tokens = await refreshAccessToken(refresh);
    accessToken = tokens.access_token;
    if (!accessToken) throw new Error("no_access_token");
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
  return { ok: true, session, email, authHeaders, accessToken };
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

  let clientId =
    typeof session.client_id === "number" && session.client_id > 0 ? session.client_id : null;

  if (clientId != null) {
    const verified = await verifyClientId(clientId);
    if (verified != null) return verified;
  }

  if (email) {
    const q = new URLSearchParams();
    q.set("request.searchText", email.trim());
    q.set("request.limit", "50");
    const r = await fetchMb("GET", `/public/v${v}/client/clients?${q}`, authHeaders, null);
    if (r.ok) {
      const list = clientsList(r.data);
      const c = pickClientByEmail(list, email);
      const id = c?.Id ?? c?.id;
      if (id != null && Number.isFinite(Number(id))) return Number(id);
      if (list.length === 1) {
        const only = /** @type {Record<string, unknown>} */ (list[0]);
        const oid = only?.Id ?? only?.id;
        if (oid != null && Number.isFinite(Number(oid))) return Number(oid);
      }
    }
  }

  const name = typeof session.name === "string" ? session.name.trim() : "";
  if (name.length >= 2) {
    const q = new URLSearchParams();
    q.set("request.searchText", name);
    q.set("request.limit", "30");
    const r = await fetchMb("GET", `/public/v${v}/client/clients?${q}`, authHeaders, null);
    if (r.ok) {
      const list = clientsList(r.data);
      const c = email ? pickClientByEmail(list, email) : null;
      if (c) {
        const id = c?.Id ?? c?.id;
        if (id != null && Number.isFinite(Number(id))) return Number(id);
      }
      if (list.length === 1) {
        const only = /** @type {Record<string, unknown>} */ (list[0]);
        const oid = only?.Id ?? only?.id;
        if (oid != null && Number.isFinite(Number(oid))) return Number(oid);
      }
    }
  }

  return null;
}

/**
 * Cookie session + refresh token → consumer Bearer headers, then resolve Mindbody `clientId`.
 * @returns {{ ok: true, session: Record<string, unknown>, email: string | null, authHeaders: Record<string,string>, clientId: number } | { ok: false, response: import('@netlify/functions').HandlerResponse }}
 */
export async function resolveConsumerClient(event) {
  const a = await getSessionWithConsumerHeaders(event);
  if (!a.ok) return a;
  const clientId = await tryResolveClientId(a.session, a.email, a.authHeaders, a.accessToken);
  if (clientId == null) {
    return { ok: false, response: jsonResponse(400, { ok: false, error: "client_not_linked" }) };
  }
  return { ok: true, session: a.session, email: a.email, authHeaders: a.authHeaders, clientId };
}
