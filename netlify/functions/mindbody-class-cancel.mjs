import { fetchMb, jsonResponse, resolveConsumerClient, MB_API_VERSION } from "./mindbody-consumer-lib.mjs";

function parseJsonBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: { "Cache-Control": "no-store" }, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" });
  }

  const body = parseJsonBody(event);
  if (body === null) {
    return jsonResponse(400, { ok: false, error: "invalid_json" });
  }

  const classIdRaw = body.classId ?? body.ClassId;
  const visitIdRaw = body.visitId ?? body.VisitId;

  const classId =
    typeof classIdRaw === "number" ? classIdRaw : typeof classIdRaw === "string" ? parseInt(classIdRaw, 10) : NaN;
  const visitId =
    typeof visitIdRaw === "number"
      ? visitIdRaw
      : typeof visitIdRaw === "string"
        ? parseInt(visitIdRaw, 10)
        : NaN;

  if (!Number.isFinite(classId) || classId <= 0) {
    return jsonResponse(400, { ok: false, error: "missing_class_id" });
  }
  if (!Number.isFinite(visitId) || visitId <= 0) {
    return jsonResponse(400, { ok: false, error: "missing_visit_id" });
  }

  const ctx = await resolveConsumerClient(event);
  if (!ctx.ok) return ctx.response;

  const v = MB_API_VERSION;
  const path = `/public/v${v}/class/removeclientfromclass`;

  /** @type {Record<string, unknown>} */
  const payload = {
    ClientId: ctx.clientId,
    ClassId: classId,
    VisitId: visitId,
  };

  const r = await fetchMb("POST", path, ctx.authHeaders, payload);

  return jsonResponse(r.ok ? 200 : r.status, {
    ok: r.ok,
    status: r.status,
    mindbody: r.data,
    ...(r.ok ? {} : { error: "mindbody_cancel_failed" }),
  });
}
