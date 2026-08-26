/**
 * One-origin local dev: watch + rebuild dist, serve static files, Mindbody GET proxy,
 * and OAuth Netlify-compatible routes (same handler code as netlify/functions).
 *
 * Usage: npm run dev (or npm run dev:full)
 * Android LAN QA: npm run dev:lan  (binds 0.0.0.0; does not change production)
 *
 * Point MINDBODY_OAUTH_REDIRECT_URI at an HTTPS URL allowed in Mindbody (production, preview,
 * or tunnel) — plain http://127.0.0.1 is usually rejected by the portal.
 */
import "./load-env.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execSync, spawn } from "node:child_process";
import chokidar from "chokidar";
import { handleMindbodyPublicRoutes } from "./mindbody-public-routes.mjs";
import { toNetlifyEvent, sendLambdaHttpResponse } from "./netlify-handler-http.mjs";
import { MOBILE_API_CORS, mobileCorsHeadersForOrigin } from "../netlify/functions/mobile-api-cors.mjs";

/** Local Vite (5178) → API (4321) preflight. Includes PATCH for notification prefs. Production Functions are unchanged. */
const DEV_API_PREFLIGHT_CORS = {
  ...MOBILE_API_CORS,
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
};

function applyDevMobileCors(req, res, cors = DEV_API_PREFLIGHT_CORS) {
  const headers = mobileCorsHeadersForOrigin(String(req.headers.origin || ""), cors);
  for (const [k, v] of Object.entries(headers)) {
    if (v !== undefined) res.setHeader(k, v);
  }
}

import { handler as hOAuthStart } from "../netlify/functions/mindbody-oauth-start.mjs";
import { lambdaHandler as hOAuthCallback } from "../netlify/functions/mindbody-oauth-callback.mjs";
import { handler as hOAuthSession } from "../netlify/functions/mindbody-oauth-session.mjs";
import { handler as hOAuthLogout } from "../netlify/functions/mindbody-oauth-logout.mjs";
import { handler as hOAuthCompleteStudioProfile } from "../netlify/functions/mindbody-oauth-complete-studio-profile.mjs";
import { handler as hOAuthMobileExchange } from "../netlify/functions/mindbody-oauth-mobile-exchange.mjs";
import { handler as hOAuthMobileRefresh } from "../netlify/functions/mindbody-oauth-mobile-refresh.mjs";
import { handler as hOAuthMobileRevoke } from "../netlify/functions/mindbody-oauth-mobile-revoke.mjs";
import { handler as hOAuthMobileBridge } from "../netlify/functions/mindbody-oauth-mobile-bridge.mjs";
import { lambdaHandler as hMemberSummary } from "../netlify/functions/mindbody-member-summary.mjs";
import { lambdaHandler as hClassBook } from "../netlify/functions/mindbody-class-book.mjs";
import { handler as hAnonymousBookIntent } from "../netlify/functions/mindbody-anonymous-book-intent.mjs";
import { lambdaHandler as hClassCancel } from "../netlify/functions/mindbody-class-cancel.mjs";
import { lambdaHandler as hClassWaitlistRemove } from "../netlify/functions/mindbody-class-waitlist-remove.mjs";
import { handler as hSaleServices } from "../netlify/functions/mindbody-sale-services.mjs";
import { handler as hSaleContracts } from "../netlify/functions/mindbody-sale-contracts.mjs";
import { lambdaHandler as hWebhooksSchedule } from "../netlify/functions/mindbody-webhooks-schedule.mjs";
import { handler as hSiteSites } from "../netlify/functions/mindbody-site-sites.mjs";
import { handler as hSaleCheckout } from "../netlify/functions/mindbody-sale-checkout.mjs";
import { handler as hSalePurchaseContract } from "../netlify/functions/mindbody-sale-purchase-contract.mjs";
import { handler as hSaleCheckoutWarmup } from "../netlify/functions/mindbody-sale-checkout-warmup.mjs";
import { handler as hClientStoredCards } from "../netlify/functions/mindbody-client-stored-cards.mjs";
import { handler as hClientRegister } from "../netlify/functions/mindbody-client-register.mjs";
import { lambdaHandler as hStripeCreateCheckoutSession } from "../netlify/functions/stripe-create-checkout-session.mjs";
import { handler as hStripeEventCreateDeposit } from "../netlify/functions/stripe-event-create-deposit.mjs";
import { handler as hStripeWebhook } from "../netlify/functions/stripe-webhook.mjs";
import { handler as hStripeOrderStatus } from "../netlify/functions/stripe-order-status.mjs";
import { handler as hStripeDeferredBookConfirmEmail } from "../netlify/functions/stripe-deferred-book-confirm-email.mjs";
import { handler as hStripeAdminOrders } from "../netlify/functions/stripe-admin-orders.mjs";
import { handler as hStripeAdminSubscriptions } from "../netlify/functions/stripe-admin-subscriptions.mjs";
import { handler as hNewClientSmsScan } from "../netlify/functions/new-client-sms-scan.mjs";
import { handler as hNewClientSmsSeedStatus } from "../netlify/functions/new-client-sms-seed-status.mjs";
import { handler as hFollowUpDashboardRun } from "../netlify/functions/follow-up-dashboard-run.mjs";
import { handler as hFollowUpLowCreditsRun } from "../netlify/functions/follow-up-low-credits-run.mjs";
import { handler as hFollowUpClassPassRun } from "../netlify/functions/follow-up-classpass-run.mjs";
import { handler as hFollowUpVisitsSeedStatus } from "../netlify/functions/follow-up-visits-seed-status.mjs";
import { handler as hFollowUpSendReport } from "../netlify/functions/follow-up-send-report.mjs";
import { handler as hFollowUpActions } from "../netlify/functions/follow-up-actions.mjs";
import { handler as hBenefitsPublicList } from "../netlify/functions/benefits-public-list.mjs";
import { lambdaHandler as hBenefitsMemberList } from "../netlify/functions/benefits-member-list.mjs";
import { lambdaHandler as hBenefitsMemberBadge } from "../netlify/functions/benefits-member-badge.mjs";
import { lambdaHandler as hBenefitsIssueToken } from "../netlify/functions/benefits-issue-token.mjs";
import { handler as hBenefitsRedeemValidate } from "../netlify/functions/benefits-redeem-validate.mjs";
import { handler as hBenefitsRedeemConfirm } from "../netlify/functions/benefits-redeem-confirm.mjs";
import { handler as hBenefitsAdmin } from "../netlify/functions/benefits-admin.mjs";
import { handler as hEventReservationsAdmin } from "../netlify/functions/event-reservations-admin.mjs";
import { handler as hEventInquirySubmit } from "../netlify/functions/event-inquiry-submit.mjs";
import { handler as hContactSubmit } from "../netlify/functions/contact-submit.mjs";
import { handler as hEventOfferPublic } from "../netlify/functions/event-offer-public.mjs";
import { handler as hAdminLogin } from "../netlify/functions/admin-login.mjs";
import { lambdaHandler as hAmareAuthSession } from "../netlify/functions/amare-auth-session.mjs";
import { handler as hAmareAuthLogout } from "../netlify/functions/amare-auth-logout.mjs";
import { handler as hAmareAuthLogoutAll } from "../netlify/functions/amare-auth-logout-all.mjs";
import { handler as hAmareAuthGoogleStart } from "../netlify/functions/amare-auth-google-start.mjs";
import { handler as hAmareAuthGoogleCallback } from "../netlify/functions/amare-auth-google-callback.mjs";
import { lambdaHandler as hAmareAuthClaimConfirm } from "../netlify/functions/amare-auth-claim-confirm.mjs";
import { lambdaHandler as hAmareAuthEmailRequest } from "../netlify/functions/amare-auth-email-request.mjs";
import { lambdaHandler as hAmareAuthEmailVerify } from "../netlify/functions/amare-auth-email-verify.mjs";
import { lambdaHandler as hAmareAuthMemberAccess } from "../netlify/functions/amare-auth-member-access.mjs";
import { lambdaHandler as hAmareAuthAccountDelete } from "../netlify/functions/amare-auth-account-delete.mjs";
import { lambdaHandler as hAmareAuthAssociationLink } from "../netlify/functions/amare-auth-association-link.mjs";
import { lambdaHandler as hAmareCommerceStatus } from "../netlify/functions/amare-commerce-status.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const staffScheduleAdminFnPath = path.join(root, "netlify/functions/staff-schedule-admin.mjs");
const dist = path.join(root, "dist");
const classClassesFnPath = path.join(root, "netlify/functions/mindbody-class-classes.mjs");
const bringAFriendStatusFnPath = path.join(
  root,
  "netlify/functions/mindbody-member-bring-a-friend-status.mjs",
);
const bringAFriendFnPath = path.join(root, "netlify/functions/mindbody-member-bring-a-friend.mjs");
const memberTopUpStatusFnPath = path.join(root, "netlify/functions/mindbody-member-top-up-status.mjs");
const memberTopUpReleaseFnPath = path.join(root, "netlify/functions/mindbody-member-top-up-release.mjs");
const guestPassLibPath = path.join(root, "netlify/functions/guest-pass-lib.mjs");
const guestPassLibLoaderPath = path.join(root, "netlify/functions/guest-pass-lib-loader.mjs");
const guestPassEmailsPath = path.join(root, "netlify/functions/guest-pass-emails.mjs");
const guestPassDevResetFnPath = path.join(root, "netlify/functions/mindbody-guest-pass-dev-reset.mjs");

function fileMtimeMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

/** Reload Netlify function on each request so edits apply without restarting dev. */
async function loadHandlerFromPath(fnPath, extraVersionPaths = []) {
  const href = pathToFileURL(fnPath);
  const versionParts = [fileMtimeMs(fnPath), ...extraVersionPaths.map(fileMtimeMs)];
  href.searchParams.set("v", versionParts.join("-"));
  const mod = await import(href.href);
  if (typeof mod.lambdaHandler === "function") return mod.lambdaHandler;
  return mod.handler;
}

/** Reload schedule passthrough on each request so Netlify function edits apply without restarting dev. */
async function loadClassClassesHandler() {
  return loadHandlerFromPath(classClassesFnPath);
}

async function loadBringAFriendStatusHandler() {
  return loadHandlerFromPath(bringAFriendStatusFnPath, [guestPassLibPath, guestPassLibLoaderPath]);
}

async function loadMemberTopUpStatusHandler() {
  return loadHandlerFromPath(memberTopUpStatusFnPath, [
    path.join(root, "netlify/functions/member-topup-lib.mjs"),
    path.join(root, "netlify/functions/member-topup-blobs.mjs"),
  ]);
}

async function loadMemberTopUpReleaseHandler() {
  return loadHandlerFromPath(memberTopUpReleaseFnPath, [
    path.join(root, "netlify/functions/member-topup-lib.mjs"),
    path.join(root, "netlify/functions/member-topup-blobs.mjs"),
  ]);
}

async function loadBringAFriendHandler() {
  return loadHandlerFromPath(bringAFriendFnPath, [
    guestPassLibPath,
    guestPassLibLoaderPath,
    guestPassEmailsPath,
    path.join(root, "netlify/functions/mindbody-guest-client-lib.mjs"),
    path.join(root, "netlify/functions/mindbody-guest-pass-sale.mjs"),
  ]);
}

const staffScheduleAvailabilityFnPath = path.join(
  root,
  "netlify/functions/staff-schedule-availability.mjs",
);

async function loadStaffScheduleAvailabilityHandler() {
  return loadHandlerFromPath(staffScheduleAvailabilityFnPath, [
    path.join(root, "netlify/functions/staff-schedule-lib.mjs"),
    path.join(root, "netlify/functions/staff-schedule-store.mjs"),
    path.join(root, "netlify/functions/staff-schedule-class-hours.mjs"),
    path.join(root, "netlify/functions/staff-schedule-availability-window.mjs"),
  ]);
}

const amareAuthLibReloadPaths = [
  path.join(root, "netlify/functions/amare-auth-lib.mjs"),
  path.join(root, "netlify/functions/amare-identity-store.mjs"),
  path.join(root, "netlify/functions/amare-identity-policy.mjs"),
  path.join(root, "netlify/functions/amare-sess-lib.mjs"),
  path.join(root, "netlify/functions/amare-studio-lib.mjs"),
  path.join(root, "netlify/functions/amare-commerce-lib.mjs"),
  path.join(root, "netlify/functions/amare-otp-store.mjs"),
  path.join(root, "netlify/functions/amare-auth-profile-lib.mjs"),
  path.join(root, "netlify/functions/amare-auth-purchase-claim.mjs"),
  path.join(root, "netlify/functions/mobile-auth-lib.mjs"),
  path.join(root, "netlify/functions/mobile-api-cors.mjs"),
  path.join(root, "netlify/functions/stripe-payment-flow.mjs"),
  path.join(root, "netlify/functions/amare-commerce-mobile-payments.mjs"),
  path.join(root, "netlify/functions/stripe-order-store.mjs"),
  path.join(root, "netlify/functions/amare-notification-http.mjs"),
  path.join(root, "netlify/functions/amare-notification-store.mjs"),
  path.join(root, "netlify/functions/amare-notification-send.mjs"),
  path.join(root, "netlify/functions/amare-notification-copy.mjs"),
  path.join(root, "netlify/functions/mindbody-class-book-lib.mjs"),
  path.join(root, "netlify/functions/stripe-mindbody-sync-lib.mjs"),
];

const amareAuthReloadFiles = new Map([
  ["/api/amare/auth/session", "amare-auth-session.mjs"],
  ["/api/amare/auth/logout", "amare-auth-logout.mjs"],
  ["/api/amare/auth/logout/all", "amare-auth-logout-all.mjs"],
  ["/api/amare/auth/google/start", "amare-auth-google-start.mjs"],
  ["/api/amare/auth/google/callback", "amare-auth-google-callback.mjs"],
  ["/api/amare/auth/claim/confirm", "amare-auth-claim-confirm.mjs"],
  ["/api/amare/auth/email/request-code", "amare-auth-email-request.mjs"],
  ["/api/amare/auth/email/verify-code", "amare-auth-email-verify.mjs"],
  ["/api/amare/auth/member-access", "amare-auth-member-access.mjs"],
  ["/api/amare/auth/account/delete", "amare-auth-account-delete.mjs"],
  ["/api/amare/commerce/status", "amare-commerce-status.mjs"],
  ["/api/amare/commerce/catalog", "amare-commerce-catalog.mjs"],
  ["/api/amare/commerce/app-checkout-start", "amare-commerce-app-checkout.mjs"],
  ["/api/amare/commerce/app-checkout-open", "amare-commerce-app-checkout.mjs"],
  ["/api/amare/commerce/mobile/prepare", "amare-commerce-mobile-payments.mjs"],
  ["/api/amare/commerce/mobile/status", "amare-commerce-mobile-payments.mjs"],
  ["/api/amare/commerce/mobile/pending", "amare-commerce-mobile-payments.mjs"],
  ["/api/amare/auth/association/link", "amare-auth-association-link.mjs"],
  ["/api/amare/auth/profile/begin", "amare-auth-profile-begin.mjs"],
  ["/api/amare/auth/profile/create", "amare-auth-profile-create.mjs"],
  ["/api/amare/notifications/installation", "amare-notification-install.mjs"],
  ["/api/amare/notifications/preferences", "amare-notification-prefs.mjs"],
  ["/api/amare/notifications/test-send", "amare-notification-test-send.mjs"],
]);

async function loadAmareAuthHandler(fnFile) {
  return loadHandlerFromPath(path.join(root, "netlify/functions", fnFile), amareAuthLibReloadPaths);
}

async function loadStaffScheduleAdminHandler() {
  return loadHandlerFromPath(staffScheduleAdminFnPath, [
    path.join(root, "netlify/functions/staff-schedule-lib.mjs"),
    path.join(root, "netlify/functions/staff-schedule-store.mjs"),
    path.join(root, "netlify/functions/staff-schedule-class-hours.mjs"),
    path.join(root, "netlify/functions/staff-schedule-email.mjs"),
    path.join(root, "netlify/functions/staff-schedule-availability-window.mjs"),
  ]);
}

async function loadGuestPassDevResetHandler() {
  return loadHandlerFromPath(guestPassDevResetFnPath, [guestPassLibPath]);
}

/** @type {import("node:child_process").ChildProcess | null} */
let localIdentityDbKeeper = null;

function amareAuthLocallyEnabled() {
  return (
    (process.env.ENABLE_AMARE_AUTH || "").trim() === "1" &&
    ((process.env.ENABLE_AMARE_AUTH_EMAIL_OTP || "").trim() === "1" ||
      (process.env.ENABLE_AMARE_AUTH_GOOGLE || "").trim() === "1" ||
      (process.env.ENABLE_AMARE_SESS_ISSUE || "").trim() === "1")
  );
}

function isLocalDatabaseUrl(url) {
  return /localhost|127\.0\.0\.1|\.local(?:[:/]|$)/i.test(String(url || ""));
}

/** @param {string} url */
async function probeLocalDatabaseUrl(url) {
  try {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2500 });
    await client.connect();
    await client.query("SELECT 1");
    await client.end();
    return true;
  } catch {
    return false;
  }
}

/** @param {import("node:child_process").ChildProcess} child */
function attachLocalIdentityDbKeeper(child) {
  localIdentityDbKeeper = child;
  const drain = () => {};
  child.stdout.on("data", drain);
  child.stderr.on("data", drain);
  child.once("exit", (code) => {
    console.warn(
      `[dev] AMARÉ local identity DB proxy exited (${code ?? "?"}). ` +
        `OTP / AMARÉ auth DB calls will fail until you restart \`npm run dev\`.`,
    );
    localIdentityDbKeeper = null;
    delete process.env.NETLIFY_DB_URL;
    delete process.env.NETLIFY_DATABASE_URL;
    delete process.env.DATABASE_URL;
  });
}

async function spawnLocalIdentityDbKeeper() {
  const child = spawn(process.execPath, [path.join(root, "node_modules/netlify-cli/bin/run.js"), "database", "connect"], {
    cwd: root,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const url = await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => {
      reject(new Error("local_netlify_db_connect_timeout"));
    }, 45000);
    const onData = (chunk) => {
      buf += String(chunk);
      const match = buf.match(/postgres:\/\/\S+/);
      if (match) {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        child.stderr.off("data", onData);
        resolve(match[0].replace(/[.,;]+$/, ""));
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`local_netlify_db_connect_exited:${code}`));
    });
  });
  if (!isLocalDatabaseUrl(url)) {
    throw new Error("local_netlify_db_url_not_local");
  }
  attachLocalIdentityDbKeeper(child);
  process.env.NETLIFY_DB_URL = url;
  console.log(`[dev] AMARÉ local identity DB: connected (${url})`);
  return url;
}

async function ensureLocalIdentityDb() {
  if (!amareAuthLocallyEnabled()) return;
  const existing = (
    process.env.NETLIFY_DB_URL ||
    process.env.NETLIFY_DATABASE_URL ||
    process.env.DATABASE_URL ||
    ""
  ).trim();
  if (existing) {
    if (!isLocalDatabaseUrl(existing)) {
      console.warn("[dev] AMARÉ identity DB URL is not local; refusing to use it in unified-local-dev.");
      delete process.env.NETLIFY_DB_URL;
      delete process.env.NETLIFY_DATABASE_URL;
      delete process.env.DATABASE_URL;
    } else if (await probeLocalDatabaseUrl(existing)) {
      process.env.NETLIFY_DB_URL = existing;
      console.log(`[dev] AMARÉ local identity DB: reusing ${existing}`);
      return;
    } else {
      console.warn(
        "[dev] Stale local NETLIFY_DB_URL (connection refused). Spawning a fresh Netlify Database proxy…",
      );
      delete process.env.NETLIFY_DB_URL;
      delete process.env.NETLIFY_DATABASE_URL;
      delete process.env.DATABASE_URL;
    }
  }
  await spawnLocalIdentityDbKeeper();
}

if (process.argv.includes("--lan") && !process.env.LOCAL_FULL_DEV_HOST) {
  process.env.LOCAL_FULL_DEV_HOST = "0.0.0.0";
}

const port =
  Number(process.env.LOCAL_FULL_DEV_PORT ?? process.env.PORT ?? 4321) || 4321;

/** Bind address: `127.0.0.1` by default. Use `0.0.0.0` if your tunnel (ngrok, Docker, WSL edge) cannot reach loopback. */
const listenHost = (process.env.LOCAL_FULL_DEV_HOST || "127.0.0.1").trim() || "127.0.0.1";

/** @type {Record<string,string>} */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

function build() {
  execSync("node scripts/build.mjs", { cwd: root, stdio: "inherit", env: process.env });
}

if (!(process.env.MINDBODY_SESSION_SECRET || "").trim()) {
  console.error(
    "[dev] MINDBODY_SESSION_SECRET is missing — OAuth session/member endpoints will crash (Missing environment variable).\n    Set it in .env (any long random string). See .env.example.",
  );
  process.exit(1);
}

console.log("[dev:full] Initial build...");
try {
  build();
} catch (e) {
  console.error("[dev:full] Build failed:", e?.message ?? e);
  process.exit(1);
}

const patterns = [
  path.join(root, "src"),
  path.join(root, "public"),
  path.join(root, "scripts", "build.mjs"),
];

let timer;
const watcher = chokidar.watch(patterns, { ignoreInitial: true });

watcher.on("all", () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      console.log("[dev:full] Change detected — rebuilding...");
      build();
      console.log("[dev:full] Done — refresh the browser.");
    } catch (e) {
      console.error("[dev:full] Build failed:", e?.message ?? e);
    }
  }, 280);
});

function underDist(candidateAbs) {
  const resolvedDist = path.resolve(dist);
  const resolvedFile = path.resolve(candidateAbs);
  const rel = path.relative(resolvedDist, resolvedFile);
  return rel !== "" && !rel.startsWith(".." + path.sep) && rel !== "..";
}

function statFileIfSafe(absJoined) {
  if (!underDist(absJoined) || !fs.existsSync(absJoined)) return null;
  const st = fs.statSync(absJoined);
  return st.isFile() ? absJoined : null;
}

/** @param {string} urlPathname */
function safeResolvedFile(urlPathname) {
  const decoded = decodeURIComponent(urlPathname.split("?")[0] ?? "/");
  if (decoded.includes("\0")) return null;

  let rel =
    decoded === "/" || decoded === "" ? "index.html" : decoded.replace(/^\/+/, "");

  const tryHtmlName = `${rel.replace(/\/$/, "")}.html`;

  /** @type {string[]} */
  const candidates = [];
  const norm = rel.replace(/^\/+|\/+$/g, "").toLowerCase();
  /**
   * Legacy `/classes-api` and `/pricing-api` were merged into `/classes` and `/pricing`
   * (the API-powered pages are now the primary versions). The 301 redirects in
   * `public/_redirects` only apply on Netlify, so for local dev we transparently
   * serve the new files when the old paths are requested — keeps existing browser
   * bookmarks and copy/pasted URLs working without a manual refresh.
   */
  if (norm === "classes-api" || norm === "classes-api/") {
    candidates.push("classes.html");
  }
  if (norm === "pricing-api" || norm === "pricing-api/") {
    candidates.push("pricing.html");
  }
  if (norm === "member" || norm === "member/") {
    candidates.push("member.html");
  }

  candidates.push(rel, tryHtmlName, path.posix.join(rel, "index.html"));

  for (let c of candidates) {
    c = path.posix.normalize(c).replace(/^(\.\.(\/|$))+/, "").replace(/^\/+/, "");
    const abs = path.join(dist, ...c.split("/"));
    const hit = statFileIfSafe(abs);
    if (hit) return hit;
  }
  return null;
}

async function runOAuth(req, res, url, handlerFn) {
  const ev = await toNetlifyEvent(req, url);
  try {
    const out = await handlerFn(ev);
    sendLambdaHttpResponse(res, out);
  } catch (e) {
    const msg = String(e?.message ?? e);
    console.error("[dev] Netlify-style handler threw:", e);
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    applyDevMobileCors(req, res);
    res.end(
      JSON.stringify({
        ok: false,
        error: "oauth_handler_exception",
        detail: msg.slice(0, 400),
      }),
    );
  }
}

const oauthRoutes = new Map([
  ["/api/mindbody/oauth/start", hOAuthStart],
  ["/api/mindbody/oauth/callback", hOAuthCallback],
  ["/api/mindbody/oauth/session", hOAuthSession],
  ["/api/mindbody/oauth/logout", hOAuthLogout],
  ["/api/mindbody/oauth/complete-studio-profile", hOAuthCompleteStudioProfile],
  ["/api/mindbody/oauth/mobile-exchange", hOAuthMobileExchange],
  ["/api/mindbody/oauth/mobile-refresh", hOAuthMobileRefresh],
  ["/api/mindbody/oauth/mobile-revoke", hOAuthMobileRevoke],
  ["/api/mindbody/oauth/mobile-bridge", hOAuthMobileBridge],
  ["/api/mindbody/member/summary", hMemberSummary],
  ["/api/mindbody/class/book", hClassBook],
  ["/api/mindbody/classes/anonymous-book-intent", hAnonymousBookIntent],
  ["/api/mindbody/class/cancel", hClassCancel],
  ["/api/mindbody/class/waitlist/remove", hClassWaitlistRemove],
  ["/api/mindbody/webhooks/schedule", hWebhooksSchedule],
  ["/api/mindbody/sale/checkout", hSaleCheckout],
  ["/api/mindbody/sale/purchase-contract", hSalePurchaseContract],
  ["/api/mindbody/sale/checkout-warmup", hSaleCheckoutWarmup],
  ["/api/mindbody/client/stored-cards", hClientStoredCards],
  ["/api/mindbody/client/register", hClientRegister],
  ["/api/stripe/checkout/create-session", hStripeCreateCheckoutSession],
  ["/api/stripe/events/create-deposit", hStripeEventCreateDeposit],
  ["/api/stripe/webhook", hStripeWebhook],
  ["/api/stripe/order-status", hStripeOrderStatus],
  ["/api/stripe/deferred-book/confirm-email", hStripeDeferredBookConfirmEmail],
  ["/api/stripe/admin/orders", hStripeAdminOrders],
  ["/api/stripe/admin/orders/retry", hStripeAdminOrders],
  ["/api/stripe/admin/orders/resolve", hStripeAdminOrders],
  ["/api/stripe/admin/subscriptions", hStripeAdminSubscriptions],
  ["/api/stripe/admin/subscriptions/failures", hStripeAdminSubscriptions],
  ["/api/stripe/admin/subscriptions/retry-sync", hStripeAdminSubscriptions],
  ["/api/stripe/admin/subscriptions/abandon", hStripeAdminSubscriptions],
  ["/api/admin/new-client-sms/run", hNewClientSmsScan],
  ["/api/admin/new-client-sms/seed-report/status", hNewClientSmsSeedStatus],
  ["/api/admin/follow-ups/run", hFollowUpDashboardRun],
  ["/api/admin/follow-ups/low-credits/run", hFollowUpLowCreditsRun],
  ["/api/admin/follow-ups/classpass/run", hFollowUpClassPassRun],
  ["/api/admin/follow-ups/classpass/seed-report/status", hFollowUpVisitsSeedStatus],
  ["/api/admin/follow-ups/send-report", hFollowUpSendReport],
  ["/api/admin/follow-ups/actions", hFollowUpActions],
  ["/api/benefits/public/list", hBenefitsPublicList],
  ["/api/benefits/member/list", hBenefitsMemberList],
  ["/api/benefits/member/badge", hBenefitsMemberBadge],
  ["/api/benefits/member/issue-token", hBenefitsIssueToken],
  ["/api/benefits/redeem/validate", hBenefitsRedeemValidate],
  ["/api/benefits/redeem/confirm", hBenefitsRedeemConfirm],
  ["/api/admin/benefits/list", hBenefitsAdmin],
  ["/api/admin/benefits/create", hBenefitsAdmin],
  ["/api/admin/benefits/update", hBenefitsAdmin],
  ["/api/admin/benefits/redemptions", hBenefitsAdmin],
  ["/api/admin/benefits/redemptions/export", hBenefitsAdmin],
  ["/api/admin/login", hAdminLogin],
  ["/api/amare/auth/session", hAmareAuthSession],
  ["/api/amare/auth/logout", hAmareAuthLogout],
  ["/api/amare/auth/logout/all", hAmareAuthLogoutAll],
  ["/api/amare/auth/google/start", hAmareAuthGoogleStart],
  ["/api/amare/auth/google/callback", hAmareAuthGoogleCallback],
  ["/api/amare/auth/claim/confirm", hAmareAuthClaimConfirm],
  ["/api/amare/auth/email/request-code", hAmareAuthEmailRequest],
  ["/api/amare/auth/email/verify-code", hAmareAuthEmailVerify],
  ["/api/amare/auth/member-access", hAmareAuthMemberAccess],
  ["/api/amare/auth/account/delete", hAmareAuthAccountDelete],
  ["/api/amare/commerce/status", hAmareCommerceStatus],
  ["/api/amare/auth/association/link", hAmareAuthAssociationLink],
  ["/api/events/inquiry", hEventInquirySubmit],
  ["/api/contact", hContactSubmit],
  ["/api/events/offer", hEventOfferPublic],
  ["/api/admin/events/list", hEventReservationsAdmin],
  ["/api/admin/events/forms", hEventReservationsAdmin],
  ["/api/admin/events/offers", hEventReservationsAdmin],
  ["/api/admin/events/manual", hEventReservationsAdmin],
  ["/api/admin/events/confirm", hEventReservationsAdmin],
  ["/api/admin/events/charge-overtime", hEventReservationsAdmin],
  ["/api/admin/events/charge-custom", hEventReservationsAdmin],
  ["/api/admin/events/charge-remaining", hEventReservationsAdmin],
  ["/api/admin/events/cancel", hEventReservationsAdmin],
  ["/api/admin/events/delete", hEventReservationsAdmin],
  ["/api/admin/events/archive", hEventReservationsAdmin],
  ["/api/admin/events/unarchive", hEventReservationsAdmin],
  ["/api/admin/events/reschedule", hEventReservationsAdmin],
  ["/api/admin/events/update", hEventReservationsAdmin],
  ["/api/admin/events/send-details", hEventReservationsAdmin],
  ["/api/admin/events/send-booking", hEventReservationsAdmin],
  ["/api/admin/events/activity", hEventReservationsAdmin],
]);

const srv = http.createServer((req, res) => {
  if (!req.url) {
    res.statusCode = 400;
    res.end("Bad Request");
    return;
  }

  const url = new URL(req.url, `http://127.0.0.1:${port}`);

  if (String(req.method || "").toUpperCase() === "OPTIONS" && url.pathname.startsWith("/api/")) {
    applyDevMobileCors(req, res);
    res.statusCode = 204;
    res.setHeader("Cache-Control", "no-store");
    res.end();
    return;
  }

  if (url.pathname.startsWith("/api/admin/staff-schedule/")) {
    void (async () => {
      try {
        const handler = await loadStaffScheduleAdminHandler();
        void runOAuth(req, res, url, handler);
      } catch (e) {
        console.error("[dev] staff-schedule handler load failed:", e);
        res.statusCode = 500;
        res.end(JSON.stringify({ ok: false, error: "handler_load_failed" }));
      }
    })();
    return;
  }

  if (url.pathname === "/api/staff-schedule/availability") {
    void (async () => {
      try {
        const handler = await loadStaffScheduleAvailabilityHandler();
        void runOAuth(req, res, url, handler);
      } catch (e) {
        console.error("[dev] staff-schedule availability handler load failed:", e);
        res.statusCode = 500;
        res.end(JSON.stringify({ ok: false, error: "handler_load_failed" }));
      }
    })();
    return;
  }

  if (url.pathname === "/api/stripe/checkout/create-session") {
    void (async () => {
      try {
        const handler = await loadHandlerFromPath(path.join(root, "netlify/functions/stripe-create-checkout-session.mjs"), [
          path.join(root, "netlify/functions/amare-studio-lib.mjs"),
          path.join(root, "netlify/functions/amare-commerce-lib.mjs"),
          path.join(root, "netlify/functions/amare-auth-member-access.mjs"),
          path.join(root, "netlify/functions/amare-identity-store.mjs"),
          path.join(root, "netlify/functions/amare-sess-lib.mjs"),
          path.join(root, "netlify/functions/mobile-auth-lib.mjs"),
          path.join(root, "netlify/functions/stripe-mindbody-sync-lib.mjs"),
        ]);
        void runOAuth(req, res, url, handler);
      } catch (e) {
        console.error("[dev] Stripe create-session handler load failed:", e);
        res.statusCode = 500;
        res.end(JSON.stringify({ ok: false, error: "handler_load_failed" }));
      }
    })();
    return;
  }

  const amareAuthFn = amareAuthReloadFiles.get(url.pathname);
  if (amareAuthFn) {
    void (async () => {
      try {
        const handler = await loadAmareAuthHandler(amareAuthFn);
        void runOAuth(req, res, url, handler);
      } catch (e) {
        console.error("[dev] AMARÉ auth handler load failed:", e);
        applyDevMobileCors(req, res);
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ ok: false, error: "handler_load_failed" }));
      }
    })();
    return;
  }

  const oauthHandler = oauthRoutes.get(url.pathname);
  if (oauthHandler) {
    void runOAuth(req, res, url, oauthHandler);
    return;
  }

  if (url.pathname === "/api/mindbody/member/bring-a-friend/status") {
    void (async () => {
      try {
        const handler = await loadBringAFriendStatusHandler();
        void runOAuth(req, res, url, handler);
      } catch (e) {
        console.error("[dev] bring-a-friend status handler load failed:", e);
        res.statusCode = 500;
        res.end(JSON.stringify({ ok: false, error: "handler_load_failed" }));
      }
    })();
    return;
  }

  if (url.pathname === "/api/mindbody/member/top-up/status") {
    void (async () => {
      try {
        const handler = await loadMemberTopUpStatusHandler();
        void runOAuth(req, res, url, handler);
      } catch (e) {
        console.error("[dev] member top-up status handler load failed:", e);
        res.statusCode = 500;
        res.end(JSON.stringify({ ok: false, error: "handler_load_failed" }));
      }
    })();
    return;
  }

  if (url.pathname === "/api/mindbody/member/top-up/release") {
    void (async () => {
      try {
        const handler = await loadMemberTopUpReleaseHandler();
        void runOAuth(req, res, url, handler);
      } catch (e) {
        console.error("[dev] member top-up release handler load failed:", e);
        res.statusCode = 500;
        res.end(JSON.stringify({ ok: false, error: "handler_load_failed" }));
      }
    })();
    return;
  }

  if (url.pathname === "/api/mindbody/member/bring-a-friend") {
    void (async () => {
      try {
        const handler = await loadBringAFriendHandler();
        void runOAuth(req, res, url, handler);
      } catch (e) {
        console.error("[dev] bring-a-friend handler load failed:", e);
        res.statusCode = 500;
        res.end(JSON.stringify({ ok: false, error: "handler_load_failed" }));
      }
    })();
    return;
  }

  if (url.pathname === "/api/dev/guest-pass/reset" && req.method === "POST") {
    void (async () => {
      try {
        const handler = await loadGuestPassDevResetHandler();
        void runOAuth(req, res, url, handler);
      } catch (e) {
        console.error("[dev] guest-pass reset handler load failed:", e);
        res.statusCode = 500;
        res.end(JSON.stringify({ ok: false, error: "handler_load_failed" }));
      }
    })();
    return;
  }

  if (url.pathname === "/api/mindbody/sale/services") {
    void runOAuth(req, res, url, hSaleServices);
    return;
  }

  if (url.pathname === "/api/mindbody/sale/contracts") {
    void runOAuth(req, res, url, hSaleContracts);
    return;
  }

  // Route `class/classes` and `site/sites` through the same Netlify Function code
  // that runs in production so the PR-1 cache headers (`Netlify-CDN-Cache-Control`,
  // `Netlify-Cache-Tag`) are observable in local dev via curl. Otherwise these GETs
  // would be absorbed by the legacy `handleMindbodyPublicRoutes` proxy below, which
  // bypasses the function and never emits cache headers.
  if (url.pathname === "/api/mindbody/class/classes") {
    void (async () => {
      try {
        const handler = await loadClassClassesHandler();
        void runOAuth(req, res, url, handler);
      } catch (e) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ ok: false, error: "DevHandlerLoadFailed", message: String(e?.message ?? e) }));
      }
    })();
    return;
  }

  if (url.pathname === "/api/mindbody/site/sites") {
    void runOAuth(req, res, url, hSiteSites);
    return;
  }

  if (handleMindbodyPublicRoutes(req, res, url, port)) return;

  const file = safeResolvedFile(url.pathname);
  if (!file || !fs.existsSync(file)) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Not found");
    return;
  }

  const ext = path.extname(file).toLowerCase();
  res.statusCode = 200;
  res.setHeader(
    "Content-Type",
    MIME[ext] || "application/octet-stream",
  );
  fs.createReadStream(file).pipe(res);
});

await ensureLocalIdentityDb();

srv.listen(port, listenHost, () => {
  console.log(`\n[dev] http://${listenHost === "0.0.0.0" ? "127.0.0.1" : listenHost}:${port}/`);
  if (listenHost === "0.0.0.0") {
    console.log(`     (listening on 0.0.0.0:${port} — reachable from tunnels / LAN)`);
    try {
      for (const [name, list] of Object.entries(os.networkInterfaces())) {
        for (const entry of list || []) {
          if (entry.family === "IPv4" && !entry.internal) {
            console.log(`     LAN: http://${entry.address}:${port}/  (${name})`);
          }
        }
      }
    } catch {
      /* ignore */
    }
  }
  console.log(`     Serving static files from ${dist}`);
  console.log(
    `     Static + Mindbody GET/API + OAuth — same Netlify function code, no deploy needed.`,
  );
  console.log(
    `     Tunnel tip: ngrok/cloudflared MUST forward to THIS port (${port}), not MINDBODY_LOCAL_PORT (8787) — ` +
      `8787 serves only GET /health + /api/mindbody/* and returns 404 for /css/*.`,
  );
  const sco = (process.env.MINDBODY_OAUTH_SCOPES || "").trim();
  if (
    sco &&
    !/\bMindbody\.Api\.Public\.v6\b/.test(sco)
  ) {
    console.warn(
      `[dev] MINDBODY_OAUTH_SCOPES is set but lacks Mindbody.Api.Public.v6 — member API calls return 401 (scope required).`,
    );
    console.warn(
      `     Add: Mindbody.Api.Public.v6  then Sign out → Sign in again to refresh consent.`,
    );
  }

  const redir = (process.env.MINDBODY_OAUTH_REDIRECT_URI || "").trim();
  if (/^http:\/\/(localhost|127\.0\.0\.1)/i.test(redir)) {
    console.warn(
      `[dev] Mindbody OAuth: MINDBODY_OAUTH_REDIRECT_URI uses plain http on localhost.`,
    );
    console.warn(
      `     The developer portal usually rejects this; sign-in fails with invalid-parameters.`,
    );
    console.warn(
      `     Use HTTPS (production / Netlify preview / ngrok-or-cloudflare tunnel) or see docs/MINDBODY.md § Auth.`,
    );
  } else if (!redir) {
    console.warn(`[dev] MINDBODY_OAUTH_REDIRECT_URI is not set — OAuth start will fail.`);
  }

  const mobileAuth = (process.env.ENABLE_MOBILE_BEARER_AUTH || "").trim();
  if (mobileAuth === "1" || mobileAuth.toLowerCase() === "true") {
    console.log(`     Mobile Bearer auth: ON (platform=mobile → app callback; APIs accept Bearer).`);
  } else {
    console.warn(
      `[dev] Mobile Bearer auth: OFF — add ENABLE_MOBILE_BEARER_AUTH=1 to .env and restart for app sign-in + booking.`,
    );
    console.warn(
      `     OAuth from the app still returns to http://127.0.0.1:5178/auth/callback, but token exchange will fail until the flag is on.`,
    );
  }
  console.log(
    `     Admin follow-up APIs: /api/admin/follow-ups/run, …/low-credits/run, …/classpass/run, …/send-report, …/actions`,
  );
  const googleRedirect = (process.env.GOOGLE_OAUTH_REDIRECT_URI || "").trim();
  if ((process.env.ENABLE_AMARE_AUTH || "").trim() === "1" && (process.env.ENABLE_AMARE_AUTH_GOOGLE || "").trim() === "1") {
    console.log(`     AMARÉ Google Auth: ON`);
    console.log(`     Google redirect_uri (explicit env, not SITE_URL): ${googleRedirect || "(unset)"}`);
  } else {
    console.log(`     AMARÉ Google Auth: OFF (ENABLE_AMARE_AUTH / ENABLE_AMARE_AUTH_GOOGLE)`);
  }
  if ((process.env.ENABLE_AMARE_AUTH || "").trim() === "1" && (process.env.ENABLE_AMARE_AUTH_EMAIL_OTP || "").trim() === "1") {
    console.log(`     AMARÉ Email OTP: ON (local only; production flag stays off)`);
  } else {
    console.log(`     AMARÉ Email OTP: OFF (ENABLE_AMARE_AUTH / ENABLE_AMARE_AUTH_EMAIL_OTP)`);
  }
  if ((process.env.ENABLE_AMARE_AUTH || "").trim() === "1" && (process.env.ENABLE_AMARE_MEMBER_READ || "").trim() === "1") {
    console.log(`     AMARÉ member-read: ON (local only; production flag stays off)`);
  } else {
    console.log(`     AMARÉ member-read: OFF (ENABLE_AMARE_AUTH / ENABLE_AMARE_MEMBER_READ)`);
  }
  if ((process.env.ENABLE_AMARE_AUTH || "").trim() === "1" && (process.env.ENABLE_AMARE_STUDIO_OPERATIONS || "").trim() === "1") {
    console.log(`     AMARÉ studio operations: ON (local only; production flag stays off)`);
  } else {
    console.log(`     AMARÉ studio operations: OFF (ENABLE_AMARE_AUTH / ENABLE_AMARE_STUDIO_OPERATIONS)`);
  }
  if ((process.env.ENABLE_AMARE_AUTH || "").trim() === "1" && (process.env.ENABLE_AMARE_COMMERCE || "").trim() === "1") {
    console.log(`     AMARÉ provider-neutral commerce: ON (local only; production flag stays off)`);
  } else {
    console.log(`     AMARÉ provider-neutral commerce: OFF (ENABLE_AMARE_AUTH / ENABLE_AMARE_COMMERCE)`);
  }
  console.log(
    `     (Optional) SCHEDULE_PROXY_BASE only if the UI is served from another origin than this server.\n`,
  );
});

function shutdown() {
  if (localIdentityDbKeeper && !localIdentityDbKeeper.killed) {
    try {
      localIdentityDbKeeper.stdin?.write("\\q\n");
    } catch {
      /* ignore */
    }
    localIdentityDbKeeper.kill();
    localIdentityDbKeeper = null;
  }
  watcher.close().catch(() => {});
  srv.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
