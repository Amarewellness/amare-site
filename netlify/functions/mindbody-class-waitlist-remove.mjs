import { MB_API_VERSION, fetchMb, jsonResponse, resolveConsumerClient, consumerAuthExtraHeaders } from "./mindbody-consumer-lib.mjs";
import { withMobileCorsHandler } from "./mobile-api-cors.mjs";

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
 * @param {unknown} data
 */
function summarizeMindbodyError(data) {
  if (!data || typeof data !== "object") return null;
  const d = /** @type {Record<string, unknown>} */ (data);
  const inner = d.Error && typeof d.Error === "object" ? /** @type {Record<string, unknown>} */ (d.Error) : null;
  const message =
    (inner && typeof inner.Message === "string" ? inner.Message : null) ??
    (typeof d.Message === "string" ? d.Message : null) ??
    null;
  return message ? message.slice(0, 200) : null;
}

/** @param {unknown} data */
function removeAlreadyGone(data) {
  const msg = (summarizeMindbodyError(data) || "").toLowerCase();
  if (!msg) return false;
  return (
    /\binvalid\b/.test(msg) ||
    /\bno longer exists?\b/.test(msg) ||
    /\bnot found\b/.test(msg) ||
    /\balready deleted\b/.test(msg) ||
    /\bdoes not exist\b/.test(msg)
  );
}

async function waitlistRemoveHandler(event) {
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

  const entryRaw = body.waitlistEntryId ?? body.WaitlistEntryId ?? body.waitlistEntryIds;
  let entryId = NaN;
  if (Array.isArray(entryRaw) && entryRaw.length > 0) {
    entryId = Number(entryRaw[0]);
  } else {
    entryId =
      typeof entryRaw === "number"
        ? entryRaw
        : typeof entryRaw === "string"
          ? parseInt(entryRaw, 10)
          : NaN;
  }

  if (!Number.isFinite(entryId) || entryId <= 0) {
    return jsonResponse(400, { ok: false, error: "missing_waitlist_entry_id" });
  }

  const ctx = await resolveConsumerClient(event);
  if (!ctx.ok) return ctx.response;

  const v = MB_API_VERSION;
  const q = new URLSearchParams();
  q.append("request.waitlistEntryIds", String(entryId));

  const r = await fetchMb("POST", `/public/v${v}/class/removefromwaitlist?${q}`, ctx.authHeaders, null);

  const alreadyGone = !r.ok && removeAlreadyGone(r.data);
  console.log(
    JSON.stringify({
      event: "class_waitlist_remove",
      waitlistEntryId: entryId,
      clientId: ctx.clientId,
      ok: r.ok || alreadyGone,
      status: r.status,
      alreadyGone,
      mindbodyErrorMessage: summarizeMindbodyError(r.data),
    }),
  );

  const cookieHdr = consumerAuthExtraHeaders(ctx);
  if (r.ok || alreadyGone) {
    return jsonResponse(
      200,
      {
        ok: true,
        waitlistEntryId: entryId,
        message: alreadyGone
          ? "You’re no longer on the waitlist for this class."
          : "Removed from the waitlist.",
        alreadyRemoved: alreadyGone,
      },
      cookieHdr,
    );
  }

  return jsonResponse(
    r.status,
    {
      ok: false,
      error: "mindbody_waitlist_remove_failed",
      message: summarizeMindbodyError(r.data) || "Could not leave the waitlist.",
    },
    cookieHdr,
  );
}

export const handler = withMobileCorsHandler(waitlistRemoveHandler);
