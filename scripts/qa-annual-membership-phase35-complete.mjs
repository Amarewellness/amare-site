/**
 * Complete Phase 3.5: issue Period 0 live Mindbody after DB term created with skip mode,
 * prove idempotency, reconciler no-op, cancel test subscription.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Stripe from "stripe";

import { loadLocalEnv } from "./load-env.mjs";
import { handleAnnualInvoicePaid } from "../netlify/functions/annual-membership-webhook-lib.mjs";
import { annualMembershipQuery } from "../netlify/functions/annual-membership-store.mjs";
import { runAnnualMembershipReconciliation } from "../netlify/functions/annual-membership-reconciler.mjs";

loadLocalEnv();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INVOICE_ID = "in_1UAuz3AjsONx3mgIhk3DleEs";
const EVENT_ID = "evt_1UAuz6AjsONx3mgISUX9hRWi";
const SUBSCRIPTION_ID = "sub_1UAuz5AjsONx3mgIVD0dsktG";
const OUR_SUB_ID = "sub_amare_DTX62MECEPZPCJ28";
const QA_CLIENT_ID = 100002839;
const PRODUCT_ID = 100133;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function mbToken() {
  const res = await fetch(`https://${process.env.MINDBODY_API_HOST || "api.mindbodyonline.com"}/public/v6/usertoken/issue`, {
    method: "POST",
    headers: {
      "API-Key": (process.env.MINDBODY_API_KEY || "").trim(),
      SiteId: (process.env.MINDBODY_SITE_ID || "-99").trim(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      Username: (process.env.MINDBODY_STAFF_USERNAME || "").trim(),
      Password: process.env.MINDBODY_STAFF_PASSWORD || "",
    }),
  });
  const j = await res.json();
  if (!j.AccessToken) throw new Error("mindbody_token_failed");
  return j.AccessToken;
}

async function mbSnapshot(token) {
  const HOST = (process.env.MINDBODY_API_HOST || "api.mindbodyonline.com").trim();
  const res = await fetch(`https://${HOST}/public/v6/client/clientservices?request.clientId=${QA_CLIENT_ID}&request.limit=200`, {
    headers: {
      "API-Key": (process.env.MINDBODY_API_KEY || "").trim(),
      SiteId: (process.env.MINDBODY_SITE_ID || "-99").trim(),
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  const cs = await res.json();
  return (cs.ClientServices || cs.clientServices || [])
    .filter((s) => Number(s.ProductId ?? s.productId) === PRODUCT_ID)
    .map((s) => ({
      Id: s.Id ?? s.id,
      Remaining: s.Remaining ?? s.remaining,
      Count: s.Count ?? s.count,
      ActiveDate: s.ActiveDate ?? s.activeDate,
      ExpirationDate: s.ExpirationDate ?? s.expirationDate,
    }));
}

async function fetchSale(token, saleId) {
  const HOST = (process.env.MINDBODY_API_HOST || "api.mindbodyonline.com").trim();
  const res = await fetch(`https://${HOST}/public/v6/sale/sales?request.saleId=${saleId}`, {
    headers: {
      "API-Key": (process.env.MINDBODY_API_KEY || "").trim(),
      SiteId: (process.env.MINDBODY_SITE_ID || "-99").trim(),
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  const j = await res.json();
  return (j.Sales || j.sales || [])[0] ?? null;
}

async function main() {
  delete process.env.ANNUAL_WEBHOOK_SKIP_MINDDBODY_ISSUE;
  const dbUrl =
    (process.env.NETLIFY_DB_URL || "").trim() ||
    fs.readFileSync(path.join(root, ".cursor-local-db-url.txt"), "utf8").trim();
  process.env.NETLIFY_DB_URL = dbUrl;

  const sk = (process.env.STRIPE_SECRET_KEY || "").trim();
  const stripe = new Stripe(sk, { apiVersion: "2025-08-27.basil" });
  const invoice = await stripe.invoices.retrieve(INVOICE_ID, { expand: ["subscription"] });
  const subMeta =
    typeof invoice.subscription === "object" && invoice.subscription?.metadata
      ? invoice.subscription.metadata
      : (await stripe.subscriptions.retrieve(SUBSCRIPTION_ID)).metadata;

  /** @type {Record<string, unknown>} */
  const subscriptionRecord = {
    id: OUR_SUB_ID,
    localSku: subMeta.localSku || "annual_monthly_5",
    mindbodyClientId: Number(subMeta.mindbodyClientId || QA_CLIENT_ID),
    stripeSubscriptionId: SUBSCRIPTION_ID,
    stripeCustomerId: typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id,
  };

  const mbTokenVal = await mbToken();
  const mbBefore = await mbSnapshot(mbTokenVal);

  const live1 = await handleAnnualInvoicePaid({
    invoice,
    subscriptionRecord,
    skipMindbodyIssue: false,
    mindbodyTest: false,
  });
  console.log(JSON.stringify({ event: "live_issue_pass1", outcome: live1 }, null, 2));
  await sleep(3000);

  const term1 = await annualMembershipQuery(
    `SELECT p.* FROM annual_membership_periods p
      JOIN annual_memberships m ON m.id = p.annual_membership_id
     WHERE m.stripe_invoice_id = $1 AND p.period_index = 0`,
    [INVOICE_ID],
  );
  const mbAfter1 = await mbSnapshot(mbTokenVal);
  const newCs1 = mbAfter1.filter((s) => !mbBefore.some((b) => Number(b.Id) === Number(s.Id)));

  const live2 = await handleAnnualInvoicePaid({
    invoice,
    subscriptionRecord,
    skipMindbodyIssue: false,
    mindbodyTest: false,
  });
  const mbAfter2 = await mbSnapshot(mbTokenVal);
  const newCs2 = mbAfter2.filter((s) => !mbAfter1.some((b) => Number(b.Id) === Number(s.Id)));

  await stripe.events.retrieve(EVENT_ID);

  const rec1 = await runAnnualMembershipReconciliation();
  const rec2 = await runAnnualMembershipReconciliation();

  await stripe.subscriptions.cancel(SUBSCRIPTION_ID);
  try {
    await stripe.subscriptions.cancel("sub_1UAuyIAjsONx3mgIBHgFOg0l");
  } catch {
    /* debug session may already be canceled */
  }

  const termAfter = await annualMembershipQuery(
    `SELECT m.status, p.status AS p0_status, p.mindbody_sale_id, p.mindbody_client_service_id,
            p.pre_issue_client_service_ids, p.claim_started_at, p.issued_at
       FROM annual_memberships m
       JOIN annual_membership_periods p ON p.annual_membership_id = m.id AND p.period_index = 0
      WHERE m.stripe_invoice_id = $1`,
    [INVOICE_ID],
  );

  let saleDetail = null;
  const saleId = termAfter.rows[0]?.mindbody_sale_id;
  if (saleId) {
    const sale = await fetchSale(mbTokenVal, saleId);
    const items = sale?.PurchasedItems || sale?.purchasedItems || [];
    const first = items[0] || {};
    saleDetail = {
      productId: first.Id ?? first.ProductId,
      regularPrice: first.UnitPrice ?? first.Price,
      discount: first.DiscountAmount,
      net: first.TotalAmount ?? first.TotalAmount,
      payments: (sale?.Payments || sale?.payments || []).map((p) => ({
        method: p.Method ?? p.Type,
        amount: p.Amount,
      })),
    };
  }

  console.log(
    JSON.stringify(
      {
        event: "phase35_complete_summary",
        period0: termAfter.rows[0],
        saleDetail,
        newClientServicesPass1: newCs1,
        idempotencyPass2NewServices: newCs2.length,
        live2Outcome: live2,
        reconciler: { first: rec1, second: rec2 },
        subscriptionCanceled: SUBSCRIPTION_ID,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(JSON.stringify({ event: "phase35_complete_failed", error: String(err?.message ?? err), stack: err?.stack?.split("\n").slice(0, 4) }));
  process.exitCode = 1;
});
