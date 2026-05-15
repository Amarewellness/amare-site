/**
 * One-origin local dev: watch + rebuild dist, serve static files, Mindbody GET proxy,
 * and OAuth Netlify-compatible routes (same handler code as netlify/functions).
 *
 * Usage: npm run dev (or npm run dev:full)
 *
 * Point MINDBODY_OAUTH_REDIRECT_URI at an HTTPS URL allowed in Mindbody (production, preview,
 * or tunnel) — plain http://127.0.0.1 is usually rejected by the portal.
 */
import "./load-env.mjs";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import chokidar from "chokidar";
import { handleMindbodyPublicRoutes } from "./mindbody-public-routes.mjs";
import { toNetlifyEvent, sendLambdaHttpResponse } from "./netlify-handler-http.mjs";

import { handler as hOAuthStart } from "../netlify/functions/mindbody-oauth-start.mjs";
import { handler as hOAuthCallback } from "../netlify/functions/mindbody-oauth-callback.mjs";
import { handler as hOAuthSession } from "../netlify/functions/mindbody-oauth-session.mjs";
import { handler as hOAuthLogout } from "../netlify/functions/mindbody-oauth-logout.mjs";
import { handler as hMemberSummary } from "../netlify/functions/mindbody-member-summary.mjs";
import { handler as hClassBook } from "../netlify/functions/mindbody-class-book.mjs";
import { handler as hClassCancel } from "../netlify/functions/mindbody-class-cancel.mjs";
import { handler as hSaleServices } from "../netlify/functions/mindbody-sale-services.mjs";
import { handler as hSaleContracts } from "../netlify/functions/mindbody-sale-contracts.mjs";
import { handler as hClassClasses } from "../netlify/functions/mindbody-class-classes.mjs";
import { handler as hSiteSites } from "../netlify/functions/mindbody-site-sites.mjs";
import { handler as hSaleCheckout } from "../netlify/functions/mindbody-sale-checkout.mjs";
import { handler as hSalePurchaseContract } from "../netlify/functions/mindbody-sale-purchase-contract.mjs";
import { handler as hSaleCheckoutWarmup } from "../netlify/functions/mindbody-sale-checkout-warmup.mjs";
import { handler as hClientStoredCards } from "../netlify/functions/mindbody-client-stored-cards.mjs";
import { handler as hClientRegister } from "../netlify/functions/mindbody-client-register.mjs";
import { handler as hStripeCreateCheckoutSession } from "../netlify/functions/stripe-create-checkout-session.mjs";
import { handler as hStripeWebhook } from "../netlify/functions/stripe-webhook.mjs";
import { handler as hStripeOrderStatus } from "../netlify/functions/stripe-order-status.mjs";
import { handler as hStripeAdminOrders } from "../netlify/functions/stripe-admin-orders.mjs";
import { handler as hStripeAdminSubscriptions } from "../netlify/functions/stripe-admin-subscriptions.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const dist = path.join(root, "dist");

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
  ["/api/mindbody/member/summary", hMemberSummary],
  ["/api/mindbody/class/book", hClassBook],
  ["/api/mindbody/class/cancel", hClassCancel],
  ["/api/mindbody/sale/checkout", hSaleCheckout],
  ["/api/mindbody/sale/purchase-contract", hSalePurchaseContract],
  ["/api/mindbody/sale/checkout-warmup", hSaleCheckoutWarmup],
  ["/api/mindbody/client/stored-cards", hClientStoredCards],
  ["/api/mindbody/client/register", hClientRegister],
  ["/api/stripe/checkout/create-session", hStripeCreateCheckoutSession],
  ["/api/stripe/webhook", hStripeWebhook],
  ["/api/stripe/order-status", hStripeOrderStatus],
  ["/api/stripe/admin/orders", hStripeAdminOrders],
  ["/api/stripe/admin/orders/retry", hStripeAdminOrders],
  ["/api/stripe/admin/orders/resolve", hStripeAdminOrders],
  ["/api/stripe/admin/subscriptions", hStripeAdminSubscriptions],
  ["/api/stripe/admin/subscriptions/failures", hStripeAdminSubscriptions],
  ["/api/stripe/admin/subscriptions/retry-sync", hStripeAdminSubscriptions],
  ["/api/stripe/admin/subscriptions/abandon", hStripeAdminSubscriptions],
]);

const srv = http.createServer((req, res) => {
  if (!req.url) {
    res.statusCode = 400;
    res.end("Bad Request");
    return;
  }

  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const oauthHandler = oauthRoutes.get(url.pathname);
  if (oauthHandler) {
    void runOAuth(req, res, url, oauthHandler);
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
    void runOAuth(req, res, url, hClassClasses);
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

srv.listen(port, listenHost, () => {
  console.log(`\n[dev] http://${listenHost === "0.0.0.0" ? "127.0.0.1" : listenHost}:${port}/`);
  if (listenHost === "0.0.0.0") console.log(`     (listening on 0.0.0.0:${port} — reachable from tunnels / LAN)`);
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
  console.log(
    `     (Optional) SCHEDULE_PROXY_BASE only if the UI is served from another origin than this server.\n`,
  );
});

function shutdown() {
  watcher.close().catch(() => {});
  srv.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
