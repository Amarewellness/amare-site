import {
  MB_API_VERSION,
  fetchMb,
  jsonResponse,
  resolveConsumerClient,
} from "./mindbody-consumer-lib.mjs";

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

/**
 * @returns {Promise<number|null>}
 */
async function pickClientServiceId(clientId, authHeaders) {
  const v = MB_API_VERSION;
  const q = new URLSearchParams({
    "request.clientId": String(clientId),
    "request.showActiveOnly": "true",
    "request.limit": "100",
  });
  const r = await fetchMb("GET", `/public/v${v}/client/clientservices?${q}`, authHeaders, null);
  if (!r.ok || !r.data || typeof r.data !== "object") return null;
  const d = /** @type {Record<string, unknown>} */ (r.data);
  const arr = /** @type {unknown[]} */ (
    Array.isArray(d.ClientServices) ? d.ClientServices : Array.isArray(d.clientServices) ? d.clientServices : []
  );
  for (const raw of arr) {
    const s = /** @type {Record<string, unknown>} */ (raw);
    const rem = s.Remaining ?? s.remaining;
    if (typeof rem === "number" && rem > 0) {
      const sid = s.Id ?? s.id;
      if (sid != null && Number.isFinite(Number(sid))) return Number(sid);
    }
  }
  return null;
}

/**
 * Trims a Mindbody response down to just the operator-relevant message + status hint, so
 * production logs aren't polluted with the full PascalCase body for every booking attempt.
 * @param {unknown} data
 */
function summarizeMindbodyBookError(data) {
  if (!data || typeof data !== "object") return null;
  const d = /** @type {Record<string, unknown>} */ (data);
  const inner = d.Error && typeof d.Error === "object" ? /** @type {Record<string, unknown>} */ (d.Error) : null;
  const message =
    (inner && typeof inner.Message === "string" ? inner.Message : null) ??
    (typeof d.Message === "string" ? d.Message : null) ??
    null;
  const code = inner && typeof inner.Code === "string" ? inner.Code : null;
  return { message: message ? message.slice(0, 200) : null, code };
}

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: { "Cache-Control": "no-store" }, body: "" };
  }
  if (event.httpMethod !== "POST") {
    console.warn(JSON.stringify({ event: "class_book_method_not_allowed", httpMethod: event.httpMethod }));
    return jsonResponse(405, { ok: false, error: "method_not_allowed" });
  }

  const body = parseJsonBody(event);
  if (body === null) {
    console.warn(JSON.stringify({ event: "class_book_invalid_json" }));
    return jsonResponse(400, { ok: false, error: "invalid_json" });
  }

  const classIdRaw = body.classId ?? body.ClassId;
  const classId =
    typeof classIdRaw === "number" ? classIdRaw : typeof classIdRaw === "string" ? parseInt(classIdRaw, 10) : NaN;
  if (!Number.isFinite(classId) || classId <= 0) {
    console.warn(JSON.stringify({ event: "class_book_missing_class_id", classIdRaw }));
    return jsonResponse(400, { ok: false, error: "missing_class_id" });
  }

  const svcRaw = body.clientServiceId ?? body.ClientServiceId;
  let clientServiceId =
    typeof svcRaw === "number"
      ? svcRaw
      : typeof svcRaw === "string" && svcRaw.trim()
        ? parseInt(svcRaw, 10)
        : null;
  if (clientServiceId != null && !Number.isFinite(clientServiceId)) clientServiceId = null;

  console.log(
    JSON.stringify({
      event: "class_book_request",
      classId,
      clientServiceIdProvided: clientServiceId,
    }),
  );

  const ctx = await resolveConsumerClient(event);
  if (!ctx.ok) {
    /**
     * Resolution failures are logged in detail by `resolveConsumerClient` itself
     * (`consumer_resolve_client_not_linked` / `not_authenticated` / `token_refresh_failed`).
     * Re-emit a slim correlation log so the booking attempt is traceable end-to-end.
     */
    const status = typeof ctx.response.statusCode === "number" ? ctx.response.statusCode : 500;
    console.warn(
      JSON.stringify({
        event: "class_book_resolve_failed",
        classId,
        status,
      }),
    );
    return ctx.response;
  }

  console.log(
    JSON.stringify({
      event: "class_book_resolved_client",
      classId,
      clientId: ctx.clientId,
      email: ctx.email,
    }),
  );

  const v = MB_API_VERSION;
  const path = `/public/v${v}/class/addclienttoclass`;

  /** @param {number | undefined} cs */
  async function tryBook(cs) {
    /** @type {Record<string, unknown>} */
    const payload = {
      ClientId: ctx.clientId,
      ClassId: classId,
      SendEmail: true,
      Waitlist: false,
      Test: false,
    };
    if (cs != null) payload.ClientServiceId = cs;
    return fetchMb("POST", path, ctx.authHeaders, payload);
  }

  let r = await tryBook(clientServiceId ?? undefined);
  let attemptedClientServiceFallback = false;
  if (!r.ok && clientServiceId == null) {
    const picked = await pickClientServiceId(ctx.clientId, ctx.authHeaders);
    if (picked != null) {
      attemptedClientServiceFallback = true;
      console.log(
        JSON.stringify({
          event: "class_book_client_service_fallback_picked",
          classId,
          clientId: ctx.clientId,
          pickedClientServiceId: picked,
        }),
      );
      r = await tryBook(picked);
    }
  }

  const summary = summarizeMindbodyBookError(r.data);
  console.log(
    JSON.stringify({
      event: "class_book_response",
      classId,
      clientId: ctx.clientId,
      ok: r.ok,
      status: r.status,
      attemptedClientServiceFallback,
      mindbodyErrorMessage: summary?.message ?? null,
      mindbodyErrorCode: summary?.code ?? null,
    }),
  );

  const cookieHdr = ctx.setCookie ? { "Set-Cookie": ctx.setCookie } : {};
  return jsonResponse(
    r.ok ? 200 : r.status,
    {
      ok: r.ok,
      status: r.status,
      mindbody: r.data,
      ...(r.ok ? {} : { error: "mindbody_book_failed" }),
    },
    cookieHdr,
  );
}
