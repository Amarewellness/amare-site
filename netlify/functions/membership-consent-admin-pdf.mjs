import PDFDocument from "pdfkit";
import {
  formatEtFromIso,
  htmlToPlainText,
  sanitizeTermsForAdminDisplay,
  snapshotFromConsentRecord,
} from "./membership-consent-admin-lib.mjs";

/**
 * @param {{
 *   detail: Record<string, unknown>;
 *   hashVerification: { ok: boolean; storedHash: string; computedHash: string; reason: string | null };
 *   consentRecord: Record<string, unknown>;
 * }} input
 * @returns {Promise<Buffer>}
 */
export async function generateMembershipConsentProofPdf(input) {
  const { detail, hashVerification, consentRecord } = input;
  const snap = snapshotFromConsentRecord(consentRecord);
  const termsText = snap
    ? htmlToPlainText(sanitizeTermsForAdminDisplay(snap))
    : "No stored terms snapshot on this record.";

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 48, size: "LETTER" });
    /** @type {Buffer[]} */
    const chunks = [];
    doc.on("data", (c) => chunks.push(Buffer.from(c)));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    doc.fontSize(16).text("AMARÉ Membership Consent Record", { underline: true });
    doc.moveDown(0.5);

    if (!hashVerification.ok) {
      doc
        .fillColor("#8b0000")
        .fontSize(11)
        .text(
          "WARNING: SHA-256 verification failed for the stored terms snapshot. Do not treat this PDF as verified proof until the record is reviewed.",
          { width: 500 },
        );
      doc.fillColor("#000000");
      doc.moveDown();
    }

    doc.fontSize(11);
    const lines = [
      ["Client name", String(detail.clientName || "—")],
      ["Email", detail.email && detail.email !== "—" ? String(detail.email) : "—"],
      ["Mindbody Client ID", detail.mindbodyClientId != null ? String(detail.mindbodyClientId) : "—"],
      ["Membership / Plan", String(detail.membershipLabel || "—")],
      ["Local SKU", detail.localSku ? String(detail.localSku) : "—"],
      ["Consent ID", String(detail.consentId || "—")],
      ["Accepted (America/New_York)", formatEtFromIso(String(detail.acceptedAt || ""))],
      ["Accepted (UTC)", detail.acceptedAt ? String(detail.acceptedAt) : "—"],
      ["Terms version", detail.termsVersion ? String(detail.termsVersion) : "—"],
      ["SHA-256 (stored)", hashVerification.storedHash || "—"],
      ["SHA-256 (recomputed)", hashVerification.computedHash || "—"],
      ["Agreement accepted", detail.agreementAccepted ? "Yes" : "No"],
      ["Billing authorization", detail.billingAuthorized ? "Yes" : "No"],
      ["Purchase status", String(detail.purchaseStatus || "—")],
      ["Stripe subscription", detail.stripeSubscriptionId ? String(detail.stripeSubscriptionId) : "—"],
      ["Stripe checkout session", detail.stripeCheckoutSessionId ? String(detail.stripeCheckoutSessionId) : "—"],
      ["Mindbody contract id", detail.mindbodyContractId != null ? String(detail.mindbodyContractId) : "—"],
      ["Mindbody sale id", detail.mindbodySaleId != null ? String(detail.mindbodySaleId) : "—"],
      ["Source", String(detail.source || "—")],
    ];
    for (const [label, value] of lines) {
      doc.font("Helvetica-Bold").text(`${label}: `, { continued: true });
      doc.font("Helvetica").text(value);
    }

    doc.moveDown();
    doc.font("Helvetica-Bold").fontSize(12).text("Terms Accepted");
    doc.moveDown(0.25);
    doc.font("Helvetica").fontSize(10).text(termsText, { width: 500, lineGap: 2 });

    doc.moveDown(1.5);
    doc
      .fontSize(9)
      .fillColor("#444444")
      .text("Generated from AMARÉ's stored membership consent record.", { width: 500 });
    doc.text(`Generated: ${formatEtFromIso(new Date().toISOString())} (America/New_York)`, {
      width: 500,
    });
    doc.text(`Generated (UTC): ${new Date().toISOString()}`, { width: 500 });

    doc.end();
  });
}
