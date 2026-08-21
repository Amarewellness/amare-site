export type CancellationPolicyKind = "unlimited_fee" | "credit_forfeit" | "none";

export type CancellationPolicy = {
  kind: CancellationPolicyKind;
  requiresAcknowledgment: boolean;
  policyVersion: string | null;
  title: string | null;
  body: string | null;
  checkboxLabel: string | null;
};

export const UNLIMITED_FEE_POLICY_VERSION = "unlimited_booking_fee_v1";

export function cancellationPolicyFromSummary(summary: unknown): CancellationPolicy | null {
  if (!summary || typeof summary !== "object") return null;
  const raw = (summary as { cancellationPolicy?: unknown }).cancellationPolicy;
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  const kind = String(p.kind || "");
  if (kind !== "unlimited_fee" && kind !== "credit_forfeit" && kind !== "none") return null;
  return {
    kind,
    requiresAcknowledgment: p.requiresAcknowledgment === true,
    policyVersion: typeof p.policyVersion === "string" ? p.policyVersion : null,
    title: typeof p.title === "string" ? p.title : null,
    body: typeof p.body === "string" ? p.body : null,
    checkboxLabel: typeof p.checkboxLabel === "string" ? p.checkboxLabel : null,
  };
}

export function bookPayloadForPolicy(classId: number, policy: CancellationPolicy | null, extra: Record<string, unknown> = {}) {
  const payload: Record<string, unknown> = { classId, ...extra };
  if (policy?.kind === "unlimited_fee" && policy.requiresAcknowledgment) {
    payload.policyAcknowledged = true;
    payload.policyVersion = policy.policyVersion || UNLIMITED_FEE_POLICY_VERSION;
  }
  return payload;
}
