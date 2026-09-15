/**
 * AMARÉ member email resolution from identity store rows.
 * Shared by member-access, studio customer resolve, and booking confirmation.
 */

import { isApplePrivateRelayEmail } from "./amare-identity-policy.mjs";

/**
 * Pick a display email from identity rows. Never uses Mindbody provider_sub.
 * @param {Array<Record<string, unknown>>} rows
 * @returns {string | null}
 */
export function displayEmailFromIdentities(rows) {
  const list = Array.isArray(rows) ? rows : [];
  /** @param {unknown} value */
  const asEmail = (value) => {
    const email = String(value || "").trim().toLowerCase();
    if (!email || !email.includes("@") || email.startsWith("@") || email.endsWith("@")) return null;
    return email;
  };
  /** @param {Record<string, unknown>} row @param {boolean} allowRelay */
  const fromRow = (row, allowRelay) => {
    const direct = asEmail(row?.email);
    if (direct && (allowRelay || !isApplePrivateRelayEmail(direct))) return direct;
    if (String(row?.provider || "") === "email") {
      const sub = asEmail(row?.provider_sub);
      if (sub && (allowRelay || !isApplePrivateRelayEmail(sub))) return sub;
    }
    return null;
  };
  for (const provider of ["email", "google"]) {
    for (const row of list) {
      if (String(row?.provider || "") !== provider) continue;
      const email = fromRow(row, false);
      if (email) return email;
    }
  }
  for (const row of list) {
    const email = fromRow(row, false);
    if (email) return email;
  }
  for (const row of list) {
    const email = fromRow(row, true);
    if (email) return email;
  }
  return null;
}

/**
 * Trusted email for a signed-in AMARÉ user (OTP/Google identity rows).
 *
 * @param {string | null | undefined} amareUserId
 * @param {{ listIdentities?: (id: string) => Promise<unknown[]> }} [deps]
 * @returns {Promise<string | null>}
 */
export async function resolveAmareSessionEmail(amareUserId, deps = {}) {
  if (!amareUserId) return null;
  try {
    const listIdentities =
      typeof deps.listIdentities === "function"
        ? deps.listIdentities
        : (await import("./amare-identity-store.mjs")).listIdentities;
    return displayEmailFromIdentities(await listIdentities(amareUserId));
  } catch {
    return null;
  }
}
