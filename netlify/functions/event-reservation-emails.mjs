/**
 * Private-event emails (deposit, confirm, overtime).
 * Card layout matches docs/email-templates + guest-pass Resend mail.
 */

import { sendResendEmail } from "./resend-email-client.mjs";
import { formatEventSchedule, formatUsd, roomLabel } from "./event-booking-lib.mjs";

const STUDIO_NAME = "AMARÉ Wellness Studio";
const STUDIO_SITE = "https://www.amarewellness.com";
const STUDIO_LOGO = `${STUDIO_SITE}/logo/logo-amare-wellness-studio.png`;
const STUDIO_PHONE = "(954) 258-9238";
const FF = "'DM Sans','Helvetica Neue',Helvetica,Arial,sans-serif";
const FF_SERIF = "'Fraunces','Cormorant Garamond',Georgia,'Times New Roman',serif";

/** @returns {string[]} */
function parseAdminRecipients() {
  const raw = (process.env.SMS_ADMIN_REPORT_TO || "").trim();
  if (!raw) return [];
  return raw
    .split(/[,;]+/)
    .map((s) => s.trim())
    .filter((s) => s.includes("@"));
}

function resolveFromAddress() {
  return (
    (process.env.RESEND_FROM || "").trim() ||
    (process.env.SMS_ADMIN_REPORT_FROM || "").trim() ||
    "AMARÉ Wellness Studio <info@amarewellness.com>"
  );
}

function siteBase() {
  return (process.env.SITE_URL || STUDIO_SITE).replace(/\/$/, "");
}

/** @param {unknown} s */
function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * @param {import("./event-reservation-store.mjs").EventReservation} rec
 */
function summaryLines(rec) {
  const when = formatEventSchedule(rec.eventDate, rec.eventTime);
  const total = rec.packageCents + rec.stylingCents;
  return {
    when,
    total,
    name: `${rec.firstName} ${rec.lastName}`.trim(),
    room: roomLabel(rec.room),
    styling: rec.styling ? formatUsd(rec.stylingCents) : "No",
  };
}

/** @param {string} previewText */
function emailShellStart(previewText) {
  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html><head></head><body>
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#faf3eb;">${previewText}</div>
<table style="background-color:#faf3eb;" width="100%" border="0" cellspacing="0" cellpadding="0"><tbody><tr>
<td style="padding:32px 16px;" align="center">
<table style="max-width:600px;width:100%;background-color:#ffffff;border:1px solid rgba(43,38,34,0.08);border-radius:8px;" width="600" border="0" cellspacing="0" cellpadding="0"><tbody>
<tr><td style="padding:36px 32px 20px 32px;" align="center">
<a href="${STUDIO_SITE}" style="text-decoration:none;">
<img src="${STUDIO_LOGO}" alt="${esc(STUDIO_NAME)}" width="220" style="display:block;width:220px;max-width:100%;height:auto;border:0;outline:none;" />
</a></td></tr>
<tr><td style="padding:0 32px;"><div style="height:1px;background-color:rgba(43,38,34,0.12);font-size:0;line-height:0;">&nbsp;</div></td></tr>`;
}

function emailShellEnd() {
  return `<tr><td style="padding:0 32px;"><div style="height:1px;background-color:rgba(43,38,34,0.12);font-size:0;line-height:0;">&nbsp;</div></td></tr>
<tr><td style="padding:24px 32px 32px 32px;">
<p style="margin:0;font-family:${FF};font-size:15px;line-height:1.6;color:#2b2622;">See you soon,</p>
<p style="margin:6px 0 0 0;font-family:${FF_SERIF};font-size:17px;font-style:italic;font-weight:400;color:#5c5650;letter-spacing:0.2px;">The ${esc(STUDIO_NAME)} Team</p>
</td></tr></tbody></table>
<table style="max-width:600px;width:100%;" width="600" border="0" cellspacing="0" cellpadding="0"><tbody><tr>
<td style="padding:20px 16px 8px 16px;font-family:${FF};font-size:12px;line-height:1.7;color:#7a726a;letter-spacing:0.3px;" align="center">
<a style="color:#7a726a;text-decoration:none;" href="${STUDIO_SITE}">${STUDIO_SITE}</a> &nbsp;&middot;&nbsp; <span style="color:#7a726a;">${STUDIO_PHONE}</span>
</td></tr></tbody></table>
</td></tr></tbody></table></body></html>`;
}

/** @param {string} previewText @param {string} inner */
function wrapEmail(previewText, inner) {
  return emailShellStart(previewText) + inner + emailShellEnd();
}

/** @param {string} eyebrow @param {string} headline @param {string} leadHtml */
function heroBlock(eyebrow, headline, leadHtml) {
  return `<tr><td style="padding:36px 32px 8px 32px;">
<p style="margin:0 0 8px 0;font-family:${FF};font-size:11px;font-weight:500;letter-spacing:1.8px;text-transform:uppercase;color:#7a726a;">${eyebrow}</p>
<h1 style="margin:0 0 18px 0;font-family:${FF_SERIF};font-size:30px;font-weight:400;line-height:1.2;color:#1a1816;letter-spacing:-0.4px;">${headline}</h1>
<p style="margin:0;font-family:${FF};font-size:16px;font-weight:400;line-height:1.6;color:#2b2622;">${leadHtml}</p>
</td></tr>`;
}

/** @param {string} html */
function bodySection(html) {
  return `<tr><td style="padding:24px 32px 8px 32px;">
<p style="margin:0;font-family:${FF};font-size:15px;font-weight:400;line-height:1.6;color:#2b2622;">${html}</p>
</td></tr>`;
}

/** @param {string} label @param {string} valueHtml @param {{ strong?: boolean; last?: boolean }} [opts] */
function detailRow(label, valueHtml, opts = {}) {
  const pad = opts.last ? "0" : "0 0 12px 0";
  const labStyle = `padding:${pad};font-family:${FF};font-size:11px;font-weight:500;letter-spacing:1.6px;text-transform:uppercase;color:#7a726a;`;
  const valStyle = opts.strong
    ? `padding:${pad};font-family:${FF};font-size:16px;font-weight:500;line-height:1.45;color:#1a1816;`
    : `padding:${pad};font-family:${FF};font-size:15px;font-weight:400;line-height:1.45;color:#2b2622;`;
  return `<tr><td style="${labStyle}" valign="top" width="110">${label}</td><td style="${valStyle}" valign="top">${valueHtml}</td></tr>`;
}

/** @param {string} title @param {string} rowsHtml */
function detailsBlock(title, rowsHtml) {
  return `<tr><td style="padding:28px 32px 8px 32px;">
<p style="margin:0 0 12px 0;font-family:${FF};font-size:11px;font-weight:500;letter-spacing:1.8px;text-transform:uppercase;color:#7a726a;">${title}</p>
<table style="background-color:#faf3eb;border-radius:6px;" width="100%" border="0" cellspacing="0" cellpadding="0"><tbody><tr><td style="padding:22px 24px;">
<table width="100%" border="0" cellspacing="0" cellpadding="0"><tbody>${rowsHtml}</tbody></table>
</td></tr></tbody></table></td></tr>`;
}

/** @param {string} href @param {string} label */
function ctaBlock(href, label) {
  return `<tr><td style="padding:24px 32px 8px 32px;" align="center">
<table style="margin:0 auto;" border="0" cellspacing="0" cellpadding="0"><tbody><tr>
<td style="background-color:#1a1816;border-radius:4px;" align="center" bgcolor="#1a1816">
<a style="display:inline-block;padding:15px 38px;font-family:${FF};font-size:13px;font-weight:500;letter-spacing:1.8px;text-transform:uppercase;color:#faf3eb;text-decoration:none;background-color:#1a1816;border-radius:4px;" href="${esc(href)}">${label}</a>
</td></tr></tbody></table>
<p style="margin:14px 0 0;font-family:${FF};font-size:13px;line-height:1.6;color:#7a726a;">Questions? Reply to this email or call us at ${STUDIO_PHONE}.</p>
</td></tr>`;
}

/**
 * @param {import("./event-reservation-store.mjs").EventReservation} rec
 * @param {{ includeContact?: boolean; includeId?: boolean }} [opts]
 */
function whenScheduleHtml(rec) {
  const s = summaryLines(rec);
  const muted = "color:#5c5650;font-weight:400;font-size:13px;";
  return `${esc(s.when.dateLine)}<br />
<span style="${muted}"><strong style="color:#1a1816;font-weight:500;">Arrival</strong> ${esc(s.when.arrival)} &mdash; 30 min before (setup)</span><br />
<span style="${muted}"><strong style="color:#1a1816;font-weight:500;">Class time</strong> ${esc(s.when.classStart)}&ndash;${esc(s.when.classEnd)}</span><br />
<span style="${muted}"><strong style="color:#1a1816;font-weight:500;">After</strong> ${esc(s.when.classEnd)}&ndash;${esc(s.when.afterEnd)} &mdash; pictures, mingling, cake</span>`;
}

function eventDetailRows(rec, opts = {}) {
  const s = summaryLines(rec);
  const rows = [
    opts.includeContact ? detailRow("Guest", esc(s.name), { strong: true }) : "",
    opts.includeContact ? detailRow("Email", esc(rec.email)) : "",
    opts.includeContact && rec.phone ? detailRow("Phone", esc(rec.phone)) : "",
    detailRow("When", whenScheduleHtml(rec), { strong: !opts.includeContact }),
    detailRow("Room", esc(s.room)),
    detailRow("Guests", esc(String(rec.guests))),
    detailRow("Styling", esc(s.styling)),
    detailRow("Deposit", esc(formatUsd(rec.depositCents))),
    detailRow("Remaining", esc(formatUsd(rec.remainingCents)), { last: !opts.includeId }),
    opts.includeId ? detailRow("ID", esc(rec.id), { last: true }) : "",
  ];
  return rows.join("");
}

/**
 * @param {import("./event-reservation-store.mjs").EventReservation} rec
 */
export async function sendEventDepositEmails(rec) {
  const from = resolveFromAddress();
  const s = summaryLines(rec);
  const adminTo = parseAdminRecipients();
  /** @type {{ client?: { ok: boolean, error?: string }, admin?: { ok: boolean, error?: string } }} */
  const results = {};

  const clientHtml = wrapEmail(
    `We received your ${formatUsd(rec.depositCents)} deposit. Your date is pending confirmation.`,
    heroBlock(
      "Private event",
      `We received your deposit, ${esc(rec.firstName)}.`,
      `Your <strong style="font-weight:500;color:#1a1816;">${esc(formatUsd(rec.depositCents))}</strong> deposit is in. The date is <strong style="font-weight:500;color:#1a1816;">pending studio confirmation</strong> &mdash; we&rsquo;ll email you once it&rsquo;s reserved.`,
    ) +
      detailsBlock("Event details", eventDetailRows(rec)) +
      bodySection(
        `Package total ${esc(formatUsd(s.total))}. The remaining balance is charged the day before, after we confirm. Your card is saved only for that balance and extra time ($50 per 30 minutes) if the event runs long.`,
      ) +
      ctaBlock(`${STUDIO_SITE}/event-info`, "Event details"),
  );

  const clientResult = await sendResendEmail({
    from,
    to: rec.email,
    subject: "AMARÉ — we received your event deposit",
    html: clientHtml,
    text: `Hi ${rec.firstName}, we received your ${formatUsd(rec.depositCents)} deposit. ${s.when.dateLine}. ${s.when.rangeLine}. Pending studio confirmation.`,
    tags: [{ name: "flow", value: "event_deposit_client" }],
  });
  results.client = { ok: !!clientResult.ok, error: clientResult.ok ? undefined : String(clientResult.error || "") };

  if (adminTo.length) {
    const adminUrl = `${siteBase()}/admin/events`;
    const adminHtml = wrapEmail(
      `New deposit from ${s.name} — confirm the date when ready.`,
      heroBlock(
        "Studio admin",
        "New private event deposit",
        `Confirm the date in admin when the studio can host it. Status: deposit paid, pending confirmation.`,
      ) +
        detailsBlock("Reservation", eventDetailRows(rec, { includeContact: true, includeId: true })) +
        ctaBlock(adminUrl, "Open event admin"),
    );
    const adminResult = await sendResendEmail({
      from,
      to: adminTo,
      subject: `Event deposit — ${s.name} · ${s.when.dateLine}`,
      html: adminHtml,
      text: `New event deposit from ${s.name} (${rec.email}). ${s.when.dateLine}. ${s.when.rangeLine}. ${s.room}, ${rec.guests} guests. Remaining ${formatUsd(rec.remainingCents)}. ${rec.id}`,
      tags: [{ name: "flow", value: "event_deposit_admin" }],
    });
    results.admin = { ok: !!adminResult.ok, error: adminResult.ok ? undefined : String(adminResult.error || "") };
  } else {
    results.admin = { ok: false, error: "missing_admin_recipients" };
  }

  return results;
}

/**
 * @param {import("./event-reservation-store.mjs").EventReservation} rec
 */
export async function sendEventConfirmedEmail(rec) {
  const from = resolveFromAddress();
  const s = summaryLines(rec);
  const html = wrapEmail(
    `Your private event is confirmed for ${s.when.dateLine}. ${s.when.rangeLine}.`,
    heroBlock(
      "Private event",
      `Your date is confirmed, ${esc(rec.firstName)}.`,
      `The studio has reserved this date. The remaining balance will be charged the day before the event.`,
    ) +
      detailsBlock("Event details", eventDetailRows(rec)) +
      bodySection(
        `Remaining ${esc(formatUsd(rec.remainingCents))} is charged automatically the day before. Extra time is $50 per 30 minutes if the event runs long.`,
      ) +
      ctaBlock(`${STUDIO_SITE}/event-info`, "Event details"),
  );
  return sendResendEmail({
    from,
    to: rec.email,
    subject: "AMARÉ — your private event is confirmed",
    html,
    text: `Hi ${rec.firstName}, your private event is confirmed for ${s.when.dateLine}. ${s.when.rangeLine}. Remaining ${formatUsd(rec.remainingCents)} will be charged the day before.`,
    tags: [{ name: "flow", value: "event_confirmed_client" }],
  });
}

/**
 * @param {import("./event-reservation-store.mjs").EventReservation} rec
 * @param {{ minutes: number, cents: number }} charge
 */
export async function sendEventOvertimeEmail(rec, charge) {
  const from = resolveFromAddress();
  const s = summaryLines(rec);
  const html = wrapEmail(
    `We charged ${formatUsd(charge.cents)} for +${charge.minutes} minutes after your event.`,
    heroBlock(
      "Private event",
      `Extra time charge, ${esc(rec.firstName)}.`,
      `We charged <strong style="font-weight:500;color:#1a1816;">${esc(formatUsd(charge.cents))}</strong> for <strong style="font-weight:500;color:#1a1816;">+${esc(String(charge.minutes))} minutes</strong> after your private event.`,
    ) +
      detailsBlock(
        "Charge details",
        [
          detailRow("When", whenScheduleHtml(rec), { strong: true }),
          detailRow("Room", esc(s.room)),
          detailRow("Extra time", esc(`+${charge.minutes} minutes`)),
          detailRow("Amount", esc(formatUsd(charge.cents)), { last: true }),
        ].join(""),
      ) +
      ctaBlock(`${STUDIO_SITE}/contact`, "Contact the studio"),
  );
  return sendResendEmail({
    from,
    to: rec.email,
    subject: `AMARÉ — extra time charge (${formatUsd(charge.cents)})`,
    html,
    text: `Hi ${rec.firstName}, we charged ${formatUsd(charge.cents)} for +${charge.minutes} minutes after your event on ${s.when.dateLine}.`,
    tags: [{ name: "flow", value: "event_overtime_client" }],
  });
}

/**
 * @param {import("./event-reservation-store.mjs").EventReservation} rec
 * @param {{ description: string, cents: number }} charge
 */
export async function sendEventCustomChargeEmail(rec, charge) {
  const from = resolveFromAddress();
  const s = summaryLines(rec);
  const html = wrapEmail(
    `We charged ${formatUsd(charge.cents)} for ${charge.description}.`,
    heroBlock(
      "Private event",
      `Additional charge, ${esc(rec.firstName)}.`,
      `We charged <strong style="font-weight:500;color:#1a1816;">${esc(formatUsd(charge.cents))}</strong> for <strong style="font-weight:500;color:#1a1816;">${esc(charge.description)}</strong>.`,
    ) +
      detailsBlock(
        "Charge details",
        [
          detailRow("When", whenScheduleHtml(rec), { strong: true }),
          detailRow("Room", esc(s.room)),
          detailRow("Item", esc(charge.description)),
          detailRow("Amount", esc(formatUsd(charge.cents)), { last: true }),
        ].join(""),
      ) +
      ctaBlock(`${STUDIO_SITE}/contact`, "Contact the studio"),
  );
  return sendResendEmail({
    from,
    to: rec.email,
    subject: `AMARÉ — ${charge.description} (${formatUsd(charge.cents)})`,
    html,
    text: `Hi ${rec.firstName}, we charged ${formatUsd(charge.cents)} for ${charge.description} (${s.when.dateLine}).`,
    tags: [{ name: "flow", value: "event_custom_charge_client" }],
  });
}

/**
 * @param {import("./event-reservation-store.mjs").EventReservation} rec
 */
export async function sendEventRemainingChargeEmail(rec) {
  const from = resolveFromAddress();
  const s = summaryLines(rec);
  const html = wrapEmail(
    `We charged the remaining ${formatUsd(rec.remainingCents)} for your private event.`,
    heroBlock(
      "Private event",
      `Remaining balance paid, ${esc(rec.firstName)}.`,
      `We charged <strong style="font-weight:500;color:#1a1816;">${esc(formatUsd(rec.remainingCents))}</strong> — the remaining event balance (package and styling, minus your deposit).`,
    ) +
      detailsBlock("Event details", eventDetailRows(rec)) +
      bodySection("See you at the studio. Extra time is $50 per 30 minutes if the event runs long.") +
      ctaBlock(`${STUDIO_SITE}/event-info`, "Event details"),
  );
  return sendResendEmail({
    from,
    to: rec.email,
    subject: `AMARÉ — remaining event balance (${formatUsd(rec.remainingCents)})`,
    html,
    text: `Hi ${rec.firstName}, we charged the remaining ${formatUsd(rec.remainingCents)} for your event on ${s.when.dateLine}. ${s.when.rangeLine}.`,
    tags: [{ name: "flow", value: "event_remaining_client" }],
  });
}

/**
 * @param {import("./event-reservation-store.mjs").EventReservation} rec
 * @param {string} [note]
 */
export async function sendEventCanceledEmail(rec, note) {
  const from = resolveFromAddress();
  const s = summaryLines(rec);
  const noteHtml = note
    ? bodySection(`Note from the studio: ${esc(note)}`)
    : "";
  const html = wrapEmail(
    `Your private event on ${s.when.dateLine} has been canceled.`,
    heroBlock(
      "Private event",
      `Your event was canceled, ${esc(rec.firstName)}.`,
      `We canceled the reservation for <strong style="font-weight:500;color:#1a1816;">${esc(s.when.dateLine)}</strong>. If a deposit refund applies, the studio will process it separately.`,
    ) +
      detailsBlock("Canceled reservation", eventDetailRows(rec)) +
      noteHtml +
      ctaBlock(`${STUDIO_SITE}/contact`, "Contact the studio"),
  );
  return sendResendEmail({
    from,
    to: rec.email,
    subject: "AMARÉ — your private event was canceled",
    html,
    text: `Hi ${rec.firstName}, your private event on ${s.when.dateLine} was canceled.${note ? ` Note: ${note}` : ""}`,
    tags: [{ name: "flow", value: "event_canceled_client" }],
  });
}

/**
 * @param {import("./event-reservation-store.mjs").EventReservation} rec
 * @param {{ oldDate: string, oldTime: string }} prev
 */
export async function sendEventRescheduledEmail(rec, prev) {
  const from = resolveFromAddress();
  const s = summaryLines(rec);
  const oldWhen = formatEventSchedule(prev.oldDate, prev.oldTime);
  const html = wrapEmail(
    `Your private event moved to ${s.when.dateLine}. ${s.when.rangeLine}.`,
    heroBlock(
      "Private event",
      `Your date was moved, ${esc(rec.firstName)}.`,
      `The studio moved your event from <strong style="font-weight:500;color:#1a1816;">${esc(oldWhen.dateLine)}</strong> at <strong style="font-weight:500;color:#1a1816;">${esc(oldWhen.timeLine)}</strong> to the new time below.`,
    ) +
      detailsBlock("Updated event", eventDetailRows(rec)) +
      ctaBlock(`${STUDIO_SITE}/event-info`, "Event details"),
  );
  return sendResendEmail({
    from,
    to: rec.email,
    subject: `AMARÉ — your event moved to ${s.when.dateLine}`,
    html,
    text: `Hi ${rec.firstName}, your event moved from ${oldWhen.dateLine} ${oldWhen.timeLine} to ${s.when.dateLine}. ${s.when.rangeLine}.`,
    tags: [{ name: "flow", value: "event_rescheduled_client" }],
  });
}
