/**
 * Admin alert when a /classes purchase completed but auto-book did not.
 */

import { sendResendEmail } from "./resend-email-client.mjs";
import { formatClassWhenEt, isClassStartingSoonEt } from "./mindbody-studio-time.mjs";

/** @returns {string[]} */
function parseAdminRecipients() {
  const raw = (process.env.SMS_ADMIN_REPORT_TO || "").trim();
  if (!raw) return [];
  return raw
    .split(/[,;]+/)
    .map((s) => s.trim())
    .filter((s) => s.includes("@"));
}

/** @returns {string} */
function resolveFromAddress() {
  return (
    (process.env.SMS_ADMIN_REPORT_FROM || "").trim() ||
    (process.env.STAFF_SCHEDULE_EMAIL_FROM || "").trim() ||
    "AMARÉ Reports <reports@amarewellness.com>"
  );
}

/**
 * @param {{
 *   clientName?: string | null;
 *   clientEmail?: string | null;
 *   clientPhone?: string | null;
 *   mindbodyClientId?: number | null;
 *   productName?: string | null;
 *   localSku?: string | null;
 *   orderId?: string | null;
 *   subscriptionId?: string | null;
 *   checkoutSessionId?: string | null;
 *   mindbodySaleId?: string | null;
 *   className?: string | null;
 *   classId?: number | null;
 *   classStartIso?: string | null;
 *   instructorName?: string | null;
 *   failureReason: string;
 *   paymentSucceeded: boolean;
 *   mindbodySyncSucceeded: boolean;
 * }} opts
 */
export function buildClassesBookingFailureAdminEmail(opts) {
  const when = formatClassWhenEt(opts.classStartIso);
  const urgent = isClassStartingSoonEt(opts.classStartIso);
  const subject = urgent
    ? "URGENT — Client purchased but was not booked into an upcoming class"
    : "ACTION REQUIRED — Purchase completed but class booking failed";

  const esc = (s) =>
    String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

  const lines = [
    "A client completed a purchase from the Classes page, but automatic booking was not completed.",
    "",
    "Client:",
    `Name: ${opts.clientName || "—"}`,
    `Email: ${opts.clientEmail || "—"}`,
    `Phone: ${opts.clientPhone || "—"}`,
    `Mindbody Client ID: ${opts.mindbodyClientId ?? "—"}`,
    "",
    "Selected class:",
    `Class: ${opts.className || "—"}`,
    `Date and time: ${when.dateLine}${when.timeLine ? ` at ${when.timeLine}` : ""} (America/New_York)`,
    `Instructor: ${opts.instructorName || "—"}`,
    `Class ID: ${opts.classId ?? "—"}`,
    "",
    "Purchase:",
    `Product: ${opts.productName || opts.localSku || "—"}`,
    `Order: ${opts.orderId || "—"}`,
    `Subscription: ${opts.subscriptionId || "—"}`,
    `Stripe Checkout Session: ${opts.checkoutSessionId || "—"}`,
    `Mindbody Sale: ${opts.mindbodySaleId || "—"}`,
    "",
    "Booking failure:",
    `Reason: ${opts.failureReason}`,
    "",
    `Payment succeeded: ${opts.paymentSucceeded ? "yes" : "no"}`,
    `Mindbody sync succeeded: ${opts.mindbodySyncSucceeded ? "yes" : "no"}`,
    "",
    "The payment and purchase were completed successfully. Please verify availability and manually add the client to the class, or contact the client if the class is no longer available.",
  ];

  const text = lines.join("\n");
  const html = `<pre style="font-family:ui-monospace,Consolas,monospace;font-size:13px;line-height:1.5;white-space:pre-wrap;">${esc(text)}</pre>`;

  return { subject, text, html, urgent };
}

/**
 * @param {Parameters<typeof buildClassesBookingFailureAdminEmail>[0]} opts
 */
export async function sendClassesBookingFailureAdminEmail(opts) {
  const to = parseAdminRecipients();
  const from = resolveFromAddress();
  if (!to.length) {
    return { ok: false, skipped: true, reason: "missing_SMS_ADMIN_REPORT_TO" };
  }
  if (!(process.env.RESEND_API_KEY || "").trim()) {
    return { ok: false, skipped: true, reason: "missing_resend_api_key" };
  }

  const content = buildClassesBookingFailureAdminEmail(opts);
  const result = await sendResendEmail({
    from,
    to,
    subject: content.subject,
    html: content.html,
    text: content.text,
    tags: [{ name: "category", value: "classes_booking_failure_admin" }],
  });

  if (!result.ok) {
    return { ok: false, reason: result.error || "send_failed" };
  }
  return { ok: true, messageId: result.messageId || null };
}
