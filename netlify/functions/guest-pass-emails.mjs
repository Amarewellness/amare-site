import { sendResendEmail } from "./resend-email-client.mjs";

function resendFrom() {
  return (
    (process.env.RESEND_FROM || "").trim() ||
    (process.env.SMS_ADMIN_REPORT_FROM || "").trim() ||
    "AMARÉ Wellness Studio <info@amarewellness.com>"
  );
}

const STUDIO_NAME = "AMARÉ Wellness Studio";
const STUDIO_LOCATION = "AMARÉ Wellness Studio";
const STUDIO_SITE = "https://www.amarewellness.com";
const STUDIO_LOGO = `${STUDIO_SITE}/logo/logo-amare-wellness-studio.png`;
const STUDIO_PHONE = "(954) 258-9238";
const STUDIO_TZ = "America/New_York";

const FF =
  "'DM Sans','Helvetica Neue',Helvetica,Arial,sans-serif";
const FF_SERIF =
  "'Fraunces','Cormorant Garamond',Georgia,'Times New Roman',serif";

/** @param {string} s */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** @param {string | null | undefined} isoLike */
function mindbodyInstantToUtcMs(isoLike) {
  if (isoLike == null || typeof isoLike !== "string") return NaN;
  const raw = isoLike.trim();
  if (!raw) return NaN;
  if (/[zZ]$/.test(raw) || /([+-])(\d{2}):?(\d{2})$/.test(raw)) {
    const t = Date.parse(raw);
    return Number.isNaN(t) ? NaN : t;
  }
  const mm = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?/.exec(raw);
  if (!mm) {
    const t = Date.parse(raw);
    return Number.isNaN(t) ? NaN : t;
  }
  const y = +mm[1],
    mo = +mm[2],
    d = +mm[3],
    h = +mm[4],
    mi = +mm[5];
  const se = mm[6] != null ? +mm[6] : 0;
  let t = Date.UTC(y, mo - 1, d, h + 5, mi, se);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: STUDIO_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  for (let i = 0; i < 48; i++) {
    const parts = fmt.formatToParts(new Date(t));
    const num = (typ) => parseInt(parts.find((p) => p.type === typ)?.value || "0", 10);
    const yy = num("year"),
      MM = num("month"),
      dd = num("day"),
      HH = num("hour"),
      mmm = num("minute"),
      ss = num("second");
    if (yy === y && MM === mo && dd === d && HH === h && mmm === mi && ss === se) return t;
    t += ((h - HH) * 3600 + (mi - mmm) * 60 + (se - ss)) * 1000;
    if (yy !== y || MM !== mo || dd !== d) t += (d - dd) * 86400000;
  }
  return NaN;
}

/** @param {string | null | undefined} isoLike */
function formatClassWhen(isoLike) {
  const ms = mindbodyInstantToUtcMs(isoLike);
  if (!Number.isFinite(ms)) {
    return { dateLine: escapeHtml(String(isoLike || "TBD")), timeLine: "" };
  }
  const d = new Date(ms);
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: STUDIO_TZ,
    weekday: "long",
  }).format(d);
  const datePart = new Intl.DateTimeFormat("en-US", {
    timeZone: STUDIO_TZ,
    month: "numeric",
    day: "numeric",
    year: "numeric",
  }).format(d);
  const timeLine = new Intl.DateTimeFormat("en-US", {
    timeZone: STUDIO_TZ,
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
  return {
    dateLine: escapeHtml(`${weekday}, ${datePart}`),
    timeLine: escapeHtml(timeLine),
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
<img src="${STUDIO_LOGO}" alt="${STUDIO_NAME}" width="220" style="display:block;width:220px;max-width:100%;height:auto;border:0;outline:none;" />
</a></td></tr>
<tr><td style="padding:0 32px;"><div style="height:1px;background-color:rgba(43,38,34,0.12);font-size:0;line-height:0;">&nbsp;</div></td></tr>`;
}

function emailShellEnd() {
  return `<tr><td style="padding:0 32px;"><div style="height:1px;background-color:rgba(43,38,34,0.12);font-size:0;line-height:0;">&nbsp;</div></td></tr>
<tr><td style="padding:24px 32px 32px 32px;">
<p style="margin:0;font-family:${FF};font-size:15px;line-height:1.6;color:#2b2622;">See you soon,</p>
<p style="margin:6px 0 0 0;font-family:${FF_SERIF};font-size:17px;font-style:italic;font-weight:400;color:#5c5650;letter-spacing:0.2px;">The ${STUDIO_NAME} Team</p>
</td></tr></tbody></table>
<table style="max-width:600px;width:100%;" width="600" border="0" cellspacing="0" cellpadding="0"><tbody><tr>
<td style="padding:20px 16px 8px 16px;font-family:${FF};font-size:12px;line-height:1.7;color:#7a726a;letter-spacing:0.3px;" align="center">
<a style="color:#7a726a;text-decoration:none;" href="${STUDIO_SITE}">${STUDIO_SITE}</a> &nbsp;&middot;&nbsp; <span style="color:#7a726a;">${STUDIO_PHONE}</span>
</td></tr></tbody></table>
</td></tr></tbody></table></body></html>`;
}

/** @param {string} inner */
function wrapReservationEmail(previewText, inner) {
  return emailShellStart(previewText) + inner + emailShellEnd();
}

/** @param {string} label @param {string} valueHtml @param {{ strong?: boolean; last?: boolean }} [opts] */
function detailRow(label, valueHtml, opts = {}) {
  const pad = opts.last ? "0" : "0 0 12px 0";
  const labStyle = `padding:${pad};font-family:${FF};font-size:11px;font-weight:500;letter-spacing:1.6px;text-transform:uppercase;color:#7a726a;`;
  const valStyle = opts.strong
    ? `padding:${pad};font-family:${FF};font-size:16px;font-weight:500;line-height:1.45;color:#1a1816;`
    : `padding:${pad};font-family:${FF};font-size:15px;font-weight:400;line-height:1.45;color:#2b2622;`;
  return `<tr><td style="${labStyle}" valign="top" width="100">${label}</td><td style="${valStyle}" valign="top">${valueHtml}</td></tr>`;
}

/** @param {string | null | undefined} fullName */
export function memberDisplayFirstName(fullName) {
  const name = String(fullName || "").trim();
  if (!name) return "";
  return name.split(/\s+/)[0] || "";
}

/** @param {string | null | undefined} memberFirstName */
function guestBookingLeadHtml(memberFirstName) {
  const inviter = memberDisplayFirstName(memberFirstName);
  if (inviter) {
    return `Your spot is confirmed. You&rsquo;re our guest courtesy of <strong style="font-weight:500;color:#1a1816;">${escapeHtml(inviter)}&rsquo;s Bring-a-Friend Pass</strong> at AMAR&Eacute; &mdash; here are the details.`;
  }
  return `Your spot is confirmed. You&rsquo;re our guest courtesy of a friend&rsquo;s <strong style="font-weight:500;color:#1a1816;">Bring-a-Friend Pass</strong> at AMAR&Eacute; &mdash; here are the details.`;
}

/**
 * @param {{
 *   className: string;
 *   classStartDateTime: string;
 *   instructor?: string | null;
 *   invitedByFirstName?: string | null;
 * }} opts
 */
function classDetailsBlock(opts) {
  const when = formatClassWhen(opts.classStartDateTime);
  const whenHtml = when.timeLine
    ? `${when.dateLine}<br /><span style="color:#5c5650;">${when.timeLine}</span>`
    : when.dateLine;
  const inviter = memberDisplayFirstName(opts.invitedByFirstName);
  const rows = [
    detailRow("Class", escapeHtml(opts.className), { strong: true }),
    opts.instructor ? detailRow("Instructor", escapeHtml(opts.instructor)) : "",
    detailRow("When", whenHtml),
    inviter ? detailRow("Invited by", escapeHtml(inviter)) : "",
    detailRow("Studio", escapeHtml(STUDIO_LOCATION), { last: true }),
  ].join("");
  return `<tr><td style="padding:28px 32px 8px 32px;">
<p style="margin:0 0 12px 0;font-family:${FF};font-size:11px;font-weight:500;letter-spacing:1.8px;text-transform:uppercase;color:#7a726a;">Class details</p>
<table style="background-color:#faf3eb;border-radius:6px;" width="100%" border="0" cellspacing="0" cellpadding="0"><tbody><tr><td style="padding:22px 24px;">
<table width="100%" border="0" cellspacing="0" cellpadding="0"><tbody>${rows}</tbody></table>
</td></tr></tbody></table></td></tr>`;
}

function whatToBringBlock() {
  const sections = [
    [
      "Reformer classes",
      "<strong style=\"color:#1a1816;\">Grip socks</strong> (or purchase at the studio), water, and yourself.",
    ],
    [
      "Mat classes",
      "We provide the mats. We simply ask that you bring a <strong style=\"color:#1a1816;\">long towel</strong> to place over the mat. We also sell towels at the studio. Of course, if you prefer to use your own mat, you&rsquo;re welcome to bring it.",
    ],
    [
      "Kangoo classes",
      "We provide the boots. We recommend wearing <strong style=\"color:#1a1816;\">high socks</strong> for the best fit and comfort. Kangoo is not suitable during pregnancy or for those with serious knee injuries.",
    ],
  ];
  const body = sections
    .map(([label, text], i) => {
      const mb = i < sections.length - 1 ? "18px" : "0";
      return (
        `<p style="margin:0 0 8px 0;font-family:${FF};font-size:14px;font-weight:600;color:#1a1816;">${label}</p>` +
        `<p style="margin:0 0 ${mb} 0;font-family:${FF};font-size:15px;font-weight:400;line-height:1.6;color:#2b2622;">${text}</p>`
      );
    })
    .join("");
  return `<tr><td style="padding:24px 32px 8px 32px;">
<p style="margin:0 0 14px 0;font-family:${FF};font-size:11px;font-weight:500;letter-spacing:1.8px;text-transform:uppercase;color:#7a726a;">What to bring</p>
${body}
</td></tr>`;
}

/** @param {{ firstVisit?: boolean }} opts */
function beforeYouArriveBlock(opts = {}) {
  const early = opts.firstVisit
    ? `<strong style="color:#1a1816;">First visit to AMAR&Eacute;</strong> &mdash; please arrive at least <strong style="color:#1a1816;">ten minutes early</strong> to complete your waiver at the front desk and check in.`
    : `Please arrive at least <strong style="color:#1a1816;">ten minutes early</strong> to complete your waiver at the front desk and check in.`;
  return `<tr><td style="padding:24px 32px 8px 32px;">
<p style="margin:0 0 10px 0;font-family:${FF};font-size:11px;font-weight:500;letter-spacing:1.8px;text-transform:uppercase;color:#7a726a;">Before you arrive</p>
<p style="margin:0;font-family:${FF};font-size:15px;font-weight:400;line-height:1.6;color:#2b2622;">${early}</p>
</td></tr>`;
}

function viewScheduleCta() {
  return `<tr><td style="padding:24px 32px 8px 32px;" align="center">
<table style="margin:0 auto;" border="0" cellspacing="0" cellpadding="0"><tbody><tr>
<td style="background-color:#1a1816;border-radius:4px;" align="center" bgcolor="#1a1816">
<a style="display:inline-block;padding:15px 38px;font-family:${FF};font-size:13px;font-weight:500;letter-spacing:1.8px;text-transform:uppercase;color:#faf3eb;text-decoration:none;background-color:#1a1816;border-radius:4px;" href="${STUDIO_SITE}/classes">View class schedule</a>
</td></tr></tbody></table>
<p style="margin:14px 0 0;font-family:${FF};font-size:13px;line-height:1.6;color:#7a726a;">Questions? Reply to this email or call us at ${STUDIO_PHONE}.</p>
</td></tr>`;
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

/**
 * @param {{
 *   guestEmail: string;
 *   guestFirstName: string;
 *   className: string;
 *   classStartDateTime: string;
 *   instructor?: string | null;
 *   requiresInStudioWaiver?: boolean;
 *   memberFirstName?: string | null;
 * }} opts
 */
export async function sendGuestBookingConfirmationEmail(opts) {
  const when = formatClassWhen(opts.classStartDateTime);
  const inviter = memberDisplayFirstName(opts.memberFirstName);
  const preview = inviter
    ? `${inviter} invited you to ${opts.className} on ${when.dateLine.replace(/<[^>]+>/g, "")}.`
    : `You're booked for ${opts.className} on ${when.dateLine.replace(/<[^>]+>/g, "")}.`;
  const html = wrapReservationEmail(
    escapeHtml(preview),
    heroBlock(
      "Bring a Friend",
      `You&rsquo;re booked, ${escapeHtml(opts.guestFirstName)}.`,
      guestBookingLeadHtml(opts.memberFirstName),
    ) +
      classDetailsBlock({
        className: opts.className,
        classStartDateTime: opts.classStartDateTime,
        instructor: opts.instructor,
        invitedByFirstName: opts.memberFirstName,
      }) +
      beforeYouArriveBlock({ firstVisit: opts.requiresInStudioWaiver === true }) +
      whatToBringBlock() +
      viewScheduleCta(),
  );
  return sendResendEmail({
    from: resendFrom(),
    to: opts.guestEmail,
    subject: `You're booked at AMARÉ — ${opts.className}`,
    html,
    tags: [{ name: "category", value: "guest_pass_guest_booking" }],
  });
}

/**
 * @param {{
 *   memberEmail: string;
 *   memberFirstName?: string;
 *   guestFirstName: string;
 *   guestLastInitial: string;
 *   className: string;
 *   classStartDateTime: string;
 *   instructor?: string | null;
 *   periodMode: string;
 *   resetsAt: string | null;
 * }} opts
 */
export async function sendMemberBookingConfirmationEmail(opts) {
  const passLine =
    opts.periodMode === "packLifetime"
      ? `Your guest pass for this pack is used &mdash; it expires ${opts.resetsAt ? formatClassWhen(opts.resetsAt).dateLine : "when your pack expires"}.`
      : `Your next Bring-a-Friend pass arrives ${opts.resetsAt ? formatClassWhen(opts.resetsAt).dateLine : "next month"}.`;
  const html = wrapReservationEmail(
    `Bring-a-Friend confirmed — ${opts.className}`,
    heroBlock(
      "Bring a Friend",
      "Guest confirmed",
      `You brought <strong style="font-weight:500;color:#1a1816;">${escapeHtml(opts.guestFirstName)} ${escapeHtml(opts.guestLastInitial)}.</strong> to class:`,
    ) +
      classDetailsBlock({
        className: opts.className,
        classStartDateTime: opts.classStartDateTime,
        instructor: opts.instructor,
      }) +
      bodySection(`${passLine}<br /><br />Please remind your guest to arrive ten minutes early for their in-studio waiver.`),
  );
  return sendResendEmail({
    from: resendFrom(),
    to: opts.memberEmail,
    subject: `Bring-a-Friend confirmed — ${opts.className}`,
    html,
    tags: [{ name: "category", value: "guest_pass_member_booking" }],
  });
}

/**
 * @param {{
 *   guestEmail: string;
 *   guestFirstName: string;
 *   className: string;
 *   classStartDateTime: string;
 *   instructor?: string | null;
 * }} opts
 */
export async function sendGuestCancellationEmail(opts) {
  const html = wrapReservationEmail(
    `Your AMARÉ class was cancelled — ${opts.className}`,
    heroBlock(
      "Cancellation",
      "Your spot was cancelled",
      `Hi ${escapeHtml(opts.guestFirstName)}, your booking has been cancelled:`,
    ) +
      classDetailsBlock({
        className: opts.className,
        classStartDateTime: opts.classStartDateTime,
        instructor: opts.instructor,
      }) +
      bodySection(`Hope to see you at AMAR&Eacute; soon! Contact us at ${STUDIO_PHONE} if you have questions.`),
  );
  return sendResendEmail({
    from: resendFrom(),
    to: opts.guestEmail,
    subject: `Your AMARÉ class was cancelled — ${opts.className}`,
    html,
    tags: [{ name: "category", value: "guest_pass_guest_cancel" }],
  });
}

/**
 * @param {{
 *   memberEmail: string;
 *   guestFirstName: string;
 *   guestLastInitial: string;
 *   className: string;
 *   classStartDateTime: string;
 *   instructor?: string | null;
 *   periodMode: string;
 *   resetsAt: string | null;
 *   monthName?: string;
 * }} opts
 */
export async function sendMemberCancellationEmail(opts) {
  const usedLine =
    opts.periodMode === "packLifetime"
      ? `<strong style="color:#1a1816;">Your guest pass for this pack is used up</strong> &mdash; it expires ${opts.resetsAt ? formatClassWhen(opts.resetsAt).dateLine : "when your pack expires"}.`
      : `<strong style="color:#1a1816;">Your Bring-a-Friend Pass${opts.monthName ? ` for ${escapeHtml(opts.monthName)}` : ""} is used up</strong> &mdash; your next pass arrives ${opts.resetsAt ? formatClassWhen(opts.resetsAt).dateLine : "next month"}.`;
  const html = wrapReservationEmail(
    "Cancellation confirmed — Bring-a-Friend",
    heroBlock(
      "Cancellation",
      "Both bookings cancelled",
      `Your class and ${escapeHtml(opts.guestFirstName)} ${escapeHtml(opts.guestLastInitial)}&rsquo;s spot were cancelled:`,
    ) +
      classDetailsBlock({
        className: opts.className,
        classStartDateTime: opts.classStartDateTime,
        instructor: opts.instructor,
      }) +
      bodySection(usedLine),
  );
  return sendResendEmail({
    from: resendFrom(),
    to: opts.memberEmail,
    subject: `Cancellation confirmed — Bring-a-Friend`,
    html,
    tags: [{ name: "category", value: "guest_pass_member_cancel" }],
  });
}

/** Preview helper for local HTML — not used in production sends. */
export function renderGuestBookingConfirmationPreview(opts) {
  return wrapReservationEmail(
    `You're booked for ${opts.className}.`,
    heroBlock(
      "Bring a Friend",
      `You&rsquo;re booked, ${escapeHtml(opts.guestFirstName)}.`,
      guestBookingLeadHtml(opts.memberFirstName),
    ) +
      classDetailsBlock({
        className: opts.className,
        classStartDateTime: opts.classStartDateTime,
        instructor: opts.instructor,
        invitedByFirstName: opts.memberFirstName,
      }) +
      beforeYouArriveBlock({ firstVisit: opts.requiresInStudioWaiver === true }) +
      whatToBringBlock() +
      viewScheduleCta(),
  );
}

/**
 * @param {{ to: string; subject: string; html: string }} opts
 */
export async function sendGuestPassStudioAlert(opts) {
  return sendResendEmail({
    from: resendFrom(),
    to: opts.to,
    subject: opts.subject,
    html: wrapReservationEmail(opts.subject, bodySection(opts.html)),
    tags: [{ name: "category", value: "guest_pass_studio_alert" }],
  });
}
