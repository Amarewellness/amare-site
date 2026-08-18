/**
 * Phase B2.1 recovery + payment-method lock checks.
 * Run: node scripts/qa-amare-mobile-payments-b21.mjs
 *
 * Does not call Mindbody, Stripe live, or production.
 */
process.env.NETLIFY = "";
process.env.STRIPE_ORDER_STORE_LOCAL_MEMORY = "1";
process.env.ENABLE_AMARE_AUTH = "1";
process.env.ENABLE_AMARE_COMMERCE = "1";
process.env.ENABLE_STRIPE_ONE_TIME_CHECKOUT = "1";

const fs = await import("node:fs");
const path = await import("node:path");
const { openOrderStore, resetOrderStoreMemoryForTests } = await import(
  "../netlify/functions/stripe-order-store.mjs"
);
const { getCatalogItem } = await import("../netlify/functions/stripe-catalog-lib.mjs");
const {
  handleMobilePaymentPrepare,
  handleMobileOrderStatus,
  handleMobilePendingOrders,
} = await import("../netlify/functions/amare-commerce-mobile-payments.mjs");

let failed = 0;
function check(name, ok, detail) {
  if (ok) console.log(`PASS — ${name}`);
  else {
    failed += 1;
    console.error(`FAIL — ${name}${detail ? ` (${detail})` : ""}`);
  }
}

function read(rel) {
  return fs.readFileSync(path.resolve(rel), "utf8");
}

const ITEM = getCatalogItem("drop_in_single_class");
const USER_A = "usr_TESTA000000000000000001";
const USER_B = "usr_TESTB000000000000000002";
const CLIENT_A = 100002726;

function parseBody(res) {
  try {
    return JSON.parse(res.body || "{}");
  } catch {
    return {};
  }
}

function mockStripe() {
  let n = 0;
  const byIdem = new Map();
  const inflight = new Map();
  const byId = new Map();
  /** @type {unknown[]} */
  const created = [];
  return {
    created,
    customers: {
      search: async () => ({ data: [] }),
      list: async () => ({ data: [] }),
      create: async () => ({ id: "cus_mobile_1" }),
      update: async () => ({}),
    },
    paymentIntents: {
      create: async (params, opts) => {
        created.push(params);
        const key = opts?.idempotencyKey;
        if (key && byIdem.has(key)) return byIdem.get(key);
        if (key && inflight.has(key)) return inflight.get(key);
        const work = (async () => {
          if (key && byIdem.has(key)) return byIdem.get(key);
          n += 1;
          const pi = {
            id: `pi_test_${n}`,
            client_secret: `pi_test_${n}_secret`,
            amount: params.amount,
            currency: params.currency,
            customer: params.customer,
            metadata: params.metadata,
          };
          if (key) byIdem.set(key, pi);
          byId.set(pi.id, pi);
          return pi;
        })();
        if (key) inflight.set(key, work);
        try {
          return await work;
        } finally {
          if (key) inflight.delete(key);
        }
      },
      retrieve: async (id) => byId.get(id) || { id, client_secret: `${id}_secret` },
    },
  };
}

function prepareEvent(userId, body) {
  return {
    httpMethod: "POST",
    headers: { authorization: `Bearer test.${userId}` },
    body: JSON.stringify(body),
  };
}

function statusEvent(userId, orderId) {
  return {
    httpMethod: "GET",
    headers: { authorization: `Bearer test.${userId}` },
    queryStringParameters: { orderId },
  };
}

function pendingEvent(userId) {
  return {
    httpMethod: "GET",
    path: "/api/amare/commerce/mobile/pending",
    headers: { authorization: `Bearer test.${userId}` },
  };
}

function depsFor(store, stripe, userId = USER_A) {
  return {
    oneTimeEnabled: true,
    orderStore: store,
    stripe,
    ncsDuplicateDryRun: async () => ({ decision: "allow" }),
    resolveStripeCustomer: async () => "cus_mobile_1",
    resolveAmareUser: async () => ({ signedIn: true, amareUserId: userId, reason: null }),
    resolveCommerceCustomer: async () => ({
      state: "AMARE_LINKED",
      amareUserId: userId,
      clientId: CLIENT_A,
      authSource: "amare",
      mbEmail: "buyer@example.com",
    }),
  };
}

async function prepareOwned(store, stripe, attempt = "attempt_r1_aaaaaaaa") {
  const prep = await handleMobilePaymentPrepare(
    prepareEvent(USER_A, { sku: ITEM.localSku, purchaseAttemptId: attempt }),
    depsFor(store, stripe, USER_A),
  );
  return { res: prep, body: parseBody(prep) };
}

resetOrderStoreMemoryForTests();
{
  const store = openOrderStore();
  const stripe = mockStripe();
  const first = await prepareOwned(store, stripe);
  const orderId = first.body.orderId;
  const attempt = "attempt_r1_aaaaaaaa";
  check("R1 prepare 200", first.res.statusCode === 200 && !!orderId);

  await store.patch(orderId, { mindbodySyncStatus: "payment_completed" });

  const pending = parseBody(await handleMobilePendingOrders(pendingEvent(USER_A), depsFor(store, stripe, USER_A)));
  check(
    "R1 completed → process death → reopen: same order recovered",
    pending.ok === true &&
      Array.isArray(pending.orders) &&
      pending.orders.length === 1 &&
      pending.orders[0].orderId === orderId &&
      pending.orders[0].purchaseAttemptId === attempt &&
      pending.orders[0].localSku === ITEM.localSku,
    JSON.stringify(pending),
  );
  const recovered = await handleMobileOrderStatus(statusEvent(USER_A, orderId), depsFor(store, stripe, USER_A));
  const recoveredBody = parseBody(recovered);
  check(
    "R1 GET status is the owned processing order",
    recovered.statusCode === 200 &&
      recoveredBody.orderId === orderId &&
      recoveredBody.mindbodySyncStatus === "payment_completed" &&
      recoveredBody.fulfilled === false,
  );
  check(
    "pending pointer has no payment secrets",
    !JSON.stringify(pending).includes("client_secret") &&
      !JSON.stringify(pending).includes("secret") &&
      !JSON.stringify(pending).includes("email"),
  );
}

resetOrderStoreMemoryForTests();
{
  const store = openOrderStore();
  const stripe = mockStripe();
  const attempt = "attempt_r2_bbbbbbbb";
  const first = await prepareOwned(store, stripe, attempt);
  await store.patch(first.body.orderId, { mindbodySyncStatus: "payment_completed" });
  const pending = parseBody(await handleMobilePendingOrders(pendingEvent(USER_A), depsFor(store, stripe, USER_A)));
  const restoredAttempt = pending.orders[0].purchaseAttemptId;
  const second = await handleMobilePaymentPrepare(
    prepareEvent(USER_A, { sku: ITEM.localSku, purchaseAttemptId: restoredAttempt }),
    depsFor(store, stripe, USER_A),
  );
  const secondBody = parseBody(second);
  check("R2 recovered processing prepare 200", second.statusCode === 200);
  check(
    "R2 recovered processing order cannot create a second PI",
    secondBody.orderId === first.body.orderId &&
      secondBody.paymentIntentClientSecret === first.body.paymentIntentClientSecret &&
      stripe.created.filter((p) => p).length === 1,
    `created=${stripe.created.length} orders=${first.body.orderId} vs ${secondBody.orderId}`,
  );
}

resetOrderStoreMemoryForTests();
{
  const store = openOrderStore();
  const stripe = mockStripe();
  const first = await prepareOwned(store, stripe, "attempt_r3_cccccccc");
  await store.patch(first.body.orderId, { mindbodySyncStatus: "mindbody_synced" });
  const pending = parseBody(await handleMobilePendingOrders(pendingEvent(USER_A), depsFor(store, stripe, USER_A)));
  const own = parseBody(
    await handleMobileOrderStatus(statusEvent(USER_A, first.body.orderId), depsFor(store, stripe, USER_A)),
  );
  check(
    "R3 recovered mindbody_synced is omitted from pending",
    pending.ok === true && Array.isArray(pending.orders) && pending.orders.length === 0,
    JSON.stringify(pending),
  );
  check("R3 GET status still owner-readable", own.fulfilled === true && own.mindbodySyncStatus === "mindbody_synced");
  const recovery = read("amare-app/src/lib/purchase-recovery.ts");
  check(
    "R3 helper clears pending after synced",
    recovery.includes('return { ui: "success", clearPending: true') &&
      read("amare-app/src/screens/PurchaseScreen.tsx").includes("clearPendingMobilePurchase") &&
      read("amare-app/src/screens/PurchaseScreen.tsx").includes("await reload()"),
  );
}

resetOrderStoreMemoryForTests();
{
  const store = openOrderStore();
  const stripe = mockStripe();
  const first = await prepareOwned(store, stripe, "attempt_r4_dddddddd");
  await store.patch(first.body.orderId, { mindbodySyncStatus: "mindbody_sync_unknown" });
  const pending = parseBody(await handleMobilePendingOrders(pendingEvent(USER_A), depsFor(store, stripe, USER_A)));
  check(
    "R4 mindbody_sync_unknown survives restart",
    pending.orders?.length === 1 &&
      pending.orders[0].orderId === first.body.orderId &&
      pending.orders[0].mindbodySyncStatus === "mindbody_sync_unknown",
    JSON.stringify(pending),
  );
  const recovery = read("amare-app/src/lib/purchase-recovery.ts");
  const screen = read("amare-app/src/screens/PurchaseScreen.tsx");
  check(
    "R4 remains buy-locked",
    recovery.includes('ui: "sync_unknown", clearPending: false, buyLocked: true') &&
      screen.includes('uiState === "sync_unknown"') &&
      screen.includes("blocked={incompleteAccess || uiState === \"sync_unknown\"}"),
  );
  const afterUnknown = await handleMobilePaymentPrepare(
    prepareEvent(USER_A, { sku: ITEM.localSku, purchaseAttemptId: pending.orders[0].purchaseAttemptId }),
    depsFor(store, stripe, USER_A),
  );
  check(
    "R4 restored attempt does not mint a new PI",
    parseBody(afterUnknown).orderId === first.body.orderId && stripe.created.length === 1,
  );
}

{
  const sessionStore = read("amare-app/src/session-store.ts");
  const pendingStore = read("amare-app/src/lib/pending-mobile-purchase.ts");
  check(
    "R5 logout clears local pending reference",
    sessionStore.includes("clearPendingMobilePurchase") &&
      sessionStore.includes("clearAllPurchaseAttemptIds") &&
      /export function clearAuth\([\s\S]*clearPendingMobilePurchase/.test(sessionStore),
  );
  check("R5 pending store has no client secret fields", !pendingStore.includes("clientSecret") && !pendingStore.includes("clientId"));
}

resetOrderStoreMemoryForTests();
{
  const store = openOrderStore();
  const stripe = mockStripe();
  const first = await prepareOwned(store, stripe, "attempt_r6_eeeeeeee");
  const foreignPending = await handleMobilePendingOrders(pendingEvent(USER_B), depsFor(store, stripe, USER_B));
  const foreignStatus = await handleMobileOrderStatus(
    statusEvent(USER_B, first.body.orderId),
    depsFor(store, stripe, USER_B),
  );
  check(
    "R6 foreign user cannot recover another user's pending",
    foreignPending.statusCode === 200 && parseBody(foreignPending).orders?.length === 0,
    JSON.stringify(parseBody(foreignPending)),
  );
  check("R6 foreign user cannot read another user's order", foreignStatus.statusCode === 403);
}

const prepareSrc = read("netlify/functions/amare-commerce-mobile-payments.mjs");
check(
  "prepare locks payment_method_types to card",
  prepareSrc.includes('payment_method_types: ["card"]') && !prepareSrc.includes("automatic_payment_methods"),
);

const docs = read("docs/MEMBERSHIP-RECURRING-CHECKOUT.md");
const section = docs.slice(docs.indexOf("### 11.2"), docs.indexOf("#### MUST NOT enable"));
check(
  "production webhook docs omit payment_intent.succeeded",
  section.includes("checkout.session.completed") &&
    section.includes("invoice.paid") &&
    !section.includes("payment_intent.succeeded"),
);

const webhook = read("netlify/functions/stripe-webhook.mjs");
check("code handles payment_intent.succeeded for mobile", webhook.includes('evt.type === "payment_intent.succeeded"'));

if (failed) {
  console.error(`\nFAILED ${failed}`);
  process.exit(1);
}
console.log("\nPHASE B2.1 RECOVERY CHECKS PASSED");
console.log("PRODUCTION: OFF");
