/**
 * AMARÉ Auth Phase 1 — sealed `amare_sess` helpers.
 * Dark capability only. Live member APIs must ignore this cookie.
 */

import { parseCookies, sealCookiePayload, unsealCookiePayload } from "./oauth-lib.mjs";

export const AMARE_SESS_COOKIE = "amare_sess";

export function amareSessIssueEnabled() {
  return (process.env.ENABLE_AMARE_SESS_ISSUE || "").trim() === "1";
}

export function amareSessionSecretOrNull() {
  const s = (process.env.AMARE_SESSION_SECRET || "").trim();
  return s.length >= 24 ? s : null;
}

/**
 * @param {{ amare_user_id: string }} input
 */
export function sealAmareSessPayload(input) {
  const secret = amareSessionSecretOrNull();
  if (!secret) throw new Error("missing_amare_session_secret");
  const id = String(input.amare_user_id || "").trim();
  if (!id.startsWith("usr_")) throw new Error("invalid_amare_user_id");
  return sealCookiePayload({ amare_user_id: id, at: Date.now() }, secret);
}

/**
 * @param {string} sealed
 */
export function unsealAmareSessPayload(sealed) {
  const secret = amareSessionSecretOrNull();
  if (!secret) return null;
  try {
    const data = unsealCookiePayload(sealed, secret);
    if (!data || typeof data !== "object") return null;
    const id = typeof data.amare_user_id === "string" ? data.amare_user_id.trim() : "";
    if (!id.startsWith("usr_")) return null;
    return { amare_user_id: id, at: typeof data.at === "number" ? data.at : null };
  } catch {
    return null;
  }
}

/**
 * @param {string | undefined} cookieHeader
 */
export function readAmareSessFromCookieHeader(cookieHeader) {
  const raw = parseCookies(cookieHeader || "").amare_sess;
  if (!raw) return { present: false, session: null };
  const session = unsealAmareSessPayload(raw);
  return { present: true, session };
}

/**
 * Compare dark `amare_sess` to live `mb_sess` client id. Logs only. Never authorizes.
 *
 * @param {{
 *   cookieHeader?: string;
 *   mbClientId?: number | null;
 *   lookupLinkedClientId?: (amareUserId: string) => Promise<number | null>;
 * }} input
 */
export async function logAmareSessVersusMbSess(input) {
  const { present, session } = readAmareSessFromCookieHeader(input.cookieHeader || "");
  if (!present) return { event: "amare_sess_absent" };

  if (!session) {
    console.warn(JSON.stringify({ event: "amare_sess_unseal_failed" }));
    return { event: "amare_sess_unseal_failed" };
  }

  const mbClientId =
    typeof input.mbClientId === "number" && input.mbClientId > 0 ? input.mbClientId : null;

  let amareClientId = null;
  if (typeof input.lookupLinkedClientId === "function") {
    try {
      amareClientId = await input.lookupLinkedClientId(session.amare_user_id);
    } catch {
      amareClientId = null;
    }
  }

  /** @type {Record<string, unknown>} */
  const payload = {
    amare_user_id: session.amare_user_id,
    mbClientId,
    amareClientId,
  };

  if (amareClientId == null) {
    payload.event = "amare_sess_present_no_db_compare";
    console.log(JSON.stringify(payload));
    return payload;
  }

  if (mbClientId != null && amareClientId === mbClientId) {
    payload.event = "amare_sess_aligns_mb_sess";
    console.log(JSON.stringify(payload));
    return payload;
  }

  payload.event = "amare_sess_conflicts_mb_sess";
  console.warn(JSON.stringify(payload));
  return payload;
}
