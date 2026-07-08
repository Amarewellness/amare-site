/**
 * POST /api/mindbody/classes/anonymous-book-intent
 *
 * Seals HttpOnly cookie proving the buyer opened Express checkout from `/classes`
 * as a guest for a specific class — enables deferred book after anonymous purchase.
 */

import { jsonResponse } from "./mindbody-consumer-lib.mjs";
import {
  anonymousBookIntentSetCookieHeader,
  buildAnonymousBookIntentPayload,
  classStartIsoHasPassed,
} from "./mindbody-pending-book-intent-lib.mjs";

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: { "Cache-Control": "no-store" }, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" });
  }

  let body = {};
  try {
    body = event.body
      ? JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body)
      : {};
  } catch {
    return jsonResponse(400, { ok: false, error: "invalid_json" });
  }

  const classIdRaw = body.classId ?? body.ClassId;
  const classId =
    typeof classIdRaw === "number"
      ? classIdRaw
      : typeof classIdRaw === "string"
        ? parseInt(classIdRaw, 10)
        : NaN;
  const classStartIso = typeof body.classStartIso === "string" ? body.classStartIso.trim() : "";
  if (!Number.isFinite(classId) || classId <= 0 || !classStartIso) {
    return jsonResponse(400, { ok: false, error: "invalid_class" });
  }
  if (body.source !== "book" || body.waitlist === true) {
    return jsonResponse(400, { ok: false, error: "invalid_scope" });
  }
  if (classStartIsoHasPassed(classStartIso)) {
    return jsonResponse(400, { ok: false, error: "class_past" });
  }

  const payload = buildAnonymousBookIntentPayload({
    classId: Math.trunc(classId),
    classStartIso,
    className: typeof body.className === "string" ? body.className.slice(0, 160) : undefined,
    selectedDayKey: typeof body.selectedDayKey === "string" ? body.selectedDayKey.slice(0, 32) : undefined,
  });

  console.log(
    JSON.stringify({
      event: "anonymous_book_intent_sealed",
      classId: payload.classId,
      classStartIso: payload.classStartIso,
    }),
  );

  return jsonResponse(
    200,
    { ok: true, classId: payload.classId, expiresAt: new Date(payload.expiresAt).toISOString() },
    { "Set-Cookie": anonymousBookIntentSetCookieHeader(payload, event.headers) },
  );
}
