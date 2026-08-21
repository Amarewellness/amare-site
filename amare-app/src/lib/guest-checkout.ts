export type GuestCheckoutIdentity = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
};

/** Same regex as website Express dialog / server `isReasonableEmail`. */
const GUEST_EMAIL_RE = /^[^\s@]{1,200}@[^\s@]{1,64}\.[A-Za-z0-9.-]{2,24}$/;

export function parseGuestCheckoutIdentity(input: {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}): { ok: true; identity: GuestCheckoutIdentity } | { ok: false; error: string } {
  const firstName = input.firstName.trim().slice(0, 80);
  const lastName = input.lastName.trim().slice(0, 80);
  const email = input.email.trim().toLowerCase().slice(0, 254);
  const phone = input.phone.trim().slice(0, 32);
  if (!firstName) return { ok: false, error: "Please enter your first name." };
  if (!lastName) return { ok: false, error: "Please enter your last name." };
  if (!GUEST_EMAIL_RE.test(email)) return { ok: false, error: "Please enter a valid email address." };
  if (phone.replace(/\D/g, "").length < 7) return { ok: false, error: "Please enter a valid phone number." };
  return { ok: true, identity: { firstName, lastName, email, phone } };
}
