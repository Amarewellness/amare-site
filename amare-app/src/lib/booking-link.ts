import type { AuthProfile } from "../config";

const STUDIO_NOT_LINKED_MSG =
  "Your AMARÉ sign-in is not fully connected to a studio profile yet. Finish connecting, or contact us and we can help.";

const AMBIGUOUS_STUDIO_CLIENT_MSG =
  "We found more than one AMARÉ profile that matches your sign-in. Please contact the studio so we can link the correct account before you book online.";

const CANDIDATE_MSG =
  "We found your existing AMARÉ profile. Confirm it to access your purchases, credits, and bookings.";

const NEEDS_PROFILE_MSG = "Finish setting up your AMARÉ profile to book classes. No Mindbody password is required.";

const CONFLICT_MSG =
  "This account cannot book or purchase online right now. Contact the studio. You are not signed in as a guest.";

const APPLE_RELAY_EMAIL_MSG =
  "This sign-in used a private relay email, so we could not match your AMARÉ profile automatically. Please contact the studio with the email on your account, or sign in with the same email you use at AMARÉ.";

export function bookingBlockedMessage(linkStatus: string | null | undefined): string {
  if (linkStatus === "ambiguous" || linkStatus === "ambiguous_studio_client") return AMBIGUOUS_STUDIO_CLIENT_MSG;
  if (linkStatus === "candidate") return CANDIDATE_MSG;
  if (linkStatus === "needs_profile") return NEEDS_PROFILE_MSG;
  if (linkStatus === "conflict") return CONFLICT_MSG;
  if (linkStatus === "apple_relay_email") return APPLE_RELAY_EMAIL_MSG;
  return STUDIO_NOT_LINKED_MSG;
}

export function bookingBlockedTitle(linkStatus: string | null | undefined): string {
  if (linkStatus === "ambiguous" || linkStatus === "ambiguous_studio_client") return "Multiple studio profiles found";
  if (linkStatus === "candidate") return "Confirm your AMARÉ profile";
  if (linkStatus === "needs_profile") return "Finish your profile";
  if (linkStatus === "conflict") return "Account needs the studio";
  if (linkStatus === "apple_relay_email") return "Email could not be matched";
  return "Account not linked yet";
}

/** UI hint only. Server identity resolution is authority for Book. */
export function isOnlineBookingAllowed(profile: AuthProfile | null): boolean {
  if (!profile) return false;
  if (profile.bookingAllowed === false) return false;
  const ls = profile.studioAccess || profile.linkStatus || "";
  if (
    ls === "ambiguous" ||
    ls === "ambiguous_studio_client" ||
    ls === "apple_relay_email" ||
    ls === "candidate" ||
    ls === "needs_profile" ||
    ls === "conflict"
  ) {
    return false;
  }
  if (profile.studioAccess === "linked") return true;
  if (profile.bookingAllowed === true) return true;
  return false;
}

export function contactStudioUrl(apiBase: string): string {
  return `${apiBase.replace(/\/$/, "")}/contact`;
}
