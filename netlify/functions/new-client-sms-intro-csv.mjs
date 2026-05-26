/**
 * Mindbody "Expiring intro offers" CSV — parse, resolve client IDs, match reporting.
 */

import { readFile } from "node:fs/promises";

import { connectLambda, getStore } from "@netlify/blobs";

import { MB_API_VERSION, clientsList, fetchMb } from "./mindbody-consumer-lib.mjs";

const INTRO_CSV_BLOB_KEY = "intro-offers-csv/latest";

/** @typedef {"email"|"phone"|"clientId"|"none"} CsvMatchedBy */
/** @typedef {"matched"|"unmatched"|"ambiguous"} CsvMatchStatus */

/**
 * @typedef {Object} IntroOffersCsvRow
 * @property {number} rowIndex 1-based data row (excludes header)
 * @property {string | null} clientIdRaw
 * @property {string} clientName
 * @property {string} email
 * @property {string} phone
 * @property {string} expiration
 * @property {string} introOffer
 * @property {string} visits
 * @property {string} nextVisit
 */

/**
 * @typedef {Object} CsvRowReportMeta
 * @property {number} csvRowIndex
 * @property {string | null} csvExpiration
 * @property {string | null} csvIntroOffer
 * @property {string | null} csvVisits
 * @property {string | null} csvNextVisit
 * @property {CsvMatchedBy} csvMatchedBy
 * @property {CsvMatchStatus} csvMatchStatus
 * @property {string | null} csvClientName
 * @property {string | null} csvEmail
 * @property {string | null} csvPhone
 * @property {string | null} [csvActivationDate]
 * @property {string | null} [csvRemaining]
 * @property {string | null} [csvActive]
 * @property {string | null} [csvPaymentRef]
 * @property {number | null} mindbodyClientId
 * @property {string | null} csvMatchDetail
 */

/**
 * @typedef {Object} CsvMatchSummary
 * @property {number} mindbodyIntroOffersCsv
 * @property {number} mindbodyIntroOffersCsvMatched
 * @property {number} mindbodyIntroOffersCsvAmbiguous
 * @property {number} mindbodyIntroOffersCsvUnmatched
 */

/** @param {string} h */
function normalizeHeaderKey(h) {
  return h.replace(/^\uFEFF/, "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** @type {Record<string, string[]>} */
const HEADER_ALIASES = {
  expiration: ["expiration", "exp date", "expiry", "expires", "exp date/time"],
  clientname: ["client name", "client", "name"],
  email: ["email", "e-mail", "email address"],
  phone: ["phone", "mobile phone", "mobile", "cell", "cell phone"],
  introoffer: ["intro offer", "introoffer", "offer", "pricing option", "service"],
  visits: ["visits", "visits used / visits count", "visit count", "visits used/count"],
  nextvisit: ["next visit", "nextvisit", "next class"],
  clientid: ["client id", "clientid", "mindbody client id", "unique id", "id"],
};

/** @param {string} header */
function canonicalFieldForHeader(header) {
  const key = normalizeHeaderKey(header);
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    if (aliases.includes(key)) return field;
  }
  return null;
}

/**
 * Split CSV text into rows of cell strings (handles quoted fields).
 * @param {string} text
 * @returns {string[][]}
 */
export function splitCsvRecords(text) {
  const src = String(text || "").replace(/^\uFEFF/, "");
  /** @type {string[][]} */
  const records = [];
  /** @type {string[]} */
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i += 1;
      row.push(cell);
      cell = "";
      if (row.some((c) => c.trim())) records.push(row);
      row = [];
    } else {
      cell += ch;
    }
  }
  row.push(cell);
  if (row.some((c) => c.trim())) records.push(row);
  return records;
}

/**
 * @param {string} text
 * @returns {{ headers: string[]; rows: IntroOffersCsvRow[] }}
 */
export function parseIntroOffersCsv(text) {
  const records = splitCsvRecords(text);
  if (!records.length) return { headers: [], rows: [] };

  const headerCells = records[0];
  /** @type {string[]} */
  const headers = headerCells.map((h) => normalizeHeaderKey(h));
  /** @type {(string | null)[]} */
  const fieldMap = headerCells.map((h) => canonicalFieldForHeader(h));

  /** @type {IntroOffersCsvRow[]} */
  const rows = [];
  for (let i = 1; i < records.length; i += 1) {
    const cells = records[i];
    /** @type {Record<string, string>} */
    const mapped = {};
    for (let j = 0; j < fieldMap.length; j += 1) {
      const field = fieldMap[j];
      if (!field) continue;
      mapped[field] = (cells[j] || "").trim();
    }
    const hasData = Object.values(mapped).some((v) => v.trim());
    if (!hasData) continue;
    rows.push({
      rowIndex: i,
      clientIdRaw: mapped.clientid || null,
      clientName: mapped.clientname || "",
      email: mapped.email || "",
      phone: mapped.phone || "",
      expiration: mapped.expiration || "",
      introOffer: mapped.introoffer || "",
      visits: mapped.visits || "",
      nextVisit: mapped.nextvisit || "",
    });
  }

  return { headers, rows };
}

/** @param {IntroOffersCsvRow} row */
function csvMetaFromRow(row) {
  return {
    csvRowIndex: row.rowIndex,
    csvExpiration: row.expiration || null,
    csvIntroOffer: row.introOffer || null,
    csvVisits: row.visits || null,
    csvNextVisit: row.nextVisit || null,
    csvClientName: row.clientName || null,
    csvEmail: row.email || null,
    csvPhone: row.phone || null,
  };
}

/** @param {IntroOffersCsvRow} row @param {CsvMatchedBy} matchedBy @param {CsvMatchStatus} status @param {number | null} [clientId] @param {string | null} [detail] */
function reportRow(row, matchedBy, status, clientId = null, detail = null) {
  return {
    ...csvMetaFromRow(row),
    csvMatchedBy: matchedBy,
    csvMatchStatus: status,
    mindbodyClientId: clientId,
    csvMatchDetail: detail,
  };
}

/** @param {unknown} row */
function clientIdFromRow(row) {
  if (!row || typeof row !== "object") return null;
  const o = /** @type {Record<string, unknown>} */ (row);
  for (const k of ["Id", "id", "UniqueId", "uniqueId", "ClientId", "clientId"]) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.trunc(v);
    if (typeof v === "string" && v.trim() && Number.isFinite(Number(v)) && Number(v) > 0) {
      return Math.trunc(Number(v));
    }
  }
  return null;
}

/** @param {unknown} row */
function emailFromRow(row) {
  if (!row || typeof row !== "object") return "";
  const o = /** @type {Record<string, unknown>} */ (row);
  const v = o.Email ?? o.email;
  return typeof v === "string" ? v.trim().toLowerCase() : "";
}

/** @param {unknown} row */
function phoneDigitsFromRow(row) {
  if (!row || typeof row !== "object") return "";
  const o = /** @type {Record<string, unknown>} */ (row);
  for (const k of ["MobilePhone", "HomePhone", "WorkPhone", "Phone", "mobilePhone"]) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) {
      return v.replace(/\D/g, "").slice(-10);
    }
  }
  return "";
}

/** @param {string} phone */
function digitsOnlyPhone(phone) {
  return String(phone || "").replace(/\D/g, "").slice(-10);
}

/**
 * @param {Record<string, string>} headers
 * @param {URLSearchParams} qs
 */
async function searchClients(headers, qs) {
  const r = await fetchMb(
    "GET",
    `/public/v${MB_API_VERSION}/client/clients?${qs}`,
    headers,
    null,
    { timeoutMs: 12000 },
  );
  if (!r.ok) return { ok: false, status: r.status, clients: [] };
  return { ok: true, status: r.status, clients: clientsList(r.data) };
}

/**
 * @param {Record<string, string>} headers
 * @param {string} email
 */
async function findClientsByExactEmail(headers, email) {
  const target = email.trim().toLowerCase();
  if (!target || !target.includes("@")) return [];
  const q = new URLSearchParams();
  q.set("request.searchText", target);
  q.set("request.limit", "100");
  const r = await searchClients(headers, q);
  if (!r.ok) return [];
  return r.clients.filter((c) => emailFromRow(c) === target);
}

/**
 * @param {Record<string, string>} headers
 * @param {string} phone
 */
async function findClientsByExactPhone(headers, phone) {
  const targetDigits = digitsOnlyPhone(phone);
  if (targetDigits.length < 10) return [];
  const q = new URLSearchParams();
  q.set("request.searchText", targetDigits);
  q.set("request.limit", "100");
  const r = await searchClients(headers, q);
  if (!r.ok) return [];
  return r.clients.filter((c) => phoneDigitsFromRow(c) === targetDigits);
}

/**
 * @param {Record<string, string>} headers
 * @param {number} clientId
 */
async function verifyClientExists(headers, clientId) {
  const q = new URLSearchParams();
  q.set("request.clientIDs", String(clientId));
  q.set("request.limit", "5");
  const r = await searchClients(headers, q);
  if (!r.ok) return null;
  for (const c of r.clients) {
    const id = clientIdFromRow(c);
    if (id === clientId) return clientId;
  }
  return r.clients.length === 1 ? clientIdFromRow(r.clients[0]) : null;
}

/**
 * @param {unknown} event
 * @returns {Promise<string | null>}
 */
export async function resolveIntroOffersCsvText(event) {
  /** @type {{ body?: string | null; isBase64Encoded?: boolean; headers?: Record<string, string | undefined> }} */
  const e = event && typeof event === "object" ? /** @type {typeof event} */ (event) : {};

  if (e.body) {
    const raw = e.isBase64Encoded
      ? Buffer.from(String(e.body), "base64").toString("utf8")
      : String(e.body);
    const contentType = Object.entries(e.headers || {}).find(
      ([k]) => k.toLowerCase() === "content-type",
    )?.[1];
    const ct = (contentType || "").toLowerCase();
    if (ct.includes("text/csv") || ct.includes("text/plain")) {
      return raw.trim() || null;
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        const o = /** @type {Record<string, unknown>} */ (parsed);
        if (typeof o.introOffersCsv === "string" && o.introOffersCsv.trim()) {
          return o.introOffersCsv;
        }
        if (typeof o.introOffersCsvBase64 === "string" && o.introOffersCsvBase64.trim()) {
          return Buffer.from(o.introOffersCsvBase64, "base64").toString("utf8");
        }
      }
    } catch {
      /* not JSON — ignore */
    }
  }

  const path = (process.env.NEW_CLIENT_SMS_INTRO_OFFERS_CSV_PATH || "").trim();
  if (path) {
    try {
      return (await readFile(path, "utf8")).trim() || null;
    } catch (err) {
      console.log(
        JSON.stringify({
          event: "new_client_sms_intro_csv_path_read_failed",
          path,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  const inline = (process.env.NEW_CLIENT_SMS_INTRO_OFFERS_CSV || "").trim();
  if (inline) return inline;

  if ((process.env.NEW_CLIENT_SMS_INTRO_OFFERS_CSV_FROM_BLOB || "").trim() === "1") {
    try {
      if (event && typeof event === "object") connectLambda(/** @type {import("@netlify/functions").HandlerEvent} */ (event));
      const store = getStore("new-client-sms-records");
      const blob = await store.get(INTRO_CSV_BLOB_KEY, { type: "text" });
      if (blob && String(blob).trim()) return String(blob);
    } catch (err) {
      console.log(
        JSON.stringify({
          event: "new_client_sms_intro_csv_blob_read_failed",
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  return null;
}

/**
 * @param {unknown} event
 * @param {string} csvText
 */
export async function persistIntroOffersCsvBlob(event, csvText) {
  if (event && typeof event === "object") connectLambda(/** @type {import("@netlify/functions").HandlerEvent} */ (event));
  const store = getStore("new-client-sms-records");
  await store.set(INTRO_CSV_BLOB_KEY, csvText);
  return { ok: true, key: INTRO_CSV_BLOB_KEY, bytes: Buffer.byteLength(csvText, "utf8") };
}

/** @param {unknown} event */
export function shouldPersistIntroOffersCsvFromBody(event) {
  if (!event || typeof event !== "object" || !event.body) return false;
  const raw = event.isBase64Encoded
    ? Buffer.from(String(event.body), "base64").toString("utf8")
    : String(event.body);
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const v = /** @type {Record<string, unknown>} */ (parsed).persistIntroOffersCsv;
      return v === true || v === 1 || v === "1";
    }
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * Match CSV rows to Mindbody client IDs (email → phone → skip; no fuzzy name).
 *
 * @param {Record<string, string>} staffHeaders
 * @param {IntroOffersCsvRow[]} rows
 */
export async function matchIntroOffersCsvRows(staffHeaders, rows) {
  /** @type {Array<{ clientId: number; meta: CsvRowReportMeta; row: IntroOffersCsvRow }>} */
  const matched = [];
  /** @type {CsvRowReportMeta[]} */
  const unmatched = [];
  /** @type {CsvRowReportMeta[]} */
  const ambiguous = [];

  for (const row of rows) {
    const base = csvMetaFromRow(row);

    const rawIdStr = (row.clientIdRaw || "").trim();
    const rawId = rawIdStr && Number.isFinite(Number(rawIdStr)) ? Math.trunc(Number(rawIdStr)) : NaN;
    if (Number.isFinite(rawId) && rawId > 0) {
      const verified = await verifyClientExists(staffHeaders, rawId);
      if (verified != null) {
        matched.push({
          clientId: verified,
          row,
          meta: {
            ...base,
            csvMatchedBy: "clientId",
            csvMatchStatus: "matched",
            mindbodyClientId: verified,
            csvMatchDetail: null,
          },
        });
        continue;
      }
      unmatched.push(
        reportRow(row, "clientId", "unmatched", null, `client_id_not_found:${rawId}`),
      );
      continue;
    }

    const email = row.email.trim().toLowerCase();
    if (email && email.includes("@")) {
      const hits = await findClientsByExactEmail(staffHeaders, email);
      if (hits.length === 1) {
        const clientId = clientIdFromRow(hits[0]);
        if (clientId != null) {
          matched.push({
            clientId,
            row,
            meta: {
              ...base,
              csvMatchedBy: "email",
              csvMatchStatus: "matched",
              mindbodyClientId: clientId,
              csvMatchDetail: null,
            },
          });
          continue;
        }
      }
      if (hits.length > 1) {
        ambiguous.push(
          reportRow(row, "email", "ambiguous", null, `multiple_email_matches:${hits.length}`),
        );
        continue;
      }
      unmatched.push(reportRow(row, "email", "unmatched", null, "email_not_found"));
      continue;
    }

    const phoneDigits = digitsOnlyPhone(row.phone);
    if (phoneDigits.length >= 10) {
      const hits = await findClientsByExactPhone(staffHeaders, row.phone);
      if (hits.length === 1) {
        const clientId = clientIdFromRow(hits[0]);
        if (clientId != null) {
          matched.push({
            clientId,
            row,
            meta: {
              ...base,
              csvMatchedBy: "phone",
              csvMatchStatus: "matched",
              mindbodyClientId: clientId,
              csvMatchDetail: null,
            },
          });
          continue;
        }
      }
      if (hits.length > 1) {
        ambiguous.push(
          reportRow(row, "phone", "ambiguous", null, `multiple_phone_matches:${hits.length}`),
        );
        continue;
      }
      unmatched.push(reportRow(row, "phone", "unmatched", null, "phone_not_found"));
      continue;
    }

    unmatched.push(
      reportRow(row, "none", "unmatched", null, "missing_client_id_email_phone"),
    );
  }

  const summary = {
    mindbodyIntroOffersCsv: rows.length,
    mindbodyIntroOffersCsvMatched: matched.length,
    mindbodyIntroOffersCsvAmbiguous: ambiguous.length,
    mindbodyIntroOffersCsvUnmatched: unmatched.length,
  };

  return { matched, unmatched, ambiguous, summary };
}

/** @param {CsvRowReportMeta | null | undefined} meta */
export function csvFieldsForReport(meta) {
  if (!meta) {
    return {
      csvExpiration: null,
      csvIntroOffer: null,
      csvVisits: null,
      csvNextVisit: null,
      csvActivationDate: null,
      csvRemaining: null,
      csvActive: null,
      csvMatchedBy: /** @type {CsvMatchedBy} */ ("none"),
      csvMatchStatus: /** @type {CsvMatchStatus} */ ("unmatched"),
      csvRowIndex: null,
      csvClientName: null,
    };
  }
  return {
    csvExpiration: meta.csvExpiration,
    csvIntroOffer: meta.csvIntroOffer,
    csvVisits: meta.csvVisits ?? meta.csvRemaining ?? null,
    csvNextVisit: meta.csvNextVisit,
    csvActivationDate: meta.csvActivationDate ?? null,
    csvRemaining: meta.csvRemaining ?? meta.csvVisits ?? null,
    csvActive: meta.csvActive ?? null,
    csvMatchedBy: meta.csvMatchedBy,
    csvMatchStatus: meta.csvMatchStatus,
    csvRowIndex: meta.csvRowIndex,
    csvClientName: meta.csvClientName ?? null,
  };
}

export const __testing = {
  parseIntroOffersCsv,
  splitCsvRecords,
  digitsOnlyPhone,
};
