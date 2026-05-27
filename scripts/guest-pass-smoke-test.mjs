/**
 * Bring-a-Friend Guest Pass — Mindbody CheckoutShoppingCart smoke test (ServiceId 100136).
 *
 * Verifies the $0 "Guest Pass - 1 Class" Pricing Option accepts staff-bearer
 * CheckoutShoppingCart with Type: Comp / Amount: 0 (Option A from bring-a-friend plan).
 *
 * Usage:
 *   node scripts/guest-pass-smoke-test.mjs
 *   node scripts/guest-pass-smoke-test.mjs --client-id=100002753 --dry
 *   node scripts/guest-pass-smoke-test.mjs --client-id=100002753 --confirm-live
 *
 * Env: MINDBODY_API_KEY, MINDBODY_SITE_ID, MINDBODY_STAFF_USERNAME, MINDBODY_STAFF_PASSWORD
 *      MINDBODY_SALE_LOCATION_ID (optional)
 */
import "./load-env.mjs";
import https from "node:https";

const API_VERSION = "6";
const HOST = (process.env.MINDBODY_API_HOST || "api.mindbodyonline.com").trim();
const API_KEY = (process.env.MINDBODY_API_KEY || "").trim();
const SITE_ID = (process.env.MINDBODY_SITE_ID || "-99").trim();
const STAFF_USER = (process.env.MINDBODY_STAFF_USERNAME || "").trim();
const STAFF_PASS = process.env.MINDBODY_STAFF_PASSWORD || "";
const SALE_LOCATION_ID = parseInt((process.env.MINDBODY_SALE_LOCATION_ID || "0").trim(), 10);
const DEFAULT_SERVICE_ID = 100136;
const DEFAULT_CLIENT_ID = 100002753;

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

const SERVICE_ID = parseInt(String(arg("service-id", String(DEFAULT_SERVICE_ID))), 10);
const CLIENT_ID_RAW = arg("client-id", String(DEFAULT_CLIENT_ID));
const CLIENT_ID = /^\d+$/.test(String(CLIENT_ID_RAW || "").trim())
  ? parseInt(String(CLIENT_ID_RAW).trim(), 10)
  : null;
const DRY = !!arg("dry");
const CONFIRM_LIVE = !!arg("confirm-live");
const PROBE_PAYNOTE = `guest-pass-smoke-${Date.now()}`;

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

async function issueStaffToken() {
  if (!STAFF_USER || !STAFF_PASS) {
    throw new Error("MINDBODY_STAFF_USERNAME / MINDBODY_STAFF_PASSWORD not set in .env");
  }
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
  if (!token || typeof token !== "string") {
    throw new Error(`No AccessToken in response: ${JSON.stringify(r.data).slice(0, 400)}`);
  }
  return token;
}

function pickServicesArray(data) {
  if (!data || typeof data !== "object") return [];
  return data.Services ?? data.services ?? data.Service ?? (Array.isArray(data) ? data : []) ?? [];
}

function pickClientServicesArray(data) {
  if (!data || typeof data !== "object") return [];
  return data.ClientServices ?? data.clientServices ?? [];
}

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

/** Same Comp shape as mindbody-sale-checkout.mjs buildCheckoutPayload (Option A — $0). */
function buildGuestPassCheckoutPayload({ test, compAmountUsd }) {
  const amt = Number(compAmountUsd);
  if (!Number.isFinite(amt) || amt < 0) {
    throw new Error(`invalid compAmountUsd=${compAmountUsd}`);
  }
  /** @type {Record<string, unknown>} */
  const checkout = {
    ClientId: String(CLIENT_ID),
    Test: test,
    test,
    Items: [
      {
        Item: {
          Type: "Service",
          Metadata: { Id: SERVICE_ID, ServiceId: SERVICE_ID },
        },
        Quantity: 1,
      },
    ],
    Payments: [
      {
        Type: "Comp",
        Metadata: { Amount: amt, AmountPaid: amt },
      },
    ],
    InStore: false,
    SendEmail: false,
  };
  if (Number.isFinite(SALE_LOCATION_ID) && SALE_LOCATION_ID > 0) {
    checkout.LocationId = SALE_LOCATION_ID;
  }
  return checkout;
}

async function stageServiceLookup(staffToken) {
  header(`STAGE 1 — GET /sale/services?ServiceIds=${SERVICE_ID}`);
  const q = new URLSearchParams();
  q.set("ServiceIds", String(SERVICE_ID));
  q.set("Limit", "5");
  const r = await requestJson({
    method: "GET",
    path: `/public/v${API_VERSION}/sale/services?${q.toString()}`,
    headers: { Authorization: `Bearer ${staffToken}` },
  });
  console.log(`  HTTP ${r.status}`);
  const list = pickServicesArray(r.data);
  if (!list.length) {
    fail(`No service row for id=${SERVICE_ID}`);
    if (r.data) dim(JSON.stringify(r.data).slice(0, 500));
    return null;
  }
  const row = /** @type {Record<string, unknown>} */ (list[0]);
  ok(`Service found: ${JSON.stringify(row.Name ?? row.ServiceName)}`);
  dim(
    [
      ["Id", row.Id ?? row.ServiceId],
      ["Price", row.Price ?? row.OnlinePrice],
      ["Count", row.Count],
      ["SellOnline", row.SellOnline],
      ["ExpirationLength", row.ExpirationLength],
      ["ExpirationType", row.ExpirationType],
    ]
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${v}`)
      .join("  "),
  );
  return row;
}

async function stageCheckout({ test, staffToken, label, compAmountUsd }) {
  header(label);
  const payload = buildGuestPassCheckoutPayload({ test, compAmountUsd });
  dim(`Comp Amount=$${compAmountUsd}  Test=${test}`);
  const r = await requestJson({
    method: "POST",
    path: `/public/v${API_VERSION}/sale/checkoutshoppingcart`,
    headers: { Authorization: `Bearer ${staffToken}` },
    bodyJson: payload,
  });
  console.log(`  HTTP ${r.status}`);
  if (!r.ok) {
    fail(`Checkout rejected: ${JSON.stringify(r.data).slice(0, 900)}`);
    return { ok: false, data: r.data };
  }
  const failed = findFailedLine(r.data);
  if (failed) {
    fail(`Cart line Action=${failed.action}`);
    dim(JSON.stringify(failed.item).slice(0, 500));
    return { ok: false, data: r.data };
  }
  const saleId = extractSaleId(r.data);
  ok(`Checkout accepted${saleId ? ` — SaleId=${saleId}` : ""} (${test ? "Test:true" : "LIVE"})`);
  return { ok: true, saleId, data: r.data };
}

async function stageClientServices(staffToken, label) {
  header(label);
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
    fail(JSON.stringify(r.data).slice(0, 400));
    return [];
  }
  const list = pickClientServicesArray(r.data);
  const matching = list.filter((raw) => {
    const row = /** @type {Record<string, unknown>} */ (raw);
    const pid = row.ProductId ?? row.productId ?? row.ServiceId ?? row.serviceId;
    if (typeof pid === "number") return pid === SERVICE_ID;
    if (typeof pid === "string") return pid.trim() === String(SERVICE_ID);
    return false;
  });
  if (!matching.length) {
    warn(`No ClientService with ProductId=${SERVICE_ID} (normal if last cart was Test:true)`);
  } else {
    ok(`${matching.length} Guest Pass ClientService row(s) on clientId=${CLIENT_ID}`);
    for (const raw of matching) {
      const o = /** @type {Record<string, unknown>} */ (raw);
      dim(
        [
          ["ClientServiceId", o.Id ?? o.ID],
          ["ProductId", o.ProductId],
          ["Name", o.Name],
          ["Remaining", o.Remaining],
          ["ExpirationDate", o.ExpirationDate],
          ["PaymentDate", o.PaymentDate ?? o.SaleDate],
        ]
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
          .join("  "),
      );
    }
  }
  return matching;
}

(async () => {
  console.log(`${C_BOLD}Guest Pass smoke test (Bring-a-Friend)${C_RESET}`);
  console.log(`  service-id = ${SERVICE_ID}`);
  console.log(`  client-id  = ${CLIENT_ID ?? "(missing)"}`);
  console.log(
    `  mode       = ${DRY ? "dry (Test:true)" : CONFIRM_LIVE ? "LIVE (Test:false)" : "lookup-only"}`,
  );

  if (!API_KEY) {
    fail("MINDBODY_API_KEY missing");
    process.exit(2);
  }
  if (!CLIENT_ID) {
    fail("Provide --client-id=<Mindbody ClientId>");
    process.exit(2);
  }

  const staffToken = await issueStaffToken();
  ok("Staff token issued");

  const serviceRow = await stageServiceLookup(staffToken);
  if (!serviceRow) process.exit(1);

  const priceRaw = serviceRow.Price ?? serviceRow.OnlinePrice;
  const priceUsd = typeof priceRaw === "number" && Number.isFinite(priceRaw) ? priceRaw : 0;
  ok(`Catalog price = $${priceUsd} → Comp Amount will be $${priceUsd}`);

  if (!DRY && !CONFIRM_LIVE) {
    console.log("");
    dim("Lookup OK. Next:");
    dim(`  node scripts/guest-pass-smoke-test.mjs --client-id=${CLIENT_ID} --dry`);
    dim(`  node scripts/guest-pass-smoke-test.mjs --client-id=${CLIENT_ID} --confirm-live`);
    process.exit(0);
  }

  let passed = true;

  if (DRY) {
    const dry = await stageCheckout({
      test: true,
      staffToken,
      compAmountUsd: priceUsd,
      label: "STAGE 2 — CheckoutShoppingCart Test:true (Comp $0)",
    });
    if (!dry.ok) passed = false;
    else ok("Option A ($0 + Comp) accepted by Mindbody in Test mode");
  }

  if (CONFIRM_LIVE) {
    await stageClientServices(staffToken, "STAGE 3-pre — clientservices BEFORE live comp sale");
    const live = await stageCheckout({
      test: false,
      staffToken,
      compAmountUsd: priceUsd,
      label: "STAGE 3 — CheckoutShoppingCart Test:false LIVE (Comp $0)",
    });
    if (!live.ok) {
      passed = false;
    } else {
      const rows = await stageClientServices(staffToken, "STAGE 4 — clientservices AFTER live comp sale");
      const fresh = rows.filter((raw) => {
        const rem = /** @type {Record<string, unknown>} */ (raw).Remaining;
        return rem === 1 || rem === "1";
      });
      if (fresh.length) ok(`Guest Pass credit issued — ${fresh.length} row(s) with Remaining=1`);
      else warn("Live sale succeeded but no Remaining=1 row found — inspect Mindbody manually");
    }
  }

  console.log("");
  if (passed) {
    ok("Guest Pass smoke test PASSED");
    process.exit(0);
  }
  fail("Guest Pass smoke test FAILED");
  process.exit(1);
})().catch((err) => {
  console.error(`${C_RED}Error:${C_RESET} ${err?.message ?? err}`);
  process.exit(1);
});
