/**
 * Private-event emails (deposit, confirm, overtime).
 * Card layout matches docs/email-templates + guest-pass Resend mail.
 */

import { sendResendEmail } from "./resend-email-client.mjs";
import { formatEventSchedule, formatUsd, reservationDepositPaid, roomLabel } from "./event-booking-lib.mjs";

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

/**
 * Client summary page after deposit — same view as post-checkout success.
 * @param {import("./event-reservation-store.mjs").EventReservation} rec
 * @returns {string}
 */
function eventClientSummaryUrl(rec) {
  const offerId = String(rec.offerId || "").trim();
  if (!offerId.startsWith("off_")) return "";
  return `${siteBase()}/event-info?view=1&o=${encodeURIComponent(offerId)}`;
}

/**
 * @param {import("./event-reservation-store.mjs").EventReservation} rec
 * @param {string} [label]
 * @returns {string}
 */
function eventClientSummaryCta(rec, label = "View your reservation") {
  const url = eventClientSummaryUrl(rec);
  return url ? ctaBlock(url, label) : "";
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
export function eventEmailSummary(rec) {
  const when = formatEventSchedule(rec.eventDate, rec.eventTime, rec.schedule);
  const total = rec.packageCents + rec.stylingCents + (rec.cleaningCents || 0);
  return {
    when,
    total,
    name: `${rec.firstName} ${rec.lastName}`.trim(),
    room: roomLabel(rec.room),
    styling: rec.styling ? formatUsd(rec.stylingCents) : "No",
    cleaning: rec.cleaningCents ? formatUsd(rec.cleaningCents) : "",
  };
}

/** @param {string} previewText */
function emailShellStart(previewText) {
  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml"><head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style type="text/css">
@media only screen and (max-width:600px){
  .email-outer{padding:16px 8px !important;}
  .email-pad{padding-left:20px !important;padding-right:20px !important;}
  .email-card{padding:16px 16px !important;}
  .email-h1{font-size:24px !important;line-height:1.25 !important;}
  .email-lead{font-size:15px !important;}
  .email-logo{width:160px !important;}
  .email-label,.email-value{display:block !important;width:100% !important;}
  .email-label{padding-bottom:2px !important;}
  .email-value{padding-bottom:12px !important;}
}
</style>
</head><body>
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#faf3eb;">${previewText}</div>
<table style="background-color:#faf3eb;" width="100%" border="0" cellspacing="0" cellpadding="0"><tbody><tr>
<td class="email-outer" style="padding:32px 16px;" align="center">
<table style="max-width:600px;width:100%;background-color:#ffffff;border:1px solid rgba(43,38,34,0.08);border-radius:8px;" width="600" border="0" cellspacing="0" cellpadding="0"><tbody>
<tr><td class="email-pad" style="padding:36px 32px 20px 32px;" align="center">
<a href="${STUDIO_SITE}" style="text-decoration:none;">
<img class="email-logo" src="${STUDIO_LOGO}" alt="${esc(STUDIO_NAME)}" width="220" style="display:block;width:220px;max-width:100%;height:auto;border:0;outline:none;" />
</a></td></tr>
<tr><td class="email-pad" style="padding:0 32px;"><div style="height:1px;background-color:rgba(43,38,34,0.12);font-size:0;line-height:0;">&nbsp;</div></td></tr>`;
}

function emailShellEnd() {
  return `<tr><td class="email-pad" style="padding:0 32px;"><div style="height:1px;background-color:rgba(43,38,34,0.12);font-size:0;line-height:0;">&nbsp;</div></td></tr>
<tr><td class="email-pad" style="padding:24px 32px 32px 32px;">
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
  return `<tr><td class="email-pad" style="padding:36px 32px 8px 32px;">
<p style="margin:0 0 8px 0;font-family:${FF};font-size:11px;font-weight:500;letter-spacing:1.8px;text-transform:uppercase;color:#7a726a;">${eyebrow}</p>
<h1 class="email-h1" style="margin:0 0 18px 0;font-family:${FF_SERIF};font-size:30px;font-weight:400;line-height:1.2;color:#1a1816;letter-spacing:-0.4px;">${headline}</h1>
<p class="email-lead" style="margin:0;font-family:${FF};font-size:16px;font-weight:400;line-height:1.6;color:#2b2622;">${leadHtml}</p>
</td></tr>`;
}

/** @param {string} html */
function bodySection(html) {
  return `<tr><td class="email-pad" style="padding:24px 32px 8px 32px;">
<p class="email-lead" style="margin:0;font-family:${FF};font-size:15px;font-weight:400;line-height:1.6;color:#2b2622;">${html}</p>
</td></tr>`;
}

/** @param {string} label @param {string} valueHtml @param {{ strong?: boolean; last?: boolean }} [opts] */
function detailRow(label, valueHtml, opts = {}) {
  const pad = opts.last ? "0" : "0 0 12px 0";
  const labStyle = `padding:${pad};font-family:${FF};font-size:11px;font-weight:500;letter-spacing:1.6px;text-transform:uppercase;color:#7a726a;`;
  const valStyle = opts.strong
    ? `padding:${pad};font-family:${FF};font-size:16px;font-weight:500;line-height:1.45;color:#1a1816;`
    : `padding:${pad};font-family:${FF};font-size:15px;font-weight:400;line-height:1.45;color:#2b2622;`;
  return `<tr><td class="email-label" style="${labStyle}" valign="top" width="110">${label}</td><td class="email-value" style="${valStyle}" valign="top">${valueHtml}</td></tr>`;
}

/** @param {string} title @param {string} rowsHtml */
function detailsBlock(title, rowsHtml) {
  return `<tr><td class="email-pad" style="padding:28px 32px 8px 32px;">
<p style="margin:0 0 12px 0;font-family:${FF};font-size:11px;font-weight:500;letter-spacing:1.8px;text-transform:uppercase;color:#7a726a;">${title}</p>
<table style="background-color:#faf3eb;border-radius:6px;" width="100%" border="0" cellspacing="0" cellpadding="0"><tbody><tr><td class="email-card" style="padding:22px 24px;">
<table width="100%" border="0" cellspacing="0" cellpadding="0"><tbody>${rowsHtml}</tbody></table>
</td></tr></tbody></table></td></tr>`;
}

/** @param {string} href @param {string} label */
function ctaBlock(href, label) {
  return `<tr><td class="email-pad" style="padding:24px 32px 8px 32px;" align="center">
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
  const s = eventEmailSummary(rec);
  const muted = "color:#5c5650;font-weight:400;font-size:13px;";
  const blocks = Array.isArray(s.when.blocks) ? s.when.blocks : [];
  const lines = blocks.length
    ? blocks
        .map(
          (b) =>
            `<span style="${muted}"><strong style="color:#1a1816;font-weight:500;">${esc(b.label)}</strong> ${esc(b.start)}&ndash;${esc(b.end)}</span>`,
        )
        .join("<br />\n")
    : `<span style="${muted}"><strong style="color:#1a1816;font-weight:500;">Arrival</strong> ${esc(s.when.arrival)}</span><br />
<span style="${muted}"><strong style="color:#1a1816;font-weight:500;">Class time</strong> ${esc(s.when.classStart)}&ndash;${esc(s.when.classEnd)}</span><br />
<span style="${muted}"><strong style="color:#1a1816;font-weight:500;">After</strong> ${esc(s.when.classEnd)}&ndash;${esc(s.when.afterEnd)}</span>`;
  return `${esc(s.when.dateLine)}<br />
${lines}`;
}

function eventDetailRows(rec, opts = {}) {
  const s = eventEmailSummary(rec);
  const rows = [
    opts.includeContact ? detailRow("Guest", esc(s.name), { strong: true }) : "",
    opts.includeContact ? detailRow("Email", esc(rec.email)) : "",
    opts.includeContact && rec.phone ? detailRow("Phone", esc(rec.phone)) : "",
    detailRow("When", whenScheduleHtml(rec), { strong: !opts.includeContact }),
    detailRow("Room", esc(s.room)),
    detailRow("Guests", esc(String(rec.guests))),
    detailRow("Styling", esc(s.styling)),
    s.cleaning ? detailRow("Cleaning", esc(s.cleaning)) : "",
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
  const s = eventEmailSummary(rec);
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
      eventClientSummaryCta(rec),
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
  const s = eventEmailSummary(rec);
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
      eventClientSummaryCta(rec),
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
  const s = eventEmailSummary(rec);
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
  const s = eventEmailSummary(rec);
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
  const s = eventEmailSummary(rec);
  const html = wrapEmail(
    `We charged the remaining ${formatUsd(rec.remainingCents)} for your private event.`,
    heroBlock(
      "Private event",
      `Remaining balance paid, ${esc(rec.firstName)}.`,
      `We charged <strong style="font-weight:500;color:#1a1816;">${esc(formatUsd(rec.remainingCents))}</strong> — the remaining event balance (package, styling, and cleaning, minus your deposit).`,
    ) +
      detailsBlock("Event details", eventDetailRows(rec)) +
      bodySection("See you at the studio. Extra time is $50 per 30 minutes if the event runs long.") +
      eventClientSummaryCta(rec),
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
  const s = eventEmailSummary(rec);
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
  const s = eventEmailSummary(rec);
  const oldWhen = formatEventSchedule(prev.oldDate, prev.oldTime, rec.schedule);
  const html = wrapEmail(
    `Your private event moved to ${s.when.dateLine}. ${s.when.rangeLine}.`,
    heroBlock(
      "Private event",
      `Your date was moved, ${esc(rec.firstName)}.`,
      `The studio moved your event from <strong style="font-weight:500;color:#1a1816;">${esc(oldWhen.dateLine)}</strong> at <strong style="font-weight:500;color:#1a1816;">${esc(oldWhen.timeLine)}</strong> to the new time below.`,
    ) +
      detailsBlock("Updated event", eventDetailRows(rec)) +
      eventClientSummaryCta(rec),
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

/**
 * @param {import("./event-inquiry-store.mjs").EventInquiry} inquiry
 */
export async function sendEventInquiryAdminEmail(inquiry) {
  const adminTo = parseAdminRecipients();
  if (!adminTo.length) return { ok: true, skipped: true };
  const from = resolveFromAddress();
  const name = `${inquiry.firstName} ${inquiry.lastName}`.trim() || inquiry.email;
  const when = [inquiry.eventDate, inquiry.eventTime].filter(Boolean).join(" · ") || "Date not specified";
  const adminUrl = `${siteBase()}/admin/events`;
  const html = wrapEmail(
    `New event inquiry from ${name}.`,
    heroBlock(
      "Studio admin",
      "New event inquiry",
      `${esc(name)} sent the /privateevents form. This is not a paid deposit.`,
    ) +
      detailsBlock(
        "Inquiry",
        [
          detailRow("Name", esc(name), { strong: true }),
          detailRow("Email", esc(inquiry.email)),
          inquiry.phone ? detailRow("Phone", esc(inquiry.phone)) : "",
          detailRow("Preferred", esc(when)),
          detailRow("Message", esc(inquiry.message).replace(/\n/g, "<br />"), { last: true }),
        ].join(""),
      ) +
      ctaBlock(adminUrl, "Open event admin"),
  );
  return sendResendEmail({
    from,
    to: adminTo,
    subject: `Event inquiry — ${name}`,
    html,
    text: `New event inquiry from ${name} (${inquiry.email}). ${when}. ${inquiry.message}`,
    tags: [{ name: "flow", value: "event_inquiry_admin" }],
  });
}

/**
 * @param {import("./event-offer-store.mjs").EventOffer} offer
 * @param {string} offerUrl
 */
export async function sendEventDetailsEmail(offer, offerUrl) {
  const from = resolveFromAddress();
  const name = offer.firstName || "there";
  const pkg = formatUsd(Number.isInteger(offer.packageCents) ? offer.packageCents : 55000);
  const when = formatEventSchedule(offer.eventDate, offer.eventTime, offer.schedule);
  const cleaning = offer.cleaningCents ? formatUsd(offer.cleaningCents) : "";
  const scheduleRows = (when.blocks || []).map((block) => detailRow(block.label, `${esc(block.start)}–${esc(block.end)}`));
  const html = wrapEmail(
    `How private events work at AMARÉ — format, rooms, and the package.`,
    heroBlock(
      "Event details",
      `How private events work, ${esc(name)}.`,
      `This is an explanation only — no payment on this page. Review the selected schedule, rooms, styling, and how the ${esc(pkg)} package works. We’ll send a separate booking link when you’re ready to hold a date.`,
    ) +
      detailsBlock(
        "What’s inside",
        [
          ...scheduleRows,
          detailRow("Package", esc(pkg)),
          ...(cleaning ? [detailRow("Cleaning", esc(cleaning))] : []),
        ].join(""),
      ) +
      ctaBlock(offerUrl, "Read the event details"),
  );
  return sendResendEmail({
    from,
    to: offer.email,
    subject: `AMARÉ — event details for ${name}`,
    html,
    text: `Hi ${name}, here’s your selected event schedule: ${when.rangeLine}. Package ${pkg}${cleaning ? `, cleaning ${cleaning}` : ""}. No payment on this page. ${offerUrl}`,
    tags: [{ name: "flow", value: "event_details_client" }],
  });
}

/**
 * @param {import("./event-offer-store.mjs").EventOffer} offer
 * @param {string} offerUrl
 */
export async function sendEventOfferEmail(offer, offerUrl) {
  const from = resolveFromAddress();
  const name = offer.firstName || "there";
  const when = formatEventSchedule(offer.eventDate, offer.eventTime, offer.schedule);
  const deposit = formatUsd(Number.isInteger(offer.depositCents) ? offer.depositCents : 20000);
  const pkg = formatUsd(Number.isInteger(offer.packageCents) ? offer.packageCents : 55000);
  const cleaning = offer.cleaningCents ? formatUsd(offer.cleaningCents) : "";
  const roomNames = { auto: "Auto", reformer: "Reformer", mat: "Mat", kangoo: "Kangoo Jump" };
  const roomLine = offer.room ? roomNames[offer.room] || offer.room : "";
  const lockedNote = offer.lockDateTime
    ? `Your date and start time are set — ${esc(when.dateLine)} at ${esc(when.timeLine)}. You won’t need to pick a different time.`
    : `We pre-filled your preferred date. You can still adjust it on the form if needed.`;
  const partyNote = offer.lockGuestsRoom && offer.guests
    ? ` Guest count and room are also set (${offer.guests} guests${roomLine ? `, ${roomLine}` : ""}).`
    : "";
  const blockRows = (when.blocks || []).map((b, i, arr) =>
    detailRow(b.label, `${esc(b.start)}–${esc(b.end)}`, {
      last: i === arr.length - 1 && !offer.guests && !roomLine && !cleaning,
    }),
  );
  const html = wrapEmail(
    `Reserve your AMARÉ private event — ${when.dateLine}.`,
    heroBlock(
      "Reserve your date",
      `Your booking link is ready, ${esc(name)}.`,
      `${lockedNote}${partyNote} Pay the ${esc(deposit)} deposit on the next page to request the date.`,
    ) +
      detailsBlock(
        "Event",
        [
          detailRow("Date", esc(when.dateLine), { strong: true }),
          ...blockRows,
          ...(offer.guests ? [detailRow("Guests", esc(String(offer.guests)))] : []),
          ...(roomLine ? [detailRow("Room", esc(roomLine))] : []),
          detailRow("Package", esc(pkg)),
          ...(cleaning ? [detailRow("Cleaning", esc(cleaning))] : []),
          detailRow("Deposit now", esc(deposit), { last: true }),
        ].join(""),
      ) +
      ctaBlock(offerUrl, "Reserve your date"),
  );
  return sendResendEmail({
    from,
    to: offer.email,
    subject: `AMARÉ — pay to reserve ${when.dateLine}`,
    html,
    text: `Hi ${name}, your booking link is ready. ${when.dateLine}. ${when.rangeLine}. ${offerUrl}`,
    tags: [{ name: "flow", value: "event_offer_client" }],
  });
}

/** @param {number} minutes */
function minutesLabel(minutes) {
  const n = Number(minutes);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 60) return `${n} min`;
  if (n % 60 === 0) {
    const hours = n / 60;
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }
  return `${n} min`;
}

/**
 * Personalized “how your event works” email from a reservation (not the generic /privateevents page).
 * @param {import("./event-reservation-store.mjs").EventReservation} rec
 */
export async function sendEventReservationDetailsEmail(rec) {
  const from = resolveFromAddress();
  const s = eventEmailSummary(rec);
  const schedule = s.when.schedule || {};
  const blocks = Array.isArray(s.when.blocks) ? s.when.blocks : [];
  const totalMin =
    Number(schedule.beforeMinutes || 0) + Number(schedule.sessionMinutes || 0) + Number(schedule.afterMinutes || 0);
  const studioTime = minutesLabel(totalMin) || "studio time";
  const sessionLabel = String(schedule.sessionLabel || "Workout");
  const pkg = formatUsd(rec.packageCents);
  const deposit = formatUsd(rec.depositCents);
  const remaining = formatUsd(rec.remainingCents);
  const depositIn = reservationDepositPaid(rec);
  const remainingPaid = rec.remainingPaid === true;
  const hasDeposit = Number(rec.depositCents) > 0;
  const timelineHtml = blocks.length
    ? blocks
        .map((block, i) => {
          const mins =
            block.kind === "before"
              ? schedule.beforeMinutes
              : block.kind === "after"
                ? schedule.afterMinutes
                : schedule.sessionMinutes;
          const pad = i === blocks.length - 1 ? "4px 0 0 0" : "4px 0 14px 0";
          return `<tr>
<td style="padding:0 14px 0 0;" valign="top" width="72">
<p style="margin:0;font-family:${FF};font-size:12px;font-weight:500;letter-spacing:0.4px;color:#7a726a;">${esc(minutesLabel(mins) || block.label)}</p>
</td>
<td style="padding:${pad};font-family:${FF};font-size:15px;line-height:1.5;color:#2b2622;" valign="top">
<strong style="font-weight:500;color:#1a1816;">${esc(block.label)}</strong>
 ${esc(block.start)}–${esc(block.end)}<br />
<span style="color:#5c5650;font-size:14px;">${esc(block.copy || "")}</span>
</td>
</tr>`;
        })
        .join("")
    : `<tr><td style="padding:4px 0;font-family:${FF};font-size:15px;color:#2b2622;">${esc(s.when.rangeLine || studioTime)}</td></tr>`;
  const paymentLead = remainingPaid
    ? `This event is paid in full — thank you.`
    : !hasDeposit
      ? `No deposit is required. The remaining ${esc(remaining)} is due the day before the event.`
      : depositIn
        ? `Your ${esc(deposit)} deposit is in. The remaining ${esc(remaining)} is due the day before.`
        : `The ${esc(deposit)} deposit is still due. The remaining ${esc(remaining)} is due the day before the event.`;
  const stylingLine = rec.styling
    ? `AMARÉ room styling is included (${esc(s.styling)}).`
    : `Bring your own décor in the time before class — no extra fee. Please skip glitter, confetti, and anything that stains.`;
  const html = wrapEmail(
    `Your AMARÉ private event details — ${s.when.dateLine}.`,
    heroBlock(
      "Your event",
      `How your private event works, ${esc(rec.firstName)}.`,
      `Here’s the format for <strong style="font-weight:500;color:#1a1816;">${esc(s.when.dateLine)}</strong> — about ${esc(studioTime)} in the studio.`,
    ) +
      detailsBlock(
        "Your reservation",
        [
          detailRow("When", `${esc(s.when.dateLine)}<br />${esc(s.when.rangeLine)}`, { strong: true }),
          detailRow("Room", `${esc(s.room)} · ${esc(String(rec.guests))} guests`),
          detailRow("Package", esc(pkg)),
          rec.styling ? detailRow("Styling", esc(s.styling)) : "",
          s.cleaning ? detailRow("Cleaning", esc(s.cleaning)) : "",
          remainingPaid
            ? detailRow("Paid", esc(formatUsd(s.total)), { last: true })
            : !hasDeposit
              ? detailRow("Payment", `No deposit · ${esc(remaining)} day before`, { last: true })
              : detailRow(
                  "Payment",
                  `${esc(deposit)}${depositIn ? " deposit received" : " deposit still due"} · ${esc(remaining)} day before`,
                  { last: true },
                ),
        ].join(""),
      ) +
      `<tr><td class="email-pad" style="padding:28px 32px 8px 32px;">
<p style="margin:0 0 12px 0;font-family:${FF};font-size:11px;font-weight:500;letter-spacing:1.8px;text-transform:uppercase;color:#7a726a;">Your format</p>
<table style="background-color:#faf3eb;border-radius:6px;" width="100%" border="0" cellspacing="0" cellpadding="0"><tbody><tr><td class="email-card" style="padding:22px 24px;">
<table width="100%" border="0" cellspacing="0" cellpadding="0"><tbody>${timelineHtml}</tbody></table>
</td></tr></tbody></table>
<p style="margin:14px 0 0;font-family:${FF};font-size:14px;line-height:1.55;color:#5c5650;">${esc(sessionLabel)} with an instructor, plus time to decorate and celebrate. A table for cake if you bring it.</p>
</td></tr>` +
      `<tr><td class="email-pad" style="padding:24px 32px 8px 32px;">
<table style="background-color:#faf3eb;border-radius:8px;" width="100%" border="0" cellspacing="0" cellpadding="0"><tbody><tr><td class="email-card" style="padding:22px 24px;">
<p style="margin:0 0 12px 0;font-family:${FF};font-size:11px;font-weight:500;letter-spacing:1.8px;text-transform:uppercase;color:#7a726a;">A few things to keep in mind</p>
<p style="margin:0 0 10px 0;font-family:${FF};font-size:15px;line-height:1.55;color:#2b2622;">${paymentLead}</p>
<p style="margin:0 0 10px 0;font-family:${FF};font-size:15px;line-height:1.55;color:#2b2622;">${stylingLine}</p>
<p style="margin:0 0 10px 0;font-family:${FF};font-size:15px;line-height:1.55;color:#2b2622;">Extra time is $50 for every 30 minutes beyond the agreed time — including late arrivals.</p>
<p style="margin:0 0 10px 0;font-family:${FF};font-size:15px;line-height:1.55;color:#2b2622;">If other classes are running, the event stays in your room. If the studio is otherwise free, you’re welcome to use the lobby too.</p>
<p style="margin:0;font-family:${FF};font-size:15px;line-height:1.55;color:#2b2622;">We’re open Sunday morning through Friday afternoon.</p>
</td></tr></tbody></table>
</td></tr>` +
      ctaBlock(`${STUDIO_SITE}/contact`, "Contact the studio"),
  );
  const text = [
    `Hi ${rec.firstName}, here are your AMARÉ private event details.`,
    `${s.when.dateLine}. ${s.when.rangeLine}.`,
    `${s.room}, ${rec.guests} guests. Package ${pkg}. Deposit ${deposit}. Remaining ${remaining}.`,
    rec.styling ? `Styling included (${s.styling}).` : "Bring your own décor if you like — no extra fee.",
    `Extra time is $50 per 30 minutes.`,
  ].join(" ");
  return sendResendEmail({
    from,
    to: rec.email,
    subject: `AMARÉ — your event details, ${rec.firstName}`,
    html,
    text,
    tags: [{ name: "flow", value: "event_reservation_details_client" }],
  });
}
