/**
 * stripe listen against the same Stripe account as local .env.
 * Does not print secrets.
 *
 * Two concurrent `stripe listen` processes forwarding to the same local webhook
 * caused a duplicate live Mindbody Drop-In (sales 25898 + 25899). This script
 * refuses to start a second *managed* listener. It is a local-dev guard only —
 * production idempotency is the order-scoped fulfillment claim, not "one listener".
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLocalEnv } from "./load-env.mjs";

const LOCK_PATH = join(tmpdir(), "amare-stripe-listen-local.lock");

function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLock() {
  if (!existsSync(LOCK_PATH)) return null;
  try {
    const raw = JSON.parse(readFileSync(LOCK_PATH, "utf8"));
    const pid = Number(raw?.pid);
    if (!pidIsAlive(pid)) {
      unlinkSync(LOCK_PATH);
      return null;
    }
    return { pid, startedAt: raw.startedAt || null };
  } catch {
    return null;
  }
}

const existing = readLock();
if (existing) {
  console.error(
    JSON.stringify({
      event: "stripe_listen_multiple_managed_listeners",
      warning: true,
      existingPid: existing.pid,
      existingStartedAt: existing.startedAt,
      lockPath: LOCK_PATH,
      detail:
        "Another managed stripe listen is already forwarding to http://127.0.0.1:4321/api/stripe/webhook. A second listener will double-deliver checkout.session.completed. Stop the other process first. Production must remain safe under duplicate delivery via the one-time fulfillment claim — do not treat one listener as the idempotency fix.",
    }),
  );
  process.exit(2);
}

loadLocalEnv();
const sk = (process.env.STRIPE_SECRET_KEY || "").trim();
if (!sk.startsWith("sk_test_") && !sk.startsWith("sk_live_")) {
  console.error("stripe_listen_missing_secret_key");
  process.exit(1);
}

writeFileSync(
  LOCK_PATH,
  JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), forwardTo: "http://127.0.0.1:4321/api/stripe/webhook" }),
  "utf8",
);

const child = spawn(
  "stripe",
  ["listen", "--forward-to", "http://127.0.0.1:4321/api/stripe/webhook", "--api-key", sk],
  { stdio: "inherit", windowsHide: true },
);
const clearLock = () => {
  try {
    if (existsSync(LOCK_PATH)) {
      const raw = JSON.parse(readFileSync(LOCK_PATH, "utf8"));
      if (Number(raw?.pid) === process.pid) unlinkSync(LOCK_PATH);
    }
  } catch {
    /* ignore */
  }
};
child.on("exit", (code) => {
  clearLock();
  process.exit(code ?? 1);
});
process.on("exit", clearLock);
process.on("SIGINT", () => {
  clearLock();
  child.kill("SIGINT");
});
process.on("SIGTERM", () => {
  clearLock();
  child.kill("SIGTERM");
});
