/**
 * Probe Mindbody Client endpoints for New Client SMS follow-up.
 * Redacts PII — logs field names, counts, and consent-related keys only.
 *
 * Usage:
 *   node scripts/mindbody-sms-endpoint-probe.mjs
 *   node scripts/mindbody-sms-endpoint-probe.mjs --client-id=100001965 --phone=6316091605
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

const TEST_CLIENT_ID = parseInt(arg("client-id", "100001965"), 10);
const TEST_PHONE = arg("phone", "6316091605");
const BATCH_IDS = [TEST_CLIENT_ID, 100002695, 100002698].filter((n) => Number.isFinite(n));

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

/** @param {unknown} v @param {number} [depth] */
function redactValue(v, depth = 0) {
  if (depth > 4) return "[depth]";
  if (v == null || typeof v === "boolean" || typeof v === "number") return v;
  if (typeof v === "string") {
    if (v.includes("@")) return "[email]";
    if (/\d{7,}/.test(v.replace(/\D/g, ""))) return "[phone/redacted]";
    if (v.length > 80) return `[string:${v.length}]`;
    return v;
  }
  if (Array.isArray(v)) return v.slice(0, 3).map((x) => redactValue(x, depth + 1));
  if (typeof v === "object") return redactObject(/** @type {Record<string, unknown>} */ (v), depth + 1);
  return String(v);
}

/** @param {Record<string, unknown>} o @param {number} depth */
function redactObject(o, depth = 0) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    out[k] = redactValue(v, depth);
  }
  return out;
}

/** @param {unknown} data */
function listKeysDeep(data, prefix = "") {
  /** @type {string[]} */
  const keys = [];
  if (!data || typeof data !== "object") return keys;
  if (Array.isArray(data)) {
    if (data[0] && typeof data[0] === "object") {
      keys.push(...listKeysDeep(data[0], `${prefix}[]`));
    }
    return keys;
  }
  const o = /** @type {Record<string, unknown>} */ (data);
  for (const [k, v] of Object.entries(o)) {
    const path = prefix ? `${prefix}.${k}` : k;
    keys.push(path);
    if (v && typeof v === "object") keys.push(...listKeysDeep(v, path));
  }
  return keys;
}

/** @param {string[]} keys */
function consentLikeKeys(keys) {
  const re = /sms|text|opt.?in|opt.?out|promo|mobile|communic|market|consent/i;
  return [...new Set(keys.filter((k) => re.test(k)))].sort();
}

/** @param {string} label @param {Promise<{status:number,data:unknown}>} p */
async function section(label, p) {
  console.log(`\n=== ${label} ===`);
  const r = await p;
  console.log("HTTP", r.status);
  if (r.data && typeof r.data === "object") {
    const err = /** @type {{ Error?: { Message?: string } }} */ (r.data).Error;
    if (err?.Message) console.log("Error:", err.Message);
  }
  return r;
}

async function main() {
  if (!API_KEY || !STAFF_USER || !STAFF_PASS) {
    console.error("Need MINDBODY_API_KEY, MINDBODY_STAFF_USERNAME, MINDBODY_STAFF_PASSWORD");
    process.exit(1);
  }
  const token = await issueStaffToken();
  const auth = { Authorization: `Bearer ${token}` };

  // 1. Client Services — single vs batch clientIds
  const qSingle = new URLSearchParams({
    "request.clientId": String(TEST_CLIENT_ID),
    "request.limit": "200",
  });
  const rSingle = await section(
    "GET client/clientservices (request.clientId)",
    requestJson({ method: "GET", path: `/public/v${V}/client/clientservices?${qSingle}`, headers: auth }),
  );
  const singleCount = Array.isArray(rSingle.data?.ClientServices)
    ? rSingle.data.ClientServices.length
    : 0;
  console.log("ClientServices count (single):", singleCount);

  const qBatch = new URLSearchParams({ "request.limit": "200" });
  for (const id of BATCH_IDS) qBatch.append("request.clientIds", String(id));
  const rBatch = await section(
    "GET client/clientservices (request.clientIds[] batch)",
    requestJson({ method: "GET", path: `/public/v${V}/client/clientservices?${qBatch}`, headers: auth }),
  );
  const batchRows = Array.isArray(rBatch.data?.ClientServices) ? rBatch.data.ClientServices : [];
  console.log("ClientServices count (batch):", batchRows.length);
  if (batchRows[0]) {
    console.log("Sample service keys:", Object.keys(batchRows[0]).sort().join(", "));
  }

  // 2. Client Visits
  const start = new Date();
  start.setUTCMonth(start.getUTCMonth() - 3);
  const end = new Date();
  end.setUTCMonth(end.getUTCMonth() + 1);
  const qVisits = new URLSearchParams({
    "request.clientId": String(TEST_CLIENT_ID),
    "request.startDate": start.toISOString(),
    "request.endDate": end.toISOString(),
    "request.limit": "5",
  });
  const rVisits = await section(
    "GET client/clientvisits (per clientId + date range)",
    requestJson({ method: "GET", path: `/public/v${V}/client/clientvisits?${qVisits}`, headers: auth }),
  );
  const visits = Array.isArray(rVisits.data?.Visits) ? rVisits.data.Visits : [];
  console.log("Visits returned:", visits.length);
  if (visits[0]) {
    console.log("Visit keys:", Object.keys(visits[0]).sort().join(", "));
    console.log("Visit sample (redacted):", JSON.stringify(redactObject(visits[0]), null, 2));
  }

  const qVisitsBatch = new URLSearchParams({
    "request.startDate": start.toISOString(),
    "request.endDate": end.toISOString(),
    "request.limit": "5",
  });
  qVisitsBatch.append("request.clientIds", String(TEST_CLIENT_ID));
  const rVisitsBatch = await section(
    "GET client/clientvisits (request.clientIds — probe)",
    requestJson({ method: "GET", path: `/public/v${V}/client/clientvisits?${qVisitsBatch}`, headers: auth }),
  );
  console.log(
    "clientIds batch visits count:",
    Array.isArray(rVisitsBatch.data?.Visits) ? rVisitsBatch.data.Visits.length : 0,
  );

  // 3. Client Complete Info
  const qCci = new URLSearchParams({ "request.clientId": String(TEST_CLIENT_ID) });
  const rCci = await section(
    "GET client/clientcompleteinfo",
    requestJson({ method: "GET", path: `/public/v${V}/client/clientcompleteinfo?${qCci}`, headers: auth }),
  );
  const clientObj = rCci.data?.Client || rCci.data?.client || rCci.data;
  const cciKeys = listKeysDeep(clientObj);
  console.log("Consent-like keys:", consentLikeKeys(cciKeys));
  if (clientObj && typeof clientObj === "object") {
    const subset = {};
    for (const k of consentLikeKeys(Object.keys(/** @type {object} */ (clientObj)))) {
      subset[k] = /** @type {Record<string, unknown>} */ (clientObj)[k];
    }
    console.log("Consent fields (values):", JSON.stringify(subset, null, 2));
    console.log("Client subset (redacted):", JSON.stringify(redactObject(/** @type {Record<string, unknown>} */ (clientObj)), null, 2));
  }

  // 4. Get Clients — phone/email search
  for (const [label, search] of [
    ["phone searchText", TEST_PHONE],
    ["email probe", "gmail.com"],
  ]) {
    const q = new URLSearchParams({ "request.searchText": search, "request.limit": "10" });
    const r = await section(
      `GET client/clients (${label})`,
      requestJson({ method: "GET", path: `/public/v${V}/client/clients?${q}`, headers: auth }),
    );
    const clients = Array.isArray(r.data?.Clients) ? r.data.Clients : [];
    console.log("Matches:", clients.length);
    if (clients[0]) {
      console.log("Match keys:", Object.keys(clients[0]).sort().join(", "));
      console.log("Consent-like on client row:", consentLikeKeys(Object.keys(clients[0])));
    }
  }

  const qById = new URLSearchParams({ "request.clientIDs": String(TEST_CLIENT_ID), "request.limit": "5" });
  const rById = await section(
    "GET client/clients (request.clientIDs)",
    requestJson({ method: "GET", path: `/public/v${V}/client/clients?${qById}`, headers: auth }),
  );
  const byIdRow = Array.isArray(rById.data?.Clients) ? rById.data.Clients[0] : null;
  if (byIdRow) {
    console.log("GetClients consent-like:", consentLikeKeys(Object.keys(byIdRow)));
  }

  // 5. Custom Client Fields
  const rCustom = await section(
    "GET client/customclientfields",
    requestJson({ method: "GET", path: `/public/v${V}/client/customclientfields`, headers: auth }),
  );
  const customFields = Array.isArray(rCustom.data?.CustomClientFields)
    ? rCustom.data.CustomClientFields
    : Array.isArray(rCustom.data?.customClientFields)
      ? rCustom.data.customClientFields
      : [];
  console.log("Custom field definitions:", customFields.length);
  for (const f of customFields.slice(0, 20)) {
    if (!f || typeof f !== "object") continue;
    const o = /** @type {Record<string, unknown>} */ (f);
    const name = String(o.Name ?? o.name ?? o.Id ?? "");
    if (/sms|text|opt|promo|market|communic/i.test(name)) {
      console.log("  SMS-related custom field:", redactObject(o));
    }
  }

  const rCustomVal = await section(
    "GET client/customclientfields (clientId scoped)",
    requestJson({
      method: "GET",
      path: `/public/v${V}/client/customclientfields?${new URLSearchParams({ "request.clientId": String(TEST_CLIENT_ID) })}`,
      headers: auth,
    }),
  );
  console.log("Custom fields for client (redacted):", JSON.stringify(redactValue(rCustomVal.data), null, 2));

  // 6. Required Client Fields
  const rReq = await section(
    "GET client/requiredclientfields",
    requestJson({ method: "GET", path: `/public/v${V}/client/requiredclientfields`, headers: auth }),
  );
  console.log("Required fields payload (redacted):", JSON.stringify(redactValue(rReq.data), null, 2));

  // 7. Contact Logs — document only
  const qLogs = new URLSearchParams({
    "request.clientId": String(TEST_CLIENT_ID),
    "request.limit": "3",
  });
  const rLogs = await section(
    "GET client/contactlogs (sample — not for v1)",
    requestJson({ method: "GET", path: `/public/v${V}/client/contactlogs?${qLogs}`, headers: auth }),
  );
  const logs = Array.isArray(rLogs.data?.ContactLogs)
    ? rLogs.data.ContactLogs
    : Array.isArray(rLogs.data?.contactLogs)
      ? rLogs.data.contactLogs
      : [];
  console.log("ContactLogs count:", logs.length);
  if (logs[0]) console.log("ContactLog keys:", Object.keys(logs[0]).sort().join(", "));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
