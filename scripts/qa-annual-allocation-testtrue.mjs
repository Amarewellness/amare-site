/**
 * Model F annual allocation Test:true probes for all three SKUs.
 * Run: npm run test:annual-allocation-testtrue
 *
 * QA client 100002753 only. No live writes.
 */
import "./load-env.mjs";
import https from "node:https";
import { buildAnnualAllocationPayNote, getAnnualSkuDefinition } from "../netlify/functions/annual-membership-lib.mjs";

const API_VERSION = "6";
const HOST = (process.env.MINDBODY_API_HOST || "api.mindbodyonline.com").trim();
const API_KEY = (process.env.MINDBODY_API_KEY || "").trim();
const SITE_ID = (process.env.MINDBODY_SITE_ID || "-99").trim();
const STAFF_USER = (process.env.MINDBODY_STAFF_USERNAME || "").trim();
const STAFF_PASS = process.env.MINDBODY_STAFF_PASSWORD || "";
const PAY_METHOD_ID = parseInt((process.env.MINDBODY_STRIPE_PAYMENT_METHOD_ID || "17").trim(), 10);
const PAY_METHOD_NAME = (process.env.MINDBODY_STRIPE_PAYMENT_METHOD_NAME || "Stripe").trim();
const SALE_LOCATION_ID = parseInt((process.env.MINDBODY_SALE_LOCATION_ID || "1").trim(), 10);
const CLIENT_ID = 100002753;

/** @type {Array<"annual_monthly_5"|"annual_monthly_8"|"annual_monthly_unlimited">} */
const SKUS = ["annual_monthly_5", "annual_monthly_8", "annual_monthly_unlimited"];

let failed = 0;

function check(name, ok, detail) {
  if (ok) console.log(`PASS — ${name}`);
  else {
    failed += 1;
    console.log(`FAIL — ${name}${detail ? `\n  ${detail}` : ""}`);
  }
}

async function requestJson({ method, path, bearer, bodyJson }) {
  const body = bodyJson != null ? Buffer.from(JSON.stringify(bodyJson)) : null;
  return new Promise((resolve, reject) => {
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
          ...(body ? { "Content-Type": "application/json", "Content-Length": body.length } : {}),
          ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let data;
          try {
            data = JSON.parse(raw);
          } catch {
            data = { _raw: raw.slice(0, 800) };
          }
          resolve({ status: res.statusCode ?? 0, ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300, data });
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
    path: `/public/v${API_VERSION}/usertoken/issue`,
    bodyJson: { Username: STAFF_USER, Password: STAFF_PASS },
  });
  return r.data?.AccessToken ?? null;
}

function buildCart(def, payNote) {
  const listUsd = def.listAmountCents / 100;
  const discUsd = def.discountAmountCents / 100;
  const netUsd = def.netAmountCents / 100;
  return {
    ClientId: String(CLIENT_ID),
    LocationId: SALE_LOCATION_ID,
    Test: true,
    SendEmail: false,
    Items: [
      {
        Item: {
          Type: "Service",
          Metadata: { Id: def.mindbodyProductId, ServiceId: def.mindbodyProductId },
        },
        Quantity: 1,
        DiscountAmount: discUsd,
      },
    ],
    Payments: [
      {
        Type: "Custom",
        Metadata: {
          id: PAY_METHOD_ID,
          Id: PAY_METHOD_ID,
          PaymentMethodId: PAY_METHOD_ID,
          Name: PAY_METHOD_NAME,
          Amount: netUsd,
          AmountPaid: netUsd,
          Notes: payNote,
          PayNotes: payNote,
        },
      },
    ],
    InStore: false,
  };
}

const token = await issueStaffToken();
if (!token) {
  console.error("FAIL — could not issue staff token");
  process.exit(2);
}

/** @type {Record<string, { taxRate: number; pass: boolean; totals?: Record<string, unknown> }>} */
const report = {};

for (const sku of SKUS) {
  const def = getAnnualSkuDefinition(sku);
  const svc = await requestJson({
    method: "GET",
    path: `/public/v${API_VERSION}/sale/services?ServiceIds=${def.mindbodyProductId}`,
    bearer: token,
  });
  const row = svc.data?.Services?.[0];
  const taxRate = Number(row?.TaxRate ?? row?.taxRate ?? NaN);
  report[sku] = { taxRate, pass: false };
  check(`tax ${def.mindbodyProductId} (${sku})`, taxRate === 0, `TaxRate=${taxRate}`);
  if (taxRate !== 0) {
    console.log(`STOP — SKU ${sku} tax > 0; skipping Test:true`);
    continue;
  }

  const payNote = buildAnnualAllocationPayNote({
    annualMembershipId: "phase2-probe",
    stripeInvoiceId: "in_phase2_probe",
    periodIndex: 0,
    sku,
    netAmountCents: def.netAmountCents,
  });
  const cart = buildCart(def, payNote);
  const checkout = await requestJson({
    method: "POST",
    path: `/public/v${API_VERSION}/sale/checkoutshoppingcart`,
    bearer: token,
    bodyJson: cart,
  });
  const sc = checkout.data?.ShoppingCart ?? checkout.data?.shoppingCart ?? checkout.data;
  const sub = Number(sc?.SubTotal ?? sc?.subTotal ?? NaN);
  const disc = Number(sc?.DiscountTotal ?? sc?.discountTotal ?? NaN);
  const tax = Number(sc?.TaxTotal ?? sc?.taxTotal ?? NaN);
  const grand = Number(sc?.GrandTotal ?? sc?.grandTotal ?? NaN);
  report[sku].totals = { sub, disc, tax, grand };
  const pass =
    checkout.ok &&
    Math.abs(sub - def.listAmountCents / 100) < 0.01 &&
    Math.abs(disc - def.discountAmountCents / 100) < 0.01 &&
    tax === 0 &&
    Math.abs(grand - def.netAmountCents / 100) < 0.01;
  report[sku].pass = pass;
  check(
    `Test:true ${sku} / ${def.mindbodyProductId}`,
    pass,
    JSON.stringify({ status: checkout.status, totals: report[sku].totals }),
  );
}

console.log("\n--- SUMMARY ---");
console.log(JSON.stringify(report, null, 2));

if (failed) {
  console.error(`\n${failed} Test:true probe(s) failed`);
  process.exit(1);
}

console.log("\nAnnual allocation Test:true probes passed");
