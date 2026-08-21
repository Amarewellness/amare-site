import { apiJson } from "../api/client";

export type MemberBenefit = {
  id: string;
  title: string;
  description: string;
  partner?: string;
  badge?: string;
};

/** Studio perks from `/pricing` — keep copy aligned with `src/content/pricing.html`. */
export const STUDIO_MEMBER_BENEFITS: MemberBenefit[] = [
  {
    id: "guest-pass",
    title: "Monthly Guest Pass",
    description: "Bring one friend for free every month.",
  },
  {
    id: "priority-waitlist",
    title: "Priority waitlist",
    description: "Members get first priority when a spot becomes available.",
  },
  {
    id: "priority-booking",
    title: "Priority booking access",
    description: "Book your favorite classes before spots fill up.",
  },
  {
    id: "retail-discount",
    title: "10% off grip socks & towels",
    description: "Save on studio essentials every time you shop.",
  },
  {
    id: "private-events",
    title: "Private event savings",
    description: "Enjoy 10% off your private event booking as an Amaré member.",
  },
  {
    id: "grip-socks",
    title: "Free grip socks on first signup",
    description: "Pick up your complimentary pair at the front desk when you first join your plan.",
    badge: "Limited time offer",
  },
];

/** Shown if `/api/benefits/public/list` is empty (local / no catalog). */
export const FALLBACK_PARTNER_BENEFITS: MemberBenefit[] = [
  {
    id: "ciocca-facial",
    title: "Complimentary Mini Ciocca Signature Facial",
    partner: "Giovanna Ciocca, M.D.",
    description:
      "45-minute facial ($150 value): skin analysis, deep cleansing, HydraFreeze, blue light therapy, and skincare recommendations. Members also get 15% off skincare during their visit.",
  },
  {
    id: "hollywood-laser",
    title: "Complimentary Laser Session",
    partner: "Hollywood Laser Med Spa",
    description:
      "Monthly members and 10/20 pack holders receive one complimentary laser session for a small or medium area.",
  },
  {
    id: "neverland-drink",
    title: "One complimentary drink of your choice",
    partner: "Neverland Coffee Bar",
    description: "Enjoy one complimentary drink of your choice at Neverland Coffee Bar.",
  },
];

type PublicBenefitRow = {
  id?: string;
  title?: string;
  description?: string | null;
  partnerDisplayName?: string | null;
  frequency?: string;
};

type PublicBenefitsResponse = {
  ok?: boolean;
  benefits?: PublicBenefitRow[];
};

function mapPublicBenefit(row: PublicBenefitRow, index: number): MemberBenefit | null {
  const title = String(row.title || "").trim();
  if (!title) return null;
  const partner = String(row.partnerDisplayName || "").trim();
  const description =
    String(row.description || "").trim() ||
    (row.frequency === "campaign"
      ? "Limited-time partner perk for monthly members."
      : "Included with your monthly membership.");
  return {
    id: String(row.id || `partner-${index}`),
    title,
    description,
    partner: partner || undefined,
  };
}

export async function fetchPublicPartnerBenefits(): Promise<MemberBenefit[]> {
  const data = await apiJson<PublicBenefitsResponse>("/api/benefits/public/list", null);
  if (!data?.ok || !Array.isArray(data.benefits)) return FALLBACK_PARTNER_BENEFITS;
  const mapped = data.benefits
    .map((row, index) => mapPublicBenefit(row, index))
    .filter((row): row is MemberBenefit => row != null);
  return mapped.length > 0 ? mapped : FALLBACK_PARTNER_BENEFITS;
}
