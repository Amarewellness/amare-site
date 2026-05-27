/**
 * Send sample Bring-a-Friend guest emails via Resend.
 * Usage: node scripts/send-guest-pass-email-sample.mjs --to=you@example.com
 */
import "./load-env.mjs";
import {
  sendGuestBookingConfirmationEmail,
  sendGuestCancellationEmail,
} from "../netlify/functions/guest-pass-emails.mjs";

const to =
  process.argv.find((a) => a.startsWith("--to="))?.split("=")[1]?.trim() || "snir1212@gmail.com";

const sample = {
  className: "Reformer Sculpt – Intermediate",
  classStartDateTime: "2026-06-03T09:00:00",
  instructor: "Kesem Amar",
  guestFirstName: "Snir",
  memberFirstName: "Sarah",
};

console.log(`Sending guest email samples to ${to}…\n`);

const booking = await sendGuestBookingConfirmationEmail({
  guestEmail: to,
  guestFirstName: sample.guestFirstName,
  memberFirstName: sample.memberFirstName,
  className: sample.className,
  classStartDateTime: sample.classStartDateTime,
  instructor: sample.instructor,
  requiresInStudioWaiver: true,
});
console.log("Guest booking confirmation:", booking);

const cancel = await sendGuestCancellationEmail({
  guestEmail: to,
  guestFirstName: sample.guestFirstName,
  className: sample.className,
  classStartDateTime: sample.classStartDateTime,
  instructor: sample.instructor,
});
console.log("Guest cancellation:", cancel);

if (!booking.ok || !cancel.ok) {
  process.exit(1);
}
