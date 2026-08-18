import fs from "node:fs";

const path = process.argv[2] || ".cursor-audit-24h-all-functions.jsonl";
const raw = fs.readFileSync(path, "utf8").trim().split(/\r?\n/).filter(Boolean);
const rows = raw.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

function ev(r) {
  try { return JSON.parse(r.message); } catch { return null; }
}

const events = rows.map((r) => ({ ...r, e: ev(r) })).filter((r) => r.e);

console.log("=== Registration audit ===");
console.log("Lines:", rows.length);

const checkouts = events.filter((r) => r.e.event === "stripe_checkout_session_created");
const synced = events.filter((r) => r.e.event === "stripe_order_synced_to_mindbody");
const expired = events.filter((r) => /checkout_session_expired/.test(r.e.event || ""));
const defIssues = events.filter((r) =>
  /deferred_class_book_(skipped|failed|class_past|class_full|unavailable)/.test(r.e.event || ""),
);
const rejected = events.filter((r) => r.e.event === "stripe_checkout_deferred_book_rejected");
const defSuccess = events.filter((r) => r.e.event === "deferred_class_book_success");
const bookFail = events.filter((r) => r.e.event === "class_book_response" && r.e.ok === false);
const oauthUnresolved = events.filter((r) =>
  ["stripe_oauth_client_id_unresolved", "consumer_resolve_client_not_linked"].includes(r.e.event),
);
const refunds = events.filter((r) => /charge_refunded/.test(r.e.event || ""));

console.log("\nCheckouts:", checkouts.length);
for (const r of checkouts) {
  console.log(`  ${r.timestamp} ${r.e.orderId} ${r.e.localSku} ${r.e.ctaLocation} known=${r.e.knownClient}`);
}

console.log("\nPaid + synced:", synced.length);
for (const r of synced) {
  console.log(`  ${r.timestamp} ${r.e.orderId} client=${r.e.clientId} sku=${r.e.sku} sale=${r.e.mbSaleId}`);
}

console.log("\nExpired checkout (no payment):", expired.length);
for (const r of expired) {
  console.log(`  ${r.timestamp} ${r.e.orderId} ${r.e.localSku}`);
}

console.log("\nDeferred book issues (paid but not booked):", defIssues.length);
for (const r of defIssues) {
  console.log(`  ${r.timestamp} ${r.e.event} order=${r.e.orderId} client=${r.e.clientId} reason=${r.e.reason || r.e.lastError} class=${r.e.classId}`);
}

console.log("\nDeferred book rejected at checkout:", rejected.length);
for (const r of rejected) {
  console.log(`  ${r.timestamp} ${r.e.orderId} ${r.e.reason} ${r.e.ctaLocation}`);
}

console.log("\nDeferred book success:", defSuccess.length);
for (const r of defSuccess) {
  console.log(`  ${r.timestamp} order=${r.e.orderId} client=${r.e.clientId} class=${r.e.classId} visit=${r.e.visitId}`);
}

console.log("\nClass book API failures:", bookFail.length);
for (const r of bookFail) {
  console.log(`  ${r.timestamp} client=${r.e.clientId} class=${r.e.classId} err=${r.e.mindbodyErrorMessage}`);
}

console.log("\nOAuth unresolved (no MB client):", oauthUnresolved.length);
for (const r of oauthUnresolved) {
  console.log(`  ${r.timestamp} ${r.e.event} ${r.e.email}`);
}

console.log("\nRefunds logged:", refunds.length);
for (const r of refunds) {
  console.log(`  ${r.timestamp} ${r.e.event} amount=${r.e.amountRefunded} charge=${r.e.chargeId}`);
}

// Paid but no book: sync without success and with issue
const issueOrders = new Set(defIssues.map((r) => r.e.orderId));
const syncedNoBook = synced.filter((r) => !defSuccess.some((s) => s.e.orderId === r.e.orderId));
console.log("\n=== PAID BUT NOT ON ROSTER (candidates) ===");
for (const r of synced) {
  const orderId = r.e.orderId;
  const issue = defIssues.find((d) => d.e.orderId === orderId);
  const success = defSuccess.find((d) => d.e.orderId === orderId);
  if (issue && !success) {
    console.log(`  ${orderId} client=${r.e.clientId} sku=${r.e.sku} issue=${issue.e.event} reason=${issue.e.reason || issue.e.lastError || "class_past"}`);
  }
}
