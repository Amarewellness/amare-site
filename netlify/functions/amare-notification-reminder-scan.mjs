/**
 * Netlify scheduled worker for AMARÉ class reminders.
 * Schedule lives in netlify.toml. Must not export a named handler.
 */
import { withLambda } from "@netlify/aws-lambda-compat";
import { jsonResponse } from "./mindbody-consumer-lib.mjs";
import { runClassReminderScan } from "./amare-notification-reminder-send.mjs";

function isScheduledInvocation(event) {
  if (!event || typeof event !== "object") return false;
  const e = /** @type {{ headers?: Record<string, string | undefined>; source?: string }} */ (event);
  if (e.source === "netlify-scheduled-function") return true;
  const headers = e.headers || {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === "x-netlify-event" && String(v || "").toLowerCase() === "schedule") {
      return true;
    }
  }
  return false;
}

export async function lambdaHandler(event = {}) {
  if (!isScheduledInvocation(event)) {
    return jsonResponse(404, { ok: false, error: "not_found" });
  }
  const result = await runClassReminderScan();
  console.log(
    JSON.stringify({
      event: "amare_class_reminder_scan",
      ok: result.ok === true,
      scanned: result.scanned || 0,
      sent: result.sent || 0,
      skipped: result.skipped || null,
    }),
  );
  return jsonResponse(200, {
    ok: result.ok === true,
    scanned: result.scanned || 0,
    sent: result.sent || 0,
    skipped: result.skipped || null,
  });
}

export default withLambda(lambdaHandler);
