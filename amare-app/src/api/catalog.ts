import { apiJson } from "./client";

export type PurchaseAgreement = {
  contractVersion: string;
  title: string;
  marketingPlanName?: string;
  summaryLines: string[];
  termsHtml: string;
  checkboxAgreementLabel: string;
  checkboxBillingAuthLabel: string;
};

export type PurchaseCatalogItem = {
  localSku: string;
  displayName: string;
  shortName: string;
  description: string;
  amountCents: number;
  currency: string;
  kind: string;
  stripeMode: "payment" | "subscription" | string;
  available: boolean;
  checkoutEnabled: boolean;
  oneTimePerClient: boolean;
  minimumCommitmentMonths: number | null;
  agreement: PurchaseAgreement | null;
};

export type PurchaseCatalogGroup = {
  id: "one_time" | "monthly" | string;
  title: string;
  items: PurchaseCatalogItem[];
};

export type PurchaseCatalog = {
  ok?: boolean;
  currency?: string;
  oneTimeCheckoutEnabled?: boolean;
  recurringCheckoutEnabled?: boolean;
  groups: PurchaseCatalogGroup[];
};

export function formatCatalogPrice(amountCents: number, currency = "usd"): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(amountCents / 100);
  } catch {
    return `$${(amountCents / 100).toFixed(2)}`;
  }
}

export function fetchPurchaseCatalog(accessToken: string | null): Promise<PurchaseCatalog> {
  return apiJson<PurchaseCatalog>("/api/amare/commerce/catalog", accessToken);
}
