/**
 * Set .env STRIPE_WEBHOOK_SECRET to the CLI secret for the same account as STRIPE_SECRET_KEY.
 * Prints only status — never the secret.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "./load-env.mjs";

loadLocalEnv();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(root, ".env");
const sk = (process.env.STRIPE_SECRET_KEY || "").trim();
if (!sk) {
  console.log("secret_status=missing_stripe_secret_key");
  process.exit(1);
}
const secret = execSync(`stripe listen --print-secret --api-key ${sk}`, { encoding: "utf8" }).trim();
if (!secret.startsWith("whsec_")) {
  console.log("secret_status=missing_cli_secret");
  process.exit(1);
}
const text = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
const match = text.match(/^STRIPE_WEBHOOK_SECRET=(.*)$/m);
const current = match ? match[1].trim().replace(/^['"]|['"]$/g, "") : "";
if (current === secret) {
  console.log("secret_status=match");
  process.exit(0);
}
const line = `STRIPE_WEBHOOK_SECRET=${secret}`;
const next = match
  ? text.replace(/^STRIPE_WEBHOOK_SECRET=.*$/m, line)
  : `${text.replace(/\s*$/, "")}${text ? "\n" : ""}${line}\n`;
fs.writeFileSync(envPath, next);
console.log(current ? "secret_status=updated" : "secret_status=added");
