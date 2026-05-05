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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const dist = path.join(root, "dist");

const port =
  Number(process.env.LOCAL_FULL_DEV_PORT ?? process.env.PORT ?? 4321) || 4321;

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
};

function build() {
  execSync("node scripts/build.mjs", { cwd: root, stdio: "inherit", env: process.env });
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
  if (norm === "classes-api" || norm === "classes-api/") {
    candidates.push("classes-api.html");
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
    console.error(e);
    res.statusCode = 500;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("OAuth handler error");
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

srv.listen(port, "127.0.0.1", () => {
  console.log(`\n[dev] http://127.0.0.1:${port}/`);
  console.log(
    `     Static + Mindbody GET/API + OAuth — same Netlify function code, no deploy needed.`,
  );
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
