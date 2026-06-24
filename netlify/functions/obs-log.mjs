// @ts-check
import { randomBytes } from "node:crypto";

/**
 * Structured observability logs for Netlify Functions.
 * Emits one JSON line per call: `{ event, requestId, ok, durationMs, ...fields }`.
 */

/** @param {import("@netlify/functions").HandlerEvent | undefined} [event] */
export function createObsContext(event) {
  const headers = event?.headers || {};
  const inbound =
    headers["x-request-id"] ||
    headers["X-Request-Id"] ||
    headers["x-nf-request-id"] ||
    headers["X-Nf-Request-Id"] ||
    null;
  const requestId =
    typeof inbound === "string" && inbound.trim()
      ? inbound.trim().slice(0, 64)
      : randomBytes(8).toString("hex");
  return { requestId, startedAt: Date.now() };
}

/**
 * @param {{ requestId: string; startedAt: number }} ctx
 * @param {string} event
 * @param {Record<string, unknown>} [fields]
 * @param {"info" | "warn" | "error"} [level]
 */
export function obsLog(ctx, event, fields = {}, level = "info") {
  /** @type {Record<string, unknown>} */
  const payload = {
    event,
    requestId: ctx.requestId,
    durationMs: Date.now() - ctx.startedAt,
    ...fields,
  };
  const line = JSON.stringify(payload);
  if (level === "warn") console.warn(line);
  else if (level === "error") console.error(line);
  else console.log(line);
}

/** Domain-only email hint — never log full addresses. */
export function maskEmail(email) {
  if (typeof email !== "string" || !email.trim()) return null;
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  return `***${email.slice(at).toLowerCase()}`;
}

/**
 * Netlify edge cache hint when the function is invoked (may be absent locally).
 * @param {import("@netlify/functions").HandlerEvent | undefined} [event]
 */
export function netlifyCacheHitFromEvent(event) {
  const headers = event?.headers || {};
  const raw =
    headers["x-nf-cache-status"] ||
    headers["X-Nf-Cache-Status"] ||
    headers["netlify-cache-status"] ||
    headers["Netlify-Cache-Status"] ||
    null;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const s = raw.toLowerCase();
  if (s.includes("hit")) return true;
  if (s.includes("miss") || s.includes("bypass") || s.includes("dynamic")) return false;
  return null;
}
