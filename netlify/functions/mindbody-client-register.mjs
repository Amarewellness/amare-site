import {
  MB_API_VERSION,
  fetchMb,
  getMindbodyStaffAccessTokenCached,
  jsonResponse,
  mindbodyIssueTokenTimeoutMs,
} from "./mindbody-consumer-lib.mjs";
import { ensureStudioClientTransactionalEmailOptIn } from "./stripe-mindbody-sync-lib.mjs";
import { mindbodyHeaders, mindbodyStaffApiHeaders, mindbodyStaffBearerHeaders } from "./mindbody-upstream.mjs";

/** @param {import("@netlify/functions").HandlerEvent} event */
function parseJsonBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** @param {unknown} val @param {number} maxLen */
function trimField(val, maxLen) {
  if (typeof val !== "string") return "";
  return val.trim().slice(0, maxLen);
}

/** @param {string} email */
function isReasonableEmail(email) {
  if (!email || email.length > 254) return false;
  return /^[^\s@]{1,200}@[^\s@]{1,64}\.[A-Za-z0-9.-]{2,24}$/.test(email);
}

/** @param {unknown} data */
function mindbodyErrorMessage(data) {
  if (!data || typeof data !== "object") return null;
  const d = /** @type {Record<string, unknown>} */ (data);
  const mbErr = d.Error;
  if (mbErr && typeof mbErr === "object") {
    const m = /** @type {{ Message?: unknown }} */ (mbErr).Message;
    if (typeof m === "string" && m.trim()) return m.trim();
  }
  if (typeof d.Message === "string" && d.Message.trim()) return d.Message.trim();

  /** First string message from `{ Errors: [...] }` style payloads */
  const errs = d.Errors ?? d.errors;
  if (Array.isArray(errs)) {
    for (const raw of errs) {
      if (raw != null && typeof raw === "object") {
        const em = /** @type {{ Message?: unknown; Error?: unknown }} */ (raw);
        const s = em.Message ?? em.Error;
        if (typeof s === "string" && s.trim()) return s.trim();
      } else if (typeof raw === "string" && raw.trim()) return raw.trim();
    }
  }
  return null;
}

/** Mindbody duplicate-client / duplicate-email wording varies by site and API version */
function errorHintsDuplicateClient(msg) {
  if (!msg || typeof msg !== "string") return false;
  const s = msg.toLowerCase();
  return (
    /\balready\s+exist/.test(s) ||
    /\bduplicate\b/.test(s) ||
    /\bmust\s+be\s+unique\b/.test(s) ||
    /(email|e-mail).*(\balready\b|\btaken\b|\bin\s+use\b|\bregistered\b|\bassigned\b|\bduplicate\b)/.test(s)
  );
}

/** @param {unknown} data */
function extractNewClientId(data) {
  if (!data || typeof data !== "object") return null;
  const d = /** @type {Record<string, unknown>} */ (data);
  const c = d.Client ?? d.client;
  if (c && typeof c === "object") {
    const o = /** @type {Record<string, unknown>} */ (c);
    const id = o.Id ?? o.id;
    if (id != null && Number.isFinite(Number(id)) && Number(id) > 0) return Number(id);
  }
  const top = d.ClientId ?? d.clientId ?? d.Id;
  if (top != null && Number.isFinite(Number(top)) && Number(top) > 0) return Number(top);
  return null;
}

/**
 * Owner-only: create Mindbody Client via Public API `POST …/client/addclient` using staff User Token.
 * Does not authenticate the visitor — created clients sign in separately with Mindbody OAuth.
 */
export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: { "Cache-Control": "no-store" },
      body: "",
    };
  }
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" });
  }

  if ((process.env.MINDBODY_DISABLE_CLIENT_SIGNUP ?? "").trim() === "1") {
    return jsonResponse(
      503,
      {
        ok: false,
        error: "signup_disabled",
        message: "Online signup is temporarily unavailable.",
      },
      null,
    );
  }

  const base = mindbodyHeaders();
  if (!base) {
    return jsonResponse(503, {
      ok: false,
      error: "mindbody_not_configured",
      message: "Server Mindbody API key is not configured.",
    });
  }

  const body = parseJsonBody(event);
  if (body === null) {
    return jsonResponse(400, { ok: false, error: "invalid_json" });
  }

  const firstName = trimField(body.firstName ?? body.FirstName, 80);
  const lastName = trimField(body.lastName ?? body.LastName, 80);
  const email = trimField(body.email ?? body.Email, 254).toLowerCase();
  const mobilePhone = trimField(body.mobilePhone ?? body.MobilePhone ?? body.phone ?? body.Phone, 32);
  const hp = trimField(body.website ?? body.url ?? "", 20);

  if (hp) {
    return jsonResponse(200, { ok: true, ignored: true });
  }

  if (!firstName || !lastName || !isReasonableEmail(email)) {
    return jsonResponse(400, {
      ok: false,
      error: "invalid_fields",
      message: "First name, last name, and a valid email are required.",
    });
  }

  const staffUser = process.env.MINDBODY_STAFF_USERNAME?.trim();
  const staffPass = process.env.MINDBODY_STAFF_PASSWORD;
  const hasIssueCreds = Boolean(staffUser && typeof staffPass === "string" && staffPass !== "");

  /** @type {Record<string, string> | null} */
  let staffHeaders = null;
  if (hasIssueCreds) {
    const issued = await getMindbodyStaffAccessTokenCached({ issueTimeoutMs: mindbodyIssueTokenTimeoutMs() });
    if (!issued.ok) {
      const code = issued.error;
      const http =
        code === "missing_staff_issue_credentials"
          ? 503
          : typeof issued.status === "number" && issued.status >= 400 && issued.status < 600
            ? issued.status
            : 502;
      return jsonResponse(http, {
        ok: false,
        error: code,
        mindbody: issued.mindbody,
        message:
          code === "staff_token_issue_timeout"
            ? "Staff sign-in to Mindbody timed out — try again shortly."
            : "Could not authorize staff access to Mindbody. Check MINDBODY_STAFF_USERNAME / MINDBODY_STAFF_PASSWORD.",
      });
    }
    staffHeaders = mindbodyStaffBearerHeaders(issued.accessToken);
  } else {
    staffHeaders = mindbodyStaffApiHeaders();
  }

  if (!staffHeaders) {
    return jsonResponse(503, {
      ok: false,
      error: "staff_not_configured",
      message:
        "Server cannot create clients in Mindbody without staff API access. Set MINDBODY_STAFF_USERNAME + MINDBODY_STAFF_PASSWORD (or MINDBODY_STAFF_USER_TOKEN).",
    });
  }

  /** @type {Record<string, unknown>} */
  const clientRow = {
    FirstName: firstName,
    LastName: lastName,
    Email: email,
    Active: true,
    ...(mobilePhone ? { MobilePhone: mobilePhone } : {}),
    SendAccountEmails: true,
    SendScheduleEmails: true,
    SendPromotionalEmails: false,
  };

  /** AddClient payload: most Mindbody examples use `{ Client: { …fields } }`; OpenAPI generators may flatten the same shape to root-level fields instead. */
  const nestedPayload = {
    Client: clientRow,
    Test: false,
    SendAccountEmails: true,
    SendScheduleEmails: true,
    SendPromotionalEmails: false,
  };
  /** @type {Record<string, unknown>} */
  const flatPayload = {
    ...clientRow,
    Test: false,
  };

  const path = `/public/v${MB_API_VERSION}/client/addclient`;
  const postTimeoutMs = Math.min(
    Math.max(parseInt(process.env.MINDBODY_ADD_CLIENT_TIMEOUT_MS || "20000", 10) || 20000, 8000),
    45000,
  );
  let r = await fetchMb("POST", path, staffHeaders, nestedPayload, { timeoutMs: postTimeoutMs });
  if (
    !r.ok &&
    r.status === 400 &&
    typeof r.data === "object" &&
    r.data !== null &&
    !extractNewClientId(r.data)
  ) {
    r = await fetchMb("POST", path, staffHeaders, flatPayload, { timeoutMs: postTimeoutMs });
  }

  if (!r.ok) {
    const detail = mindbodyErrorMessage(r.data);
    const dupHint = errorHintsDuplicateClient(detail);

    /** Duplicate email: HTTP 200 + `ok: false` so the browser/DevTools don’t show a misleading “failed request” red state — the signup form still treats it as an expected outcome. */
    if (dupHint) {
      return jsonResponse(
        200,
        {
          ok: false,
          error: "client_email_already_exists",
          conflict: true,
          message:
            "This email is already linked to a client at this Mindbody studio. Sign in instead.",
          ...(detail ? { mindbodyMessage: detail } : {}),
          mindbody: r.data,
        },
        null,
      );
    }

    const httpStatus = r.status >= 400 && r.status < 600 ? r.status : 502;
    return jsonResponse(
      httpStatus,
      {
        ok: false,
        error: "mindbody_add_client_failed",
        message: detail || "Mindbody could not create this profile.",
        mindbody: r.data,
      },
      null,
    );
  }

  const newId = extractNewClientId(r.data);
  if (newId != null) {
    const opt = await ensureStudioClientTransactionalEmailOptIn(staffHeaders, newId);
    if (!opt.ok) {
      console.warn(
        JSON.stringify({
          event: "mindbody_client_transactional_email_opt_in_failed",
          clientId: newId,
          via: "client_register",
          reason: opt.reason,
        }),
      );
    }
  }
  return jsonResponse(200, {
    ok: true,
    clientId: newId ?? undefined,
    message: "Profile created in Mindbody. Sign in with your email to finish booking.",
  });
}
