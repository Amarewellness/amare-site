import crypto from "node:crypto";

export function requiredEnv(name) {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing environment variable: ${name}`);
  return v;
}

export function redirectUri() {
  return requiredEnv("MINDBODY_OAUTH_REDIRECT_URI");
}

export function issuerBase() {
  return (process.env.MINDBODY_OAUTH_ISSUER || "https://signin.mindbodyonline.com").replace(
    /\/$/,
    "",
  );
}

export async function fetchUserInfo(accessToken) {
  if (!accessToken?.trim()) return {};
  const url = `${issuerBase()}/connect/userinfo`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken.trim()}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) return {};
  try {
    return await res.json();
  } catch {
    return {};
  }
}

export function subscriberId() {
  return (
    process.env.MINDBODY_OAUTH_SUBSCRIBER_ID?.trim() ||
    process.env.MINDBODY_SITE_ID?.trim() ||
    ""
  );
}

export function oauthScopes() {
  return (
    process.env.MINDBODY_OAUTH_SCOPES?.trim() ||
    "email profile openid offline_access Mindbody.Api.Public.v6"
  );
}

export function sessionSecret() {
  return requiredEnv("MINDBODY_SESSION_SECRET");
}

export function safeReturnPath(raw) {
  if (!raw || typeof raw !== "string") return "/classes";
  const pathOnly = raw.split("?")[0] || "/classes";
  if (!pathOnly.startsWith("/") || pathOnly.startsWith("//")) return "/classes";
  const allowed = /^\/[\w\-./]*$/;
  if (!allowed.test(pathOnly)) return "/classes";
  return pathOnly || "/classes";
}

export function signState(obj, secret) {
  const payload = Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyState(token, secret) {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const obj = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof obj.exp !== "number" || obj.exp < Date.now()) return null;
    return obj;
  } catch {
    return null;
  }
}

export function decodeJwtPayload(jwt) {
  const parts = String(jwt || "").split(".");
  if (parts.length < 2) return {};
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

/**
 * Site / subscriber Mindbody binds to Partner OAuth access tokens (`SiteId` header must match).
 * @param {Record<string, unknown>} claims JWT payload object
 */
export function pickMindbodyTokenSiteId(claims) {
  if (!claims || typeof claims !== "object") return null;

  /** @param {unknown} v */
  function asSiteString(v) {
    if (typeof v === "number" && Number.isFinite(v) && v !== 0 && Math.abs(v) < 1e12)
      return String(Math.trunc(v));
    if (typeof v === "string" && /^-?\d+$/.test(v.trim())) {
      const n = parseInt(v.trim(), 10);
      if (Number.isFinite(n) && n !== 0 && Math.abs(n) < 1e12) return String(n);
    }
    return null;
  }

  const keys = [
    "site_id",
    "siteid",
    "SiteId",
    "SubscriberId",
    "subscriberId",
    "studio_id",
    "StudioId",
    "subscriber_id",
    "Subscriber_id",
  ];
  for (const k of keys) {
    if (k in claims) {
      const s = asSiteString(claims[k]);
      if (s) return s;
    }
  }

  for (const [k, v] of Object.entries(claims)) {
    const lkSlash = k.toLowerCase();
    if (lkSlash.endsWith("/site_id") || lkSlash.endsWith("/siteid")) {
      const s = asSiteString(v);
      if (s) return s;
    }
  }

  for (const [k, v] of Object.entries(claims)) {
    const lk = k.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (
      lk.includes("siteid") ||
      lk.includes("subscriberid") ||
      lk.includes("studioid")
    ) {
      const s = asSiteString(v);
      if (s) return s;
    }
  }

  /** Do not use `membershipidentifier` here — its leading digits are often subscriber / legacy ids, not Public API `SiteId` (wrong id → "Site is deactivated"). See `mindbodyMembershipLeadingSiteId` for trace hints only. */
  return null;
}

/**
 * Leading numeric segment of `membershipidentifier` — for diagnostics only; not reliable as `SiteId` header.
 * @param {unknown} v claim value
 */
export function mindbodyMembershipLeadingSiteId(v) {
  if (typeof v === "number" && Number.isFinite(v) && v !== 0 && Math.abs(v) < 1e12)
    return String(Math.trunc(v));
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (/^-?[0-9]{1,12}$/.test(t)) return String(parseInt(t, 10));
  const m = t.match(/^(-?[0-9]{1,12})(?=[^\d]|$)/);
  return m ? String(parseInt(m[1], 10)) : null;
}

/** Normalize OIDC / Mindbody-style claim shapes into a small profile. */
export function profileFromClaims(c) {
  if (!c || typeof c !== "object") {
    return { sub: null, email: null, name: "" };
  }
  const email =
    c.email ||
    c.preferred_username ||
    c["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress"] ||
    null;
  const name =
    c.name ||
    [c.given_name, c.family_name].filter(Boolean).join(" ").trim() ||
    c.displayName ||
    c.preferred_username ||
    "";
  return {
    sub: c.sub || null,
    email: typeof email === "string" ? email : null,
    name: typeof name === "string" ? name : "",
  };
}

/**
 * Names + phone for Staff `addclient` after OAuth when no Studio Client exists yet.
 * @param {Record<string, unknown>} merged JWT + userinfo claims
 */
export function profileForStudioClientCreate(merged) {
  const base = profileFromClaims(merged);
  const email = base.email ? base.email.trim().toLowerCase() : "";
  const given =
    typeof merged.given_name === "string" && merged.given_name.trim()
      ? merged.given_name.trim().slice(0, 80)
      : "";
  const family =
    typeof merged.family_name === "string" && merged.family_name.trim()
      ? merged.family_name.trim().slice(0, 80)
      : "";
  /** @type {string[]} */
  const nameParts = (base.name || "").trim().split(/\s+/).filter(Boolean);
  const firstFromName = nameParts[0] || "";
  const lastFromName = nameParts.length > 1 ? nameParts.slice(1).join(" ") : "";
  const firstName = given || firstFromName || "";
  const lastName = family || lastFromName || firstName || "Client";
  const phoneRaw =
    merged.phone_number ??
    merged.mobile_phone ??
    merged.phone ??
    merged.MobilePhone ??
    merged.mobilePhone;
  const mobilePhone = typeof phoneRaw === "string" ? phoneRaw.trim().slice(0, 32) : "";
  return { email, firstName, lastName, mobilePhone };
}

export function sealCookiePayload(payload, secret) {
  const key = crypto.createHash("sha256").update(secret).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64url");
}

export function unsealCookiePayload(token, secret) {
  const raw = Buffer.from(token, "base64url");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const enc = raw.subarray(28);
  const key = crypto.createHash("sha256").update(secret).digest();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
  return JSON.parse(dec);
}

/** Best-effort numeric Mindbody client id from OIDC / userinfo style claims (when present). */
export function pickMindbodyClientId(claims) {
  if (!claims || typeof claims !== "object") return null;
  for (const k of [
    "ClientId",
    "clientId",
    "client_id",
    "legacy_identifier",
    "nameid",
    "UserId",
    "userId",
    "mb_client_id",
  ]) {
    const v = claims[k];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
    if (typeof v === "string" && /^\d+$/.test(v.trim())) return parseInt(v.trim(), 10);
  }
  const sub = typeof claims.sub === "string" ? claims.sub.trim() : "";
  if (sub) {
    const tail = sub.match(/-(\d{4,14})$/);
    if (tail) {
      const n = parseInt(tail[1], 10);
      if (n > 0) return n;
    }
  }
  return null;
}

/** Heuristic: claim keys that look like Mindbody client / RSS id. Caller must verify via GET clients. */
export function scanMindbodyClientIdFromClaims(claims) {
  if (!claims || typeof claims !== "object") return null;
  for (const [k, v] of Object.entries(claims)) {
    if (!/[Cc]lient|[Rr]ss[Ii]?[Dd]?|[Mm]indbody|[Mm]b_|[Uu]ser[Ii]d|legacy|nameid/i.test(k))
      continue;
    if (typeof v === "number" && Number.isFinite(v) && v > 0 && v < 1e15) return Math.trunc(v);
    if (typeof v === "string" && /^\d{4,14}$/.test(v.trim())) return parseInt(v.trim(), 10);
  }
  return null;
}

export async function refreshAccessToken(refreshToken) {
  const rt = refreshToken?.trim();
  if (!rt) throw new Error("missing_refresh_token");
  const tokenUrl = `${issuerBase()}/connect/token`;
  const params = new URLSearchParams();
  params.set("grant_type", "refresh_token");
  params.set("client_id", requiredEnv("MINDBODY_OAUTH_CLIENT_ID"));
  params.set("client_secret", requiredEnv("MINDBODY_OAUTH_CLIENT_SECRET"));
  params.set("refresh_token", rt);
  params.set("scope", oauthScopes());
  const sub = subscriberId();
  if (sub) params.set("subscriberId", sub);

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(json.error_description || json.error || text || "refresh_failed");
    throw err;
  }
  return json;
}

export function parseCookies(header) {
  /** @type {Record<string,string>} */
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

/** @param {Record<string,string|undefined>} heads */
export function cookieSecureFlag(heads) {
  const proto = heads["x-forwarded-proto"] || heads["X-Forwarded-Proto"];
  return proto === "https" ? "; Secure" : "";
}
