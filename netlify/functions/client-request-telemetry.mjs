/**
 * Optional client-supplied request diagnostics (book/cancel bodies).
 *
 * TRUST MODEL: Never use these fields for authentication, authorization, Mindbody
 * identity, eligibility, LateCancel, attendance fees, Stripe, or rate limits.
 * Values may be spoofed; they exist only for structured production logs.
 */

const MAX_VERSION_LEN = 32;
const MAX_BUILD_LEN = 16;
const MAX_REQUEST_ID_LEN = 64;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * @typedef {{
 *   clientSource: "mobile" | "web" | null;
 *   platform: "ios" | "android" | null;
 *   appVersion: string | null;
 *   buildNumber: string | null;
 *   clientRequestId: string | null;
 * }} ClientRequestTelemetry
 */

/** @returns {ClientRequestTelemetry} */
export function emptyClientRequestTelemetry() {
  return {
    clientSource: null,
    platform: null,
    appVersion: null,
    buildNumber: null,
    clientRequestId: null,
  };
}

/**
 * @param {unknown} body
 * @returns {ClientRequestTelemetry}
 */
export function parseClientRequestTelemetry(body) {
  if (!body || typeof body !== "object") return emptyClientRequestTelemetry();
  const b = /** @type {Record<string, unknown>} */ (body);
  /** @type {ClientRequestTelemetry} */
  const out = emptyClientRequestTelemetry();

  const src = typeof b.clientSource === "string" ? b.clientSource.trim().toLowerCase() : "";
  if (src === "mobile" || src === "web") out.clientSource = src;

  const plat = typeof b.platform === "string" ? b.platform.trim().toLowerCase() : "";
  if (plat === "ios" || plat === "android") out.platform = plat;

  const verRaw = b.appVersion;
  if (typeof verRaw === "string" && verRaw.trim()) {
    out.appVersion = verRaw.trim().slice(0, MAX_VERSION_LEN);
  } else if (typeof verRaw === "number" && Number.isFinite(verRaw)) {
    out.appVersion = String(verRaw).slice(0, MAX_VERSION_LEN);
  }

  const buildRaw = b.buildNumber;
  if (typeof buildRaw === "string" && buildRaw.trim()) {
    out.buildNumber = buildRaw.trim().slice(0, MAX_BUILD_LEN);
  } else if (typeof buildRaw === "number" && Number.isFinite(buildRaw)) {
    out.buildNumber = String(Math.trunc(buildRaw)).slice(0, MAX_BUILD_LEN);
  }

  const rid = typeof b.clientRequestId === "string" ? b.clientRequestId.trim() : "";
  if (
    rid &&
    rid.length <= MAX_REQUEST_ID_LEN &&
    (UUID_RE.test(rid) || /^[a-zA-Z0-9_-]{8,64}$/.test(rid))
  ) {
    out.clientRequestId = rid;
  }

  return out;
}

/**
 * @param {ClientRequestTelemetry | null | undefined} telemetry
 */
export function clientTelemetryLogFields(telemetry) {
  if (!telemetry) {
    return {
      clientSource: null,
      platform: null,
      appVersion: null,
      buildNumber: null,
      clientRequestId: null,
    };
  }
  return {
    clientSource: telemetry.clientSource,
    platform: telemetry.platform,
    appVersion: telemetry.appVersion,
    buildNumber: telemetry.buildNumber,
    clientRequestId: telemetry.clientRequestId,
  };
}

/**
 * @param {ClientRequestTelemetry | null | undefined} telemetry
 */
export function clientSourceForLog(telemetry) {
  return telemetry?.clientSource ?? "unknown";
}
