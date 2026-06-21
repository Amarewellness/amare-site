/**
 * DRY-RUN audit: find clients billed for the SAME membership through BOTH the
 * Stripe integration AND a native Mindbody payment (Visa/MC, Credit card, autopay).
 *
 * This is the exact failure mode observed for client "virginia solano" on 2026-06-18:
 *   • Sale 9919 — AMARÉ Monthly Unlimited — payment method "Stripe"   (our integration)
 *   • Sale 9912 — AMARÉ Monthly Unlimited — payment method "Visa/MC"  (Mindbody-native autopay)
 *
 * Detection signal (read-only):
 *   Every sale our Stripe → Mindbody webhook posts uses the custom payment method
 *   named MINDBODY_STRIPE_PAYMENT_METHOD_NAME (default "Stripe") and carries PayNotes
 *   like `orderId=…; session=cs_…; sku=…`. ANY membership sale for the same client that
 *   is paid via a different method (Visa/MC / Credit card / Cash / autopay) is a parallel
 *   native charge → duplicate billing risk.
 *
 * What it does:
 *   1. Issue a staff token (usertoken/issue).
 *   2. Paginate GET /public/v6/sale/sales over the last --days window (default 120).
 *   3. Keep only membership-like line items (configurable regex).
 *   4. Group by client; classify each membership sale as "stripe" vs "native".
 *   5. Report clients that have BOTH → hard duplicate signal.
 *
 * It NEVER writes anything. Only POST usertoken/issue (auth) + GET /sale/sales.
 *
 * Usage:
 *   node scripts/audit-duplicate-membership-billing.mjs
 *   node scripts/audit-duplicate-membership-billing.mjs --days=180
 *   node scripts/audit-duplicate-membership-billing.mjs --debug          # dump first sale raw JSON to calibrate fields
 *   node scripts/audit-duplicate-membership-billing.mjs --json           # machine-readable output
 *   node scripts/audit-duplicate-membership-billing.mjs --membership-re="unlimited|monthly|membership"
 *
 * Required env (loaded from .env via scripts/load-env.mjs):
 *   MINDBODY_API_KEY, MINDBODY_SITE_ID, MINDBODY_STAFF_USERNAME, MINDBODY_STAFF_PASSWORD
 *   (optional) MINDBODY_API_HOST, MINDBODY_STRIPE_PAYMENT_METHOD_NAME
 */
import "./load-env.mjs";
import https from "node:https";

const API_VERSION = "6";
const HOST = (process.env.MINDBODY_API_HOST || "api.mindbodyonline.com").trim();
const API_KEY = (process.env.MINDBODY_API_KEY || "").trim();
const SITE_ID = (process.env.MINDBODY_SITE_ID || "-99").trim();
const STAFF_USER = (process.env.MINDBODY_STAFF_USERNAME || "").trim();
const STAFF_PASS = process.env.MINDBODY_STAFF_PASSWORD || "";
const STRIPE_METHOD_NAME = (process.env.MINDBODY_STRIPE_PAYMENT_METHOD_NAME || "Stripe").trim();

/* ---------------------------------------------------------------------------- */
/* CLI args                                                                     */
/* ---------------------------------------------------------------------------- */

function arg(name, fallback = null) {
  const prefix = `--${name}=`;
  for (const a of process.argv) if (a.startsWith(prefix)) return a.slice(prefix.length);
  for (const a of process.argv) if (a === `--${name}`) return "1";
  return fallback;
}

const DAYS = Math.max(1, parseInt(String(arg("days", "120")), 10) || 120);
const DEBUG = !!arg("debug");
const JSON_OUT = !!arg("json");
const PAGE_LIMIT = Math.min(200, Math.max(10, parseInt(String(arg("page-limit", "200")), 10) || 200));
const MAX_PAGES = Math.max(1, parseInt(String(arg("max-pages", "200")), 10) || 200);
const MEMBERSHIP_RE = new RegExp(String(arg("membership-re", "unlimited|monthly|membership")), "i");
/** Item names matching this are NOT memberships even if they hit MEMBERSHIP_RE (false-positive guard). */
const MEMBERSHIP_EXCLUDE_RE = /\b(socks|mat|towel|water|retail|product|gift\s*card)\b/i;

/* ---------------------------------------------------------------------------- */
/* Colors                                                                       */
/* ---------------------------------------------------------------------------- */

const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m", mag: "\x1b[35m",
};
const log = (...a) => console.log(...a);

/* ---------------------------------------------------------------------------- */
/* HTTPS                                                                        */
/* ---------------------------------------------------------------------------- */

function requestJson({ method, path, headers, bodyJson }) {
  return new Promise((resolve, reject) => {
    const body = bodyJson != null ? Buffer.from(JSON.stringify(bodyJson), "utf8") : null;
    const finalHeaders = {
      "API-Key": API_KEY,
      SiteId: SITE_ID,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json", "Content-Length": String(body.length) } : {}),
      ...(headers || {}),
    };
    const req = https.request(
      { hostname: HOST, port: 443, path, method, headers: finalHeaders },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let data = null;
          try { data = raw ? JSON.parse(raw) : null; } catch { data = { _nonJson: true, raw: raw.slice(0, 800) }; }
          resolve({ status: res.statusCode || 0, ok: !!(res.statusCode && res.statusCode < 400), data });
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function issueStaffToken() {
  if (!STAFF_USER || !STAFF_PASS) {
    throw new Error("MINDBODY_STAFF_USERNAME / MINDBODY_STAFF_PASSWORD not set in .env");
  }
  const r = await requestJson({
    method: "POST",
    path: `/public/v${API_VERSION}/usertoken/issue`,
    bodyJson: { Username: STAFF_USER, Password: STAFF_PASS },
  });
  if (!r.ok) throw new Error(`usertoken/issue HTTP ${r.status}: ${JSON.stringify(r.data).slice(0, 400)}`);
  const token = r.data?.AccessToken ?? r.data?.accessToken ?? r.data?.access_token;
  if (!token || typeof token !== "string") throw new Error(`No AccessToken in response: ${JSON.stringify(r.data).slice(0, 400)}`);
  return token;
}

/* ---------------------------------------------------------------------------- */
/* Extraction helpers (defensive — Mindbody field casing varies)                */
/* ---------------------------------------------------------------------------- */

function asArray(v) { return Array.isArray(v) ? v : []; }

function salesFromPayload(data) {
  if (!data || typeof data !== "object") return [];
  return asArray(data.Sales ?? data.sales);
}

function paginationOf(data) {
  const p = data?.PaginationResponse ?? data?.paginationResponse ?? null;
  if (!p || typeof p !== "object") return null;
  return {
    total: Number(p.TotalResults ?? p.totalResults ?? 0) || 0,
    pageSize: Number(p.PageSize ?? p.pageSize ?? 0) || 0,
    offset: Number(p.RequestedOffset ?? p.requestedOffset ?? 0) || 0,
  };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Pull the line items off a Sale (name + signed amount + quantity), defensively across shapes. */
function itemsOfSale(sale) {
  const arr = asArray(sale.PurchasedItems ?? sale.purchasedItems ?? sale.SaleItems ?? sale.Items ?? sale.items);
  const out = [];
  for (const it of arr) {
    if (!it || typeof it !== "object") continue;
    const name =
      it.Description ?? it.description ?? it.Name ?? it.name ??
      it.ProductName ?? it.ServiceName ?? "";
    const qty = num(it.Quantity ?? it.quantity);
    const total =
      num(it.TotalAmount ?? it.totalAmount) ??
      num(it.AmountPaid ?? it.amountPaid) ??
      (num(it.UnitPrice ?? it.unitPrice) != null && qty != null
        ? Number(it.UnitPrice ?? it.unitPrice) * qty
        : num(it.Price ?? it.price));
    out.push({ name: String(name || "").trim(), amount: total, qty, raw: it });
  }
  return out;
}

/**
 * A sale line is a REFUND/return (not a charge) when its amount or quantity is negative.
 * Mindbody represents a returned sale as a separate negative-amount sale row.
 */
function isRefundItem(it) {
  if (it.amount != null && it.amount < 0) return true;
  if (it.qty != null && it.qty < 0) return true;
  return false;
}

/** Pull payment method descriptors off a Sale. Returns array of human strings. */
function paymentsOfSale(sale) {
  const arr = asArray(sale.Payments ?? sale.payments);
  const out = [];
  for (const p of arr) {
    if (!p || typeof p !== "object") continue;
    const method =
      p.Method ?? p.method ?? p.Type ?? p.type ?? p.Name ?? p.name ??
      p.PaymentMethod ?? p.paymentMethod ?? "";
    const notes = p.Notes ?? p.notes ?? p.PayNotes ?? p.payNotes ?? "";
    out.push({
      method: String(method || "").trim(),
      notes: String(notes || "").trim(),
      raw: p,
    });
  }
  return out;
}

/** Is this payment our Stripe integration? Method name "Stripe" OR PayNotes fingerprint. */
function isStripeIntegrationPayment(pay) {
  const m = pay.method.toLowerCase();
  if (m.includes(STRIPE_METHOD_NAME.toLowerCase())) return true;
  const blob = `${pay.method} ${pay.notes} ${safeStr(pay.raw)}`.toLowerCase();
  if (/\bsession=cs_/.test(blob)) return true;
  if (/\borderid=ord_/.test(blob)) return true;
  if (/\bsub_amare_/.test(blob)) return true;
  if (blob.includes("stripe")) return true;
  return false;
}

function safeStr(o) { try { return JSON.stringify(o); } catch { return ""; } }

/**
 * Collapse a membership item name into a canonical "tier" so the SAME membership
 * billed by Stripe and natively is matched even when the Pricing Option names differ
 * (e.g. "AMARÉ Monthly Unlimited" vs legacy "unlimited 1 month"). Returns a stable key.
 */
function canonicalTier(name) {
  const n = String(name || "").toLowerCase();
  if (/unlimited/.test(n)) return "unlimited";
  if (/\b8\b|\beight\b/.test(n)) return "8_classes";
  if (/\b5\b|\bfive\b/.test(n)) return "5_classes";
  if (/\b10\b|\bten\b/.test(n)) return "10_classes";
  if (/\b4\b|\bfour\b/.test(n)) return "4_classes";
  // Fall back to a normalized name so unknown memberships still group consistently.
  return n.replace(/[^a-z]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "other";
}

function clientIdOfSale(sale) {
  const id = sale.ClientId ?? sale.clientId ?? sale.ClientID ?? sale.Client?.Id ?? sale.client?.id;
  if (id == null) return null;
  const s = String(id).trim();
  return s || null;
}

function clientNameOfSale(sale) {
  const c = sale.Client ?? sale.client;
  if (c && typeof c === "object") {
    const fn = c.FirstName ?? c.firstName ?? "";
    const ln = c.LastName ?? c.lastName ?? "";
    const nm = `${fn} ${ln}`.trim();
    if (nm) return nm;
  }
  const direct = sale.ClientName ?? sale.clientName ?? "";
  return String(direct || "").trim();
}

function saleDateOf(sale) {
  const d = sale.SaleDate ?? sale.saleDate ?? sale.SaleDateTime ?? sale.saleDateTime ?? "";
  return String(d || "").trim();
}

function saleIdOf(sale) {
  const id = sale.Id ?? sale.id ?? sale.SaleId ?? sale.saleId;
  return id == null ? "" : String(id);
}

/**
 * Best-effort name + email enrichment for a set of client ids (the sale payload only
 * carries ClientId). Read-only GET /client/clients?request.clientIds=…
 * @param {Record<string,string>} authHeaders
 * @param {string[]} ids
 * @returns {Promise<Map<string,{ name: string; email: string }>>}
 */
async function fetchClientNames(authHeaders, ids) {
  const out = new Map();
  const unique = [...new Set(ids)].filter(Boolean);
  const CHUNK = 50;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const slice = unique.slice(i, i + CHUNK);
    const q = new URLSearchParams();
    for (const id of slice) q.append("request.clientIds", id);
    q.set("request.limit", String(slice.length));
    const r = await requestJson({
      method: "GET",
      path: `/public/v${API_VERSION}/client/clients?${q.toString()}`,
      headers: authHeaders,
    });
    if (!r.ok) continue;
    const list = asArray(r.data?.Clients ?? r.data?.clients);
    for (const c of list) {
      if (!c || typeof c !== "object") continue;
      const id = String(c.Id ?? c.id ?? c.ClientId ?? "").trim();
      if (!id) continue;
      const name = `${c.FirstName ?? ""} ${c.LastName ?? ""}`.trim();
      const email = String(c.Email ?? c.email ?? "").trim();
      out.set(id, { name, email });
    }
  }
  return out;
}

/* ---------------------------------------------------------------------------- */
/* Main                                                                         */
/* ---------------------------------------------------------------------------- */

async function main() {
  if (!API_KEY) throw new Error("MINDBODY_API_KEY not set in .env");

  const now = new Date();
  const start = new Date(now.getTime() - DAYS * 24 * 60 * 60 * 1000);
  const startIso = start.toISOString().slice(0, 19);
  const endIso = now.toISOString().slice(0, 19);

  if (!JSON_OUT) {
    log(`${C.bold}${C.cyan}── Duplicate-membership-billing audit (DRY RUN, read-only) ──${C.reset}`);
    log(`  Site: ${SITE_ID}   Host: ${HOST}`);
    log(`  Window: ${startIso} → ${endIso}  (${DAYS} days)`);
    log(`  Membership match: /${MEMBERSHIP_RE.source}/i   Stripe method: "${STRIPE_METHOD_NAME}"`);
    log("");
  }

  const token = await issueStaffToken();
  const authHeaders = { Authorization: `Bearer ${token}` };

  /**
   * clientId → { name, tiers: Map<tier, { stripe: any[]; native: any[] }> }
   * @type {Map<string, { name: string; tiers: Map<string, { stripe: any[]; native: any[] }> }>}
   */
  const byClient = new Map();
  let totalSales = 0;
  let membershipSales = 0;
  let debugDumped = false;

  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const q = new URLSearchParams();
    q.set("request.StartSaleDateTime", startIso);
    q.set("request.EndSaleDateTime", endIso);
    q.set("request.Limit", String(PAGE_LIMIT));
    q.set("request.Offset", String(offset));
    const r = await requestJson({
      method: "GET",
      path: `/public/v${API_VERSION}/sale/sales?${q.toString()}`,
      headers: authHeaders,
    });
    if (!r.ok) {
      throw new Error(`GET /sale/sales HTTP ${r.status}: ${JSON.stringify(r.data).slice(0, 500)}`);
    }
    const sales = salesFromPayload(r.data);
    if (DEBUG && !debugDumped && sales.length) {
      log(`${C.mag}[debug] first sale raw JSON:${C.reset}`);
      log(JSON.stringify(sales[0], null, 2).slice(0, 4000));
      log("");
      debugDumped = true;
    }
    if (!sales.length) break;
    totalSales += sales.length;

    for (const sale of sales) {
      const items = itemsOfSale(sale);
      const membershipItems = items.filter(
        (it) => it.name && MEMBERSHIP_RE.test(it.name) && !MEMBERSHIP_EXCLUDE_RE.test(it.name),
      );
      if (!membershipItems.length) continue;
      membershipSales += 1;

      const cid = clientIdOfSale(sale);
      if (!cid) continue;
      const pays = paymentsOfSale(sale);
      const anyStripe = pays.some((p) => isStripeIntegrationPayment(p));
      const bucket = anyStripe ? "stripe" : "native";

      const entry = byClient.get(cid) || { name: clientNameOfSale(sale) || "", tiers: new Map() };
      if (!entry.name) entry.name = clientNameOfSale(sale) || "";
      // A single sale can (rarely) carry >1 membership line; bucket each by its own tier.
      for (const it of membershipItems) {
        const tier = canonicalTier(it.name);
        const t = entry.tiers.get(tier) || { stripe: [], native: [], refunds: [] };
        const row = {
          saleId: saleIdOf(sale),
          date: saleDateOf(sale),
          item: it.name,
          amount: it.amount,
          methods: pays.map((p) => p.method || "(unknown)"),
        };
        // Negative-amount lines are refunds/returns — track separately, never count as a charge.
        if (isRefundItem(it)) t.refunds.push({ ...row, bucket });
        else t[bucket].push(row);
        entry.tiers.set(tier, t);
      }
      byClient.set(cid, entry);
    }

    const pg = paginationOf(r.data);
    offset += sales.length;
    if (pg && pg.total && offset >= pg.total) break;
    if (sales.length < PAGE_LIMIT) break;
  }

  /* Flag duplicates: same client + same membership tier billed BOTH via Stripe and natively. */
  const flagged = [];
  for (const [cid, e] of byClient.entries()) {
    for (const [tier, t] of e.tiers.entries()) {
      if (t.stripe.length > 0 && t.native.length > 0) {
        flagged.push({ clientId: cid, name: e.name, email: "", tier, stripe: t.stripe, native: t.native, refunds: t.refunds || [] });
      }
    }
  }
  /* Enrich flagged clients with name + email (sale payload only has ClientId). */
  if (flagged.length) {
    const names = await fetchClientNames(authHeaders, flagged.map((f) => f.clientId));
    for (const f of flagged) {
      const info = names.get(f.clientId);
      if (info) {
        if (!f.name && info.name) f.name = info.name;
        f.email = info.email || "";
      }
    }
  }
  flagged.sort(
    (a, b) => (a.name || "").localeCompare(b.name || "") || a.clientId.localeCompare(b.clientId),
  );

  if (JSON_OUT) {
    log(JSON.stringify({
      window: { startIso, endIso, days: DAYS },
      totals: { totalSales, membershipSales, clientsWithMembership: byClient.size, flagged: flagged.length },
      flagged,
    }, null, 2));
    return;
  }

  log(`${C.dim}Scanned ${totalSales} sales; ${membershipSales} membership sales across ${byClient.size} clients.${C.reset}`);
  log("");
  if (!flagged.length) {
    log(`${C.green}✓ No clients found with BOTH a Stripe membership charge and a native Mindbody membership charge in this window.${C.reset}`);
    log(`${C.dim}  (Note: a scheduled native autopay that has not charged yet within the window will NOT appear here —`);
    log(`   the Mindbody Public API does not expose future autopay schedules. Cross-check with the Mindbody`);
    log(`   Sales → AutoPays report for forward-dated schedules.)${C.reset}`);
    return;
  }

  const flaggedClients = new Set(flagged.map((f) => f.clientId)).size;
  log(`${C.red}${C.bold}⚠ ${flagged.length} duplicate membership(s) across ${flaggedClients} client(s) (same tier billed Stripe + native):${C.reset}`);
  let lastCid = null;
  for (const f of flagged) {
    if (f.clientId !== lastCid) {
      log("");
      log(`  ${C.bold}${f.name || "(unknown name)"}${C.reset}  ${C.dim}clientId=${f.clientId}${f.email ? `  ${f.email}` : ""}${C.reset}`);
      lastCid = f.clientId;
    }
    const refundedIds = new Set((f.refunds || []).map((r) => r.saleId));
    log(`    ${C.mag}tier=${f.tier}${C.reset}  ${C.dim}(stripe charges: ${f.stripe.length}, native charges: ${f.native.length}${f.refunds && f.refunds.length ? `, refunds: ${f.refunds.length}` : ""})${C.reset}`);
    for (const s of f.stripe) {
      log(`      ${C.cyan}STRIPE ${C.reset} sale ${s.saleId}  ${s.date}  [method ${s.methods.join(", ")}]  ${s.item}`);
    }
    for (const s of f.native) {
      log(`      ${C.yellow}NATIVE ${C.reset} sale ${s.saleId}  ${s.date}  [method ${s.methods.join(", ")}]  ${s.item}`);
    }
    for (const r of f.refunds || []) {
      log(`      ${C.green}REFUND ${C.reset} sale ${r.saleId}  ${r.date}  [method ${r.methods.join(", ")}]  ${r.item}  ${C.dim}(${r.bucket} return)${C.reset}`);
    }
  }
  log("");
  log(`${C.dim}DRY RUN — nothing was modified. Verify each in Mindbody → Account Details → Autopay Schedule,`);
  log(`then delete the native autopay schedule for confirmed duplicates.${C.reset}`);
}

main().catch((e) => {
  console.error(`${C.red}audit failed:${C.reset} ${e?.message || e}`);
  process.exitCode = 1;
});
