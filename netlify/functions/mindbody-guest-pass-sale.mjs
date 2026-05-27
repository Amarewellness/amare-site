import {
  MB_API_VERSION,
  fetchMb,
  getMindbodyStaffAccessTokenCached,
} from "./mindbody-consumer-lib.mjs";
import { mindbodyStaffApiHeaders, mindbodyStaffBearerHeaders } from "./mindbody-upstream.mjs";
import { loadGuestPassConfig } from "./guest-pass-catalog-lib.mjs";

/** @returns {Promise<Record<string, string> | null>} */
export async function resolveGuestPassStaffHeaders() {
  const staffUser = process.env.MINDBODY_STAFF_USERNAME?.trim();
  const staffPass = process.env.MINDBODY_STAFF_PASSWORD;
  const hasIssueCreds = Boolean(staffUser && typeof staffPass === "string" && staffPass !== "");
  if (hasIssueCreds) {
    const issued = await getMindbodyStaffAccessTokenCached({ issueTimeoutMs: 8000 });
    if (issued.ok) return mindbodyStaffBearerHeaders(issued.accessToken);
  }
  return mindbodyStaffApiHeaders();
}

/** @param {unknown} data */
export function extractSaleIdFromCheckoutResponse(data) {
  if (!data || typeof data !== "object") return null;
  const d = /** @type {Record<string, unknown>} */ (data);
  for (const path of [
    d.ShoppingCart,
    d.shoppingCart,
    /** @type {Record<string, unknown>|undefined} */ (d.ShoppingCart)?.Sale,
    d.Sale,
    d.shoppingCart?.sale,
    d.sale,
    d,
  ]) {
    if (!path || typeof path !== "object") continue;
    const o = /** @type {Record<string, unknown>} */ (path);
    const id = o.SaleId ?? o.saleId ?? o.Id ?? o.id;
    if (typeof id === "number" && id > 0) return id;
    if (typeof id === "string" && /^\d+$/.test(id)) return parseInt(id, 10);
  }
  return null;
}

/** @param {unknown} data */
function findFailedCartLine(data) {
  if (!data || typeof data !== "object") return null;
  const d = /** @type {Record<string, unknown>} */ (data);
  for (const seg of [d.ShoppingCart, d.shoppingCart, d.Sale, d.sale, d]) {
    if (!seg || typeof seg !== "object") continue;
    for (const key of ["CartItems", "cartItems", "Items", "items"]) {
      const arr = /** @type {Record<string, unknown>} */ (seg)[key];
      if (!Array.isArray(arr)) continue;
      for (let i = 0; i < arr.length; i++) {
        const it = arr[i];
        if (!it || typeof it !== "object") continue;
        const action = /** @type {Record<string, unknown>} */ (it).Action ?? /** @type {Record<string, unknown>} */ (it).action;
        if (typeof action === "string" && /^failed$/i.test(action)) {
          return { index: i, item: it };
        }
      }
    }
  }
  return null;
}

/**
 * Issue Guest Pass via staff CheckoutShoppingCart Comp $0 (Option A).
 * @param {{ guestClientId: number; test?: boolean; staffHeaders: Record<string, string> }} opts
 */
export async function issueGuestPassCompSale(opts) {
  const cfg = loadGuestPassConfig();
  const saleLocationId = parseInt((process.env.MINDBODY_SALE_LOCATION_ID || "0").trim(), 10);
  const compAmountUsd = cfg.unitPriceUsd;
  /** @type {Record<string, unknown>} */
  const checkout = {
    ClientId: String(opts.guestClientId),
    Test: opts.test === true,
    test: opts.test === true,
    Items: [
      {
        Item: {
          Type: "Service",
          Metadata: { Id: cfg.mindbodyServiceId, ServiceId: cfg.mindbodyServiceId },
        },
        Quantity: 1,
      },
    ],
    Payments: [
      {
        Type: "Comp",
        Metadata: { Amount: compAmountUsd, AmountPaid: compAmountUsd },
      },
    ],
    InStore: false,
    SendEmail: false,
  };
  if (Number.isFinite(saleLocationId) && saleLocationId > 0) {
    checkout.LocationId = saleLocationId;
  }
  const r = await fetchMb(
    "POST",
    `/public/v${MB_API_VERSION}/sale/checkoutshoppingcart`,
    opts.staffHeaders,
    checkout,
  );
  if (!r.ok) {
    return { ok: false, status: r.status, data: r.data, error: "mindbody_sale_failed" };
  }
  const failed = findFailedCartLine(r.data);
  if (failed) {
    return { ok: false, status: 400, data: r.data, error: "mindbody_sale_failed", cartFailed: true };
  }
  const saleId = extractSaleIdFromCheckoutResponse(r.data);
  return { ok: true, saleId, data: r.data, issuedAtIso: new Date().toISOString() };
}

/** @param {unknown} data */
function pickClientServicesArray(data) {
  if (!data || typeof data !== "object") return [];
  const d = /** @type {Record<string, unknown>} */ (data);
  const arr = d.ClientServices ?? d.clientServices;
  return Array.isArray(arr) ? arr : [];
}

/**
 * @param {{ guestClientId: number; guestPassServiceId: number; guestPassServiceName: string; issuedAtIso: string; staffHeaders: Record<string, string> }} opts
 */
export async function pickFreshlyIssuedGuestPassServiceId(opts) {
  const q = new URLSearchParams({
    "request.clientId": String(opts.guestClientId),
    "request.showActiveOnly": "false",
    "request.limit": "100",
  });
  const r = await fetchMb(
    "GET",
    `/public/v${MB_API_VERSION}/client/clientservices?${q}`,
    opts.staffHeaders,
    null,
  );
  if (!r.ok) {
    return { ok: false, reason: "guest_pass_not_found_after_sale", mindbody: r.data };
  }
  const issuedMs = Date.parse(opts.issuedAtIso);
  const slackMs = 60_000;
  /** @type {{ id: number; createdMs: number; isLeftover: boolean }[]} */
  const matches = [];
  for (const raw of pickClientServicesArray(r.data)) {
    if (!raw || typeof raw !== "object") continue;
    const row = /** @type {Record<string, unknown>} */ (raw);
    const pid = row.ProductId ?? row.productId ?? row.ServiceId ?? row.serviceId;
    const pidNum =
      typeof pid === "number" ? pid : typeof pid === "string" && /^\d+$/.test(pid) ? parseInt(pid, 10) : NaN;
    if (pidNum !== opts.guestPassServiceId) continue;
    const rem = row.Remaining ?? row.remaining;
    if (rem !== 1 && rem !== "1") continue;
    const name = String(row.Name ?? row.name ?? "");
    if (opts.guestPassServiceName && name && !name.toLowerCase().includes("guest pass")) continue;
    const createdRaw = row.CreatedDateTime ?? row.createdDateTime ?? row.PaymentDate ?? row.SaleDate;
    const createdMs = createdRaw ? Date.parse(String(createdRaw)) : NaN;
    const isRecent = Number.isFinite(createdMs) && Number.isFinite(issuedMs) && createdMs >= issuedMs - slackMs;
    const sid = row.Id ?? row.id ?? row.ClientServiceId ?? row.clientServiceId;
    const idNum =
      typeof sid === "number" ? sid : typeof sid === "string" && /^\d+$/.test(sid) ? parseInt(sid, 10) : NaN;
    if (!Number.isFinite(idNum) || idNum <= 0) continue;
    matches.push({ id: idNum, createdMs: Number.isFinite(createdMs) ? createdMs : 0, isLeftover: !isRecent });
  }
  if (!matches.length) {
    return { ok: false, reason: "guest_pass_not_found_after_sale" };
  }
  matches.sort((a, b) => b.createdMs - a.createdMs);
  const best = matches[0];
  return {
    ok: true,
    clientServiceId: best.id,
    isLeftover: best.isLeftover || matches.length > 1,
  };
}
