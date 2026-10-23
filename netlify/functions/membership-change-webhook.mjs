/**
 * `invoice.paid` hook for scheduled admin plan changes.
 *
 * Runs only when the SubscriptionRecord carries `pendingPlanChange`. If the paid invoice is the
 * renewal that starts the new plan, the record's plan fields switch to the target SKU before the
 * existing Mindbody sync reads `record.localSku`. Any other invoice leaves the record untouched.
 */
import { applyPendingPlanChangeToRecord, matchPendingPlanChangeToInvoice } from "./membership-change-lib.mjs";

/**
 * @param {{
 *   stripe: any,
 *   subStore: { patch: (id: string, partial: Record<string, unknown>) => Promise<unknown> },
 *   record: Record<string, any>,
 *   invoice: any,
 * }} input
 * @returns {Promise<{ record: Record<string, any>, applied: boolean, reason: string }>}
 */
export async function applyPendingPlanChangeOnInvoicePaid(input) {
  const { record, invoice } = input;
  const pending = record?.pendingPlanChange;
  if (!pending?.toSku) return { record, applied: false, reason: "no_pending_change" };

  let metadataSku = null;
  try {
    const sub = await input.stripe.subscriptions.retrieve(record.stripeSubscriptionId);
    metadataSku = typeof sub?.metadata?.localSku === "string" ? sub.metadata.localSku : null;
  } catch {
    metadataSku = null;
  }
  const match = matchPendingPlanChangeToInvoice({ pending, invoice, subscriptionMetadataSku: metadataSku });
  console.log(
    JSON.stringify({
      event: "membership_change_pending_invoice_check",
      subscriptionId: record.id,
      invoiceId: invoice?.id ?? null,
      operationId: pending.operationId ?? null,
      apply: match.apply,
      reason: match.reason,
    }),
  );
  if (!match.apply) return { record, applied: false, reason: match.reason };

  const partial = applyPendingPlanChangeToRecord(record, {
    invoiceId: String(invoice.id),
    appliedAt: new Date().toISOString(),
  });
  if (!partial) return { record, applied: false, reason: "nothing_to_apply" };
  const patched = await input.subStore.patch(record.id, partial);
  if (!patched) {
    throw Object.assign(new Error("pending_plan_change_patch_failed"), { retryable: true });
  }
  return { record: { ...record, ...partial }, applied: true, reason: match.reason };
}
