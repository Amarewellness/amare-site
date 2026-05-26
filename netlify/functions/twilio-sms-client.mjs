/**
 * Minimal Twilio SMS client (REST API via fetch — no npm dependency).
 *
 * Disabled unless caller passes explicit send approval after env gates.
 */

/**
 * @param {string} name
 * @returns {boolean}
 */
function envTruthy(name) {
  const v = (process.env[name] || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** @returns {{ configured: boolean; accountSid: string; authToken: string; fromNumber: string }} */
export function twilioConfigFromEnv() {
  return {
    configured: Boolean(
      (process.env.TWILIO_ACCOUNT_SID || "").trim() &&
        (process.env.TWILIO_AUTH_TOKEN || "").trim() &&
        (process.env.TWILIO_FROM_NUMBER || "").trim(),
    ),
    accountSid: (process.env.TWILIO_ACCOUNT_SID || "").trim(),
    authToken: (process.env.TWILIO_AUTH_TOKEN || "").trim(),
    fromNumber: (process.env.TWILIO_FROM_NUMBER || "").trim(),
  };
}

/**
 * Global send gate — all must pass for live SMS.
 * @returns {{ allowed: boolean; reasons: string[] }}
 */
export function twilioSendAllowedByEnv() {
  /** @type {string[]} */
  const reasons = [];
  if (!envTruthy("ENABLE_NEW_CLIENT_SMS_AUTOMATION")) {
    reasons.push("automation_disabled");
  }
  if (envTruthy("NEW_CLIENT_SMS_DRY_RUN")) {
    reasons.push("dry_run");
  }
  if (!envTruthy("ENABLE_NEW_CLIENT_SMS_SENDING")) {
    reasons.push("sending_disabled");
  }
  const cfg = twilioConfigFromEnv();
  if (!cfg.configured) {
    reasons.push("twilio_not_configured");
  }
  return { allowed: reasons.length === 0, reasons };
}

/**
 * @param {string} phone E.164 preferred
 * @param {string} body
 * @returns {Promise<{ ok: true; messageSid: string } | { ok: false; error: string; status?: number }>}
 */
export async function sendTwilioSms(phone, body) {
  const gate = twilioSendAllowedByEnv();
  if (!gate.allowed) {
    return { ok: false, error: `send_blocked:${gate.reasons.join(",")}` };
  }

  const cfg = twilioConfigFromEnv();
  const to = (phone || "").trim();
  const text = (body || "").trim();
  if (!to) return { ok: false, error: "missing_to_phone" };
  if (!text) return { ok: false, error: "missing_body" };
  if (text.length > 1600) return { ok: false, error: "body_too_long" };

  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(cfg.accountSid)}/Messages.json`;
  const params = new URLSearchParams();
  params.set("To", to);
  params.set("From", cfg.fromNumber);
  params.set("Body", text);

  const auth = Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString("base64");

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
  } catch (e) {
    return {
      ok: false,
      error: `twilio_fetch_failed:${String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 120)}`,
    };
  }

  /** @type {unknown} */
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    const msg =
      data && typeof data === "object"
        ? String(/** @type {{ message?: string }} */ (data).message || res.status)
        : String(res.status);
    return { ok: false, error: `twilio_error:${msg.slice(0, 200)}`, status: res.status };
  }

  const sid =
    data && typeof data === "object"
      ? String(/** @type {{ sid?: string }} */ (data).sid || "")
      : "";
  if (!sid) return { ok: false, error: "twilio_missing_sid", status: res.status };
  return { ok: true, messageSid: sid };
}
