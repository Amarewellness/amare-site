/**
 * Internal admin email report for New Client SMS dry-run (Resend).
 * Never sends marketing email to clients — team inbox only.
 */

import { sendResendEmail } from "./resend-email-client.mjs";
import { envTruthy, smsTimezone } from "./new-client-sms-lib.mjs";

/** @returns {boolean} */
export function adminReportEmailConfigured() {
  if (!envTruthy("ENABLE_NEW_CLIENT_SMS_ADMIN_EMAIL")) return false;
  if (!(process.env.RESEND_API_KEY || "").trim()) return false;
  return parseAdminReportRecipients().length > 0;
}

/** @returns {string[]} */
export function parseAdminReportRecipients() {
  const raw = (process.env.SMS_ADMIN_REPORT_TO || "").trim();
  if (!raw) return [];
  return [...new Set(raw.split(/[,;]/).map((s) => s.trim()).filter((s) => s.includes("@")))];
}

/** @param {string} s */
function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** @param {unknown} row */
export function recommendedActionForCandidate(row) {
  if (!row || typeof row !== "object") return "Review in Mindbody before outreach.";
  const r = /** @type {Record<string, unknown>} */ (row);
  if (r.followUpPurchaseFound === true) return "No action.";
  const skipReasons = Array.isArray(r.skipReasons) ? r.skipReasons : [];
  if (skipReasons.some((s) => String(s).includes("already_converted"))) {
    return "No action.";
  }
  const consent = String(r.smsConsent || "unknown");
  const wouldSend = r.wouldSend === true;
  if (consent === "explicit_opt_out") {
    return "Do not send marketing SMS. Use email, phone, in-studio conversation, or front desk note.";
  }
  if (consent === "unknown") {
    return "Review SMS consent before outreach.";
  }
  if (consent === "explicit_opt_in" && wouldSend) {
    return "Eligible for SMS. Review and send manually for now.";
  }
  return "Review segment/eligibility before outreach.";
}

/**
 * @param {unknown[]} candidates
 */
function countBySegment(candidates) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const raw of candidates) {
    if (!raw || typeof raw !== "object") continue;
    const seg = String(/** @type {Record<string, unknown>} */ (raw).segment || "unknown");
    out[seg] = (out[seg] || 0) + 1;
  }
  return out;
}

/**
 * @param {unknown[]} candidates
 */
function countSmsConsent(candidates) {
  /** @type {Record<string, number>} */
  const out = { explicit_opt_in: 0, explicit_opt_out: 0, unknown: 0 };
  for (const raw of candidates) {
    if (!raw || typeof raw !== "object") continue;
    const c = String(/** @type {Record<string, unknown>} */ (raw).smsConsent || "unknown");
    if (c in out) out[c] += 1;
    else out.unknown += 1;
  }
  return out;
}

/**
 * @param {unknown[]} candidates
 */
function countBlockReasons(candidates) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const raw of candidates) {
    if (!raw || typeof raw !== "object") continue;
    const r = /** @type {Record<string, unknown>} */ (raw);
    const key = r.blockReason ? String(r.blockReason) : r.wouldSend ? "(none — would send if live)" : "(none)";
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

/** @param {Record<string, number>} map */
function formatCountMap(map) {
  const entries = Object.entries(map);
  if (!entries.length) return "—";
  return entries.map(([k, v]) => `${k}: ${v}`).join(", ");
}

/**
 * @param {object} input
 * @param {Record<string, unknown>} input.summary
 * @param {{ candidates?: unknown[]; csvUnmatchedRows?: unknown[]; csvAmbiguousRows?: unknown[] }} input.report
 */
export function buildAdminReportContent({ summary, report }) {
  const candidates = report.candidates || [];
  const ss = /** @type {Record<string, unknown>} */ (summary.seedSources || {});
  const tz = smsTimezone();
  const runAt = new Date().toLocaleString("en-US", {
    timeZone: tz,
    dateStyle: "medium",
    timeStyle: "short",
  });

  const candidateCount = candidates.length;
  const subject = `AMARÉ New Client Follow-Up Report — ${candidateCount} candidates`;

  const bySegment = countBySegment(candidates);
  const consentCounts = countSmsConsent(candidates);
  const blockCounts = countBlockReasons(candidates);

  const unmatched = Number(ss.mindbodySeriesExpirationUnmatched ?? 0);
  const ambiguous = Number(ss.mindbodySeriesExpirationAmbiguous ?? 0);

  const jsonNote =
    summary.manual === true
      ? "Full JSON: save the POST /api/admin/new-client-sms/run response body (or local-sms-dry-run.json in dev)."
      : "Full JSON: Netlify function logs (new_client_sms_run_summary) or admin POST response when triggered manually.";

  /** @type {string[]} */
  const textLines = [
    "AMARÉ New Client Follow-Up Report (internal — dry-run only)",
    "",
    `Run: ${runAt} (${tz})`,
    `Dry-run: ${summary.dryRun === true ? "yes" : "no"}`,
    `SMS sent this run: ${summary.sent ?? 0} (expected 0 in dry-run)`,
    "",
    "Series Expirations",
    `  Total rows: ${ss.mindbodySeriesExpirationRows ?? 0}`,
    `  NCS rows: ${ss.mindbodySeriesExpirationNcsRows ?? 0}`,
    `  Matched: ${ss.mindbodySeriesExpirationMatched ?? 0}`,
    `  Unmatched: ${unmatched}`,
    `  Ambiguous: ${ambiguous}`,
    "",
    `Evaluated clients: ${summary.evaluatedClients ?? 0}`,
    `Candidates: ${candidateCount}`,
    `Candidates by segment: ${formatCountMap(bySegment)}`,
    `SMS consent (candidates): ${formatCountMap(consentCounts)}`,
    `Block reasons (candidates): ${formatCountMap(blockCounts)}`,
    `ClientServices batch calls: ${summary.clientservicesBatchCalls ?? 0}`,
    "",
    `Unmatched Series Expiration rows: ${unmatched} — review full dry-run JSON (no PII in this email).`,
    `Ambiguous Series Expiration rows: ${ambiguous} — review full dry-run JSON.`,
    "",
    jsonNote,
    "",
    "— Candidates —",
  ];

  for (const raw of candidates) {
    if (!raw || typeof raw !== "object") continue;
    const c = /** @type {Record<string, unknown>} */ (raw);
    textLines.push(
      [
        c.csvClientName || "(name n/a)",
        `ID ${c.mindbodyClientId}`,
        String(c.segment),
        `remaining=${c.remainingVisits}`,
        `consent=${c.smsConsent}`,
        `wouldSend=${c.wouldSend}`,
        c.blockReason ? `block=${c.blockReason}` : "",
        recommendedActionForCandidate(c),
      ]
        .filter(Boolean)
        .join(" | "),
    );
  }

  if (!candidates.length) {
    textLines.push("(No segment-matched candidates this run.)");
  }

  textLines.push(
    "",
    "Internal use only. Do not forward to clients. Live Twilio SMS remains disabled until ops enable explicitly.",
  );

  /** @type {string[]} */
  const tableRows = [];
  for (const raw of candidates) {
    if (!raw || typeof raw !== "object") continue;
    const c = /** @type {Record<string, unknown>} */ (raw);
    const preview = String(c.messageBody || "").slice(0, 160);
    tableRows.push(`<tr>
      <td>${escHtml(c.csvClientName || "—")}</td>
      <td>${escHtml(c.mindbodyClientId)}</td>
      <td>${escHtml(c.segment)}</td>
      <td>${escHtml(c.remainingVisits)}</td>
      <td>${escHtml(c.expirationDate || c.csvExpiration || "—")}</td>
      <td>${escHtml(c.daysToExpiry)}</td>
      <td>${escHtml(c.smsConsent)}</td>
      <td>${c.wouldSend ? "yes" : "no"}</td>
      <td>${escHtml(c.blockReason || "—")}</td>
      <td>…${escHtml(c.phoneLast4 || "—")}</td>
      <td>${escHtml(c.emailDomain || "—")}</td>
      <td>${escHtml(recommendedActionForCandidate(c))}</td>
      <td style="font-size:12px">${escHtml(preview)}</td>
    </tr>`);
  }

  const candidatesTable =
    tableRows.length > 0
      ? `<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:13px">
      <thead><tr>
        <th>Client</th><th>MB ID</th><th>Segment</th><th>Remaining</th><th>Expiration</th><th>Days</th>
        <th>Consent</th><th>Would send</th><th>Block</th><th>Phone</th><th>Email domain</th><th>Action</th><th>Message preview</th>
      </tr></thead>
      <tbody>${tableRows.join("")}</tbody>
    </table>`
      : `<p><em>No segment-matched candidates this run.</em></p>`;

  const html = `<!DOCTYPE html><html><body style="font-family:system-ui,sans-serif;color:#222;max-width:960px">
    <h1 style="font-size:20px">AMARÉ New Client Follow-Up Report</h1>
    <p style="color:#666;font-size:13px"><strong>Internal use only</strong> — dry-run task list for manual follow-up. Not sent to clients.</p>
    <table style="font-size:14px;line-height:1.6">
      <tr><td><strong>Run</strong></td><td>${escHtml(runAt)} (${escHtml(tz)})</td></tr>
      <tr><td><strong>Dry-run</strong></td><td>${summary.dryRun ? "Yes" : "No"}</td></tr>
      <tr><td><strong>SMS sent</strong></td><td>${escHtml(summary.sent ?? 0)} (Twilio disabled in dry-run)</td></tr>
      <tr><td><strong>Series rows</strong></td><td>${escHtml(ss.mindbodySeriesExpirationRows ?? 0)} total · ${escHtml(ss.mindbodySeriesExpirationNcsRows ?? 0)} NCS · matched ${escHtml(ss.mindbodySeriesExpirationMatched ?? 0)} · unmatched ${unmatched} · ambiguous ${ambiguous}</td></tr>
      <tr><td><strong>Evaluated</strong></td><td>${escHtml(summary.evaluatedClients ?? 0)} clients</td></tr>
      <tr><td><strong>Candidates</strong></td><td>${candidateCount} · ${escHtml(formatCountMap(bySegment))}</td></tr>
      <tr><td><strong>Consent</strong></td><td>${escHtml(formatCountMap(consentCounts))}</td></tr>
      <tr><td><strong>Block reasons</strong></td><td>${escHtml(formatCountMap(blockCounts))}</td></tr>
      <tr><td><strong>ClientServices batches</strong></td><td>${escHtml(summary.clientservicesBatchCalls ?? 0)} API call(s)</td></tr>
    </table>
    <p style="font-size:13px">Unmatched/ambiguous Series Expiration rows: <strong>${unmatched}</strong> / <strong>${ambiguous}</strong> — review full dry-run JSON (PII not included here).</p>
    <p style="font-size:13px">${escHtml(jsonNote)}</p>
    <h2 style="font-size:16px;margin-top:24px">Candidates</h2>
    ${candidatesTable}
    <p style="font-size:12px;color:#888;margin-top:24px">Live Twilio SMS and client-facing Resend email are not enabled in this phase.</p>
  </body></html>`;

  return { subject, html, text: textLines.join("\n"), candidateCount };
}

/**
 * Send internal admin report after dry-run. Never sends to client emails.
 *
 * @param {object} input
 * @param {Record<string, unknown>} input.summary
 * @param {{ candidates?: unknown[]; csvUnmatchedRows?: unknown[]; csvAmbiguousRows?: unknown[] }} input.report
 */
export async function sendNewClientSmsAdminReport({ summary, report }) {
  if (summary.dryRun !== true) {
    return { ok: false, skipped: true, reason: "not_dry_run" };
  }
  if (!adminReportEmailConfigured()) {
    return { ok: false, skipped: true, reason: "admin_email_disabled_or_unconfigured" };
  }

  const from =
    (process.env.SMS_ADMIN_REPORT_FROM || "").trim() ||
    "AMARÉ Reports <reports@amarewellness.com>";
  const to = parseAdminReportRecipients();
  const { subject, html, text } = buildAdminReportContent({ summary, report });

  const result = await sendResendEmail({
    from,
    to,
    subject,
    html,
    text,
    tags: [
      { name: "category", value: "new_client_sms_admin_report" },
      { name: "dry_run", value: "true" },
    ],
  });

  if (result.ok) {
    console.log(
      JSON.stringify({
        event: "new_client_sms_admin_report_sent",
        messageId: result.messageId,
        recipientCount: to.length,
        candidateCount: report.candidates?.length ?? 0,
      }),
    );
    return { ok: true, messageId: result.messageId, recipientCount: to.length };
  }

  console.log(
    JSON.stringify({
      event: "new_client_sms_admin_report_failed",
      error: result.error,
      status: result.status,
    }),
  );
  return { ok: false, error: result.error, status: result.status };
}

export const __testing = {
  recommendedActionForCandidate,
  buildAdminReportContent,
  parseAdminReportRecipients,
  adminReportEmailConfigured,
};
