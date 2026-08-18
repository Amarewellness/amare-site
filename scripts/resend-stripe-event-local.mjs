/**
 * Resend one Stripe event to the local CLI listener. Does not print secrets.
 */
import { spawnSync } from "node:child_process";
import { loadLocalEnv } from "./load-env.mjs";

loadLocalEnv();
const sk = (process.env.STRIPE_SECRET_KEY || "").trim();
const eventId = String(process.argv[2] || "").trim();
if (!eventId.startsWith("evt_")) {
  console.error("usage: node scripts/resend-stripe-event-local.mjs evt_...");
  process.exit(1);
}
const r = spawnSync("stripe", ["events", "resend", eventId, "--api-key", sk], {
  encoding: "utf8",
  windowsHide: true,
});
if (r.stdout) {
  const redacted = r.stdout.replace(/sk_(?:test|live)_[A-Za-z0-9]+/g, "sk_***").replace(/whsec_[A-Za-z0-9]+/g, "whsec_***");
  console.log(redacted.trim().slice(0, 400));
}
if (r.status !== 0) {
  const err = String(r.stderr || r.error || "resend_failed")
    .replace(/sk_(?:test|live)_[A-Za-z0-9]+/g, "sk_***")
    .slice(0, 240);
  console.error(err);
  process.exit(r.status || 1);
}
console.log("resend_ok");
