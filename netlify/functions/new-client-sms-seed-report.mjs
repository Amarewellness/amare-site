/**
 * Resolve Mindbody seed report content (Series Expirations .xls HTML or CSV).
 */

import { readFile } from "node:fs/promises";

import { connectLambda, getStore } from "@netlify/blobs";

import {
  isMindbodyHtmlReport,
  parseSeriesExpirationReport,
} from "./new-client-sms-series-expiration.mjs";

export const SEED_REPORT_BLOB_KEY = "seed-report/latest";
export const SEED_REPORT_META_BLOB_KEY = "seed-report/meta";

/**
 * @typedef {Object} SeedReportMeta
 * @property {string} uploadedAt
 * @property {string | null} filename
 * @property {number} size
 * @property {string} format
 * @property {number | null} totalRows
 * @property {number | null} ncsRows
 * @property {{ min: string | null; max: string | null } | null} [reportDateRange]
 * @property {string | null} [uploadSource]
 */

/** @param {unknown} event */
function connectBlobStore(event) {
  if (event && typeof event === "object") {
    connectLambda(/** @type {import("@netlify/functions").HandlerEvent} */ (event));
  }
}

/** @type {Map<string, string> | null} */
let seedReportMemorySingleton = null;

function shouldUseLocalSeedReportMemory() {
  if ((process.env.NETLIFY || "").trim()) return false;
  const flag = (process.env.NEW_CLIENT_SMS_STORE_LOCAL_MEMORY || "").trim().toLowerCase();
  if (flag === "0" || flag === "false" || flag === "no") return false;
  // Local dev default: in-memory seed report (no Netlify Blobs context in npm run dev).
  return true;
}

/**
 * @param {unknown} event
 * @returns {{ mode: string; getText: (key: string) => Promise<string | null>; setText: (key: string, text: string) => Promise<void> } | null}
 */
function openSeedReportBlobStore(event) {
  if (shouldUseLocalSeedReportMemory()) {
    if (!seedReportMemorySingleton) seedReportMemorySingleton = new Map();
    const backing = seedReportMemorySingleton;
    return {
      mode: "local_memory",
      async getText(key) {
        return backing.get(key) ?? null;
      },
      async setText(key, text) {
        backing.set(key, text);
      },
    };
  }

  try {
    connectBlobStore(event);
    const store = getStore("new-client-sms-records");
    return {
      mode: "netlify_blobs",
      async getText(key) {
        const blob = await store.get(key, { type: "text" });
        if (blob == null) return null;
        const text = String(blob);
        return text.trim() ? text : null;
      },
      async setText(key, text) {
        await store.set(key, text);
      },
    };
  } catch (err) {
    console.log(
      JSON.stringify({
        event: "new_client_sms_seed_report_store_unavailable",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return null;
  }
}

/** @param {unknown} event */
function readEventBodyBuffer(event) {
  /** @type {{ body?: string | null; isBase64Encoded?: boolean }} */
  const e = event && typeof event === "object" ? /** @type {typeof event} */ (event) : {};
  if (!e.body) return Buffer.alloc(0);
  return e.isBase64Encoded
    ? Buffer.from(String(e.body), "base64")
    : Buffer.from(String(e.body), "utf8");
}

/** @param {string | undefined} contentType */
function parseMultipartBoundary(contentType) {
  const ct = String(contentType || "");
  const match = ct.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
  return match ? (match[1] || match[2] || "").trim() : null;
}

/**
 * @param {Buffer} body
 * @param {string} boundary
 */
function parseMultipartForm(body, boundary) {
  /** @type {Record<string, { filename?: string; contentType?: string; data: Buffer }>} */
  const fields = {};
  const marker = Buffer.from(`--${boundary}`);
  let start = body.indexOf(marker);
  if (start < 0) return fields;

  while (start >= 0) {
    const next = body.indexOf(marker, start + marker.length);
    if (next < 0) break;
    const part = body.subarray(start + marker.length, next);
    start = next;

    if (part.length < 4) continue;
    const trimmed = part.subarray(part[0] === 13 && part[1] === 10 ? 2 : 0);
    if (trimmed.length >= 2 && trimmed[0] === 45 && trimmed[1] === 45) continue;

    const headerEnd = trimmed.indexOf("\r\n\r\n");
    if (headerEnd < 0) continue;
    const headerText = trimmed.subarray(0, headerEnd).toString("utf8");
    let data = trimmed.subarray(headerEnd + 4);
    if (data.length >= 2 && data[data.length - 2] === 13 && data[data.length - 1] === 10) {
      data = data.subarray(0, data.length - 2);
    }

    const disposition = headerText.match(/content-disposition:[^\r\n]*/i)?.[0] || "";
    const nameMatch = disposition.match(/name="([^"]+)"/i);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    const filenameMatch = disposition.match(/filename="([^"]*)"/i);
    const partContentType = headerText.match(/content-type:[^\r\n]*/i)?.[0]?.split(":")[1]?.trim();

    fields[name] = {
      filename: filenameMatch ? filenameMatch[1] : undefined,
      contentType: partContentType,
      data,
    };
  }

  return fields;
}

/**
 * @param {unknown} event
 * @returns {{ text: string; source: string; filename?: string | null } | null}
 */
export function extractMultipartSeedUpload(event) {
  /** @type {{ headers?: Record<string, string | undefined> }} */
  const e = event && typeof event === "object" ? /** @type {typeof event} */ (event) : {};
  const contentType = Object.entries(e.headers || {}).find(
    ([k]) => k.toLowerCase() === "content-type",
  )?.[1];
  const ct = String(contentType || "").toLowerCase();
  if (!ct.includes("multipart/form-data")) return null;

  const boundary = parseMultipartBoundary(contentType);
  if (!boundary) return null;

  const body = readEventBodyBuffer(event);
  if (!body.length) return null;

  const fields = parseMultipartForm(body, boundary);
  for (const key of ["report", "seriesExpirationReport", "reportFile", "file"]) {
    const part = fields[key];
    if (!part?.data?.length) continue;
    const text = part.data.toString("utf8").trim();
    if (!text) continue;
    return {
      text,
      source: "post_multipart",
      filename: part.filename || null,
    };
  }
  return null;
}

/** @param {string[]} dates */
function computeReportDateRange(dates) {
  /** @type {Date[]} */
  const parsed = [];
  for (const raw of dates) {
    const s = String(raw || "").trim();
    if (!s) continue;
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) parsed.push(d);
  }
  if (!parsed.length) return null;
  parsed.sort((a, b) => a.getTime() - b.getTime());
  const fmt = (d) =>
    d.toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" });
  return { min: fmt(parsed[0]), max: fmt(parsed[parsed.length - 1]) };
}

/**
 * @param {string} reportText
 * @param {{ filename?: string | null; source?: string | null }} [opts]
 * @returns {SeedReportMeta}
 */
export function buildSeedReportMeta(reportText, opts = {}) {
  const uploadedAt = new Date().toISOString();
  const size = Buffer.byteLength(reportText, "utf8");
  /** @type {SeedReportMeta} */
  const meta = {
    uploadedAt,
    filename: opts.filename ?? null,
    size,
    format: "unknown",
    totalRows: null,
    ncsRows: null,
    reportDateRange: null,
    uploadSource: opts.source ?? null,
  };

  if (isMindbodyHtmlReport(reportText)) {
    meta.format = "mindbody_series_expiration_html";
    const parsed = parseSeriesExpirationReport(reportText);
    meta.totalRows = parsed.totalRows;
    meta.ncsRows = parsed.ncsRows.length;
    meta.reportDateRange = computeReportDateRange(parsed.ncsRows.map((r) => r.expirationDate));
    return meta;
  }

  const trimmed = reportText.trim();
  if (trimmed.includes(",") && trimmed.includes("\n")) {
    meta.format = "csv";
    meta.totalRows = Math.max(0, trimmed.split(/\r?\n/).filter((l) => l.trim()).length - 1);
  }

  return meta;
}

/**
 * @param {unknown} event
 * @returns {Promise<{ text: string; source: string } | null>}
 */
export async function resolveSeedReportContent(event) {
  /** @type {{ body?: string | null; isBase64Encoded?: boolean; headers?: Record<string, string | undefined> }} */
  const e = event && typeof event === "object" ? /** @type {typeof event} */ (event) : {};

  const multipart = extractMultipartSeedUpload(event);
  if (multipart?.text) {
    return { text: multipart.text, source: multipart.source };
  }

  if (e.body) {
    const raw = e.isBase64Encoded
      ? Buffer.from(String(e.body), "base64").toString("utf8")
      : String(e.body);
    const contentType = Object.entries(e.headers || {}).find(
      ([k]) => k.toLowerCase() === "content-type",
    )?.[1];
    const ct = (contentType || "").toLowerCase();
    if (ct.includes("text/html") || ct.includes("application/vnd.ms-excel")) {
      return raw.trim() ? { text: raw, source: "post_body_raw" } : null;
    }
    if (ct.includes("text/csv") || ct.includes("text/plain")) {
      return raw.trim() ? { text: raw, source: "post_body_csv" } : null;
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        const o = /** @type {Record<string, unknown>} */ (parsed);
        for (const [key, source] of [
          ["seriesExpirationReport", "post_json_series"],
          ["introOffersCsv", "post_json_csv"],
        ]) {
          if (typeof o[key] === "string" && /** @type {string} */ (o[key]).trim()) {
            return { text: /** @type {string} */ (o[key]), source };
          }
        }
        for (const [key, source] of [
          ["seriesExpirationReportBase64", "post_json_series_base64"],
          ["introOffersCsvBase64", "post_json_csv_base64"],
        ]) {
          if (typeof o[key] === "string" && /** @type {string} */ (o[key]).trim()) {
            return {
              text: Buffer.from(/** @type {string} */ (o[key]), "base64").toString("utf8"),
              source,
            };
          }
        }
      }
    } catch {
      /* not JSON */
    }
  }

  const seriesPath = (process.env.NEW_CLIENT_SMS_SERIES_EXPIRATION_REPORT_PATH || "").trim();
  if (seriesPath) {
    try {
      const text = (await readFile(seriesPath, "utf8")).trim();
      return text ? { text, source: "env_series_path" } : null;
    } catch (err) {
      console.log(
        JSON.stringify({
          event: "new_client_sms_series_report_path_read_failed",
          path: seriesPath,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  const csvPath = (process.env.NEW_CLIENT_SMS_INTRO_OFFERS_CSV_PATH || "").trim();
  if (csvPath) {
    try {
      const text = (await readFile(csvPath, "utf8")).trim();
      return text ? { text, source: "env_csv_path" } : null;
    } catch (err) {
      console.log(
        JSON.stringify({
          event: "new_client_sms_intro_csv_path_read_failed",
          path: csvPath,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  const inlineSeries = (process.env.NEW_CLIENT_SMS_SERIES_EXPIRATION_REPORT || "").trim();
  if (inlineSeries) return { text: inlineSeries, source: "env_series_inline" };

  const inlineCsv = (process.env.NEW_CLIENT_SMS_INTRO_OFFERS_CSV || "").trim();
  if (inlineCsv) return { text: inlineCsv, source: "env_csv_inline" };

  let readSavedBlob = (process.env.NEW_CLIENT_SMS_SEED_REPORT_FROM_BLOB || process.env.NEW_CLIENT_SMS_INTRO_OFFERS_CSV_FROM_BLOB || "").trim() === "1";
  if (!readSavedBlob && e.body) {
    const raw = e.isBase64Encoded
      ? Buffer.from(String(e.body), "base64").toString("utf8")
      : String(e.body);
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        const o = /** @type {Record<string, unknown>} */ (parsed);
        if (o.useSavedReport === true || o.useSavedReport === 1 || o.useSavedReport === "1") {
          readSavedBlob = true;
        }
      }
    } catch {
      /* ignore */
    }
  }

  if (readSavedBlob) {
    const store = openSeedReportBlobStore(event);
    if (store) {
      try {
        const blob = await store.getText(SEED_REPORT_BLOB_KEY);
        if (blob) return { text: blob, source: "netlify_blob" };
      } catch (err) {
        console.log(
          JSON.stringify({
            event: "new_client_sms_seed_report_blob_read_failed",
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }
  }

  return null;
}

/**
 * @param {unknown} event
 * @param {string} reportText
 * @param {{ filename?: string | null; source?: string | null }} [opts]
 */
export async function persistSeedReportBlob(event, reportText, opts = {}) {
  if (typeof reportText !== "string" || !reportText.trim()) {
    return { ok: false, error: "empty_report_text" };
  }

  const store = openSeedReportBlobStore(event);
  if (!store) {
    return { ok: false, error: "seed_report_store_unavailable" };
  }

  const meta = buildSeedReportMeta(reportText, opts);
  const metaJson = JSON.stringify(meta);
  if (typeof metaJson !== "string") {
    return { ok: false, error: "seed_report_meta_serialize_failed" };
  }

  await store.setText(SEED_REPORT_BLOB_KEY, reportText);
  await store.setText(SEED_REPORT_META_BLOB_KEY, metaJson);
  return {
    ok: true,
    key: SEED_REPORT_BLOB_KEY,
    bytes: meta.size,
    meta,
    storeMode: store.mode,
  };
}

/**
 * @param {unknown} event
 * @returns {Promise<(SeedReportMeta & { exists: boolean }) | { exists: false }>}
 */
export async function getSeedReportBlobStatus(event) {
  const store = openSeedReportBlobStore(event);
  if (!store) return { exists: false };

  try {
    const metaRaw = await store.getText(SEED_REPORT_META_BLOB_KEY);
    if (metaRaw) {
      const parsed = JSON.parse(metaRaw);
      if (parsed && typeof parsed === "object") {
        return { exists: true, storeMode: store.mode, .../** @type {SeedReportMeta} */ (parsed) };
      }
    }

    const latest = await store.getText(SEED_REPORT_BLOB_KEY);
    if (latest) {
      const meta = buildSeedReportMeta(latest, { source: "netlify_blob_legacy" });
      await store.setText(SEED_REPORT_META_BLOB_KEY, JSON.stringify(meta));
      return { exists: true, storeMode: store.mode, ...meta };
    }
  } catch (err) {
    console.log(
      JSON.stringify({
        event: "new_client_sms_seed_report_status_failed",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
  return { exists: false, storeMode: store.mode };
}

/** @param {unknown} event */
export function shouldPersistSeedReportFromBody(event) {
  if (!event || typeof event !== "object" || !event.body) return false;

  if (extractMultipartSeedUpload(event)?.text) return true;

  const raw = event.isBase64Encoded
    ? Buffer.from(String(event.body), "base64").toString("utf8")
    : String(event.body);

  const contentType = Object.entries(event.headers || {}).find(
    ([k]) => k.toLowerCase() === "content-type",
  )?.[1];
  const ct = String(contentType || "").toLowerCase();
  if (
    ct.includes("text/html") ||
    ct.includes("application/vnd.ms-excel") ||
    ct.includes("text/csv")
  ) {
    return raw.trim().length > 0;
  }

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const o = /** @type {Record<string, unknown>} */ (parsed);
      const flags = [o.persistSeedReport, o.persistIntroOffersCsv, o.persistSeriesExpirationReport];
      if (flags.some((v) => v === true || v === 1 || v === "1")) return true;
      if (typeof o.seriesExpirationReport === "string" && o.seriesExpirationReport.trim()) {
        return true;
      }
      if (typeof o.introOffersCsv === "string" && o.introOffersCsv.trim()) return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/** @param {unknown} event */
export function seedUploadFilenameFromBody(event) {
  const multipart = extractMultipartSeedUpload(event);
  if (multipart?.filename) return multipart.filename;

  if (!event || typeof event !== "object" || !event.body) return null;
  const raw = event.isBase64Encoded
    ? Buffer.from(String(event.body), "base64").toString("utf8")
    : String(event.body);
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const o = /** @type {Record<string, unknown>} */ (parsed);
      if (typeof o.filename === "string" && o.filename.trim()) return o.filename.trim();
      if (typeof o.reportFilename === "string" && o.reportFilename.trim()) {
        return o.reportFilename.trim();
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}
