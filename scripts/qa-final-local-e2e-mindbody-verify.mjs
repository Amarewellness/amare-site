import https from "node:https";
import { loadLocalEnv } from "./load-env.mjs";

loadLocalEnv();

const QA_CLIENT = 100002839;
const PRODUCT = 100134;
const CS_ID = 32942;

async function mbToken() {
  const HOST = process.env.MINDBODY_API_HOST || "api.mindbodyonline.com";
  const body = JSON.stringify({
    Username: process.env.MINDBODY_STAFF_USERNAME,
    Password: process.env.MINDBODY_STAFF_PASSWORD,
  });
  const res = await fetch(`https://${HOST}/public/v6/usertoken/issue`, {
    method: "POST",
    headers: {
      "API-Key": process.env.MINDBODY_API_KEY,
      SiteId: process.env.MINDBODY_SITE_ID || "-99",
      "Content-Type": "application/json",
    },
    body,
  });
  const j = await res.json();
  return j.AccessToken;
}

async function mbGet(path, token) {
  const HOST = process.env.MINDBODY_API_HOST || "api.mindbodyonline.com";
  const res = await fetch(`https://${HOST}${path}`, {
    headers: {
      "API-Key": process.env.MINDBODY_API_KEY,
      SiteId: process.env.MINDBODY_SITE_ID || "-99",
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  return res.json();
}

const token = await mbToken();
const cs = await mbGet(
  `/public/v6/client/clientservices?request.clientId=${QA_CLIENT}&request.limit=200`,
  token,
);
const services = (cs.ClientServices || cs.clientServices || []).filter(
  (s) => Number(s.ProductId ?? s.productId) === PRODUCT,
);
const target = services.find((s) => Number(s.Id ?? s.id) === CS_ID) ?? services.at(-1);
let saleDetail = null;
if (target?.SaleID ?? target?.saleId) {
  const saleId = target.SaleID ?? target.saleId;
  const saleRes = await mbGet(`/public/v6/sale/sales?request.saleId=${saleId}`, token);
  const sale = (saleRes.Sales || saleRes.sales || [])[0];
  const item = (sale?.PurchasedItems || sale?.purchasedItems || [])[0] || {};
  saleDetail = {
    saleId,
    productId: item.Id ?? item.ProductId,
    regularPrice: item.UnitPrice ?? item.Price,
    discount: item.DiscountAmount,
    net: item.TotalAmount,
    payments: (sale?.Payments || sale?.payments || []).map((p) => ({
      method: p.Method ?? p.Type,
      amount: p.Amount,
    })),
  };
}

console.log(
  JSON.stringify(
    {
      clientService: target
        ? {
            id: target.Id ?? target.id,
            count: target.Count ?? target.count,
            remaining: target.Remaining ?? target.remaining,
            activeDate: target.ActiveDate ?? target.activeDate,
            expirationDate: target.ExpirationDate ?? target.expirationDate,
            saleId: target.SaleID ?? target.saleId,
          }
        : null,
      saleDetail,
      product100134Count: services.length,
    },
    null,
    2,
  ),
);
