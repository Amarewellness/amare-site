/**
 * Keyless FCM transport for AMARÉ.
 * ADC comes from the attached Cloud Run service account. No JSON key.
 * Netlify remains authority for ownership / candidates. This service only sends.
 */
import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import admin from "firebase-admin";

const MAX_SKEW_SECONDS = 120;
const MAX_BODY_BYTES = 16 * 1024;

function relaySecret() {
  return (process.env.AMARE_PUSH_RELAY_SECRET || "").trim();
}

function sign(secret, timestamp, rawBody) {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

function signatureValid(secret, timestamp, rawBody, signature) {
  const got = String(signature || "")
    .trim()
    .replace(/^sha256=/i, "");
  if (!secret || !got || !/^[0-9a-f]{64}$/i.test(got)) return false;
  const expected = sign(secret, timestamp, rawBody);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(got, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function timestampFresh(timestamp) {
  const ts = Number(timestamp);
  if (!Number.isInteger(ts) || ts < 1) return false;
  return Math.abs(Math.floor(Date.now() / 1000) - ts) <= MAX_SKEW_SECONDS;
}

function header(req, name) {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(req.headers || {})) {
    if (k.toLowerCase() === want) return String(v || "").trim();
  }
  return "";
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body_too_large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function ensureAdmin() {
  if (!admin.apps.length) {
    admin.initializeApp({ projectId: "amare-auth" });
  }
  return admin;
}

function validatePayload(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "invalid_json";
  const allowed = new Set(["token", "title", "body", "data"]);
  for (const key of Object.keys(parsed)) {
    if (!allowed.has(key)) return "unknown_field";
  }
  const token = String(parsed.token || "").trim();
  if (!token || token.length > 4096) return "invalid_token";
  const title = String(parsed.title || "").trim();
  const body = String(parsed.body || "").trim();
  if (!title || title.length > 200 || !body || body.length > 500) return "invalid_copy";
  const data = parsed.data && typeof parsed.data === "object" && !Array.isArray(parsed.data) ? parsed.data : {};
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (typeof v !== "string") return "invalid_data";
    if (v.length > 256) return "invalid_data";
    out[k] = v;
  }
  return { token, title, body, data: out };
}

async function handleSend(req, res) {
  const secret = relaySecret();
  if (!secret || secret.length < 24) {
    console.warn(JSON.stringify({ event: "amare_push_relay_unconfigured" }));
    return json(res, 503, { ok: false, error: "relay_unconfigured" });
  }
  let rawBody = "";
  try {
    rawBody = await readBody(req);
  } catch {
    return json(res, 413, { ok: false, error: "body_too_large" });
  }
  const timestamp = header(req, "x-amare-relay-timestamp");
  const signature = header(req, "x-amare-relay-signature");
  if (!timestampFresh(timestamp) || !signatureValid(secret, timestamp, rawBody, signature)) {
    console.warn(JSON.stringify({ event: "amare_push_relay_unauthorized" }));
    return json(res, 401, { ok: false, error: "unauthorized" });
  }
  let parsed = null;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return json(res, 400, { ok: false, error: "invalid_json" });
  }
  const valid = validatePayload(parsed);
  if (typeof valid === "string") return json(res, 400, { ok: false, error: valid });

  try {
    const app = ensureAdmin();
    const name = await app.messaging().send({
      token: valid.token,
      notification: { title: valid.title, body: valid.body },
      data: {
        path: valid.data.path || "/my-classes",
        kind: valid.data.kind || "",
        classId: valid.data.classId || "",
      },
      android: {
        priority: "high",
        notification: {
          channelId: "amare-class",
          icon: "ic_stat_amare",
          color: "#1A1816",
        },
      },
    });
    console.log(JSON.stringify({ event: "amare_push_relay_sent", ok: true, hasToken: true }));
    return json(res, 200, { ok: true, name });
  } catch (err) {
    const code = String(err?.code || err?.errorInfo?.code || "");
    const message = String(err?.message || err).slice(0, 300);
    console.warn(JSON.stringify({ event: "amare_push_relay_fcm_failed", code }));
    const unregistered =
      code.includes("registration-token-not-registered") || message.toLowerCase().includes("requested entity was not found");
    return json(res, 502, {
      ok: false,
      error: "fcm_send_failed",
      code: unregistered ? "messaging/registration-token-not-registered" : code || undefined,
    });
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/health") {
    return json(res, 200, { ok: true });
  }
  if (req.method === "POST" && url.pathname === "/send") {
    return handleSend(req, res);
  }
  return json(res, 404, { ok: false, error: "not_found" });
});

const port = Number(process.env.PORT || 8080);
server.listen(port, () => {
  console.log(JSON.stringify({ event: "amare_push_relay_listen", port }));
});
