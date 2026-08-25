import { formatMindbodyEt, mindbodyInstantToUtcMs } from "./mindbody-time";
import type { GuestCancelPreflight } from "../api/cancel-api";
import { isWithinLateCancelWindow } from "./schedule-utils";

export type GuestAttached = {
  guestFirstName?: string;
  guestLastInitial?: string;
  status?: string;
};

export type BringAFriendBookedClass = {
  classId: number;
  name?: string;
  startDateTime?: string;
  spotsRemaining?: number | null;
  guestAttached?: GuestAttached | null;
};

export type BringAFriendUsedFor = {
  guestFirstName?: string;
  guestLastInitial?: string;
  classId?: number;
  className?: string | null;
  classStartDateTime?: string | null;
};

export type BringAFriendStatus = {
  eligible?: boolean;
  status?: string;
  error?: string;
  tier?: string;
  periodMode?: string;
  period?: string;
  resetsAt?: string | null;
  usedFor?: BringAFriendUsedFor;
  cancelledFor?: BringAFriendUsedFor & { lateCancel?: boolean };
  supportContext?: string;
  upcomingBookedClasses?: BringAFriendBookedClass[];
  bookingConsentText?: string;
};

const ERROR_COPY: Record<string, string> = {
  invalid_fields: "Please complete all guest details.",
  booking_consent_required: "Please confirm your guest gave permission to be booked.",
  cannot_invite_self: "You can't invite yourself as your own guest.",
  tier_not_eligible:
    "Bring a Friend Pass is included with monthly memberships and 10/20 Flexible Packs.",
  already_used_this_period: "You've already used your guest pass for this period.",
  guest_already_used_this_period: "This guest already used a complimentary pass this period.",
  member_not_booked_to_class:
    "Book yourself first — your guest pass only works for classes you're attending.",
  class_not_available_for_guest:
    "This class is almost full. Pick a class with at least 2 open spots.",
  guest_lookup_ambiguous:
    "We found more than one profile matching this guest. Please contact the studio.",
  guest_already_booked_to_class: "Your guest is already booked into this class.",
  mindbody_guest_create_failed:
    "We couldn't create your guest's profile. Please check their details or contact the studio.",
  mindbody_sale_failed:
    "We couldn't issue the guest pass. Please try again or contact the studio.",
  mindbody_booking_failed:
    "We couldn't book your guest into the class. Please try again or contact the studio.",
  guest_pass_blobs_unavailable:
    "Guest pass storage isn't available in this environment. Contact the studio if this persists.",
  guest_pass_blobs_disabled:
    "Guest pass storage isn't available in this environment. Contact the studio if this persists.",
  staff_not_configured: "Guest booking is temporarily unavailable. Please contact the studio.",
};

export function bringAFriendErrorMessage(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "Something went wrong. Please try again or contact the studio.";
  }
  const code = String((payload as { error?: string }).error ?? "");
  return ERROR_COPY[code] ?? "Something went wrong. Please try again or contact the studio.";
}

export function formatBringAFriendWhen(iso: string | null | undefined): string {
  if (!iso) return "";
  return formatMindbodyEt(iso, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function bringAFriendHint(status: BringAFriendStatus | null): string {
  if (!status?.eligible) {
    return "Bring a Friend Pass is included with monthly memberships and 10/20 Flexible Packs.";
  }
  if (status.periodMode === "packLifetime") {
    return "One complimentary guest class per Flexible Pack purchase.";
  }
  let hint = "One complimentary guest class per calendar month for eligible memberships.";
  if (status.status === "available" && status.resetsAt) {
    hint += ` Resets ${formatBringAFriendWhen(status.resetsAt)}.`;
  }
  return hint;
}

/** Member booked + ≥2 open spots + pass available (matches server `upcomingBookedClasses`). */
export function isClassEligibleForGuestInvite(
  status: BringAFriendStatus | null,
  classId: number | null,
): boolean {
  return guestInviteClassOption(status, classId) != null;
}

export function guestInviteClassOption(
  status: BringAFriendStatus | null,
  classId: number | null,
): BringAFriendBookedClass | null {
  if (!status?.eligible || status.status !== "available" || classId == null) return null;
  const list = status.upcomingBookedClasses ?? [];
  return list.find((c) => c.classId === classId) ?? null;
}

export function classLabelForGuestOption(c: BringAFriendBookedClass): string {
  const when = formatBringAFriendWhen(c.startDateTime);
  const spots = c.spotsRemaining ?? "?";
  return `${c.name || "Class"} — ${when} (${spots} spots)`;
}

export const DEFAULT_BOOKING_CONSENT =
  "I confirm my guest gave permission to share their contact information with Amaré and understands they must arrive 10 minutes early to complete the in-studio waiver and check-in.";

export type BringAFriendBookPayload = {
  classId: number;
  guestFirstName: string;
  guestLastName: string;
  guestEmail: string;
  guestPhone: string;
  bookingConsentAccepted: boolean;
};

export type GuestBadge = {
  guestFirstName: string;
  guestLastInitial: string;
  whenMs: number;
};

/** Build classId → guest badges from BAF status (matches web `guestBadgeLookupFromBafStatus`). */
export function guestBadgeLookupFromBafStatus(
  data: BringAFriendStatus | null,
): Map<number, GuestBadge[]> {
  const map = new Map<number, GuestBadge[]>();

  function add(classId: number | null, startIso: string, attached: GuestAttached | null | undefined) {
    if (classId == null || !attached || attached.status !== "confirmed") return;
    const fn = String(attached.guestFirstName ?? "").trim();
    const li = String(attached.guestLastInitial ?? "").trim();
    if (!fn && !li) return;
    const whenMs = mindbodyInstantToUtcMs(startIso);
    if (!Number.isFinite(whenMs)) return;
    const list = map.get(classId) ?? [];
    list.push({ guestFirstName: fn, guestLastInitial: li, whenMs });
    map.set(classId, list);
  }

  for (const row of data?.upcomingBookedClasses ?? []) {
    add(row.classId, String(row.startDateTime ?? ""), row.guestAttached);
  }

  if (data?.status === "used" && data.usedFor) {
    const u = data.usedFor;
    add(
      typeof u.classId === "number" ? u.classId : null,
      String(u.classStartDateTime ?? ""),
      {
        guestFirstName: u.guestFirstName,
        guestLastInitial: u.guestLastInitial,
        status: "confirmed",
      },
    );
  }

  return map;
}

export function guestBadgeForVisit(
  lookup: Map<number, GuestBadge[]>,
  classIdNum: number | null,
  whenMs: number | null,
): GuestBadge | null {
  if (classIdNum == null || whenMs == null) return null;
  const rows = lookup.get(classIdNum);
  if (!rows?.length) return null;
  for (const row of rows) {
    if (Math.abs(row.whenMs - whenMs) <= 60_000) return row;
  }
  return null;
}

export function formatGuestBadgeLabel(badge: GuestBadge): string {
  return `Guest: ${badge.guestFirstName} ${badge.guestLastInitial}`.trim();
}

export function preflightAllowsRemoveGuestOnly(preflight: GuestCancelPreflight): boolean {
  return preflight.canRemoveGuestOnly === true || preflight.guestPassWillRestore === true;
}

/** Early window: guest badge present and outside late-cancel window (matches web schedule row). */
export function canShowRemoveGuestOnSchedule(
  badge: GuestBadge | null,
  whenMs: number | null,
): boolean {
  return badge != null && whenMs != null && !isWithinLateCancelWindow(whenMs);
}
