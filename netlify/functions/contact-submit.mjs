/**
 * POST /api/contact
 * Public contact form from the website and the AMARÉ app.
 */

import { sendResendEmail } from "./resend-email-client.mjs";
import { jsonResponse } from "./mindbody-consumer-lib.mjs";
import { withMobileCorsHandler } from "./mobile-api-cors.mjs";

/** @param {unknown} event */
function parseJsonBody(event) {
  if (!event || typeof event !== "object") return {};
  const e = /** @type {{ body?: unknown; isBase64Encoded?: boolean }} */ (event);
  if (e.body == null || e.body === "") return {};
  const raw = e.isBase64Encoded
    ? Buffer.from(/** @type {string} */ (e.body), "base64").toString("utf8")
    : /** @type {string} */ (e.body);
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** @param {unknown} v @param {number} max */
function clip(v, max) {
  return String(v ?? "").trim().slice(0, max);
}

function looksLikeEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function adminRecipients() {
  const raw = (process.env.SMS_ADMIN_REPORT_TO || process.env.CONTACT_FORM_TO || "").trim();
  if (raw) {
    return raw
      .split(/[,;]+/)
      .map((s) => s.trim())
      .filter((s) => s.includes("@"));
  }
  return ["info@amarewellness.com"];
}

function fromAddress() {
  return (
    (process.env.RESEND_FROM || "").trim() ||
    (process.env.SMS_ADMIN_REPORT_FROM || "").trim() ||
    "AMARÉ Wellness Studio <info@amarewellness.com>"
  );
}

/** @param {unknown} s */
function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** @param {import("@netlify/functions").HandlerEvent} event */
async function handleContactSubmit(event) {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" });
  }

  const body = parseJsonBody(event);
  if (body == null || typeof body !== "object") {
    return jsonResponse(400, { ok: false, error: "invalid_json" });
  }
  const rec = /** @type {Record<string, unknown>} */ (body);
  if (clip(rec.botField || rec["bot-field"], 80)) {
    return jsonResponse(200, { ok: true, noop: true });
  }

  const name = clip(rec.name, 120);
  const email = clip(rec.email, 160).toLowerCase();
  const topic = clip(rec.topic, 40) || "general";
  const message = clip(rec.message, 4000);
  if (!name) return jsonResponse(400, { ok: false, error: "Enter your name." });
  if (!looksLikeEmail(email)) return jsonResponse(400, { ok: false, error: "Enter a valid email." });
  if (message.length < 2) return jsonResponse(400, { ok: false, error: "Enter a short message." });

  const to = adminRecipients();
  const mail = await sendResendEmail({
    from: fromAddress(),
    to,
    replyTo: email,
    subject: `AMARÉ contact — ${topic} — ${name}`,
    text: `Name: ${name}\nEmail: ${email}\nTopic: ${topic}\n\n${message}`,
    html: `<p><strong>Name:</strong> ${esc(name)}</p>
<p><strong>Email:</strong> ${esc(email)}</p>
<p><strong>Topic:</strong> ${esc(topic)}</p>
<p>${esc(message).replace(/\n/g, "<br />")}</p>`,
  });
  if (!mail.ok) {
    console.warn(JSON.stringify({ event: "contact_submit_email_failed", error: mail.error }));
    return jsonResponse(503, {
      ok: false,
      error: "We couldn’t send that right now. Please call or WhatsApp the studio.",
    });
  }
  return jsonResponse(200, { ok: true });
}

export const handler = withMobileCorsHandler(handleContactSubmit);
