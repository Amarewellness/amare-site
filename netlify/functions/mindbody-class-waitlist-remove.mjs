import { MB_API_VERSION, fetchMb, jsonResponse, consumerAuthExtraHeaders } from "./mindbody-consumer-lib.mjs";
import { withLambdaMobileCors } from "./amare-lambda-mobile-cors.mjs";
import { withMobileCorsHandler } from "./mobile-api-cors.mjs";
import { resolveStudioCustomer } from "./amare-studio-lib.mjs";
import { waitlistEntryOwnedByClient } from "./mindbody-class-book-lib.mjs";

/**
 * AMARÉ-linked (authSource=amare) uses Staff headers from resolveStudioCustomer.
 * Mindbody (authSource=mindbody) keeps the Consumer path.
 * Leave-waitlist must not require mb_sess or consumerAssociated for Email OTP.
 *
 * @param {"amare" | "mindbody" | string | null | undefined} authSource
 */
export function waitlistRemoveAuthMode(authSource) {
  return authSource === "amare" ? "staff" : "consumer";
}

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

  const ctx = await resolveStudioCustomer(event);
  if (!ctx.ok) return ctx.response;

  const cookieHdrFor = () =>
    ctx.authSource === "mindbody" && ctx.consumerCtx ? consumerAuthExtraHeaders(ctx.consumerCtx) : {};

  const owned = await waitlistEntryOwnedByClient({
    clientId: ctx.clientId,
    waitlistEntryId: entryId,
    authHeaders: ctx.authHeaders,
  });
  if (!owned) {
    return jsonResponse(403, { ok: false, error: "waitlist_entry_not_owned" }, cookieHdrFor());
  }

  const v = MB_API_VERSION;
  const q = new URLSearchParams();
  q.append("request.waitlistEntryIds", String(entryId));

  const authMode = waitlistRemoveAuthMode(ctx.authSource);
  const r = await fetchMb("POST", `/public/v${v}/class/removefromwaitlist?${q}`, ctx.authHeaders, null);

  const alreadyGone = !r.ok && removeAlreadyGone(r.data);
  console.log(
    JSON.stringify({
      event: "class_waitlist_remove",
      waitlistEntryId: entryId,
      clientId: ctx.clientId,
      authSource: ctx.authSource,
      authMode,
      ok: r.ok || alreadyGone,
      status: r.status,
      alreadyGone,
      mindbodyErrorMessage: summarizeMindbodyError(r.data),
    }),
  );

  const cookieHdr = cookieHdrFor();
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

export const lambdaHandler = withMobileCorsHandler(waitlistRemoveHandler);
export default withLambdaMobileCors(lambdaHandler);
