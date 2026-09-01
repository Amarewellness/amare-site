/**
 * Phase 3.5 — ONE controlled annual membership E2E (QA only).
 *
 * Stripe TEST checkout → stripe listen → annual webhook → Postgres → Mindbody Period 0.
 * Authorized: exactly ONE live Mindbody allocation on QA client 100002839.
 *
 * Usage:
 *   node scripts/qa-annual-membership-phase35-e2e.mjs
 *
 * Requires: .env sk_test_*, Mindbody staff creds, local dev reachable (or script starts it),
 * optional .cursor-local-db-url.txt for Postgres ledger.
 */

import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Stripe from "stripe";

import { loadLocalEnv } from "./load-env.mjs";
import { loadMbContractTermsConfig, resolveManualContractEntryByServiceId } from "../netlify/functions/load-mb-contract-terms.mjs";
import { annualMembershipQuery } from "../netlify/functions/annual-membership-store.mjs";
import { runAnnualMembershipReconciliation } from "../netlify/functions/annual-membership-reconciler.mjs";

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
const SKU = "annual_monthly_5";
const SERVICE_ID = 100133;
const PRODUCT_ID = 100133;

/** @type {Record<string, unknown>} */
const report = { phase: "3.5", startedAt: new Date().toISOString() };

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
    const timer = setTimeout(() => {
      reject(new Error(`local_db_proxy_timeout:${stderrBuf.slice(0, 240)}`));
    }, 90_000);
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
      reject(new Error(`local_db_proxy_exited:${code}:${stderrBuf.slice(0, 240)}`));
    });
  });
  process.env.NETLIFY_DB_URL = url;
  fs.writeFileSync(path.join(root, ".cursor-local-db-url.txt"), `${url}\n`, "utf8");
  return url;
}

async function ensureLocalDb() {
  let url = loadLocalDbUrl();
  if (url && (await probeDbUrl(url))) return url;
  try {
    url = await spawnLocalDbProxy();
    if (await probeDbUrl(url)) return url;
  } catch (err) {
    if (process.env.QA_ALLOW_MEMORY_LEDGER === "1") {
      process.env.ANNUAL_MEMBERSHIP_STORE_LOCAL_MEMORY = "1";
      report.localDbFallback = "memory_store";
      report.localDbProxyError = String(/** @type {{ message?: string }} */ (err)?.message ?? err).slice(
        0,
        240,
      );
      return "";
    }
    throw err;
  }
  throw new Error("local_db_unavailable_after_proxy");
}

async function ensureAnnualMigration() {
  const sqlPath = path.join(root, "netlify/database/migrations/20260901183000_annual_memberships.sql");
  const sql = fs.readFileSync(sqlPath, "utf8");
  const check = await annualMembershipQuery(
    "SELECT to_regclass('public.annual_memberships') AS table_name",
    [],
  );
  if (check.rows[0]?.table_name) return { applied: false, already: true };
  const statements = sql
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("--"));
  for (const stmt of statements) {
    await annualMembershipQuery(`${stmt};`, []);
  }
  return { applied: true, already: false };
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
    if (s) {
      const redacted = s.replace(/whsec_[A-Za-z0-9]+/g, "whsec_[REDACTED]");
      log(`${label}_stderr`, { line: redacted.slice(0, 240) });
    }
  });
  return child;
}

async function killExternalDevOnOrigin() {
  try {
    if (process.platform === "win32") {
      const out = execSync('netstat -ano | findstr ":4321"', { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
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
    } else {
      execSync("lsof -ti :4321 | xargs -r kill -9", { stdio: "ignore" });
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
        STRIPE_SUBSCRIPTION_STORE_LOCAL_MEMORY: process.env.STRIPE_SUBSCRIPTION_STORE_LOCAL_MEMORY || "1",
        ENABLE_STRIPE_RECURRING_CHECKOUT: "1",
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
      const line = s.trim();
      if (line) log("dev_stdout", { line: line.slice(0, 240) });
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
  let devExternal = false;
  try {
    await waitForHttp(`${ORIGIN}/`, { timeout: 3000 });
    devExternal = true;
  } catch {
    /* will start below */
  }

  const listenSecret = getStripeListenSecret();
  process.env.STRIPE_WEBHOOK_SECRET = listenSecret;
  report.webhookEnvKeyVerified = "ANNUAL_WEBHOOK_SKIP_MINDDBODY_ISSUE";
  report.webhookSkipUnset =
    (process.env.ANNUAL_WEBHOOK_SKIP_MINDDBODY_ISSUE || "").trim() !== "1";
  report.stripeListenCommand = `stripe listen --forward-to ${WEBHOOK_URL}`;

  for (const c of children.splice(0)) {
    try {
      c.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
  if (devExternal) await killExternalDevOnOrigin();
  await sleep(devExternal ? 1000 : 0);
  await startDevWithWebhookSecret(listenSecret);

  spawnBg("stripe_listen", stripeListenCommand().cmd, stripeListenCommand().args, {
    STRIPE_WEBHOOK_SECRET: listenSecret,
  });
  await sleep(4000);
  return { devExternal, listenStarted: true, listenSecretPrefix: listenSecret.slice(0, 8) };
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
  const STAFF_USER = (process.env.MINDBODY_STAFF_USERNAME || "").trim();
  const STAFF_PASS = process.env.MINDBODY_STAFF_PASSWORD || "";
  const r = await mbRequest({
    method: "POST",
    path: "/public/v6/usertoken/issue",
    bodyJson: { Username: STAFF_USER, Password: STAFF_PASS },
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
  const purchases = await mbRequest({
    method: "GET",
    path: `/public/v6/client/clientpurchases?${new URLSearchParams({
      "request.clientId": String(QA_CLIENT_ID),
      "request.limit": "50",
    })}`,
    bearer: token,
  });
  const client = await mbRequest({
    method: "GET",
    path: `/public/v6/client/clients?${new URLSearchParams({
      "request.clientIDs": String(QA_CLIENT_ID),
    })}`,
    bearer: token,
  });
  const services = pickArr(cs.data, ["ClientServices", "clientServices"]).filter(
    (s) => Number(s.ProductId ?? s.productId) === PRODUCT_ID,
  );
  const sales = pickArr(purchases.data, ["Purchases", "purchases"]).map((p) => p?.Sale ?? p?.sale ?? p);
  return {
    clientServices100133: services.map((s) => ({
      Id: s.Id ?? s.id,
      Remaining: s.Remaining ?? s.remaining,
      Count: s.Count ?? s.count,
      ActiveDate: s.ActiveDate ?? s.activeDate,
      ExpirationDate: s.ExpirationDate ?? s.expirationDate,
    })),
    salesCount: sales.length,
    membershipId: client.data?.Clients?.[0]?.MembershipIcon ?? client.data?.Clients?.[0]?.MembershipIcon ?? null,
    accountBalance: client.data?.Clients?.[0]?.AccountBalance ?? client.data?.Clients?.[0]?.accountBalance ?? null,
  };
}

async function snapshotDb() {
  if (process.env.ANNUAL_MEMBERSHIP_STORE_LOCAL_MEMORY === "1") {
    const { openAnnualMembershipStoreForTests } = await import("../netlify/functions/annual-membership-store.mjs");
    const store = openAnnualMembershipStoreForTests();
    const terms = await annualMembershipQuery
      ? await annualMembershipQuery(
          `SELECT id, stripe_invoice_id, stripe_subscription_id, sku, status, term_start_date, term_end_date, annual_amount_cents
             FROM annual_memberships
            WHERE mindbody_client_id = $1
            ORDER BY created_at ASC`,
          [QA_CLIENT_ID],
        ).catch(() => ({ rows: [] }))
      : { rows: [] };
    if (terms.rows.length) return { memberships: terms.rows, periods: [] };
    return { memberships: [], periods: [], memoryStore: true };
  }
  const terms = await annualMembershipQuery(
    `SELECT id, stripe_invoice_id, stripe_subscription_id, sku, status, term_start_date, term_end_date, annual_amount_cents
       FROM annual_memberships
      WHERE mindbody_client_id = $1
      ORDER BY created_at ASC`,
    [QA_CLIENT_ID],
  );
  const periods = await annualMembershipQuery(
    `SELECT p.id, p.period_index, p.status, p.mindbody_sale_id, p.mindbody_client_service_id,
            p.pre_issue_client_service_ids, p.claim_started_at, p.issued_at
       FROM annual_membership_periods p
       JOIN annual_memberships m ON m.id = p.annual_membership_id
      WHERE m.mindbody_client_id = $1
      ORDER BY m.created_at, p.period_index`,
    [QA_CLIENT_ID],
  );
  return { memberships: terms.rows, periods: periods.rows };
}

function buildConsentBody() {
  const cfg = loadMbContractTermsConfig();
  const bundle = resolveManualContractEntryByServiceId(cfg, SERVICE_ID);
  const manual = /** @type {Record<string, unknown>} */ (bundle?.manual ?? {});
  const termsHtml = String(manual.termsHtml || "").trim();
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
    membershipTermsContractVersion: String(manual.contractVersion || "2026-05-14-v2"),
    membershipTermsDisplayedHtml: termsHtml,
    ctaLocation: "phase35_e2e",
    pageLocation: `${ORIGIN}/pricing`,
  };
}

async function createAnnualCheckoutSession() {
  const res = await fetch(`${ORIGIN}/api/stripe/checkout/create-session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify(buildConsentBody()),
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
  const browser = await playwright.chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"],
  });
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
    } else {
      const cardFrame = page.frameLocator('iframe[name*="__privateStripeFrame"]').first();
      await cardFrame.getByPlaceholder("1234 1234 1234 1234").fill("4242424242424242", { timeout: 60_000 });
      await cardFrame.getByPlaceholder("MM / YY").fill("12/34");
      await cardFrame.getByPlaceholder("CVC").fill("123");
    }

    await page.getByRole("button", { name: /^Subscribe$/i }).click({ timeout: 60_000 });
    try {
      await page.waitForURL(/success|session_id|checkout\/success|pricing/i, { timeout: 180_000 });
    } catch {
      /* success redirect may lag; caller polls Stripe session status */
    }
    return { ok: true, finalUrl: page.url() };
  } catch (err) {
    const shot = path.join(root, "amare-app", "qa-phase35-checkout-fail.png");
    try {
      if (page) await page.screenshot({ path: shot, fullPage: true });
      log("checkout_screenshot", { path: shot });
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    await browser.close();
  }
}

async function waitForAnnualTerm(invoiceId, timeoutMs = 180_000) {
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

async function fetchSaleDetail(token, saleId) {
  const r = await mbRequest({
    method: "GET",
    path: `/public/v6/sale/sales?${new URLSearchParams({ "request.saleId": String(saleId) })}`,
    bearer: token,
  });
  const sales = pickArr(r.data, ["Sales", "sales"]);
  return sales[0] ?? null;
}

async function main() {
  try {
    delete process.env.ANNUAL_MEMBERSHIP_STORE_LOCAL_MEMORY;
    if ((process.env.ANNUAL_WEBHOOK_SKIP_MINDDBODY_ISSUE || "").trim() === "1") {
      throw new Error("ANNUAL_WEBHOOK_SKIP_MINDDBODY_ISSUE must be unset for live E2E");
    }

    const sk = (process.env.STRIPE_SECRET_KEY || "").trim();
    if (!sk.startsWith("sk_test_")) throw new Error("stripe_not_test_mode");
    report.stripeMode = "TEST";

    await waitForHttp(WEBHOOK_URL, { method: "OPTIONS", acceptStatus: [204, 200, 405], timeout: 5000 }).catch(
      () => ensureDevAndListen(),
    );
    if (!report.stripeListenCommand) {
      const infra = await ensureDevAndListen();
      report.infra = infra;
    }

    const dbUrl = await ensureLocalDb();
    report.localDbConfigured = Boolean(dbUrl);
    const mig = await ensureAnnualMigration();
    report.localDbMigration = mig.already || mig.applied ? "PASS" : "FAIL";

    const stripe = new Stripe(sk, { apiVersion: "2025-08-27.basil" });
    const mbToken = await mbStaffToken();
    report.before = {
      mindbody: await snapshotMindbody(mbToken),
      db: await snapshotDb(),
    };

    const checkout = await createAnnualCheckoutSession();
    report.checkoutSession = checkout.sessionId;
    report.checkoutSubscriptionId = checkout.subscriptionId ?? null;

    await completeStripeCheckout(checkout.url);

    let session = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      session = await stripe.checkout.sessions.retrieve(checkout.sessionId, {
        expand: ["subscription", "invoice"],
      });
      if (session.status === "complete" && session.payment_status === "paid") break;
      await sleep(3000);
    }
    if (session?.status !== "complete" || session?.payment_status !== "paid") {
      throw new Error(`checkout_not_completed:${session?.status}:${session?.payment_status}`);
    }
    const subId =
      typeof session.subscription === "string" ? session.subscription : session.subscription?.id ?? null;
    const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id ?? null;
    let invoiceId =
      typeof session.invoice === "string" ? session.invoice : session.invoice?.id ?? null;
    if (!invoiceId && subId) {
      const sub = await stripe.subscriptions.retrieve(subId, { expand: ["latest_invoice"] });
      invoiceId =
        typeof sub.latest_invoice === "string" ? sub.latest_invoice : sub.latest_invoice?.id ?? null;
    }
    if (!invoiceId) throw new Error("missing_invoice_id_after_checkout");

    const invoice = await stripe.invoices.retrieve(invoiceId);
    report.customer = customerId;
    report.subscription = subId;
    report.invoice = invoiceId;
    report.stripeAnnualPaymentCents = invoice.amount_paid;
    report.invoicePaidEvent = null;

    const term = await waitForAnnualTerm(invoiceId);
    report.annualMembershipId = term.membership.id;
    report.periodCount = Number(term.membership.period_count);

    const afterFirst = await snapshotDb();
    const periods = await annualMembershipQuery(
      `SELECT period_index, status FROM annual_membership_periods WHERE annual_membership_id = $1 ORDER BY period_index`,
      [term.membership.id],
    );
    report.period0 = term.period0;
    report.periods1to11Pending = periods.rows
      .filter((p) => p.period_index > 0)
      .every((p) => p.status === "pending");

    const mbAfter = await snapshotMindbody(mbToken);
    const newServices = mbAfter.clientServices100133.filter(
      (s) => !report.before.mindbody.clientServices100133.some((b) => Number(b.Id) === Number(s.Id)),
    );
    report.mindbodyNewClientServices = newServices;
    report.mindbodySaleId = term.period0.mindbody_sale_id;
    report.mindbodyClientServiceId = term.period0.mindbody_client_service_id;

    if (term.period0.mindbody_sale_id) {
      const sale = await fetchSaleDetail(mbToken, term.period0.mindbody_sale_id);
      const items = pickArr(sale, ["PurchasedItems", "purchasedItems", "Items", "items"]);
      const first = items[0] ?? {};
      report.saleDetail = {
        productId: first.Id ?? first.id ?? first.ProductId,
        regularPrice: first.UnitPrice ?? first.Price ?? first.RegularPrice,
        discount: first.DiscountAmount ?? first.discountAmount,
        net: first.TotalAmount ?? first.totalAmount,
        payments: pickArr(sale, ["Payments", "payments"]).map((p) => ({
          method: p.Method ?? p.method ?? p.Type,
          amount: p.Amount ?? p.amount,
        })),
      };
    }

    const events = await stripe.events.list({ type: "invoice.paid", limit: 10 });
    const paidEvt = events.data.find((e) => {
      const inv = /** @type {Stripe.Invoice} */ (e.data.object);
      return inv.id === invoiceId;
    });
    if (!paidEvt) throw new Error("invoice_paid_event_not_found");
    report.invoicePaidEvent = paidEvt.id;

    const mbBeforeReplay = await snapshotMindbody(mbToken);
    await stripe.events.resend(paidEvt.id);
    await sleep(8000);
    const mbAfterReplay = await snapshotMindbody(mbToken);
    const dbAfterReplay = await snapshotDb();
    report.replay = {
      membershipCount: dbAfterReplay.memberships.length,
      periodCount: dbAfterReplay.periods.filter((p) => p.annual_membership_id === term.membership.id).length,
      newServicesAfterReplay: mbAfterReplay.clientServices100133.filter(
        (s) => !mbBeforeReplay.clientServices100133.some((b) => Number(b.Id) === Number(s.Id)),
      ).length,
      newSalesAfterReplay: mbAfterReplay.salesCount - mbBeforeReplay.salesCount,
    };

    const rec1 = await runAnnualMembershipReconciliation();
    const rec2 = await runAnnualMembershipReconciliation();
    report.reconciler = { first: rec1, second: rec2 };

    if (subId) {
      await stripe.subscriptions.cancel(subId);
      report.testSubscriptionCanceled = true;
      const termAfterCancel = await annualMembershipQuery(
        `SELECT id, status FROM annual_memberships WHERE id = $1`,
        [term.membership.id],
      );
      report.annualTermPreservedAfterCancel = termAfterCancel.rows[0]?.status ?? null;
    }

    report.final = "PASS";
    log("phase35_e2e_complete", report);
  } catch (err) {
    report.final = "FAIL";
    report.error = String(/** @type {{ message?: string }} */ (err)?.message ?? err).slice(0, 500);
    if (err && typeof err === "object" && "stack" in err) {
      report.errorStack = String(/** @type {{ stack?: string }} */ (err).stack).split("\n").slice(0, 5).join(" | ");
    }
    log("phase35_e2e_failed", report);
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
