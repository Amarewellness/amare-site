/**
 * Staff login for /admin pages.
 *
 * POST /api/admin/login { username, password }
 *   Shared studio username/password → frontdesk session (read-only) + the shared admin token.
 *   A billing admin id + password → owner/superadmin session. Billing writes require this
 *   session (and a CSRF header). The shared token is still returned so the rest of the
 *   admin panel keeps working, and it never authorizes a charge by itself.
 * GET  /api/admin/session → the current session (no billing secret in the browser).
 * POST /api/admin/logout  → revokes the session. Requires the CSRF header.
 *
 * The first owner is enrolled out of band (scripts/membership-billing-admin-enroll.mjs).
 * There is no public bootstrap route and no new environment variable.
 */
import { withLambda } from "@netlify/aws-lambda-compat";
import { adminCorsHeaders } from "./new-client-sms-admin-auth.mjs";
import { ACTOR_ID_RE, clientIpHash, RATE_LIMIT, verifyBillingActor } from "./membership-change-auth.mjs";
import { openBillingAuthStore } from "./membership-billing-auth-store.mjs";
import {
  ADMIN_SESSION_COOKIE,
  adminSessionSetCookie,
  csrfMatches,
  hashSessionToken,
  issueSessionMaterial,
  readSessionCookie,
  resolveAdminSession,
  SESSION_TTL_MS,
} from "./membership-admin-session.mjs";

/** @param {string} a @param {string} b */
function timingSafeEq(a, b) {
  const x = String(a);
  const y = String(b);
  const max = Math.max(x.length, y.length, 1);
  let mismatch = x.length === y.length ? 0 : 1;
  for (let i = 0; i < max; i += 1) {
    mismatch |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  }
  return mismatch === 0;
}

/** @param {number} status @param {unknown} body @param {Record<string, string>} [extra] */
function json(status, body, extra) {
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...adminCorsHeaders(),
      ...(extra || {}),
    },
    body: JSON.stringify(body),
  };
}

/** @param {import("@netlify/functions").HandlerEvent} event */
function parseBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** @param {import("@netlify/functions").HandlerEvent} event */
function requestPath(event) {
  const path = String(event.path || "");
  if (path) return path.split("?")[0];
  try {
    return new URL(String(event.rawUrl || "")).pathname;
  } catch {
    return "";
  }
}

/**
 * @param {import("@netlify/functions").HandlerEvent} event
 * @param {{ billingStore?: any }} overrides
 */
async function handle(event, overrides) {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  const path = requestPath(event);
  const store = overrides.billingStore || openStore();
  if (event.httpMethod === "GET" && path.endsWith("/session")) return sessionResponse(event, store);
  if (event.httpMethod === "POST" && path.endsWith("/logout")) return logout(event, store);
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "method_not_allowed" });
  return login(event, store);
}

function openStore() {
  try {
    return openBillingAuthStore();
  } catch {
    return null;
  }
}

/**
 * @param {import("@netlify/functions").HandlerEvent} event
 * @param {any} store
 */
async function sessionResponse(event, store) {
  if (!store) return json(503, { ok: false, error: "admin_directory_unavailable" });
  const session = await resolveAdminSession(event, store);
  if (!session.ok) return json(401, { ok: false, error: session.reason });
  return json(200, { ok: true, actor: session.actor, csrfToken: session.csrfToken, canBill: session.canBill });
}

/**
 * @param {import("@netlify/functions").HandlerEvent} event
 * @param {any} store
 */
async function logout(event, store) {
  const clear = { "Set-Cookie": adminSessionSetCookie("", event.headers, 0) };
  if (!store) return json(200, { ok: true }, clear);
  const session = await resolveAdminSession(event, store);
  if (session.present && session.ok && !csrfMatches(event, session.csrfToken)) {
    return json(403, { ok: false, error: "csrf_invalid" });
  }
  const token = readSessionCookie(event);
  if (token) await store.revokeSession(hashSessionToken(token));
  return json(200, { ok: true }, clear);
}

/**
 * @param {import("@netlify/functions").HandlerEvent} event
 * @param {any} store
 * @param {{ actorId: string | null, role: string }} identity
 */
async function issue(event, store, identity) {
  const token = (process.env.ADMIN_DEBUG_TOKEN || "").trim();
  const material = issueSessionMaterial();
  if (store) {
    await store.createSession({
      sessionHash: material.sessionHash,
      actorId: identity.actorId,
      role: identity.role,
      csrfToken: material.csrfToken,
      expiresAt: material.expiresAt,
      ipHash: clientIpHash(event),
    });
  }
  const session = store
    ? await resolveAdminSession({ headers: { cookie: `${ADMIN_SESSION_COOKIE}=${material.token}` } }, store)
    : null;
  return json(
    200,
    {
      ok: true,
      token,
      actor: session?.actor || { id: identity.actorId, role: identity.role, displayName: null, mustRotate: false },
      csrfToken: material.csrfToken,
      canBill: session ? session.canBill === true : identity.role === "owner" || identity.role === "superadmin",
    },
    { "Set-Cookie": adminSessionSetCookie(material.token, event.headers, Math.floor(SESSION_TTL_MS / 1000)) },
  );
}

/**
 * @param {import("@netlify/functions").HandlerEvent} event
 * @param {any} store
 */
async function login(event, store) {
  const expectedUser = (process.env.ADMIN_USERNAME || "").trim();
  const expectedPass = (process.env.ADMIN_PASSWORD || "").trim();
  const token = (process.env.ADMIN_DEBUG_TOKEN || "").trim();
  if (!expectedUser || expectedUser.length < 3 || !expectedPass || expectedPass.length < 8 || !token || token.length < 16) {
    return json(503, {
      ok: false,
      error: "password_login_unconfigured",
      message: "Username/password login is not set. Use the admin token, or add ADMIN_USERNAME and ADMIN_PASSWORD.",
    });
  }

  const body = parseBody(event);
  if (body == null) return json(400, { ok: false, error: "invalid_json" });
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  const ipHash = clientIpHash(event);

  if (store) {
    const recent = await store.recentFailures({ actorId: null, ipHash, sinceMs: Date.now() - RATE_LIMIT.windowMs });
    if (recent.ipFailures >= RATE_LIMIT.perIp) {
      return json(429, { ok: false, error: "billing_auth_rate_limited", message: "Too many sign-in attempts. Try again in 15 minutes." });
    }
  }

  const studioUser = timingSafeEq(username, expectedUser);
  const studioPass = timingSafeEq(password, expectedPass);
  if (studioUser && studioPass) {
    if (!store) return json(200, { ok: true, token, actor: { id: null, role: "frontdesk", displayName: null, mustRotate: false }, canBill: false });
    return issue(event, store, { actorId: null, role: "frontdesk" });
  }
  if (studioUser) {
    if (store) await store.recordAttempt({ actorId: null, ipHash, success: false, reason: "studio_bad_password" });
    return json(401, { ok: false, error: "invalid_credentials", message: "Wrong username or password." });
  }

  const actorId = username.toLowerCase();
  if (!store) {
    return json(503, { ok: false, error: "admin_directory_unavailable", message: "Admin sign-in is temporarily unavailable." });
  }
  if (!ACTOR_ID_RE.test(actorId)) {
    await store.recordAttempt({ actorId: null, ipHash, success: false, reason: "unknown_login" });
    return json(401, { ok: false, error: "invalid_credentials", message: "Wrong username or password." });
  }
  const admin = await store.getAdmin(actorId);
  if (!admin || !password) {
    await store.recordAttempt({ actorId: null, ipHash, success: false, reason: "unknown_login" });
    return json(401, { ok: false, error: "invalid_credentials", message: "Wrong username or password." });
  }
  const auth = await verifyBillingActor(
    { headers: { ...event.headers, "x-billing-actor": actorId, "x-billing-key": password } },
    store,
  );
  if (!auth.ok) {
    const status = auth.status === 429 ? 429 : 401;
    return json(status, {
      ok: false,
      error: status === 429 ? "billing_auth_rate_limited" : "invalid_credentials",
      message: status === 429 ? "Too many sign-in attempts. Try again in 15 minutes." : "Wrong username or password.",
    });
  }
  return issue(event, store, { actorId: auth.actor.id, role: auth.actor.role });
}

/** @param {{ billingStore?: any }} [overrides] tests only */
export function createAdminLoginHandler(overrides = {}) {
  return (event) => handle(event, overrides);
}

export const lambdaHandler = createAdminLoginHandler();
export default withLambda(lambdaHandler);
