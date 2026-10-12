/**
 * QA — optional client request telemetry (book/cancel diagnostics only).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseClientRequestTelemetry,
  clientTelemetryLogFields,
  clientSourceForLog,
} from "../netlify/functions/client-request-telemetry.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;

function check(label, ok) {
  if (ok) console.log(`PASS — ${label}`);
  else {
    console.error(`FAIL — ${label}`);
    failed += 1;
  }
}

const valid = parseClientRequestTelemetry({
  classId: 1,
  visitId: 2,
  clientSource: "mobile",
  platform: "android",
  appVersion: "1.0",
  buildNumber: "5",
  clientRequestId: "550e8400-e29b-41d4-a716-446655440000",
});
check("mobile payload parses", valid.clientSource === "mobile" && valid.platform === "android");
check("appVersion preserved", valid.appVersion === "1.0");
check("buildNumber preserved", valid.buildNumber === "5");
check(
  "clientRequestId preserved",
  valid.clientRequestId === "550e8400-e29b-41d4-a716-446655440000",
);

const malformed = parseClientRequestTelemetry({
  clientSource: "desktop",
  platform: "windows",
  appVersion: "x".repeat(100),
  buildNumber: 9999999999999,
  clientRequestId: "not a uuid!!!",
  email: "must-not-log@example.com",
});
check("invalid clientSource ignored", malformed.clientSource === null);
check("invalid platform ignored", malformed.platform === null);
check("appVersion truncated", malformed.appVersion?.length === 32);
check("malformed clientRequestId ignored", malformed.clientRequestId === null);
check("missing telemetry → unknown source", clientSourceForLog(malformed) === "unknown");

const web = parseClientRequestTelemetry({ clientSource: "web" });
check("web clientSource accepted", web.clientSource === "web");

const logFields = clientTelemetryLogFields(valid);
check("log fields omit PII keys", !("email" in logFields) && logFields.clientRequestId != null);

const cancelSrc = readFileSync(path.join(root, "netlify/functions/mindbody-class-cancel.mjs"), "utf8");
const bookSrc = readFileSync(path.join(root, "netlify/functions/mindbody-class-book.mjs"), "utf8");
check(
  "cancel uses telemetry only in logs",
  cancelSrc.includes("parseClientRequestTelemetry") &&
    cancelSrc.includes("clientTelemetryLogFields") &&
    !cancelSrc.includes("clientTelemetry.clientSource ==="),
);
check(
  "book uses telemetry only in logs",
  bookSrc.includes("parseClientRequestTelemetry") &&
    bookSrc.includes("class_book_response") &&
    !bookSrc.includes("clientTelemetry.platform"),
);

if (failed > 0) {
  console.error(`\n${failed} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll client-request telemetry checks passed.");
