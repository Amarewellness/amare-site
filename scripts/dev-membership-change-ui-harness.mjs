/**
 * Local UI harness for /admin/monthly-memberships against Stripe TEST MODE.
 *
 * Serves dist/, routes /api/admin/monthly-memberships to the real handler + service with an
 * in-memory subscription store and ledger, fake Mindbody reads, and a background loop that plays
 * the webhook's Mindbody sync for paid change invoices. Creates one Monthly 5 test customer on a
 * Stripe test clock and deletes the clock on exit.
 *
 * Run: npm run build && node scripts/dev-membership-change-ui-harness.mjs
 */
process.env.NETLIFY = "";
process.env.STRIPE_SUBSCRIPTION_STORE_LOCAL_MEMORY = "1";
process.env.MEMBERSHIP_CHANGE_ADMIN_ENABLED = "1";
process.env.MEMBERSHIP_CHANGE_DEFERRED_ENABLED = "1";

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Stripe from "stripe";
import "./load-env.mjs";
import { getCatalogItem } from "../netlify/functions/stripe-catalog-lib.mjs";
import { openSubscriptionStore } from "../netlify/functions/stripe-subscription-store.mjs";
import { executeMonthlyRenewalSync } from "../netlify/functions/stripe-monthly-period-sync.mjs";
import { createMemoryMembershipChangeStore } from "../netlify/functions/membership-change-store.mjs";
import { createMembershipChangeService } from "../netlify/functions/membership-change-service.mjs";
import { billingAdminEntry } from "../netlify/functions/membership-change-auth.mjs";
import { createMembershipChangeAdminHandler } from "../netlify/functions/membership-change-admin.mjs";

const key = (process.env.STRIPE_SECRET_KEY || "").trim();
if (!key.startsWith("sk_test_")) {
  console.error("Refusing to run: needs a Stripe TEST key (sk_test_…).");
  process.exit(2);
}
const PORT = Number(process.env.HARNESS_PORT || 8899);
const ADMIN_TOKEN = "ui-harness-admin-token-0123456789";
const BILLING_KEY = "ui-harness-billing-key";
process.env.ADMIN_DEBUG_TOKEN = ADMIN_TOKEN;
process.env.MEMBERSHIP_BILLING_ADMINS = billingAdminEntry("owner1", "owner", BILLING_KEY);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const stripe = new Stripe(key, { apiVersion: "2025-08-27.basil" });
const subStore = openSubscriptionStore();
const ledger = createMemoryMembershipChangeStore();
const M5 = getCatalogItem("monthly_5");
const RECORD_ID = "sub_amare_UIHARNESS00000001";
const mbRows = [{ Id: 1, ProductId: M5.mindbodyServiceId, Remaining: 2, PaymentDate: new Date().toISOString(), Current: true }];

const clock = await stripe.testHelpers.testClocks.create({ frozen_time: Math.floor(Date.now() / 1000), name: "amare-mc-ui-harness" });
const customer = await stripe.customers.create({ email: "ui-harness@example.com", name: "UI Harness Member", test_clock: clock.id });
const pm = await stripe.paymentMethods.attach("pm_card_visa", { customer: customer.id });
const product = await stripe.products.create({ name: "QA checkout Monthly 5", metadata: { qa: "ui-harness" } });
const sub = await stripe.subscriptions.create({
  customer: customer.id,
  items: [{ price_data: { currency: "usd", product: product.id, unit_amount: M5.amountCents, recurring: { interval: "month" } } }],
  default_payment_method: pm.id,
  metadata: { localSku: "monthly_5", subscriptionId: RECORD_ID, membershipConsentId: "ui_consent" },
});
await stripe.products.update(product.id, { active: false });
await subStore.put({
  id: RECORD_ID,
  stripeSubscriptionId: sub.id,
  stripeCustomerId: customer.id,
  stripeCheckoutSessionId: "cs_ui_harness",
  localSku: "monthly_5",
  displayName: M5.displayName,
  monthlyAmountCents: M5.amountCents,
  currency: "usd",
  mindbodyClientId: 900001234,
  mindbodyServiceId: M5.mindbodyServiceId,
  mindbodyContractProductId: M5.mindbodyContractProductId,
  commitmentStartDate: "2026-10-01T00:00:00.000Z",
  commitmentEndDate: "2027-01-01T00:00:00.000Z",
  membershipConsentId: "ui_consent",
  agreementTextHash: "ui_hash",
  status: "active",
  invoices: [],
  customerEmail: "ui-harness@example.com",
  customerName: "UI Harness Member",
});

const service = createMembershipChangeService({
  stripe,
  subStore,
  ledger,
  io: {
    clientServices: async () => mbRows,
    futureVisits: async () => [],
    consentContractProductId: async () => String(M5.mindbodyContractProductId),
  },
  previewSecret: "ui-harness-preview-secret-0123456789",
  flags: { deferredEnabled: true },
  syncWaitMs: 0,
});
const handler = createMembershipChangeAdminHandler({ service });

/** Play the webhook: sync paid change invoices to fake Mindbody a few seconds after payment. */
setInterval(async () => {
  const ops = await ledger.listOperations(RECORD_ID, 10);
  for (const op of ops.filter((o) => o.status === "syncing" && o.stripeInvoiceId)) {
    const record = await subStore.get(RECORD_ID);
    if ((record.invoices || []).some((e) => e.invoiceId === op.stripeInvoiceId)) continue;
    const invoice = await stripe.invoices.retrieve(op.stripeInvoiceId);
    await executeMonthlyRenewalSync({
      subStore,
      record,
      invoice,
      existingEntry: null,
      item: getCatalogItem(record.localSku),
      retrieveInvoice: async () => invoice,
      syncFn: async () => ({ ok: true, mindbodySaleId: `UI_${invoice.id.slice(-6)}`, mindbodyClientServiceId: "UI_CS" }),
      claimAlreadyAcquired: true,
      lostClaim: false,
    });
    mbRows.push({ Id: 2, ProductId: getCatalogItem(record.localSku).mindbodyServiceId, Remaining: 99999, PaymentDate: new Date().toISOString(), Current: true });
    console.log(`harness: simulated webhook Mindbody sync for ${invoice.id}`);
  }
}, 4000);

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2" };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  if (url.pathname === "/api/admin/monthly-memberships") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const out = await handler({
      httpMethod: req.method,
      headers: req.headers,
      queryStringParameters: Object.fromEntries(url.searchParams),
      body: Buffer.concat(chunks).toString("utf8"),
    });
    res.writeHead(out.statusCode, out.headers || {});
    res.end(out.body || "");
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "not_in_harness" }));
    return;
  }
  let file = path.join(dist, decodeURIComponent(url.pathname));
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  if (!fs.existsSync(file) && fs.existsSync(`${file}.html`)) file = `${file}.html`;
  if (!file.startsWith(dist) || !fs.existsSync(file)) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});

async function cleanup() {
  await stripe.testHelpers.testClocks.del(clock.id).catch(() => {});
  console.log("harness: test clock deleted");
  process.exit(0);
}
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
setTimeout(cleanup, 30 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`harness ready: http://localhost:${PORT}/admin/monthly-memberships`);
  console.log(`admin token: ${ADMIN_TOKEN} | billing: owner1 / ${BILLING_KEY} | record: ${RECORD_ID}`);
});
