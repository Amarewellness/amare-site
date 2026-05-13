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
import { mindbodyConsumerHeaders, mindbodyHeaders, mindbodyHost, mindbodyStaffApiHeaders, mindbodyStaffBearerHeaders } from "./mindbody-upstream.mjs";

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
    "TruncatedCardNumber",
    "truncatedCardNumber",
    "ObfuscatedCardNumber",
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
    o.CreditCardId ??
    o.creditCardId ??
    o.CreditCardID ??
    o.PaymentMethodId ??
    o.paymentMethodId ??
    o.PaymentInstrumentId ??
    o.paymentInstrumentId ??
    o.ClientAccountCreditCardId ??
    o.WalletId ??
    o.walletId ??
    null;
  if (prefer != null && Number.isFinite(Number(prefer)) && Number(prefer) > 0) return Number(prefer);

  for (const k of ["CreditCardID", "VaultEntryId", "BillingCardId", "ConsumerPaymentProfileId"]) {
    const v = o[k];
    if (v != null && Number.isFinite(Number(v)) && Number(v) > 0) return Number(v);
  }

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
  if (/ClientCreditCards?|creditcards?|storedcards?|PaymentMethods?|paymentmethods?|Billing|Autopay|wallet|Wallet|Vault|vault/i.test(propName))
    return true;
  return /\b(credit[\s_-]*card|stored[\s_-]*card|storedcard|clientcreditcard|payment[\s_-]*method|wallet|vault|billing[\s_-]*card)\b/i.test(
    propName,
  );
}

/**
 * Picks up card rows the strict walk can miss (e.g. expiry + card brand without masked PAN in payload).
 * @param {unknown} data
 * @returns {{ id: number; lastFour: string; cardType: string }[]}
 */
function extractLooseExpiryBasedCards(data) {
  /** @type {Map<number, { id: number; lastFour: string; cardType: string }>} */
  const byId = new Map();

  /** @param {Record<string, unknown>} o */
  function looksLikePaymentInstrument(o) {
    const ct = String(o.CardType ?? o.cardType ?? o.CardBrand ?? o.Brand ?? "").trim();
    if (coerceLastFourDigits(o) != null) return true;
    if (ct && /\b(visa|master|amex|discover|diners|jcb|union|card|debit|cc)\b/i.test(ct)) return true;
    const cn = o.CardNumber ?? o.cardNumber;
    if (typeof cn === "string" && cn.trim() && (/\*/.test(cn) || /x{2,}/i.test(cn) || /\d{4}/.test(cn)))
      return true;
    return false;
  }

  /** @param {unknown} node */
  function visit(node) {
    if (node == null) return;
    if (Array.isArray(node)) {
      for (const el of node) visit(el);
      return;
    }
    if (typeof node !== "object") return;
    const o = /** @type {Record<string, unknown>} */ (node);

    const em =
      o.ExpirationMonth ?? o.ExpMonth ?? o.expMonth ?? o.ExpirationMonthNumber ?? o.ExpMonthNumber;
    const ey = o.ExpirationYear ?? o.ExpYear ?? o.expYear ?? o.ExpirationYearNumber ?? o.ExpYearNumber ?? o.ExpYearFull;
    const hasExp =
      em != null &&
      ey != null &&
      Number.isFinite(Number(em)) &&
      Number.isFinite(Number(ey)) &&
      Number(em) > 0 &&
      Number(ey) > 0;

    const id = coerceMindbodyStoredPaymentId(o);
    if (id != null && id > 0 && hasExp && !looksLikePlainClientProfileRow(o) && looksLikePaymentInstrument(o)) {
      const lf = coerceLastFourDigits(o);
      const cardType = String(o.CardType ?? o.cardType ?? o.CardBrand ?? o.Brand ?? "").trim();
      if (!byId.has(id)) {
        byId.set(id, {
          id,
          lastFour: lf != null ? lf.slice(-4).padStart(4, "0") : "0000",
          cardType,
        });
      }
    }

    for (const k of Object.keys(o)) visit(o[k]);
  }

  visit(data);
  return [...byId.values()].sort((a, b) => a.id - b.id);
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

  for (const c of extractLooseExpiryBasedCards(data)) {
    if (!byId.has(c.id)) byId.set(c.id, c);
  }

  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/**
 * Matches {@link PurchaseContract} `StoredCardInfo.LastFour`: only attempt on-site billing when Mindbody exposes
 * a four-digit suffix on Consumer wallet payloads (reject extractor placeholder unknown → `0000`).
 * @param {{ lastFour?: string }[]} cards normalized rows from `fetchMindbodyConsumerStoredWalletCards`
 * @returns {string | null} four ASCII digits or null
 */
export function reliableLastFourFromWalletCards(cards) {
  if (!Array.isArray(cards)) return null;
  for (const c of cards) {
    const raw = c && typeof c.lastFour === "string" ? c.lastFour.trim() : "";
    const digits = raw.replace(/\D/g, "").slice(-4);
    if (digits.length === 4 && /^[0-9]{4}$/.test(digits) && digits !== "0000") return digits;
  }
  return null;
}

/** @param {{ lastFour?: string }[]} cards */
export function walletCardsWithReliableLastFourCount(cards) {
  if (!Array.isArray(cards)) return 0;
  let n = 0;
  for (const c of cards) {
    const raw = c && typeof c.lastFour === "string" ? c.lastFour.trim() : "";
    const digits = raw.replace(/\D/g, "").slice(-4);
    if (digits.length === 4 && /^[0-9]{4}$/.test(digits) && digits !== "0000") n += 1;
  }
  return n;
}

const WALLET_DEBUG_PAYMENT_KEY_RE = /\b(billing|payment|credit|card|wallet|vault|stored|autopay|eft|ach)\b/i;

/**
 * Whether the JSON mentions `ClientCreditCard` / plural by **property name only** — no PAN, expiry values, tokens, etc.
 * Mindbody may omit these fields entirely for Consumer JWT sites, omit per processor, or return only when using
 * `request.Fields` projections and/or Staff User Token — not guaranteed across Public API installs.
 *
 * @param {unknown} data
 */
function walletDebugClientCreditCardFieldPresence(data) {
  /** @type {string[]} */
  const propertyNamePathsSample = [];
  const MAX_PATHS = 28;
  /** @param {string} k */
  function keyIsClientCreditCard(k) {
    const t = k.replace(/\s/g, "");
    return /^ClientCreditCards?$/i.test(t) || /^clientcreditcards?$/i.test(t);
  }
  /** @param {unknown} node @param {string} path */
  function walk(node, path) {
    if (propertyNamePathsSample.length >= MAX_PATHS || node == null) return;
    if (Array.isArray(node)) {
      const lim = Math.min(node.length, 12);
      for (let i = 0; i < lim; i++) walk(node[i], `${path}[${i}]`);
      return;
    }
    if (typeof node !== "object") return;
    const o = /** @type {Record<string, unknown>} */ (node);
    for (const k of Object.keys(o)) {
      const dot = path ? `${path}.${k}` : k;
      if (keyIsClientCreditCard(k)) {
        propertyNamePathsSample.push(dot);
        if (propertyNamePathsSample.length >= MAX_PATHS) return;
      }
      walk(o[k], dot);
    }
  }
  walk(data, "");

  const top = data && typeof data === "object" ? /** @type {Record<string, unknown>} */ (data) : null;
  const hasTopLevelClientCreditCard = !!(
    top && Object.keys(top).some((k) => keyIsClientCreditCard(k))
  );

  let hasClient_ClientCreditCard = false;
  if (top?.Client && typeof top.Client === "object") {
    const cObj = /** @type {Record<string, unknown>} */ (top.Client);
    hasClient_ClientCreditCard = Object.keys(cObj).some((k) => keyIsClientCreditCard(k));
  }

  let hasClientsRow_ClientCreditCard = false;
  const cl = clientsList(data);
  for (let i = 0; i < cl.length && i < 80; i++) {
    const row = cl[i];
    if (!row || typeof row !== "object") continue;
    if (Object.keys(/** @type {Record<string, unknown>} */ (row)).some((k) => keyIsClientCreditCard(k))) {
      hasClientsRow_ClientCreditCard = true;
      break;
    }
  }

  return {
    hasTopLevelClientCreditCard,
    hasClient_ClientCreditCard,
    hasClientsRow_ClientCreditCard,
    propertyNamePathsSample,
  };
}

/**
 * DFS: dot-paths whose property names look billing/payment-related (keys only — no values).
 * @param {unknown} data
 * @param {number} [maxPaths]
 * @param {number} [maxDepth]
 * @returns {string[]}
 */
function collectPaymentLikeKeyPaths(data, maxPaths = 48, maxDepth = 9) {
  /** @type {string[]} */
  const out = [];
  /** @param {unknown} node @param {string} path @param {number} depth */
  function walk(node, path, depth) {
    if (out.length >= maxPaths || depth > maxDepth || node == null) return;
    if (Array.isArray(node)) {
      const lim = Math.min(node.length, 4);
      for (let i = 0; i < lim; i++) walk(node[i], `${path}[${i}]`, depth + 1);
      if (node.length > lim && out.length < maxPaths)
        out.push(`${path}[…+${node.length - lim} more rows]`);
      return;
    }
    if (typeof node !== "object") return;
    const o = /** @type {Record<string, unknown>} */ (node);
    for (const k of Object.keys(o)) {
      if (out.length >= maxPaths) return;
      const p = path ? `${path}.${k}` : k;
      if (keySuggestsPaymentInstrumentSubtree(k) || WALLET_DEBUG_PAYMENT_KEY_RE.test(k)) out.push(p);
      walk(o[k], p, depth + 1);
    }
  }
  walk(data, "", 0);
  return out.slice(0, maxPaths);
}

/**
 * Safe JSON shape for wallet diagnostics — no PAN, tokens, or raw bodies.
 * @param {string} pathLabel
 * @param {'consumer'|'staff'} authRole
 * @param {{ ok: boolean; status: number; data: unknown }} mbResult
 */
function summarizeMbWalletResponse(pathLabel, authRole, mbResult) {
  const { ok, status, data } = mbResult;
  /** @type {Record<string, unknown>} */
  const row = {
    pathLabel,
    authRole,
    httpStatus: status,
    responseOk: ok,
  };
  if (data && typeof data === "object" && "_raw" in data) {
    row.jsonParsed = false;
    const raw = /** @type {Record<string, unknown>} */ (data)._raw;
    row.rawBodyLength = typeof raw === "string" ? raw.length : 0;
    row.clientCreditCardFieldPresence = {
      skippedNonJsonPayload: true,
      hasTopLevelClientCreditCard: false,
      hasClient_ClientCreditCard: false,
      hasClientsRow_ClientCreditCard: false,
      propertyNamePathsSample: [],
    };
    return row;
  }
  row.jsonParsed = true;
  if (data == null || typeof data !== "object") {
    row.dataKind = data === null ? "null" : typeof data;
    row.extractorCardCount = 0;
    row.clientCreditCardFieldPresence = {
      skippedNoObjectPayload: true,
      hasTopLevelClientCreditCard: false,
      hasClient_ClientCreditCard: false,
      hasClientsRow_ClientCreditCard: false,
      propertyNamePathsSample: [],
    };
    return row;
  }
  const d = /** @type {Record<string, unknown>} */ (data);
  row.topLevelKeys = Object.keys(d).slice(0, 96);
  const cl = clientsList(d);
  row.clientsListLength = cl.length;
  if (d.Client && typeof d.Client === "object") {
    row.clientSubtreeKeys = Object.keys(/** @type {Record<string, unknown>} */ (d.Client)).slice(0, 96);
  }
  if (cl[0] && typeof cl[0] === "object") {
    row.firstClientRowKeys = Object.keys(/** @type {Record<string, unknown>} */ (cl[0])).slice(0, 96);
  }
  const extracted = extractStoredCardsFromMindbodyPayload(data);
  row.extractorCardCount = extracted.length;
  row.paymentRelatedPathsSample = collectPaymentLikeKeyPaths(data);
  row.clientCreditCardFieldPresence = walletDebugClientCreditCardFieldPresence(data);
  return row;
}

/**
 * `?debugWallet=1` is honored only when (a) not Netlify `production` CONTEXT, or (b) `MINDBODY_WALLET_DEBUG_SECRET`
 * matches header `x-mb-wallet-debug` or query `debugSecret`.
 * @param {import('@netlify/functions').HandlerEvent} event
 */
export function isWalletDebugGateOpen(event) {
  const secret = process.env.MINDBODY_WALLET_DEBUG_SECRET?.trim();
  const q = event.queryStringParameters || {};
  const hdr = String(
    (event.headers && (event.headers["x-mb-wallet-debug"] || event.headers["X-Mb-Wallet-Debug"])) || "",
  ).trim();
  const qsSecret = q.debugSecret != null ? String(q.debugSecret).trim() : "";
  if (secret && (hdr === secret || qsSecret === secret)) return true;

  const netlifyCtx = process.env.CONTEXT || "";
  if (netlifyCtx && netlifyCtx !== "production") return true;
  const n = process.env.NODE_ENV || "";
  if (!n || n === "development" || n === "dev") return true;
  return false;
}

/**
 * Consumer wallet: `clientcompleteinfo` + `GetClients` (+ optional `request.Fields` projections).
 * If `clientcompleteinfo` fails, we still query `GetClients` — some sites return cards only there
 * (or CCI is flaky while `/client/clients` works).
 *
 * @param {number} clientId
 * @param {Record<string, string>} authHeaders
 * @param {{ walletDebug?: boolean }} [opts]
 * @returns {Promise<{
 *   cards: { id: number; lastFour: string; cardType: string }[];
 *   cciOk: boolean;
 *   cciHttpStatus: number;
 *   cciBody: unknown;
 *   anyMindbodyRequestSucceeded: boolean;
 *   staffWalletProbe?: { attempted: boolean; staffHeadersAvailable: boolean; cciScoped: boolean };
 *   walletDebug?: { requests: Record<string, unknown>[]; staffTokenIssue?: Record<string, unknown> };
 * }>}
 */
export async function fetchMindbodyConsumerStoredWalletCards(clientId, authHeaders, opts) {
  const dbg = opts?.walletDebug === true;
  const clientCreditCardApiNote =
    "Mindbody Client.ClientCreditCard is not guaranteed on GET clientcompleteinfo or GET client/clients; some sites return it only with request.Fields (e.g. Clients.ClientCreditCard), Staff User Token, and/or specific payment-processor / privacy settings. If clientCreditCardFieldPresence is all false and propertyNamePathsSample is empty across our consumer+staff+Fields attempts, treat as: no stored-card subtree exposed on this Public API path.";
  /** @type {Record<string, unknown>[]} */
  const walletDebugRequests = [];
  /** @param {string} label @param {'consumer'|'staff'} role @param {{ ok: boolean; status: number; data: unknown }} res */
  const pushDbg = (label, role, res) => {
    if (!dbg) return;
    const summarized = summarizeMbWalletResponse(label, role, res);
    walletDebugRequests.push(summarized);
    console.log(
      JSON.stringify({
        event: "mb_wallet_clientcreditcard_probe",
        pathLabel: label,
        authRole: role,
        httpStatus: res.status,
        responseOk: res.ok,
        clientCreditCardFieldPresence: summarized.clientCreditCardFieldPresence,
      }),
    );
  };

  function walletDbgPayload(extra) {
    /** @param {unknown} pres */
    function ccKeyPresentAnywhere(pres) {
      if (!pres || typeof pres !== "object") return false;
      const o = /** @type {Record<string, unknown>} */ (pres);
      if (o.skippedNonJsonPayload === true || o.skippedNoObjectPayload === true) return false;
      if (
        o.hasTopLevelClientCreditCard === true ||
        o.hasClient_ClientCreditCard === true ||
        o.hasClientsRow_ClientCreditCard === true
      ) {
        return true;
      }
      const s = o.propertyNamePathsSample;
      return Array.isArray(s) && s.length > 0;
    }
    const anyClientCreditCardKeyInResponses = walletDebugRequests.some((req) =>
      ccKeyPresentAnywhere(req.clientCreditCardFieldPresence),
    );
    return {
      requests: walletDebugRequests,
      clientCreditCardApiNote,
      anyClientCreditCardKeyInResponses,
      ...(extra && typeof extra === "object" ? extra : {}),
    };
  }

  const v = MB_API_VERSION;
  const r = await fetchMb("GET", `/public/v${v}/client/clientcompleteinfo`, authHeaders, null);
  pushDbg(`GET /public/v${v}/client/clientcompleteinfo`, "consumer", r);

  let anyMbOk = !!r.ok;

  /** @type {{ id: number; lastFour: string; cardType: string }[]} */
  let cards = [];
  if (r.ok) {
    cards = extractStoredCardsFromMindbodyPayload(r.data);
    if (cards.length) {
      return {
        cards,
        cciOk: true,
        cciHttpStatus: r.status,
        cciBody: r.data,
        anyMindbodyRequestSucceeded: true,
        ...(dbg ? { walletDebug: walletDbgPayload() } : {}),
      };
    }
  }

  /** Some sites only return credit-card subtrees when `request.clientId` is explicit (even for consumer JWT). */
  if (!cards.length) {
    const cidQs = new URLSearchParams();
    cidQs.set("request.clientId", String(clientId));
    const rCciScoped = await fetchMb(
      "GET",
      `/public/v${v}/client/clientcompleteinfo?${cidQs}`,
      authHeaders,
      null,
    );
    pushDbg(`GET /public/v${v}/client/clientcompleteinfo?request.clientId=…`, "consumer", rCciScoped);
    anyMbOk = anyMbOk || !!rCciScoped.ok;
    if (rCciScoped.ok) {
      cards = extractStoredCardsFromMindbodyPayload(rCciScoped.data);
      if (cards.length) {
        return {
          cards,
          cciOk: true,
          cciHttpStatus: rCciScoped.status,
          cciBody: rCciScoped.data,
          anyMindbodyRequestSucceeded: true,
          ...(dbg ? { walletDebug: walletDbgPayload() } : {}),
        };
      }
    }
  }

  const q = new URLSearchParams();
  q.set("request.clientIDs", String(clientId));
  q.set("request.Limit", "50");

  const r2 = await fetchMb("GET", `/public/v${v}/client/clients?${q}`, authHeaders, null);
  pushDbg(`GET /public/v${v}/client/clients?clientIDs`, "consumer", r2);
  anyMbOk = anyMbOk || !!r2.ok;
  if (r2.ok) {
    cards = extractStoredCardsFromMindbodyPayload(r2.data);
    if (cards.length) {
      return {
        cards,
        cciOk: !!r.ok,
        cciHttpStatus: r.status,
        cciBody: r.data,
        anyMindbodyRequestSucceeded: true,
        ...(dbg ? { walletDebug: walletDbgPayload() } : {}),
      };
    }
  }

  /** Fewer parallel variants than before — excess Fields calls slowed responses and could trigger throttling. */
  if (!cards.length) {
    const fieldQueries = [
      "Clients.ClientCreditCard",
      "clients.clientcreditcard",
      "Clients.ClientCreditCards",
    ];
    const rs = await Promise.all(
      fieldQueries.map((fields) => {
        const qp = new URLSearchParams(q);
        qp.set("request.Fields", fields);
        return fetchMb("GET", `/public/v${v}/client/clients?${qp}`, authHeaders, null);
      }),
    );
    fieldQueries.forEach((fields, i) => {
      pushDbg(`GET /public/v${v}/client/clients?Fields=${fields}`, "consumer", rs[i]);
    });
    for (const rx of rs) {
      if (rx.ok) anyMbOk = true;
    }
    /** @type {Map<number, { id: number; lastFour: string; cardType: string }>} */
    const merged = new Map();
    for (const rx of rs) {
      if (rx.ok) {
        for (const c of extractStoredCardsFromMindbodyPayload(rx.data)) merged.set(c.id, c);
      }
    }
    cards = [...merged.values()].sort((a, b) => a.id - b.id);
    if (cards.length) {
      return {
        cards,
        cciOk: !!r.ok,
        cciHttpStatus: r.status,
        cciBody: r.data,
        anyMindbodyRequestSucceeded: true,
        ...(dbg ? { walletDebug: walletDbgPayload() } : {}),
      };
    }
  }

  /**
   * Many studios hide vaulted cards from **consumer** JWT responses but return them for **staff** tokens.
   * Same `clientId` from OAuth — no extra PII exposure; staff creds stay server-side.
   */
  /** @type {{ attempted: boolean; staffHeadersAvailable: boolean; cciScoped: boolean }} */
  const staffProbe = { attempted: false, staffHeadersAvailable: false, cciScoped: false };

  /** @type {Record<string, unknown> | undefined} */
  let staffTokenIssueDbg;

  if (!cards.length) {
    const staffIssued = await getMindbodyStaffAccessTokenCached({ issueTimeoutMs: 8000 });
    if (dbg) {
      staffTokenIssueDbg = {
        issueOk: staffIssued.ok === true,
        fromCache: staffIssued.ok === true ? staffIssued.fromCache === true : undefined,
        errorCode: staffIssued.ok === false ? staffIssued.error : undefined,
      };
    }
    /** @type {Record<string, string> | null} */
    let sh = staffIssued.ok === true ? mindbodyStaffBearerHeaders(staffIssued.accessToken) : null;
    if (!sh) sh = mindbodyStaffApiHeaders();
    staffProbe.attempted = true;
    staffProbe.staffHeadersAvailable = !!sh;
    if (sh) {
      anyMbOk = true;
      const cciStaffQs = new URLSearchParams();
      cciStaffQs.set("request.clientId", String(clientId));
      const [rCciSt, rCliSt] = await Promise.all([
        fetchMb(
          "GET",
          `/public/v${v}/client/clientcompleteinfo?${cciStaffQs}`,
          sh,
          null,
          { timeoutMs: 15000 },
        ),
        fetchMb("GET", `/public/v${v}/client/clients?${q}`, sh, null, { timeoutMs: 15000 }),
      ]);
      pushDbg(`GET /public/v${v}/client/clientcompleteinfo?request.clientId=… (staff)`, "staff", rCciSt);
      pushDbg(`GET /public/v${v}/client/clients?clientIDs (staff)`, "staff", rCliSt);
      staffProbe.cciScoped = true;
      for (const payload of [rCciSt.ok ? rCciSt.data : null, rCliSt.ok ? rCliSt.data : null]) {
        if (payload) {
          const extracted = extractStoredCardsFromMindbodyPayload(payload);
          if (extracted.length) {
            return {
              cards: extracted,
              cciOk: !!r.ok,
              cciHttpStatus: r.status,
              cciBody: r.data,
              anyMindbodyRequestSucceeded: true,
              staffWalletProbe: staffProbe,
              ...(dbg
                ? { walletDebug: walletDbgPayload({ staffTokenIssue: staffTokenIssueDbg }) }
                : {}),
            };
          }
        }
      }
      const fieldQueries = [
        "Clients.ClientCreditCard",
        "clients.clientcreditcard",
        "Clients.ClientCreditCards",
      ];
      const rsSt = await Promise.all(
        fieldQueries.map((fields) => {
          const qp = new URLSearchParams(q);
          qp.set("request.Fields", fields);
          return fetchMb("GET", `/public/v${v}/client/clients?${qp}`, sh, null, { timeoutMs: 15000 });
        }),
      );
      fieldQueries.forEach((fields, i) => {
        pushDbg(`GET /public/v${v}/client/clients?Fields=${fields} (staff)`, "staff", rsSt[i]);
      });
      for (const rx of rsSt) {
        if (rx.ok) anyMbOk = true;
      }
      /** @type {Map<number, { id: number; lastFour: string; cardType: string }>} */
      const staffMerged = new Map();
      for (const rx of rsSt) {
        if (rx.ok) {
          for (const c of extractStoredCardsFromMindbodyPayload(rx.data)) staffMerged.set(c.id, c);
        }
      }
      cards = [...staffMerged.values()].sort((a, b) => a.id - b.id);
      if (cards.length) {
        return {
          cards,
          cciOk: !!r.ok,
          cciHttpStatus: r.status,
          cciBody: r.data,
          anyMindbodyRequestSucceeded: true,
          staffWalletProbe: staffProbe,
          ...(dbg
            ? { walletDebug: walletDbgPayload({ staffTokenIssue: staffTokenIssueDbg }) }
            : {}),
        };
      }
    }
  }

  return {
    cards,
    cciOk: !!r.ok,
    cciHttpStatus: r.status,
    cciBody: r.data,
    anyMindbodyRequestSucceeded: anyMbOk,
    staffWalletProbe: staffProbe,
    ...(dbg ? { walletDebug: walletDbgPayload({ staffTokenIssue: staffTokenIssueDbg }) } : {}),
  };
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
 * @param {Array<Record<string, unknown>> | null | undefined} [resolutionTrace] When provided, append safe resolution steps (no tokens/PII).
 */
export async function tryResolveClientId(session, email, authHeaders, accessToken, resolutionTrace) {
  const v = MB_API_VERSION;
  const trace = Array.isArray(resolutionTrace);

  async function verifyClientId(candidate) {
    if (candidate == null || !Number.isFinite(Number(candidate)) || Number(candidate) <= 0) {
      if (trace) resolutionTrace.push({ step: "verify_skip", reason: "invalid_candidate" });
      return null;
    }
    const id = Number(candidate);
    const q = new URLSearchParams();
    q.set("request.clientIDs", String(id));
    q.set("request.limit", "5");
    const r = await fetchMb("GET", `/public/v${v}/client/clients?${q}`, authHeaders, null);
    if (trace) {
      resolutionTrace.push({
        step: "verify_clients_by_id",
        candidateId: id,
        httpStatus: r.status,
        responseOk: r.ok,
        matchedRows: r.ok ? clientsList(r.data).length : 0,
      });
    }
    if (r.ok && clientsList(r.data).length) return id;
    return null;
  }

  if (typeof accessToken === "string" && accessToken.includes(".")) {
    if (trace) resolutionTrace.push({ step: "try_jwt_claims" });
    const atClaims = decodeJwtPayload(accessToken);
    let tid = pickMindbodyClientId(atClaims);
    if (tid == null) tid = scanMindbodyClientIdFromClaims(atClaims);
    if (trace) resolutionTrace.push({ step: "jwt_candidate_client_id", candidateId: tid ?? null });
    const verified = await verifyClientId(tid);
    if (verified != null) {
      if (trace) resolutionTrace.push({ step: "resolved", via: "jwt_access_token", clientId: verified });
      return verified;
    }
  }

  let clientId = null;
  const rawSid = session.client_id;
  if (typeof rawSid === "number" && rawSid > 0) clientId = rawSid;
  else if (typeof rawSid === "string" && /^\d+$/.test(rawSid.trim())) {
    const n = parseInt(rawSid.trim(), 10);
    if (n > 0) clientId = n;
  }

  if (clientId != null) {
    if (trace) resolutionTrace.push({ step: "try_session_client_id", candidateId: clientId });
    const verified = await verifyClientId(clientId);
    if (verified != null) {
      if (trace) resolutionTrace.push({ step: "resolved", via: "session_client_id", clientId: verified });
      return verified;
    }
  }

  {
    if (trace) resolutionTrace.push({ step: "fetch_clientcompleteinfo_for_id_extraction" });
    const r = await fetchMb("GET", `/public/v${v}/client/clientcompleteinfo`, authHeaders, null);
    if (trace) {
      resolutionTrace.push({
        step: "clientcompleteinfo_resolution_fetch",
        httpStatus: r.status,
        responseOk: r.ok,
      });
    }
    if (r.ok && r.data && typeof r.data === "object") {
      const cid = extractClientIdFromCompleteInfoPayload(r.data);
      if (trace) resolutionTrace.push({ step: "cci_extracted_client_id", candidateId: cid ?? null });
      if (cid != null) {
        const verified = await verifyClientId(cid);
        if (verified != null) {
          if (trace) resolutionTrace.push({ step: "resolved", via: "clientcompleteinfo_payload", clientId: verified });
          return verified;
        }
      }
    }
  }

  if (email) {
    if (trace) resolutionTrace.push({ step: "search_clients_by_email", hasEmail: true });
    const q = new URLSearchParams();
    q.set("request.searchText", email.trim());
    q.set("request.limit", "100");
    const r = await fetchMb("GET", `/public/v${v}/client/clients?${q}`, authHeaders, null);
    if (r.ok) {
      const list = clientsList(r.data);
      if (trace) resolutionTrace.push({ step: "email_search_result_rows", count: list.length });
      const c = pickClientByEmail(list, email);
      let candidate =
        c != null ? (c.Id ?? c.id) : list.length === 1 ? (/** @type {Record<string, unknown>} */ (list[0]).Id ?? /** @type {Record<string, unknown>} */ (list[0]).id) : null;
      if (candidate != null && Number.isFinite(Number(candidate))) {
        const verified = await verifyClientId(Number(candidate));
        if (verified != null) {
          if (trace) resolutionTrace.push({ step: "resolved", via: "email_search", clientId: verified });
          return verified;
        }
      }
    } else if (trace) {
      resolutionTrace.push({ step: "email_search_failed", httpStatus: r.status });
    }
  }

  const name = typeof session.name === "string" ? session.name.trim() : "";
  if (name.length >= 2) {
    if (trace) resolutionTrace.push({ step: "search_clients_by_name", nameLength: name.length });
    const q = new URLSearchParams();
    q.set("request.searchText", name);
    q.set("request.limit", "100");
    const r = await fetchMb("GET", `/public/v${v}/client/clients?${q}`, authHeaders, null);
    if (r.ok) {
      const list = clientsList(r.data);
      if (trace) resolutionTrace.push({ step: "name_search_result_rows", count: list.length });
      const c = email ? pickClientByEmail(list, email) : null;
      let candidate =
        c != null
          ? (c.Id ?? c.id)
          : list.length === 1
            ? (/** @type {Record<string, unknown>} */ (list[0]).Id ?? /** @type {Record<string, unknown>} */ (list[0]).id)
            : null;
      if (candidate != null && Number.isFinite(Number(candidate))) {
        const verified = await verifyClientId(Number(candidate));
        if (verified != null) {
          if (trace) resolutionTrace.push({ step: "resolved", via: "name_search", clientId: verified });
          return verified;
        }
      }
    } else if (trace) {
      resolutionTrace.push({ step: "name_search_failed", httpStatus: r.status });
    }
  }

  if (trace) resolutionTrace.push({ step: "failed", reason: "no_resolvable_client_id" });
  return null;
}

/**
 * Cookie session + refresh token → consumer headers (`consumer-identity-token`), then resolve Mindbody `clientId`.
 * @param {import('@netlify/functions').HandlerEvent} event
 * @param {{ walletDebug?: boolean }} [options]
 * @returns {Promise<{ ok: true, session: Record<string, unknown>, email: string | null, authHeaders: Record<string,string>, clientId: number, setCookie?: string, clientResolution?: { steps: Record<string, unknown>[] } } | { ok: false, response: import('@netlify/functions').HandlerResponse }>}
 */
export async function resolveConsumerClient(event, options) {
  const a = await getSessionWithConsumerHeaders(event);
  if (!a.ok) return a;
  const cookieHeaders = a.setCookie ? { "Set-Cookie": a.setCookie } : {};
  const wantTrace = options?.walletDebug === true;
  /**
   * Trace is now always populated (cheap: a few small objects). When resolution
   * succeeds we drop it; when it fails we emit a single warn log with the steps,
   * so the next "Booking failed." has a full breadcrumb trail (which strategy
   * was tried, what Mindbody returned, where the chain broke).
   */
  /** @type {Record<string, unknown>[]} */
  const resolutionSteps = [];
  const clientId = await tryResolveClientId(
    a.session,
    a.email,
    a.authHeaders,
    a.accessToken,
    resolutionSteps,
  );
  if (clientId == null) {
    const sessionAtRaw = a.session.at;
    const sessionAtMs = typeof sessionAtRaw === "number" && Number.isFinite(sessionAtRaw) ? sessionAtRaw : null;
    console.warn(
      JSON.stringify({
        event: "consumer_resolve_client_not_linked",
        email: a.email,
        sessionAtMs,
        sessionAgeMs: sessionAtMs != null ? Date.now() - sessionAtMs : null,
        sessionClientIdRaw: a.session.client_id ?? null,
        hasName: typeof a.session.name === "string" && a.session.name.length > 0,
        sub: typeof a.session.sub === "string" ? a.session.sub : null,
        resolutionSteps,
      }),
    );
    return {
      ok: false,
      response: jsonResponse(
        400,
        {
          ok: false,
          error: "client_not_linked",
          ...(wantTrace
            ? { clientResolution: { steps: resolutionSteps }, walletDebugEnabled: true }
            : {}),
        },
        cookieHeaders,
      ),
    };
  }
  return {
    ok: true,
    session: a.session,
    email: a.email,
    authHeaders: a.authHeaders,
    clientId,
    setCookie: a.setCookie,
    ...(wantTrace ? { clientResolution: { steps: resolutionSteps } } : {}),
  };
}
