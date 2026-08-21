/**
 * Shared HMAC contract for Netlify → Cloud Run FCM relay.
 * Cloud Run copies the same canonical string. Never logs tokens.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const RELAY_MAX_SKEW_SECONDS = 120;

export function relaySecret() {
  return (process.env.AMARE_PUSH_RELAY_SECRET || "").trim();
}

export function relayUrl() {
  return (process.env.AMARE_PUSH_RELAY_URL || "").trim().replace(/\/$/, "");
}

export function relayConfigured() {
  return Boolean(relayUrl() && relaySecret().length >= 24);
}

export function canonicalRelayPayload(timestamp, rawBody) {
  return `${String(timestamp)}.${String(rawBody)}`;
}

export function signRelayRequest(secret, timestamp, rawBody) {
  return createHmac("sha256", secret).update(canonicalRelayPayload(timestamp, rawBody)).digest("hex");
}

export function relaySignatureValid(secret, timestamp, rawBody, signature) {
  const got = String(signature || "")
    .trim()
    .replace(/^sha256=/i, "");
  if (!secret || !got || !/^[0-9a-f]{64}$/i.test(got)) return false;
  const expected = signRelayRequest(secret, timestamp, rawBody);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(got, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function relayTimestampFresh(timestamp, nowSec = Math.floor(Date.now() / 1000)) {
  const ts = Number(timestamp);
  if (!Number.isInteger(ts) || ts < 1) return false;
  return Math.abs(nowSec - ts) <= RELAY_MAX_SKEW_SECONDS;
}

export function normalizeRelayMessage(message = {}) {
  const title = String(message.title || "").trim();
  const body = String(message.body || "").trim();
  const path = String(message.path || "/my-classes").trim() || "/my-classes";
  const kind = String(message.kind || "").trim();
  const classId = message.classId == null || message.classId === "" ? "" : String(message.classId);
  return {
    title,
    body,
    data: { path, kind, classId },
  };
}

/**
 * @param {string} token
 * @param {{ title?: string, body?: string, path?: string, kind?: string, classId?: unknown }} message
 */
export async function sendViaPushRelay(token, message) {
  const url = relayUrl();
  const secret = relaySecret();
  if (!url || !secret) throw new Error("push_relay_unconfigured");
  const deviceToken = String(token || "").trim();
  if (!deviceToken || deviceToken.length > 4096) throw new Error("invalid_push_token");
  const normalized = normalizeRelayMessage(message);
  if (!normalized.title || !normalized.body) throw new Error("invalid_relay_copy");
  const rawBody = JSON.stringify({
    token: deviceToken,
    title: normalized.title,
    body: normalized.body,
    data: normalized.data,
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = signRelayRequest(secret, timestamp, rawBody);
  const res = await fetch(`${url}/send`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Amare-Relay-Timestamp": timestamp,
      "X-Amare-Relay-Signature": `sha256=${signature}`,
    },
    body: rawBody,
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(String(payload?.error || `relay_${res.status}`).slice(0, 300));
    if (payload?.code) err.code = payload.code;
    throw err;
  }
  return payload.name || payload.messageName || "ok";
}
