/**
 * Complete FINAL LOCAL E2E steps 9–11 for an existing annual_monthly_8 purchase.
 * Usage: node scripts/qa-final-local-e2e-complete.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Stripe from "stripe";

import { loadLocalEnv } from "./load-env.mjs";
import { annualMembershipQuery } from "../netlify/functions/annual-membership-store.mjs";
import { runAnnualMembershipReconciliation } from "../netlify/functions/annual-membership-reconciler.mjs";
import { handleAnnualInvoicePaid } from "../netlify/functions/annual-membership-webhook-lib.mjs";

loadLocalEnv();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INVOICE_ID = process.env.E2E_INVOICE_ID || "in_1UAwZ5AjsONx3mgIJnnQSMd4";
const SUB_ID = process.env.E2E_SUBSCRIPTION_ID || "sub_1UAwZ7AjsONx3mgIBbg2YnF8";
const QA_CLIENT = 100002839;
const SKU = "annual_monthly_8";

const dbFile = path.join(root, ".cursor-local-db-url.txt");

async function ensureDb() {
  if (fs.existsSync(dbFile)) {
    const url = fs.readFileSync(dbFile, "utf8").trim();
    process.env.NETLIFY_DB_URL = url;
    try {
      const { default: pg } = await import("pg");
      const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
      await c.connect();
      await c.query("SELECT 1");
      await c.end();
      return url;
    } catch {
      /* reconnect below */
    }
  }
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [path.join(root, "node_modules/netlify-cli/bin/run.js"), "database", "connect"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const url = await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("db_proxy_timeout")), 90_000);
    child.stdout?.on("data", (chunk) => {
      buf += String(chunk);
      const match = buf.match(/postgres:\/\/\S+/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0].replace(/[.,;]+$/, ""));
      }
    });
    child.once("error", reject);
  });
  process.env.NETLIFY_DB_URL = url;
  fs.writeFileSync(dbFile, `${url}\n`, "utf8");
  return url;
}

await ensureDb();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2025-08-27.basil" });
const invoice = await stripe.invoices.retrieve(INVOICE_ID, { expand: ["subscription"] });
const sub = await stripe.subscriptions.retrieve(SUB_ID);

const term = await annualMembershipQuery(
  `SELECT m.*, (
     SELECT COUNT(*)::int FROM annual_membership_periods p WHERE p.annual_membership_id = m.id
   ) AS period_count
   FROM annual_memberships m WHERE m.stripe_invoice_id = $1`,
  [INVOICE_ID],
);
const periods = await annualMembershipQuery(
  `SELECT period_index, status, mindbody_sale_id, mindbody_client_service_id
     FROM annual_membership_periods WHERE annual_membership_id = $1 ORDER BY period_index`,
  [term.rows[0].id],
);

const subRecord = {
  id: "sub_amare_e2e_replay",
  localSku: SKU,
  mindbodyClientId: QA_CLIENT,
  stripeSubscriptionId: SUB_ID,
  stripeCustomerId: typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id,
};

const r1 = await handleAnnualInvoicePaid({
  invoice,
  subscriptionRecord: subRecord,
  skipMindbodyIssue: false,
  mindbodyTest: false,
});
await new Promise((r) => setTimeout(r, 2000));
const r2 = await handleAnnualInvoicePaid({
  invoice,
  subscriptionRecord: subRecord,
  skipMindbodyIssue: false,
  mindbodyTest: false,
});

const rec1 = await runAnnualMembershipReconciliation();
const rec2 = await runAnnualMembershipReconciliation();

const canceled =
  sub.status !== "canceled" ? await stripe.subscriptions.cancel(SUB_ID) : sub;

console.log(
  JSON.stringify(
    {
      annualMembershipId: term.rows[0].id,
      sku: term.rows[0].sku,
      annualAmountCents: term.rows[0].annual_amount_cents,
      mindbodyClientId: term.rows[0].mindbody_client_id,
      periodCount: term.rows[0].period_count,
      period0: periods.rows[0],
      periods1to11Pending: periods.rows.slice(1).every((p) => p.status === "pending"),
      idempotency: { r1: r1?.outcome ?? r1, r2: r2?.outcome ?? r2 },
      reconciler: {
        rec1,
        rec2,
        mindbodyWrites:
          (rec1.issued ?? 0) + (rec1.failed ?? 0) + (rec2.issued ?? 0) + (rec2.failed ?? 0),
      },
      subscriptionCanceled: canceled.status,
    },
    null,
    2,
  ),
);
