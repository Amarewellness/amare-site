import { apiJson } from "./client";

export type MemberBenefitStatus = "eligible" | "pending_token" | "redeemed" | "not_eligible" | string;

export type MemberBenefit = {
  id: string;
  title?: string;
  description?: string | null;
  terms?: string | null;
  partnerDisplayName?: string | null;
  logoUrl?: string | null;
  locationAddress?: string | null;
  partnerPhone?: string | null;
  memberStatus?: MemberBenefitStatus;
  validThrough?: string | null;
  redeemedAt?: string | null;
  availableAgain?: string | null;
  redeemedMessage?: string | null;
  message?: string | null;
  redemptionPeriodKey?: string | null;
};

export type MemberBenefitsResponse = {
  ok?: boolean;
  periodKey?: string;
  eligible?: boolean;
  benefits?: MemberBenefit[];
};

export type IssueBenefitTokenResponse = {
  ok?: boolean;
  benefitId?: string;
  qrUrl?: string;
  validThrough?: string;
  redemptionPeriodKey?: string;
  error?: string;
};

export function fetchMemberBenefits(accessToken: string): Promise<MemberBenefitsResponse> {
  return apiJson<MemberBenefitsResponse>("/api/benefits/member/list", accessToken);
}

export function issueBenefitToken(
  accessToken: string,
  benefitId: string,
): Promise<IssueBenefitTokenResponse> {
  return apiJson<IssueBenefitTokenResponse>("/api/benefits/member/issue-token", accessToken, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ benefitId }),
  });
}

export function benefitQrImageUrl(qrUrl: string): string {
  return `https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=${encodeURIComponent(qrUrl)}`;
}
