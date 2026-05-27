/**
 * Weekly front desk schedule emails to assigned staff (Resend).
 * Internal staff addresses only — gated by ENABLE_STAFF_SCHEDULE_ADMIN_EMAIL.
 */

import { sendResendEmail } from "./resend-email-client.mjs";
import { formatWeekOfLabel, formatWeekRangeLabel, slotDisplayLabel } from "./staff-schedule-lib.mjs";

const STUDIO_NAME = "AMARÉ Wellness Studio";
const STUDIO_PHONE = "(954) 258-9238";
const FF = "'DM Sans','Helvetica Neue',Helvetica,Arial,sans-serif";
const FF_SERIF = "'Fraunces','Cormorant Garamond',Georgia,'Times New Roman',serif";

/** @param {string} key */
function envTruthy(key) {
  const v = (process.env[key] || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** @returns {boolean} */
export function staffScheduleEmailConfigured() {
  if (!envTruthy("ENABLE_STAFF_SCHEDULE_ADMIN_EMAIL")) return false;
  if (!(process.env.RESEND_API_KEY || "").trim()) return false;
  return Boolean(resolveFromAddress());
}

/** @returns {string[]} */
export function parseStaffScheduleAdminNotifyRecipients() {
  const dedicated = (process.env.STAFF_SCHEDULE_ADMIN_NOTIFY_TO || "").trim();
  const raw = dedicated || (process.env.SMS_ADMIN_REPORT_TO || "").trim();
  if (!raw) return [];
  return [...new Set(raw.split(/[,;]/).map((s) => s.trim()).filter((s) => s.includes("@")))];
}

/** @returns {boolean} */
export function staffScheduleAdminNotifyConfigured() {
  if (!staffScheduleEmailConfigured()) return false;
  return parseStaffScheduleAdminNotifyRecipients().length > 0;
}

/** @returns {string} */
function resolveFromAddress() {
  return (
    (process.env.STAFF_SCHEDULE_EMAIL_FROM || process.env.SMS_ADMIN_REPORT_FROM || "").trim()
  );
}

/** @returns {string} */
function resolveStudioSiteUrl() {
  const direct = (process.env.STAFF_SCHEDULE_CLASSES_URL || "").trim();
  if (direct) return direct.replace(/\/classes\/?$/, "");
  const site = (process.env.SITE_URL || "").trim().replace(/\/$/, "");
  if (site) return site;
  return "https://www.amarewellness.com";
}

/** @returns {string} Absolute URL to the live class schedule page. */
export function resolveClassesScheduleUrl() {
  const direct = (process.env.STAFF_SCHEDULE_CLASSES_URL || "").trim();
  if (direct) return direct.replace(/\/$/, "");
  const site = resolveStudioSiteUrl();
  return `${site}/classes`;
}

/** @param {string} s */
function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** @param {string | null | undefined} start @param {string | null | undefined} end */
function formatTimeRange(start, end) {
  const fmt = (t) => {
    if (!t) return "";
    const [hh, mm] = t.split(":").map((x) => parseInt(x, 10));
    const h12 = hh % 12 || 12;
    const ap = hh >= 12 ? "PM" : "AM";
    return mm ? `${h12}:${String(mm).padStart(2, "0")}\u00a0${ap}` : `${h12}\u00a0${ap}`;
  };
  if (!start && !end) return "";
  return `${fmt(start)}\u2013${fmt(end)}`;
}

/** @param {string} slot */
function slotOrder(slot) {
  if (slot === "early_morning") return 0;
  if (slot === "morning") return 1;
  if (slot === "evening") return 2;
  return 9;
}

/** @param {string} previewText */
function emailShellStart(previewText) {
  const site = escHtml(resolveStudioSiteUrl());
  const logo = escHtml(`${resolveStudioSiteUrl()}/logo/logo-amare-wellness-studio.png`);
  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml"><head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>AMARÉ Front Desk Schedule</title>
</head><body style="margin:0;padding:0;background-color:#faf3eb;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#faf3eb;">${escHtml(previewText)}</div>
<table role="presentation" style="background-color:#faf3eb;" width="100%" border="0" cellspacing="0" cellpadding="0"><tbody><tr>
<td style="padding:32px 16px;" align="center">
<table role="presentation" style="max-width:600px;width:100%;background-color:#ffffff;border:1px solid rgba(43,38,34,0.08);border-radius:8px;" width="600" border="0" cellspacing="0" cellpadding="0"><tbody>
<tr><td style="padding:32px 32px 18px 32px;" align="center">
<a href="${site}" style="text-decoration:none;">
<img src="${logo}" alt="${escHtml(STUDIO_NAME)}" width="200" style="display:block;width:200px;max-width:100%;height:auto;border:0;outline:none;" />
</a></td></tr>
<tr><td style="padding:0 32px;"><div style="height:1px;background-color:rgba(43,38,34,0.12);font-size:0;line-height:0;">&nbsp;</div></td></tr>`;
}

function emailShellEnd() {
  const site = escHtml(resolveStudioSiteUrl());
  return `<tr><td style="padding:0 32px;"><div style="height:1px;background-color:rgba(43,38,34,0.12);font-size:0;line-height:0;">&nbsp;</div></td></tr>
<tr><td style="padding:24px 32px 32px 32px;">
<p style="margin:0;font-family:${FF};font-size:15px;line-height:1.6;color:#2b2622;">See you at the desk,</p>
<p style="margin:6px 0 0 0;font-family:${FF_SERIF};font-size:17px;font-style:italic;font-weight:400;color:#5c5650;letter-spacing:0.2px;">The ${escHtml(STUDIO_NAME)} Team</p>
</td></tr></tbody></table>
<table role="presentation" style="max-width:600px;width:100%;" width="600" border="0" cellspacing="0" cellpadding="0"><tbody><tr>
<td style="padding:20px 16px 8px 16px;font-family:${FF};font-size:12px;line-height:1.7;color:#7a726a;letter-spacing:0.3px;" align="center">
<a style="color:#7a726a;text-decoration:none;" href="${site}">${site}</a> &nbsp;&middot;&nbsp; <span style="color:#7a726a;">${STUDIO_PHONE}</span>
</td></tr></tbody></table>
</td></tr></tbody></table></body></html>`;
}

/** @param {string} url @param {string} label */
function buildEmailActionButtonHtml(url, label) {
  const href = escHtml(url);
  return `<table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0"><tbody><tr>
<td style="padding:8px 0 4px;" align="center">
<table role="presentation" border="0" cellspacing="0" cellpadding="0" style="margin:0 auto;"><tbody><tr>
<td style="background-color:#1a1816;border-radius:4px;" align="center" bgcolor="#1a1816">
<a style="display:inline-block;padding:15px 32px;font-family:${FF};font-size:13px;font-weight:500;letter-spacing:1.8px;text-transform:uppercase;color:#faf3eb;text-decoration:none;background-color:#1a1816;border-radius:4px;" href="${href}">${escHtml(label)}</a>
</td></tr></tbody></table>
</td></tr></tbody></table>`;
}

/** @param {string} url */
function buildScheduleViewButtonHtml(url) {
  return buildEmailActionButtonHtml(url, "View update schedule");
}

/**
 * @param {Array<{ day?: string; date?: string; slot?: string; start?: string | null; end?: string | null; note?: string }>} assignments
 */
function buildShiftDayCardsHtml(assignments) {
  /** @type {Map<string, { day: string; rows: typeof assignments }>} */
  const byDate = new Map();
  for (const row of assignments) {
    const date = String(row.date || "");
    const day = String(row.day || date);
    if (!byDate.has(date)) byDate.set(date, { day, rows: [] });
    byDate.get(date).rows.push(row);
  }

  /** @type {string[]} */
  const cards = [];
  for (const [date, group] of byDate) {
    const shiftLines = group.rows
      .map((row, index) => {
        const slotLabel = slotDisplayLabel(String(row.slot || ""));
        const time = formatTimeRange(row.start, row.end);
        const note = typeof row.note === "string" ? row.note.trim() : "";
        const borderTop = index === 0 ? "0" : "1px solid rgba(43,38,34,0.08)";
        const noteHtml = note
          ? `<p style="margin:8px 0 0;font-family:${FF};font-size:13px;line-height:1.5;color:#7a726a;">Note: ${escHtml(note)}</p>`
          : "";
        return `<tr><td style="padding:${index === 0 ? "0" : "12px"} 0 0;border-top:${borderTop};">
<table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0"><tbody><tr>
<td style="font-family:${FF};font-size:15px;font-weight:600;line-height:1.4;color:#1a1816;vertical-align:top;padding-right:12px;">${escHtml(slotLabel)}</td>
<td style="font-family:${FF};font-size:15px;font-weight:400;line-height:1.4;color:#2b2622;text-align:right;vertical-align:top;white-space:nowrap;">${escHtml(time || "—")}</td>
</tr></tbody></table>${noteHtml}
</td></tr>`;
      })
      .join("");

    cards.push(`<table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="margin-bottom:12px;background-color:#faf3eb;border-radius:6px;"><tbody>
<tr><td style="padding:16px 18px 10px;">
<p style="margin:0 0 2px;font-family:${FF};font-size:11px;font-weight:500;letter-spacing:1.6px;text-transform:uppercase;color:#7a726a;">${escHtml(group.day)}</p>
<p style="margin:0;font-family:${FF};font-size:12px;line-height:1.4;color:#9a928a;">${escHtml(date)}</p>
</td></tr>
<tr><td style="padding:0 18px 16px;">
<table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0"><tbody>${shiftLines}</tbody></table>
</td></tr></tbody></table>`);
  }

  return cards.join("");
}

/**
 * @param {string} staffName
 * @param {string} weekStart
 * @param {Array<{ day?: string; date?: string; slot?: string; start?: string | null; end?: string | null; note?: string }>} assignments
 */
export function buildStaffScheduleEmailContent(staffName, weekStart, assignments) {
  const weekLabel = formatWeekOfLabel(weekStart);
  const scheduleUrl = resolveClassesScheduleUrl();
  const sorted = [...assignments].sort((a, b) => {
    const dateCmp = String(a.date || "").localeCompare(String(b.date || ""));
    if (dateCmp !== 0) return dateCmp;
    return slotOrder(String(a.slot || "")) - slotOrder(String(b.slot || ""));
  });

  /** @type {string[]} */
  const textLines = [
    `Hi ${staffName},`,
    "",
    `Your AMARÉ front desk shifts for the week of ${weekLabel}:`,
    "",
  ];

  let currentDay = "";
  for (const row of sorted) {
    const day = String(row.day || row.date || "");
    if (day !== currentDay) {
      currentDay = day;
      textLines.push(day);
    }
    const slotLabel = slotDisplayLabel(String(row.slot || ""));
    const time = formatTimeRange(row.start, row.end).replace(/\u00a0/g, " ");
    const note = typeof row.note === "string" ? row.note.trim() : "";
    const line = time ? `${slotLabel} — ${time}` : slotLabel;
    textLines.push(`  ${line}${note ? ` (${note})` : ""}`);
  }

  textLines.push(
    "",
    "Please clock in and out through Mindbody Time Clock when you arrive and leave.",
    "",
    `View update schedule: ${scheduleUrl}`,
    "",
    `— ${STUDIO_NAME}`,
  );

  const previewText = `Your front desk shifts for the week of ${weekLabel}.`;
  const firstName = String(staffName || "").trim().split(/\s+/)[0] || staffName;
  const inner = `<tr><td style="padding:28px 32px 8px 32px;">
<p style="margin:0 0 8px 0;font-family:${FF};font-size:11px;font-weight:500;letter-spacing:1.8px;text-transform:uppercase;color:#7a726a;">Front desk schedule</p>
<h1 style="margin:0 0 14px 0;font-family:${FF_SERIF};font-size:28px;font-weight:400;line-height:1.25;color:#1a1816;letter-spacing:-0.3px;">Hi ${escHtml(firstName)},</h1>
<p style="margin:0;font-family:${FF};font-size:16px;font-weight:400;line-height:1.6;color:#2b2622;">Your shifts for the week of <strong style="font-weight:500;color:#1a1816;">${escHtml(weekLabel)}</strong>:</p>
</td></tr>
<tr><td style="padding:8px 32px 8px 32px;">
${buildShiftDayCardsHtml(sorted)}
</td></tr>
<tr><td style="padding:4px 32px 8px 32px;">
<table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color:#faf3eb;border-radius:6px;"><tbody><tr><td style="padding:16px 18px;">
<p style="margin:0;font-family:${FF};font-size:14px;line-height:1.6;color:#2b2622;">Please clock in and out through <strong style="font-weight:500;color:#1a1816;">Mindbody Time Clock</strong> when you arrive and leave.</p>
</td></tr></tbody></table>
</td></tr>
<tr><td style="padding:8px 32px 24px 32px;" align="center">
${buildScheduleViewButtonHtml(scheduleUrl)}
<p style="margin:14px 0 0;font-family:${FF};font-size:13px;line-height:1.6;color:#7a726a;">Class times may change — check the live schedule for updates.</p>
</td></tr>`;

  return {
    subject: `AMARÉ Front Desk Schedule — Week of ${weekLabel}`,
    text: textLines.join("\n"),
    html: emailShellStart(previewText) + inner + emailShellEnd(),
  };
}

/**
 * Build per-staff email targets from published assignments (all assigned shifts).
 * @param {Record<string, unknown>} enrichedWeek
 */
export function buildStaffEmailTargets(enrichedWeek) {
  const shifts = Array.isArray(enrichedWeek.shifts) ? enrichedWeek.shifts : [];
  /** @type {Map<string, { name: string; email: string; assignments: object[] }>} */
  const byId = new Map();

  for (const raw of shifts) {
    if (!raw || typeof raw !== "object") continue;
    const s = /** @type {Record<string, unknown>} */ (raw);
    if (s.status !== "assigned" || !s.staffId) continue;
    const staffId = String(s.staffId);
    const email = String(s.staffEmail || "").trim().toLowerCase();
    const name = String(s.staffName || "").trim();
    if (!email.includes("@")) continue;

    if (!byId.has(staffId)) {
      byId.set(staffId, { name: name || email, email, assignments: [] });
    }
    byId.get(staffId).assignments.push({
      date: s.date,
      day: s.day,
      slot: s.slot,
      start: s.start,
      end: s.end,
      note: s.note,
    });
  }

  return [...byId.values()];
}

/** @returns {string} Absolute URL to the staff availability form. */
export function resolveStaffAvailabilityUrl() {
  return `${resolveStudioSiteUrl()}/staff/availability`;
}

/** @returns {string} */
export function resolveStaffScheduleAdminUrl() {
  return `${resolveStudioSiteUrl()}/admin/staff-schedule`;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * @param {string} date
 * @param {string} slot
 */
export function formatAvailabilitySelectionLabel(date, slot) {
  const [y, m, d] = date.split("-").map((x) => parseInt(x, 10));
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const dayName = DAY_NAMES[dow] || "";
  return `${dayName} ${formatWeekOfLabel(date)} — ${slotDisplayLabel(slot)}`;
}

/**
 * @param {Array<{ date?: string; slot?: string }>} selections
 * @returns {string[]}
 */
export function formatAvailabilitySelectionLabels(selections) {
  if (!Array.isArray(selections) || !selections.length) return [];
  return selections
    .map((sel) => {
      const date = String(sel.date || "");
      const slot = String(sel.slot || "");
      if (!date || !slot) return "";
      return formatAvailabilitySelectionLabel(date, slot);
    })
    .filter(Boolean);
}

/** @param {string} url */
function buildAvailabilityFormButtonHtml(url) {
  const href = escHtml(url);
  return `<table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0"><tbody><tr>
<td style="padding:8px 0 4px;" align="center">
<table role="presentation" border="0" cellspacing="0" cellpadding="0" style="margin:0 auto;"><tbody><tr>
<td style="background-color:#1a1816;border-radius:4px;" align="center" bgcolor="#1a1816">
<a style="display:inline-block;padding:15px 32px;font-family:${FF};font-size:13px;font-weight:500;letter-spacing:1.8px;text-transform:uppercase;color:#faf3eb;text-decoration:none;background-color:#1a1816;border-radius:4px;" href="${href}">Submit your shifts</a>
</td></tr></tbody></table>
</td></tr></tbody></table>`;
}

/**
 * @param {{ name?: string; email?: string; pin?: string }} staff
 */
export function buildStaffLoginEmailContent(staff) {
  const name = String(staff.name || "").trim() || "there";
  const email = String(staff.email || "").trim();
  const pin = String(staff.pin || "").trim();
  const availabilityUrl = resolveStaffAvailabilityUrl();
  const firstName = name.split(/\s+/)[0] || name;

  const textLines = [
    `Hi ${name},`,
    "",
    "Use the details below to submit your front desk shift availability at AMARÉ:",
    "",
    `Email on file: ${email}`,
    `PIN: ${pin}`,
    "",
    "On the form, select your name from the list and enter your PIN.",
    "",
    `Open the availability form: ${availabilityUrl}`,
    "",
    "Keep your PIN private — do not share it with others.",
    "",
    `— ${STUDIO_NAME}`,
  ];

  const previewText = "Your AMARÉ shift availability login details.";
  const inner = `<tr><td style="padding:28px 32px 8px 32px;">
<p style="margin:0 0 8px 0;font-family:${FF};font-size:11px;font-weight:500;letter-spacing:1.8px;text-transform:uppercase;color:#7a726a;">Shift availability</p>
<h1 style="margin:0 0 14px 0;font-family:${FF_SERIF};font-size:28px;font-weight:400;line-height:1.25;color:#1a1816;letter-spacing:-0.3px;">Hi ${escHtml(firstName)},</h1>
<p style="margin:0;font-family:${FF};font-size:16px;font-weight:400;line-height:1.6;color:#2b2622;">Use the login details below to submit which reception shifts you can work:</p>
</td></tr>
<tr><td style="padding:8px 32px 8px 32px;">
<table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color:#faf3eb;border-radius:6px;"><tbody><tr><td style="padding:18px 20px;">
<p style="margin:0 0 10px;font-family:${FF};font-size:11px;font-weight:500;letter-spacing:1.6px;text-transform:uppercase;color:#7a726a;">Your login</p>
<p style="margin:0 0 8px;font-family:${FF};font-size:15px;line-height:1.5;color:#2b2622;"><strong style="font-weight:500;color:#1a1816;">Email:</strong> ${escHtml(email)}</p>
<p style="margin:0;font-family:${FF};font-size:15px;line-height:1.5;color:#2b2622;"><strong style="font-weight:500;color:#1a1816;">PIN:</strong> ${escHtml(pin)}</p>
</td></tr></tbody></table>
</td></tr>
<tr><td style="padding:4px 32px 8px 32px;">
<p style="margin:0;font-family:${FF};font-size:15px;line-height:1.6;color:#2b2622;">On the form, <strong style="font-weight:500;color:#1a1816;">select your name</strong> from the list and enter your PIN.</p>
</td></tr>
<tr><td style="padding:8px 32px 24px 32px;" align="center">
${buildAvailabilityFormButtonHtml(availabilityUrl)}
<p style="margin:14px 0 0;font-family:${FF};font-size:13px;line-height:1.6;color:#7a726a;">Keep your PIN private — do not share it with others.</p>
</td></tr>`;

  return {
    subject: "AMARÉ — Shift availability login",
    text: textLines.join("\n"),
    html: emailShellStart(previewText) + inner + emailShellEnd(),
  };
}

/**
 * @param {{ name?: string; email?: string; pin?: string; active?: boolean }} staff
 */
export async function sendStaffLoginEmail(staff) {
  if (!staffScheduleEmailConfigured()) {
    return {
      ok: false,
      error: "email_not_configured",
      hint: "Set ENABLE_STAFF_SCHEDULE_ADMIN_EMAIL=1 and Resend env vars.",
    };
  }

  const from = resolveFromAddress();
  if (!from) {
    return { ok: false, error: "missing_from_address", hint: "Set STAFF_SCHEDULE_EMAIL_FROM or SMS_ADMIN_REPORT_FROM." };
  }

  const email = String(staff.email || "").trim().toLowerCase();
  if (!email.includes("@")) {
    return { ok: false, error: "invalid_staff_email", hint: "Staff member needs a valid email address." };
  }

  const pin = String(staff.pin || "").trim();
  if (pin.replace(/\D/g, "").length < 4) {
    return { ok: false, error: "invalid_staff_pin", hint: "Staff member needs a 4–6 digit PIN." };
  }

  if (staff.active === false) {
    return { ok: false, error: "staff_inactive", hint: "Reactivate this staff member before sending login details." };
  }

  const content = buildStaffLoginEmailContent(staff);
  const result = await sendResendEmail({
    from,
    to: email,
    subject: content.subject,
    html: content.html,
    text: content.text,
    tags: [{ name: "category", value: "staff_availability_login" }],
  });

  if (!result.ok) {
    return {
      ok: false,
      error: result.error || "send_failed",
      hint: `Failed sending to ${email}.`,
    };
  }

  return { ok: true, to: email, messageId: result.messageId || null };
}

/**
 * @param {{ name?: string; email?: string; pin?: string }} staff
 * @param {string} weekStart
 */
export function buildStaffAvailabilityReminderEmailContent(staff, weekStart) {
  const name = String(staff.name || "").trim() || "there";
  const email = String(staff.email || "").trim();
  const pin = String(staff.pin || "").trim();
  const availabilityUrl = resolveStaffAvailabilityUrl();
  const firstName = name.split(/\s+/)[0] || name;
  const weekRange = formatWeekRangeLabel(weekStart);
  const weekOf = formatWeekOfLabel(weekStart);

  const textLines = [
    `Hi ${name},`,
    "",
    `Please submit which front desk shifts you can work for the week of ${weekRange}.`,
    "",
    `Week starting: ${weekOf} (${weekRange})`,
    "",
    "Your login for the availability form:",
    `Email on file: ${email}`,
    `PIN: ${pin}`,
    "",
    "On the form, select your name from the list and enter your PIN.",
    "",
    `Submit your availability: ${availabilityUrl}`,
    "",
    "Keep your PIN private — do not share it with others.",
    "",
    `— ${STUDIO_NAME}`,
  ];

  const previewText = `Submit your shift availability for the week of ${weekRange}.`;
  const inner = `<tr><td style="padding:28px 32px 8px 32px;">
<p style="margin:0 0 8px 0;font-family:${FF};font-size:11px;font-weight:500;letter-spacing:1.8px;text-transform:uppercase;color:#7a726a;">Shift availability</p>
<h1 style="margin:0 0 14px 0;font-family:${FF_SERIF};font-size:28px;font-weight:400;line-height:1.25;color:#1a1816;letter-spacing:-0.3px;">Hi ${escHtml(firstName)},</h1>
<p style="margin:0;font-family:${FF};font-size:16px;font-weight:400;line-height:1.6;color:#2b2622;">Please submit which reception shifts you <strong style="font-weight:500;color:#1a1816;">can work</strong> for the week of <strong style="font-weight:500;color:#1a1816;">${escHtml(weekRange)}</strong>.</p>
</td></tr>
<tr><td style="padding:8px 32px 8px 32px;">
<table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color:#faf3eb;border-radius:6px;"><tbody><tr><td style="padding:18px 20px;">
<p style="margin:0 0 10px;font-family:${FF};font-size:11px;font-weight:500;letter-spacing:1.6px;text-transform:uppercase;color:#7a726a;">Week</p>
<p style="margin:0;font-family:${FF};font-size:15px;line-height:1.5;color:#2b2622;">${escHtml(weekRange)}</p>
</td></tr></tbody></table>
</td></tr>
<tr><td style="padding:8px 32px 8px 32px;">
<table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color:#faf3eb;border-radius:6px;"><tbody><tr><td style="padding:18px 20px;">
<p style="margin:0 0 10px;font-family:${FF};font-size:11px;font-weight:500;letter-spacing:1.6px;text-transform:uppercase;color:#7a726a;">Your login</p>
<p style="margin:0 0 8px;font-family:${FF};font-size:15px;line-height:1.5;color:#2b2622;"><strong style="font-weight:500;color:#1a1816;">Email:</strong> ${escHtml(email)}</p>
<p style="margin:0;font-family:${FF};font-size:15px;line-height:1.5;color:#2b2622;"><strong style="font-weight:500;color:#1a1816;">PIN:</strong> ${escHtml(pin)}</p>
</td></tr></tbody></table>
</td></tr>
<tr><td style="padding:4px 32px 8px 32px;">
<p style="margin:0;font-family:${FF};font-size:15px;line-height:1.6;color:#2b2622;">On the form, <strong style="font-weight:500;color:#1a1816;">select your name</strong> from the list and enter your PIN. This is a request only — final schedule is set by your manager.</p>
</td></tr>
<tr><td style="padding:8px 32px 24px 32px;" align="center">
${buildAvailabilityFormButtonHtml(availabilityUrl)}
<p style="margin:14px 0 0;font-family:${FF};font-size:13px;line-height:1.6;color:#7a726a;">Keep your PIN private — do not share it with others.</p>
</td></tr>`;

  return {
    subject: `AMARÉ — Submit shifts for week of ${weekRange}`,
    text: textLines.join("\n"),
    html: emailShellStart(previewText) + inner + emailShellEnd(),
  };
}

/**
 * @param {Array<{ name?: string; email?: string; pin?: string; active?: boolean; id?: string }>} staffList
 * @param {string} weekStart
 */
export async function sendStaffAvailabilityReminderEmails(staffList, weekStart) {
  if (!staffScheduleEmailConfigured()) {
    return {
      ok: false,
      error: "email_not_configured",
      hint: "Set ENABLE_STAFF_SCHEDULE_ADMIN_EMAIL=1 and Resend env vars.",
    };
  }

  const from = resolveFromAddress();
  if (!from) {
    return { ok: false, error: "missing_from_address", hint: "Set STAFF_SCHEDULE_EMAIL_FROM or SMS_ADMIN_REPORT_FROM." };
  }

  /** @type {string[]} */
  const recipients = [];
  /** @type {string[]} */
  const skipped = [];
  let sent = 0;

  for (const staff of staffList) {
    if (staff.active === false) {
      skipped.push(String(staff.id || staff.email || "unknown"));
      continue;
    }
    const email = String(staff.email || "").trim().toLowerCase();
    if (!email.includes("@")) {
      skipped.push(String(staff.id || email || "unknown"));
      continue;
    }
    const pin = String(staff.pin || "").trim();
    if (pin.replace(/\D/g, "").length < 4) {
      skipped.push(String(staff.id || email || "unknown"));
      continue;
    }

    const content = buildStaffAvailabilityReminderEmailContent(staff, weekStart);
    const result = await sendResendEmail({
      from,
      to: email,
      subject: content.subject,
      html: content.html,
      text: content.text,
      tags: [{ name: "category", value: "staff_availability_reminder" }],
    });
    if (!result.ok) {
      return {
        ok: false,
        error: result.error || "send_failed",
        hint: `Failed sending to ${email}.`,
        sent,
        recipients,
      };
    }
    recipients.push(email);
    sent += 1;
  }

  if (sent === 0) {
    return {
      ok: false,
      error: "no_eligible_staff",
      hint: "Selected staff need a valid email and 4–6 digit PIN.",
      skipped,
    };
  }

  return { ok: true, sent, recipients, skipped };
}

/**
 * @param {{ staffName: string; weekStart: string; selections: Array<{ date?: string; slot?: string }>; isUpdate?: boolean }} opts
 */
export function buildStaffAvailabilitySubmittedAdminEmailContent(opts) {
  const staffName = String(opts.staffName || "").trim() || "Staff";
  const weekStart = String(opts.weekStart || "").trim();
  const weekRange = formatWeekRangeLabel(weekStart);
  const lines = formatAvailabilitySelectionLabels(opts.selections);
  const isUpdate = opts.isUpdate === true;
  const actionLabel = isUpdate ? "updated" : "submitted";
  const adminUrl = resolveStaffScheduleAdminUrl();
  const shiftSummary =
    lines.length > 0 ? lines.join("\n") : "No shifts selected — staff saved an empty availability.";

  const textLines = [
    `${staffName} ${actionLabel} front desk shift availability for the week of ${weekRange}.`,
    "",
    "Requested shifts:",
    shiftSummary,
    "",
    `Review in admin: ${adminUrl}`,
    "",
    `— ${STUDIO_NAME} (internal)`,
  ];

  const previewText = `${staffName} ${actionLabel} shift availability for ${weekRange}.`;
  const listHtml =
    lines.length > 0
      ? `<ul style="margin:0;padding:0 0 0 1.1rem;font-family:${FF};font-size:15px;line-height:1.65;color:#2b2622;">${lines
          .map((line) => `<li style="margin:0 0 6px 0;">${escHtml(line)}</li>`)
          .join("")}</ul>`
      : `<p style="margin:0;font-family:${FF};font-size:15px;line-height:1.6;color:#7a726a;">No shifts selected.</p>`;

  const inner = `<tr><td style="padding:28px 32px 8px 32px;">
<p style="margin:0 0 8px 0;font-family:${FF};font-size:11px;font-weight:500;letter-spacing:1.8px;text-transform:uppercase;color:#7a726a;">Staff availability</p>
<h1 style="margin:0 0 14px 0;font-family:${FF_SERIF};font-size:28px;font-weight:400;line-height:1.25;color:#1a1816;letter-spacing:-0.3px;">${escHtml(staffName)} ${escHtml(actionLabel)} shifts</h1>
<p style="margin:0;font-family:${FF};font-size:16px;font-weight:400;line-height:1.6;color:#2b2622;"><strong style="font-weight:500;color:#1a1816;">${escHtml(staffName)}</strong> ${escHtml(actionLabel)} availability for the week of <strong style="font-weight:500;color:#1a1816;">${escHtml(weekRange)}</strong>.</p>
</td></tr>
<tr><td style="padding:8px 32px 8px 32px;">
<table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color:#faf3eb;border-radius:6px;"><tbody><tr><td style="padding:18px 20px;">
<p style="margin:0 0 10px;font-family:${FF};font-size:11px;font-weight:500;letter-spacing:1.6px;text-transform:uppercase;color:#7a726a;">Requested shifts</p>
${listHtml}
</td></tr></tbody></table>
</td></tr>
<tr><td style="padding:8px 32px 24px 32px;" align="center">
${buildEmailActionButtonHtml(adminUrl, "Open staff schedule")}
</td></tr>`;

  return {
    subject: `AMARÉ — ${staffName} ${actionLabel} shift availability (${weekRange})`,
    text: textLines.join("\n"),
    html: emailShellStart(previewText) + inner + emailShellEnd(),
  };
}

/**
 * @param {{ staffName: string; weekStart: string; selections: Array<{ date?: string; slot?: string }>; isUpdate?: boolean }} opts
 * @returns {Promise<{ ok: true; recipients: string[]; messageId?: string | null } | { ok: false; error: string; hint?: string; skipped?: boolean }>}
 */
export async function sendStaffAvailabilitySubmittedAdminEmail(opts) {
  if (!staffScheduleAdminNotifyConfigured()) {
    return {
      ok: false,
      skipped: true,
      error: "admin_notify_not_configured",
      hint: "Set ENABLE_STAFF_SCHEDULE_ADMIN_EMAIL=1, RESEND_API_KEY, STAFF_SCHEDULE_EMAIL_FROM, and STAFF_SCHEDULE_ADMIN_NOTIFY_TO or SMS_ADMIN_REPORT_TO.",
    };
  }

  const from = resolveFromAddress();
  const recipients = parseStaffScheduleAdminNotifyRecipients();
  if (!from || !recipients.length) {
    return {
      ok: false,
      error: "missing_notify_config",
      hint: "Set STAFF_SCHEDULE_EMAIL_FROM and STAFF_SCHEDULE_ADMIN_NOTIFY_TO or SMS_ADMIN_REPORT_TO.",
    };
  }

  const content = buildStaffAvailabilitySubmittedAdminEmailContent(opts);
  const result = await sendResendEmail({
    from,
    to: recipients,
    subject: content.subject,
    html: content.html,
    text: content.text,
    tags: [{ name: "category", value: "staff_availability_admin_notify" }],
  });

  if (!result.ok) {
    return {
      ok: false,
      error: result.error || "send_failed",
      hint: "Resend failed sending staff availability admin notification.",
    };
  }

  return { ok: true, recipients, messageId: result.messageId || null };
}

/**
 * @param {Record<string, unknown>} enrichedWeek
 * @returns {Promise<{ ok: true; sent: number; recipients: string[] } | { ok: false; error: string; hint?: string }>}
 */
export async function sendStaffScheduleEmails(enrichedWeek) {
  const from = resolveFromAddress();
  if (!from) {
    return { ok: false, error: "missing_from_address", hint: "Set STAFF_SCHEDULE_EMAIL_FROM or SMS_ADMIN_REPORT_FROM." };
  }

  const weekStart = String(enrichedWeek.weekStart || "");
  const targets = buildStaffEmailTargets(enrichedWeek);

  if (!targets.length) {
    return {
      ok: false,
      error: "no_assigned_staff",
      hint: "Assign staff to active shifts before emailing.",
    };
  }

  /** @type {string[]} */
  const recipients = [];
  let sent = 0;

  for (const target of targets) {
    const content = buildStaffScheduleEmailContent(target.name, weekStart, target.assignments);
    const result = await sendResendEmail({
      from,
      to: target.email,
      subject: content.subject,
      html: content.html,
      text: content.text,
      tags: [{ name: "category", value: "staff_schedule" }],
    });
    if (!result.ok) {
      return {
        ok: false,
        error: result.error || "send_failed",
        hint: `Failed sending to ${target.email}.`,
      };
    }
    recipients.push(target.email);
    sent += 1;
  }

  return { ok: true, sent, recipients };
}
