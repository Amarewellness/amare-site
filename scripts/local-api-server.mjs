/**
 * Minimal localhost proxy so the browser never sees MINDBODY_API_KEY.
 * Webhooks TLS / API-Key requirements: https://developers.mindbodyonline.com/WebhooksDocumentation
 * Public API: https://developers.mindbodyonline.com/ui/documentation/public-api
 */
import "./load-env.mjs";
import http from "node:http";
import { handleMindbodyPublicRoutes } from "./mindbody-public-routes.mjs";

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

const port = Number(process.env.MINDBODY_LOCAL_PORT ?? 8787) || 8787;

const srv = http.createServer((req, res) => {
  if (!req.url) {
    sendJson(res, 400, { ok: false, error: "BadRequest" });
    return;
  }
  const url = new URL(req.url, `http://127.0.0.1:${port}`);

  if (handleMindbodyPublicRoutes(req, res, url, port)) return;

  sendJson(res, 404, {
    ok: false,
    error: "NotFound",
    hint:
      "This is the Mindbody GET proxy only (health + /api/mindbody/*). For full site + /css + /js use `npm run dev` (unified, default :4321) or `npm run preview`, then point your tunnel at that port — not this one.",
    endpoints: [
      "GET /health",
      "GET /api/mindbody/site/sites",
      "GET /api/mindbody/class/classes?StartDateTime=…&EndDateTime=…&HideCanceledClasses=true&Limit=200",
      "GET /api/mindbody/sale/services?SellOnline=true&Limit=200",
      "GET /api/mindbody/sale/contracts?request.locationId=1&request.soldOnline=true&Limit=100",
    ],
  });
});

srv.listen(port, "127.0.0.1", () => {
  console.log(`[mindbody-proxy] http://127.0.0.1:${port}/health`);
  console.log(
    `               · GET /api/mindbody/site/sites · GET …/class/classes?… · GET …/sale/services?… · GET …/sale/contracts?…`,
  );
});
