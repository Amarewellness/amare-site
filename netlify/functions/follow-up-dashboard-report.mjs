/**
 * Combined internal follow-up dashboard email (Resend) — team inbox only.
 */

import { sendResendEmail } from "./resend-email-client.mjs";
import { envTruthy, smsTimezone } from "./new-client-sms-lib.mjs";
import {
  parseAdminReportRecipients,
  recommendedActionForCandidate,
} from "./new-client-sms-admin-report.mjs";
import { recommendedActionForLowCredits } from "./follow-up-low-credits-lib.mjs";
import { recommendedActionForClassPass } from "./follow-up-classpass-lib.mjs";

/** @returns {boolean} */
export function followUpDashboardEmailConfigured() {
  if (!envTruthy("ENABLE_FOLLOWUP_DASHBOARD_ADMIN_EMAIL") && !envTruthy("ENABLE_NEW_CLIENT_SMS_ADMIN_EMAIL")) {
    return false;
  }
  if (!(process.env.RESEND_API_KEY || "").trim()) return false;
  return parseAdminReportRecipients().length > 0;
}

/** @param {string} s */
function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** @param {unknown[]} candidates @param {(row: Record<string, unknown>) => string} actionFn */
function countConsent(candidates, actionFn) {
  /** @type {Record<string, number>} */
  const consent = { explicit_opt_in: 0, explicit_opt_out: 0, unknown: 0 };
  for (const raw of candidates) {
    if (!raw || typeof raw !== "object") continue;
    const c = String(/** @type {Record<string, unknown>} */ (raw).smsConsent || "unknown");
    if (c in consent) consent[c] += 1;
    else consent.unknown += 1;
  }
  return consent;
}

/** @param {Record<string, number>} map */
function formatCountMap(map) {
  const entries = Object.entries(map || {});
  if (!entries.length) return "—";
  return entries.map(([k, v]) => `${k}: ${v}`).join(", ");
}

/**
 * @param {object} input
 * @param {Record<string, unknown> | null | undefined} input.newClient
 * @param {Record<string, unknown> | null | undefined} input.lowCredits
 * @param {Record<string, unknown> | null | undefined} input.classPass
 */
export function buildFollowUpDashboardReportContent({ newClient, lowCredits, classPass }) {
  const tz = smsTimezone();
  const runAt = new Date().toLocaleString("en-US", {
    timeZone: tz,
    dateStyle: "medium",
    timeStyle: "short",
  });

  const ncCandidates = /** @type {unknown[]} */ (
    newClient?.report && typeof newClient.report === "object"
      ? /** @type {{ candidates?: unknown[] }} */ (newClient.report).candidates || []
      : []
  );
  const lcCandidates = /** @type {unknown[]} */ (
    lowCredits?.report && typeof lowCredits.report === "object"
      ? /** @type {{ candidates?: unknown[] }} */ (lowCredits.report).candidates || []
      : []
  );
  const cpCandidates = /** @type {unknown[]} */ (
    classPass?.report && typeof classPass.report === "object"
      ? /** @type {{ candidates?: unknown[] }} */ (classPass.report).candidates || []
      : []
  );

  const ncCount = ncCandidates.length;
  const lcCount = lcCandidates.length;
  const cpCount = cpCandidates.length;
  const total = ncCount + lcCount + cpCount;
  const subject = `AMARÉ Daily Follow-Up Report — ${total} clients`;

  /** @type {string[]} */
  const textLines = [
    "AMARÉ Daily Follow-Up Report (internal — report-only)",
    "",
    `Run: ${runAt} (${tz})`,
    "Dry-run / report-only: yes — no customer messages sent from this system.",
    "",
    "Summary by category",
    `  New Client: ${ncCount}`,
    `  Low Credits: ${lcCount}`,
    `  ClassPass Repeat: ${cpCount}`,
    `  Frequent Non-Members: 0 (not yet implemented)`,
    `  Lapsed Clients: 0 (not yet implemented)`,
    "",
    `SMS consent (New Client candidates): ${formatCountMap(countConsent(ncCandidates, recommendedActionForCandidate))}`,
    `SMS consent (Low Credits candidates): ${formatCountMap(countConsent(lcCandidates, recommendedActionForLowCredits))}`,
    `SMS consent (ClassPass candidates): ${formatCountMap(countConsent(cpCandidates, recommendedActionForClassPass))}`,
    "",
    "— New Client candidates —",
  ];

  for (const raw of ncCandidates) {
    if (!raw || typeof raw !== "object") continue;
    const c = /** @type {Record<string, unknown>} */ (raw);
    textLines.push(
      [
        c.csvClientName || "(name n/a)",
        `ID ${c.mindbodyClientId}`,
        String(c.segment),
        `remaining=${c.remainingVisits}`,
        `consent=${c.smsConsent}`,
        recommendedActionForCandidate(c),
      ].join(" | "),
    );
  }
  if (!ncCount) textLines.push("(none)");

  textLines.push("", "— Low Credits candidates —");
  for (const raw of lcCandidates) {
    if (!raw || typeof raw !== "object") continue;
    const c = /** @type {Record<string, unknown>} */ (raw);
    textLines.push(
      [
        c.csvClientName || "(name n/a)",
        `ID ${c.mindbodyClientId}`,
        String(c.packName || "pack"),
        `remaining=${c.remainingVisits}`,
        `consent=${c.smsConsent}`,
        recommendedActionForLowCredits(c),
      ].join(" | "),
    );
  }
  if (!lcCount) textLines.push("(none)");

  textLines.push("", "— ClassPass Repeat candidates —");
  for (const raw of cpCandidates) {
    if (!raw || typeof raw !== "object") continue;
    const c = /** @type {Record<string, unknown>} */ (raw);
    textLines.push(
      [
        c.csvClientName || "(name n/a)",
        `ID ${c.mindbodyClientId}`,
        `classPassVisits=${c.classPassVisits}`,
        `lastVisit=${c.lastVisitDate || "—"}`,
        `consent=${c.smsConsent}`,
        recommendedActionForClassPass(c),
      ].join(" | "),
    );
  }
  if (!cpCount) textLines.push("(none)");

  textLines.push("", "Internal use only. Do not forward to clients.");

  /** @param {unknown[]} rows @param {"new_client"|"low_credits"|"classpass"} kind */
  function tableSection(rows, kind) {
    if (!rows.length) {
      const label =
        kind === "new_client"
          ? "New Client"
          : kind === "low_credits"
            ? "Low Credits"
            : "ClassPass Repeat";
      return `<p><em>No ${label} candidates this run.</em></p>`;
    }
    const trs = rows
      .map((raw) => {
        if (!raw || typeof raw !== "object") return "";
        const c = /** @type {Record<string, unknown>} */ (raw);
        const action =
          kind === "new_client"
            ? recommendedActionForCandidate(c)
            : kind === "low_credits"
              ? recommendedActionForLowCredits(c)
              : recommendedActionForClassPass(c);
        const label =
          kind === "new_client"
            ? String(c.segment || "—")
            : kind === "low_credits"
              ? String(c.packName || "pack")
              : `${c.classPassVisits ?? "—"} visits`;
        const expiryOrVisit =
          kind === "classpass" ? c.lastVisitDate || "—" : c.expirationDate || c.csvExpiration || "—";
        const remaining =
          kind === "classpass" ? c.classPassVisits : c.remainingVisits;
        return `<tr>
          <td>${escHtml(c.csvClientName || "—")}</td>
          <td>${escHtml(c.mindbodyClientId)}</td>
          <td>${escHtml(label)}</td>
          <td>${escHtml(remaining)}</td>
          <td>${escHtml(expiryOrVisit)}</td>
          <td>${escHtml(c.smsConsent)}</td>
          <td>…${escHtml(c.phoneLast4 || "—")}</td>
          <td>${escHtml(c.emailDomain || "—")}</td>
          <td>${escHtml(action)}</td>
          <td style="font-size:12px">${escHtml(String(c.messageBody || "").slice(0, 140))}</td>
        </tr>`;
      })
      .join("");
    return `<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:13px;width:100%">
      <thead><tr>
        <th>Client</th><th>MB ID</th><th>Category detail</th><th>Remaining</th><th>Expiration</th>
        <th>Consent</th><th>Phone</th><th>Email domain</th><th>Recommended action</th><th>Message preview</th>
      </tr></thead><tbody>${trs}</tbody></table>`;
  }

  const html = `<!DOCTYPE html><html><body style="font-family:system-ui,sans-serif;color:#222;max-width:960px">
    <h1 style="font-size:20px">AMARÉ Daily Follow-Up Report</h1>
    <p style="color:#666;font-size:13px"><strong>Internal use only</strong> — decision support for manual follow-up. No customer messages sent.</p>
    <table style="font-size:14px;line-height:1.6">
      <tr><td><strong>Run</strong></td><td>${escHtml(runAt)} (${escHtml(tz)})</td></tr>
      <tr><td><strong>Status</strong></td><td>Report-only / dry-run</td></tr>
      <tr><td><strong>Total candidates</strong></td><td>${total}</td></tr>
      <tr><td><strong>New Client</strong></td><td>${ncCount}</td></tr>
      <tr><td><strong>Low Credits</strong></td><td>${lcCount}</td></tr>
      <tr><td><strong>ClassPass Repeat</strong></td><td>${cpCount}</td></tr>
    </table>
    <h2 style="font-size:16px;margin-top:24px">New Client (${ncCount})</h2>
    ${tableSection(ncCandidates, "new_client")}
    <h2 style="font-size:16px;margin-top:24px">Low Credits (${lcCount})</h2>
    ${tableSection(lcCandidates, "low_credits")}
    <h2 style="font-size:16px;margin-top:24px">ClassPass Repeat (${cpCount})</h2>
    ${tableSection(cpCandidates, "classpass")}
    <p style="font-size:12px;color:#888;margin-top:24px">Phase 1 — no live SMS or customer-facing email.</p>
  </body></html>`;

  return { subject, html, text: textLines.join("\n"), totalCount: total, counts: { newClient: ncCount, lowCredits: lcCount, classPass: cpCount } };
}

/**
 * @param {object} input
 * @param {Record<string, unknown> | null | undefined} input.newClient
 * @param {Record<string, unknown> | null | undefined} input.lowCredits
 * @param {Record<string, unknown> | null | undefined} input.classPass
 */
export async function sendFollowUpDashboardReport({ newClient, lowCredits, classPass }) {
  if (!followUpDashboardEmailConfigured()) {
    return { ok: false, skipped: true, reason: "email_not_configured" };
  }
  const content = buildFollowUpDashboardReportContent({ newClient, lowCredits, classPass });
  const recipients = parseAdminReportRecipients();
  const from = (process.env.SMS_ADMIN_REPORT_FROM || process.env.RESEND_FROM || "").trim();
  if (!from) return { ok: false, skipped: true, reason: "missing_from_address" };

  const res = await sendResendEmail({
    from,
    to: recipients,
    subject: content.subject,
    html: content.html,
    text: content.text,
  });
  return {
    ok: res.ok,
    messageId: res.messageId || null,
    recipientCount: recipients.length,
    totalCount: content.totalCount,
    counts: content.counts,
    error: res.ok ? null : res.error || "send_failed",
  };
}
