/**
 * One-shot discovery: dump candidate Mindbody Service (Pricing Option) ids and names so you
 * can pin them in `netlify/functions/_embedded/stripe-mindbody-catalog.config.json`.
 *
 * Usage:
 *   node scripts/stripe-find-mindbody-service-ids.mjs
 *   node scripts/stripe-find-mindbody-service-ids.mjs --filter="new client"
 *
 * Reads `.env` via `scripts/load-env.mjs`. Only needs MINDBODY_API_KEY + MINDBODY_SITE_ID
 * (same auth `GET /api/mindbody/sale/services` uses — no staff token required).
 *
 * Output is grouped to match the catalog kinds (newClient / dropin / packs / monthly).
 * The "monthly" group is shown for awareness only — recurring memberships do NOT belong in
 * the Stripe catalog and must continue to use Mindbody classic / `purchase-contract`.
 */
import "./load-env.mjs";
import https from "node:https";

const host = (process.env.MINDBODY_API_HOST || "api.mindbodyonline.com").trim();
const apiKey = (process.env.MINDBODY_API_KEY || "").trim();
const siteId = (process.env.MINDBODY_SITE_ID || "-99").trim();
const filter = (() => {
  const arg = process.argv.find((a) => a.startsWith("--filter="));
  if (!arg) return "";
  return arg.slice("--filter=".length).trim().toLowerCase();
})();

if (!apiKey) {
  console.error(
    "Missing MINDBODY_API_KEY in .env. See .env.example. (No staff token required for /sale/services.)",
  );
  process.exit(2);
}

const path = `/public/v6/sale/services?SellOnline=true&Limit=200`;
const url = `https://${host}${path}`;

/** @returns {Promise<unknown>} */
function fetchAll() {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: host,
        port: 443,
        path,
        method: "GET",
        headers: {
          "API-Key": apiKey,
          SiteId: siteId,
          Accept: "application/json",
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode && res.statusCode >= 400) {
            console.error(`HTTP ${res.statusCode} GET ${url}`);
            console.error(raw.slice(0, 400));
            process.exitCode = 1;
            resolve(null);
            return;
          }
          try {
            resolve(JSON.parse(raw));
          } catch (e) {
            console.error("Non-JSON response:", raw.slice(0, 400));
            reject(e);
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const NCS_PATTERNS = [/new\s*client/i, /first.{0,8}time/i, /\b3\s*(class|pack|sessions?)\b/i, /triple/i, /intro/i];
const DROPIN_PATTERNS = [/drop.?in/i, /single\s*class/i, /same\s*day/i];
const PACK_PATTERNS = [/\b(5|10|20)\s*(class\s*)?pack\b/i, /\b(5|10|20)\s+class\b.*pack/i];
const MONTHLY_HINTS = [/recurring/i, /unlimited/i, /monthly/i, /membership/i, /subscription/i, /auto.?pay/i, /per\s*month/i];

function classifyName(name) {
  const s = String(name || "").trim();
  if (!s) return "other";
  if (MONTHLY_HINTS.some((re) => re.test(s))) return "monthly";
  if (NCS_PATTERNS.some((re) => re.test(s))) return "newClient";
  if (PACK_PATTERNS.some((re) => re.test(s))) return "packs";
  if (DROPIN_PATTERNS.some((re) => re.test(s))) return "dropin";
  return "other";
}

function rowId(o) {
  const id = o?.Id ?? o?.ID ?? o?.ServiceId ?? o?.ServiceID;
  if (typeof id === "number" && Number.isFinite(id) && id > 0) return Math.trunc(id);
  if (typeof id === "string" && /^\d+$/.test(id.trim())) return parseInt(id.trim(), 10);
  return null;
}

function rowPrice(o) {
  for (const k of ["OnlinePrice", "Price", "PriceWithTax", "OnlinePriceWithTax"]) {
    const v = o?.[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

(async () => {
  const data = await fetchAll();
  if (!data || typeof data !== "object") return;
  const rows = Array.isArray(data.Services)
    ? data.Services
    : Array.isArray(data.services)
      ? data.services
      : [];
  if (!rows.length) {
    console.warn("No /sale/services rows returned. Check MINDBODY_SITE_ID (current:", siteId, ") and credentials.");
    return;
  }

  /** @type {Record<string, { id: number; name: string; price: number | null }[]>} */
  const groups = { newClient: [], dropin: [], packs: [], monthly: [], other: [] };
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const id = rowId(raw);
    const name = String(raw.Name ?? raw.name ?? "").trim();
    if (id == null || !name) continue;
    if (filter && !name.toLowerCase().includes(filter)) continue;
    groups[classifyName(name)].push({ id, name, price: rowPrice(raw) });
  }

  const labelByGroup = {
    newClient: "New Client Special candidates  → catalog `new_client_special_3_for_65`",
    dropin: "Drop-in candidates                → catalog `drop_in_single_class` / `drop_in_same_day`",
    packs: "Class pack candidates              → catalog `pack_5_classes` / `pack_10_classes` / `pack_20_classes`",
    monthly: "Recurring memberships              → DO NOT put in Stripe catalog (Mindbody classic only)",
    other: "Other (review manually)",
  };

  const order = ["newClient", "dropin", "packs", "monthly", "other"];
  for (const k of order) {
    const list = groups[k];
    if (!list.length) continue;
    list.sort((a, b) => a.name.localeCompare(b.name));
    console.log(`\n## ${labelByGroup[k]}`);
    for (const row of list) {
      const priceLabel = row.price != null ? ` $${row.price}` : "";
      console.log(`  ${String(row.id).padStart(8)}  ${row.name}${priceLabel}`);
    }
  }

  console.log(
    "\nPaste the right Id into `mindbodyServiceId` in netlify/functions/_embedded/stripe-mindbody-catalog.config.json.",
  );
  console.log(
    "Recurring memberships (`monthly` group) must NOT be added — they continue through Mindbody classic.",
  );
})();
