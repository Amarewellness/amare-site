/**
 * Membership consent admin — unit tests (lib + auth wiring).
 * Run: node scripts/qa-membership-consent-admin.mjs
 */

import assert from "node:assert/strict";
import {
  consentIdFromBlobKey,
  evidenceLabel,
  formatEtFromIso,
  htmlToPlainText,
  purchaseApplicabilityForSku,
  sanitizeTermsForAdminDisplay,
  snapshotFromConsentRecord,
  verifyStoredTermsHash,
} from "../netlify/functions/membership-consent-admin-lib.mjs";
import { adminAuthorized } from "../netlify/functions/new-client-sms-admin-auth.mjs";
import { generateMembershipConsentProofPdf } from "../netlify/functions/membership-consent-admin-pdf.mjs";

function check(name, cond) {
  assert.ok(cond, name);
  console.log(`ok ${name}`);
}

check(
  "consentIdFromBlobKey",
  consentIdFromBlobKey("v1/sub_amare_ABC_def") === "sub_amare_ABC_def",
);

const snapHtml =
  "<p><strong>Test agreement</strong></p><p>Twelve chars min for validation paths in related modules.</p>";
const rec = {
  consentId: "c1",
  agreementTextSnapshot: snapHtml,
  agreementTextHash: verifyStoredTermsHash(
    { agreementTextSnapshot: snapHtml, agreementTextHash: "" },
    null,
  ).computedHash,
};
rec.agreementTextHash = verifyStoredTermsHash(rec, null).computedHash;

check("snapshotFromConsentRecord", snapshotFromConsentRecord(rec).includes("Test agreement"));
check(
  "verifyStoredTermsHash ok",
  verifyStoredTermsHash(rec, null).ok === true,
);
check(
  "evidenceLabel strong",
  evidenceLabel(rec, { stripeSubscriptionId: "sub_x", agreementAcceptedAt: "2026-01-01T00:00:00.000Z", agreementTextHash: rec.agreementTextHash, mindbodyClientId: 1, id: "sub_amare_X" }, true) ===
    "STRONG_RECORD",
);
check(
  "evidenceLabel partial",
  evidenceLabel({}, { agreementVersion: "v1" }, false) === "PARTIAL_RECORD",
);
check(
  "evidenceLabel none",
  evidenceLabel({}, null, false) === "NO_AMARE_RECORD",
);

check(
  "sanitize strips script",
  !sanitizeTermsForAdminDisplay('<script>alert(1)</script><p>Hello world — long enough.</p>').includes("script"),
);
check(
  "htmlToPlainText",
  htmlToPlainText("<p>Line one</p><p>Line two — enough text.</p>").includes("Line one"),
);

check(
  "purchaseApplicability monthly",
  purchaseApplicabilityForSku("monthly_5") === "MEMBERSHIP",
);
check(
  "purchaseApplicability pack NCS",
  purchaseApplicabilityForSku("drop_in_single_class") === "NOT_APPLICABLE",
);

check("formatEtFromIso", formatEtFromIso("2026-10-14T15:11:55.576Z").includes("2026"));

const prev = process.env.ADMIN_DEBUG_TOKEN;
process.env.ADMIN_DEBUG_TOKEN = "test-admin-token-0123456789";
check(
  "adminAuthorized rejects missing header",
  adminAuthorized({ headers: {} }) === false,
);
check(
  "adminAuthorized accepts token",
  adminAuthorized({ headers: { "x-admin-token": "test-admin-token-0123456789" } }) === true,
);
if (prev === undefined) delete process.env.ADMIN_DEBUG_TOKEN;
else process.env.ADMIN_DEBUG_TOKEN = prev;

const pdf = await generateMembershipConsentProofPdf({
  detail: {
    consentId: "c1",
    clientName: "Test User",
    email: "test@example.com",
    mindbodyClientId: 100,
    membershipLabel: "Monthly 5",
    localSku: "monthly_5",
    acceptedAt: "2026-10-14T15:11:55.576Z",
    termsVersion: "2026-05-14-v2",
    agreementAccepted: true,
    billingAuthorized: true,
    purchaseStatus: "active",
    stripeSubscriptionId: "sub_test",
    stripeCheckoutSessionId: "cs_test",
    source: "Website",
  },
  hashVerification: verifyStoredTermsHash(rec, null),
  consentRecord: rec,
});
check("PDF generated", Buffer.isBuffer(pdf) && pdf.length > 500);
check("PDF magic bytes", pdf.subarray(0, 4).toString("utf8") === "%PDF");

console.log("membership-consent-admin QA passed");
