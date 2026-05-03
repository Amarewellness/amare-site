/**
 * Sanity check against Mindbody Public API v6 (GET /site/sites).
 * Uses root `.env` if present (`scripts/load-env.mjs`).
 */
import "./load-env.mjs";
import https from "node:https";
import { mbHeaders, pickHost } from "./mindbody-env.mjs";

async function main() {
  const host = pickHost();
  const path = `/public/v6/site/sites`;

  /** @type {import("node:https").RequestOptions} */
  const opts = {
    hostname: host,
    port: 443,
    path,
    method: "GET",
    headers: mbHeaders(),
  };

  await new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        console.log(`HTTP ${res.statusCode} GET https://${host}${path}`);
        try {
          const data = JSON.parse(raw);
          console.log(JSON.stringify(data, null, 2));
        } catch {
          console.log(raw.slice(0, 2000));
        }
        if (res.statusCode && res.statusCode >= 400) process.exitCode = 1;
        resolve();
      });
    });
    req.on("error", reject);
    req.end();
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
