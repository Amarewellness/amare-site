/**
 * Probe a Mindbody Pricing Option (Service id) end-to-end against the same
 * staff-token CheckoutShoppingCart flow our Stripe → Mindbody webhook uses.
 *
 * Goal: verify a "Sell online: No" Pricing Option (e.g. 100133 — AMARÉ Monthly
 * 5 Classes) is purchasable through `/public/v6/sale/checkoutshoppingcart`
 * with our staff Bearer token, including:
 *   • the cart accepts the Service id (no "Failed" cart line)
 *   • the client receives Remaining=N credits
 *   • the service has the configured ExpirationDate (≈ +1 month)
 *   • the same Service can be added to the same client twice (monthly renewal)
 *
 * Stages (gated by flags so destructive writes never happen by accident):
 *   STAGE 1  always           GET /public/v6/sale/services?ServiceIds=<id>
 *   STAGE 1B always           GET /public/v6/sale/services?Search=<id>
 *   STAGE 2  --dry            POST /sale/checkoutshoppingcart   { Test: true }
 *   STAGE 3  --confirm-live   POST /sale/checkoutshoppingcart   { Test: false }
 *   STAGE 4  after stage 3    GET /public/v6/client/clientservices?clientId=…
 *   STAGE 5  --twice + live   STAGE 3 again, then STAGE 4 again
 *
 * Usage:
 *   node scripts/mindbody-membership-service-probe.mjs --service-id=100133
 *   node scripts/mindbody-membership-service-probe.mjs --service-id=100133 --client-id=<id> --dry
 *   node scripts/mindbody-membership-service-probe.mjs --service-id=100133 --client-id=<id> --confirm-live --twice
 *
 * Required env (loaded from .env via scripts/load-env.mjs):
 *   MINDBODY_API_KEY, MINDBODY_SITE_ID, MINDBODY_STAFF_USERNAME, MINDBODY_STAFF_PASSWORD
 *   MINDBODY_STRIPE_PAYMENT_METHOD_ID, MINDBODY_STRIPE_PAYMENT_METHOD_NAME
 */
import "./load-env.mjs";
import https from "node:https";

const API_VERSION = "6";
const HOST = (process.env.MINDBODY_API_HOST || "api.mindbodyonline.com").trim();
const API_KEY = (process.env.MINDBODY_API_KEY || "").trim();
const SITE_ID = (process.env.MINDBODY_SITE_ID || "-99").trim();
const STAFF_USER = (process.env.MINDBODY_STAFF_USERNAME || "").trim();
const STAFF_PASS = process.env.MINDBODY_STAFF_PASSWORD || "";
const PAY_METHOD_ID = parseInt((process.env.MINDBODY_STRIPE_PAYMENT_METHOD_ID || "0").trim(), 10);
const PAY_METHOD_NAME = (process.env.MINDBODY_STRIPE_PAYMENT_METHOD_NAME || "Stripe").trim();
const SALE_LOCATION_ID = parseInt((process.env.MINDBODY_SALE_LOCATION_ID || "0").trim(), 10);

/* ---------------------------------------------------------------------------- */
/* CLI args                                                                     */
/* ---------------------------------------------------------------------------- */

function arg(name, fallback = null) {
  const prefix = `--${name}=`;
  for (const a of process.argv) {
    if (a.startsWith(prefix)) return a.slice(prefix.length);
  }
  for (const a of process.argv) {
    if (a === `--${name}`) return "1";
  }
  return fallback;
}

const SERVICE_ID = parseInt(String(arg("service-id", "100133")), 10);
const CLIENT_ID_RAW = arg("client-id", "");
const CLIENT_ID = /^\d+$/.test(String(CLIENT_ID_RAW || "").trim())
  ? parseInt(String(CLIENT_ID_RAW).trim(), 10)
  : null;
const DRY = !!arg("dry");
const CONFIRM_LIVE = !!arg("confirm-live");
const TWICE = !!arg("twice");
const PROBE_PAYNOTE = `probe-${Date.now()}`;

/* ---------------------------------------------------------------------------- */
/* Pretty print                                                                 */
/* ---------------------------------------------------------------------------- */

const C_RESET = "\x1b[0m";
const C_BOLD = "\x1b[1m";
const C_DIM = "\x1b[2m";
const C_RED = "\x1b[31m";
const C_GREEN = "\x1b[32m";
const C_YELLOW = "\x1b[33m";
const C_CYAN = "\x1b[36m";

function header(label) {
  console.log("");
  console.log(`${C_BOLD}${C_CYAN}── ${label} ──${C_RESET}`);
}
function ok(msg) {
  console.log(`  ${C_GREEN}✓${C_RESET} ${msg}`);
}
function warn(msg) {
  console.log(`  ${C_YELLOW}!${C_RESET} ${msg}`);
}
function fail(msg) {
  console.log(`  ${C_RED}✗${C_RESET} ${msg}`);
}
function dim(msg) {
  console.log(`  ${C_DIM}${msg}${C_RESET}`);
}

/* ---------------------------------------------------------------------------- */
/* HTTPS                                                                        */
/* ---------------------------------------------------------------------------- */

function requestJson({ method, path, headers, bodyJson }) {
  return new Promise((resolve, reject) => {
    const body = bodyJson != null ? Buffer.from(JSON.stringify(bodyJson), "utf8") : null;
    const finalHeaders = {
      "API-Key": API_KEY,
      SiteId: SITE_ID,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json", "Content-Length": String(body.length) } : {}),
      ...(headers || {}),
    };
    const req = https.request(
      { hostname: HOST, port: 443, path, method, headers: finalHeaders },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let data = null;
          try {
            data = raw ? JSON.parse(raw) : null;
          } catch {
            data = { _nonJson: true, raw: raw.slice(0, 800) };
          }
          resolve({ status: res.statusCode || 0, ok: !!(res.statusCode && res.statusCode < 400), data });
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/* ---------------------------------------------------------------------------- */
/* Staff token                                                                  */
/* ---------------------------------------------------------------------------- */

async function issueStaffToken() {
  if (!STAFF_USER || !STAFF_PASS) throw new Error("MINDBODY_STAFF_USERNAME / MINDBODY_STAFF_PASSWORD not set in .env");
  const r = await requestJson({
    method: "POST",
    path: `/public/v${API_VERSION}/usertoken/issue`,
    headers: {},
    bodyJson: { Username: STAFF_USER, Password: STAFF_PASS },
  });
  if (!r.ok) {
    throw new Error(`usertoken/issue HTTP ${r.status}: ${JSON.stringify(r.data).slice(0, 400)}`);
  }
  const token =
    r.data?.AccessToken ?? r.data?.accessToken ?? r.data?.access_token ?? r.data?.AccessToken?.access_token;
  if (!token || typeof token !== "string") throw new Error(`No AccessToken in response: ${JSON.stringify(r.data).slice(0, 400)}`);
  return token;
}

/* ---------------------------------------------------------------------------- */
/* Stages                                                                       */
/* ---------------------------------------------------------------------------- */

function findFailedLine(data) {
  if (!data || typeof data !== "object") return null;
  for (const seg of [data.ShoppingCart, data.shoppingCart, data.Sale, data.sale, data]) {
    if (!seg || typeof seg !== "object") continue;
    for (const key of ["CartItems", "cartItems", "Items", "items"]) {
      const arr = seg[key];
      if (!Array.isArray(arr)) continue;
      for (let i = 0; i < arr.length; i++) {
        const it = arr[i];
        if (!it || typeof it !== "object") continue;
        const action = it.Action ?? it.action;
        if (typeof action === "string" && /^failed$/i.test(action)) {
          return { index: i, action, item: it };
        }
      }
    }
  }
  return null;
}

function extractSaleId(data) {
  if (!data || typeof data !== "object") return null;
  /** Mindbody envelopes vary: live carts return `ShoppingCart.SaleId` directly, others nest under `Sale.Id`. */
  for (const path of [
    data?.ShoppingCart,
    data?.shoppingCart,
    data?.ShoppingCart?.Sale,
    data?.Sale,
    data?.shoppingCart?.sale,
    data?.sale,
    data,
  ]) {
    const id = path?.SaleId ?? path?.saleId ?? path?.Id ?? path?.id;
    if (typeof id === "number" && id > 0) return id;
    if (typeof id === "string" && /^\d+$/.test(id)) return parseInt(id, 10);
  }
  return null;
}

function summarizeServiceRow(row) {
  if (!row || typeof row !== "object") return "(no row)";
  const o = /** @type {Record<string, unknown>} */ (row);
  const fields = [
    ["Id", o.Id ?? o.ID ?? o.ServiceId],
    ["Name", o.Name ?? o.ServiceName],
    ["Price", o.Price ?? o.OnlinePrice],
    ["Count", o.Count],
    ["ExpirationLength", o.ExpirationLength],
    ["ExpirationType", o.ExpirationType],
    ["SellOnline", o.SellOnline],
    ["Type", o.Type],
    ["Active", o.Active],
    ["IsIntroOffer", o.IsIntroOffer],
    ["Category", o.Category ?? o.CategoryName],
    ["MembershipType", o.MembershipType],
  ];
  return fields
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${typeof v === "string" ? JSON.stringify(v) : v}`)
    .join("  ");
}

function pickServicesArray(data) {
  if (!data || typeof data !== "object") return [];
  return (
    data.Services ??
    data.services ??
    data.Service ??
    (Array.isArray(data) ? data : []) ??
    []
  );
}

function pickClientServicesArray(data) {
  if (!data || typeof data !== "object") return [];
  return data.ClientServices ?? data.clientServices ?? [];
}

async function stage1ServiceLookup(staffToken) {
  header(`STAGE 1 — GET /sale/services?ServiceIds=${SERVICE_ID}`);
  const headersStaff = { Authorization: `Bearer ${staffToken}` };
  // Try without SellOnline filter first (most permissive — staff should see Sell-online-No items)
  const q = new URLSearchParams();
  q.set("ServiceIds", String(SERVICE_ID));
  q.set("Limit", "5");
  const r1 = await requestJson({
    method: "GET",
    path: `/public/v${API_VERSION}/sale/services?${q.toString()}`,
    headers: headersStaff,
  });
  console.log(`  HTTP ${r1.status}`);
  const list1 = pickServicesArray(r1.data);
  if (!Array.isArray(list1) || list1.length === 0) {
    fail(`No service returned for id=${SERVICE_ID} (without SellOnline filter)`);
    if (r1.data) dim(`payload: ${JSON.stringify(r1.data).slice(0, 500)}`);
  } else {
    ok(`Service id=${SERVICE_ID} returned (${list1.length} row${list1.length > 1 ? "s" : ""})`);
    for (const row of list1) dim(summarizeServiceRow(row));
  }

  // Also try WITH SellOnline=true — it should NOT return our service (since Sell online is No)
  const q2 = new URLSearchParams();
  q2.set("ServiceIds", String(SERVICE_ID));
  q2.set("SellOnline", "true");
  q2.set("Limit", "5");
  const r2 = await requestJson({
    method: "GET",
    path: `/public/v${API_VERSION}/sale/services?${q2.toString()}`,
    headers: headersStaff,
  });
  const list2 = pickServicesArray(r2.data);
  console.log(`  ${C_DIM}HTTP ${r2.status}, SellOnline=true filter: ${list2.length} rows${C_RESET}`);
  if (list2.length === 0) {
    ok("Confirmed: Service is NOT exposed to public sale catalog (SellOnline filter excludes it). Staff can still post it.");
  } else {
    warn("Service shows up under SellOnline=true — was the toggle just changed?");
  }

  return list1[0] || null;
}

function buildCheckoutPayload({ test, paynote, priceUsd }) {
  const itemMetadata = { Id: SERVICE_ID, ServiceId: SERVICE_ID };
  const amount = Number(priceUsd);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`buildCheckoutPayload: invalid priceUsd=${priceUsd}`);
  }
  const cart = {
    ClientId: String(CLIENT_ID),
    Test: test,
    test,
    Items: [{ Item: { Type: "Service", Metadata: itemMetadata }, Quantity: 1 }],
    Payments: [
      {
        Type: "Custom",
        Metadata: {
          id: PAY_METHOD_ID,
          Id: PAY_METHOD_ID,
          PaymentMethodId: PAY_METHOD_ID,
          Name: PAY_METHOD_NAME,
          Amount: amount,
          AmountPaid: amount,
          Notes: paynote,
          PayNotes: paynote,
        },
      },
    ],
    InStore: false,
    SendEmail: !test,
  };
  if (Number.isFinite(SALE_LOCATION_ID) && SALE_LOCATION_ID > 0) cart.LocationId = SALE_LOCATION_ID;
  return cart;
}

async function stageCart({ test, staffToken, label, paynote, priceUsd }) {
  header(label);
  if (!CLIENT_ID) {
    fail("Missing --client-id=<id>; cannot run cart stages.");
    return null;
  }
  if (!Number.isFinite(PAY_METHOD_ID) || PAY_METHOD_ID <= 0) {
    fail("Missing MINDBODY_STRIPE_PAYMENT_METHOD_ID in .env; required for Custom payment row.");
    return null;
  }
  const payload = buildCheckoutPayload({ test, paynote, priceUsd });
  dim(`payload: ${JSON.stringify(payload).slice(0, 500)}`);
  const r = await requestJson({
    method: "POST",
    path: `/public/v${API_VERSION}/sale/checkoutshoppingcart`,
    headers: { Authorization: `Bearer ${staffToken}` },
    bodyJson: payload,
  });
  console.log(`  HTTP ${r.status}`);
  if (!r.ok) {
    fail(`Cart rejected. Body: ${JSON.stringify(r.data).slice(0, 800)}`);
    return null;
  }
  const failed = findFailedLine(r.data);
  if (failed) {
    fail(`Cart line returned Action="${failed.action}" — service id may be invalid or studio-blocked.`);
    dim(`failed line: ${JSON.stringify(failed.item).slice(0, 500)}`);
    return null;
  }
  const saleId = extractSaleId(r.data);
  if (saleId) ok(`SaleId=${saleId} (${test ? "Test:true — not persisted" : "live — persisted"})`);
  else warn(`Cart accepted but no SaleId found in response. payload=${JSON.stringify(r.data).slice(0, 500)}`);
  return { saleId, body: r.data };
}

async function stageClientServices(staffToken, label) {
  header(label);
  if (!CLIENT_ID) {
    fail("Missing --client-id=<id>");
    return null;
  }
  const q = new URLSearchParams();
  q.set("clientId", String(CLIENT_ID));
  q.set("limit", "100");
  q.set("showActiveOnly", "false");
  const r = await requestJson({
    method: "GET",
    path: `/public/v${API_VERSION}/client/clientservices?${q.toString()}`,
    headers: { Authorization: `Bearer ${staffToken}` },
  });
  console.log(`  HTTP ${r.status}`);
  if (!r.ok) {
    fail(`clientservices fetch failed: ${JSON.stringify(r.data).slice(0, 400)}`);
    return null;
  }
  const list = pickClientServicesArray(r.data);
  console.log(`  ${list.length} row(s) returned for clientId=${CLIENT_ID}`);
  const matching = list.filter((row) => {
    const id = row?.ProductId ?? row?.productId ?? row?.Id ?? row?.id ?? row?.ServiceId ?? row?.serviceId;
    if (typeof id === "number") return id === SERVICE_ID;
    if (typeof id === "string") return id.trim() === String(SERVICE_ID);
    return false;
  });
  if (matching.length === 0) {
    warn(`No row for serviceId=${SERVICE_ID} on this client (may be normal if cart was Test:true)`);
  } else {
    ok(`Found ${matching.length} matching service row(s) for serviceId=${SERVICE_ID}`);
    for (const row of matching) {
      const o = /** @type {Record<string, unknown>} */ (row);
      const fields = [
        ["Id", o.Id ?? o.ID],
        ["ProductId", o.ProductId],
        ["Name", o.Name ?? o.ServiceName],
        ["Remaining", o.Remaining ?? o.remaining],
        ["Count", o.Count ?? o.count],
        ["Active", o.Active],
        ["ActiveDate", o.ActiveDate],
        ["ExpirationDate", o.ExpirationDate],
        ["PaymentDate", o.PaymentDate],
        ["SaleDate", o.SaleDate],
        ["MembershipType", o.MembershipType],
      ];
      dim(
        fields
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => `${k}=${typeof v === "string" ? JSON.stringify(v) : v}`)
          .join("  "),
      );
    }
  }
  return list;
}

/* ---------------------------------------------------------------------------- */
/* Main                                                                         */
/* ---------------------------------------------------------------------------- */

(async () => {
  console.log(`${C_BOLD}Mindbody Membership Service Probe${C_RESET}`);
  console.log(`  service-id   = ${SERVICE_ID}`);
  console.log(`  client-id    = ${CLIENT_ID ?? "(not provided)"}`);
  console.log(`  mode         = ${DRY ? "dry-run (Test:true)" : CONFIRM_LIVE ? "LIVE (Test:false)" : "info-only"}`);
  console.log(`  twice        = ${TWICE ? "yes (run live cart twice — repeat-renewal sim)" : "no"}`);
  console.log(`  paynote      = ${PROBE_PAYNOTE}`);
  console.log(`  payMethodId  = ${PAY_METHOD_ID || "(missing)"}  payMethodName = ${PAY_METHOD_NAME}`);
  console.log(`  siteId       = ${SITE_ID}  host = ${HOST}`);

  if (!API_KEY) {
    fail("MINDBODY_API_KEY missing in .env");
    process.exit(2);
  }

  const staffToken = await issueStaffToken();
  ok(`Staff token issued (length=${staffToken.length})`);

  const serviceRow = await stage1ServiceLookup(staffToken);
  if (!serviceRow) {
    fail(`Aborting: Service id=${SERVICE_ID} not found via /sale/services lookup. Cart stages would fail anyway.`);
    process.exit(1);
  }

  /** Take Price from Stage 1 service row so the Custom payment line matches Mindbody's calculated cart total. */
  const priceUsd = (() => {
    const o = /** @type {Record<string, unknown>} */ (serviceRow);
    for (const k of ["OnlinePrice", "Price", "PriceWithTax", "OnlinePriceWithTax"]) {
      const v = o[k];
      if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
    }
    return null;
  })();
  if (priceUsd == null) {
    fail(`Could not read a positive Price from /sale/services row for id=${SERVICE_ID}.`);
    process.exit(1);
  }
  ok(`Catalog price = $${priceUsd} (used for Custom payment Amount)`);

  if (!DRY && !CONFIRM_LIVE) {
    console.log("");
    dim("Stage 1 done. To proceed:");
    dim(`  • Dry-run a cart against a test client:   --client-id=<id> --dry`);
    dim(`  • Live cart on a test client:             --client-id=<id> --confirm-live`);
    dim(`  • Live cart × 2 (renewal simulation):     --client-id=<id> --confirm-live --twice`);
    process.exit(0);
  }

  if (DRY) {
    await stageCart({ test: true, staffToken, priceUsd, label: "STAGE 2 — POST /sale/checkoutshoppingcart  (Test:true)", paynote: PROBE_PAYNOTE + ";dry" });
  }

  if (CONFIRM_LIVE) {
    await stageClientServices(staffToken, "STAGE 4-pre — clientservices BEFORE first live purchase");
    const live1 = await stageCart({ test: false, staffToken, priceUsd, label: "STAGE 3 — POST /sale/checkoutshoppingcart  (Test:false LIVE)", paynote: PROBE_PAYNOTE + ";live1" });
    if (!live1) process.exit(1);
    await stageClientServices(staffToken, "STAGE 4 — clientservices AFTER first live purchase");
    if (TWICE) {
      const live2 = await stageCart({ test: false, staffToken, priceUsd, label: "STAGE 5 — POST /sale/checkoutshoppingcart  (Test:false LIVE — repeat)", paynote: PROBE_PAYNOTE + ";live2" });
      if (!live2) process.exit(1);
      await stageClientServices(staffToken, "STAGE 5b — clientservices AFTER second live purchase");
    }
  }

  console.log("");
  ok("Probe complete.");
})().catch((err) => {
  console.error("");
  console.error(`${C_RED}Probe error:${C_RESET} ${err?.message ?? err}`);
  process.exit(1);
});
