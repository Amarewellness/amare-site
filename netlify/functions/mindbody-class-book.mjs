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
  const classId =
    typeof classIdRaw === "number" ? classIdRaw : typeof classIdRaw === "string" ? parseInt(classIdRaw, 10) : NaN;
  if (!Number.isFinite(classId) || classId <= 0) {
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

  const ctx = await resolveConsumerClient(event);
  if (!ctx.ok) return ctx.response;

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
  if (!r.ok && clientServiceId == null) {
    const picked = await pickClientServiceId(ctx.clientId, ctx.authHeaders);
    if (picked != null) {
      r = await tryBook(picked);
    }
  }

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
