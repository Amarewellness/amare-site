/**
 * Minimal Resend REST client — internal transactional email only.
 * @see https://resend.com/docs/api-reference/emails/send-email
 */

/**
 * @param {object} opts
 * @param {string} opts.from
 * @param {string | string[]} opts.to
 * @param {string} opts.subject
 * @param {string} opts.html
 * @param {string} [opts.text]
 * @param {string} [opts.replyTo]
 * @param {{ name: string; value: string }[]} [opts.tags]
 */
export async function sendResendEmail(opts) {
  const apiKey = (process.env.RESEND_API_KEY || "").trim();
  if (!apiKey) {
    return { ok: false, error: "missing_resend_api_key" };
  }

  /** @type {string[]} */
  const toList = (Array.isArray(opts.to) ? opts.to : [opts.to])
    .map((a) => String(a || "").trim())
    .filter((a) => a.includes("@"));
  if (!toList.length) {
    return { ok: false, error: "missing_recipients" };
  }

  /** @type {Record<string, unknown>} */
  const body = {
    from: opts.from,
    to: toList,
    subject: opts.subject,
    html: opts.html,
  };
  if (opts.text) body.text = opts.text;
  if (opts.replyTo) body.reply_to = opts.replyTo;
  if (opts.tags?.length) body.tags = opts.tags;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    /** @type {unknown} */
    let data = null;
    const raw = await res.text();
    if (raw) {
      try {
        data = JSON.parse(raw);
      } catch {
        data = { raw: raw.slice(0, 500) };
      }
    }
    if (!res.ok) {
      const msg =
        data && typeof data === "object" && "message" in data
          ? String(/** @type {{ message?: unknown }} */ (data).message)
          : `http_${res.status}`;
      return { ok: false, error: msg, status: res.status, data };
    }
    const messageId =
      data && typeof data === "object" && "id" in data
        ? String(/** @type {{ id?: unknown }} */ (data).id)
        : null;
    return { ok: true, messageId, status: res.status };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
