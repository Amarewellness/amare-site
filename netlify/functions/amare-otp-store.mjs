/**
 * AMARÉ Auth 2A.5 — OTP challenge persistence.
 * Never stores plaintext codes. No HTTP handler.
 */

import crypto from "node:crypto";
import { identityQuery, withIdentityTransaction } from "./amare-identity-store.mjs";

function timingSafeEqualHex(a, b) {
  const left = Buffer.from(String(a || ""), "utf8");
  const right = Buffer.from(String(b || ""), "utf8");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export const OTP_LENGTH = 6;
export const OTP_TTL_MS = 10 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
export const OTP_EMAIL_HOURLY_CAP = 5;
export const OTP_REQUEST_KEY_HOURLY_CAP = 20;

export async function insertOtpChallenge(input) {
  const r = await identityQuery(
    `INSERT INTO amare_otp_challenges
      (email_normalized, code_hash, expires_at, request_key)
     VALUES ($1, $2, $3, $4)
     RETURNING id, created_at, expires_at`,
    [input.email_normalized, input.code_hash, input.expires_at, input.request_key ?? null],
  );
  return r.rows[0];
}

export async function countRecentOtpChallenges({ emailNormalized, requestKey, since }) {
  const emailCount = await identityQuery(
    `SELECT count(*)::int AS n FROM amare_otp_challenges
      WHERE email_normalized = $1 AND created_at >= $2`,
    [emailNormalized, since],
  );
  const keyCount = requestKey
    ? await identityQuery(
        `SELECT count(*)::int AS n FROM amare_otp_challenges
          WHERE request_key = $1 AND created_at >= $2`,
        [requestKey, since],
      )
    : { rows: [{ n: 0 }] };
  return {
    email: Number(emailCount.rows[0]?.n || 0),
    requestKey: Number(keyCount.rows[0]?.n || 0),
  };
}

export async function latestOtpCreatedAt(emailNormalized) {
  const r = await identityQuery(
    `SELECT created_at FROM amare_otp_challenges
      WHERE email_normalized = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [emailNormalized],
  );
  return r.rows[0]?.created_at || null;
}

/**
 * Atomically consume a valid unused unexpired challenge.
 * Wrong codes increment attempt_count. Concurrent consumes: only one wins.
 */
export async function consumeOtpChallenge({ emailNormalized, codeHash, now = new Date() }) {
  return withIdentityTransaction(async (client) => {
    const sel = await client.query(
      `SELECT id, code_hash, expires_at, consumed_at, attempt_count
         FROM amare_otp_challenges
        WHERE email_normalized = $1
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE`,
      [emailNormalized],
    );
    const row = sel.rows[0];
    if (!row) return { ok: false, reason: "no_challenge" };
    if (row.consumed_at) return { ok: false, reason: "consumed" };
    if (new Date(row.expires_at).getTime() <= now.getTime()) return { ok: false, reason: "expired" };
    if (Number(row.attempt_count) >= OTP_MAX_ATTEMPTS) return { ok: false, reason: "attempt_limit" };
    if (!timingSafeEqualHex(row.code_hash, codeHash)) {
      await client.query(
        `UPDATE amare_otp_challenges SET attempt_count = attempt_count + 1 WHERE id = $1`,
        [row.id],
      );
      return { ok: false, reason: "wrong_code" };
    }
    const upd = await client.query(
      `UPDATE amare_otp_challenges
          SET consumed_at = $2
        WHERE id = $1 AND consumed_at IS NULL
        RETURNING id`,
      [row.id, now.toISOString()],
    );
    if (!upd.rows[0]) return { ok: false, reason: "consumed" };
    return { ok: true, id: Number(upd.rows[0].id) };
  });
}

export async function deleteExpiredOtpChallenges(now = new Date()) {
  await identityQuery(
    `DELETE FROM amare_otp_challenges
      WHERE consumed_at IS NOT NULL
         OR expires_at <= $1`,
    [now.toISOString()],
  );
}

/** @param {string} emailNormalized */
export async function deleteOtpChallengesByEmail(emailNormalized) {
  const email = String(emailNormalized || "").trim().toLowerCase();
  if (!email || !email.includes("@")) return 0;
  const r = await identityQuery(`DELETE FROM amare_otp_challenges WHERE email_normalized = $1`, [email]);
  return r.rows?.length ?? 0;
}
