/**
 * Probe Mindbody client visits for status / sign-in fields.
 * Usage: node scripts/probe-client-visits.mjs --client-id=100003166
 */
import "./load-env.mjs";
import https from "node:https";

const V = "6";
const HOST = (process.env.MINDBODY_API_HOST || "api.mindbodyonline.com").trim();
const API_KEY = (process.env.MINDBODY_API_KEY || "").trim();
const SITE_ID = (process.env.MINDBODY_SITE_ID || "-99").trim();
const STAFF_USER = (process.env.MINDBODY_STAFF_USERNAME || "").trim();
const STAFF_PASS = process.env.MINDBODY_STAFF_PASSWORD || "";

function arg(name, fallback) {
  const p = `--${name}=`;
  for (const a of process.argv) {
    if (a.startsWith(p)) return a.slice(p.length);
  }
  return fallback;
}

const CLIENT_ID = parseInt(arg("client-id", "100003166"), 10);

function requestJson({ method, path, headers, bodyJson }) {
  return new Promise((resolve, reject) => {
    const body = bodyJson != null ? Buffer.from(JSON.stringify(bodyJson), "utf8") : null;
    const req = https.request(
      {
        hostname: HOST,
        port: 443,
        path,
        method,
        headers: {
          "API-Key": API_KEY,
          SiteId: SITE_ID,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json", "Content-Length": String(body.length) } : {}),
          ...(headers || {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          let data = null;
          const raw = Buffer.concat(chunks).toString("utf8");
          try {
            data = raw ? JSON.parse(raw) : null;
          } catch {
            data = { _raw: raw.slice(0, 500) };
          }
          resolve({ status: res.statusCode || 0, data });
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function issueStaffToken() {
  const r = await requestJson({
    method: "POST",
    path: `/public/v${V}/usertoken/issue`,
    bodyJson: { Username: STAFF_USER, Password: STAFF_PASS },
  });
  if (r.status !== 200) throw new Error(`usertoken/issue ${r.status}`);
  const token = r.data?.AccessToken || r.data?.accessToken;
  if (!token) throw new Error("no access token");
  return token;
}

function visitsList(data) {
  if (!data || typeof data !== "object") return [];
  for (const k of ["Visits", "ClientVisits", "visits"]) {
    if (Array.isArray(data[k])) return data[k];
  }
  return [];
}

const token = await issueStaffToken();
const start = new Date();
start.setUTCFullYear(start.getUTCFullYear() - 1);
const end = new Date();
end.setUTCDate(end.getUTCDate() + 30);

const q = new URLSearchParams({
  "request.clientId": String(CLIENT_ID),
  "request.startDate": start.toISOString(),
  "request.endDate": end.toISOString(),
  "request.limit": "100",
});

const r = await requestJson({
  method: "GET",
  path: `/public/v${V}/client/clientvisits?${q}`,
  headers: { Authorization: token },
});

console.log(`clientId=${CLIENT_ID} HTTP ${r.status}`);
const visits = visitsList(r.data);
console.log(`visitCount=${visits.length}`);

for (const v of visits.sort((a, b) =>
  String(a.StartDateTime || "").localeCompare(String(b.StartDateTime || "")),
)) {
  const when = v.StartDateTime || v.startDateTime || "?";
  const name = v.Name || v.ClassDescription?.Name || v.classDescription?.name || "?";
  console.log(
    JSON.stringify({
      id: v.Id ?? v.id,
      when,
      class: String(name).slice(0, 60),
      appointmentStatus: v.AppointmentStatus ?? v.appointmentStatus ?? null,
      signedIn: v.SignedIn ?? v.signedIn ?? null,
      missed: v.Missed ?? v.missed ?? null,
      lateCancelled: v.LateCancelled ?? v.lateCancelled ?? null,
      action: v.Action ?? v.action ?? null,
      webSignup: v.WebSignup ?? v.webSignup ?? null,
    }),
  );
}
