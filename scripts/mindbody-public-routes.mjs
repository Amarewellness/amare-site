/**
 * Shared GET forwards to Mindbody Public API (Sites, Classes).
 */
import "./load-env.mjs";
import https from "node:https";
import { mbHeaders, pickHost, siteId as envSiteId } from "./mindbody-env.mjs";

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(body);
}

function forwardMindbody(method, pathname, req, res) {
  const host = pickHost();

  /** @type {import("node:https").RequestOptions} */
  const opts = {
    hostname: host,
    port: 443,
    path: pathname,
    method,
    headers: mbHeaders({
      ...(req.headers["transaction-key"]
        ? { "Transaction-Key": /** @type {string} */ (req.headers["transaction-key"]) }
        : {}),
    }),
  };

  const proxy = https.request(opts, (mbRes) => {
    const chunks = [];
    mbRes.on("data", (c) => chunks.push(c));
    mbRes.on("end", () => {
      const buf = Buffer.concat(chunks);
      res.writeHead(mbRes.statusCode ?? 502, {
        "Content-Type": mbRes.headers["content-type"] || "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(buf);
    });
  });
  proxy.on("error", (err) => {
    sendJson(res, 502, {
      ok: false,
      error: "MindbodyUpstreamError",
      message: err.message,
    });
  });
  proxy.end();
}

/**
 * Handle GET /health, /api/mindbody/site/sites, /api/mindbody/class/classes
 * @returns {boolean} true if request was handled
 */
export function handleMindbodyPublicRoutes(req, res, url, portFallback) {
  if (req.method === "OPTIONS") {
    const p = url.pathname;
    if (
      p === "/api/mindbody/site/sites" ||
      p === "/api/mindbody/class/classes" ||
      p === "/health"
    ) {
      sendJson(res, 204, {});
      return true;
    }
    return false;
  }

  if (!req.method || req.method !== "GET") return false;

  if (url.pathname === "/health") {
    sendJson(res, 200, {
      ok: true,
      service: "amare-local-mindbody-proxy",
      siteId: envSiteId(),
      host: pickHost(),
      portHint: portFallback,
    });
    return true;
  }

  if (url.pathname === "/api/mindbody/site/sites") {
    forwardMindbody("GET", "/public/v6/site/sites", req, res);
    return true;
  }

  if (url.pathname === "/api/mindbody/class/classes") {
    const qs = url.searchParams.toString();
    const pathFwd = `/public/v6/class/classes${qs ? `?${qs}` : ""}`;
    forwardMindbody("GET", pathFwd, req, res);
    return true;
  }

  return false;
}
