/**
 * Stripe → Mindbody sync helpers.
 *
 * Customers pay in Stripe. We then:
 *  1. Resolve or create a Mindbody client from Stripe customer details (no duplicates).
 *  2. POST /sale/checkoutshoppingcart with `Type: "Service"` (one-time package) and the
 *     Mindbody **custom** payment method named via MINDBODY_STRIPE_PAYMENT_METHOD_NAME
 *     (default "Stripe"). The customer is NOT charged again — Mindbody just records the sale
 *     against that payment method, with a PayNotes referencing the Stripe order.
 *
 * Decisions: docs/STRIPE-MINDBODY-QUESTIONS.md
 *  • Q1 — accounting: A (custom payment type "Stripe"), no silent comp fallback.
 *  • Q3 — NCS duplicate policy: A (block_before_checkout_if_known; manual_review otherwise).
 *
 * Inspection finding: one-time packages are `Type: "Service"`, identified by the Pricing Option
 * `Id` from `GET /public/v6/sale/services?SellOnline=true`. See `mindbody-sale-checkout.mjs`.
 *
 * Recurring memberships go through `mindbody-sale-purchase-contract.mjs` and are NOT in scope
 * for this module.
 */

import {
  MB_API_VERSION,
  fetchMb,
  getMindbodyStaffAccessTokenCached,
  mindbodyCheckoutTimeoutMs,
} from "./mindbody-consumer-lib.mjs";
import {
  mindbodyHeaders,
  mindbodyHost,
  mindbodyStaffApiHeaders,
  mindbodyStaffBearerHeaders,
} from "./mindbody-upstream.mjs";

const NCS_HISTORY_KEYWORDS = [
  "new client",
  "first time",
  "intro",
  "trial",
  "3 class",
  "3 pack",
  "triple",
];

/* -------------------------------------------------------------------------- */
/* Staff auth                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * @returns {Promise<{ ok: true; headers: Record<string, string>; mode: "issue_cached_or_fresh" | "static_env_token" } | { ok: false; error: string; status?: number }>}
 */
async function staffHeadersForSync() {
  const staffUser = process.env.MINDBODY_STAFF_USERNAME?.trim();
  const staffPass = process.env.MINDBODY_STAFF_PASSWORD;
  const hasIssueCreds = Boolean(staffUser && typeof staffPass === "string" && staffPass !== "");
  if (hasIssueCreds) {
    const issued = await getMindbodyStaffAccessTokenCached();
    if (!issued.ok) {
      return { ok: false, error: issued.error, status: issued.status };
    }
    const h = mindbodyStaffBearerHeaders(issued.accessToken);
    if (!h) return { ok: false, error: "staff_headers_unavailable" };
    return { ok: true, headers: h, mode: "issue_cached_or_fresh" };
  }
  const h = mindbodyStaffApiHeaders();
  if (!h) {
    return {
      ok: false,
      error: "staff_credentials_not_configured",
    };
  }
  return { ok: true, headers: h, mode: "static_env_token" };
}

/* -------------------------------------------------------------------------- */
/* Misc helpers                                                               */
/* -------------------------------------------------------------------------- */

/** @param {unknown} data */
function clientsArrayFromPayload(data) {
  if (!data || typeof data !== "object") return [];
  const d = /** @type {Record<string, unknown>} */ (data);
  if (Array.isArray(d.Clients)) return d.Clients;
  if (Array.isArray(d.clients)) return d.clients;
  const pag = d.PaginationResponse ?? d.pagination_response ?? d.Pagination;
  if (pag && typeof pag === "object") {
    const p = /** @type {Record<string, unknown>} */ (pag);
    if (Array.isArray(p.Clients)) return p.Clients;
    if (Array.isArray(p.clients)) return p.clients;
  }
  return [];
}

/** @param {unknown} fullName */
export function splitFullName(fullName) {
  const s = typeof fullName === "string" ? fullName.trim() : "";
  if (!s) return { first: "", last: "" };
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return { first: parts[0], last: "" };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

/** @param {unknown} v */
function asString(v) {
  if (v == null) return "";
  return typeof v === "string" ? v : String(v);
}

/** @param {Record<string, unknown>} row */
function clientIdFromRow(row) {
  const id = row.Id ?? row.id ?? row.ClientId ?? row.clientId;
  if (id != null && Number.isFinite(Number(id)) && Number(id) > 0) return Number(id);
  return null;
}

/** @param {Record<string, unknown>} row */
function emailFromRow(row) {
  const e = row.Email ?? row.email;
  if (typeof e !== "string") return "";
  return e.trim().toLowerCase();
}

/** @param {Record<string, unknown>} row */
function activeFromRow(row) {
  const a = row.Active ?? row.active ?? row.IsActive ?? row.isActive;
  if (a === true) return true;
  if (a === false) return false;
  return null;
}

/** @param {string} phone */
function digitsOnly(phone) {
  return String(phone || "").replace(/\D/g, "");
}

/** Mindbody error message extraction (mirrors mindbody-client-register.mjs). */
function mindbodyErrorMessage(data) {
  if (!data || typeof data !== "object") return null;
  const d = /** @type {Record<string, unknown>} */ (data);
  const mbErr = d.Error;
  if (mbErr && typeof mbErr === "object") {
    const m = /** @type {{ Message?: unknown }} */ (mbErr).Message;
    if (typeof m === "string" && m.trim()) return m.trim();
  }
  if (typeof d.Message === "string" && d.Message.trim()) return d.Message.trim();
  const errs = d.Errors ?? d.errors;
  if (Array.isArray(errs)) {
    for (const raw of errs) {
      if (raw != null && typeof raw === "object") {
        const em = /** @type {{ Message?: unknown; Error?: unknown }} */ (raw);
        const s = em.Message ?? em.Error;
        if (typeof s === "string" && s.trim()) return s.trim();
      } else if (typeof raw === "string" && raw.trim()) return raw.trim();
    }
  }
  return null;
}

/**
 * Coerce a primitive value to a positive-integer string id, or null. Accepts numbers and
 * digit-only strings. Used by `shoppingSaleFingerprint` for both Sale ID and Transaction ID.
 *
 * @param {unknown} v
 * @returns {string | null}
 */
function coercePositiveIntId(v) {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return String(Math.trunc(v));
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return v.trim();
  return null;
}

/**
 * Extract Sale ID + Transaction ID from a Mindbody CheckoutShoppingCart success response.
 *
 * Mindbody's response shape varies between studio configurations and (rarely) between
 * Public API minor versions. Observed envelopes:
 *   • `{ ShoppingCart: { Id, ... } }`                          — most common
 *   • `{ Sale: { Id, ... } }`                                   — alt name
 *   • `{ ShoppingCart: { CartItems, Sale: { Id, ... } } }`     — nested Sale under cart
 *   • `{ shoppingCart: { id, ... } }`                          — camelCase variant
 *   • Top-level Sale ID directly on `r.data` for older sites
 *
 * Strategy: walk known parent keys first (preserve fast-path for the dominant case), then
 * fall back to a depth-bounded scan that finds any property whose key is exactly
 * `Id`/`SaleId`/`TransactionId` (case-insensitive variants). The scan caps at depth 6 and
 * stops at the first hit so it is O(response-size).
 *
 * Verified against:
 *   • Snir17 Drop-in single-class with WELCOME10 (Sale ID 11684).
 *   • Snir17 10-pack with AMARE20 (Sale ID 11685).
 *   • Snir17 NCS no-coupon (Sale ID 11683).
 *
 * @param {unknown} mb
 * @returns {{ saleId: string | null; transactionId: string | null }}
 */
function shoppingSaleFingerprint(mb) {
  if (!mb || typeof mb !== "object") return { saleId: null, transactionId: null };
  const root = /** @type {Record<string, unknown>} */ (mb);

  /** @param {Record<string, unknown>} o */
  function readFromObject(o) {
    const id = o.Id ?? o.id ?? o.SaleId ?? o.saleId ?? o.SaleID ?? o.saleID;
    const tx =
      o.TransactionId ??
      o.transactionId ??
      o.TransactionID ??
      o.transactionID ??
      o.PaymentRefNo ??
      o.paymentRefNo;
    return { saleId: coercePositiveIntId(id), transactionId: coercePositiveIntId(tx) };
  }

  /** Fast path — the dominant envelope shape. */
  for (const key of ["ShoppingCart", "Sale", "shoppingCart", "sale"]) {
    const seg = root[key];
    if (!seg || typeof seg !== "object") continue;
    const r = readFromObject(/** @type {Record<string, unknown>} */ (seg));
    if (r.saleId || r.transactionId) return r;
  }

  /** Fallback — depth-bounded recursive scan. Stops at first viable hit. */
  /** @type {string | null} */
  let foundSaleId = null;
  /** @type {string | null} */
  let foundTxId = null;
  /** @param {unknown} x @param {number} depth */
  function walk(x, depth) {
    if (foundSaleId && foundTxId) return;
    if (depth > 6 || x == null || typeof x !== "object") return;
    if (Array.isArray(x)) {
      for (const el of x) {
        walk(el, depth + 1);
        if (foundSaleId && foundTxId) return;
      }
      return;
    }
    const o = /** @type {Record<string, unknown>} */ (x);
    const r = readFromObject(o);
    if (!foundSaleId && r.saleId) foundSaleId = r.saleId;
    if (!foundTxId && r.transactionId) foundTxId = r.transactionId;
    if (foundSaleId && foundTxId) return;
    for (const v of Object.values(o)) {
      walk(v, depth + 1);
      if (foundSaleId && foundTxId) return;
    }
  }
  walk(root, 0);

  return { saleId: foundSaleId, transactionId: foundTxId };
}

/* -------------------------------------------------------------------------- */
/* Service-id resolution from /sale/services                                  */
/* -------------------------------------------------------------------------- */

/** @param {Record<string, unknown>} row */
function serviceIdFromRow(row) {
  const id = row.Id ?? row.ID ?? row.ServiceId ?? row.ServiceID;
  if (typeof id === "number" && Number.isFinite(id) && id > 0) return Math.trunc(id);
  if (typeof id === "string" && /^\d+$/.test(id.trim())) return parseInt(id.trim(), 10);
  return null;
}

/** @param {Record<string, unknown>} row */
function serviceNameFromRow(row) {
  const n = row.Name ?? row.name;
  return typeof n === "string" ? n.trim() : "";
}

/**
 * Walk `GET /sale/services?SellOnline=true` paginated to find the service id matching the
 * catalog row's name patterns. Used only when `mindbodyServiceId` isn't pinned in catalog.
 *
 * @param {{ nameMatchAny: string[]; nameMatchExclude: string[] }} match
 * @returns {Promise<{ id: number; name: string } | null>}
 */
async function resolveServiceIdByNameMatch(match) {
  const h = mindbodyHeaders();
  if (!h) return null;
  const limit = 200;
  for (let offset = 0; offset <= 4800; offset += limit) {
    const path = `/public/v${MB_API_VERSION}/sale/services?SellOnline=true&Limit=${limit}&Offset=${offset}`;
    const url = `https://${mindbodyHost()}${path}`;
    let res;
    try {
      res = await fetch(url, { method: "GET", headers: h });
    } catch {
      return null;
    }
    /** @type {unknown} */
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || typeof data !== "object") return null;
    const d = /** @type {Record<string, unknown>} */ (data);
    /** @type {unknown[]} */
    const rows = Array.isArray(d.Services)
      ? d.Services
      : Array.isArray(d.services)
        ? d.services
        : [];
    if (!rows.length) return null;
    for (const raw of rows) {
      if (!raw || typeof raw !== "object") continue;
      const r = /** @type {Record<string, unknown>} */ (raw);
      const id = serviceIdFromRow(r);
      if (id == null) continue;
      const name = serviceNameFromRow(r).toLowerCase();
      if (!name) continue;
      if (match.nameMatchExclude.some((bad) => bad && name.includes(bad))) continue;
      if (match.nameMatchAny.some((needle) => needle && name.includes(needle))) {
        return { id, name: serviceNameFromRow(r) };
      }
    }
    if (rows.length < limit) return null;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Mindbody client search / verify / create                                   */
/* -------------------------------------------------------------------------- */

/**
 * @param {Record<string, string>} headers
 * @param {number} clientId
 * @returns {Promise<Record<string, unknown> | null>}
 */
async function fetchClientById(headers, clientId, opts) {
  const q = new URLSearchParams();
  q.set("request.clientIDs", String(clientId));
  q.set("request.limit", "5");
  const fetchOpts = opts && typeof opts.timeoutMs === "number" ? { timeoutMs: opts.timeoutMs } : undefined;
  const r = await fetchMb(
    "GET",
    `/public/v${MB_API_VERSION}/client/clients?${q}`,
    headers,
    null,
    fetchOpts,
  );
  if (!r.ok) return null;
  const list = clientsArrayFromPayload(r.data);
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const row = /** @type {Record<string, unknown>} */ (raw);
    if (clientIdFromRow(row) === clientId) return row;
  }
  return null;
}

/**
 * Read-only contact lookup used by `stripe-create-checkout-session.mjs` to prefill the
 * Stripe Checkout page for logged-in Mindbody members. Returns null on any miss so callers
 * can fall back to anonymous checkout without surfacing an error to the buyer.
 *
 * @param {Record<string, string>} headers Mindbody staff headers (Bearer or API-key)
 * @param {number} clientId
 * @param {{ timeoutMs?: number }} [opts] Optional hard cap on the upstream call
 * @returns {Promise<{ email: string; firstName: string; lastName: string; phone: string; fullName: string } | null>}
 */
export async function fetchMindbodyClientContact(headers, clientId, opts) {
  if (!Number.isFinite(clientId) || clientId <= 0) return null;
  const row = await fetchClientById(headers, Math.trunc(clientId), opts);
  if (!row || typeof row !== "object") return null;
  const email = emailFromRow(row);
  const o = /** @type {Record<string, unknown>} */ (row);
  const firstName = typeof o.FirstName === "string" ? o.FirstName.trim() : "";
  const lastName = typeof o.LastName === "string" ? o.LastName.trim() : "";
  /**
   * Try the standard Mindbody phone fields in order of preference (Mindbody returns whichever
   * the client has on file). MobilePhone is most useful for SMS later if we add that.
   */
  let phone = "";
  for (const k of ["MobilePhone", "HomePhone", "WorkPhone", "Phone"]) {
    const v = /** @type {Record<string, unknown>} */ (o)[k];
    if (typeof v === "string" && v.trim()) {
      phone = v.trim();
      break;
    }
  }
  const fullName = `${firstName} ${lastName}`.trim();
  return { email, firstName, lastName, phone, fullName };
}

/**
 * Resolve a Mindbody clientId from a session-derived email. Used when the browser cookie
 * holds the OAuth identity (email/sub) but the numeric clientId was never persisted there.
 *
 * Returns the id only when the search yields a single confident email match — multiple-match
 * or no-match cases return null so the caller falls back to anonymous checkout (the post-
 * payment webhook still does its own duplicate-tolerant resolve/create).
 *
 * @param {Record<string, string>} headers Mindbody staff headers
 * @param {string} email
 * @param {{ timeoutMs?: number }} [opts] Optional hard cap on the upstream call
 * @returns {Promise<number | null>}
 */
export async function fetchClientIdByEmail(headers, email, opts) {
  const target = (email || "").trim().toLowerCase();
  if (!target) return null;
  const list = await searchClientsByEmail(headers, target, opts);
  if (list.length !== 1) return null;
  const id = clientIdFromRow(list[0]);
  return Number.isFinite(id) && id > 0 ? id : null;
}

/**
 * @param {Record<string, string>} headers
 * @param {string} email
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function searchClientsByEmail(headers, email, opts) {
  if (!email) return [];
  const q = new URLSearchParams();
  q.set("request.searchText", email);
  q.set("request.limit", "100");
  const fetchOpts = opts && typeof opts.timeoutMs === "number" ? { timeoutMs: opts.timeoutMs } : undefined;
  const r = await fetchMb(
    "GET",
    `/public/v${MB_API_VERSION}/client/clients?${q}`,
    headers,
    null,
    fetchOpts,
  );
  if (!r.ok) return [];
  const list = clientsArrayFromPayload(r.data);
  /** @type {Record<string, unknown>[]} */
  const out = [];
  const target = email.trim().toLowerCase();
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const row = /** @type {Record<string, unknown>} */ (raw);
    if (emailFromRow(row) === target) out.push(row);
  }
  return out;
}

/**
 * Decide which client (from a same-email match list) is the canonical one.
 * Returns `null` when ambiguous so the caller can mark `manual_review`.
 *
 * @param {Record<string, unknown>[]} clients
 * @param {{ email: string; phone: string }} hint
 */
export function pickCanonicalClient(clients, hint) {
  if (clients.length === 0) return { kind: /** @type {const} */ ("none") };
  if (clients.length === 1) {
    return { kind: /** @type {const} */ ("one"), client: clients[0] };
  }
  const phoneDigits = digitsOnly(hint.phone).slice(-10);
  /** @type {Record<string, unknown>[]} */
  const phoneMatches = phoneDigits
    ? clients.filter((c) => {
        const o = /** @type {Record<string, unknown>} */ (c);
        const candidates = [o.MobilePhone, o.HomePhone, o.WorkPhone, o.Phone, o.mobilePhone];
        for (const raw of candidates) {
          const d = digitsOnly(asString(raw)).slice(-10);
          if (d && d === phoneDigits) return true;
        }
        return false;
      })
    : [];
  if (phoneMatches.length === 1) return { kind: /** @type {const} */ ("one"), client: phoneMatches[0] };

  /** @type {Record<string, unknown>[]} */
  const activeOnes = clients.filter((c) => activeFromRow(/** @type {Record<string, unknown>} */ (c)) === true);
  if (activeOnes.length === 1) return { kind: /** @type {const} */ ("one"), client: activeOnes[0] };

  return { kind: /** @type {const} */ ("ambiguous"), count: clients.length };
}

/**
 * Staff directory search by arbitrary text (name, etc.). Caller must apply strict
 * cardinality rules — Mindbody fuzzy search can return many rows.
 *
 * @param {Record<string, string>} headers
 * @param {string} searchText
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function searchClientsBySearchText(headers, searchText, opts) {
  const q = (searchText || "").trim();
  if (!q) return [];
  const params = new URLSearchParams();
  params.set("request.searchText", q);
  params.set("request.limit", "100");
  const fetchOpts = opts && typeof opts.timeoutMs === "number" ? { timeoutMs: opts.timeoutMs } : undefined;
  const r = await fetchMb(
    "GET",
    `/public/v${MB_API_VERSION}/client/clients?${params}`,
    headers,
    null,
    fetchOpts,
  );
  if (!r.ok) return [];
  return clientsArrayFromPayload(r.data);
}

/**
 * Stripe-grade lookup before OAuth `addclient`: email via `pickCanonicalClient`, then
 * unique name match only when the directory returns exactly one row.
 *
 * @param {Record<string, string>} staffHeaders
 * @param {{ email: string; firstName: string; lastName: string; mobilePhone?: string }} profile
 * @returns {Promise<
 *   | { ok: true; clientId: number; via: "email_unique" | "email_phone_unique" | "name_unique"; created: false }
 *   | { ok: false; reason: "multiple_client_matches"; candidateCount: number }
 *   | { ok: false; reason: "not_found" | "apple_relay_email" }
 * >}
 */
export async function resolveExistingStudioClientForOAuth(staffHeaders, profile) {
  const email = (profile.email || "").trim().toLowerCase();
  const phone = (profile.mobilePhone || "").trim();

  if (email && /@privaterelay\.appleid\.com$/i.test(email)) {
    return { ok: false, reason: "apple_relay_email" };
  }

  if (email && email.includes("@")) {
    const matches = await searchClientsByEmail(staffHeaders, email);
    const pick = pickCanonicalClient(matches, { email, phone });
    if (pick.kind === "one") {
      const id = clientIdFromRow(/** @type {Record<string, unknown>} */ (pick.client));
      if (id != null) {
        return {
          ok: true,
          clientId: id,
          via: phone ? "email_phone_unique" : "email_unique",
          created: false,
        };
      }
    }
    if (pick.kind === "ambiguous") {
      return { ok: false, reason: "multiple_client_matches", candidateCount: pick.count };
    }
  }

  const fullName = [profile.firstName, profile.lastName]
    .map((s) => (s || "").trim())
    .filter(Boolean)
    .join(" ")
    .trim();
  if (fullName.length >= 2) {
    const nameRows = await searchClientsBySearchText(staffHeaders, fullName);
    if (nameRows.length === 1) {
      const row = /** @type {Record<string, unknown>} */ (nameRows[0]);
      const rowEmail = emailFromRow(row);
      if (!email || !rowEmail || rowEmail === email) {
        const id = clientIdFromRow(row);
        if (id != null) {
          return { ok: true, clientId: id, via: "name_unique", created: false };
        }
      }
    }
  }

  return { ok: false, reason: "not_found" };
}

/**
 * Create a Mindbody client. Reuses the same `addclient` shape (nested + flat fallback) used by
 * `mindbody-client-register.mjs`.
 *
 * `mindbodyTest` controls the `Test` flag on the Mindbody payload — when true, Mindbody
 * validates the request without persisting a real client, used by the
 * `STRIPE_TEST_MODE_MINDBODY_BEHAVIOR=mindbody_test` mode.
 *
 * @param {Record<string, string>} headers
 * @param {{ firstName: string; lastName: string; email: string; mobilePhone: string }} input
 * @param {{ mindbodyTest?: boolean }} [opts]
 * @returns {Promise<{ ok: true; clientId: number } | { ok: false; error: string; mindbody?: unknown; conflict?: boolean }>}
 */
async function addClient(headers, input, opts) {
  const isTest = opts?.mindbodyTest === true;
  const clientRow = {
    FirstName: input.firstName.slice(0, 80),
    LastName: input.lastName.slice(0, 80) || input.firstName.slice(0, 80) || "Client",
    Email: input.email,
    Active: true,
    ...(input.mobilePhone ? { MobilePhone: input.mobilePhone.slice(0, 32) } : {}),
  };
  const nested = {
    Client: clientRow,
    Test: isTest,
    SendAccountEmails: true,
    SendScheduleEmails: true,
    SendPromotionalEmails: false,
  };
  /** @type {Record<string, unknown>} */
  const flat = {
    ...clientRow,
    Test: isTest,
    SendAccountEmails: true,
    SendScheduleEmails: true,
    SendPromotionalEmails: false,
  };
  const path = `/public/v${MB_API_VERSION}/client/addclient`;
  const timeoutMs = Math.min(
    Math.max(parseInt(process.env.MINDBODY_ADD_CLIENT_TIMEOUT_MS || "20000", 10) || 20000, 8000),
    45000,
  );
  let r = await fetchMb("POST", path, headers, nested, { timeoutMs });
  if (!r.ok && r.status === 400) {
    r = await fetchMb("POST", path, headers, flat, { timeoutMs });
  }
  if (!r.ok) {
    const detail = mindbodyErrorMessage(r.data);
    /**
     * Mindbody enforces uniqueness on email AND (depending on Site Settings) phone. Either
     * collision should route us to the duplicate-resolution branch — NOT to a hard
     * `addclient_failed` — so we re-search by email and use the existing client. The regex
     * intentionally covers both vocabularies (Mindbody phrases vary across API versions).
     */
    const dup =
      typeof detail === "string" &&
      /(already\s+exist|duplicate|must\s+be\s+unique|(email|e-mail|phone|mobile).*(already|taken|in\s+use|registered|assigned|duplicate|exist))/i.test(
        detail,
      );
    return {
      ok: false,
      error: dup ? "client_email_already_exists" : "addclient_failed",
      mindbody: r.data,
      conflict: dup,
    };
  }
  /** @type {unknown} */
  const data = r.data;
  if (data && typeof data === "object") {
    const d = /** @type {Record<string, unknown>} */ (data);
    const c = d.Client ?? d.client;
    if (c && typeof c === "object") {
      const id = clientIdFromRow(/** @type {Record<string, unknown>} */ (c));
      if (id != null) return { ok: true, clientId: id };
    }
    const top = d.ClientId ?? d.clientId ?? d.Id;
    if (top != null && Number.isFinite(Number(top)) && Number(top) > 0) {
      return { ok: true, clientId: Number(top) };
    }
  }
  return { ok: false, error: "addclient_response_missing_id", mindbody: r.data };
}

/**
 * Ensure a Studio Client row exists for an OAuth sign-in (email-first, optional create).
 * Used when `MINDBODY_OAUTH_ENSURE_STUDIO_CLIENT=1` and email search returned zero rows.
 *
 * @param {Record<string, string>} staffHeaders
 * @param {{ email: string; firstName: string; lastName: string; mobilePhone?: string }} profile
 * @returns {Promise<
 *   | { ok: true; clientId: number; created: boolean; via?: string }
 *   | { ok: false; reason: string; candidateCount?: number }
 * >}
 */
export async function ensureStudioClientForOAuthProfile(staffHeaders, profile) {
  const email = (profile.email || "").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return { ok: false, reason: "missing_email" };
  }
  const firstName = (profile.firstName || "").trim();
  if (!firstName) {
    return { ok: false, reason: "missing_name" };
  }

  const existing = await resolveExistingStudioClientForOAuth(staffHeaders, profile);
  if (existing.ok) {
    return { ok: true, clientId: existing.clientId, created: false, via: existing.via };
  }
  if (existing.reason === "multiple_client_matches") {
    return {
      ok: false,
      reason: "multiple_client_matches",
      candidateCount: existing.candidateCount,
    };
  }
  if (existing.reason === "apple_relay_email") {
    return { ok: false, reason: "apple_relay_email" };
  }

  const created = await addClient(staffHeaders, {
    firstName,
    lastName: (profile.lastName || "").trim() || firstName,
    email,
    mobilePhone: profile.mobilePhone || "",
  });
  if (created.ok) {
    return { ok: true, clientId: created.clientId, created: true };
  }
  if (created.conflict) {
    const again = await resolveExistingStudioClientForOAuth(staffHeaders, profile);
    if (again.ok) {
      return { ok: true, clientId: again.clientId, created: false, via: again.via };
    }
    if (again.reason === "multiple_client_matches") {
      return {
        ok: false,
        reason: "multiple_client_matches",
        candidateCount: again.candidateCount,
      };
    }
  }
  return { ok: false, reason: created.error || "addclient_failed" };
}

/* -------------------------------------------------------------------------- */
/* Auto-merge duplicate Studio Clients after OAuth                            */
/* -------------------------------------------------------------------------- */

/**
 * Wrap Mindbody's native `POST /client/mergeclients`. Source data (services, visits,
 * contracts, purchase history) is transferred into Target; Source is consumed by
 * Mindbody. Mindbody handles all the accounting/history correctly — no Comp transactions,
 * no manual cleanup.
 *
 * Reference: Mindbody Public API V6 — `client/mergeclients` endpoint.
 *
 * Safety rails:
 *  • Reject when source/target ids are not positive integers.
 *  • Reject when source === target (Mindbody would error too — fail fast for clarity).
 *  • Hard 15s upstream timeout; the OAuth callback further wraps this in a 12s race so
 *    a slow merge never blocks user sign-in indefinitely.
 *
 * @param {Record<string, string>} headers Staff headers (Bearer or static API-Key).
 * @param {{ sourceClientId: number; targetClientId: number }} input
 * @returns {Promise<{ ok: true } | { ok: false; error: string; status?: number; mindbody?: unknown }>}
 */
async function mergeMindbodyClients(headers, input) {
  if (!Number.isFinite(input.sourceClientId) || input.sourceClientId <= 0) {
    return { ok: false, error: "invalid_source_client_id" };
  }
  if (!Number.isFinite(input.targetClientId) || input.targetClientId <= 0) {
    return { ok: false, error: "invalid_target_client_id" };
  }
  if (input.sourceClientId === input.targetClientId) {
    return { ok: false, error: "source_equals_target" };
  }
  const path = `/public/v${MB_API_VERSION}/client/mergeclients`;
  const body = {
    SourceClientId: input.sourceClientId,
    TargetClientId: input.targetClientId,
  };
  const r = await fetchMb("POST", path, headers, body, { timeoutMs: 15000 });
  if (!r.ok) {
    return {
      ok: false,
      error: "mindbody_merge_rejected",
      status: r.status,
      mindbody: r.data,
    };
  }
  return { ok: true };
}

/**
 * After the OAuth callback we know the user's signed-in `clientId` (Identity-bound) and
 * their email. Find any **other** Studio Clients in this site with the same email and merge
 * them INTO the signed-in client. The signed-in client is always the merge **target** (kept)
 * because it is the canonical record from Mindbody Identity — the one the user will resolve
 * to on every future login.
 *
 * Typical scenario this fixes:
 *  1. Anonymous Stripe purchase → addclient creates Studio Client A (with package),
 *     not yet linked to Mindbody Identity.
 *  2. User clicks "Sign in & book a class" → OAuth Identity creates Studio Client B
 *     (Identity-linked, empty).
 *  3. Identity returns clientId=B. We merge A→B so the package is on B.
 *  4. User lands on /classes — wallet shows the package immediately.
 *
 * Failure handling:
 *  • Returns `ok: true` with per-source results so the caller can log granular outcomes.
 *  • The caller (OAuth callback) should NEVER fail sign-in if this returns `ok: false` or
 *    throws. Worst case the user sees an empty wallet briefly; the next sign-in retries.
 *  • Idempotent: once a source is merged Mindbody removes it, so a re-run finds nothing to do.
 *
 * @param {{ sessionClientId: number; email: string; timeoutMs?: number }} input
 * @returns {Promise<
 *   | { ok: true; merged: number[]; skipped: { id: number; reason: string }[]; failed: { id: number; error: string }[] }
 *   | { ok: false; reason: string; message?: string }
 * >}
 */
export async function autoMergeDuplicatesByEmail(input) {
  const sessionClientId = Number(input.sessionClientId);
  const email = (input.email || "").trim().toLowerCase();
  if (!Number.isFinite(sessionClientId) || sessionClientId <= 0) {
    return { ok: false, reason: "invalid_session_client_id" };
  }
  if (!email || !email.includes("@")) {
    return { ok: false, reason: "invalid_email" };
  }

  const staff = await staffHeadersForSync();
  if (!staff.ok) {
    return { ok: false, reason: staff.error };
  }

  const searchTimeoutMs = typeof input.timeoutMs === "number" ? input.timeoutMs : 8000;
  const matches = await searchClientsByEmail(staff.headers, email, { timeoutMs: searchTimeoutMs });

  /**
   * Surface the raw match list in the production logs. Without this we cannot tell
   * whether `merged: []` means "no duplicates exist" vs "the public API search did not
   * return them" (e.g., wrong email casing, search index lag, or a Mindbody-side filter
   * we did not anticipate).
   */
  console.log(
    JSON.stringify({
      event: "stripe_auto_merge_search_results",
      sessionClientId,
      email,
      matchCount: matches.length,
      matchIds: matches
        .map((row) => clientIdFromRow(/** @type {Record<string, unknown>} */ (row)))
        .filter((id) => id != null),
    }),
  );

  /** @type {number[]} */
  const merged = [];
  /** @type {{ id: number; reason: string }[]} */
  const skipped = [];
  /** @type {{ id: number; error: string }[]} */
  const failed = [];

  for (const row of matches) {
    const id = clientIdFromRow(/** @type {Record<string, unknown>} */ (row));
    if (id == null) {
      skipped.push({ id: 0, reason: "missing_id_in_row" });
      continue;
    }
    if (id === sessionClientId) {
      /**
       * The session client is the merge **target** — it must always be preserved.
       * Mindbody's mergeclients API would reject source===target anyway, but we skip
       * here for clarity and to keep the result counters honest.
       */
      skipped.push({ id, reason: "is_session_client_target" });
      continue;
    }
    const r = await mergeMindbodyClients(staff.headers, {
      sourceClientId: id,
      targetClientId: sessionClientId,
    });
    if (r.ok) {
      merged.push(id);
    } else {
      failed.push({ id, error: r.error });
    }
  }

  return { ok: true, merged, skipped, failed };
}

/* -------------------------------------------------------------------------- */
/* Password setup email for newly created clients                             */
/* -------------------------------------------------------------------------- */

/**
 * Trigger the Mindbody "set your password" email to a brand-new client. After this email is
 * delivered the client clicks the link, sets a password, and can log into Mindbody (their email
 * is the username — confirmed in Mindbody's API docs). Without this step, an anonymous Stripe
 * buyer would have a Mindbody account they cannot sign into to book classes.
 *
 * Best-effort: failure here MUST NOT roll back the order. The package was already added; the
 * customer can hit "Forgot password?" themselves later. The webhook records the result on the
 * order so a staff member can re-trigger via the admin endpoint if needed.
 *
 * @param {Record<string, string>} headers
 * @param {{ email: string; firstName: string; lastName: string }} input
 * @returns {Promise<{ ok: true } | { ok: false; error: string; status?: number; mindbody?: unknown }>}
 */
export async function sendNewClientPasswordSetupEmail(headers, input) {
  const email = (input.email || "").trim();
  const firstName = (input.firstName || "").trim();
  const lastName = (input.lastName || firstName).trim();
  if (!email || !firstName) {
    return { ok: false, error: "missing_required_fields_for_password_email" };
  }
  /**
   * Mindbody requires UserEmail + UserFirstName + UserLastName. Email is also the username.
   * Reference: SendPasswordResetEmailRequest model — public/v6 path.
   */
  const body = {
    UserEmail: email,
    UserFirstName: firstName.slice(0, 80),
    UserLastName: lastName.slice(0, 80) || firstName.slice(0, 80),
  };
  const path = `/public/v${MB_API_VERSION}/client/sendpasswordresetemail`;
  const r = await fetchMb("POST", path, headers, body, { timeoutMs: 12000 });
  if (!r.ok) {
    return {
      ok: false,
      error: "send_password_reset_failed",
      status: r.status,
      mindbody: r.data,
    };
  }
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* NCS history                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Best-effort: does this client have any prior visits or purchases that look like a New Client
 * Special pricing option? We treat ANY history matching the configured keywords as "yes".
 *
 * Returns:
 *  • { ok: true, hadNcs: boolean, evidence: string[] }
 *  • { ok: false, error: string }   (we couldn't query history confidently)
 *
 * @param {Record<string, string>} headers
 * @param {number} clientId
 */
export async function fetchClientNcsHistory(headers, clientId) {
  /** @type {string[]} */
  const evidence = [];
  let anyOk = false;
  let hadNcs = false;

  /** @param {string} text */
  const matches = (text) => {
    const t = text.toLowerCase();
    return NCS_HISTORY_KEYWORDS.some((kw) => t.includes(kw));
  };

  /** @type {URLSearchParams} */
  const purchasesQs = new URLSearchParams();
  purchasesQs.set("request.clientId", String(clientId));
  purchasesQs.set("request.limit", "200");
  const purchases = await fetchMb(
    "GET",
    `/public/v${MB_API_VERSION}/client/clientpurchases?${purchasesQs}`,
    headers,
    null,
  );
  if (purchases.ok && purchases.data && typeof purchases.data === "object") {
    anyOk = true;
    const d = /** @type {Record<string, unknown>} */ (purchases.data);
    /** @type {unknown[]} */
    const rows = Array.isArray(d.Purchases)
      ? d.Purchases
      : Array.isArray(d.purchases)
        ? d.purchases
        : [];
    for (const raw of rows) {
      if (!raw || typeof raw !== "object") continue;
      const r = /** @type {Record<string, unknown>} */ (raw);
      const name = asString(r.Name ?? r.Description ?? r.ProductName);
      if (name && matches(name)) {
        hadNcs = true;
        evidence.push(`purchase:${name.slice(0, 80)}`);
      }
    }
  }

  if (!hadNcs) {
    const servicesQs = new URLSearchParams();
    servicesQs.set("request.clientId", String(clientId));
    servicesQs.set("request.limit", "200");
    const services = await fetchMb(
      "GET",
      `/public/v${MB_API_VERSION}/client/clientservices?${servicesQs}`,
      headers,
      null,
    );
    if (services.ok && services.data && typeof services.data === "object") {
      anyOk = true;
      const d = /** @type {Record<string, unknown>} */ (services.data);
      /** @type {unknown[]} */
      const rows = Array.isArray(d.ClientServices)
        ? d.ClientServices
        : Array.isArray(d.clientServices)
          ? d.clientServices
          : [];
      for (const raw of rows) {
        if (!raw || typeof raw !== "object") continue;
        const r = /** @type {Record<string, unknown>} */ (raw);
        const name = asString(r.Name ?? r.ServiceName ?? r.Description);
        if (name && matches(name)) {
          hadNcs = true;
          evidence.push(`service:${name.slice(0, 80)}`);
        }
      }
    }
  }

  if (!anyOk) return { ok: /** @type {const} */ (false), error: "ncs_history_query_failed" };
  return { ok: /** @type {const} */ (true), hadNcs, evidence };
}

/* -------------------------------------------------------------------------- */
/* resolveOrCreateMindbodyClient                                              */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} ResolveInput
 * @property {number | null} knownMindbodyClientId
 * @property {string} email
 * @property {string} fullName Single-string name fallback (e.g., cardholder, Apple Pay, Link).
 * @property {string=} firstName Optional explicit first name (sourced from Stripe
 *   `custom_fields[first_name]`). When provided together with `lastName`, takes
 *   precedence over `splitFullName(fullName)` for the `addclient` payload — this is the
 *   path that gives Mindbody Identity the cleanest first+last+email signal for auto-link.
 * @property {string=} lastName Optional explicit last name (sourced from Stripe
 *   `custom_fields[last_name]`). See `firstName` above.
 * @property {string} phone
 * @property {boolean=} mindbodyTest When true, `addClient` is sent with Mindbody `Test: true`
 *   so the validation runs without persisting a real client. Used by the
 *   `STRIPE_TEST_MODE_MINDBODY_BEHAVIOR=mindbody_test` mode.
 */

/**
 * @typedef {Object} ResolveResult
 * @property {true} ok
 * @property {number} clientId
 * @property {"known_id_verified"|"email_unique"|"email_phone_unique"|"created"} via
 * @property {boolean} clientCreated
 * @property {string=} email
 */

/**
 * @typedef {Object} ResolveAmbiguous
 * @property {false} ok
 * @property {"multiple_client_matches"} reason
 * @property {number} candidateCount
 * @property {string} email
 */

/**
 * @typedef {Object} ResolveError
 * @property {false} ok
 * @property {string} reason
 * @property {string=} message
 * @property {boolean=} retryable
 * @property {unknown=} mindbody
 */

/**
 * @param {ResolveInput} input
 * @param {Record<string, string>} staffHeaders
 * @returns {Promise<ResolveResult | ResolveAmbiguous | ResolveError>}
 */
export async function resolveOrCreateMindbodyClient(input, staffHeaders) {
  const email = (input.email || "").trim().toLowerCase();
  const phone = digitsOnly(input.phone || "");
  /**
   * Prefer explicit `firstName` / `lastName` from Stripe `custom_fields` when both are
   * present. Falls back to `splitFullName(fullName)` for legacy callers and for
   * non-anonymous flows that don't collect custom fields. The fallback uses the brittle
   * single-string parse (whatever Apple Pay / Link / cardholder typed) as a last resort.
   */
  const explicitFirst = (input.firstName || "").trim();
  const explicitLast = (input.lastName || "").trim();
  const useExplicit = Boolean(explicitFirst) && Boolean(explicitLast);
  const { first: parsedFirst, last: parsedLast } = useExplicit
    ? { first: "", last: "" }
    : splitFullName(input.fullName);
  const first = useExplicit ? explicitFirst : parsedFirst;
  const last = useExplicit ? explicitLast : parsedLast;

  if (input.knownMindbodyClientId != null && Number(input.knownMindbodyClientId) > 0) {
    const row = await fetchClientById(staffHeaders, Number(input.knownMindbodyClientId));
    if (row) {
      const rowEmail = emailFromRow(row);
      if (!email || !rowEmail || rowEmail === email) {
        return {
          ok: true,
          clientId: Number(input.knownMindbodyClientId),
          via: "known_id_verified",
          clientCreated: false,
          email: rowEmail || email || undefined,
        };
      }
    }
  }

  if (email) {
    const matches = await searchClientsByEmail(staffHeaders, email);
    const pick = pickCanonicalClient(matches, { email, phone });
    if (pick.kind === "one") {
      const id = clientIdFromRow(/** @type {Record<string, unknown>} */ (pick.client));
      if (id != null) {
        return {
          ok: true,
          clientId: id,
          via: phone ? "email_phone_unique" : "email_unique",
          clientCreated: false,
          email,
        };
      }
    } else if (pick.kind === "ambiguous") {
      return {
        ok: false,
        reason: "multiple_client_matches",
        candidateCount: pick.count,
        email,
      };
    }
  }

  if (!email) {
    return {
      ok: false,
      reason: "missing_customer_email",
      message: "Stripe customer details did not include an email; cannot create Mindbody client.",
    };
  }
  if (!first) {
    return {
      ok: false,
      reason: "missing_customer_name",
      message: "Stripe customer details did not include a name; cannot create Mindbody client.",
    };
  }

  const created = await addClient(
    staffHeaders,
    {
      firstName: first,
      lastName: last,
      email,
      mobilePhone: input.phone || "",
    },
    { mindbodyTest: input.mindbodyTest === true },
  );
  if (!created.ok) {
    if (created.conflict) {
      const matches = await searchClientsByEmail(staffHeaders, email);
      const pick = pickCanonicalClient(matches, { email, phone });
      if (pick.kind === "one") {
        const id = clientIdFromRow(/** @type {Record<string, unknown>} */ (pick.client));
        if (id != null) {
          return {
            ok: true,
            clientId: id,
            via: "email_unique",
            clientCreated: false,
            email,
          };
        }
      }
      if (pick.kind === "ambiguous") {
        return {
          ok: false,
          reason: "multiple_client_matches",
          candidateCount: pick.count,
          email,
        };
      }
    }
    return {
      ok: false,
      reason: created.error,
      message: mindbodyErrorMessage(created.mindbody) || undefined,
      mindbody: created.mindbody,
    };
  }
  const verify = await fetchClientById(staffHeaders, created.clientId);
  if (!verify) {
    return {
      ok: false,
      reason: "addclient_succeeded_but_verify_failed",
      retryable: true,
    };
  }
  return {
    ok: true,
    clientId: created.clientId,
    via: "created",
    clientCreated: true,
    email,
  };
}

/* -------------------------------------------------------------------------- */
/* syncOneTimePurchaseToMindbody                                              */
/* -------------------------------------------------------------------------- */

/**
 * Parse a "calculated total (X)" mismatch from Mindbody's CheckoutShoppingCart error payload.
 *
 * Ported from `mindbody-sale-checkout.mjs` (the classic Mindbody-driven flow already had
 * this safety net). Mindbody rejects the cart when `Payments.sum !== calculatedCartTotal`,
 * e.g. list price $65 + Payment $55 with no DiscountAmount. The error message embeds the
 * total Mindbody computed; we parse it so we can either retry the cart with the matching
 * payment amount or surface a structured `mindbody_calculated_total_mismatch` reason on the
 * order record (instead of an opaque `paid_but_not_synced`).
 *
 * @param {unknown} mbData
 * @returns {number | null} calculated cart total Mindbody expects (USD), or null if no mismatch
 */
function mindbodyCheckoutMismatchCalculatedTotal(mbData) {
  /** @param {string} s */
  function fromString(s) {
    const m = s.match(/calculated total\s*\(\s*([\d.]+)\s*\)/i);
    if (!m) return null;
    const n = Number.parseFloat(m[1]);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  /** @param {unknown} x @param {number} depth */
  function walk(x, depth = 0) {
    if (depth > 14) return null;
    if (x == null) return null;
    if (typeof x === "string") return fromString(x);
    if (typeof x !== "object") return null;
    if (Array.isArray(x)) {
      for (const el of x) {
        const n = walk(el, depth + 1);
        if (n != null) return n;
      }
      return null;
    }
    const o = /** @type {Record<string, unknown>} */ (x);
    const msg = o.Message ?? o.message;
    if (typeof msg === "string") {
      const hit = fromString(msg);
      if (hit != null) return hit;
    }
    for (const v of Object.values(o)) {
      const n = walk(v, depth + 1);
      if (n != null) return n;
    }
    return null;
  }

  const hit = walk(mbData);
  if (hit != null) return hit;
  if (mbData && typeof mbData === "object") {
    const raw = /** @type {Record<string, unknown>} */ (mbData)._raw;
    if (typeof raw === "string") {
      const n = fromString(raw);
      if (n != null) return n;
    }
  }
  try {
    return fromString(JSON.stringify(mbData));
  } catch {
    return null;
  }
}

/**
 * Walk a Mindbody CheckoutShoppingCart success-response and surface any cart line whose
 * `Action` came back as "Failed". When Mindbody accepts the request envelope but rejects an
 * individual line (e.g. `DiscountAmount` invalid for a particular Service), the HTTP status
 * is still 200 and the failure surfaces only on the per-item Action enum. Without this
 * detection we would mark the order `mindbody_synced` even though the Service was never
 * granted to the client — exactly the silent-money-in / no-fulfillment failure mode we are
 * trying to eliminate around the new coupon flow.
 *
 * Returns the failed item's index/Action when found, null otherwise.
 *
 * @param {unknown} mbData
 * @returns {{ index: number; action: string; itemId: number | null } | null}
 */
function findFailedCartItem(mbData) {
  if (!mbData || typeof mbData !== "object") return null;
  const root = /** @type {Record<string, unknown>} */ (mbData);
  for (const seg of [root.ShoppingCart, root.shoppingCart, root.Sale, root.sale, root]) {
    if (!seg || typeof seg !== "object") continue;
    const o = /** @type {Record<string, unknown>} */ (seg);
    for (const key of ["CartItems", "cartItems", "Items", "items"]) {
      const arr = o[key];
      if (!Array.isArray(arr)) continue;
      for (let i = 0; i < arr.length; i += 1) {
        const row = arr[i];
        if (!row || typeof row !== "object") continue;
        const r = /** @type {Record<string, unknown>} */ (row);
        const action = String(r.Action ?? r.action ?? "").trim();
        if (action.toLowerCase() === "failed") {
          const idRaw = r.Id ?? r.id ?? r.ItemId ?? r.itemId;
          const itemId =
            typeof idRaw === "number" && Number.isFinite(idRaw) ? Math.trunc(idRaw) : null;
          return { index: i, action, itemId };
        }
      }
    }
  }
  return null;
}

/**
 * @param {number} cents
 * @returns {string}
 */
function fmtUsd(cents) {
  if (!Number.isFinite(cents)) return "$0.00";
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  return `${sign}$${(abs / 100).toFixed(2)}`;
}

/**
 * Build the CheckoutShoppingCart payload. Same shape as `mindbody-sale-checkout.mjs`
 * (`Type: "Service"`, `Metadata: { Id, ServiceId }`) but with a Custom payment row instead of
 * a stored card / Comp.
 *
 * `mindbodyTest` controls Mindbody's own dry-run mode — when true, Mindbody validates the
 * sale without persisting a Service against the client.
 *
 * **Discount handling (Stripe coupon path):**
 *   When `discountUsd > 0` we attach `DiscountAmount` to the cart line item. Per Mindbody
 *   Public API v6 Swagger spec (`CheckoutItemWrapper`), this field is "the amount the item
 *   is discounted" and is **ignored only for `Type:"Package"`**. Our catalog SKUs are all
 *   `Type:"Service"` (Pricing Options), so the discount is honoured and Mindbody computes
 *   the cart total as `(serviceListPrice * quantity) - discount`. The Custom payment row's
 *   `Amount` / `AmountPaid` is set to the discounted total so the payment-sum equals the
 *   cart-total and Mindbody does not raise a "calculated total mismatch".
 *
 * @param {{
 *   clientId: number;
 *   serviceId: number;
 *   listAmountUsd: number;
 *   discountAmountUsd: number;
 *   paidAmountUsd: number;
 *   payNote: string;
 *   mode: "custom" | "comp";
 *   paymentMethodName: string;
 *   paymentMethodId: number | null;
 *   mindbodyTest?: boolean;
 * }} cfg
 */
function buildSyncPayload(cfg) {
  const isTest = cfg.mindbodyTest === true;
  const itemMetadata = { Id: cfg.serviceId, ServiceId: cfg.serviceId };

  /**
   * `DiscountAmount` is omitted (rather than sent as 0) when no Stripe coupon was applied,
   * to keep the payload identical to the pre-coupon shape and avoid any chance of triggering
   * Mindbody-side rounding logic on the no-discount path.
   */
  /** @type {Record<string, unknown>} */
  const cartLine = { Item: { Type: "Service", Metadata: itemMetadata }, Quantity: 1 };
  if (cfg.discountAmountUsd > 0) {
    cartLine.DiscountAmount = Number(cfg.discountAmountUsd.toFixed(2));
  }
  const cartLines = [cartLine];

  /** @type {Record<string, unknown>[]} */
  const payments = [];
  if (cfg.mode === "comp") {
    payments.push({
      Type: "Comp",
      Metadata: {
        Amount: cfg.paidAmountUsd,
        AmountPaid: cfg.paidAmountUsd,
        Notes: cfg.payNote,
      },
    });
  } else {
    /**
     * Mindbody Public API custom payment row. Verified empirically against /sale/checkoutshoppingcart
     * (Test:true) on May 12 2026: the **lowercase `id`** key is REQUIRED inside Metadata —
     * a Name-only payload returns 400 "The received Custom's Metadata was missing key id."
     * We additionally send `Id` and `PaymentMethodId` in PascalCase + the human-readable `Name`
     * so other Mindbody parsers that prefer those still work, and `Notes`/`PayNotes` carry the
     * Stripe order reference (Mindbody Site Settings → Payment Methods → "Stripe" → PayNotes
     * label "Stripe Order ID" must be enabled for the notes to surface in the dashboard).
     *
     * `cfg.paymentMethodId` is guaranteed non-null here — `syncOneTimePurchaseToMindbody`
     * fails fast with `missing_payment_method_id` when MINDBODY_STRIPE_PAYMENT_METHOD_ID is unset.
     */
    /** @type {Record<string, unknown>} */
    const meta = {
      id: /** @type {number} */ (cfg.paymentMethodId),
      Id: cfg.paymentMethodId,
      PaymentMethodId: cfg.paymentMethodId,
      Name: cfg.paymentMethodName,
      Amount: cfg.paidAmountUsd,
      AmountPaid: cfg.paidAmountUsd,
      Notes: cfg.payNote,
      PayNotes: cfg.payNote,
    };
    payments.push({ Type: "Custom", Metadata: meta });
  }

  /**
   * Mindbody behaviour with `Test: true` on /sale/checkoutshoppingcart, verified empirically:
   *   • The cart is validated end-to-end (Service IDs, payment method id, totals, currency).
   *   • Mindbody allocates a Sale ID counter value but DOES NOT persist a row to
   *     Sales / Purchases / Services — the client's account is unchanged.
   *   • Mindbody DOES emit a receipt email if `SendEmail: true` (the email pipeline runs
   *     at request time, before the persistence step). To avoid customer confusion from a
   *     real-looking receipt for a Stripe test card payment, we send `SendEmail: false`
   *     when `isTest === true`.
   * Live (`!isTest`) carts always send `SendEmail: true` so the customer gets their real
   * Mindbody receipt.
   */
  const checkout = {
    ClientId: String(cfg.clientId),
    Test: isTest,
    test: isTest,
    Items: cartLines,
    Payments: payments,
    InStore: false,
    SendEmail: !isTest,
  };

  const locRaw = (process.env.MINDBODY_SALE_LOCATION_ID ?? "").trim();
  if (/^\d+$/.test(locRaw)) {
    const n = parseInt(locRaw, 10);
    if (n > 0) checkout.LocationId = n;
  }

  return checkout;
}

/**
 * @typedef {Object} SyncInput
 * @property {string} orderId
 * @property {string} stripeCheckoutSessionId
 * @property {string} localSku
 * @property {number} clientId
 * @property {number} amountCents Catalog **list price** in cents. Becomes the Service line
 *   item's effective list price in Mindbody. Used for PayNotes (`list=$X`) and as the
 *   fallback `paidAmountCents` when no Stripe coupon was applied. NEVER overwritten by
 *   Stripe coupon math — that's `paidAmountCents` / `discountAmountCents` below.
 * @property {string} currency
 * @property {number=} paidAmountCents Stripe `session.amount_total` — the actual amount
 *   collected, in cents. Becomes `Payments[0].Amount` / `AmountPaid` on the Mindbody Custom
 *   payment row. When omitted, falls back to `amountCents` (legacy / no-coupon path).
 * @property {number=} discountAmountCents Stripe `session.total_details.amount_discount` —
 *   the cart-level discount, in cents. Becomes `Items[0].DiscountAmount` on the Mindbody
 *   cart line when > 0. Per Mindbody Public API v6 (`CheckoutItemWrapper`), this is the
 *   correct field for per-line discounts on `Type:"Service"` items.
 * @property {string=} promotionCode Human-facing Stripe promotion code the buyer typed
 *   (e.g. "WELCOME20"). Surfaced in PayNotes for staff visibility; not used for any pricing
 *   calculation on our side (Stripe already discounted the cart).
 * @property {string=} couponId Stripe coupon object id (e.g. "abc123"). Surfaced in PayNotes.
 * @property {boolean=} mindbodyTest When true, the CheckoutShoppingCart payload uses
 *   Mindbody `Test: true` so the sale is dry-run only — Mindbody validates the request but
 *   does not persist the Service against the client. Used by the
 *   `STRIPE_TEST_MODE_MINDBODY_BEHAVIOR=mindbody_test` mode.
 */

/**
 * @typedef {Object} SyncOk
 * @property {true} ok
 * @property {string | null} mindbodySaleId
 * @property {string | null} mindbodyTransactionId
 * @property {string} responseSummary
 * @property {string} mode
 * @property {string} paymentMethodName
 */

/**
 * @typedef {Object} SyncErr
 * @property {false} ok
 * @property {string} reason
 * @property {string=} message
 * @property {string} mode
 * @property {boolean=} retryable
 * @property {unknown=} mindbody
 * @property {number=} mbHttpStatus
 */

/**
 * Resolve the Mindbody service id, build the sync payload, POST to
 * /sale/checkoutshoppingcart, and return a structured result. The caller is responsible for
 * persisting the result to the order store and never retrying with the same orderId once
 * `ok: true` is returned.
 *
 * @param {SyncInput & { item: import("./stripe-catalog-lib.mjs").CatalogItem }} input
 * @returns {Promise<SyncOk | SyncErr>}
 */
export async function syncOneTimePurchaseToMindbody(input) {
  const mode = (process.env.MINDBODY_STRIPE_PAYMENT_MODE || "custom").trim().toLowerCase();
  if (mode !== "custom" && mode !== "comp") {
    return { ok: false, reason: "invalid_payment_mode_env", mode };
  }
  const paymentMethodName =
    (process.env.MINDBODY_STRIPE_PAYMENT_METHOD_NAME || "Stripe").trim() || "Stripe";
  const paymentMethodIdRaw = (process.env.MINDBODY_STRIPE_PAYMENT_METHOD_ID || "").trim();
  /** @type {number | null} */
  const paymentMethodId =
    /^\d+$/.test(paymentMethodIdRaw) ? parseInt(paymentMethodIdRaw, 10) : null;

  /**
   * Mindbody REQUIRES `Metadata.id` (lowercase) on `Type:"Custom"` payment rows. Discovered
   * during a `mindbody_test` dry-run: an order with a `Name`-only Metadata returned
   * "The received Custom's Metadata was missing key id." 400. Without the numeric id we
   * cannot build a valid CheckoutShoppingCart payload, so fail fast with a clear, actionable
   * error rather than letting Mindbody reject every order. To find the id:
   *   `npm run stripe:find-mb-payment-id`
   */
  if (mode === "custom" && paymentMethodId == null) {
    return {
      ok: false,
      reason: "missing_payment_method_id",
      mode,
      message:
        "MINDBODY_STRIPE_PAYMENT_METHOD_ID is required when MINDBODY_STRIPE_PAYMENT_MODE=custom. " +
        "Mindbody rejects Type:'Custom' Payments without a numeric Metadata.id. " +
        "Run `npm run stripe:find-mb-payment-id` to discover the id for the configured payment method name.",
    };
  }

  const staff = await staffHeadersForSync();
  if (!staff.ok) {
    return {
      ok: false,
      reason: staff.error,
      mode,
      retryable: staff.error === "staff_token_issue_timeout",
    };
  }

  /** @type {number | null} */
  let serviceId = input.item.mindbodyServiceId;
  if (serviceId == null) {
    const found = await resolveServiceIdByNameMatch({
      nameMatchAny: input.item.mindbodyServiceNameMatchAny,
      nameMatchExclude: input.item.mindbodyServiceNameMatchExclude,
    });
    if (!found) {
      return {
        ok: false,
        reason: "mindbody_service_id_unresolved",
        message:
          "Could not find a /sale/services row matching this catalog SKU. Pin `mindbodyServiceId` in stripe-mindbody-catalog.config.json or fix the name match patterns.",
        mode,
      };
    }
    serviceId = found.id;
  }

  if (input.currency.toLowerCase() !== "usd") {
    return {
      ok: false,
      reason: "non_usd_currency",
      message: `Catalog currency was ${input.currency}; Mindbody Comp/Custom payments are USD here.`,
      mode,
    };
  }
  /**
   * Three amounts, all in cents, mapped 1:1 to Stripe Checkout Session fields:
   *   • `listCents`     — `OrderRecord.amountCents`           (catalog list, Service price).
   *   • `paidCents`     — `session.amount_total`              (actual Stripe charge).
   *   • `discountCents` — `session.total_details.amount_discount` (coupon discount).
   *
   * Backward-compat: when `paidAmountCents` is not supplied (legacy callers, no coupon),
   * the paid amount falls back to the list price — exactly the pre-coupon behaviour.
   * `discountAmountCents` is clamped to 0 when missing.
   */
  const listCents = Math.round(input.amountCents);
  const paidCents = Math.round(
    typeof input.paidAmountCents === "number" && Number.isFinite(input.paidAmountCents)
      ? input.paidAmountCents
      : listCents,
  );
  const discountCents = Math.max(
    0,
    Math.round(
      typeof input.discountAmountCents === "number" && Number.isFinite(input.discountAmountCents)
        ? input.discountAmountCents
        : 0,
    ),
  );
  const listAmountUsd = listCents / 100;
  const paidAmountUsd = paidCents / 100;
  const discountAmountUsd = discountCents / 100;
  if (!(listAmountUsd > 0)) {
    return { ok: false, reason: "invalid_amount", mode };
  }
  if (!(paidAmountUsd >= 0)) {
    /** Allow $0 paid for 100%-off coupons; reject negatives outright. */
    return { ok: false, reason: "invalid_paid_amount", mode };
  }
  /**
   * Internal consistency check: list - discount must equal paid (Stripe's own arithmetic).
   * If Stripe's numbers don't add up we DO NOT proceed — better to fail loudly here than to
   * send a malformed cart to Mindbody and have it accepted with the wrong totals.
   * Tolerance: 1¢ for floating-point/rounding edge cases on percent_off coupons.
   */
  const expectedPaidCents = Math.max(0, listCents - discountCents);
  if (Math.abs(expectedPaidCents - paidCents) > 1) {
    return {
      ok: false,
      reason: "stripe_amount_arithmetic_mismatch",
      message: `Stripe arithmetic does not reconcile: list=${listCents}¢, discount=${discountCents}¢, paid=${paidCents}¢ (expected ${expectedPaidCents}¢).`,
      mode,
    };
  }

  /**
   * PayNotes — surfaces the full coupon story to studio staff in the Mindbody UI under
   * Site Settings → Payment Methods → Stripe → PayNotes. Format is intentionally compact and
   * machine-greppable (`key=value` pairs, semicolon-delimited, capped at Mindbody's 250 char
   * limit). Always includes orderId/session/sku; conditionally appends list/discount/paid +
   * promo when a Stripe coupon was applied.
   */
  /** @type {string[]} */
  const noteParts = [
    `orderId=${input.orderId}`,
    `session=${input.stripeCheckoutSessionId}`,
    `sku=${input.localSku}`,
  ];
  if (discountCents > 0) {
    noteParts.push(`list=${fmtUsd(listCents)}`);
    noteParts.push(`discount=${fmtUsd(discountCents)}`);
    noteParts.push(`paid=${fmtUsd(paidCents)}`);
    if (input.promotionCode) noteParts.push(`promo=${String(input.promotionCode).slice(0, 60)}`);
    if (input.couponId) noteParts.push(`coupon=${String(input.couponId).slice(0, 60)}`);
  }
  const payNote = noteParts.join("; ").slice(0, 250);

  const payload = buildSyncPayload({
    clientId: input.clientId,
    serviceId,
    listAmountUsd,
    discountAmountUsd,
    paidAmountUsd,
    payNote,
    mode: /** @type {"custom"|"comp"} */ (mode),
    mindbodyTest: input.mindbodyTest === true,
    paymentMethodName,
    paymentMethodId,
  });

  const path = `/public/v${MB_API_VERSION}/sale/checkoutshoppingcart`;
  let r = await fetchMb("POST", path, staff.headers, payload, { timeoutMs: mindbodyCheckoutTimeoutMs() });
  if (!r.ok && (r.status === 401 || r.status === 403)) {
    /** Force-refresh staff token once on auth errors. */
    const issued = await getMindbodyStaffAccessTokenCached({ forceRefresh: true });
    if (issued.ok) {
      const h2 = mindbodyStaffBearerHeaders(issued.accessToken);
      if (h2) {
        r = await fetchMb("POST", path, h2, payload, { timeoutMs: mindbodyCheckoutTimeoutMs() });
      }
    }
  }

  /** Timeouts are retryable but DO NOT retry inside this function — caller decides. */
  if (
    !r.ok &&
    r.data &&
    typeof r.data === "object" &&
    /** @type {Record<string, unknown>} */ (r.data)._mbFetchTimeout === true
  ) {
    return {
      ok: false,
      reason: "mindbody_sync_timeout",
      message:
        "Mindbody did not respond within the timeout. Mindbody may have already recorded the sale; before retrying, check Mindbody for an existing sale with this PayNotes order id.",
      mode,
      retryable: true,
      mbHttpStatus: r.status,
    };
  }

  if (!r.ok) {
    const detail = mindbodyErrorMessage(r.data);
    /**
     * Calculated-total mismatch — port of the safety net from `mindbody-sale-checkout.mjs`.
     * When Mindbody rejects the cart because `Payments.sum !== calculatedCartTotal`, the
     * error message embeds the total Mindbody computed (e.g. "calculated total (65.00)").
     * Surfacing this as a structured `mindbody_calculated_total_mismatch` reason gives ops
     * an actionable signal — "Stripe charged $55, Mindbody wanted $65, the discount field
     * either was rejected or didn't propagate" — instead of an opaque rejection. The order
     * still goes to `paid_but_not_synced` (caller decides), but with diagnostic context.
     *
     * NOTE: We do NOT auto-retry with the corrected amount here (unlike the classic flow).
     * Auto-retrying would either double-charge the buyer (Stripe already collected) or hide
     * a real configuration bug (e.g. `DiscountAmount` rejected by Mindbody for this Service
     * type). Manual review is the correct posture for now; once the verification cycle
     * confirms `DiscountAmount` is honoured, this branch should fire only on configuration
     * regressions and gives us a clear log line to investigate.
     */
    const expectedTotal = mindbodyCheckoutMismatchCalculatedTotal(r.data);
    if (expectedTotal != null) {
      return {
        ok: false,
        reason: "mindbody_calculated_total_mismatch",
        message:
          `Mindbody expected cart total $${expectedTotal.toFixed(2)}, but Payments sum was $${paidAmountUsd.toFixed(2)} ` +
          `(list $${listAmountUsd.toFixed(2)}, discount $${discountAmountUsd.toFixed(2)}). ` +
          `Either DiscountAmount was rejected by Mindbody for this Service or the Stripe arithmetic ` +
          `differs from Mindbody's. Manual review required.`,
        mode,
        mbHttpStatus: r.status,
        mindbody: r.data,
      };
    }
    return {
      ok: false,
      reason: "mindbody_sync_rejected",
      message: detail || "Mindbody rejected the CheckoutShoppingCart payload.",
      mode,
      mbHttpStatus: r.status,
      mindbody: r.data,
    };
  }

  /**
   * 200 OK envelope but a per-item `Action: "Failed"` is treated as a hard failure. Mindbody
   * sometimes accepts the cart shape but rejects an individual line — historically rare on
   * the existing Service-only flow, but explicitly possible when we start sending
   * `DiscountAmount`. Without this check we would record `mindbody_synced` while the Service
   * was never granted to the client (the exact silent-money-in failure we are protecting
   * against around the new coupon flow).
   */
  const failedLine = findFailedCartItem(r.data);
  if (failedLine) {
    return {
      ok: false,
      reason: "mindbody_cart_item_failed",
      message:
        `Mindbody returned 200 but cart item #${failedLine.index} came back with Action="${failedLine.action}". ` +
        `Service was NOT granted. Likely DiscountAmount rejected for this Service type or Service no longer ` +
        `sellable online. Manual review required.`,
      mode,
      mbHttpStatus: r.status,
      mindbody: r.data,
    };
  }

  const fp = shoppingSaleFingerprint(r.data);
  const summary = (() => {
    try {
      return JSON.stringify(r.data).slice(0, 1200);
    } catch {
      return "";
    }
  })();
  return {
    ok: true,
    mindbodySaleId: fp.saleId,
    mindbodyTransactionId: fp.transactionId,
    responseSummary: summary,
    mode,
    paymentMethodName,
  };
}

export const __testing = {
  staffHeadersForSync,
  pickCanonicalClient,
  splitFullName,
  buildSyncPayload,
  resolveServiceIdByNameMatch,
  mergeMindbodyClients,
  mindbodyCheckoutMismatchCalculatedTotal,
  findFailedCartItem,
  fmtUsd,
  NCS_HISTORY_KEYWORDS,
};
