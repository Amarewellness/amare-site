/**
 * AMARÉ Auth 2A.3 — Google OIDC + claim evaluation.
 * Reuses 2A.2 session core and Phase 1 identity store. No Mindbody OAuth rewrite.
 *
 * Critical existing-client + new Google sub (design §6.4):
 * do not create usr_B; do not silent-attach to usr_A; pending-link cookie + explicit confirm.
 */

import crypto from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import {
  cookieSecureFlag,
  parseCookies,
  safeReturnPath,
  sealCookiePayload,
  sessionSecret,
  unsealCookiePayload,
} from "./oauth-lib.mjs";
import { resolveClaimCandidate } from "./amare-identity-policy.mjs";
import {
  evaluateAnonymousPurchaseAutoLink,
  maskVerifiedEmailForClaimUi,
  sanitizeOrderIdHint,
} from "./amare-auth-purchase-claim.mjs";

export { maskVerifiedEmailForClaimUi, sanitizeOrderIdHint };
import {
  amareAuthEnabled,
  amareSessIssueEnabled,
  buildAmareSessionCookie,
  buildClearAmareSessionCookie,
  canIssueAmareSession,
  isForeignOriginMutation,
  maybeIssueAmareSession,
  requireAmareSessionSecret,
  resolveAmareUser,
  signAmareAuthState,
  verifyAmareAuthState,
} from "./amare-sess-lib.mjs";
import { issueAmareMobileTokenPair, mobileBearerAuthEnabled } from "./mobile-auth-lib.mjs";

export const AMARE_OAUTH_TX_COOKIE = "amare_oauth_tx";
export const AMARE_PENDING_LINK_COOKIE = "amare_pending_link";
export const AMARE_CLAIM_TX_COOKIE = "amare_claim_tx";
export const AMARE_PROFILE_TX_COOKIE = "amare_profile_tx";
export const PROFILE_TX_TTL_MS = 15 * 60 * 1000;
export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
export const GOOGLE_ISSUERS = Object.freeze(["https://accounts.google.com", "accounts.google.com"]);
export const OAUTH_TX_TTL_MS = 15 * 60 * 1000;
export const PENDING_LINK_TTL_MS = 15 * 60 * 1000;

const GOOGLE_JWKS = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));

export function amareAuthGoogleEnabled() {
  return (process.env.ENABLE_AMARE_AUTH_GOOGLE || "").trim() === "1";
}

export function googleAuthRoutesEnabled() {
  return amareAuthEnabled() && amareAuthGoogleEnabled();
}

export function canIssueAmareSessionFromGoogle() {
  return canIssueAmareSession() && amareAuthGoogleEnabled();
}

export function amareAuthEmailOtpEnabled() {
  return (process.env.ENABLE_AMARE_AUTH_EMAIL_OTP || "").trim() === "1";
}

export function emailOtpRoutesEnabled() {
  return amareAuthEnabled() && amareAuthEmailOtpEnabled();
}

export function canIssueAmareSessionFromEmail() {
  return canIssueAmareSession() && amareAuthEmailOtpEnabled();
}

export function amareAuthMindbodyBridgeEnabled() {
  return (process.env.ENABLE_AMARE_AUTH_MINDBODY_BRIDGE || "").trim() === "1";
}

export function mindbodyBridgeEnabled() {
  return amareAuthEnabled() && amareAuthMindbodyBridgeEnabled();
}

export function canIssueAmareSessionFromMindbody() {
  return canIssueAmareSession() && amareAuthMindbodyBridgeEnabled();
}

export function amareClaimRoutesEnabled() {
  return (
    amareAuthEnabled() &&
    (amareAuthGoogleEnabled() || amareAuthEmailOtpEnabled() || amareAuthMindbodyBridgeEnabled())
  );
}

export function issueAmareSessionAfterClaim(amareUserId, headers) {
  if (!canIssueAmareSession()) return null;
  return maybeIssueAmareSession({ amare_user_id: amareUserId, headers });
}

/** Mindbody OIDC sub only. Never email, clientId, or phone. */
export function usableMindbodyOidcSub(raw) {
  if (raw == null) return null;
  const sub = String(raw).trim();
  return sub || null;
}

export function googleOAuthConfig() {
  const clientId = (process.env.GOOGLE_OAUTH_CLIENT_ID || "").trim();
  const clientSecret = (process.env.GOOGLE_OAUTH_CLIENT_SECRET || "").trim();
  const redirectUri = (process.env.GOOGLE_OAUTH_REDIRECT_URI || "").trim();
  if (!clientId || !clientSecret || !redirectUri) {
    const err = new Error("google_oauth_unconfigured");
    err.code = "google_oauth_unconfigured";
    throw err;
  }
  return { clientId, clientSecret, redirectUri };
}

export function amareSiteId() {
  return (process.env.MINDBODY_SITE_ID || "").trim() || "amare-unknown-site";
}

export function createPkcePair() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge, method: "S256" };
}

export function randomTxId() {
  return crypto.randomBytes(16).toString("hex");
}

function shortCookie(name, sealed, headers, maxAgeSeconds) {
  return `${name}=${encodeURIComponent(sealed)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${cookieSecureFlag(headers)}`;
}

export function clearCookie(name, headers = {}) {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${cookieSecureFlag(headers)}`;
}

export function buildOAuthTxCookie(payload, headers = {}) {
  const sealed = sealCookiePayload(payload, requireAmareSessionSecret());
  return shortCookie(AMARE_OAUTH_TX_COOKIE, sealed, headers, Math.floor(OAUTH_TX_TTL_MS / 1000));
}

export function readOAuthTxCookie(cookieHeader) {
  const raw = parseCookies(cookieHeader || "")[AMARE_OAUTH_TX_COOKIE];
  if (!raw) return null;
  try {
    const data = unsealCookiePayload(raw, requireAmareSessionSecret());
    if (!data || typeof data !== "object") return null;
    if (typeof data.exp !== "number" || data.exp <= Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

export function buildPendingLinkCookie(payload, headers = {}) {
  const sealed = sealCookiePayload(payload, requireAmareSessionSecret());
  return shortCookie(AMARE_PENDING_LINK_COOKIE, sealed, headers, Math.floor(PENDING_LINK_TTL_MS / 1000));
}

export function readPendingLinkCookie(cookieHeader) {
  const raw = parseCookies(cookieHeader || "")[AMARE_PENDING_LINK_COOKIE];
  if (!raw) return null;
  try {
    const data = unsealCookiePayload(raw, requireAmareSessionSecret());
    if (!data || data.kind !== "attach_provider") return null;
    if (typeof data.exp !== "number" || data.exp <= Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

export function buildClaimTxCookie(payload, headers = {}) {
  const sealed = sealCookiePayload(payload, requireAmareSessionSecret());
  return shortCookie(AMARE_CLAIM_TX_COOKIE, sealed, headers, Math.floor(PENDING_LINK_TTL_MS / 1000));
}

export function readClaimTxCookie(cookieHeader) {
  const raw = parseCookies(cookieHeader || "")[AMARE_CLAIM_TX_COOKIE];
  if (!raw) return null;
  try {
    const data = unsealCookiePayload(raw, requireAmareSessionSecret());
    if (!data || data.kind !== "verify_candidate") return null;
    if (typeof data.exp !== "number" || data.exp <= Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

export function buildProfileTxCookie(payload, headers = {}) {
  const sealed = sealCookiePayload(payload, requireAmareSessionSecret());
  return shortCookie(AMARE_PROFILE_TX_COOKIE, sealed, headers, Math.floor(PROFILE_TX_TTL_MS / 1000));
}

export function readProfileTxToken(raw) {
  const sealed = String(raw || "").trim();
  if (!sealed) return null;
  try {
    const data = unsealCookiePayload(sealed, requireAmareSessionSecret());
    if (!data || data.kind !== "new_profile") return null;
    if (data.provider !== "email") return null;
    if (typeof data.amare_user_id !== "string" || !data.amare_user_id) return null;
    if (typeof data.provider_sub !== "string" || !data.provider_sub.includes("@")) return null;
    if (typeof data.exp !== "number" || data.exp <= Date.now()) return null;
    if (typeof data.nonce !== "string" || !data.nonce) return null;
    return data;
  } catch {
    return null;
  }
}

export function sealProfileTxToken(payload) {
  if (!payload || payload.kind !== "new_profile") return null;
  return sealCookiePayload(payload, requireAmareSessionSecret());
}

/** Mobile Bearer pair when ENABLE_MOBILE_BEARER_AUTH=1. Web cookie path unchanged. */
export function withAmareMobileTokens(body, amareUserId) {
  const id = String(amareUserId || "").trim();
  if (!mobileBearerAuthEnabled() || !id.startsWith("usr_")) return body;
  try {
    return { ...body, ...issueAmareMobileTokenPair(id) };
  } catch {
    return body;
  }
}

export function readProfileTxCookie(cookieHeader) {
  const raw = parseCookies(cookieHeader || "")[AMARE_PROFILE_TX_COOKIE];
  return readProfileTxToken(raw);
}

export function buildNewProfileTx({ amareUserId, email }) {
  const normalized = normalizeAmareEmail(email);
  if (!amareUserId || !normalized) return null;
  const now = Date.now();
  return {
    kind: "new_profile",
    amare_user_id: String(amareUserId),
    provider: "email",
    provider_sub: normalized,
    at: now,
    exp: now + PROFILE_TX_TTL_MS,
    nonce: randomTxId(),
  };
}

export function claimStatusForVerifyResponse(claim) {
  if (!claim) return null;
  if (claim.needsProfile === true) return "needs_profile";
  if (claim.action === "search_unavailable" || claim.blockReason === "staff_search_unavailable") {
    return "search_unavailable";
  }
  return claim.status || null;
}

export function buildGoogleStart({ returnPath, headers = {} }) {
  const cfg = googleOAuthConfig();
  const pkce = createPkcePair();
  const tx = randomTxId();
  const nonce = randomTxId();
  const ret = safeReturnPath(returnPath);
  const exp = Date.now() + OAUTH_TX_TTL_MS;
  const state = signAmareAuthState({ tx, exp, return: ret, provider: "google" });
  const txCookie = buildOAuthTxCookie(
    { tx, verifier: pkce.verifier, nonce, returnPath: ret, consumed: false, exp },
    headers,
  );
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", cfg.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("access_type", "online");
  url.searchParams.set("include_granted_scopes", "false");
  console.log(JSON.stringify({ event: "google_oauth_started", provider: "google" }));
  return { url: url.toString(), state, nonce, tx, txCookie, pkce };
}

export async function exchangeGoogleAuthorizationCode({ code, codeVerifier }) {
  const cfg = googleOAuthConfig();
  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("code", code);
  body.set("client_id", cfg.clientId);
  body.set("client_secret", cfg.clientSecret);
  body.set("redirect_uri", cfg.redirectUri);
  body.set("code_verifier", codeVerifier);
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.id_token) {
    const err = new Error("google_token_exchange_failed");
    err.code = "google_token_exchange_failed";
    throw err;
  }
  return json;
}

export async function verifyGoogleIdToken(idToken, { nonce, audience } = {}, deps = {}) {
  const cfgAudience = audience || googleOAuthConfig().clientId;
  const verify = deps.jwtVerify || jwtVerify;
  const jwks = deps.jwks || GOOGLE_JWKS;
  let payload;
  try {
    const result = await verify(idToken, jwks, {
      issuer: [...GOOGLE_ISSUERS],
      audience: cfgAudience,
    });
    payload = result.payload;
  } catch (err) {
    const claim = err?.claim || "";
    const name = String(err?.code || err?.name || err?.message || "");
    if (name.includes("JWTExpired") || name.includes("ERR_JWT_EXPIRED") || claim === "exp") {
      const e = new Error("google_id_token_expired");
      e.code = "google_id_token_expired";
      throw e;
    }
    if (claim === "iss" || /issuer/i.test(name)) {
      const e = new Error("google_issuer_invalid");
      e.code = "google_issuer_invalid";
      throw e;
    }
    if (claim === "aud" || /audience/i.test(name)) {
      const e = new Error("google_audience_invalid");
      e.code = "google_audience_invalid";
      throw e;
    }
    if (/signature|JWSSignature/i.test(name)) {
      const e = new Error("google_id_token_bad_signature");
      e.code = "google_id_token_bad_signature";
      throw e;
    }
    const e = new Error("google_id_token_invalid");
    e.code = "google_id_token_invalid";
    throw e;
  }
  const sub = typeof payload.sub === "string" ? payload.sub.trim() : "";
  if (!sub) {
    const err = new Error("google_sub_missing");
    err.code = "google_sub_missing";
    throw err;
  }
  if (nonce && payload.nonce !== nonce) {
    const err = new Error("google_nonce_mismatch");
    err.code = "google_nonce_mismatch";
    throw err;
  }
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  const emailVerified = payload.email_verified === true;
  return {
    sub,
    email: email && emailVerified ? email : null,
    emailVerified,
    rawEmailPresent: Boolean(email),
  };
}

/**
 * Read-only Staff-backed Studio client lookup for AMARÉ claim evidence.
 * Exact trim+lowercase email match only. Never addclient. Never API-Key-only authority.
 * Failure is never normalized to a successful empty list.
 *
 * @param {string} email
 * @param {{
 *   resolveStaffAuthHeaders?: () => Promise<Record<string, string> | null>;
 *   fetch?: typeof fetch;
 *   mindbodyHost?: () => string;
 * }} [deps]
 * @returns {Promise<{ ok: true; exactMatches: number[] } | { ok: false; reason: string; exactMatches: [] }>}
 */
export async function searchStudioClientsByEmail(email, deps = {}) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized) return { ok: false, reason: "invalid_email", exactMatches: [] };
  try {
    const resolveStaff =
      deps.resolveStaffAuthHeaders ||
      (await import("./mindbody-class-book-lib.mjs")).resolveStaffAuthHeaders;
    const headers = await resolveStaff();
    if (!headers) {
      console.warn(JSON.stringify({ event: "studio_claim_search_unavailable", reason: "staff_headers_missing" }));
      return { ok: false, reason: "staff_search_unavailable", exactMatches: [] };
    }
    const hostFn = deps.mindbodyHost || (await import("./mindbody-upstream.mjs")).mindbodyHost;
    const fetchFn = deps.fetch || fetch;
    const q = new URLSearchParams();
    q.set("request.searchText", normalized);
    q.set("request.limit", "25");
    const res = await fetchFn(`https://${hostFn()}/public/v6/client/clients?${q}`, { headers });
    if (!res.ok) {
      const reason =
        res.status === 401 || res.status === 403
          ? "staff_search_unauthorized"
          : res.status === 429
            ? "staff_search_rate_limited"
            : res.status >= 500
              ? "staff_search_upstream"
              : "staff_search_failed";
      console.warn(JSON.stringify({ event: "studio_claim_search_failed", status: res.status, reason }));
      return { ok: false, reason, exactMatches: [] };
    }
    let data;
    try {
      data = await res.json();
    } catch {
      console.warn(JSON.stringify({ event: "studio_claim_search_failed", reason: "staff_search_invalid_response" }));
      return { ok: false, reason: "staff_search_invalid_response", exactMatches: [] };
    }
    const rows = data?.Clients ?? data?.clients;
    if (!Array.isArray(rows)) {
      console.warn(JSON.stringify({ event: "studio_claim_search_failed", reason: "staff_search_invalid_response" }));
      return { ok: false, reason: "staff_search_invalid_response", exactMatches: [] };
    }
    const ids = [];
    const seen = new Set();
    for (const row of rows) {
      const rowEmail = String(row?.Email || row?.email || "").trim().toLowerCase();
      if (rowEmail !== normalized) continue;
      const raw = row?.Id ?? row?.id ?? row?.ClientId ?? row?.clientId;
      const n = typeof raw === "number" ? raw : parseInt(String(raw || ""), 10);
      if (!Number.isFinite(n) || n <= 0 || seen.has(n)) continue;
      seen.add(n);
      ids.push(n);
    }
    console.log(JSON.stringify({ event: "studio_claim_search_staff", exactCount: ids.length }));
    return { ok: true, exactMatches: ids };
  } catch (err) {
    const failReason = String(err?.name || err?.message || "error").slice(0, 80);
    const reason = /timeout|AbortError/i.test(`${err?.name || ""} ${failReason}`)
      ? "staff_search_timeout"
      : "staff_search_failed";
    console.warn(JSON.stringify({ event: "studio_claim_search_failed", reason: failReason }));
    return { ok: false, reason, exactMatches: [] };
  }
}

/**
 * Accept the explicit Staff search contract, or a legacy successful id array (QA mocks).
 * Never treat a missing/invalid object as a successful zero-match.
 *
 * @param {unknown} found
 * @returns {{ ok: true; exactMatches: number[] } | { ok: false; reason: string; exactMatches: [] }}
 */
export function normalizeStudioEmailSearchResult(found) {
  if (Array.isArray(found)) {
    return {
      ok: true,
      exactMatches: found.filter((n) => Number(n) > 0).map(Number),
    };
  }
  if (found && typeof found === "object") {
    const row = /** @type {{ ok?: unknown; exactMatches?: unknown; reason?: unknown }} */ (found);
    if (row.ok === true && Array.isArray(row.exactMatches)) {
      return {
        ok: true,
        exactMatches: row.exactMatches.filter((n) => Number(n) > 0).map(Number),
      };
    }
    return {
      ok: false,
      reason: typeof row.reason === "string" && row.reason ? row.reason : "staff_search_unavailable",
      exactMatches: [],
    };
  }
  return { ok: false, reason: "staff_search_unavailable", exactMatches: [] };
}

export function consumeOAuthTransaction({ cookieHeader, state }) {
  const st = verifyAmareAuthState(state);
  if (!st || st.provider !== "google" || !st.tx) {
    return { ok: false, reason: "invalid_state" };
  }
  const tx = readOAuthTxCookie(cookieHeader);
  if (!tx) return { ok: false, reason: "missing_correlation_cookie" };
  if (tx.consumed === true) return { ok: false, reason: "replayed_transaction" };
  if (tx.tx !== st.tx) return { ok: false, reason: "state_tx_mismatch" };
  if (typeof tx.verifier !== "string" || !tx.verifier) return { ok: false, reason: "missing_pkce_verifier" };
  if (typeof tx.nonce !== "string" || !tx.nonce) return { ok: false, reason: "missing_nonce" };
  return {
    ok: true,
    tx: { ...tx, consumed: true },
    returnPath: safeReturnPath(st.return || tx.returnPath),
  };
}

export function readMbSessClientId(cookieHeader) {
  const raw = parseCookies(cookieHeader || "").mb_sess;
  if (!raw) return { valid: false, clientId: null };
  try {
    const secret = sessionSecret();
    const data = unsealCookiePayload(raw, secret);
    const rawId = data?.client_id ?? data?.clientId;
    const n = typeof rawId === "number" ? rawId : typeof rawId === "string" ? parseInt(rawId, 10) : NaN;
    if (!Number.isFinite(n) || n <= 0) return { valid: true, clientId: null };
    return { valid: true, clientId: n };
  } catch {
    return { valid: false, clientId: null };
  }
}

function defaultIdentity() {
  return import("./amare-identity-store.mjs");
}

/**
 * Decide the AMARÉ user target before any write.
 * New Google sub + mb_sess client already verified to usr_A → pending_attach (no usr_B).
 */
export async function resolveProviderIdentityTarget(input, deps = {}) {
  const identity = deps.identity || (await defaultIdentity());
  const provider = String(input.provider || "").trim();
  const sub = String(input.sub || "").trim();
  if (!provider || !sub) throw new Error("identity_key_missing");

  const existing = await identity.findIdentity(provider, sub);
  if (existing?.amare_user_id) {
    return { kind: "existing_identity", amare_user_id: String(existing.amare_user_id), provider, sub };
  }

  const siteId = input.siteId || amareSiteId();
  const mbClientId = Number(input.mbSessClientId) > 0 ? Number(input.mbSessClientId) : null;
  if (mbClientId && typeof identity.findActiveAssociationByClientId === "function") {
    const owner = await identity.findActiveAssociationByClientId(siteId, mbClientId);
    if (owner?.amare_user_id) {
      return {
        kind: "pending_attach",
        provider,
        target_amare_user_id: String(owner.amare_user_id),
        client_id: mbClientId,
        sub,
        email: input.email || null,
        siteId,
      };
    }
  }

  return { kind: "create_new", provider, sub, email: input.email || null, siteId };
}

export async function resolveGoogleIdentityTarget(input, deps = {}) {
  const sub = String(input.sub || "").trim();
  if (!sub) throw new Error("google_sub_missing");
  return resolveProviderIdentityTarget(
    { provider: "google", sub, email: input.email, mbSessClientId: input.mbSessClientId, siteId: input.siteId },
    deps,
  );
}

export async function evaluateGoogleClaim(input, deps = {}) {
  const identity = deps.identity || (await defaultIdentity());
  const siteId = input.siteId || amareSiteId();
  const existing =
    typeof identity.getActiveAssociation === "function"
      ? await identity.getActiveAssociation(input.amare_user_id, siteId)
      : null;
  const existingStatus = existing?.status || null;
  const existingClientId = existing?.client_id != null ? Number(existing.client_id) : null;

  const latest =
    typeof identity.getLatestAssociation === "function"
      ? await identity.getLatestAssociation(input.amare_user_id, siteId)
      : null;
  const ignoreMbSessAsClaim =
    latest?.block_reason === "shared_computer_continue_as_new" || input.ignoreMbSessAsClaim === true;
  if (ignoreMbSessAsClaim && input.mbSessValid === true && Number(input.mbSessClientId) > 0) {
    logDualSessionMismatch({
      amareUserId: input.amare_user_id,
      mbClientId: input.mbSessClientId,
      reason: "continue_as_new_mb_sess_ignored",
    });
  }
  const mbSessValid = ignoreMbSessAsClaim ? false : input.mbSessValid === true && Number(input.mbSessClientId) > 0;
  const mbSessClientId = ignoreMbSessAsClaim ? null : input.mbSessClientId;

  if (mbSessClientId && existingStatus && existingClientId && Number(mbSessClientId) !== existingClientId) {
    return {
      rank: 5,
      action: "conflict",
      status: "conflict",
      blockReason: "session_conflict",
      clientId: existingClientId,
      autoBind: false,
    };
  }

  let emailMatchCount = 0;
  let emailClientId = null;
  let emailClientIds = [];
  let searchOk = true;
  let searchRan = false;
  if (input.verifiedEmail && typeof deps.searchStudioClientsByEmail === "function") {
    searchRan = true;
    const found = normalizeStudioEmailSearchResult(await deps.searchStudioClientsByEmail(input.verifiedEmail));
    if (!found.ok) {
      return {
        rank: 0,
        action: "search_unavailable",
        status: "unlinked",
        blockReason: "staff_search_unavailable",
        clientId: null,
        autoBind: false,
        searchOk: false,
        needsProfile: false,
      };
    }
    emailClientIds = found.exactMatches;
    emailMatchCount = emailClientIds.length;
    emailClientId = emailClientIds.length === 1 ? emailClientIds[0] : null;
    searchOk = true;
  }

  const claim = resolveClaimCandidate({
    existingStatus,
    existingClientId,
    mbSessValid,
    mbSessClientId,
    verifiedEmail: input.verifiedEmail || null,
    emailMatchCount,
  });

  if (claim.status === "candidate" && !claim.clientId && emailClientId) {
    claim.clientId = emailClientId;
  }
  if (claim.status === "ambiguous") {
    claim.candidateClientIds = emailClientIds;
  }

  if (claim.status === "candidate" && claim.clientId && typeof identity.findActiveAssociationByClientId === "function") {
    const owner = await identity.findActiveAssociationByClientId(siteId, claim.clientId);
    if (owner?.amare_user_id && String(owner.amare_user_id) !== String(input.amare_user_id)) {
      return {
        rank: 5,
        action: "conflict",
        status: "conflict",
        blockReason: "client_owned_elsewhere",
        clientId: claim.clientId,
        autoBind: false,
      };
    }
  }

  claim.searchOk = searchOk;
  claim.searchRan = searchRan;
  claim.emailMatchCount = emailMatchCount;
  if (claim.status === "unlinked" && searchRan && searchOk && !claim.blockReason && emailMatchCount === 0) {
    claim.blockReason = "staff_zero_match";
  }
  return claim;
}

export async function persistGoogleClaim(amareUserId, claim, deps = {}) {
  const identity = deps.identity || (await defaultIdentity());
  const siteId = deps.siteId || amareSiteId();
  if (claim.action === "use_existing") return claim;
  if (!["candidate", "ambiguous", "unlinked", "conflict"].includes(claim.status)) {
    throw new Error("callback_cannot_write_verified");
  }
  let blockReason = claim.blockReason ?? null;
  let needsProfile = false;
  if (deps.provider === "email" && claim.status === "unlinked" && blockReason === "staff_zero_match") {
    needsProfile = true;
    claim.needsProfile = true;
  }
  if (claim.searchOk === false || claim.action === "search_unavailable") {
    blockReason = "staff_search_unavailable";
    claim.needsProfile = false;
  }
  if (deps.provider !== "email" && blockReason === "staff_zero_match") {
    blockReason = null;
    claim.needsProfile = false;
  }
  await identity.proposeAssociation({
    amare_user_id: amareUserId,
    site_id: siteId,
    status: claim.status,
    client_id: claim.clientId ?? null,
    candidate_client_ids: claim.status === "ambiguous" ? claim.candidateClientIds || null : null,
    block_reason: blockReason,
    claim_proof_ref: needsProfile && deps.verifiedEmail ? String(deps.verifiedEmail) : null,
  });
  claim.blockReason = blockReason;
  const event =
    claim.status === "candidate"
      ? "claim_candidate"
      : claim.status === "ambiguous"
        ? "claim_ambiguous"
        : claim.status === "conflict"
          ? "claim_conflict"
          : "claim_unlinked";
  console.log(JSON.stringify({ event, provider: deps.provider || "google", amare_user_id: amareUserId, status: claim.status }));
  return claim;
}

export function issueGoogleAmareSession(amareUserId, headers) {
  if (!canIssueAmareSessionFromGoogle()) return null;
  return maybeIssueAmareSession({ amare_user_id: amareUserId, headers });
}

/**
 * Shared-computer / leftover mb_sess: AMARÉ identity is B, Studio cookie is A.
 * Logs only. Never authorizes Book and never attaches A's client to B.
 */
export function logDualSessionMismatch({ amareUserId, mbClientId, reason } = {}) {
  const payload = {
    event: "dual_session_mismatch",
    amare_user_id: amareUserId || null,
    status: "mismatch",
    reason: reason || "amare_sess_and_mb_sess_differ",
  };
  if (Number(mbClientId) > 0) payload.has_mb_sess_client = true;
  console.log(JSON.stringify(payload));
  return payload;
}

/**
 * Full post-OIDC identity + claim path. No Google tokens persisted.
 */
export async function finishGoogleAuthentication(input, deps = {}) {
  const identity = deps.identity || (await defaultIdentity());
  const siteId = input.siteId || amareSiteId();
  const target = await resolveGoogleIdentityTarget(
    {
      sub: input.sub,
      email: input.email,
      mbSessClientId: input.mbSessClientId,
      siteId,
    },
    { identity },
  );

  if (target.kind === "pending_attach") {
    const pending = {
      kind: "attach_provider",
      provider: "google",
      provider_sub: target.sub,
      email: target.email,
      target_amare_user_id: target.target_amare_user_id,
      client_id: target.client_id,
      siteId,
      jti: randomTxId(),
      exp: Date.now() + PENDING_LINK_TTL_MS,
    };
    console.log(
      JSON.stringify({
        event: "login_success",
        provider: "google",
        status: "pending_attach",
        amare_user_id: target.target_amare_user_id,
      }),
    );
    return {
      outcome: "pending_attach",
      pending,
      amare_user_id: null,
      createdUser: false,
      claim: { status: "pending_attach", autoBind: false },
    };
  }

  let amareUserId = target.amare_user_id;
  let createdUser = false;
  if (target.kind === "create_new") {
    const created = await identity.createUserWithIdentity({
      provider: "google",
      provider_sub: target.sub,
      email: target.email,
      email_verified: Boolean(target.email),
    });
    amareUserId = created.amare_user_id;
    createdUser = true;
  }

  const claim = await evaluateGoogleClaim(
    {
      amare_user_id: amareUserId,
      siteId,
      mbSessValid: Boolean(input.mbSessClientId),
      mbSessClientId: input.mbSessClientId,
      verifiedEmail: input.email,
    },
    { identity, searchStudioClientsByEmail: deps.searchStudioClientsByEmail || searchStudioClientsByEmail },
  );
  await persistGoogleClaim(amareUserId, claim, { identity, siteId });

  const claimTx =
    claim.status === "candidate" && claim.clientId
      ? {
          kind: "verify_candidate",
          amare_user_id: amareUserId,
          client_id: claim.clientId,
          siteId,
          jti: randomTxId(),
          exp: Date.now() + PENDING_LINK_TTL_MS,
        }
      : null;

  console.log(
    JSON.stringify({
      event: "login_success",
      provider: "google",
      amare_user_id: amareUserId,
      status: claim.status,
    }),
  );
  return { outcome: "authenticated", amare_user_id: amareUserId, createdUser, claim, claimTx };
}

export async function confirmAmareClaim(input, deps = {}) {
  const identity = deps.identity || (await defaultIdentity());
  const siteId = input.siteId || amareSiteId();

  if (input.pending && input.continueAsNew === true) {
    const created = await identity.createUserWithIdentity({
      provider: input.pending.provider || "google",
      provider_sub: input.pending.provider_sub,
      email: input.pending.email,
      email_verified: Boolean(input.pending.email),
    });
    await identity.proposeAssociation({
      amare_user_id: created.amare_user_id,
      site_id: siteId,
      status: "unlinked",
      client_id: null,
      block_reason: "shared_computer_continue_as_new",
    });
    logDualSessionMismatch({
      amareUserId: created.amare_user_id,
      mbClientId: input.pending.client_id,
      reason: "continue_as_new",
    });
    console.log(
      JSON.stringify({
        event: "login_success",
        provider: input.pending.provider || "google",
        amare_user_id: created.amare_user_id,
        status: "unlinked",
        reason: "continue_as_new",
      }),
    );
    return { ok: true, outcome: "continue_as_new", amare_user_id: created.amare_user_id, status: "unlinked" };
  }

  if (input.pending && input.explicitConfirm === true) {
    const owner = await identity.findActiveAssociationByClientId(siteId, input.pending.client_id);
    if (!owner || String(owner.amare_user_id) !== String(input.pending.target_amare_user_id)) {
      return { ok: false, statusCode: 409, error: "claim_conflict" };
    }
    const already = await identity.findIdentity(input.pending.provider || "google", input.pending.provider_sub);
    if (already && String(already.amare_user_id) !== String(input.pending.target_amare_user_id)) {
      return { ok: false, statusCode: 409, error: "claim_conflict" };
    }
    if (!already) {
      await identity.attachIdentity({
        amare_user_id: input.pending.target_amare_user_id,
        provider: input.pending.provider || "google",
        provider_sub: input.pending.provider_sub,
        email: input.pending.email,
        email_verified: Boolean(input.pending.email),
      });
      if ((input.pending.provider || "google") === "mindbody" && typeof identity.listIdentities === "function") {
        const listed = await identity.listIdentities(input.pending.target_amare_user_id);
        if (listed.some((row) => row.provider && row.provider !== "mindbody")) {
          console.log(
            JSON.stringify({
              event: "identity_attached_mindbody_after_social",
              amare_user_id: input.pending.target_amare_user_id,
            }),
          );
        }
      }
    }
    const attachStatus = await maybePromoteLinkedAfterConfirm(
      identity,
      input.pending.target_amare_user_id,
      siteId,
    );
    if (attachStatus && typeof attachStatus === "object" && attachStatus.ok === false) {
      return attachStatus;
    }
    console.log(
      JSON.stringify({
        event: "claim_confirmed",
        provider: input.pending.provider || "google",
        amare_user_id: input.pending.target_amare_user_id,
        status: attachStatus,
        reason: "attach_provider",
      }),
    );
    return {
      ok: true,
      outcome: "attached",
      amare_user_id: input.pending.target_amare_user_id,
      status: attachStatus,
    };
  }

  if (input.explicitConfirm !== true) {
    return { ok: false, statusCode: 400, error: "explicit_confirm_required" };
  }

  const amareUserId = input.amare_user_id;
  if (!amareUserId) return { ok: false, statusCode: 401, error: "signed_out" };

  const candidate =
    typeof identity.getCandidateAssociation === "function"
      ? await identity.getCandidateAssociation(amareUserId, siteId)
      : null;
  if (!candidate) return { ok: false, statusCode: 409, error: "no_candidate" };
  if (candidate.status === "ambiguous") return { ok: false, statusCode: 409, error: "ambiguous_cannot_confirm" };

  const serverClientId = Number(candidate.client_id);
  if (!Number.isFinite(serverClientId) || serverClientId <= 0) {
    return { ok: false, statusCode: 409, error: "candidate_missing_client" };
  }
  if (input.displayedClientId != null && Number(input.displayedClientId) !== serverClientId) {
    return { ok: false, statusCode: 409, error: "client_id_not_authority" };
  }

  const owner = await identity.findActiveAssociationByClientId(siteId, serverClientId);
  if (owner && String(owner.amare_user_id) !== String(amareUserId)) {
    return { ok: false, statusCode: 409, error: "claim_conflict" };
  }

  try {
    await identity.confirmAssociation({
      amare_user_id: amareUserId,
      site_id: siteId,
      fromStatus: "candidate",
      client_id: serverClientId,
      claim_method: "mb_sess_confirmed",
      explicitConfirm: true,
    });
  } catch (err) {
    if (err?.code === "23505" || /unique|duplicate/i.test(String(err?.message || ""))) {
      return { ok: false, statusCode: 409, error: "claim_conflict" };
    }
    if (String(err?.message || "") === "linked_forbidden_in_phase1") {
      return { ok: false, statusCode: 409, error: "linked_forbidden" };
    }
    throw err;
  }

  const status = await maybePromoteLinkedAfterConfirm(identity, amareUserId, siteId);
  if (status && typeof status === "object" && status.ok === false) return status;
  console.log(JSON.stringify({ event: "claim_confirmed", amare_user_id: amareUserId, status }));
  return { ok: true, outcome: status, amare_user_id: amareUserId, status };
}

async function maybePromoteLinkedAfterConfirm(identity, amareUserId, siteId) {
  if ((process.env.ENABLE_AMARE_AUTH || "").trim() !== "1") return "verified";
  const memberRead = (process.env.ENABLE_AMARE_MEMBER_READ || "").trim() === "1";
  const studioOps = (process.env.ENABLE_AMARE_STUDIO_OPERATIONS || "").trim() === "1";
  if (!memberRead && !studioOps) return "verified";
  if (typeof identity.promoteAssociationToLinked !== "function") return "verified";
  try {
    const promoted = await identity.promoteAssociationToLinked({
      amare_user_id: amareUserId,
      site_id: siteId,
      explicitPromote: true,
    });
    return promoted?.status || "linked";
  } catch (err) {
    if (String(err?.message || "") === "claim_conflict") {
      return { ok: false, statusCode: 409, error: "claim_conflict" };
    }
    if (String(err?.message || "") === "linked_requires_verified") return "verified";
    if (String(err?.message || "") === "linked_forbidden_in_phase1") return "verified";
    throw err;
  }
}

export function normalizeAmareEmail(raw) {
  const email = String(raw || "").trim().toLowerCase();
  if (!email || !email.includes("@") || email.startsWith("@") || email.endsWith("@")) return null;
  if (/\s/.test(email)) return null;
  const [local, domain] = email.split("@");
  if (!local || !domain || !domain.includes(".")) return null;
  return email;
}

export function generateOtpCode(length = 6) {
  const n = Number(length) || 6;
  const max = 10 ** n;
  const value = crypto.randomInt(0, max);
  return String(value).padStart(n, "0");
}

export function requireOtpPepper() {
  const pepper = (process.env.AMARE_OTP_PEPPER || "").trim();
  if (pepper.length < 24) {
    const err = new Error("amare_otp_pepper_missing");
    err.code = "amare_otp_pepper_missing";
    throw err;
  }
  return pepper;
}

export function hashOtpCode(emailNormalized, code, pepper = requireOtpPepper()) {
  return crypto.createHmac("sha256", pepper).update(`${emailNormalized}:${code}`).digest("hex");
}

export function hashOtpRequestKey(ip) {
  const raw = String(ip || "unknown").trim() || "unknown";
  return crypto.createHash("sha256").update(`amare-otp-ip:${raw}`).digest("hex");
}

export function otpFromAddress() {
  return (process.env.AMARE_OTP_FROM || process.env.RESEND_FROM || "").trim() || "AMARÉ <info@amarewellness.com>";
}

export function buildOtpEmail({ code, ttlMinutes = 10 }) {
  const text = [
    "AMARÉ",
    "",
    "Your sign-in code is:",
    "",
    String(code),
    "",
    `This code expires in ${ttlMinutes} minutes.`,
    "",
    "If you didn't request this code, you can ignore this email.",
  ].join("\n");
  const html = `<p>AMARÉ</p><p>Your sign-in code is:</p><p style="font-size:24px;letter-spacing:4px"><strong>${String(code)}</strong></p><p>This code expires in ${ttlMinutes} minutes.</p><p>If you didn't request this code, you can ignore this email.</p>`;
  return { subject: "Your AMARÉ sign-in code", text, html };
}

function stampAmareOtpStage(err, stage) {
  if (err && typeof err === "object" && err.amareOtpStage == null) {
    err.amareOtpStage = stage;
  }
  return err;
}

export async function requestEmailOtp(input, deps = {}) {
  let stage = "otp_store_import";
  try {
    const {
      OTP_EMAIL_HOURLY_CAP,
      OTP_REQUEST_KEY_HOURLY_CAP,
      OTP_RESEND_COOLDOWN_MS,
      OTP_TTL_MS,
      countRecentOtpChallenges,
      insertOtpChallenge,
      latestOtpCreatedAt,
    } = deps.otp || (await import("./amare-otp-store.mjs"));
    const email = normalizeAmareEmail(input.email);
    if (!email) return { ok: false, statusCode: 400, error: "invalid_email" };

    const requestKey = hashOtpRequestKey(input.requestKey || input.ip || "");
    const now = deps.now || Date.now();
    const hourAgo = new Date(now - 60 * 60 * 1000).toISOString();
    stage = "otp_rate_limit_select";
    const counts = await countRecentOtpChallenges({
      emailNormalized: email,
      requestKey,
      since: hourAgo,
    });
    let suppress = null;
    if (counts.email >= OTP_EMAIL_HOURLY_CAP) suppress = "email_rate_limited";
    else if (counts.requestKey >= OTP_REQUEST_KEY_HOURLY_CAP) suppress = "request_key_rate_limited";
    else {
      const latest = await latestOtpCreatedAt(email);
      if (latest && now - new Date(latest).getTime() < OTP_RESEND_COOLDOWN_MS) suppress = "resend_cooldown";
    }

    if (suppress) {
      console.log(JSON.stringify({ event: "email_otp_suppressed", reason: suppress }));
      return { ok: true, sent: false, reason: suppress };
    }

    stage = "otp_hash";
    const code = typeof deps.generateOtp === "function" ? deps.generateOtp() : generateOtpCode();
    const codeHash = hashOtpCode(email, code, deps.pepper || requireOtpPepper());
    stage = "otp_insert";
    await insertOtpChallenge({
      email_normalized: email,
      code_hash: codeHash,
      expires_at: new Date(now + OTP_TTL_MS).toISOString(),
      request_key: requestKey,
    });

    stage = "otp_resend";
    const send = deps.sendEmail || (await import("./resend-email-client.mjs")).sendResendEmail;
    const content = buildOtpEmail({ code, ttlMinutes: Math.round(OTP_TTL_MS / 60000) });
    const sent = await send({
      from: otpFromAddress(),
      to: email,
      subject: content.subject,
      text: content.text,
      html: content.html,
      tags: [{ name: "amare_auth", value: "email_otp" }],
    });
    if (!sent?.ok) {
      console.log(JSON.stringify({ event: "email_otp_send_failed", reason: sent?.error || "send_failed" }));
    } else {
      console.log(JSON.stringify({ event: "email_otp_sent" }));
    }
    return { ok: true, sent: Boolean(sent?.ok) };
  } catch (err) {
    throw stampAmareOtpStage(err, stage);
  }
}

export async function finishEmailAuthentication(input, deps = {}) {
  const identity = deps.identity || (await defaultIdentity());
  const siteId = input.siteId || amareSiteId();
  const email = normalizeAmareEmail(input.email);
  if (!email) throw new Error("invalid_email");
  const target = await resolveProviderIdentityTarget(
    {
      provider: "email",
      sub: email,
      email,
      mbSessClientId: input.mbSessClientId,
      siteId,
    },
    { identity },
  );

  if (target.kind === "pending_attach") {
    const pending = {
      kind: "attach_provider",
      provider: "email",
      provider_sub: target.sub,
      email: target.email,
      target_amare_user_id: target.target_amare_user_id,
      client_id: target.client_id,
      siteId,
      jti: randomTxId(),
      exp: Date.now() + PENDING_LINK_TTL_MS,
    };
    console.log(
      JSON.stringify({
        event: "login_success",
        provider: "email",
        status: "pending_attach",
        amare_user_id: target.target_amare_user_id,
      }),
    );
    return {
      outcome: "pending_attach",
      pending,
      amare_user_id: null,
      createdUser: false,
      claim: { status: "pending_attach", autoBind: false },
    };
  }

  let amareUserId = target.amare_user_id;
  let createdUser = false;
  if (target.kind === "create_new") {
    const created = await identity.createUserWithIdentity({
      provider: "email",
      provider_sub: target.sub,
      email: target.email,
      email_verified: true,
    });
    amareUserId = created.amare_user_id;
    createdUser = true;
  }

  const claim = await evaluateGoogleClaim(
    {
      amare_user_id: amareUserId,
      siteId,
      mbSessValid: Boolean(input.mbSessClientId),
      mbSessClientId: input.mbSessClientId,
      verifiedEmail: email,
    },
    { identity, searchStudioClientsByEmail: deps.searchStudioClientsByEmail || searchStudioClientsByEmail },
  );
  await persistGoogleClaim(amareUserId, claim, {
    identity,
    siteId,
    provider: "email",
    verifiedEmail: email,
  });

  let purchaseConnected = false;
  if (
    claim.status === "candidate" &&
    claim.clientId &&
    typeof identity.confirmAssociation === "function" &&
    typeof deps.getOrder === "function"
  ) {
    const hint = sanitizeOrderIdHint(deps.orderIdHint);
    let order = null;
    if (hint) {
      try {
        order = await deps.getOrder(hint);
      } catch {
        order = null;
      }
    }
    const decision = evaluateAnonymousPurchaseAutoLink({
      verifiedEmail: email,
      candidateClientId: claim.clientId,
      candidateCount: Number(claim.emailMatchCount) || 0,
      currentAmareUserId: amareUserId,
      existingOwnerUserId: null,
      dualSessionConflict: false,
      order,
    });
    if (decision.ok) {
      try {
        await identity.confirmAssociation({
          amare_user_id: amareUserId,
          site_id: siteId,
          fromStatus: "candidate",
          client_id: decision.clientId,
          claim_method: "email_unique_confirmed",
          claim_proof_ref: `order:${decision.orderId}`,
          explicitConfirm: true,
        });
        const status = await maybePromoteLinkedAfterConfirm(identity, amareUserId, siteId);
        if (!(status && typeof status === "object" && status.ok === false)) {
          claim.status = typeof status === "string" ? status : "verified";
          claim.purchaseConnected = true;
          purchaseConnected = true;
          console.log(
            JSON.stringify({
              event: "purchase_auto_link",
              amare_user_id: amareUserId,
              status: claim.status,
            }),
          );
        }
      } catch {
        purchaseConnected = false;
      }
    } else {
      console.log(JSON.stringify({ event: "purchase_auto_link_skipped", reason: decision.reason }));
    }
  }

  const claimTx =
    !purchaseConnected && claim.status === "candidate" && claim.clientId
      ? {
          kind: "verify_candidate",
          amare_user_id: amareUserId,
          client_id: claim.clientId,
          siteId,
          jti: randomTxId(),
          exp: Date.now() + PENDING_LINK_TTL_MS,
        }
      : null;

  const profileTx =
    claim.needsProfile === true ? buildNewProfileTx({ amareUserId, email }) : null;

  console.log(
    JSON.stringify({
      event: "login_success",
      provider: "email",
      amare_user_id: amareUserId,
      status: claimStatusForVerifyResponse(claim) || claim.status,
    }),
  );
  return {
    outcome: "authenticated",
    amare_user_id: amareUserId,
    createdUser,
    claim,
    claimTx,
    profileTx,
    maskedEmail: maskVerifiedEmailForClaimUi(email),
    purchaseConnected,
  };
}

export function issueEmailAmareSession(amareUserId, headers) {
  if (!canIssueAmareSessionFromEmail()) return null;
  return maybeIssueAmareSession({ amare_user_id: amareUserId, headers });
}

export function issueMindbodyAmareSession(amareUserId, headers) {
  if (!canIssueAmareSessionFromMindbody()) return null;
  return maybeIssueAmareSession({ amare_user_id: amareUserId, headers });
}

export async function finishMindbodyAuthentication(input, deps = {}) {
  const identity = deps.identity || (await defaultIdentity());
  const siteId = input.siteId || amareSiteId();
  const sub = usableMindbodyOidcSub(input.sub);
  if (!sub) {
    console.log(JSON.stringify({ event: "mindbody_identity_sub_missing" }));
    return { outcome: "sub_missing", amare_user_id: null, createdUser: false, claim: null, wroteIdentity: false };
  }

  const target = await resolveProviderIdentityTarget(
    {
      provider: "mindbody",
      sub,
      email: input.email || null,
      mbSessClientId: input.mbSessClientId,
      siteId,
    },
    { identity },
  );

  if (target.kind === "pending_attach") {
    const pending = {
      kind: "attach_provider",
      provider: "mindbody",
      provider_sub: target.sub,
      email: target.email,
      target_amare_user_id: target.target_amare_user_id,
      client_id: target.client_id,
      siteId,
      jti: randomTxId(),
      exp: Date.now() + PENDING_LINK_TTL_MS,
    };
    console.log(
      JSON.stringify({
        event: "login_success",
        provider: "mindbody",
        status: "pending_attach",
        amare_user_id: target.target_amare_user_id,
      }),
    );
    return {
      outcome: "pending_attach",
      pending,
      amare_user_id: null,
      createdUser: false,
      claim: { status: "pending_attach", autoBind: false },
      wroteIdentity: false,
    };
  }

  let amareUserId = target.amare_user_id;
  let createdUser = false;
  if (target.kind === "create_new") {
    const created = await identity.createUserWithIdentity({
      provider: "mindbody",
      provider_sub: target.sub,
      email: input.email || null,
      email_verified: false,
    });
    amareUserId = created.amare_user_id;
    createdUser = true;
  }

  const claim = await evaluateGoogleClaim(
    {
      amare_user_id: amareUserId,
      siteId,
      mbSessValid: Boolean(input.mbSessClientId),
      mbSessClientId: input.mbSessClientId,
      verifiedEmail: input.email || null,
    },
    { identity, searchStudioClientsByEmail: deps.searchStudioClientsByEmail || searchStudioClientsByEmail },
  );
  await persistGoogleClaim(amareUserId, claim, { identity, siteId, provider: "mindbody" });

  if (!createdUser && (claim.status === "verified" || claim.status === "linked" || claim.action === "use_existing")) {
    console.log(JSON.stringify({ event: "login_mindbody_already_linked", amare_user_id: amareUserId }));
  }
  if (claim.status === "candidate") {
    console.log(JSON.stringify({ event: "login_mindbody_claim_success", amare_user_id: amareUserId, status: "candidate" }));
  }

  const claimTx =
    claim.status === "candidate" && claim.clientId
      ? {
          kind: "verify_candidate",
          amare_user_id: amareUserId,
          client_id: claim.clientId,
          siteId,
          jti: randomTxId(),
          exp: Date.now() + PENDING_LINK_TTL_MS,
        }
      : null;

  console.log(
    JSON.stringify({
      event: "login_success",
      provider: "mindbody",
      amare_user_id: amareUserId,
      status: claim.status,
    }),
  );
  return { outcome: "authenticated", amare_user_id: amareUserId, createdUser, claim, claimTx, wroteIdentity: true };
}

/**
 * Additive web-only Mindbody → AMARÉ identity hook.
 * Never changes mb_sess. Never runs from shared session-build (mobile uses that).
 */
export async function applyMindbodyLegacyBridge(input, deps = {}) {
  if (!mindbodyBridgeEnabled()) {
    return { applied: false, cookies: [], wroteIdentity: false, finished: null };
  }
  try {
    const finished = await finishMindbodyAuthentication(
      {
        sub: input.sub,
        email: input.email,
        mbSessClientId: input.mbSessClientId,
        siteId: input.siteId,
      },
      {
        identity: deps.identity,
        searchStudioClientsByEmail: deps.searchStudioClientsByEmail,
      },
    );

    const headers = input.headers || {};
    const cookies = [];
    if (finished.outcome === "sub_missing") {
      return { applied: true, cookies, wroteIdentity: false, finished };
    }

    if (input.cookieHeader) {
      try {
        const existing = await resolveAmareUser(
          { headers: { cookie: input.cookieHeader, Cookie: input.cookieHeader } },
          {
            findUser:
              deps.findUser ||
              (async (id) => {
                if (typeof deps.identity?.users?.has === "function" && deps.identity.users.has(id)) {
                  return { amare_user_id: id };
                }
                return { amare_user_id: id };
              }),
          },
        );
        const resolvedId = finished.amare_user_id || finished.pending?.target_amare_user_id || null;
        if (existing.signedIn && resolvedId && existing.amareUserId !== resolvedId) {
          logDualSessionMismatch({
            amareUserId: existing.amareUserId,
            mbClientId: input.mbSessClientId,
            reason: "amare_sess_and_mindbody_differ",
          });
        }
      } catch {
        /* dual-session log is best-effort */
      }
    }

    if (finished.outcome === "pending_attach") {
      cookies.push(buildPendingLinkCookie(finished.pending, headers));
      return { applied: true, cookies, wroteIdentity: false, finished };
    }

    const issued = issueMindbodyAmareSession(finished.amare_user_id, headers);
    if (issued?.cookie) cookies.push(issued.cookie);
    if (finished.claimTx) cookies.push(buildClaimTxCookie(finished.claimTx, headers));
    else cookies.push(clearCookie(AMARE_CLAIM_TX_COOKIE, headers));
    cookies.push(clearCookie(AMARE_PENDING_LINK_COOKIE, headers));
    return { applied: true, cookies, wroteIdentity: Boolean(finished.wroteIdentity), finished };
  } catch (err) {
    const reason = String(err?.message || "bridge_failed").slice(0, 80);
    console.log(JSON.stringify({ event: "mindbody_bridge_failed", reason }));
    return { applied: false, cookies: [], wroteIdentity: false, finished: null };
  }
}

export async function verifyEmailOtp(input, deps = {}) {
  const otp = deps.otp || (await import("./amare-otp-store.mjs"));
  const email = normalizeAmareEmail(input.email);
  const code = String(input.code || "").trim();
  if (!email || !/^\d{6}$/.test(code)) return { ok: false, statusCode: 400, error: "invalid_code" };

  const codeHash = hashOtpCode(email, code, deps.pepper || requireOtpPepper());
  const consumed = await otp.consumeOtpChallenge({
    emailNormalized: email,
    codeHash,
    now: deps.now ? new Date(deps.now) : new Date(),
  });
  if (!consumed.ok) {
    console.log(JSON.stringify({ event: "login_failure", provider: "email", reason: consumed.reason }));
    return { ok: false, statusCode: 401, error: "invalid_code" };
  }
  try {
    await otp.deleteExpiredOtpChallenges();
  } catch {
    /* cleanup is best-effort */
  }

  const finished = await finishEmailAuthentication(
    { email, mbSessClientId: input.mbSessClientId, siteId: input.siteId },
    {
      identity: deps.identity,
      searchStudioClientsByEmail: deps.searchStudioClientsByEmail,
      getOrder: deps.getOrder,
      orderIdHint: input.orderIdHint,
    },
  );
  return { ok: true, ...finished };
}

export function disabledAuthResponse() {
  return {
    statusCode: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    body: "amare_auth_disabled",
  };
}

export function jsonResponse(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

export function redirectResponse(location, cookies = []) {
  /** @type {Record<string, string | string[]>} */
  const headers = { Location: location, "Cache-Control": "no-store" };
  if (cookies.length === 1) headers["Set-Cookie"] = cookies[0];
  const res = { statusCode: 302, headers, body: "" };
  if (cookies.length > 1) res.multiValueHeaders = { "Set-Cookie": cookies };
  return res;
}

export { isForeignOriginMutation, resolveAmareUser, buildClearAmareSessionCookie, buildAmareSessionCookie, amareSessIssueEnabled };
