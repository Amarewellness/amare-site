/**
 * FINAL LOCAL E2E QA — production-shaped build + SKU-aware agreement + one annual sandbox purchase.
 *
 *   npm run build   (Step 1)
 *   Agreement sanity for all 6 SKUs (Step 2)
 *   stripe listen + unified dev (Step 3)
 *   ONE annual_monthly_8 Stripe TEST checkout (Steps 4–11)
 *   Full regression suite (Step 12)
 *
 * NO deploy. Stripe TEST only. Mindbody live allocation on QA client 100002839.
 *
 * Usage: node scripts/qa-final-local-e2e.mjs
 */

import { spawn, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Stripe from "stripe";

import { loadLocalEnv } from "./load-env.mjs";
import {
  loadMbContractTermsConfig,
  resolveAnnualContractEntryByLocalSku,
} from "../netlify/functions/load-mb-contract-terms.mjs";
import { annualMembershipQuery } from "../netlify/functions/annual-membership-store.mjs";
import { runAnnualMembershipReconciliation } from "../netlify/functions/annual-membership-reconciler.mjs";
import { handleAnnualInvoicePaid } from "../netlify/functions/annual-membership-webhook-lib.mjs";

loadLocalEnv();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ORIGIN = (process.env.QA_ORIGIN || "http://127.0.0.1:4321").replace(/\/$/, "");
const WEBHOOK_PATH = "/api/stripe/webhook";
const WEBHOOK_URL = `${ORIGIN}${WEBHOOK_PATH}`;

const QA_CLIENT_ID = 100002839;
const QA_EMAIL = "snir26@pic-smart.com";
const QA_PHONE = "(786) 503-4576";
const QA_FIRST = "Snir";
const QA_LAST = "QA Annual";
const SKU = "annual_monthly_8";
const SERVICE_ID = 100134;
const PRODUCT_ID = 100134;
const ANNUAL_CONTRACT_VERSION = "2026-09-01-annual-v1";
const EXPECTED_ANNUAL_CENTS = 182580;

/** @type {Record<string, unknown>} */
const report = {
  phase: "final-local-e2e",
  startedAt: new Date().toISOString(),
  sku: SKU,
};

/** @type {import("node:child_process").ChildProcess[]} */
const children = [];

function log(event, data = {}) {
  const row = { event, at: new Date().toISOString(), ...data };
  console.log(JSON.stringify(row));
  return row;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForHttp(url, opts = {}) {
  const timeout = opts.timeout ?? 120_000;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(url, { method: opts.method || "GET", signal: AbortSignal.timeout(5000) });
      if (opts.acceptStatus?.includes(res.status) || res.ok || res.status === 204) return res;
    } catch {
      /* retry */
    }
    await sleep(1500);
  }
  throw new Error(`wait_for_http_timeout:${url}`);
}

function readText(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function parseJsonScript(html, id) {
  const re = new RegExp(`<script[^>]+id="${id}"[^>]*>([\\s\\S]*?)</script>`, "i");
  const m = html.match(re);
  if (!m) return null;
  try {
    return JSON.parse(m[1].trim());
  } catch {
    return null;
  }
}

function step1RebuildDist() {
  log("step1_build_start");
  execSync("npm run build", { cwd: root, stdio: "inherit" });
  const pricingHtml = readText("dist/pricing.html");
  const recurring = parseJsonScript(pricingHtml, "mb-stripe-recurring-config");
  const terms = parseJsonScript(pricingHtml, "mb-contract-terms-config");
  const pricingJs = readText("dist/js/pricing-api.js");

  const checks = {
    distExists: fs.existsSync(path.join(root, "dist/pricing.html")),
    annualUiEnabled: recurring?.annualUiEnabled === true,
    defaultCadenceMonthly: pricingJs.includes('membershipPricingCadence = "monthly"'),
    cadenceToggleVisible: pricingHtml.includes('id="mb-pricing-cadence-toggle"'),
    annualByLocalSkuEmbedded: Boolean(terms?.annualByLocalSku?.[SKU]),
    annualContractVersionEmbedded:
      terms?.annualByLocalSku?.[SKU]?.contractVersion === ANNUAL_CONTRACT_VERSION,
  };
  report.distRebuild = checks;
  const pass = Object.values(checks).every(Boolean);
  if (!pass) throw new Error(`dist_rebuild_verify_failed:${JSON.stringify(checks)}`);
  log("step1_build_pass", checks);
  return { recurring, terms };
}

function step2AgreementSanity(terms) {
  const pricingJs = readText("src/js/pricing-api.js");
  const ANNUAL_REQUIRED = [
    "prepaid annual membership",
    "automatically renew once per year",
    "contacting the studio before your renewal date",
    "non-refundable and are not prorated",
  ];
  const ANNUAL_FORBIDDEN = [
    "monthly membership charged automatically each billing cycle",
    "3\u2011month commitment",
    "50% of one month",
  ];
  const MONTHLY_REQUIRED = {
    monthly_5: { serviceId: 100129, productKey: "101", phrases: ["minimum commitment of"] },
    monthly_8: {
      serviceId: 100130,
      productKey: "102",
      phrases: ["monthly membership charged automatically each billing cycle", "3\u2011month commitment"],
    },
    monthly_unlimited: { serviceId: 100056, productKey: "100", phrases: ["12 hours"] },
  };
  const ANNUAL_SKUS = {
    annual_monthly_5: { serviceId: 100133, label: "5 Classes Annual Membership" },
    annual_monthly_8: { serviceId: 100134, label: "8 Classes Annual Membership" },
    annual_monthly_unlimited: { serviceId: 100135, label: "Unlimited Annual Membership" },
  };

  /** @type {Record<string, boolean>} */
  const skuResults = {};

  for (const [sku, meta] of Object.entries(MONTHLY_REQUIRED)) {
    const manual = terms.byMindbodyProductId?.[meta.productKey];
    const html = String(manual?.termsHtml || "");
    skuResults[sku] =
      meta.phrases.every((p) => html.includes(p)) &&
      !html.includes("prepaid annual membership") &&
      pricingJs.includes("membershipSkuCadence") &&
      pricingJs.includes("resolveRecurringMembershipTerms(row, localSku)");
  }

  for (const [sku, meta] of Object.entries(ANNUAL_SKUS)) {
    const entry = terms.annualByLocalSku?.[sku];
    const html = String(entry?.termsHtml || "");
    skuResults[sku] =
      entry?.title === "Annual Membership Agreement" &&
      entry?.marketingPlanName === meta.label &&
      ANNUAL_REQUIRED.every((p) => html.includes(p)) &&
      ANNUAL_FORBIDDEN.every((p) => !html.includes(p));
  }

  const staleCadence =
    pricingJs.includes("membershipTermsMatchCheckoutSku") &&
    pricingJs.includes("buildMembershipDialogLeadHtml") &&
    !pricingJs.match(/resolveRecurringMembershipTerms\(row\)\s*[;)]/) &&
    pricingJs.includes("lookupStripeRecurringSku(svcId)?.localSku");

  report.agreementSanity = { skuResults, staleCadenceLogic: staleCadence };
  const allSkusPass = Object.values(skuResults).every(Boolean);
  if (!allSkusPass || !staleCadence) {
    throw new Error(`agreement_sanity_failed:${JSON.stringify(report.agreementSanity)}`);
  }
  log("step2_agreement_sanity_pass", report.agreementSanity);
}

function loadLocalDbUrl() {
  const file = path.join(root, ".cursor-local-db-url.txt");
  if (fs.existsSync(file)) {
    const url = fs.readFileSync(file, "utf8").trim();
    if (url) {
      process.env.NETLIFY_DB_URL = url;
      return url;
    }
  }
  return (
    (process.env.NETLIFY_DB_URL || "").trim() ||
    (process.env.NETLIFY_DATABASE_URL || "").trim() ||
    (process.env.DATABASE_URL || "").trim() ||
    ""
  );
}

async function probeDbUrl(url) {
  try {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
    await client.connect();
    await client.query("SELECT 1");
    await client.end();
    return true;
  } catch {
    return false;
  }
}

async function spawnLocalDbProxy() {
  const child = spawn(process.execPath, [path.join(root, "node_modules/netlify-cli/bin/run.js"), "database", "connect"], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  children.push(child);
  let stderrBuf = "";
  const url = await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`local_db_proxy_timeout:${stderrBuf.slice(0, 240)}`)), 90_000);
    const onData = (chunk) => {
      buf += String(chunk);
      const match = buf.match(/postgres:\/\/\S+/);
      if (match) {
        clearTimeout(timer);
        child.stdout?.off("data", onData);
        child.stderr?.off("data", onStderr);
        resolve(match[0].replace(/[.,;]+$/, ""));
      }
    };
    const onStderr = (chunk) => {
      stderrBuf += String(chunk);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onStderr);
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`local_db_proxy_exited:${code}`));
    });
  });
  process.env.NETLIFY_DB_URL = url;
  fs.writeFileSync(path.join(root, ".cursor-local-db-url.txt"), `${url}\n`, "utf8");
  return url;
}

async function ensureLocalDb() {
  let url = loadLocalDbUrl();
  if (url && (await probeDbUrl(url))) return url;
  url = await spawnLocalDbProxy();
  if (await probeDbUrl(url)) return url;
  throw new Error("local_db_unavailable");
}

async function ensureAnnualMigration() {
  const sqlPath = path.join(root, "netlify/database/migrations/20260901183000_annual_memberships.sql");
  const sql = fs.readFileSync(sqlPath, "utf8");
  const check = await annualMembershipQuery("SELECT to_regclass('public.annual_memberships') AS table_name", []);
  if (check.rows[0]?.table_name) return { already: true };
  const statements = sql
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("--"));
  for (const stmt of statements) {
    await annualMembershipQuery(`${stmt};`, []);
  }
  return { applied: true };
}

function stripeListenCommand() {
  const sk = (process.env.STRIPE_SECRET_KEY || "").trim();
  return {
    cmd: "stripe",
    args: ["listen", "--forward-to", WEBHOOK_URL, "--api-key", sk],
    printSecretArgs: ["listen", "--print-secret", "--api-key", sk],
  };
}

function getStripeListenSecret() {
  const { cmd, printSecretArgs } = stripeListenCommand();
  const out = execSync([cmd, ...printSecretArgs].join(" "), {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const secret = out.trim().split(/\s+/).pop();
  if (!secret?.startsWith("whsec_")) throw new Error("stripe_listen_print_secret_failed");
  return secret;
}

function spawnBg(label, command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  children.push(child);
  child.stdout?.on("data", (d) => {
    const s = String(d).trim();
    if (s) log(`${label}_stdout`, { line: s.slice(0, 240) });
  });
  child.stderr?.on("data", (d) => {
    const s = String(d).trim();
    if (s) log(`${label}_stderr`, { line: s.replace(/whsec_[A-Za-z0-9]+/g, "whsec_[REDACTED]").slice(0, 240) });
  });
  return child;
}

async function killExternalDevOnOrigin() {
  try {
    if (process.platform === "win32") {
      const out = execSync('netstat -ano | findstr ":4321"', {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const pids = new Set(
        out
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.includes("LISTENING"))
          .map((line) => Number(line.split(/\s+/).pop()))
          .filter((pid) => Number.isFinite(pid) && pid > 0),
      );
      for (const pid of pids) {
        try {
          execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" });
        } catch {
          /* ignore */
        }
      }
    }
    await sleep(2000);
  } catch {
    /* no listener */
  }
}

async function startDevWithWebhookSecret(listenSecret) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "scripts/unified-local-dev.mjs")], {
      cwd: root,
      env: {
        ...process.env,
        STRIPE_WEBHOOK_SECRET: listenSecret,
        STRIPE_SUBSCRIPTION_STORE_LOCAL_MEMORY: "1",
        MINDBODY_MEMBERSHIP_CONSENT_BLOBS: "1",
        MINDBODY_MEMBERSHIP_CONSENT_LOCAL_MEMORY: "1",
        ENABLE_STRIPE_RECURRING_CHECKOUT: "1",
        ENABLE_STRIPE_RECURRING_CHECKOUT_FRONTEND: "1",
        STRIPE_TEST_MODE_MINDBODY_BEHAVIOR: "live",
        NETLIFY_DB_URL: process.env.NETLIFY_DB_URL || "",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    children.push(child);
    let buf = "";
    const timer = setTimeout(() => reject(new Error("dev_start_timeout")), 180_000);
    const onData = (chunk) => {
      const s = String(chunk);
      buf += s;
      if (s.trim()) log("dev_stdout", { line: s.trim().slice(0, 240) });
      const match = buf.match(/postgres:\/\/localhost:\d+\/\S+/);
      if (match) {
        const url = match[0].replace(/[.,;)]+$/, "");
        process.env.NETLIFY_DB_URL = url;
        fs.writeFileSync(path.join(root, ".cursor-local-db-url.txt"), `${url}\n`, "utf8");
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", (chunk) => {
      const s = String(chunk).trim();
      if (s) log("dev_stderr", { line: s.slice(0, 240) });
    });
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    waitForHttp(`${ORIGIN}/`, { timeout: 120_000 })
      .then(() => {
        clearTimeout(timer);
        child.stdout?.off("data", onData);
        resolve(process.env.NETLIFY_DB_URL || "");
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

async function ensureDevAndListen() {
  await killExternalDevOnOrigin();
  const listenSecret = getStripeListenSecret();
  process.env.STRIPE_WEBHOOK_SECRET = listenSecret;
  if ((process.env.ANNUAL_WEBHOOK_SKIP_MINDDBODY_ISSUE || "").trim() === "1") {
    throw new Error("ANNUAL_WEBHOOK_SKIP_MINDDBODY_ISSUE must be unset for live E2E");
  }
  await startDevWithWebhookSecret(listenSecret);
  spawnBg("stripe_listen", stripeListenCommand().cmd, stripeListenCommand().args);
  await sleep(4000);
  report.stripeListen = { command: `stripe listen --forward-to ${WEBHOOK_URL}`, started: true };
  log("step3_stripe_listen_pass", report.stripeListen);
}

async function mbRequest({ method, path: p, bearer, bodyJson }) {
  const HOST = (process.env.MINDBODY_API_HOST || "api.mindbodyonline.com").trim();
  const API_KEY = (process.env.MINDBODY_API_KEY || "").trim();
  const SITE_ID = (process.env.MINDBODY_SITE_ID || "-99").trim();
  const body = bodyJson != null ? Buffer.from(JSON.stringify(bodyJson)) : null;
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: HOST,
        port: 443,
        path: p,
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

async function mbStaffToken() {
  const r = await mbRequest({
    method: "POST",
    path: "/public/v6/usertoken/issue",
    bodyJson: {
      Username: (process.env.MINDBODY_STAFF_USERNAME || "").trim(),
      Password: process.env.MINDBODY_STAFF_PASSWORD || "",
    },
  });
  if (!r.ok || !r.data?.AccessToken) throw new Error("mindbody_staff_token_failed");
  return r.data.AccessToken;
}

function pickArr(data, keys) {
  if (!data || typeof data !== "object") return [];
  for (const k of keys) if (Array.isArray(data[k])) return data[k];
  return [];
}

async function snapshotMindbody(token) {
  const cs = await mbRequest({
    method: "GET",
    path: `/public/v6/client/clientservices?${new URLSearchParams({
      "request.clientId": String(QA_CLIENT_ID),
      "request.limit": "200",
    })}`,
    bearer: token,
  });
  const services = pickArr(cs.data, ["ClientServices", "clientServices"]).filter(
    (s) => Number(s.ProductId ?? s.productId) === PRODUCT_ID,
  );
  return {
    clientServices: services.map((s) => ({
      Id: s.Id ?? s.id,
      Remaining: s.Remaining ?? s.remaining,
      Count: s.Count ?? s.count,
      ActiveDate: s.ActiveDate ?? s.activeDate,
      ExpirationDate: s.ExpirationDate ?? s.expirationDate,
    })),
  };
}

async function snapshotDb() {
  const terms = await annualMembershipQuery(
    `SELECT id, stripe_invoice_id, stripe_subscription_id, sku, status, annual_amount_cents, mindbody_client_id
       FROM annual_memberships
      WHERE mindbody_client_id = $1
      ORDER BY created_at ASC`,
    [QA_CLIENT_ID],
  );
  const periods = await annualMembershipQuery(
    `SELECT p.id, p.annual_membership_id, p.period_index, p.status, p.mindbody_sale_id, p.mindbody_client_service_id
       FROM annual_membership_periods p
       JOIN annual_memberships m ON m.id = p.annual_membership_id
      WHERE m.mindbody_client_id = $1
      ORDER BY m.created_at, p.period_index`,
    [QA_CLIENT_ID],
  );
  return { memberships: terms.rows, periods: periods.rows };
}

function buildAnnualConsentBody() {
  const cfg = loadMbContractTermsConfig();
  const bundle = resolveAnnualContractEntryByLocalSku(cfg, SKU);
  if (!bundle) throw new Error("annual_consent_config_missing");
  const annual = /** @type {Record<string, unknown>} */ (bundle.annual);
  const termsHtml = String(annual.termsHtml || "").trim();
  if (!termsHtml.includes("prepaid annual membership")) {
    throw new Error("annual_consent_html_not_annual");
  }
  return {
    localSku: SKU,
    firstName: QA_FIRST,
    lastName: QA_LAST,
    email: QA_EMAIL,
    phone: QA_PHONE,
    requiresMembershipAgreement: true,
    membershipAgreementAccepted: true,
    membershipBillingAuthorized: true,
    membershipFullLegalName: `${QA_FIRST} ${QA_LAST}`,
    membershipTermsContractVersion: String(annual.contractVersion || ANNUAL_CONTRACT_VERSION),
    membershipTermsDisplayedHtml: `<div class="mb-pricing-contract-html">${termsHtml}</div>`,
    ctaLocation: "final_local_e2e",
    pageLocation: `${ORIGIN}/pricing`,
  };
}

async function createAnnualCheckoutSession() {
  const res = await fetch(`${ORIGIN}/api/stripe/checkout/create-session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify(buildAnnualConsentBody()),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json?.url || !json?.sessionId) {
    throw new Error(`create_session_failed:${res.status}:${JSON.stringify(json).slice(0, 400)}`);
  }
  return json;
}

async function completeStripeCheckout(url) {
  let playwright;
  try {
    playwright = await import("playwright");
  } catch {
    execSync("npm install --no-save playwright@1.49.1", { cwd: root, stdio: "inherit" });
    playwright = await import("playwright");
  }
  const browser = await playwright.chromium.launch({ headless: true });
  let page;
  try {
    page = await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 180_000 });
    await page.waitForURL(/checkout\.stripe\.com/, { timeout: 60_000 });
    await page.waitForTimeout(3000);
    const email = page.getByLabel(/email/i).first();
    if (await email.count()) await email.fill(QA_EMAIL);
    await page.locator("#payment-method-accordion-item-title-card").click({ force: true });
    await page.waitForTimeout(2000);
    const cardNumber = page.getByPlaceholder("1234 1234 1234 1234");
    if (await cardNumber.count()) {
      await cardNumber.fill("4242424242424242", { timeout: 60_000 });
      await page.getByPlaceholder("MM / YY").fill("12/34");
      await page.getByPlaceholder("CVC").fill("123");
      const cardholder = page.getByPlaceholder("Full name on card").first();
      if (await cardholder.count()) await cardholder.fill(`${QA_FIRST} ${QA_LAST}`);
      const zip = page.getByPlaceholder("ZIP").first();
      if (await zip.count()) await zip.fill("33101");
    }
    await page.getByRole("button", { name: /^Subscribe$/i }).click({ timeout: 60_000 });
    try {
      await page.waitForURL(/success|session_id|checkout\/success|pricing/i, { timeout: 180_000 });
    } catch {
      /* webhook may complete before redirect */
    }
    return { ok: true, finalUrl: page.url() };
  } finally {
    await browser.close();
  }
}

async function waitForAnnualTerm(invoiceId, timeoutMs = 240_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await annualMembershipQuery(
      `SELECT m.*, (
         SELECT COUNT(*)::int FROM annual_membership_periods p WHERE p.annual_membership_id = m.id
       ) AS period_count
       FROM annual_memberships m
      WHERE m.stripe_invoice_id = $1
      LIMIT 1`,
      [invoiceId],
    );
    const row = r.rows[0];
    if (row && Number(row.period_count) === 12) {
      const p0 = await annualMembershipQuery(
        `SELECT * FROM annual_membership_periods WHERE annual_membership_id = $1 AND period_index = 0 LIMIT 1`,
        [row.id],
      );
      if (p0.rows[0]?.status === "issued") return { membership: row, period0: p0.rows[0] };
    }
    await sleep(3000);
  }
  throw new Error("annual_term_wait_timeout");
}

function sha256HexUtf8(s) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

async function fetchSaleDetail(token, saleId) {
  const r = await mbRequest({
    method: "GET",
    path: `/public/v6/sale/sales?${new URLSearchParams({ "request.saleId": String(saleId) })}`,
    bearer: token,
  });
  return pickArr(r.data, ["Sales", "sales"])[0] ?? null;
}

async function runRegressionSuite() {
  const suites = [
    "test:annual-membership-phase1",
    "test:annual-membership-phase2",
    "test:annual-membership-phase3",
    "test:annual-membership-phase4",
    "test:final-purchase-regression-gate",
  ];
  /** @type {Record<string, number>} */
  const results = {};
  for (const script of suites) {
    try {
      execSync(`npm run ${script}`, { cwd: root, stdio: "pipe" });
      results[script] = 0;
    } catch (e) {
      results[script] = /** @type {{ status?: number }} */ (e)?.status ?? 1;
    }
  }
  report.regression = results;
  const failed = Object.entries(results).filter(([, code]) => code !== 0);
  if (failed.length) throw new Error(`regression_failed:${failed.map(([k]) => k).join(",")}`);
}

async function main() {
  try {
    const sk = (process.env.STRIPE_SECRET_KEY || "").trim();
    if (!sk.startsWith("sk_test_")) throw new Error("stripe_not_test_mode");
    report.stripeMode = "TEST";

    const { terms } = step1RebuildDist();
    step2AgreementSanity(terms);
    report.sixSkuAgreementSanity = "PASS";
    report.staleCadenceState = "PASS";

    delete process.env.ANNUAL_MEMBERSHIP_STORE_LOCAL_MEMORY;
    await ensureDevAndListen();
    const dbUrl = await ensureLocalDb();
    report.localDbConfigured = Boolean(dbUrl);
    await ensureAnnualMigration();

    const stripe = new Stripe(sk, { apiVersion: "2025-08-27.basil" });
    const mbToken = await mbStaffToken();
    report.before = { mindbody: await snapshotMindbody(mbToken), db: await snapshotDb() };

    const checkout = await createAnnualCheckoutSession();
    report.checkoutSessionId = checkout.sessionId;
    log("step4_checkout_session_created", { sessionId: checkout.sessionId });

    await completeStripeCheckout(checkout.url);
    report.annual8Checkout = "PASS";

    let session = null;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      session = await stripe.checkout.sessions.retrieve(checkout.sessionId, {
        expand: ["subscription", "invoice"],
      });
      if (session.status === "complete" && session.payment_status === "paid") break;
      await sleep(3000);
    }
    if (session?.status !== "complete" || session?.payment_status !== "paid") {
      throw new Error(`checkout_not_completed:${session?.status}:${session?.payment_status}`);
    }

    const subId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id ?? null;
    const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id ?? null;
    let invoiceId = typeof session.invoice === "string" ? session.invoice : session.invoice?.id ?? null;
    if (!invoiceId && subId) {
      const sub = await stripe.subscriptions.retrieve(subId, { expand: ["latest_invoice"] });
      invoiceId = typeof sub.latest_invoice === "string" ? sub.latest_invoice : sub.latest_invoice?.id ?? null;
    }
    if (!invoiceId) throw new Error("missing_invoice_id");

    const invoice = await stripe.invoices.retrieve(invoiceId);
    const sub = subId ? await stripe.subscriptions.retrieve(subId) : null;
    report.stripe = {
      checkoutSessionId: checkout.sessionId,
      customerId,
      subscriptionId: subId,
      invoiceId,
      amountPaidCents: invoice.amount_paid,
      sku: sub?.metadata?.localSku ?? SKU,
      interval: sub?.items?.data?.[0]?.price?.recurring?.interval ?? null,
      mode: session.mode,
    };

    if (report.stripe.amountPaidCents !== EXPECTED_ANNUAL_CENTS) {
      throw new Error(`stripe_amount_mismatch:${report.stripe.amountPaidCents}`);
    }
    if (report.stripe.interval !== "year") throw new Error(`stripe_interval_not_year:${report.stripe.interval}`);
    report.stripeTestPayment = "PASS";

    const events = await stripe.events.list({ type: "invoice.paid", limit: 15 });
    const paidEvt = events.data.find((e) => /** @type {Stripe.Invoice} */ (e.data.object).id === invoiceId);
    if (!paidEvt) throw new Error("invoice_paid_event_not_found");
    report.invoicePaidEventId = paidEvt.id;

    const term = await waitForAnnualTerm(invoiceId);
    report.annualMembershipId = term.membership.id;
    report.periodCount = Number(term.membership.period_count);
    report.period0 = term.period0;

    if (term.membership.sku !== SKU) throw new Error(`db_sku_mismatch:${term.membership.sku}`);
    const annual8Terms = (report.before?.db?.memberships || []).filter((m) => m.sku === SKU);
    report.priorAnnual8Terms = annual8Terms.length;
    if (annual8Terms.length > 0) {
      log("warn_prior_annual8_terms_exist", { count: annual8Terms.length });
    }
    if (Number(term.membership.annual_amount_cents) !== EXPECTED_ANNUAL_CENTS) {
      throw new Error(`db_amount_mismatch:${term.membership.annual_amount_cents}`);
    }
    if (Number(term.membership.mindbody_client_id) !== QA_CLIENT_ID) {
      throw new Error(`db_client_mismatch:${term.membership.mindbody_client_id}`);
    }

    const periods = await annualMembershipQuery(
      `SELECT period_index, status FROM annual_membership_periods WHERE annual_membership_id = $1 ORDER BY period_index`,
      [term.membership.id],
    );
    if (periods.rows.length !== 12) throw new Error(`period_count_not_12:${periods.rows.length}`);
    if (!periods.rows.every((p, i) => (i === 0 ? p.status === "issued" : p.status === "pending"))) {
      throw new Error(`period_statuses_invalid:${JSON.stringify(periods.rows)}`);
    }
    report.annualTerm = "PASS";

    report.consent = {
      localSku: session.metadata?.localSku ?? sub?.metadata?.localSku ?? null,
      contractVersion: session.metadata?.agreementVersion ?? sub?.metadata?.agreementVersion ?? null,
      membershipConsentId: session.metadata?.membershipConsentId ?? sub?.metadata?.membershipConsentId ?? null,
      agreementTextHash: session.metadata?.agreementTextHash ?? sub?.metadata?.agreementTextHash ?? null,
      billingCadence: session.metadata?.billingCadence ?? sub?.metadata?.billingCadence ?? null,
      orderType: session.metadata?.orderType ?? sub?.metadata?.orderType ?? null,
      expectedHash: sha256HexUtf8(String(buildAnnualConsentBody().membershipTermsDisplayedHtml).trim()),
    };
    report.consent.hashMatch = report.consent.agreementTextHash === report.consent.expectedHash;
    if (report.consent.localSku !== SKU) throw new Error(`consent_sku_mismatch:${report.consent.localSku}`);
    if (report.consent.contractVersion !== ANNUAL_CONTRACT_VERSION) {
      throw new Error(`consent_version_mismatch:${report.consent.contractVersion}`);
    }
    if (!report.consent.hashMatch) throw new Error("consent_hash_mismatch_not_annual_snapshot");
    if (report.consent.billingCadence !== "annual" || report.consent.orderType !== "annual_membership") {
      throw new Error(`consent_cadence_metadata_mismatch:${report.consent.billingCadence}:${report.consent.orderType}`);
    }
    report.annualConsent = "PASS";

    const mbAfter = await snapshotMindbody(mbToken);
    const newServices = mbAfter.clientServices.filter(
      (s) => !report.before.mindbody.clientServices.some((b) => Number(b.Id) === Number(s.Id)),
    );
    report.mindbodyClientServiceId = term.period0.mindbody_client_service_id;
    report.mindbodySaleId = term.period0.mindbody_sale_id;
    report.mindbodyNewServices = newServices;

    const cs =
      mbAfter.clientServices.find((s) => Number(s.Id) === Number(term.period0.mindbody_client_service_id)) ??
      newServices[0] ??
      null;
    report.clientService = cs
      ? { id: cs.Id, count: cs.Count, remaining: cs.Remaining, activeDate: cs.ActiveDate, expirationDate: cs.ExpirationDate }
      : null;

    if (term.period0.mindbody_sale_id) {
      const sale = await fetchSaleDetail(mbToken, term.period0.mindbody_sale_id);
      const items = pickArr(sale, ["PurchasedItems", "purchasedItems"]);
      const first = items[0] ?? {};
      report.saleDetail = {
        productId: first.Id ?? first.ProductId ?? first.id,
        regularPrice: first.UnitPrice ?? first.Price,
        discount: first.DiscountAmount,
        net: first.TotalAmount ?? first.TotalAmount,
        payments: pickArr(sale, ["Payments", "payments"]).map((p) => ({
          method: p.Method ?? p.Type,
          amount: p.Amount,
        })),
      };
      if (Number(report.saleDetail.productId) !== PRODUCT_ID) {
        throw new Error(`mindbody_product_mismatch:${report.saleDetail.productId}`);
      }
    }

    report.mindbodySale = term.period0.mindbody_sale_id ? "PASS" : "FAIL";
    report.clientServicePass =
      cs && Number(cs.Count) === 8 && Number(cs.Remaining) === 8 ? "PASS" : "FAIL";

    const chargesBefore = (await stripe.charges.list({ customer: customerId, limit: 10 })).data.length;
    report.secondStripeCharge = "NO";

    const mbBeforeReplay = await snapshotMindbody(mbToken);
    const dbBeforeReplay = await snapshotDb();
    const subRecordForReplay = subId
      ? await (async () => {
          process.env.STRIPE_SUBSCRIPTION_STORE_LOCAL_MEMORY = "1";
          const { openSubscriptionStore } = await import("../netlify/functions/stripe-subscription-store.mjs");
          return openSubscriptionStore({}).getByStripeSubscriptionId(subId);
        })()
      : null;
    const replaySubRecord =
      subRecordForReplay ??
      /** @type {import("../netlify/functions/stripe-subscription-store.mjs").SubscriptionRecord} */ ({
        id: `sub_amare_replay_${Date.now()}`,
        localSku: SKU,
        mindbodyClientId: QA_CLIENT_ID,
        stripeSubscriptionId: subId,
        stripeCustomerId: customerId,
      });
    const replay1 = await handleAnnualInvoicePaid({
      invoice,
      subscriptionRecord: replaySubRecord,
      skipMindbodyIssue: false,
      mindbodyTest: false,
    });
    await sleep(3000);
    const replay2 = await handleAnnualInvoicePaid({
      invoice,
      subscriptionRecord: replaySubRecord,
      skipMindbodyIssue: false,
      mindbodyTest: false,
    });
    const mbAfterReplay = await snapshotMindbody(mbToken);
    const dbAfterReplay = await snapshotDb();
    const duplicateServices = mbAfterReplay.clientServices.filter(
      (s) => !mbBeforeReplay.clientServices.some((b) => Number(b.Id) === Number(s.Id)),
    ).length;
    report.idempotencyReplay = {
      replay1Outcome: replay1?.outcome ?? replay1,
      replay2Outcome: replay2?.outcome ?? replay2,
      membershipCountSame: dbAfterReplay.memberships.length === dbBeforeReplay.memberships.length,
      periodCountSame:
        dbAfterReplay.periods.filter((p) => p.annual_membership_id === term.membership.id).length === 12,
      period0StillIssued:
        dbAfterReplay.periods.find(
          (p) => p.period_index === 0 && p.annual_membership_id === term.membership.id,
        )?.status === "issued",
      duplicateMindbodyServices: duplicateServices,
    };
    if (
      !report.idempotencyReplay.membershipCountSame ||
      !report.idempotencyReplay.periodCountSame ||
      duplicateServices > 0
    ) {
      throw new Error(`idempotency_failed:${JSON.stringify(report.idempotencyReplay)}`);
    }
    report.duplicateMindbodyAllocation = duplicateServices > 0 ? "YES" : "NO";

    const rec1 = await runAnnualMembershipReconciliation();
    const rec2 = await runAnnualMembershipReconciliation();
    report.reconciler = {
      first: rec1,
      second: rec2,
      mindbodyWrites: (rec1.issued ?? 0) + (rec1.failed ?? 0) + (rec2.issued ?? 0) + (rec2.failed ?? 0),
    };
    report.reconcilerResult = report.reconciler.mindbodyWrites === 0 ? "NO-OP" : "WRITE";

    if (subId) {
      await stripe.subscriptions.cancel(subId);
      report.testSubscriptionCanceled = true;
    }

    const chargesAfter = (await stripe.charges.list({ customer: customerId, limit: 10 })).data.length;
    if (chargesAfter > chargesBefore) report.secondStripeCharge = "YES";

    await runRegressionSuite();
    report.fullRegression = "PASS";
    report.finalLocalE2e = "PASS";
    log("final_local_e2e_complete", report);
  } catch (err) {
    report.finalLocalE2e = "FAIL";
    report.error = String(/** @type {{ message?: string }} */ (err)?.message ?? err).slice(0, 500);
    log("final_local_e2e_failed", report);
    process.exitCode = 1;
  } finally {
    for (const c of children) {
      try {
        c.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }
  }
}

main();
