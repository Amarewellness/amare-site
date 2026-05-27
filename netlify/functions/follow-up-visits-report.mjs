/**
 * Persist / resolve Mindbody Client Visits report for ClassPass follow-up.
 * Separate blob keys from Series Expirations seed report.
 */

import { readFile } from "node:fs/promises";

import { connectLambda, getStore } from "@netlify/blobs";

import {
  VisitsReportFormatError,
  buildClientVisitsReportMeta,
  isXlsxBuffer,
} from "./new-client-sms-client-visits.mjs";

export const VISITS_REPORT_BLOB_KEY = "visits-report/latest";
export const VISITS_REPORT_META_BLOB_KEY = "visits-report/meta";
export const VISITS_REPORT_FORMAT_XLSX = "mindbody_client_visits_xlsx";
export const VISITS_REPORT_FORMAT_HTML = "mindbody_client_visits_html";

/** @param {unknown} event */
function connectBlobStore(event) {
  if (event && typeof event === "object") {
    connectLambda(/** @type {import("@netlify/functions").HandlerEvent} */ (event));
  }
}

/** @type {Map<string, string> | null} */
let visitsReportMemorySingleton = null;

function shouldUseLocalVisitsReportMemory() {
  if ((process.env.NETLIFY || "").trim()) return false;
  const flag = (process.env.NEW_CLIENT_SMS_STORE_LOCAL_MEMORY || "").trim().toLowerCase();
  if (flag === "0" || flag === "false" || flag === "no") return false;
  return true;
}

/**
 * @param {unknown} event
 * @returns {{ mode: string; getText: (key: string) => Promise<string | null>; setText: (key: string, text: string) => Promise<void> } | null}
 */
function openVisitsReportBlobStore(event) {
  if (shouldUseLocalVisitsReportMemory()) {
    if (!visitsReportMemorySingleton) visitsReportMemorySingleton = new Map();
    const backing = visitsReportMemorySingleton;
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
        event: "follow_up_visits_report_store_unavailable",
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
    const part = body.subarray(start + marker.length, next >= 0 ? next : body.length);
    start = next;

    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd < 0) continue;
    const headerBlock = part.subarray(0, headerEnd).toString("utf8");
    const data = part.subarray(headerEnd + 4);
    const trimmed = data.subarray(0, Math.max(0, data.length - 2));

    const nameMatch = headerBlock.match(/name="([^"]+)"/i);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    const filenameMatch = headerBlock.match(/filename="([^"]*)"/i);
    const ctMatch = headerBlock.match(/Content-Type:\s*([^\r\n]+)/i);
    fields[name] = {
      filename: filenameMatch?.[1],
      contentType: ctMatch?.[1]?.trim(),
      data: trimmed,
    };
  }
  return fields;
}

/** @param {Buffer} buffer @param {string | null | undefined} filename */
function detectVisitsReportFormat(buffer, filename) {
  if (isXlsxBuffer(buffer)) return VISITS_REPORT_FORMAT_XLSX;
  const fn = String(filename || "").toLowerCase();
  if (fn.endsWith(".xlsx")) return VISITS_REPORT_FORMAT_XLSX;
  return VISITS_REPORT_FORMAT_HTML;
}

/** @param {string} stored @param {string | null | undefined} format */
function decodeStoredVisitsReport(stored, format) {
  if (format === VISITS_REPORT_FORMAT_XLSX) {
    return Buffer.from(stored, "base64");
  }
  return Buffer.from(stored, "utf8");
}

/** @param {Buffer} buffer @param {string} format */
function encodeStoredVisitsReport(buffer, format) {
  if (format === VISITS_REPORT_FORMAT_XLSX) {
    return buffer.toString("base64");
  }
  return buffer.toString("utf8");
}

/** @param {unknown} event */
function extractMultipartVisitsUpload(event) {
  if (!event || typeof event !== "object" || !event.body) return null;
  const e = /** @type {{ body?: string | null; isBase64Encoded?: boolean; headers?: Record<string, string | undefined> }} */ (
    event
  );
  const contentType = Object.entries(e.headers || {}).find(
    ([k]) => k.toLowerCase() === "content-type",
  )?.[1];
  const boundary = parseMultipartBoundary(contentType);
  if (!boundary) return null;

  const body = readEventBodyBuffer(event);
  const fields = parseMultipartForm(body, boundary);
  const fileField = fields.reportFile || fields.clientVisitsReport || fields.file;
  if (!fileField?.data?.length) return null;

  const format = detectVisitsReportFormat(fileField.data, fileField.filename);
  return {
    buffer: fileField.data,
    format,
    filename: fileField.filename || null,
    source: "multipart_upload",
  };
}

function classpassLookbackDays() {
  const raw = Number(process.env.FOLLOWUP_CLASSPASS_LOOKBACK_DAYS || 60);
  return Number.isFinite(raw) ? Math.max(7, Math.min(Math.trunc(raw), 180)) : 60;
}

/**
 * @typedef {Object} ResolvedVisitsReport
 * @property {Buffer} buffer
 * @property {string} format
 * @property {string | null} [filename]
 * @property {string} source
 */

/**
 * @param {unknown} event
 * @returns {Promise<ResolvedVisitsReport | null>}
 */
export async function resolveVisitsReportContent(event) {
  /** @type {{ body?: string | null; isBase64Encoded?: boolean; headers?: Record<string, string | undefined> }} */
  const e = event && typeof event === "object" ? /** @type {typeof event} */ (event) : {};

  const multipart = extractMultipartVisitsUpload(event);
  if (multipart?.buffer?.length) {
    return multipart;
  }

  if (e.body) {
    const rawBody = readEventBodyBuffer(event);
    const contentType = Object.entries(e.headers || {}).find(
      ([k]) => k.toLowerCase() === "content-type",
    )?.[1];
    const ct = (contentType || "").toLowerCase();
    if (
      ct.includes("spreadsheetml") ||
      ct.includes("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    ) {
      return {
        buffer: rawBody,
        format: VISITS_REPORT_FORMAT_XLSX,
        filename: null,
        source: "post_body_xlsx",
      };
    }
    if (ct.includes("text/html") || ct.includes("application/vnd.ms-excel")) {
      return rawBody.length
        ? {
            buffer: rawBody,
            format: VISITS_REPORT_FORMAT_HTML,
            filename: null,
            source: "post_body_raw",
          }
        : null;
    }

    const raw = e.isBase64Encoded ? rawBody.toString("utf8") : String(e.body);
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        const o = /** @type {Record<string, unknown>} */ (parsed);
        const filename =
          typeof o.reportFilename === "string"
            ? o.reportFilename
            : typeof o.filename === "string"
              ? o.filename
              : null;

        if (typeof o.clientVisitsReportBase64 === "string" && o.clientVisitsReportBase64.trim()) {
          const buffer = Buffer.from(o.clientVisitsReportBase64.trim(), "base64");
          return {
            buffer,
            format: detectVisitsReportFormat(buffer, filename),
            filename,
            source: "post_json_visits_base64",
          };
        }

        for (const [key, source] of [
          ["clientVisitsReport", "post_json_visits"],
          ["visitsReport", "post_json_visits_alt"],
        ]) {
          if (typeof o[key] === "string" && /** @type {string} */ (o[key]).trim()) {
            const text = /** @type {string} */ (o[key]);
            const buffer = Buffer.from(text, "utf8");
            return {
              buffer,
              format: detectVisitsReportFormat(buffer, filename),
              filename,
              source,
            };
          }
        }
      }
    } catch {
      /* not JSON */
    }
  }

  const visitsPath = (process.env.FOLLOWUP_CLIENT_VISITS_REPORT_PATH || "").trim();
  if (visitsPath) {
    try {
      const buffer = await readFile(visitsPath);
      return buffer.length
        ? {
            buffer,
            format: detectVisitsReportFormat(buffer, visitsPath),
            filename: visitsPath.split(/[/\\]/).pop() || null,
            source: "env_visits_path",
          }
        : null;
    } catch (err) {
      console.log(
        JSON.stringify({
          event: "follow_up_visits_report_path_read_failed",
          path: visitsPath,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  let readSavedBlob =
    (process.env.FOLLOWUP_CLIENT_VISITS_REPORT_FROM_BLOB || "").trim() === "1";
  if (!readSavedBlob && e.body) {
    const raw = e.isBase64Encoded
      ? readEventBodyBuffer(event).toString("utf8")
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
    const store = openVisitsReportBlobStore(event);
    if (store) {
      try {
        const metaRaw = await store.getText(VISITS_REPORT_META_BLOB_KEY);
        let format = VISITS_REPORT_FORMAT_HTML;
        if (metaRaw) {
          const meta = JSON.parse(metaRaw);
          if (meta && typeof meta === "object" && typeof meta.format === "string") {
            format = meta.format;
          }
        }
        const blob = await store.getText(VISITS_REPORT_BLOB_KEY);
        if (blob) {
          return {
            buffer: decodeStoredVisitsReport(blob, format),
            format,
            filename: null,
            source: "netlify_blob",
          };
        }
      } catch (err) {
        console.log(
          JSON.stringify({
            event: "follow_up_visits_report_blob_read_failed",
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
 * @param {{ buffer: Buffer; format: string; filename?: string | null; source?: string | null }} payload
 */
export async function persistVisitsReportBlob(event, payload) {
  const { buffer, format } = payload;
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    return { ok: false, error: "empty_report_buffer" };
  }

  let meta;
  try {
    meta = buildClientVisitsReportMeta(buffer, {
      filename: payload.filename ?? null,
      source: payload.source ?? null,
      lookbackDays: classpassLookbackDays(),
    });
  } catch (err) {
    if (err instanceof VisitsReportFormatError) {
      return { ok: false, error: err.code, hint: err.hint };
    }
    throw err;
  }

  if (meta.error) {
    return { ok: false, error: meta.error, hint: meta.hint };
  }

  const store = openVisitsReportBlobStore(event);
  if (!store) {
    return { ok: false, error: "visits_report_store_unavailable" };
  }

  const metaJson = JSON.stringify(meta);
  const stored = encodeStoredVisitsReport(buffer, format);

  await store.setText(VISITS_REPORT_BLOB_KEY, stored);
  await store.setText(VISITS_REPORT_META_BLOB_KEY, metaJson);
  return {
    ok: true,
    key: VISITS_REPORT_BLOB_KEY,
    bytes: buffer.length,
    meta,
    storeMode: store.mode,
  };
}

/**
 * @param {unknown} event
 * @returns {Promise<(Record<string, unknown> & { exists: boolean }) | { exists: false }>}
 */
export async function getVisitsReportBlobStatus(event) {
  const store = openVisitsReportBlobStore(event);
  if (!store) return { exists: false };

  try {
    const metaRaw = await store.getText(VISITS_REPORT_META_BLOB_KEY);
    if (metaRaw) {
      const parsed = JSON.parse(metaRaw);
      if (parsed && typeof parsed === "object") {
        return { exists: true, storeMode: store.mode, .../** @type {Record<string, unknown>} */ (parsed) };
      }
    }

    const latest = await store.getText(VISITS_REPORT_BLOB_KEY);
    if (latest) {
      let format = VISITS_REPORT_FORMAT_HTML;
      if (!latest.trimStart().startsWith("<")) {
        const asBin = Buffer.from(latest, "base64");
        if (isXlsxBuffer(asBin)) format = VISITS_REPORT_FORMAT_XLSX;
      }
      const buffer = decodeStoredVisitsReport(latest, format);
      const meta = buildClientVisitsReportMeta(buffer, { source: "netlify_blob_legacy" });
      await store.setText(VISITS_REPORT_META_BLOB_KEY, JSON.stringify(meta));
      return { exists: true, storeMode: store.mode, ...meta };
    }
  } catch (err) {
    console.log(
      JSON.stringify({
        event: "follow_up_visits_report_status_failed",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
  return { exists: false, storeMode: store.mode };
}

/** @param {unknown} event */
export function shouldPersistVisitsReportFromBody(event) {
  if (!event || typeof event !== "object" || !event.body) return false;
  if (extractMultipartVisitsUpload(event)?.buffer?.length) return true;

  const raw = event.isBase64Encoded
    ? Buffer.from(String(event.body), "base64").toString("utf8")
    : String(event.body);

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const o = /** @type {Record<string, unknown>} */ (parsed);
      if (o.persistVisitsReport === true || o.persistReport === true) return true;
      if (typeof o.clientVisitsReportBase64 === "string" && o.clientVisitsReportBase64.trim()) {
        return true;
      }
      if (typeof o.clientVisitsReport === "string" && o.clientVisitsReport.trim()) return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/** @param {unknown} event */
export function visitsUploadFilenameFromBody(event) {
  const multipart = extractMultipartVisitsUpload(event);
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
