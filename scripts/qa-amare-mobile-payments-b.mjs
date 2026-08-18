/**
 * Phase B mobile PaymentSheet backend matrix.
 * Run: node scripts/qa-amare-mobile-payments-b.mjs
 *
 * Mocks Stripe and CheckoutShoppingCart. Does not call Mindbody or enable production.
 */
process.env.NETLIFY = "";
process.env.STRIPE_ORDER_STORE_LOCAL_MEMORY = "1";
process.env.ENABLE_AMARE_AUTH = "1";
process.env.ENABLE_AMARE_COMMERCE = "1";
process.env.ENABLE_STRIPE_ONE_TIME_CHECKOUT = "1";

const {
  newOrderId,
  openOrderStore,
  resetOrderStoreMemoryForTests,
} = await import("../netlify/functions/stripe-order-store.mjs");
const { getCatalogItem } = await import("../netlify/functions/stripe-catalog-lib.mjs");
const {
  handleMobilePaymentIntentSucceeded,
  PAYMENT_FLOW_HOSTED,
  PAYMENT_FLOW_MOBILE,
} = await import("../netlify/functions/stripe-payment-flow.mjs");
const { handleMobilePaymentPrepare, handleMobileOrderStatus } = await import(
  "../netlify/functions/amare-commerce-mobile-payments.mjs"
);
const { fulfillSession } = await import("../netlify/functions/stripe-webhook.mjs");

let failed = 0;
function check(name, ok, detail) {
  if (ok) console.log(`PASS — ${name}`);
  else {
    failed += 1;
    console.error(`FAIL — ${name}${detail ? ` (${detail})` : ""}`);
  }
}

const ITEM = getCatalogItem("drop_in_single_class");
if (!ITEM || ITEM.amountCents !== 4000 || ITEM.currency !== "usd") {
  check("catalog drop_in_single_class authoritative", false, JSON.stringify(ITEM));
  process.exit(1);
}

const USER_A = "usr_TESTA000000000000000001";
const USER_B = "usr_TESTB000000000000000002";
const CLIENT_A = 100002726;
const LIVE = { stripeLivemode: true, behavior: /** @type {const} */ ("live"), mindbodyTest: false };

function parseBody(res) {
  try {
    return JSON.parse(res.body || "{}");
  } catch {
    return {};
  }
}

function countingSync(saleId = "90001") {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    fn: async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return {
        ok: true,
        mindbodySaleId: saleId,
        mindbodyTransactionId: null,
        responseSummary: `sale=${saleId}`,
        mode: "custom",
      };
    },
  };
}

async function seedOrder(store, overrides = {}) {
  const orderId = overrides.orderId || newOrderId();
  const record = {
    orderId,
    localSku: ITEM.localSku,
    amountCents: ITEM.amountCents,
    currency: ITEM.currency,
    stripeCheckoutSessionId: `cs_test_${orderId.slice(4, 18).toLowerCase()}`,
    stripePaymentIntentId: `pi_test_${orderId.slice(4, 18).toLowerCase()}`,
    stripeCustomerId: "cus_hosted_1",
    mindbodySyncStatus: "checkout_created",
    knownMindbodyClientId: CLIENT_A,
    resolvedMindbodyClientId: CLIENT_A,
    amareUserId: USER_A,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
  await store.put(record);
  return store.get(orderId);
}

function paidSession(order, extraMeta = {}) {
  return {
    id: order.stripeCheckoutSessionId,
    payment_status: "paid",
    amount_total: order.amountCents,
    amount_subtotal: order.amountCents,
    customer: order.stripeCustomerId,
    payment_intent: order.stripePaymentIntentId,
    metadata: {
      orderId: order.orderId,
      localSku: order.localSku,
      ...extraMeta,
    },
    customer_details: { email: "buyer@example.com", name: "Buyer Name", phone: "+15555550100" },
  };
}

function mobilePi(order, extra = {}) {
  return {
    id: order.stripePaymentIntentId || "pi_mobile_1",
    amount_received: order.amountCents,
    currency: order.currency,
    customer: order.stripeCustomerId || "cus_mobile_1",
    invoice: null,
    metadata: {
      amarePaymentFlow: PAYMENT_FLOW_MOBILE,
      orderId: order.orderId,
      localSku: order.localSku,
      amareUserId: order.amareUserId,
      flow: "stripe_to_mindbody_one_time",
      ...(extra.metadata || {}),
    },
    ...extra,
  };
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
          await new Promise((r) => setTimeout(r, 15));
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

const hostedSessionOpts = {
  resolveMindbodyClient: async (order) => ({
    ok: true,
    clientId: order.knownMindbodyClientId || CLIENT_A,
    clientCreated: false,
    email: "buyer@example.com",
  }),
};

/* -------------------------------------------------------------------------- */
/* H1 existing hosted one-time still fulfills once                              */
/* -------------------------------------------------------------------------- */
resetOrderStoreMemoryForTests();
{
  const store = openOrderStore();
  const order = await seedOrder(store, { paymentFlow: PAYMENT_FLOW_HOSTED });
  const sync = countingSync("91001");
  const session = paidSession(order, { amarePaymentFlow: PAYMENT_FLOW_HOSTED });
  const first = await fulfillSession(session, store, LIVE, {
    stripeEventId: "evt_h1_a",
    syncFn: sync.fn,
    ...hostedSessionOpts,
  });
  const second = await fulfillSession(session, store, LIVE, {
    stripeEventId: "evt_h1_b",
    syncFn: sync.fn,
    ...hostedSessionOpts,
  });
  const final = await store.get(order.orderId);
  check("H1 hosted session fulfills", first.status === "mindbody_synced" && !first.noop);
  check("H1 duplicate session noops", second.noop === true);
  check("H1 one CheckoutShoppingCart", sync.calls === 1, `calls=${sync.calls}`);
  check("H1 mindbody_synced once", final?.mindbodySyncStatus === "mindbody_synced");

  const legacy = await seedOrder(store);
  const syncLegacy = countingSync("91002");
  const legacyOut = await fulfillSession(paidSession(legacy), store, LIVE, {
    stripeEventId: "evt_h1_legacy",
    syncFn: syncLegacy.fn,
    ...hostedSessionOpts,
  });
  check(
    "H1 legacy missing paymentFlow still fulfills",
    legacyOut.status === "mindbody_synced" && !legacyOut.noop,
  );
}

/* -------------------------------------------------------------------------- */
/* H2 hosted recurring unchanged                                                */
/* -------------------------------------------------------------------------- */
resetOrderStoreMemoryForTests();
{
  const store = openOrderStore();
  const order = await seedOrder(store, { paymentFlow: PAYMENT_FLOW_HOSTED });
  const sync = countingSync("92001");
  const invoicePi = {
    id: "pi_sub_1",
    amount_received: 19900,
    currency: "usd",
    customer: "cus_sub",
    invoice: "in_sub_1",
    metadata: {
      orderType: "monthly_membership",
      localSku: "monthly_unlimited",
      flow: "stripe_recurring_subscription",
    },
  };
  const out = await handleMobilePaymentIntentSucceeded(invoicePi, store, {
    stripeEventId: "evt_h2",
    syncFn: sync.fn,
    testModeDecision: LIVE,
  });
  check("H2 subscription invoice PI is ignored", out.reason === "subscription_invoice_intent");
  check("H2 subscription invoice PI does not fulfill", out.fulfilled === false && sync.calls === 0);
  const hostedStill = await store.get(order.orderId);
  check(
    "H2 hosted one-time order untouched",
    hostedStill.mindbodySyncStatus === "checkout_created",
  );
}

/* -------------------------------------------------------------------------- */
/* H3 hosted session cannot fulfill mobile PaymentSheet order                   */
/* -------------------------------------------------------------------------- */
resetOrderStoreMemoryForTests();
{
  const store = openOrderStore();
  const order = await seedOrder(store, {
    paymentFlow: PAYMENT_FLOW_MOBILE,
    stripeCheckoutSessionId: undefined,
    prepareStatus: "ready",
  });
  const sync = countingSync("93001");
  const forged = {
    ...paidSession(order, { amarePaymentFlow: PAYMENT_FLOW_HOSTED }),
    id: "cs_forged_mobile",
    metadata: { orderId: order.orderId, localSku: order.localSku, amarePaymentFlow: PAYMENT_FLOW_HOSTED },
  };
  const out = await fulfillSession(forged, store, LIVE, {
    stripeEventId: "evt_h3",
    syncFn: sync.fn,
    ...hostedSessionOpts,
  });
  const final = await store.get(order.orderId);
  check("H3 session against mobile order is ignored", out.status === "ignored_mobile_payment_sheet" && out.noop);
  check("H3 no CheckoutShoppingCart", sync.calls === 0, `calls=${sync.calls}`);
  check("H3 mobile order not fulfilled", final.mindbodySyncStatus === "checkout_created");
}

/* -------------------------------------------------------------------------- */
/* H4 payment_intent cannot fulfill hosted order                                */
/* -------------------------------------------------------------------------- */
resetOrderStoreMemoryForTests();
{
  const store = openOrderStore();
  const legacy = await seedOrder(store);
  const sync = countingSync("94001");
  const legacyPi = {
    id: legacy.stripePaymentIntentId,
    amount_received: legacy.amountCents,
    currency: legacy.currency,
    customer: legacy.stripeCustomerId,
    metadata: {
      orderId: legacy.orderId,
      localSku: legacy.localSku,
      flow: "stripe_to_mindbody_one_time",
    },
  };
  const h4legacy = await handleMobilePaymentIntentSucceeded(legacyPi, store, {
    stripeEventId: "evt_h4_legacy",
    syncFn: sync.fn,
    testModeDecision: LIVE,
  });
  check("H4 legacy Checkout PI missing amarePaymentFlow ignored", h4legacy.reason === "wrong_amarePaymentFlow");

  const hosted = await seedOrder(store, { paymentFlow: PAYMENT_FLOW_HOSTED });
  const hostedPi = mobilePi(hosted, {
    metadata: { amarePaymentFlow: PAYMENT_FLOW_HOSTED, orderId: hosted.orderId, localSku: hosted.localSku },
  });
  hostedPi.metadata.amarePaymentFlow = PAYMENT_FLOW_HOSTED;
  const h4hosted = await handleMobilePaymentIntentSucceeded(hostedPi, store, {
    stripeEventId: "evt_h4_hosted",
    syncFn: sync.fn,
    testModeDecision: LIVE,
  });
  check("H4 explicit hosted_checkout PI ignored", h4hosted.reason === "wrong_amarePaymentFlow");
  check("H4 PI never calls CheckoutShoppingCart", sync.calls === 0);

  const sessionSync = countingSync("94002");
  const sessionOut = await fulfillSession(paidSession(hosted, { amarePaymentFlow: PAYMENT_FLOW_HOSTED }), store, LIVE, {
    stripeEventId: "evt_h4_session",
    syncFn: sessionSync.fn,
    ...hostedSessionOpts,
  });
  check("H4 hosted session still fulfills after PI no-op", sessionOut.status === "mindbody_synced" && !sessionOut.noop);
}

/* -------------------------------------------------------------------------- */
/* M1 valid mobile PaymentIntent fulfills once                                  */
/* -------------------------------------------------------------------------- */
resetOrderStoreMemoryForTests();
let mobileOrder;
{
  const store = openOrderStore();
  mobileOrder = await seedOrder(store, {
    paymentFlow: PAYMENT_FLOW_MOBILE,
    stripeCheckoutSessionId: undefined,
    stripeCustomerId: "cus_mobile_1",
    stripePaymentIntentId: "pi_mobile_ok",
    prepareStatus: "ready",
    mindbodySyncStatus: "checkout_created",
  });
  const sync = countingSync("95001");
  const out = await handleMobilePaymentIntentSucceeded(mobilePi(mobileOrder), store, {
    stripeEventId: "evt_m1",
    syncFn: sync.fn,
    testModeDecision: LIVE,
  });
  const final = await store.get(mobileOrder.orderId);
  check("M1 fulfills once", out.fulfilled === true && out.status === "mindbody_synced");
  check("M1 one CheckoutShoppingCart", sync.calls === 1, `calls=${sync.calls}`);
  check("M1 durable mindbody_synced", final.mindbodySyncStatus === "mindbody_synced");

  /* M2 duplicate webhook no-op */
  const dup = await handleMobilePaymentIntentSucceeded(mobilePi(mobileOrder), store, {
    stripeEventId: "evt_m2",
    syncFn: sync.fn,
    testModeDecision: LIVE,
  });
  check("M2 duplicate webhook no-op", dup.noop === true && sync.calls === 1);
}

/* -------------------------------------------------------------------------- */
/* M3 concurrent duplicate webhook one fulfillment                              */
/* -------------------------------------------------------------------------- */
resetOrderStoreMemoryForTests();
{
  const store = openOrderStore();
  const order = await seedOrder(store, {
    paymentFlow: PAYMENT_FLOW_MOBILE,
    stripeCheckoutSessionId: undefined,
    stripeCustomerId: "cus_mobile_1",
    stripePaymentIntentId: "pi_mobile_conc",
    prepareStatus: "ready",
  });
  const sync = countingSync("95003");
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      handleMobilePaymentIntentSucceeded(mobilePi(order), store, {
        stripeEventId: `evt_m3_${i}`,
        syncFn: sync.fn,
        testModeDecision: LIVE,
      }),
    ),
  );
  const winners = results.filter((r) => r.fulfilled);
  const final = await store.get(order.orderId);
  check("M3 one fulfillment winner", winners.length === 1, `winners=${winners.length}`);
  check("M3 one CheckoutShoppingCart", sync.calls === 1, `calls=${sync.calls}`);
  check("M3 mindbody_synced", final.mindbodySyncStatus === "mindbody_synced");
}

/* -------------------------------------------------------------------------- */
/* M4-M9 hard gate                                                              */
/* -------------------------------------------------------------------------- */
resetOrderStoreMemoryForTests();
{
  const store = openOrderStore();

  async function expectReject(label, order, pi, expectedReason) {
    const sync = countingSync("95999");
    const out = await handleMobilePaymentIntentSucceeded(pi, store, {
      stripeEventId: `evt_${label}`,
      syncFn: sync.fn,
      testModeDecision: LIVE,
    });
    const final = await store.get(order.orderId);
    check(`${label} rejected`, out.fulfilled === false && out.reason === expectedReason, out.reason);
    check(
      `${label} no claim/cart`,
      sync.calls === 0 && final.mindbodySyncStatus === "checkout_created",
    );
  }

  const wrongFlow = await seedOrder(store, {
    paymentFlow: PAYMENT_FLOW_HOSTED,
    stripeCheckoutSessionId: undefined,
    stripeCustomerId: "cus_mobile_1",
    stripePaymentIntentId: "pi_m4",
    prepareStatus: "ready",
  });
  await expectReject("M4", wrongFlow, mobilePi(wrongFlow), "wrong_paymentFlow");

  const gateOrder = await seedOrder(store, {
    paymentFlow: PAYMENT_FLOW_MOBILE,
    stripeCheckoutSessionId: undefined,
    stripeCustomerId: "cus_mobile_1",
    stripePaymentIntentId: "pi_gate",
    prepareStatus: "ready",
  });

  const wrongSkuPi = mobilePi(gateOrder);
  wrongSkuPi.metadata.localSku = "pack_10_classes";
  await expectReject("M5", gateOrder, wrongSkuPi, "sku_mismatch");

  const wrongAmt = mobilePi(gateOrder);
  wrongAmt.amount_received = 1;
  await expectReject("M6", gateOrder, wrongAmt, "amount_mismatch");

  const wrongCur = mobilePi(gateOrder);
  wrongCur.currency = "eur";
  await expectReject("M7", gateOrder, wrongCur, "currency_mismatch");

  const wrongCus = mobilePi(gateOrder);
  wrongCus.customer = "cus_other";
  await expectReject("M8", gateOrder, wrongCus, "customer_mismatch");

  const missingId = mobilePi(gateOrder);
  missingId.metadata.orderId = newOrderId();
  const syncM9 = countingSync("95998");
  const m9 = await handleMobilePaymentIntentSucceeded(missingId, store, {
    stripeEventId: "evt_M9",
    syncFn: syncM9.fn,
    testModeDecision: LIVE,
  });
  const still = await store.get(gateOrder.orderId);
  check("M9 wrong order id/metadata rejected", m9.fulfilled === false && m9.reason === "order_not_found", m9.reason);
  check("M9 original order unclaimed", syncM9.calls === 0 && still.mindbodySyncStatus === "checkout_created");
}

/* -------------------------------------------------------------------------- */
/* P1 purchaseAttemptId idempotency                                             */
/* -------------------------------------------------------------------------- */
resetOrderStoreMemoryForTests();
{
  const store = openOrderStore();
  const stripe = mockStripe();
  const attempt = "attempt_p1_aaaaaaaa";
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      handleMobilePaymentPrepare(
        prepareEvent(USER_A, {
          sku: ITEM.localSku,
          purchaseAttemptId: attempt,
          amount: 1,
          currency: "eur",
          clientId: 999,
          amare_user_id: USER_B,
        }),
        depsFor(store, stripe, USER_A),
      ),
    ),
  );
  const bodies = results.map(parseBody);
  const ids = new Set(bodies.map((b) => b.orderId));
  const pis = new Set(bodies.map((b) => String(b.paymentIntentClientSecret || "").split("_secret")[0]));
  const amounts = new Set(bodies.map((b) => b.amount));
  const currencies = new Set(bodies.map((b) => b.currency));
  check("P1 all prepare 200", results.every((r) => r.statusCode === 200));
  check("P1 one OrderRecord", ids.size === 1, [...ids].join(","));
  check("P1 one PaymentIntent", pis.size === 1, [...pis].join(","));
  check("SERVER PRICE AUTHORITY amount", amounts.size === 1 && amounts.has(ITEM.amountCents));
  check("SERVER PRICE AUTHORITY currency", currencies.size === 1 && currencies.has(ITEM.currency));
  const listed = await store.get([...ids][0]);
  check(
    "P1 ignores client price and clientId",
    listed.amountCents === ITEM.amountCents &&
      listed.knownMindbodyClientId === CLIENT_A &&
      listed.amareUserId === USER_A &&
      listed.paymentFlow === PAYMENT_FLOW_MOBILE &&
      !listed.stripeCheckoutSessionId,
  );
  check(
    "PI payment_method_types card only",
    stripe.created.length > 0 &&
      stripe.created.every(
        (p) => Array.isArray(p.payment_method_types) && p.payment_method_types.join(",") === "card",
      ),
  );
  check(
    "APM disabled on PaymentIntent",
    stripe.created.every((p) => p.automatic_payment_methods == null),
  );

  const monthly = await handleMobilePaymentPrepare(
    prepareEvent(USER_A, { sku: "monthly_unlimited", purchaseAttemptId: "attempt_monthly_xx" }),
    depsFor(store, stripe, USER_A),
  );
  check("monthly SKU stays off PaymentSheet", monthly.statusCode === 400 && parseBody(monthly).error === "sku_not_allowed");
}

/* -------------------------------------------------------------------------- */
/* M10 / S1 status ownership and no self-fulfill                                */
/* -------------------------------------------------------------------------- */
resetOrderStoreMemoryForTests();
{
  const store = openOrderStore();
  const stripe = mockStripe();
  const prep = await handleMobilePaymentPrepare(
    prepareEvent(USER_A, { sku: ITEM.localSku, purchaseAttemptId: "attempt_status_aaaa" }),
    depsFor(store, stripe, USER_A),
  );
  const prepared = parseBody(prep);
  check("MOBILE PAYMENT PREPARE 200", prep.statusCode === 200 && prepared.orderId && prepared.paymentIntentClientSecret);

  const own = await handleMobileOrderStatus(statusEvent(USER_A, prepared.orderId), depsFor(store, stripe, USER_A));
  const ownBody = parseBody(own);
  check("S1 status remains processing without webhook", own.statusCode === 200 && ownBody.paymentStatus === "processing");
  check("S1 never self-fulfills", ownBody.fulfilled === false && ownBody.mindbodySyncStatus === "checkout_created");

  const foreign = await handleMobileOrderStatus(statusEvent(USER_B, prepared.orderId), depsFor(store, stripe, USER_B));
  check("M10 foreign AMARÉ user cannot read order status", foreign.statusCode === 403);

  const noBearer = await handleMobileOrderStatus(
    { httpMethod: "GET", headers: {}, queryStringParameters: { orderId: prepared.orderId } },
    depsFor(store, stripe, USER_A),
  );
  check("status requires Bearer", noBearer.statusCode === 401);
}

if (failed) {
  console.error(`\nFAILED ${failed}`);
  process.exit(1);
}
console.log("\nALL PHASE B CHECKS PASSED");
console.log("CLIENT FULFILLMENT: NONE");
console.log("PRODUCTION: OFF");
