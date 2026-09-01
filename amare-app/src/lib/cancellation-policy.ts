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

export function parseCancellationPolicyRaw(raw: unknown): CancellationPolicy | null {
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

export function cancellationPolicyFromSummary(summary: unknown): CancellationPolicy | null {
  if (!summary || typeof summary !== "object") return null;
  const raw = (summary as { cancellationPolicy?: unknown }).cancellationPolicy;
  return parseCancellationPolicyRaw(raw);
}

/** Single source of truth for Unlimited policy checkbox + submit validation. */
export function requiresUnlimitedPolicyAcceptance(policy: CancellationPolicy | null): boolean {
  return policy?.kind === "unlimited_fee" && policy.requiresAcknowledgment === true;
}

export function lateCancelConfirmCopy(policy: CancellationPolicy | null, hours = 12): string {
  if (requiresUnlimitedPolicyAcceptance(policy)) {
    return `Heads up: this class is within our ${hours}-hour cancellation window. Late cancellations and no-shows may be subject to a $10 fee.`;
  }
  return `Heads up: this class is within our ${hours}-hour cancellation window. Cancelling now may use your class credit.`;
}

export function bookPayloadForPolicy(
  classId: number,
  policy: CancellationPolicy | null,
  extra: Record<string, unknown> = {},
  policyAcknowledged = false,
  classStartIso?: string | null,
) {
  const payload: Record<string, unknown> = { classId, ...extra };
  const start =
    typeof classStartIso === "string" && classStartIso.trim()
      ? classStartIso.trim().slice(0, 40)
      : "";
  if (start) payload.classStartIso = start;
  if (requiresUnlimitedPolicyAcceptance(policy) && policyAcknowledged) {
    payload.policyAcknowledged = true;
    payload.policyVersion = policy?.policyVersion || UNLIMITED_FEE_POLICY_VERSION;
  }
  return payload;
}
