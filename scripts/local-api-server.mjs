/**
 * Minimal localhost proxy so the browser never sees MINDBODY_API_KEY.
 * Webhooks TLS / API-Key requirements: https://developers.mindbodyonline.com/WebhooksDocumentation
 * Public API: https://developers.mindbodyonline.com/ui/documentation/public-api
 */
import "./load-env.mjs";
import http from "node:http";
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
        ? { "Transaction-Key": req.headers["transaction-key"] }
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

const port = Number(process.env.MINDBODY_LOCAL_PORT ?? 8787) || 8787;

const srv = http.createServer((req, res) => {
  if (!req.url) {
    sendJson(res, 400, { ok: false, error: "BadRequest" });
    return;
  }
  const url = new URL(req.url, `http://127.0.0.1:${port}`);

  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, {
      ok: true,
      service: "amare-local-mindbody-proxy",
      siteId: envSiteId(),
      host: pickHost(),
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/mindbody/site/sites") {
    forwardMindbody("GET", "/public/v6/site/sites", req, res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/mindbody/class/classes") {
    const qs = url.searchParams.toString();
    const pathFwd = `/public/v6/class/classes${qs ? `?${qs}` : ""}`;
    forwardMindbody("GET", pathFwd, req, res);
    return;
  }

  sendJson(res, 404, {
    ok: false,
    endpoints: [
      "GET /health",
      "GET /api/mindbody/site/sites",
      "GET /api/mindbody/class/classes?StartDateTime=…&EndDateTime=…&HideCanceledClasses=true&Limit=200",
    ],
  });
});

srv.listen(port, "127.0.0.1", () => {
  console.log(`[mindbody-proxy] http://127.0.0.1:${port}/health`);
  console.log(
    `               · GET /api/mindbody/site/sites · GET /api/mindbody/class/classes?…`
  );
});
