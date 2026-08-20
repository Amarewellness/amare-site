/**
 * Anonymous recurring membership checkout QA.
 * Run: npm run test:anonymous-recurring-membership
 *
 * Pricing UI + existing backend resolution / renewal / claim contracts.
 * Does not charge. Does not mutate production. Does not change fulfillment.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getCatalogItem } from "../netlify/functions/stripe-catalog-lib.mjs";
import { resolveOrCreateMindbodyClient } from "../netlify/functions/stripe-mindbody-sync-lib.mjs";
import {
  newSubscriptionId,
  openSubscriptionStore,
  resetSubscriptionStoreMemoryForTests,
} from "../netlify/functions/stripe-subscription-store.mjs";

process.env.NETLIFY = "";
process.env.STRIPE_SUBSCRIPTION_STORE_LOCAL_MEMORY = "1";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;

function check(name, ok, detail) {
  if (ok) console.log(`PASS — ${name}`);
  else {
    failed += 1;
    console.error(`FAIL — ${name}${detail ? ` (${detail})` : ""}`);
  }
}

function jsonResponse(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(data),
    json: async () => data,
  };
}

function optedInClient(row) {
  return {
    SendScheduleEmails: true,
    SendAccountEmails: true,
    SendPromotionalEmails: true,
    Active: true,
    ...row,
  };
}

function installMindbodyFetchMock({ existingClients = [], createdId = 100009901 }) {
  const stats = { addClient: 0, search: 0, getById: 0 };
  const createdRows = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const method = String(init?.method || "GET").toUpperCase();
    if (u.includes("/client/clients") && method === "GET") {
      const parsed = new URL(u);
      const byId = parsed.searchParams.get("request.clientIDs");
      if (byId) {
        stats.getById += 1;
        const id = Number(byId);
        const row =
          existingClients.find((c) => Number(c.Id) === id) ||
          createdRows.find((c) => Number(c.Id) === id) ||
          optedInClient({ Id: id, Email: "lookup@example.com", FirstName: "Look", LastName: "Up" });
        return jsonResponse(200, { Clients: [row] });
      }
      stats.search += 1;
      const search = (parsed.searchParams.get("request.searchText") || "").trim().toLowerCase();
      const matches = existingClients.filter(
        (c) => String(c.Email || "").trim().toLowerCase() === search,
      );
      return jsonResponse(200, { Clients: matches });
    }
    if (u.includes("/client/addclient") && method === "POST") {
      stats.addClient += 1;
      const body = JSON.parse(String(init?.body || "{}"));
      const client = body.Client && typeof body.Client === "object" ? body.Client : body;
      const row = optedInClient({
        Id: createdId,
        Email: client.Email,
        FirstName: client.FirstName,
        LastName: client.LastName,
        MobilePhone: client.MobilePhone,
      });
      createdRows.push(row);
      return jsonResponse(200, { Client: row });
    }
    if (u.includes("/client/updateclient") && method === "POST") {
      return jsonResponse(200, { Client: { Id: createdId } });
    }
    throw new Error(`unexpected_fetch ${method} ${u}`);
  };
  return {
    stats,
    restore() {
      globalThis.fetch = orig;
    },
  };
}

const [
  pricing,
  checkout,
  webhook,
  classesSchedule,
] = await Promise.all([
  readFile(path.join(root, "src/js/pricing-api.js"), "utf8"),
  readFile(path.join(root, "netlify/functions/stripe-create-checkout-session.mjs"), "utf8"),
  readFile(path.join(root, "netlify/functions/stripe-webhook.mjs"), "utf8"),
  readFile(path.join(root, "src/js/classes-schedule.js"), "utf8"),
]);

const recoveryBlock = pricing.slice(
  pricing.indexOf("if (stripeMatch.eligible || earlyStripeRecurringPreview)"),
  pricing.indexOf("if (stripeMatch.eligible && stripeMatch.localSku && stripeMatch.displayName)"),
);
const openFlow = pricing.slice(
  pricing.indexOf("async function openCheckoutFlow(row)"),
  pricing.indexOf("runBtn.addEventListener(\"click\""),
);
const submitSlice = pricing.slice(
  pricing.indexOf("const recurringSkuEntry = isRecurring ? lookupStripeRecurringSku(svcId) : null;"),
  pricing.indexOf("const stripeRes = await fetch("),
);

check(
  "A/UI signed-out membership is not blocked by sign-in modal",
  !pricing.includes("Sign in to your AMARÉ account to start this membership.") &&
    pricing.includes("guestStripeRecurring") &&
    pricing.includes("signed_out_membership"),
);
check(
  "A/UI guest recurring skips consumer/session auth gates",
  openFlow.includes("!consumerApisAuthenticated && !sessionBannerSaysLoggedIn && !guestStripeRecurring") &&
    openFlow.includes("commerceLinkedForMembership || guestStripeRecurring"),
);
check(
  "A/UI guest identity fields live inside the consent dialog",
  pricing.includes("function buildGuestMembershipIdentityHtml") &&
    pricing.includes("First Name") &&
    pricing.includes("Last Name") &&
    pricing.includes('name="firstName"') &&
    pricing.includes('name="lastName"') &&
    pricing.includes('name="email"') &&
    pricing.includes('name="phone"') &&
    openFlow.includes("guestStripeRecurring ? buildGuestMembershipIdentityHtml()") &&
    openFlow.includes("membershipContractInset"),
);
const guestFormFn = pricing.slice(
  pricing.indexOf("function buildGuestMembershipIdentityHtml"),
  pricing.indexOf("function readGuestMembershipIdentity"),
);
check(
  "A/UI guest form does not mention a Mindbody account",
  !pricing.includes("need a Mindbody account") &&
    !guestFormFn.includes("Sign in with Mindbody") &&
    !guestFormFn.includes("Mindbody"),
);
check(
  "A/UI guest submit posts firstName/lastName/email/phone and no clientId",
  submitSlice.includes("stripePayload.firstName = guestIdentity.firstName") &&
    submitSlice.includes("stripePayload.lastName = guestIdentity.lastName") &&
    submitSlice.includes("stripePayload.email = guestIdentity.email") &&
    submitSlice.includes("stripePayload.phone = guestIdentity.phone") &&
    !submitSlice.includes("clientId") &&
    !submitSlice.includes("knownMindbodyClientId"),
);
check(
  "A/UI guest validation matches Express",
  pricing.includes("function readGuestMembershipIdentity") &&
    pricing.includes("/^[^\\s@]{1,200}@[^\\s@]{1,64}\\.[A-Za-z0-9.-]{2,24}$/") &&
    pricing.includes("phone.replace(/\\D/g, \"\").length < 7"),
);

const existingEmail = "existing-member@example.com";
const existingId = 100001555;
const existingMock = installMindbodyFetchMock({
  existingClients: [
    optedInClient({
      Id: existingId,
      Email: existingEmail,
      FirstName: "Existing",
      LastName: "Member",
      MobilePhone: "2025550100",
    }),
  ],
});
const reused = await resolveOrCreateMindbodyClient(
  {
    knownMindbodyClientId: null,
    email: existingEmail,
    fullName: "Existing Member",
    firstName: "Existing",
    lastName: "Member",
    phone: "2025550100",
  },
  { Authorization: "Bearer qa" },
);
existingMock.restore();

check(
  "A existing exact email reuses client and skips AddClient",
  reused.ok === true &&
    reused.clientId === existingId &&
    reused.clientCreated === false &&
    existingMock.stats.addClient === 0,
  JSON.stringify(reused.ok ? { via: reused.via, id: reused.clientId, adds: existingMock.stats.addClient } : reused),
);

resetSubscriptionStoreMemoryForTests();
const storeA = openSubscriptionStore();
const subA = newSubscriptionId();
const putA = await storeA.put({
  id: subA,
  stripeSubscriptionId: `pending_${subA}`,
  stripeCustomerId: "cus_qa_existing",
  stripeCheckoutSessionId: "",
  localSku: "monthly_5",
  displayName: "Monthly 5 Classes",
  monthlyAmountCents: 12500,
  currency: "usd",
  mindbodyClientId: reused.ok ? reused.clientId : 0,
  mindbodyServiceId: 100133,
  mindbodyContractProductId: "101",
  status: "pending_first_invoice",
  invoices: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  stripeLivemode: false,
});
const recA = await storeA.get(subA);
check(
  "A subscription record freezes reused mindbodyClientId",
  putA.ok === true && recA?.mindbodyClientId === existingId && recA?.localSku === "monthly_5",
);

const createdId = 100009808;
const newMock = installMindbodyFetchMock({ existingClients: [], createdId });
const created = await resolveOrCreateMindbodyClient(
  {
    knownMindbodyClientId: null,
    email: "new-member@example.com",
    fullName: "New Member",
    firstName: "New",
    lastName: "Member",
    phone: "2025550199",
  },
  { Authorization: "Bearer qa" },
);
newMock.restore();
check(
  "B new email AddClient once",
  created.ok === true &&
    created.clientId === createdId &&
    created.clientCreated === true &&
    created.via === "created" &&
    newMock.stats.addClient === 1,
  JSON.stringify(created.ok ? { via: created.via, id: created.clientId, adds: newMock.stats.addClient } : created),
);

resetSubscriptionStoreMemoryForTests();
const storeB = openSubscriptionStore();
const subB = newSubscriptionId();
const putB = await storeB.put({
  id: subB,
  stripeSubscriptionId: `pending_${subB}`,
  stripeCustomerId: "cus_qa_new",
  stripeCheckoutSessionId: "",
  localSku: "monthly_8",
  displayName: "Monthly 8 Classes",
  monthlyAmountCents: 17900,
  currency: "usd",
  mindbodyClientId: created.ok ? created.clientId : 0,
  mindbodyServiceId: 100134,
  mindbodyContractProductId: "102",
  status: "pending_first_invoice",
  invoices: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  stripeLivemode: false,
});
const recB = await storeB.get(subB);
check(
  "B subscription record freezes newly created mindbodyClientId",
  putB.ok === true && recB?.mindbodyClientId === createdId && recB?.localSku === "monthly_8",
);

const monthly5 = getCatalogItem("monthly_5");
const monthly8 = getCatalogItem("monthly_8");
const unlimited = getCatalogItem("monthly_unlimited");
check(
  "A catalog Monthly 5 recurring metadata",
  monthly5?.stripeMode === "subscription" &&
    monthly5?.kind === "monthlyMembership" &&
    monthly5?.mindbodyServiceId === 100133 &&
    monthly5?.mindbodyContractProductId === "101" &&
    monthly5?.amountCents === 12500,
);
check(
  "B catalog Monthly 8 recurring metadata",
  monthly8?.stripeMode === "subscription" &&
    monthly8?.kind === "monthlyMembership" &&
    monthly8?.mindbodyServiceId === 100134 &&
    monthly8?.mindbodyContractProductId === "102" &&
    monthly8?.amountCents === 17900,
);
check(
  "C catalog Unlimited recurring metadata",
  unlimited?.stripeMode === "subscription" &&
    unlimited?.kind === "monthlyMembership" &&
    unlimited?.mindbodyServiceId === 100135 &&
    unlimited?.mindbodyContractProductId === "100" &&
    unlimited?.amountCents === 22900 &&
    unlimited?.enabled === true,
);
check(
  "C create-session accepts guest identity before membership dispatch",
  checkout.includes("safeStr(/** @type {{ firstName?: unknown }} */ (body).firstName, 80)") &&
    checkout.includes("safeStr(/** @type {{ lastName?: unknown }} */ (body).lastName, 80)") &&
    checkout.includes("safeStr(/** @type {{ email?: unknown }} */ (body).email, 254)") &&
    checkout.includes("safeStr(/** @type {{ phone?: unknown }} */ (body).phone, 32)") &&
    checkout.includes("if (item.kind === \"monthlyMembership\" || item.stripeMode === \"subscription\")") &&
    checkout.includes("return await handleMembershipSubscription(") &&
    checkout.includes("customerFirstName: customerFirstNameRaw") &&
    checkout.includes("mindbodyClientId: String(resolved.clientId)") &&
    checkout.includes("localSku: item.localSku") &&
    checkout.includes("mindbodyServiceId: String(item.mindbodyServiceId)") &&
    checkout.includes("mindbodyContractProductId: String(item.mindbodyContractProductId)"),
);
check(
  "C classes still hands memberships to Pricing",
  classesSchedule.includes("function queuePricingCheckoutAndGo") &&
    classesSchedule.includes("queuePricingCheckoutAndGo(item, bookFailCls)") &&
    !classesSchedule.includes("buildGuestMembershipIdentityHtml"),
);

check(
  "D signed-in linked path does not collect identity fields",
  openFlow.includes("commerceLinkedForMembership") &&
    openFlow.includes("isLinkedCommerceState(commerceStatus.state)") &&
    submitSlice.includes("if (guestIdentity)") &&
    !submitSlice.includes("if (commerceLinkedForMembership)") &&
    pricing.includes("showLinkedCommercePurchaseDialog") === true,
);
check(
  "D trusted linked client remains authoritative",
  checkout.includes("trustKnownClientId:") &&
    checkout.includes("isPurchaseLinkedState(commerceCustomer.state)") &&
    checkout.includes("knownMindbodyClientId != null") &&
    checkout.includes("browser_client_id_never_ownership"),
);

check(
  "E recovery states still block before guest path",
  recoveryBlock.includes("commerceStatus.state === \"CONFLICT\"") &&
    recoveryBlock.includes("commerceStatus.state === \"AMBIGUOUS\"") &&
    recoveryBlock.includes("commerceStatus.state === \"CANDIDATE\"") &&
    recoveryBlock.includes("commerceStatus.state === \"NEEDS_PROFILE\"") &&
    recoveryBlock.includes("showCommerceRecoveryDialog") &&
    !recoveryBlock.includes("SIGNED_OUT") &&
    !recoveryBlock.includes("guestStripeRecurring"),
);
check(
  "E recovery copy is unchanged",
  pricing.includes("Complete your AMARÉ profile") &&
    pricing.includes("Confirm your studio profile before purchasing") &&
    pricing.includes("two different studio accounts"),
);

const invoicePaid = webhook.slice(
  webhook.indexOf("return await syncOneTimePurchaseToMindbody({"),
  webhook.indexOf("evt.type === \"invoice.paid\" ||"),
);
check(
  "F invoice.paid uses stored mindbodyClientId without a browser session",
  invoicePaid.includes("clientId: record.mindbodyClientId") &&
    invoicePaid.includes("async function handleInvoicePaid") &&
    invoicePaid.includes("typeof record.mindbodyClientId === \"number\"") &&
    !invoicePaid.includes("cookie") &&
    !invoicePaid.includes("amare_sess") &&
    !invoicePaid.includes("mb_sess") &&
    !invoicePaid.includes("resolveCommerceCustomer"),
);
check(
  "F create-session freezes resolved client onto the subscription record",
  checkout.includes("mindbodyClientId: resolved.clientId") &&
    checkout.includes("status: \"pending_first_invoice\""),
);

resetSubscriptionStoreMemoryForTests();
const storeF = openSubscriptionStore();
const subF = newSubscriptionId();
await storeF.put({
  id: subF,
  stripeSubscriptionId: "sub_qa_renewal",
  stripeCustomerId: "cus_qa_renewal",
  stripeCheckoutSessionId: "cs_qa_renewal",
  localSku: "monthly_5",
  displayName: "Monthly 5 Classes",
  monthlyAmountCents: 12500,
  currency: "usd",
  mindbodyClientId: existingId,
  mindbodyServiceId: 100133,
  mindbodyContractProductId: "101",
  status: "active",
  invoices: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  stripeLivemode: false,
});
const cycleClaim = await storeF.claimInvoiceSlot(subF, "in_qa_subscription_cycle", {
  sourceEventId: "evt_invoice_paid_cycle",
});
const recF = await storeF.get(subF);
check(
  "F synthetic subscription_cycle claim keeps frozen clientId",
  cycleClaim.ok === true &&
    cycleClaim.acquired === true &&
    recF?.mindbodyClientId === existingId &&
    recF?.status === "active",
);

resetSubscriptionStoreMemoryForTests();
const storeG = openSubscriptionStore();
const subG = newSubscriptionId();
await storeG.put({
  id: subG,
  stripeSubscriptionId: "sub_qa_dup",
  stripeCustomerId: "cus_qa_dup",
  stripeCheckoutSessionId: "cs_qa_dup",
  localSku: "monthly_unlimited",
  displayName: "Monthly Unlimited",
  monthlyAmountCents: 22900,
  currency: "usd",
  mindbodyClientId: createdId,
  mindbodyServiceId: 100135,
  mindbodyContractProductId: "100",
  status: "active",
  invoices: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  stripeLivemode: false,
});
const firstPaid = await storeG.claimInvoiceSlot(subG, "in_qa_duplicate", { sourceEventId: "evt_paid_1" });
const dupPaid = await storeG.claimInvoiceSlot(subG, "in_qa_duplicate", { sourceEventId: "evt_paid_2" });
check(
  "G duplicate invoice.paid claims once",
  firstPaid.ok === true &&
    firstPaid.acquired === true &&
    dupPaid.ok === true &&
    dupPaid.acquired === false &&
    webhook.includes("stripe_webhook_invoice_paid_dedup"),
);

if (failed) {
  console.error(`\n${failed} anonymous recurring membership QA check(s) failed.`);
  process.exit(1);
}
console.log("\nAnonymous recurring membership QA passed.");
