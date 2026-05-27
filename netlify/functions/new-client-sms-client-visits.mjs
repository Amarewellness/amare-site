/**
 * Mindbody Client Visits / Attendance exports for ClassPass repeat-visitor follow-up.
 * Supports HTML (.xls) and real .xlsx workbooks.
 */

import XLSX from "xlsx";

import { digitsOnlyPhone, extractAllHtmlTableRows, isMindbodyHtmlReport } from "./new-client-sms-series-expiration.mjs";

export class VisitsReportFormatError extends Error {
  /** @param {string} code @param {string} hint */
  constructor(code, hint) {
    super(hint);
    this.name = "VisitsReportFormatError";
    this.code = code;
    this.hint = hint;
  }
}

/** @typedef {Object} ClientVisitRow
 * @property {number} rowIndex
 * @property {string} clientName
 * @property {number | null} clientId
 * @property {string} visitDate
 * @property {string} className
 * @property {string} serviceName
 * @property {string} typeTaken
 * @property {string} paymentMethod
 * @property {string} phone
 * @property {string} email
 * @property {string} instructor
 */

/** @param {string} h */
function normalizeHeaderKey(h) {
  return h.replace(/^\uFEFF/, "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** @type {Record<string, string[]>} */
const VISITS_HEADER_ALIASES = {
  clientname: ["client", "client name", "name"],
  clientid: ["client id", "clientid", "mb id", "unique id", "id"],
  visitdate: ["visit date", "date", "start date", "start time", "class date", "signed in date"],
  classname: ["class", "class name", "description", "class description"],
  servicename: [
    "service",
    "pricing option",
    "pricing options",
    "service name",
    "series/name",
    "series / name",
  ],
  typetaken: ["type taken", "type", "visit type", "payment type"],
  paymentmethod: ["payment method", "payment", "paid with"],
  phone: ["phone #", "phone", "mobile phone", "mobile"],
  email: ["email", "e-mail"],
  instructor: ["instructor", "staff", "teacher"],
};

/** @param {string} header */
function canonicalVisitsField(header) {
  const key = normalizeHeaderKey(header);
  for (const [field, aliases] of Object.entries(VISITS_HEADER_ALIASES)) {
    if (aliases.includes(key)) return field;
  }
  return null;
}

/** @param {string} raw */
function parseClientId(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  const n = Number(s.replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

/** @param {ClientVisitRow} row */
export function isClassPassVisitRow(row) {
  const blob = [
    row.serviceName,
    row.typeTaken,
    row.paymentMethod,
    row.className,
    row.clientName,
  ]
    .join(" ")
    .toLowerCase();
  return /\bclass\s*pass\b|\bclasspass\b/.test(blob);
}

/** @param {string} dateStr */
export function parseMindbodyReportDate(dateStr) {
  const s = String(dateStr || "").trim();
  if (!s) return null;
  const iso = Date.parse(s);
  if (!Number.isNaN(iso)) return new Date(iso);
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s|$)/);
  if (m) {
    let year = Number(m[3]);
    if (year < 100) year += 2000;
    const d = new Date(year, Number(m[1]) - 1, Number(m[2]));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** @param {string} html */
export function parseClientVisitsReport(html) {
  const tables = extractAllHtmlTableRows(html);
  if (!tables.length) {
    return { totalRows: 0, headers: [], rows: [], classPassRows: [] };
  }

  for (const tableRows of tables) {
    const parsed = parseClientVisitsTable(tableRows);
    if (parsed.totalRows > 0) return parsed;
  }

  return { totalRows: 0, headers: [], rows: [], classPassRows: [] };
}

/** @param {string[][]} tableRows */
function parseClientVisitsTable(tableRows) {

  let headerRowIndex = -1;
  /** @type {(string | null)[]} */
  let fieldMap = [];
  /** @type {string[]} */
  let headerCells = [];

  for (let i = 0; i < tableRows.length; i += 1) {
    const candidateMap = tableRows[i].map((h) => canonicalVisitsField(h));
    const hasClient = candidateMap.includes("clientname");
    const hasVisitSignal =
      candidateMap.includes("visitdate") ||
      candidateMap.includes("classname") ||
      candidateMap.includes("servicename");
    if (hasClient && hasVisitSignal) {
      headerRowIndex = i;
      fieldMap = candidateMap;
      headerCells = tableRows[i];
      break;
    }
  }

  if (headerRowIndex < 0) {
    return { totalRows: 0, headers: [], rows: [], classPassRows: [] };
  }

  /** @type {ClientVisitRow[]} */
  const rows = [];
  /** @type {ClientVisitRow[]} */
  const classPassRows = [];

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

    /** @type {ClientVisitRow} */
    const row = {
      rowIndex: i,
      clientName: mapped.clientname || "",
      clientId: parseClientId(mapped.clientid),
      visitDate: mapped.visitdate || "",
      className: mapped.classname || "",
      serviceName: mapped.servicename || "",
      typeTaken: mapped.typetaken || "",
      paymentMethod: mapped.paymentmethod || "",
      phone: mapped.phone || "",
      email: mapped.email || "",
      instructor: mapped.instructor || "",
    };
    rows.push(row);
    if (isClassPassVisitRow(row)) classPassRows.push(row);
  }

  return { totalRows: rows.length, headers: headerCells, rows, classPassRows };
}

/** @param {Buffer} buffer */
export function isXlsxBuffer(buffer) {
  return (
    Buffer.isBuffer(buffer) &&
    buffer.length >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    buffer[2] === 0x03 &&
    buffer[3] === 0x04
  );
}

/** @param {string[][]} tableRows */
function isAttendanceAnalysisAggregate(tableRows) {
  for (const row of tableRows.slice(0, 8)) {
    if (!Array.isArray(row)) continue;
    const keys = row.map((c) => normalizeHeaderKey(String(c || "")));
    const joined = keys.join(" ");
    if (
      joined.includes("service time") &&
      joined.includes("paid visits") &&
      !keys.some((k) => k === "client" || k === "client name")
    ) {
      return true;
    }
  }
  return false;
}

/** @param {string[][]} tableRows */
function tableRowsFromXlsxSheet(sheet) {
  return XLSX.utils
    .sheet_to_json(sheet, { header: 1, defval: "", raw: false })
    .map((row) => /** @type {unknown[]} */ (row).map((cell) => String(cell ?? "").trim()));
}

/** @param {Buffer} buffer */
export function parseClientVisitsXlsx(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  /** @type {ReturnType<typeof parseClientVisitsTable> | null} */
  let best = null;

  for (const sheetName of wb.SheetNames) {
    const tableRows = tableRowsFromXlsxSheet(wb.Sheets[sheetName]);
    if (!tableRows.length) continue;

    if (isAttendanceAnalysisAggregate(tableRows)) {
      throw new VisitsReportFormatError(
        "wrong_report_attendance_analysis",
        "This file is Mindbody Attendance Analysis (hourly summary), not per-client visits. Use Mindbody Manager → Reports → Client Visits → export .xlsx or .xls with one row per visit/client.",
      );
    }

    const parsed = parseClientVisitsTable(tableRows);
    if (parsed.totalRows > (best?.totalRows ?? 0)) best = parsed;
  }

  return best || { totalRows: 0, headers: [], rows: [], classPassRows: [] };
}

/**
 * @param {string | Buffer} input
 * @param {{ filename?: string | null }} [opts]
 */
export function parseClientVisitsReportInput(input, opts = {}) {
  if (Buffer.isBuffer(input) && isXlsxBuffer(input)) {
    const parsed = parseClientVisitsXlsx(input);
    if (parsed.totalRows === 0) {
      const fn = String(opts.filename || "").toLowerCase();
      if (fn.includes("attendanceanalysis") || fn.includes("attendance analysis")) {
        throw new VisitsReportFormatError(
          "wrong_report_attendance_analysis",
          "Attendance Analysis reports do not list individual clients. Export Client Visits instead.",
        );
      }
      throw new VisitsReportFormatError(
        "no_client_visit_rows",
        "No per-client visit rows found. Export Mindbody Reports → Client Visits (.xlsx or .xls).",
      );
    }
    return { ...parsed, format: "mindbody_client_visits_xlsx" };
  }

  const text = Buffer.isBuffer(input) ? input.toString("utf8") : String(input || "");
  if (isMindbodyHtmlReport(text)) {
    const parsed = parseClientVisitsReport(text);
    if (parsed.totalRows === 0) {
      throw new VisitsReportFormatError(
        "no_client_visit_rows",
        "No per-client visit rows found in this HTML export. Use Mindbody Client Visits report.",
      );
    }
    return { ...parsed, format: "mindbody_client_visits_html" };
  }

  throw new VisitsReportFormatError(
    "unsupported_report_format",
    "Upload Mindbody Client Visits export (.xlsx, .xls, or HTML table with Client + visit columns).",
  );
}

/**
 * @param {ClientVisitRow[]} classPassRows
 * @param {number} lookbackDays
 */
export function filterClassPassRowsByLookback(classPassRows, lookbackDays) {
  const maxDays = Math.max(1, lookbackDays);
  const now = new Date();
  return classPassRows.filter((row) => {
    const d = parseMindbodyReportDate(row.visitDate);
    if (!d) return true;
    const diffMs = now.getTime() - d.getTime();
    const days = diffMs / (24 * 60 * 60 * 1000);
    return days >= 0 && days <= maxDays;
  });
}

/**
 * @param {ClientVisitRow[]} classPassRows
 * @param {number} minVisits
 */
export function aggregateClassPassClients(classPassRows, minVisits) {
  /** @type {Map<string, { clientName: string; reportClientId: number | null; phone: string; email: string; classPassVisits: number; lastVisitDate: string | null; firstVisitDate: string | null; lastVisitMs: number }>} */
  const byKey = new Map();

  for (const row of classPassRows) {
    const phoneDigits = digitsOnlyPhone(row.phone);
    const key =
      row.clientId != null
        ? `id:${row.clientId}`
        : phoneDigits.length >= 10
          ? `phone:${phoneDigits}`
          : `name:${row.clientName.trim().toLowerCase()}`;
    if (key === "name:") continue;

    const visitMs = parseMindbodyReportDate(row.visitDate)?.getTime() ?? 0;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        clientName: row.clientName || "",
        reportClientId: row.clientId,
        phone: row.phone || "",
        email: row.email || "",
        classPassVisits: 1,
        lastVisitDate: row.visitDate || null,
        firstVisitDate: row.visitDate || null,
        lastVisitMs: visitMs,
      });
      continue;
    }
    existing.classPassVisits += 1;
    if (row.clientName && !existing.clientName) existing.clientName = row.clientName;
    if (row.clientId != null && existing.reportClientId == null) {
      existing.reportClientId = row.clientId;
    }
    if (row.phone && !existing.phone) existing.phone = row.phone;
    if (row.email && !existing.email) existing.email = row.email;
    if (visitMs >= existing.lastVisitMs) {
      existing.lastVisitDate = row.visitDate || existing.lastVisitDate;
      existing.lastVisitMs = visitMs;
    }
    if (visitMs > 0 && (existing.firstVisitDate == null || visitMs < (parseMindbodyReportDate(existing.firstVisitDate)?.getTime() ?? Infinity))) {
      existing.firstVisitDate = row.visitDate;
    }
  }

  return [...byKey.values()]
    .filter((a) => a.classPassVisits >= minVisits)
    .sort((a, b) => b.classPassVisits - a.classPassVisits || b.lastVisitMs - a.lastVisitMs)
    .map(({ lastVisitMs, ...rest }) => rest);
}

/** @param {string | Buffer} reportInput @param {{ filename?: string | null; source?: string | null; lookbackDays?: number | null }} [opts] */
export function buildClientVisitsReportMeta(reportInput, opts = {}) {
  const uploadedAt = new Date().toISOString();
  const size = Buffer.isBuffer(reportInput)
    ? reportInput.length
    : Buffer.byteLength(String(reportInput), "utf8");
  const lookback = Number(opts.lookbackDays) || 60;

  let parsed;
  try {
    parsed = parseClientVisitsReportInput(reportInput, { filename: opts.filename ?? null });
  } catch (err) {
    if (err instanceof VisitsReportFormatError) {
      return {
        uploadedAt,
        filename: opts.filename ?? null,
        size,
        format: err.code,
        totalRows: 0,
        classPassRows: 0,
        classPassClients: 0,
        lookbackDays: lookback,
        uploadSource: opts.source ?? null,
        error: err.code,
        hint: err.hint,
      };
    }
    throw err;
  }

  const filtered = filterClassPassRowsByLookback(parsed.classPassRows, lookback);
  return {
    uploadedAt,
    filename: opts.filename ?? null,
    size,
    format: parsed.format,
    totalRows: parsed.totalRows,
    classPassRows: parsed.classPassRows.length,
    classPassClients: aggregateClassPassClients(filtered, 2).length,
    lookbackDays: lookback,
    uploadSource: opts.source ?? null,
  };
}

export const __testing = {
  parseClientVisitsReport,
  parseClientVisitsReportInput,
  parseClientVisitsXlsx,
  isClassPassVisitRow,
  isAttendanceAnalysisAggregate,
  aggregateClassPassClients,
  filterClassPassRowsByLookback,
};
