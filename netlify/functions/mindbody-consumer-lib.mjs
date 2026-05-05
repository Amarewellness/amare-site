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

/** Client-side uses the same keys in `member-dashboard.js` — keep payloads consistent. */
const VISITS_ARRAY_KEYS = ["Visits", "ClientVisits", "visits", "VisitDetails", "ScheduledVisits"];

/** @param {unknown} data Mindbody GET clientvisits JSON */
export function visitsList(data) {
  if (!data || typeof data !== "object") return [];
  const d = /** @type {Record<string, unknown>} */ (data);
  for (const k of VISITS_ARRAY_KEYS) {
    const v = d[k];
    if (Array.isArray(v)) return v;
  }
  for (const key of ["PaginationResponse", "Pagination", "pagination_response"]) {
    const pag = d[key];
    if (pag && typeof pag === "object") {
      const p = /** @type {Record<string, unknown>} */ (pag);
      for (const k of VISITS_ARRAY_KEYS) {
        const v = p[k];
        if (Array.isArray(v)) return v;
      }
    }
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

/** @param {unknown} row */
function idFromMindbodyClientRow(row) {
  if (!row || typeof row !== "object") return null;
  const o = /** @type {Record<string, unknown>} */ (row);
  const id = o.Id ?? o.id;
  if (id != null && Number.isFinite(Number(id)) && Number(id) > 0) return Number(id);
  return null;
}

/**
 * Parses Public API GET `client/clientcompleteinfo` payloads (Mindbody PascalCase / wrappers vary).
 * @param {unknown} data
 */
export function extractClientIdFromCompleteInfoPayload(data) {
  if (!data || typeof data !== "object") return null;
  const d = /** @type {Record<string, unknown>} */ (data);
  const fromWrapped = idFromMindbodyClientRow(d.Client ?? d.client);
  if (fromWrapped != null) return fromWrapped;
  const list = clientsList(d);
  if (list.length === 1) {
    const sole = idFromMindbodyClientRow(list[0]);
    if (sole != null) return sole;
  }
  const top = d.ClientId ?? d.clientId;
  if (top != null && Number.isFinite(Number(top)) && Number(top) > 0) return Number(top);
  return null;
}

/** Exclude full client-profile objects from heuristic card detection (`Id` is the person, not vault row). */
function looksLikePlainClientProfileRow(o) {
  const em = o.Email ?? o.email;
  const hasEmail = typeof em === "string" && em.includes("@");
  const fn = o.FirstName ?? o.firstName;
  const ln = o.LastName ?? o.lastName;
  const hasPersonName =
    (typeof fn === "string" && fn.trim()) || (typeof ln === "string" && ln.trim());
  const hasCcHint =
    o.LastFour != null ||
    o.lastFour != null ||
    o.CardType != null ||
    o.cardType != null ||
    o.CardNumber != null ||
    (typeof o.Type === "string" && /\bcard\b/i.test(o.Type));

  return hasEmail && hasPersonName && !hasCcHint;
}

/** @param {Record<string, unknown>} o */
function coerceLastFourDigits(o) {
  const direct = [
    o.LastFour,
    o.lastFour,
    o.last4,
    o.Last4,
    o.Last4Digits,
    o.LastFourDigits,
    o.CardLastFour,
    o.NumberLastFour,
    o.LastFourNumber,
  ];
  for (const raw of direct) {
    if (typeof raw === "number" && Number.isFinite(raw)) {
      const s = String(Math.trunc(Math.abs(raw))).padStart(4, "0");
      return s.slice(-4);
    }
    if (typeof raw === "string" && raw.trim()) {
      const digits = raw.replace(/\D/g, "");
      if (digits.length >= 4) return digits.slice(-4);
    }
  }
  for (const k of [
    "CardNumber",
    "cardNumber",
    "Number",
    "CardNumberMasked",
    "MaskedNumber",
    "MaskedCardNumber",
    "AccountNumber",
  ]) {
    const v = o[k];
    if (typeof v === "string") {
      const digits = v.replace(/\D/g, "");
      if (digits.length >= 4) return digits.slice(-4);
    }
  }
  return null;
}

/** Stored-card / vaulted payment row id (not the client's profile id when avoidable). */
/** @param {Record<string, unknown>} o */
function coerceMindbodyStoredPaymentId(o) {
  const prefer =
    o.StoredCardId ??
    o.storedCardId ??
    o.ClientCreditCardId ??
    o.ClientCreditCardID ??
    o.PaymentMethodId ??
    o.paymentMethodId ??
    null;
  if (prefer != null && Number.isFinite(Number(prefer)) && Number(prefer) > 0) return Number(prefer);

  const idRaw = o.Id ?? o.id ?? o.UniqueId ?? o.uniqueId;
  if (idRaw != null && Number.isFinite(Number(idRaw)) && Number(idRaw) > 0) return Number(idRaw);
  return null;
}

/** @param {Record<string, unknown>} o */
function looksLikeMindbodyStoredCardBlob(o) {
  if (coerceLastFourDigits(o) != null) return true;
  const ct = o.CardType ?? o.cardType ?? o.CardBrand ?? o.Brand ?? o.brand;
  if (typeof ct === "string" && ct.trim()) return true;
  if (typeof o.Type === "string" && /\bstored\b|\bcredit\b.*\bcard\b|\bmaster\b|\bvisa\b/i.test(o.Type))
    return true;
  for (const k of ["CardNumber", "cardNumber", "MaskedNumber"]) {
    if (typeof o[k] === "string" && (/\*/.test(/** @type {string} */ (o[k])) || /xxxx/i.test(/** @type {string} */ (o[k]))))
      return true;
  }
  const em = o.ExpirationMonth ?? o.ExpMonth ?? o.expMonth;
  const ey = o.ExpirationYear ?? o.ExpYear ?? o.expYear;
  if (
    em != null &&
    ey != null &&
    Number.isFinite(Number(em)) &&
    Number.isFinite(Number(ey)) &&
    (((typeof ct === "string" && ct.trim()) || coerceLastFourDigits(o) != null || typeof o.CardNumber === "string"))
  )
    return true;
  return false;
}

/** `ClientCreditCard`, `StoredCard`, etc. — children often omit redundant `CardType` but still vault `Id`. */
function keySuggestsPaymentInstrumentSubtree(propName) {
  return /\b(credit[\s_-]*card|stored[\s_-]*card|storedcard|clientcreditcard|payment[\s_-]*method|wallet|vault|billing.?card)\b/i.test(
    propName,
  );
}

/**
 * Finds Mindbody vaulted cards anywhere in Consumer payloads (`ClientCompleteInfo`, `Clients`, wrappers).
 * @param {unknown} data
 * @returns {{ id: number; lastFour: string; cardType: string }[]}
 */
export function extractStoredCardsFromMindbodyPayload(data) {
  /** @type {Map<number, { id: number; lastFour: string; cardType: string }>} */
  const byId = new Map();

  /** @param {unknown} node @param {{ inPaymentSubtree: boolean }} ctx */
  function walk(node, ctx) {
    if (node == null) return;
    if (Array.isArray(node)) {
      for (const el of node) walk(el, ctx);
      return;
    }
    if (typeof node !== "object") return;
    const o = /** @type {Record<string, unknown>} */ (node);

    const id = coerceMindbodyStoredPaymentId(o);
    if (id != null && id > 0 && !looksLikePlainClientProfileRow(o)) {
      const blob = looksLikeMindbodyStoredCardBlob(o);
      const storedFlag =
        o.StoredCardId != null || o.storedCardId != null || o.ClientCreditCardId != null || o.ClientCreditCardID != null;
      const acceptInWalletTree = ctx.inPaymentSubtree && (blob || storedFlag || coerceLastFourDigits(o) != null);
      const looksCard = blob || acceptInWalletTree;
      if (looksCard) {
        const lf = coerceLastFourDigits(o);
        const lastFour = lf != null ? lf : "0000";
        const cardType = String(
          o.CardType ?? o.cardType ?? o.CardBrand ?? o.Brand ?? o.brand ?? o.Type ?? "",
        ).trim();
        if (!byId.has(id)) {
          byId.set(id, {
            id,
            lastFour: lastFour.slice(-4).padStart(4, "0"),
            cardType,
          });
        }
      }
    }

    for (const k of Object.keys(o)) {
      const child = o[k];
      const next = { inPaymentSubtree: ctx.inPaymentSubtree };
      if (keySuggestsPaymentInstrumentSubtree(k)) next.inPaymentSubtree = true;
      walk(child, next);
    }
  }

  walk(data, { inPaymentSubtree: false });
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/**
 * Consumer Wallet / stored cards (`clientcompleteinfo` + `GetClients` fallbacks — same discovery as `mindbody-client-stored-cards`).
 *
 * @param {number} clientId
 * @param {Record<string, string>} authHeaders
 */
export async function fetchMindbodyConsumerStoredWalletCards(clientId, authHeaders) {
  const v = MB_API_VERSION;
  const r = await fetchMb("GET", `/public/v${v}/client/clientcompleteinfo`, authHeaders, null);

  /** @type {{ id: number; lastFour: string; cardType: string }[]} */
  let cards = [];

  if (!r.ok) {
    return {
      cciOk: /** @type {const} */ (false),
      cciHttpStatus: r.status,
      cciBody: r.data,
      cards,
    };
  }

  cards = extractStoredCardsFromMindbodyPayload(r.data);
  if (cards.length) {
    return { cciOk: /** @type {const} */ (true), cciHttpStatus: r.status, cciBody: r.data, cards };
  }

  const q = new URLSearchParams();
  q.set("request.clientIDs", String(clientId));
  q.set("request.Limit", "50");

  const r2 = await fetchMb("GET", `/public/v${v}/client/clients?${q}`, authHeaders, null);
  if (r2.ok) cards = extractStoredCardsFromMindbodyPayload(r2.data);

  if (!cards.length && r2.ok) {
    const q3 = new URLSearchParams(q);
    q3.set("request.Fields", "Clients.ClientCreditCard");
    const r3 = await fetchMb("GET", `/public/v${v}/client/clients?${q3}`, authHeaders, null);
    if (r3.ok) cards = extractStoredCardsFromMindbodyPayload(r3.data);
  }

  if (!cards.length && r2.ok) {
    const q4 = new URLSearchParams(q);
    q4.set("request.Fields", "clients.clientcreditcard");
    const r4 = await fetchMb("GET", `/public/v${v}/client/clients?${q4}`, authHeaders, null);
    if (r4.ok) cards = extractStoredCardsFromMindbodyPayload(r4.data);
  }

  return { cciOk: /** @type {const} */ (true), cciHttpStatus: r.status, cciBody: r.data, cards };
}

/**
 * GET/POST to Mindbody Public API.
 * @param {string} method
 * @param {string} pathQuery path + query
 * @param {Record<string,string>} headers
 * @param {Record<string, unknown>|null} bodyObj POST JSON or null
 * @param {{ timeoutMs?: number }} [opts] When set, aborts the request after `timeoutMs` (returns `504` + `{ _mbFetchTimeout: true }`).
 */
export async function fetchMb(method, pathQuery, headers, bodyObj, opts) {
  const timeoutMs =
    opts && typeof opts.timeoutMs === "number" && opts.timeoutMs > 0 ? opts.timeoutMs : 0;
  const url = `https://${mindbodyHost()}${pathQuery}`;
  /** @type {AbortController | null} */
  let ac = null;
  /** @return {void} */
  let clearT = () => {};
  if (timeoutMs) {
    ac = new AbortController();
    const t = setTimeout(() => ac?.abort(), timeoutMs);
    clearT = () => clearTimeout(t);
  }
  /** @type {RequestInit} */
  const init = {
    method,
    headers: { ...headers },
    ...(ac ? { signal: ac.signal } : {}),
  };
  if (bodyObj != null && method !== "GET") {
    /** @type {Record<string,string>} */ (init.headers)["Content-Type"] = "application/json";
    init.body = JSON.stringify(bodyObj);
  }
  try {
    const res = await fetch(url, init);
    clearT();
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { _raw: text };
    }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    clearT();
    const aborted =
      (e && typeof e === "object" && "name" in e && /** @type {{ name?: string }} */ (e).name === "AbortError") ||
      (e && typeof e === "object" && "code" in e && /** @type {{ code?: string|number }} */ (e).code === 20);
    if (aborted) {
      return {
        ok: false,
        status: 504,
        data: { _mbFetchTimeout: true, _timeoutMs: timeoutMs },
      };
    }
    throw e;
  }
}

/** @param {unknown} data Mindbody Issue response (AccessToken PascalCase per Public API models). */
function accessTokenFromIssueResponse(data) {
  if (!data || typeof data !== "object") return null;
  /** @param {unknown} o */
  function fromObj(o) {
    if (!o || typeof o !== "object") return null;
    const x = /** @type {Record<string, unknown>} */ (o);
    const t = x.AccessToken ?? x.accessToken;
    return typeof t === "string" && t.trim() ? t.trim() : null;
  }
  const direct = fromObj(data);
  if (direct) return direct;
  for (const v of Object.values(/** @type {Record<string, unknown>} */ (data))) {
    const nested = fromObj(v);
    if (nested) return nested;
  }
  return null;
}

/** Hot-instance cache for staff JWT (serverless: warm invocations reuse; cold start refetches). */
let staffAccessTokenCache = {
  /** @type {string | null} */
  accessToken: null,
  expiresAtMs: 0,
};

function boundedIssueTimeoutMs(ms) {
  return Math.min(Math.max(ms, 3000), 30000);
}

export function mindbodyIssueTokenTimeoutMs() {
  return boundedIssueTimeoutMs(parseInt(process.env.MINDBODY_ISSUE_TOKEN_TIMEOUT_MS || "8000", 10) || 8000);
}

/** Used by sale checkout + client total wait budget. */
export function mindbodyCheckoutTimeoutMs() {
  return Math.min(Math.max(parseInt(process.env.MINDBODY_CHECKOUT_TIMEOUT_MS || "20000", 10) || 20000, 8000), 120000);
}

function defaultStaffCacheTtlMs() {
  const raw = process.env.MINDBODY_STAFF_TOKEN_CACHE_TTL_SEC?.trim();
  if (raw && /^\d+$/.test(raw)) {
    const s = parseInt(raw, 10);
    if (s >= 60 && s <= 86400) return s * 1000;
  }
  return 5 * 60 * 1000;
}

/** @param {string} accessToken */
function staffTokenExpiryMs(accessToken) {
  const payload = decodeJwtPayload(accessToken);
  const exp =
    payload && typeof payload === "object"
      ? /** @type {Record<string, unknown>} */ (payload).exp
      : null;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return null;
  return exp * 1000;
}

/**
 * `POST …/usertoken/issue` — Staff User Token for CheckoutShoppingCart (server secrets only).
 * @param {{ timeoutMs?: number }} [options]
 * @returns {{ ok: true; accessToken: string } | { ok: false; error: string; status?: number; mindbody?: unknown }}
 */
export async function issueMindbodyStaffUserToken(options = {}) {
  const base = mindbodyHeaders();
  const username = process.env.MINDBODY_STAFF_USERNAME?.trim();
  const passwordEnv = process.env.MINDBODY_STAFF_PASSWORD;
  const password = typeof passwordEnv === "string" ? passwordEnv : "";
  if (!base || !username || !password) {
    return {
      ok: false,
      error: "missing_staff_issue_credentials",
      status: 400,
    };
  }
  const timeoutMs =
    typeof options.timeoutMs === "number" && options.timeoutMs > 0
      ? boundedIssueTimeoutMs(options.timeoutMs)
      : mindbodyIssueTokenTimeoutMs();

  const path = `/public/v${MB_API_VERSION}/usertoken/issue`;
  const r = await fetchMb(
    "POST",
    path,
    base,
    {
      Username: username,
      Password: password,
    },
    { timeoutMs },
  );
  if (!r.ok) {
    const timeout =
      r.data && typeof r.data === "object" && /** @type {Record<string, unknown>} */ (r.data)._mbFetchTimeout === true;
    return {
      ok: false,
      error: timeout ? "staff_token_issue_timeout" : "staff_token_issue_failed",
      status: r.status,
      mindbody: r.data,
    };
  }
  const accessToken = accessTokenFromIssueResponse(r.data);
  if (!accessToken) {
    return { ok: false, error: "staff_token_issue_malformed", mindbody: r.data };
  }
  return { ok: true, accessToken };
}

/**
 * Reuses in-memory staff token until ~30s before JWT `exp` (or `MINDBODY_STAFF_TOKEN_CACHE_TTL_SEC` if not a JWT).
 * @param {{ forceRefresh?: boolean; issueTimeoutMs?: number }} [options]
 */
export async function getMindbodyStaffAccessTokenCached(options = {}) {
  const forceRefresh = options.forceRefresh === true;
  const issueTimeoutMs =
    typeof options.issueTimeoutMs === "number" && options.issueTimeoutMs > 0
      ? boundedIssueTimeoutMs(options.issueTimeoutMs)
      : mindbodyIssueTokenTimeoutMs();

  const now = Date.now();
  if (
    !forceRefresh &&
    staffAccessTokenCache.accessToken &&
    now < staffAccessTokenCache.expiresAtMs
  ) {
    return { ok: true, accessToken: staffAccessTokenCache.accessToken, fromCache: true };
  }

  const issued = await issueMindbodyStaffUserToken({ timeoutMs: issueTimeoutMs });
  if (!issued.ok) {
    if (forceRefresh) {
      staffAccessTokenCache = { accessToken: null, expiresAtMs: 0 };
    }
    return { ...issued, fromCache: false };
  }

  const jwtExp = staffTokenExpiryMs(issued.accessToken);
  let expiresAtMs;
  if (jwtExp != null) {
    expiresAtMs = Math.max(now + 15_000, jwtExp - 30_000);
  } else {
    expiresAtMs = now + defaultStaffCacheTtlMs();
  }
  staffAccessTokenCache = {
    accessToken: issued.accessToken,
    expiresAtMs,
  };
  return { ok: true, accessToken: issued.accessToken, fromCache: false };
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

  {
    const r = await fetchMb("GET", `/public/v${v}/client/clientcompleteinfo`, authHeaders, null);
    if (r.ok && r.data && typeof r.data === "object") {
      const cid = extractClientIdFromCompleteInfoPayload(r.data);
      if (cid != null) {
        const verified = await verifyClientId(cid);
        if (verified != null) return verified;
      }
    }
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
