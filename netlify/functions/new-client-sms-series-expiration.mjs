/**
 * Mindbody "Series Expirations" report — HTML disguised as .xls.
 * Filter to NCS pricing options; phone-only client matching.
 */

import { MB_API_VERSION, clientsList, fetchMb } from "./mindbody-consumer-lib.mjs";

/** @typedef {"phone"|"none"} SeriesMatchedBy */
/** @typedef {"matched"|"unmatched"|"ambiguous"} SeriesMatchStatus */

/**
 * @typedef {Object} SeriesExpirationRow
 * @property {number} rowIndex
 * @property {string} clientName
 * @property {string} pricingOption
 * @property {string} paymentRef
 * @property {string} activationDate
 * @property {string} expirationDate
 * @property {string} paid
 * @property {string} remaining
 * @property {string} active
 * @property {string} rep1
 * @property {string} phone
 */

/**
 * @typedef {import("./new-client-sms-intro-csv.mjs").CsvRowReportMeta} SeedRowReportMeta
 */

/** @param {string} h */
function normalizeHeaderKey(h) {
  return h.replace(/^\uFEFF/, "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** @type {Record<string, string[]>} */
const SERIES_HEADER_ALIASES = {
  clientname: ["client", "client name", "name"],
  pricingoption: [
    "pricing options/memberships",
    "pricing options / memberships",
    "pricing option",
    "pricing options",
    "memberships",
  ],
  paymentref: ["payment ref #", "payment ref", "payment reference"],
  activationdate: ["activation date", "activated"],
  expirationdate: ["expiration date", "expiration", "exp date"],
  paid: ["paid", "amount paid"],
  remaining: ["remaining", "visits remaining", "remaining visits"],
  active: ["active"],
  rep1: ["rep 1", "rep1", "sales rep"],
  phone: ["phone #", "phone", "mobile phone", "mobile"],
};

/** @param {string} header */
function canonicalSeriesField(header) {
  const key = normalizeHeaderKey(header);
  for (const [field, aliases] of Object.entries(SERIES_HEADER_ALIASES)) {
    if (aliases.includes(key)) return field;
  }
  return null;
}

/** @param {string} text */
export function isMindbodyHtmlReport(text) {
  const t = String(text || "").trim().slice(0, 500).toLowerCase();
  return t.startsWith("<") && (t.includes("<table") || t.includes("<html") || t.includes("<tr"));
}

/** @param {string} html */
function decodeHtmlEntities(text) {
  return String(text || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
}

/** @param {string} html */
function stripHtmlCell(html) {
  const withBreaks = String(html || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/p>/gi, " ")
    .replace(/<\/div>/gi, " ");
  const stripped = withBreaks.replace(/<[^>]+>/g, " ");
  return decodeHtmlEntities(stripped).replace(/,\s*$/, "").trim();
}

/**
 * @param {string} html
 * @returns {string[][]}
 */
export function extractHtmlTableRows(html) {
  /** @type {string[][]} */
  const tables = [];
  const tableRe = /<table[\s\S]*?>([\s\S]*?)<\/table>/gi;
  let tableMatch;
  while ((tableMatch = tableRe.exec(html)) !== null) {
    /** @type {string[][]} */
    const rows = [];
    const rowRe = /<tr[\s\S]*?>([\s\S]*?)<\/tr>/gi;
    let rowMatch;
    while ((rowMatch = rowRe.exec(tableMatch[1])) !== null) {
      /** @type {string[]} */
      const cells = [];
      const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
      let cellMatch;
      while ((cellMatch = cellRe.exec(rowMatch[1])) !== null) {
        cells.push(stripHtmlCell(cellMatch[1]));
      }
      if (cells.some((c) => c.trim())) rows.push(cells);
    }
    if (rows.length) tables.push(rows);
  }
  /** Prefer the table whose header row looks like Series Expirations. */
  for (const rows of tables) {
    const headerJoined = rows[0].join(" ").toLowerCase();
    if (
      headerJoined.includes("pricing") &&
      (headerJoined.includes("expiration") || headerJoined.includes("remaining"))
    ) {
      return rows;
    }
  }
  return tables[0] || [];
}

/** @returns {string[]} */
export function defaultNcsPricingOptionNames() {
  const raw = (
    process.env.NEW_CLIENT_SMS_SERIES_EXPIRATION_NCS_NAMES || "New Client - 3 pack"
  ).trim();
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** @param {string} pricingOption @param {string[]} allowedNames */
export function isNcsPricingOptionRow(pricingOption, allowedNames) {
  const normalized = pricingOption.trim().toLowerCase();
  if (!normalized) return false;
  return allowedNames.some((name) => normalized === name.trim().toLowerCase());
}

/**
 * @param {string} html
 * @param {string[]} [allowedNcsNames]
 */
export function parseSeriesExpirationReport(html, allowedNcsNames = defaultNcsPricingOptionNames()) {
  const tableRows = extractHtmlTableRows(html);
  if (!tableRows.length) {
    return { totalRows: 0, headers: [], ncsRows: [], allowedNcsNames, skippedNonNcs: 0 };
  }

  let headerRowIndex = -1;
  /** @type {(string | null)[]} */
  let fieldMap = [];
  /** @type {string[]} */
  let headerCells = [];

  for (let i = 0; i < tableRows.length; i += 1) {
    const candidateMap = tableRows[i].map((h) => canonicalSeriesField(h));
    const hasClient = candidateMap.includes("clientname");
    const hasPricing = candidateMap.includes("pricingoption");
    const hasExpiration = candidateMap.includes("expirationdate");
    if (hasClient && hasPricing && hasExpiration) {
      headerRowIndex = i;
      fieldMap = candidateMap;
      headerCells = tableRows[i];
      break;
    }
  }

  if (headerRowIndex < 0) {
    return { totalRows: 0, headers: [], ncsRows: [], allowedNcsNames, skippedNonNcs: 0 };
  }

  /** @type {SeriesExpirationRow[]} */
  const allRows = [];
  /** @type {SeriesExpirationRow[]} */
  const ncsRows = [];
  let skippedNonNcs = 0;

  for (let i = headerRowIndex + 1; i < tableRows.length; i += 1) {
    const cells = tableRows[i];
    /** @type {Record<string, string>} */
    const mapped = {};
    for (let j = 0; j < fieldMap.length; j += 1) {
      const field = fieldMap[j];
      if (!field) continue;
      mapped[field] = (cells[j] || "").trim();
    }
    const hasData = Object.values(mapped).some((v) => v.trim());
    if (!hasData) continue;

    /** @type {SeriesExpirationRow} */
    const row = {
      rowIndex: i,
      clientName: mapped.clientname || "",
      pricingOption: mapped.pricingoption || "",
      paymentRef: mapped.paymentref || "",
      activationDate: mapped.activationdate || "",
      expirationDate: mapped.expirationdate || "",
      paid: mapped.paid || "",
      remaining: mapped.remaining || "",
      active: mapped.active || "",
      rep1: mapped.rep1 || "",
      phone: mapped.phone || "",
    };
    allRows.push(row);

    if (isNcsPricingOptionRow(row.pricingOption, allowedNcsNames)) {
      ncsRows.push(row);
    } else {
      skippedNonNcs += 1;
    }
  }

  return {
    totalRows: allRows.length,
    headers: headerCells,
    ncsRows,
    allowedNcsNames,
    skippedNonNcs,
  };
}

/** @param {string} phone */
export function digitsOnlyPhone(phone) {
  return String(phone || "").replace(/\D/g, "").slice(-10);
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

/** @param {SeriesExpirationRow} row */
function metaFromSeriesRow(row) {
  return {
    csvRowIndex: row.rowIndex,
    csvExpiration: row.expirationDate || null,
    csvIntroOffer: row.pricingOption || null,
    csvVisits: row.remaining || null,
    csvNextVisit: null,
    csvActivationDate: row.activationDate || null,
    csvRemaining: row.remaining || null,
    csvActive: row.active || null,
    csvPaymentRef: row.paymentRef || null,
    csvClientName: row.clientName || null,
    csvEmail: null,
    csvPhone: row.phone || null,
  };
}

/** @param {SeriesExpirationRow} row @param {SeriesMatchedBy} matchedBy @param {SeriesMatchStatus} status @param {number | null} [clientId] @param {string | null} [detail] */
function reportRow(row, matchedBy, status, clientId = null, detail = null) {
  return {
    ...metaFromSeriesRow(row),
    csvMatchedBy: matchedBy,
    csvMatchStatus: status,
    mindbodyClientId: clientId,
    csvMatchDetail: detail,
  };
}

/**
 * Phone-only matching for Series Expiration NCS rows.
 *
 * @param {Record<string, string>} staffHeaders
 * @param {SeriesExpirationRow[]} rows
 * @param {number} totalReportRows
 */
export async function matchSeriesExpirationRows(staffHeaders, rows, totalReportRows) {
  /** @type {Array<{ clientId: number; meta: SeedRowReportMeta; row: SeriesExpirationRow }>} */
  const matched = [];
  /** @type {SeedRowReportMeta[]} */
  const unmatched = [];
  /** @type {SeedRowReportMeta[]} */
  const ambiguous = [];

  for (const row of rows) {
    const phoneDigits = digitsOnlyPhone(row.phone);
    if (phoneDigits.length < 10) {
      unmatched.push(reportRow(row, "none", "unmatched", null, "missing_phone"));
      continue;
    }

    const hits = await findClientsByExactPhone(staffHeaders, row.phone);
    if (hits.length === 1) {
      const clientId = clientIdFromRow(hits[0]);
      if (clientId != null) {
        matched.push({
          clientId,
          row,
          meta: {
            ...metaFromSeriesRow(row),
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
  }

  const summary = {
    mindbodySeriesExpirationRows: totalReportRows,
    mindbodySeriesExpirationNcsRows: rows.length,
    mindbodySeriesExpirationMatched: matched.length,
    mindbodySeriesExpirationUnmatched: unmatched.length,
    mindbodySeriesExpirationAmbiguous: ambiguous.length,
  };

  return { matched, unmatched, ambiguous, summary };
}

export const __testing = {
  parseSeriesExpirationReport,
  extractHtmlTableRows,
  isMindbodyHtmlReport,
  isNcsPricingOptionRow,
  digitsOnlyPhone,
};
