/**
 * One-shot discovery: dump the Mindbody Custom Payment Methods so you can pin the numeric Id
 * for the "Stripe" entry into `MINDBODY_STRIPE_PAYMENT_METHOD_ID` in `.env`.
 *
 * Why: Mindbody's CheckoutShoppingCart with `Type:"Custom"` REQUIRES `Metadata.id` (lowercase)
 * containing the numeric payment method id. Sending only `Metadata.Name` returns
 * "The received Custom's Metadata was missing key id." (caught during mindbody_test dry-run).
 *
 * Usage:
 *   node scripts/stripe-find-mindbody-payment-method-id.mjs
 *   node scripts/stripe-find-mindbody-payment-method-id.mjs --filter=stripe
 *
 * Reads `.env` via `scripts/load-env.mjs`. Requires:
 *   - MINDBODY_API_KEY
 *   - MINDBODY_SITE_ID
 *   - MINDBODY_STAFF_USERNAME + MINDBODY_STAFF_PASSWORD
 *     (the same staff used by the rest of the integration; the endpoint requires a staff
 *     User Token).
 */
import "./load-env.mjs";
import https from "node:https";

const host = (process.env.MINDBODY_API_HOST || "api.mindbodyonline.com").trim();
const apiKey = (process.env.MINDBODY_API_KEY || "").trim();
const siteId = (process.env.MINDBODY_SITE_ID || "-99").trim();
const staffUser = (process.env.MINDBODY_STAFF_USERNAME || "").trim();
const staffPass = process.env.MINDBODY_STAFF_PASSWORD || "";
const targetName = (process.env.MINDBODY_STRIPE_PAYMENT_METHOD_NAME || "Stripe").trim();
const filter = (() => {
  const arg = process.argv.find((a) => a.startsWith("--filter="));
  if (!arg) return targetName.toLowerCase();
  return arg.slice("--filter=".length).trim().toLowerCase();
})();

if (!apiKey) {
  console.error("Missing MINDBODY_API_KEY in .env. See .env.example.");
  process.exit(2);
}
if (!staffUser || !staffPass) {
  console.error(
    "Missing MINDBODY_STAFF_USERNAME / MINDBODY_STAFF_PASSWORD. The custompaymentmethods endpoint requires a staff User Token.",
  );
  process.exit(2);
}

/**
 * @param {{ method: "GET" | "POST"; path: string; headers?: Record<string,string>; body?: unknown }} r
 * @returns {Promise<{ status: number; data: unknown }>}
 */
function call(r) {
  const body = r.body == null ? null : JSON.stringify(r.body);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: host,
        port: 443,
        path: r.path,
        method: r.method,
        headers: {
          "API-Key": apiKey,
          SiteId: siteId,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(r.headers || {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let data = raw;
          try {
            data = raw ? JSON.parse(raw) : null;
          } catch {
            /* keep raw text */
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

/** Issue a staff User Token (the same shape used by `mindbody-upstream.mjs::issueStaffUserToken`). */
async function issueStaffUserToken() {
  const r = await call({
    method: "POST",
    path: "/public/v6/usertoken/issue",
    body: { Username: staffUser, Password: staffPass },
  });
  if (r.status >= 400 || !r.data || typeof r.data !== "object") {
    return { ok: false, status: r.status, data: r.data };
  }
  const tok =
    /** @type {Record<string, unknown>} */ (r.data).AccessToken ??
    /** @type {Record<string, unknown>} */ (r.data).accessToken ??
    /** @type {Record<string, unknown>} */ (r.data).access_token;
  if (typeof tok !== "string" || !tok) return { ok: false, status: r.status, data: r.data };
  return { ok: true, accessToken: tok };
}

async function fetchCustomPaymentMethods(accessToken) {
  /**
   * `GET /public/v6/sale/custompaymentmethods` — Returns CustomPaymentMethods[] with each
   * row exposing Id and Name. Auth: API-Key + SiteId + Authorization: Bearer <staff>.
   */
  const r = await call({
    method: "GET",
    path: "/public/v6/sale/custompaymentmethods?limit=200",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return r;
}

(async () => {
  console.log(`Resolving custom payment methods for SiteId=${siteId} (target name: "${targetName}").`);
  const tok = await issueStaffUserToken();
  if (!tok.ok) {
    console.error(
      "Failed to issue Mindbody staff User Token.",
      JSON.stringify({ status: tok.status, body: tok.data }, null, 2).slice(0, 800),
    );
    process.exit(1);
  }
  const r = await fetchCustomPaymentMethods(tok.accessToken);
  if (r.status >= 400 || !r.data || typeof r.data !== "object") {
    console.error(
      `HTTP ${r.status} GET /public/v6/sale/custompaymentmethods`,
      JSON.stringify(r.data, null, 2).slice(0, 800),
    );
    process.exit(1);
  }
  const d = /** @type {Record<string, unknown>} */ (r.data);
  /**
   * Mindbody returns the rows under `PaymentMethods` (not `CustomPaymentMethods` despite the
   * endpoint name). Defensive against future schema drift.
   */
  /** @type {unknown[]} */
  const rows = Array.isArray(d.PaymentMethods)
    ? /** @type {unknown[]} */ (d.PaymentMethods)
    : Array.isArray(d.paymentMethods)
      ? /** @type {unknown[]} */ (d.paymentMethods)
      : Array.isArray(d.CustomPaymentMethods)
        ? /** @type {unknown[]} */ (d.CustomPaymentMethods)
        : [];
  if (!rows.length) {
    console.warn(
      "No PaymentMethods returned. Confirm Mindbody Site Settings → Payment Methods has at least one Custom row.",
    );
    console.log("\nRaw response keys:", Object.keys(d).join(", ") || "(empty)");
    console.log("Raw response (first 1200 chars):");
    console.log(JSON.stringify(d, null, 2).slice(0, 1200));
    return;
  }

  /** @type {{ id: number; name: string }[]} */
  const list = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const o = /** @type {Record<string, unknown>} */ (raw);
    const id = o.Id ?? o.id;
    const name = (o.Name ?? o.name ?? "").toString().trim();
    if (typeof id !== "number" || !Number.isFinite(id) || !name) continue;
    list.push({ id: Math.trunc(id), name });
  }
  list.sort((a, b) => a.name.localeCompare(b.name));

  console.log(`\nAll custom payment methods (${list.length} row${list.length === 1 ? "" : "s"}):`);
  for (const row of list) {
    const star = row.name.toLowerCase() === targetName.toLowerCase() ? " ← matches target" : "";
    console.log(`  ${String(row.id).padStart(8)}  ${row.name}${star}`);
  }

  if (filter) {
    const filtered = list.filter((r) => r.name.toLowerCase().includes(filter));
    if (filtered.length === 0) {
      console.warn(
        `\nNo custom payment method whose Name contains "${filter}". Create one in Mindbody Site Settings → Payment Methods (Type: Custom, Name: "${targetName}", PayNotes enabled).`,
      );
      process.exit(2);
    }
    if (filtered.length === 1) {
      console.log(
        `\nPaste this into your .env (and Netlify environment when deploying):\n  MINDBODY_STRIPE_PAYMENT_METHOD_ID=${filtered[0].id}`,
      );
    } else {
      console.log(
        `\n${filtered.length} candidate rows match "${filter}". Pick the right Id and paste:\n  MINDBODY_STRIPE_PAYMENT_METHOD_ID=<chosen-id>`,
      );
    }
  }
})();
