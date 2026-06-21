import type { AuthProfile } from "../config";

const STUDIO_NOT_LINKED_MSG =
  "Your Mindbody account is connected, but it is not fully linked to AMARÉ yet. Please contact us and we can connect your account or book the class for you.";

const AMBIGUOUS_STUDIO_CLIENT_MSG =
  "We found more than one AMARÉ profile that matches your sign-in. Please contact the studio so we can link the correct account before you book online.";

const APPLE_RELAY_EMAIL_MSG =
  "Sign in with Apple is using a private relay email, so we could not match your AMARÉ profile automatically. Please contact the studio with the email on your account, or sign in with the same email you use at AMARÉ.";

export function bookingBlockedMessage(linkStatus: string | null | undefined): string {
  if (linkStatus === "ambiguous_studio_client") return AMBIGUOUS_STUDIO_CLIENT_MSG;
  if (linkStatus === "apple_relay_email") return APPLE_RELAY_EMAIL_MSG;
  return STUDIO_NOT_LINKED_MSG;
}

export function bookingBlockedTitle(linkStatus: string | null | undefined): string {
  if (linkStatus === "ambiguous_studio_client") return "Multiple studio profiles found";
  if (linkStatus === "apple_relay_email") return "Email could not be matched";
  return "Account not linked yet";
}

/** Mirrors website `oauthBookingAllowed` — false when session says so or link is blocked. */
export function isOnlineBookingAllowed(profile: AuthProfile | null): boolean {
  if (!profile) return false;
  if (profile.bookingAllowed === false) return false;
  const ls = profile.linkStatus ?? "";
  if (ls === "ambiguous_studio_client" || ls === "apple_relay_email") return false;
  if (profile.bookingAllowed === true) return true;
  if (profile.clientId != null && profile.clientId > 0) return true;
  return false;
}

export function contactStudioUrl(apiBase: string): string {
  return `${apiBase.replace(/\/$/, "")}/contact`;
}
