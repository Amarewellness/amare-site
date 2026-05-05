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

/** Mindbody token/authorize calls often need subscriberId; try dedicated env then Site ID. */
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
    "openid profile email offline_access Mindbody.Api.Public.v6"
  );
}

export function sessionSecret() {
  return requiredEnv("MINDBODY_SESSION_SECRET");
}

export function safeReturnPath(raw) {
  if (!raw || typeof raw !== "string") return "/classes-api";
  const pathOnly = raw.split("?")[0] || "/classes-api";
  if (!pathOnly.startsWith("/") || pathOnly.startsWith("//")) return "/classes-api";
  const allowed = /^\/[\w\-./]*$/;
  if (!allowed.test(pathOnly)) return "/classes-api";
  return pathOnly || "/classes-api";
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
