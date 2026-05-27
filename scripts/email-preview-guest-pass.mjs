/**
 * Write local preview HTML for guest booking confirmation email.
 * Usage: node scripts/email-preview-guest-pass.mjs
 */
import "./load-env.mjs";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderGuestBookingConfirmationPreview } from "../netlify/functions/guest-pass-emails.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = renderGuestBookingConfirmationPreview({
  guestFirstName: "snir guest",
  memberFirstName: "Sarah",
  className: "Reformer Sculpt – Intermediate",
  classStartDateTime: "2026-06-03T09:00:00",
  instructor: "Kesem Amar",
  requiresInStudioWaiver: true,
});

const out = path.join(root, "public", "email-preview-guest-pass-booking.html");
writeFileSync(out, html, "utf8");
console.log(`Wrote ${out}`);
