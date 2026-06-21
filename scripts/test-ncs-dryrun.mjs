/**
 * DRY-RUN test: would Mindbody accept an NCS purchase for a given client?
 *
 * Uses the SAME production code path as the webhook sync
 * (`syncOneTimePurchaseToMindbody`) but with Mindbody `Test: true`, so the cart is
 * validated by Mindbody (including the intro-series purchase-count limit) WITHOUT
 * persisting any sale or charging anyone.
 *
 * Purpose: prove that an authoritative pre-checkout check can detect that a client
 * already used the New Client Special — replacing the fragile keyword/date heuristic
 * in `fetchClientNcsHistory`. Also measures Mindbody round-trip latency.
 *
 * It NEVER writes anything (Test:true) — only POST usertoken/issue (auth) +
 * POST /sale/checkoutshoppingcart with Test:true.
 *
 * Usage:
 *   node scripts/test-ncs-dryrun.mjs                       # default: clientId 100002414 (Chaya), NCS sku
 *   node scripts/test-ncs-dryrun.mjs --clientId=100002414
 *   node scripts/test-ncs-dryrun.mjs --sku=new_client_special_3_for_65 --runs=3
 */
import "./load-env.mjs";
import {
  ncsDuplicateDryRun,
  syncOneTimePurchaseToMindbody,
} from "../netlify/functions/stripe-mindbody-sync-lib.mjs";

function arg(name, fallback = null) {
  const prefix = `--${name}=`;
  for (const a of process.argv) if (a.startsWith(prefix)) return a.slice(prefix.length);
  for (const a of process.argv) if (a === `--${name}`) return "1";
  return fallback;
}

const CLIENT_ID = parseInt(String(arg("clientId", "100002414")), 10);
const SKU = String(arg("sku", "new_client_special_3_for_65"));
const RUNS = Math.max(1, parseInt(String(arg("runs", "2")), 10) || 2);

/**
 * NCS catalog item — values mirror
 * src/content/stripe-mindbody-catalog.config.json. `mindbodyServiceId` is pinned so the
 * helper does not need a /sale/services lookup.
 */
const NCS_ITEM = {
  localSku: "new_client_special_3_for_65",
  displayName: "New Client Special — 3 Classes",
  amountCents: 6500,
  mindbodyItemType: "Service",
  mindbodyServiceId: 100012,
  mindbodyServiceNameMatchAny: ["new client", "3 pack", "first time", "triple"],
  mindbodyServiceNameMatchExclude: ["recurring", "membership", "monthly"],
  kind: "newClient",
};

const ITEMS = {
  new_client_special_3_for_65: NCS_ITEM,
  drop_in_single_class: {
    localSku: "drop_in_single_class",
    displayName: "Drop-In — Single Class",
    amountCents: 4000,
    mindbodyItemType: "Service",
    mindbodyServiceId: 100011,
    mindbodyServiceNameMatchAny: ["single class"],
    mindbodyServiceNameMatchExclude: ["same day"],
    kind: "package",
  },
};

async function main() {
  const item = ITEMS[SKU];
  if (!item) {
    console.error(`Unknown sku: ${SKU}. Known: ${Object.keys(ITEMS).join(", ")}`);
    process.exit(1);
  }

  console.log("─".repeat(72));
  console.log(`NCS dry-run (Test:true) — clientId=${CLIENT_ID} sku=${SKU} runs=${RUNS}`);
  console.log(`serviceId=${item.mindbodyServiceId} amountCents=${item.amountCents}`);
  console.log("─".repeat(72));

  /** @type {number[]} */
  const timings = [];
  for (let i = 1; i <= RUNS; i++) {
    const t0 = performance.now();
    const dry = await ncsDuplicateDryRun({
      clientId: CLIENT_ID,
      amountCents: item.amountCents,
      item,
    });
    const ms = performance.now() - t0;
    timings.push(ms);

    console.log(`\n[run ${i}] ${ms.toFixed(0)} ms  → decision=${dry.decision.toUpperCase()} (mindbody ${dry.elapsedMs} ms)`);
    if (dry.detail) console.log(`         detail=${String(dry.detail).slice(0, 300)}`);
  }

  /**
   * Sale-ID parse verification: a raw Test:true sync returns the parsed `mindbodySaleId`
   * (via shoppingSaleFingerprint). On an ALLOW sku this lets us confirm the parser picks the
   * real SaleId, not a cart line-item Id.
   */
  const raw = await syncOneTimePurchaseToMindbody({
    orderId: `saleidcheck_${Date.now()}`,
    stripeCheckoutSessionId: "cs_saleid_check",
    localSku: item.localSku,
    clientId: CLIENT_ID,
    amountCents: item.amountCents,
    currency: "usd",
    mindbodyTest: true,
    item,
  });
  console.log("\n" + "─".repeat(72));
  if (raw.ok) {
    console.log(`SaleId parse check → mindbodySaleId=${JSON.stringify(raw.mindbodySaleId)} transactionId=${JSON.stringify(raw.mindbodyTransactionId)}`);
  } else {
    console.log(`SaleId parse check → sync not-ok (${raw.reason}); cannot read mindbodySaleId on a blocked sku.`);
  }

  const avg = timings.reduce((a, b) => a + b, 0) / timings.length;
  const warm = timings.length > 1 ? timings.slice(1) : timings;
  const warmAvg = warm.reduce((a, b) => a + b, 0) / warm.length;
  console.log("\n" + "─".repeat(72));
  console.log("Timing summary");
  console.log(`  first call (cold, incl. staff token): ${timings[0].toFixed(0)} ms`);
  console.log(`  warm avg (subsequent calls):          ${warmAvg.toFixed(0)} ms`);
  console.log(`  overall avg:                          ${avg.toFixed(0)} ms`);
  console.log("─".repeat(72));
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
