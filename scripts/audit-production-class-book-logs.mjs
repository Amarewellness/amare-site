/**
 * Production class-book log audit — run against Netlify function logs (or exported JSONL).
 *
 * Goal: determine whether successful monthly bookings use consumer path or staff fallback,
 * and whether credits were actually consumed (Unpaid Visits in Manager).
 *
 * Netlify CLI (requires site link + auth):
 *   netlify logs:function mindbody-class-book --site <site-id> | node scripts/audit-production-class-book-logs.mjs
 *
 * Or pipe a saved export:
 *   node scripts/audit-production-class-book-logs.mjs < production-class-book.jsonl
 *
 * Looks for correlated events: class_book_request → class_book_response (+ staff fallback markers).
 */
import fs from "node:fs";

/** @param {string} line */
function parseEvent(line) {
  const t = line.trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

/** @param {AsyncIterable<string> | Iterable<string>} lines */
async function auditLines(lines) {
  /** @type {Map<string, Record<string, unknown>>} */
  const byKey = new Map();
  /** @type {Record<string, unknown>[]} */
  const responses = [];

  for await (const line of lines) {
    const ev = parseEvent(line);
    if (!ev || typeof ev.event !== "string") continue;

    if (ev.event === "class_book_response" && ev.ok === true) {
      responses.push(ev);
      continue;
    }

    if (ev.event === "class_book_request" && ev.classId != null) {
      const key = `${ev.classId}:${ev.clientServiceIdProvided ?? "null"}`;
      byKey.set(key, ev);
    }
  }

  let staffFallbackSuccess = 0;
  let consumerOnlySuccess = 0;
  let unknown = 0;

  for (const r of responses) {
    if (r.attemptedStaffPaymentFallback === true) staffFallbackSuccess += 1;
    else if (r.attemptedStaffPaymentFallback === false) consumerOnlySuccess += 1;
    else unknown += 1;
  }

  console.log("=== Production class-book audit ===");
  console.log(`Successful bookings (class_book_response ok:true): ${responses.length}`);
  console.log(`  Consumer-only (attemptedStaffPaymentFallback:false): ${consumerOnlySuccess}`);
  console.log(`  Used staff fallback (attemptedStaffPaymentFallback:true): ${staffFallbackSuccess}`);
  console.log(`  Unknown fallback flag: ${unknown}`);
  console.log("");
  console.log("Manual follow-up for staff-fallback successes:");
  console.log("  1. Mindbody Manager → client Visits → confirm NOT Unpaid Group Classes");
  console.log("  2. Wallet / ClientServices → Remaining decreased by 1");
  console.log("");
  console.log("If consumer-only dominates, local should prioritize fixing consumer path.");
  console.log("If staff-fallback dominates in prod, prod may be returning 200 without consuming credits.");
}

async function main() {
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8");
    const lines = text.split(/\r?\n/);
    await auditLines(lines);
    return;
  }

  console.log(`No stdin — pipe Netlify logs or a JSONL export into this script.
Example:
  netlify logs:function mindbody-class-book | node scripts/audit-production-class-book-logs.mjs`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
