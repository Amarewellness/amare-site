# Stripe Recurring Membership → Mindbody Service-per-renewal (Option A)

Status: **V1 fully verified locally — 18/18 tests passed (2026-05-14, Monthly 5 sandbox).** All happy-path, idempotency, race-condition, payment-failure, and cancellation scenarios verified end-to-end (Stripe → webhook → SubscriptionRecord → Mindbody Sale → booking). See § 13.1 for the full test ledger and § 11 for the production rollout checklist. The race-condition fix (§ 9.12), API-version compatibility (§ 9.11), and cancellation guard (§ 9.13) are all landed and verified. Catalog + terms config updated. All code paths from sections 4.1–4.5 are landed behind `ENABLE_STRIPE_RECURRING_CHECKOUT=0` (server) and `ENABLE_STRIPE_RECURRING_CHECKOUT_FRONTEND=0` (build-time) by default — flip per the rollout sequence in § 11, never directly.

Master feature flag: `ENABLE_STRIPE_RECURRING_CHECKOUT` (default `0`). All code paths added in this feature are gated behind this flag and the per-SKU `enabled: false` in the catalog.

> **Cross-references:**
>
> * **Section 8** — full E2E verification proof (Stripe ids, Mindbody Sale ID, log evidence) from the 2026-05-14 local run.
> * **Section 9** — lessons learned: the nine concrete bugs that surfaced during local testing and how each was fixed. Read before working on V2.
> * **Section 10** — local development env vars (memory-store fallbacks). **NEVER set in production.**
> * **Section 11** — production rollout checklist (env vars / webhook / catalog / Mindbody / smoke test / monitoring). Includes the per-SKU enablement order (Monthly 5 → Monthly 8 → Unlimited).
> * **Section 12** — **CRITICAL** production warning about renewals & `invoice.paid` webhook. Read before flipping any flag in production.
> * **Section 13** — V1 test results checklist (passed / pending). Updated as tests progress.

---

## 1. Context & decision

The studio offers three monthly memberships:

| Marketing name        | Stripe SKU          | Mindbody Pricing Option (new) | Mindbody legacy Pricing Option (untouched) | List price |
| --------------------- | ------------------- | ----------------------------- | ------------------------------------------ | ---------- |
| Monthly 5 Classes     | `monthly_5`         | **100133**                    | 100129                                     | $125       |
| Monthly 8 Classes     | `monthly_8`         | **100134**                    | 100130                                     | $179       |
| Monthly Unlimited     | `monthly_unlimited` | **100135**                    | 100056                                     | $229       |

The Mindbody Public API does NOT expose a contract-creation endpoint that works without real card details (`POST /sale/purchasecontract` requires `CreditCardInfo` or `StoredCardInfo`). Three options were considered:

* **Option A (selected)** — Stripe handles recurring billing. On every successful `invoice.paid`, our backend adds the matching Mindbody **Service** Pricing Option to the client via `POST /sale/checkoutshoppingcart` (the same endpoint we already use for one-time packs). Mindbody does NOT track an "active contract" status for these clients; we own subscription state in our own store + Stripe.
* **Option B** — Mindbody Contract with a comp/dummy payment method. Rejected: too brittle, risks double-billing, hard to reconcile with Stripe.
* **Option C** — Hybrid (Stripe billing + manual sync). Rejected: unsustainable.

API verification on 2026-05-14 with `scripts/mindbody-membership-service-probe.mjs` confirmed Option A works end-to-end against test client `100002753` for all three new IDs:

* `CheckoutShoppingCart` accepts the new Service IDs even though `SellOnline=No` (staff bearer bypass).
* Repeated purchases of the same Service ID create distinct `ClientServices` rows (each with its own `ActiveDate`/`ExpirationDate`/`Remaining`) — exactly what we need for monthly renewal sync.
* Class counts match the Pricing Option config (5/8/999999 for unlimited).
* Expiration is +1 month after sale date.
* Old IDs (100129/100130/100056) and the existing Mindbody Classic `/sale/purchasecontract` flow remain fully functional.

**Test sales recorded on test client `100002753` during verification: SaleIds 11701–11706.** These are real Mindbody sales using the Custom/Stripe payment method; no real card was charged. Cleanup is optional and can be done manually from the Mindbody Sales dashboard later.

## 2. V1 scope (this feature)

### In scope

* Stripe Checkout Session in `mode: subscription` for the three monthly SKUs.
* Server-side enforcement of agreement/waiver acceptance (reuses existing electronic-consent system; no new UI required for the agreement itself).
* Mandatory consent storage with the same audit fields already stored for the Mindbody Classic flow (`agreementAccepted`, `agreementVersion`, `agreementTextSnapshot`, `clientIp`, `userAgent`, etc.).
* Webhook handlers for `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.deleted`, `customer.subscription.updated`.
* Each successful `invoice.paid` adds a fresh Service row to Mindbody (per-invoice idempotency).
* Subscription state is persisted in a new Netlify Blobs store (`stripe-mindbody-subscriptions`).
* `paid_but_not_synced` admin retry surface (reusing the existing one-time order admin pattern).

### Explicitly NOT in scope (V1)

* **No Stripe Customer Portal at all.** Not enabled, not linked, not partially exposed. We do NOT build, configure, or surface any portal link in the UI. The studio handles all post-signup actions (cancel, plan change, payment method update, invoice download) directly via the Stripe Dashboard. A limited Portal — restricted to payment-method updates and invoice access only — may be added in a later phase once the recurring flow is fully stable; that future Portal will explicitly disable cancellation, plan switching, and pause.
* **No customer self-service of any kind:** no self-cancellation, no plan switching, no pause, no payment-method-update link.
* No automatic early-cancellation fee collection. The 50% fee is documented in the agreement but enforcement is manual via the studio.
* No automatic enforcement of the 3-month minimum commitment in code. The frontend will display the rule; the studio enforces it.
* No grace period for `invoice.payment_failed`. Failed payment = no Service granted that month, period. Stripe's own retry schedule (smart retries) handles re-attempts.
* No proration when an admin cancels mid-cycle. Whatever credits the client has already received in Mindbody for that cycle are theirs.

## 3. Already-completed in this turn

### `src/content/stripe-mindbody-catalog.config.json`

* Added three monthly-membership entries with `enabled: false`, `stripeMode: "subscription"`, `recurringInterval: "month"`, `kind: "monthlyMembership"`, `mindbodyItemType: "Service"`, `mindbodyServiceId` 100133/100134/100135, `mindbodyContractProductId` 101/102/100, `minimumCommitmentMonths: 3`, `earlyCancellationFeePercent: 50`.
* Updated `_doc` and `_pinnedAgainstStudio` to describe both checkout paths.
* Bumped `_schemaVersion` 1 → 2.

### `src/content/mb-contract-terms.config.json`

* `byCheckoutServiceId` now maps both old and new IDs to the same product key (no break for existing Mindbody Classic flow):

  | Mindbody Service Id | productKey | Marketing plan        |
  | ------------------- | ---------- | --------------------- |
  | 100129 (legacy)     | 101        | 5 Classes Monthly     |
  | 100130 (legacy)     | 102        | 8 Classes Monthly     |
  | 100056 (legacy)     | 100        | Unlimited Monthly     |
  | 100133 (Stripe)     | 101        | 5 Classes Monthly     |
  | 100134 (Stripe)     | 102        | 8 Classes Monthly     |
  | 100135 (Stripe)     | 100        | Unlimited Monthly     |
* Updated `summaryLines` and `termsHtml` for products 101 and 102 to match real Mindbody behaviour around unused classes:
  > "Unused classes are valid only until their original expiration date and do not extend beyond their billing cycle. New monthly credits do not extend or renew unused credits from prior cycles."
* Bumped `contractVersion` 101 + 102: `2026-05-05-v1` → `2026-05-14-v2`. Product 100 (Unlimited) text was unchanged so its version stays at `v1`.
* Added `aliasesByNormalizedName` entries for the new Mindbody service names.

Verification: `resolveManualContractEntryByServiceId(cfg, 100133)` returns `{ productKey: "101", contractVersion: "2026-05-14-v2", marketingPlanName: "5 Classes Monthly Membership" }`; same for 100134→102 and 100135→100; old IDs unchanged.

`netlify/functions/_embedded/*.json` regenerated via `npm run build`.

## 4. Code changes (LANDED 2026-05-14 — see section 8 for verification proof)

> Sections 4.1–4.5 below describe the design that was actually implemented. Where the implementation diverged from the original design (e.g., the addition of `mindbodyDisplayServiceId`, the eager first-invoice sync, and the local-memory store fallbacks), the divergence is documented in **Section 9 — Lessons learned & fixes**. Reading the design here in isolation will be misleading without that section.

### 4.1. New module — `netlify/functions/stripe-subscription-store.mjs`

A Netlify Blobs–backed store mirroring `stripe-order-store.mjs` but for subscription records. Schema (TypeScript-style):

```ts
type SubscriptionRecord = {
  id: string;                              // our own subscription id (sub_amare_xxxxx)
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  stripeCheckoutSessionId: string;         // session that created it
  localSku: "monthly_5" | "monthly_8" | "monthly_unlimited";
  mindbodyServiceId: 100133 | 100134 | 100135;
  mindbodyClientId: number | null;         // resolved on first invoice.paid
  status: "pending_first_invoice"          // checkout completed, waiting for invoice.paid
        | "active"                         // at least one invoice.paid synced
        | "past_due"                       // last attempted invoice failed
        | "canceled_admin"                 // admin canceled in Stripe Dashboard
        | "canceled_payment_failure";      // Stripe gave up after smart retries
  createdAt: string;                       // ISO8601
  updatedAt: string;
  consent: {
    contractVersion: string;               // e.g., "2026-05-14-v2"
    productKey: "100" | "101" | "102";
    agreementAccepted: true;
    billingAuthorized: true;
    legalName: string;
    acceptedAt: string;
    clientIp: string;
    userAgent: string;
    agreementTextSnapshot: string;         // HTML snapshot of termsHtml at acceptance time
    consentBlobKey: string;                // pointer to the existing membership-consents store
  };
  invoices: Array<{
    invoiceId: string;                     // Stripe invoice id (idempotency key)
    paidAt: string;
    amountPaidCents: number;
    mindbodySync: {
      status: "synced" | "paid_but_not_synced" | "skipped_payment_failed";
      mindbodySaleId: string | null;
      mindbodyTransactionId: string | null;
      attemptedAt: string;
      lastError?: string;
      retryCount: number;
    };
  }>;
};
```

Functions: `openSubscriptionStore`, `getSubscription`, `upsertSubscription`, `appendInvoiceSync`, `markSubscriptionStatus`, `listSubscriptionsByStripeCustomer`, `listSubscriptionsAwaitingRetry`.

### 4.2. Extend `stripe-create-checkout-session.mjs`

When the body's `localSku` resolves to a catalog item with `kind === "monthlyMembership"`:

* Reject unless `ENABLE_STRIPE_RECURRING_CHECKOUT === "1"` AND the catalog item's `enabled === true`.
* Require `agreementAccepted`, `agreementBillingAuthorized`, `agreementVersion`, `legalName` in the request body.
* Validate consent via the existing `validateMembershipElectronicConsent(...)` (no changes to that function — adding `100133/4/5` to `byCheckoutServiceId` is what makes it route correctly).
* Persist consent to the existing `mindbody-membership-consents` Blobs store (already implemented). Capture the returned blob key.
* Resolve / create Mindbody client (reuse `resolveOrCreateMindbodyClient` — same as one-time path).
* **Resolve or create the Stripe Customer BEFORE creating the Checkout Session** — Stripe subscriptions need a stable, persistent `customer` (not the per-session `customer_email`) so renewal invoices, payment-method changes (admin-managed), and any future limited portal can attach to a single record. Lookup priority:
  1. `SubscriptionRecord` keyed by `stripeCustomerId` for this Mindbody client (same email/clientId already subscribed in the past) — reuse it.
  2. `OrderRecord` for prior one-time purchases by the same email — reuse the customer id.
  3. `stripe.customers.search({ query: "email:'<email>'" })` — pick the most recent.
  4. `stripe.customers.create({ email, name, metadata: { mindbodyClientId } })`.
  Always overwrite/upsert `metadata.mindbodyClientId` on the resolved customer so future webhook lookups can map either direction.
* Create a Stripe Subscription Checkout Session:
  ```ts
  await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{
      price_data: {
        currency: "usd",
        product_data: { name: catalogItem.displayName, metadata: { localSku, mbServiceId: String(catalogItem.mindbodyServiceId) } },
        unit_amount: catalogItem.amountCents,
        recurring: { interval: "month" },
      },
      quantity: 1,
    }],
    customer: stripeCustomerId,                        // resolved/created above — required for subscriptions
    customer_update: { address: "auto", name: "auto" },
    metadata: {
      orderType: "monthly_membership",
      localSku,
      mindbodyClientId: String(mbClientId),
      mindbodyServiceId: String(catalogItem.mindbodyServiceId),
      consentBlobKey,
    },
    subscription_data: {
      metadata: { /* same as session metadata for webhook lookup */ },
      // No trial. No automatic cancellation rule.
    },
    success_url: `${SITE_URL}/checkout/success?session_id={CHECKOUT_SESSION_ID}&kind=membership`,
    cancel_url: `${SITE_URL}/checkout/cancel?kind=membership`,
    allow_promotion_codes: false,                      // V1 — no promo on memberships
    payment_method_collection: "always",
    consent_collection: { terms_of_service: "none" },  // we collect consent ourselves
  });
  ```
  We deliberately do NOT pass `billing_portal` or any portal-related option, and we do NOT generate any portal link anywhere in the codebase for V1.
* Persist a `pending_first_invoice` subscription record before returning the session URL (so the webhook can attribute even races).

### 4.3. Extend `stripe-webhook.mjs`

Add three new event branches **before** the existing `checkout.session.completed` branch (so subscription mode short-circuits the one-time order flow):

```js
// 1. Subscription checkout completed: persist mapping, no Mindbody call yet.
if (evt.type === "checkout.session.completed" && session.mode === "subscription") { /* upsert SubscriptionRecord, status: pending_first_invoice; ack and return */ }

// 2. Invoice paid (FIRST and EVERY renewal): sync ONE Service row to Mindbody.
if (evt.type === "invoice.paid") { /* idempotency via invoice.id; reuse syncOneTimePurchaseToMindbody */ }

// 3. Payment failed: mark past_due; do NOT sync; rely on Stripe Smart Retries.
if (evt.type === "invoice.payment_failed") { /* updateStatus: past_due; record attempt */ }

// 4. Subscription canceled or deleted: stop future syncs.
if (evt.type === "customer.subscription.deleted") { /* updateStatus based on cancellation_details.reason */ }

// 5. Subscription updated (e.g., admin pauses, default payment changed): reflect status only; no Mindbody change.
if (evt.type === "customer.subscription.updated") { /* update status; reconcile cancel_at_period_end */ }
```

The `invoice.paid` path is the only one that calls `syncOneTimePurchaseToMindbody`. Reuses the existing function unchanged — pass:
* `clientId` from the SubscriptionRecord.
* `mindbodyServiceId` from the SubscriptionRecord (cached at checkout — never re-resolved at runtime to avoid drift).
* `amountCents = invoice.amount_paid` (paid cents) AND `paidAmountCents = invoice.amount_paid` (no coupon support on memberships in V1, so list = paid).
* `discountAmountCents = 0`.
* PayNotes formatted as `subId=<our-id>; invoice=<stripe-invoice-id>; sku=<localSku>; renewal=<n>`.

If `syncOneTimePurchaseToMindbody` returns `ok: false`, write `paid_but_not_synced` to the SubscriptionRecord's invoice array and return 500 so Stripe retries the webhook (existing pattern from one-time orders).

### 4.4. Frontend — `src/js/pricing-api.js`

The membership purchase dialog already exists and is fully built (consent checkboxes, legal name, terms HTML rendering). Only the submit handler needs to branch:

* If `ENABLE_STRIPE_RECURRING_CHECKOUT_FRONTEND === "1"` (build-time flag injected like `ENABLE_STRIPE_ONE_TIME_CHECKOUT`) **AND** the chosen plan is one of `monthly_5/8/unlimited`, POST to `/api/stripe/checkout/create-session` with `localSku` + consent fields, then `window.location = session.url`.
* Otherwise, fall back to the existing Mindbody Classic `/classic/ws?stype=40&prodid=...` link (unchanged).

This means we can roll out per-environment without touching the existing Mindbody Classic UX.

### 4.5. New admin endpoint — `netlify/functions/stripe-admin-subscriptions.mjs`

Mirror of `stripe-admin-orders.mjs` for the subscription store. V1 read-only-plus surface:

* List subscriptions (filter by status, by Mindbody client id, by Stripe customer id).
* Surface `paid_but_not_synced` invoices with diagnostic detail.
* Action: "retry Mindbody sync" for a specific invoice (re-runs `syncOneTimePurchaseToMindbody` and updates the SubscriptionRecord).

Explicitly NOT exposed in V1:

* No "cancel subscription" button. Cancellation is performed manually in the Stripe Dashboard; our webhook reflects the result via `customer.subscription.deleted`.
* No "issue billing portal link" action.
* No "change plan" action.
* No "update payment method" action.

This keeps the admin surface narrow and aligned with the V1 promise of studio-managed lifecycle.

### 4.6. New env vars

| Variable                                       | Default | Purpose                                                                 |
| ---------------------------------------------- | ------- | ----------------------------------------------------------------------- |
| `ENABLE_STRIPE_RECURRING_CHECKOUT`             | `0`     | Master kill switch for the entire feature (server-side).                 |
| `ENABLE_STRIPE_RECURRING_CHECKOUT_FRONTEND`    | `0`     | Build-time flag that decides whether `pricing-api.js` calls Stripe vs Mindbody Classic for memberships. |
| `STRIPE_RECURRING_WEBHOOK_EVENTS_ALLOWED`      | `invoice.paid,invoice.payment_failed,customer.subscription.deleted,customer.subscription.updated` | Allowlist (for safety; optional). |

No new Mindbody env vars — the existing `MINDBODY_STRIPE_PAYMENT_METHOD_ID` / `MINDBODY_STRIPE_PAYMENT_METHOD_NAME` cover the Custom payment row.

## 5. Idempotency & ordering guarantees

* **Subscription mapping**: keyed by `stripeSubscriptionId`. Webhook retries are idempotent thanks to upsert.
* **Per-invoice sync**: keyed by `invoice.id` inside the SubscriptionRecord's `invoices` array. If we see an `invoice.paid` event whose `invoice.id` is already present with `status: "synced"`, we ack 200 immediately without calling Mindbody.
* **First-invoice race**: Stripe sometimes fires `invoice.paid` before `checkout.session.completed`. Handle by:
  1. If `invoice.paid` arrives first → look up SubscriptionRecord by `invoice.subscription`. If missing, ack with 500 so Stripe retries; the next checkout.session.completed will create the record, and the retried invoice.paid will succeed.
  2. If `checkout.session.completed` arrives first → standard path, no race.
* **Mindbody timeouts**: existing `syncOneTimePurchaseToMindbody` returns `retryable: true` on timeouts. Webhook returns 500, Stripe retries on its standard schedule; the deduplication on `invoice.id` ensures we don't double-grant credits.

## 6. Rollout plan

1. Land catalog/terms changes — **DONE this turn**.
2. Implement code changes in 4.1 → 4.5 above. Land behind `ENABLE_STRIPE_RECURRING_CHECKOUT=0` and `enabled: false` per SKU.
3. Configure Stripe Test mode webhook endpoint to receive the new events. Verify signature.
4. End-to-end test in Stripe Test + Mindbody Test mode:
   * Subscribe to monthly_5 with `4242` test card.
   * Verify `checkout.session.completed` stores SubscriptionRecord (status `pending_first_invoice`).
   * Verify `invoice.paid` syncs to Mindbody with `Test: true` cart and stores `synced` invoice entry.
   * Use Stripe's "Advance billing cycle" to trigger a second `invoice.paid`. Verify a SECOND Mindbody Service row is granted with a new ExpirationDate.
   * Use `4000 0000 0000 0341` (test card that fails on subscription billing) to verify `invoice.payment_failed` does NOT add credits.
   * Cancel via Stripe Dashboard. Verify `customer.subscription.deleted` stops future sync.
5. Flip `enabled: true` for `monthly_5` only on staging, with `ENABLE_STRIPE_RECURRING_CHECKOUT=1`. Sanity test with a real $0.50 test plan.
6. Production rollout SKU-by-SKU after each cycle's invoice.paid is observed end-to-end in real Mindbody.

## 7. Open questions for product owner

1. ~~**Cancellation UX in V1 admin tooling**~~ — **Resolved 2026-05-14:** the studio cancels subscriptions directly in the Stripe Dashboard. Our backend reflects the result via `customer.subscription.deleted`. No "cancel" button in our admin endpoint, no Customer Portal in V1.
2. **Refunds** — if an admin issues a Stripe refund for an already-synced invoice, should we automatically remove the corresponding Mindbody Service row? V1 default is **no** — the refund is recorded in Stripe + a manual Mindbody adjustment is the studio's call.
3. **Plan change UX** — out of scope for V1. Confirm: the studio communicates plan changes via WhatsApp/email, then admin cancels old sub via Stripe Dashboard + customer signs up for the new sub through the same Stripe Checkout flow. Any unused credits from the old plan keep their original expiration date (per the agreement wording we just locked in).
4. **Trial / first-month discount** — out of scope for V1. If marketing wants a first-month-half-off campaign later, we'd add `subscription_data.discounts` to the checkout session and update the agreement wording.
5. **Future limited Customer Portal (post-V1)** — once the recurring flow is stable in production, we may expose a Stripe-hosted portal restricted to *payment-method updates and invoice/receipt access only*. That portal will explicitly disable cancellation, plan switching, and pause via the Stripe Portal Configuration. Not part of V1; flagged here for tracking.

---

## 8. Implementation status — V1 verified locally (2026-05-14)

V1 implemented and verified locally on **2026-05-14 with Monthly 5**. Local sandbox + Mindbody live test mode + Stripe test mode.

### Verified end-to-end proof

| Stage | Evidence |
| ----- | -------- |
| Stripe Subscription Checkout succeeded | Stripe Checkout page rendered with "Subscribe to Monthly 5 Classes / $125.00 per month / 5 classes per billing cycle, renews monthly. 3-month minimum commitment." Card `4242…` accepted. |
| Consent dialog worked | `<dialog>` opened with the membership terms snapshot, both checkboxes (agreement + billing authorization) gated the Submit button, full legal name field captured. |
| `SubscriptionRecord` was created | `stripe_subscription_session_created` log line: `subscriptionId="sub_amare_FC72N1S62NNRT0QB"`, `localSku="monthly_5"`, `monthlyAmountCents=12500`, `mindbodyClientId=100002753`, `mindbodyServiceId=100133`, `stripeCustomerId="cus_UVj6EYWf68OPKC"`, `commitmentMonths=3`. |
| `checkout.session.completed` was handled | `stripe_webhook_subscription_session_completed` log line with `stripeSubId="sub_1TWtjeAjsONx3mgIlVKNX3CH"`, `currentStatus="pending_first_invoice"`. |
| Eager first-invoice sync worked | `stripe_webhook_subscription_eager_first_invoice_synced` log line with `eagerStatus="synced"`, `eagerNoop=false`, `invoiceId="in_1TWtjbAjsONx3mgIgrFCN439"`. |
| Mindbody Sale ID **11707** was created | Mindbody → Snir17 → Purchases tab shows Sale ID `11707`, Sale Date `05/14/2026`, **Payment Method: Stripe**, Description `AMARÉ Monthly 5 Classes`, Location `Online Store`, Price $125.00, Quantity 1, Amount Paid $125.00, Payment Ref `8853`. |
| Mindbody received Service ID **100133** | The Sale row description "AMARÉ Monthly 5 Classes" maps to `mindbodyServiceId: 100133` per the catalog (`monthly_5` SKU). The legacy `100129` was NOT used — verified the server picked the new API-only Service ID. |
| Success page showed "membership active" | `/checkout/success?session_id=cs_test_a1PA9zm…` rendered: "Thank you — payment received / Your monthly membership is active. You can book classes now. / Order: sub_amare_FC72N1S62NNRT0QB / Package: monthly_5 / Amount: $125.00". |

### Test client used

* **Mindbody Client ID**: `100002753` (Snir17 Elhararl7, `snir17@pic-smart.com`)
* **Stripe Customer**: `cus_UVj6EYWf68OPKC`

### Test sales recorded during verification

* **SaleId 11707** — final successful E2E run (2026-05-14, Monthly 5 Classes, paid via Stripe, $125.00).
* **SaleIds 11701–11706** — earlier `mindbody-membership-service-probe.mjs` API verification runs (2026-05-14, Custom/Stripe payment method, no real card charged).
* All test sales can be cleaned up manually from the Mindbody Sales dashboard later. They do NOT block production rollout.

### Orphaned subscriptions from this debug session

The following Stripe Subscriptions in the SubscriptionRecord store reached `pending_first_invoice` but never advanced because the eager-sync code didn't exist yet at the time:

* `sub_amare_XWDQYA2G77202QPA` — first failed attempt (no `invoice.paid` webhook delivered).
* `sub_amare_S6B2G2XYZGM6GQ8J` — second attempt (Stripe Customer Portal pre-eager-sync).
* `sub_amare_9VT3XG2AF0X7784T` — third attempt (eager sync hit `noop_no_record` because of the `invoice.subscription`-null bug — see § 9.9).

These will be wiped by the next dev-server restart (in-memory store) and have NO Mindbody-side effect (no `CheckoutShoppingCart` was called for any of them). On Netlify Blobs in production this would not happen — the eager sync now succeeds on the first attempt.

---

## 9. Lessons learned & fixes (from the 2026-05-14 implementation cycle)

The original design (sections 4.1–4.5) was sound but missed several integration details that only surfaced in local testing. Each item below documents what broke, the root cause, and the fix — read this before extending the feature.

### 9.1. Frontend was falling back to Mindbody Classic too early

**Symptom**: Clicking "Subscribe" on `/pricing` opened the Mindbody Classic checkout in a new tab. The membership consent dialog never opened.

**Root cause**: `openCheckoutFlow` in `src/js/pricing-api.js` short-circuited to `openMindbodyClassicInNewTab(href)` whenever `PRICING_MINDBODY_EXPRESS_CHECKOUT_ENABLED === false` (the studio's normal state) — *before* the dialog was even rendered. The Stripe Recurring fork inside the dialog's Submit handler was unreachable.

**Fix**: Resolve `lookupStripeRecurringSku(checkoutServiceId(row))` early. When it returns a recurring SKU entry AND the row is recurring, bypass the Classic short-circuit and proceed to render the dialog. Logic gate:

```js
const earlyStripeRecurring = earlyIsRecurring
  ? lookupStripeRecurringSku(checkoutServiceId(row))
  : null;

if (
  !earlyStripeRecurring &&
  !PRICING_MINDBODY_EXPRESS_CHECKOUT_ENABLED &&
  typeof classicEarly === "string" &&
  classicEarly.trim()
) { /* short-circuit to Classic — original behaviour */ }
```

### 9.2. Dialog was not rendering Submit because `expressOnSiteAllowed` was false

**Symptom**: Even after the dialog opened, the only CTA shown was "Continue to Mindbody". Submit (the button that triggers the Stripe fork) never rendered.

**Root cause**: Inside the dialog flow, `expressOnSiteAllowed` was computed from `PRICING_MINDBODY_EXPRESS_CHECKOUT_ENABLED && hasStoredCardFromApi`. Both are `false` in our setup (no Mindbody on-site Express, no Mindbody stored card needed for Stripe). The dialog took the "Continue to Mindbody" branch and `runBtn` was never created.

**Fix**: Force `expressOnSiteAllowed = true` for Stripe-recurring rows — Stripe captures the card on its own hosted page; we don't need a Mindbody stored card.

```js
const stripeRecurringSubscriptionAllowed =
  !!earlyStripeRecurring && consumerApisAuthenticated;

const expressOnSiteAllowed =
  hasStoredCardFromApi === true || stripeRecurringSubscriptionAllowed;
```

### 9.3. AbortController TDZ issue

**Symptom**: As soon as the Stripe fork tried to run inside the Submit click handler, `ReferenceError: Cannot access 'ac' before initialization`.

**Root cause**: The Stripe fork referenced `ac.signal` from a code block that *preceded* the `const ac = new AbortController()` declaration (which lived at the top of the Mindbody Classic POST flow further down).

**Fix**: Hoisted the `ac` + `abortT` declarations to the top of the click handler, so both the Stripe fork and the Mindbody fallback share the same `AbortController`. Both branches honour the `checkoutClientWaitMs` timeout via the same `signal`.

### 9.4. Display service IDs vs API-only service IDs

**Symptom**: After all the above were fixed, clicking Subscribe still fell through to Mindbody Classic.

**Root cause**: Mindbody's `/sale/contracts` endpoint only surfaces Pricing Options that are flagged `Sell online: Yes`. The new API-only Service IDs (100133/100134/100135) have `Sell online: No`, so Mindbody renders the existing pricing rows with the **legacy** Pricing Option IDs (100129/100130/100056). The frontend's `byMindbodyServiceId` map was keyed only on the new IDs → `lookupStripeRecurringSku(100129)` returned `null` → fall-through.

**Fix**: Added a `mindbodyDisplayServiceId` field to each `monthlyMembership` SKU in `src/content/stripe-mindbody-catalog.config.json`, and updated `stripeRecurringConfigJson()` in `scripts/build.mjs` to register **both** the API-only `mindbodyServiceId` and the legacy `mindbodyDisplayServiceId` as keys in `byMindbodyServiceId` (pointing at the same SKU entry). The server still uses the new `mindbodyServiceId` (100133) when calling `CheckoutShoppingCart` — the display ID is purely a UI matcher.

```json
{
  "localSku": "monthly_5",
  "mindbodyServiceId": 100133,        // NEW (API-only) — server uses this for Mindbody sync
  "mindbodyDisplayServiceId": 100129  // LEGACY — frontend uses this to recognize the existing card
}
```

### 9.5. Hiding irrelevant Mindbody fields for recurring flow

**Symptom**: The dialog showed "Promotion code", "Dry run — Mindbody Test mode", and "I understand this may charge the card Mindbody keeps on file" — none of which apply to a Stripe Subscription.

**Root cause**: The dialog template was originally designed only for the Mindbody Classic on-site flow.

**Fix**: Conditional render. For Stripe-recurring rows, the dialog renders only the membership terms inset + the two consent checkboxes + the Submit button + the log `<pre>`. The Mindbody warm-up fetch (`/sale/checkout-warmup`) is also skipped. No data leakage in either direction.

### 9.6. Local Netlify Blobs fallback

**Symptom**: Server returned `503 subscription_store_unavailable` and `503 membership_consent_storage_unavailable` on every recurring checkout attempt during local dev. The frontend correctly fell through to "Check the confirmation box" — but no testing was possible.

**Root cause**: `npm run dev` (via `unified-local-dev.mjs`) does NOT initialize Netlify Blobs context. `subStore.available` and `tryOpenMembershipConsentBlobStore()` returned `null` → server returned 503.

**Fix**: Added in-memory store fallbacks gated by env flags:

* `STRIPE_SUBSCRIPTION_STORE_LOCAL_MEMORY=1` — activates the in-memory shim in `stripe-subscription-store.mjs` (mirrors the existing `STRIPE_ORDER_STORE_LOCAL_MEMORY=1` pattern).
* `MINDBODY_MEMBERSHIP_CONSENT_LOCAL_MEMORY=1` — activates the in-memory shim in `membership-consent-blobs.mjs` (new flag added this turn).

Both flags are gated by the absence of the `NETLIFY` env var, so they cannot accidentally activate in production. See § 10.

### 9.7. Success page subscription support

**Symptom**: After successful Stripe Checkout, `/checkout/success?session_id=cs_test_…` displayed: "We couldn't find that order. If you just paid, please refresh in a moment."

**Root cause**: `/api/stripe/order-status` only looked up `OrderRecord` (one-time orders). For a subscription session id, it returned 404.

**Fix**: Extended `netlify/functions/stripe-order-status.mjs` to also query `openSubscriptionStore(event)` after the OrderRecord lookup misses. Added `publicSubscriptionSummary(sub)` that returns the same shape as the order summary (`bucket`, `message`, `orderId`, `localSku`, `amountCents`, etc.) — the success page renders without changes. Added subscription-specific fields (`minimumCommitmentMonths`, `commitmentEndDate`, `currentPeriodEnd`) for the page to surface later if needed.

### 9.8. Eager first-invoice sync

**Symptom**: After Stripe payment succeeded and `checkout.session.completed` was processed, the SubscriptionRecord stayed at `pending_first_invoice` indefinitely. No Mindbody Sale was created. Customer was charged but received no credits.

**Root cause**: Stripe was sending `invoice.paid` for the first invoice, but the local webhook only had `checkout.session.completed` enabled in the listening pipe. `invoice.paid` was never delivered.

**Fix**: Added an **eager first-invoice sync** inside `handleSubscriptionCheckoutCompleted`:

1. After binding the SubscriptionRecord, fetch the parent Stripe Subscription.
2. Pull the `latest_invoice` id from the subscription.
3. Re-fetch the invoice via `stripe.invoices.retrieve(invoiceId)` to get the canonical form.
4. If the invoice is `paid` and `amount_paid > 0`, run the same `handleInvoicePaid(...)` synchronously.

Idempotency in `handleInvoicePaid` (dedup by `invoice.id` in `record.invoices[]`) ensures that a separate `invoice.paid` webhook delivery for the same invoice id is a no-op. The eager sync is **defence in depth** for the first invoice only — see § 12 for why this matters in production.

### 9.9. `invoice.subscription` null issue during eager sync

**Symptom**: First attempt at the eager sync logged `eagerStatus: "noop_no_record"` and `stripeSubId: null` inside `stripe_webhook_invoice_paid_no_record`. Mindbody still didn't sync.

**Root cause**: When fetching `latest_invoice` via `subscriptions.retrieve(sub_id, { expand: ["latest_invoice"] })`, Stripe omits the back-reference field `invoice.subscription` to prevent recursive expansion. `handleInvoicePaid` extracted `stripeSubId` from `invoice.subscription` → got `null` → couldn't resolve our `SubscriptionRecord` → bailed out.

**Fix** (defence in depth):

1. Switched to a fresh `stripe.invoices.retrieve(invoiceId)` (without `expand`) — the canonical form does include `invoice.subscription`.
2. Belt-and-braces: even after the fresh fetch, if `invoice.subscription` is still falsy, force-set it to the known `stripeSubId`:

   ```js
   if (!firstInvoice.subscription) {
     firstInvoice.subscription = stripeSubId;
   }
   ```

This makes the eager sync robust against any future Stripe SDK quirks around back-reference fields.

### 9.10. `SubscriptionRecord.stripeSubscriptionId` stuck on `pending_<id>` placeholder

**Symptom**: Surfaced during admin endpoint testing on 2026-05-14 — the admin GET response contained `"stripeSubscriptionId": "pending_sub_amare_5PAKP25NY3TV2JC1"` instead of the real Stripe `sub_…` for a record that had completed checkout and synced to Mindbody successfully (Sale 11707 created, 5 credits added, membership Active).

**Why it didn't break sync**: Mindbody sync still worked because `handleSubscriptionCheckoutCompleted` calls `subStore.bindStripeSubscription(stripeSubId, record.id)` AFTER the patch attempt. That call writes to the `byStripe` Blobs index, which is the path used by `getByStripeSubscriptionId` for renewal lookups. The record body's own `stripeSubscriptionId` field was never read at runtime — only by the admin UI / human ops.

**Root cause**: `stripe-subscription-store.mjs::patch()` was force-restoring `stripeSubscriptionId: before.stripeSubscriptionId` on every patch, treating it as fully immutable. This silently override the legitimate transition that `handleSubscriptionCheckoutCompleted` was attempting:

```js
if (stripeSubId && record.stripeSubscriptionId !== stripeSubId) {
  patch.stripeSubscriptionId = stripeSubId;
}
patch.stripeLivemode = ...;
await subStore.patch(record.id, patch);
```

The patch arrived correctly, but the store layer dropped the field before write.

**Fix** (landed 2026-05-14):

1. **`stripe-subscription-store.mjs::patch()`** — allow the one-time `pending_<id>` (or non-real-Stripe-format) → `sub_<…>` transition. Reject and log `stripe_subscription_patch_rejected_*` for:
   * regression `sub_…` → `pending_…`
   * rebinding from one `sub_…` to a different `sub_…` (data-loss risk: would silently steal another customer's subscription record)
   * non-string or empty values that don't match `^sub_…$`
2. **`stripe-webhook.mjs::resolveSubscriptionRecord()`** — auto-heal stale records: when `getByStripeSubscriptionId` returns a record whose own field still mismatches the real id, issue the patch in place and emit `stripe_subscription_auto_heal_stripeSubId`. Existing broken records in production self-heal on the next `invoice.paid` / `subscription.updated` / `subscription.deleted` event — no manual migration script required.

**Lesson**: When a function intentionally protects fields as immutable, distinguish between "truly immutable" (e.g. `id`, `createdAt`) and "monotonic state machine" (placeholder → real). Use a `^pattern$` test or a state-machine guard for the latter, not a blanket override. Don't rely on a separately-written index to mask a stale primary record — admins read primary records.

### 9.11. `invoice.subscription` moved in Stripe API `2026-04-22.dahlia`

**Symptom** (during Test Clock renewal simulation 2026-05-14, ~20:30 UTC+3): a successful `stripe invoices pay` produced a real Stripe `invoice.paid` event delivered through the ngrok-fronted Dashboard webhook. The webhook arrived (`stripe_webhook_recurring_event_received eventId=… type=invoice.paid livemode=false`), passed signature verification, but immediately returned `stripe_webhook_invoice_paid_no_record stripeSubId=null invoiceId=in_…`. Mindbody never received a second Sale.

**Root cause — API version mismatch between SDK and Dashboard endpoint**:

* Our backend's Stripe SDK is pinned to API version `2025-08-27.basil` (see `new Stripe(sk, { apiVersion: ... })` in `stripe-webhook.mjs` and `stripe-create-checkout-session.mjs`). When OUR code calls `stripe.invoices.retrieve(...)`, Stripe returns the legacy invoice shape with `invoice.subscription` populated as a top-level string. This is why the **eager first-invoice sync worked** — it uses our SDK call directly.
* But the **Stripe Dashboard webhook endpoint** (`we_…`) auto-pinned itself to `2026-04-22.dahlia` (the current default for newly created endpoints in 2026). Webhooks delivered through that endpoint use the endpoint's own API version, NOT the SDK's. In `2026-04-22.dahlia`, Stripe restructured invoice ↔ subscription back-references: `invoice.subscription` is no longer present, and the data lives at:

  ```
  invoice.parent.subscription_details.subscription   // Stripe sub_id
  invoice.parent.subscription_details.metadata       // our subscription_data.metadata
  invoice.parent.type === "subscription_details"     // discriminator
  ```

  Our `handleInvoicePaid` and `handleInvoicePaymentFailed` only read `invoice.subscription`, so they got `""` for every webhook delivery → resolution failed → `noop_no_record`.

**Fix** (landed 2026-05-14):

1. Added a helper `extractInvoiceSubscriptionId(invoice)` in `stripe-webhook.mjs` that probes the legacy shape first (so SDK-originated calls keep working) and falls back to `invoice.parent.subscription_details.subscription` for new-shape webhook payloads.
2. Replaced both inline extractions in `handleInvoicePaid` and `handleInvoicePaymentFailed` with the helper.
3. Updated the eager-sync defensive write to use the helper for its emptiness check.

**Side fix — Dashboard webhook endpoint events were missing**: while debugging this we discovered the active ngrok endpoint had `enabled_events` set to only the four `checkout.session.*` variants — `invoice.paid`, `invoice.payment_failed`, `customer.subscription.*`, and `charge.refunded` were never being delivered. We updated the endpoint via API (preserving the `whsec_…` so no `.env` change needed):

```bash
stripe webhook_endpoints update we_<id> \
  -d "enabled_events[]=checkout.session.completed" \
  -d "enabled_events[]=invoice.paid" \
  -d "enabled_events[]=invoice.payment_failed" \
  -d "enabled_events[]=customer.subscription.updated" \
  -d "enabled_events[]=customer.subscription.deleted" \
  -d "enabled_events[]=charge.refunded"
```

**Production lesson** (CRITICAL — copy into the Section 11 production checklist):

* When creating the production Stripe webhook endpoint, **VERIFY the API version Stripe assigns to it** (Dashboard → Webhooks → endpoint → "API version" or via `stripe webhook_endpoints retrieve we_…`). Stripe defaults to the current API version at the time of endpoint creation, NOT to the SDK version your backend uses.
* If the endpoint's API version does not match the SDK's pinned version, you have two options:
  1. **Pin the endpoint's API version** to match the SDK (`Update API version` in Dashboard, or `-d "api_version=2025-08-27.basil"` via CLI). Recommended for V1 — keeps payload shape predictable.
  2. **Keep the endpoint at the latest version** and ensure the handler code is shape-tolerant (we now have the helper, so this is also safe). Future-proof, but each new API version may shuffle other fields; audit-required after every Stripe major upgrade.
* Always test with one `Send test webhook` of every event type the endpoint listens to — the test event uses the endpoint's pinned API version, exposing shape mismatches before real customer events do.
* This bug would be invisible in any test that only relied on the eager sync (since that uses our SDK shape). It only surfaces on the **second** invoice — i.e. month-2 renewal in production. Test renewal flow with a real webhook delivery (Test Clock or manual `stripe invoices pay`) BEFORE flipping the recurring flags ON.

### 9.12. CRITICAL — concurrent webhooks created 3 duplicate Mindbody Sales for the same invoice

**Symptom** (immediately after fixing § 9.11, 2026-05-14 ~20:35 UTC+3): a fresh `monthly_5` Subscribe completed end-to-end. Mindbody UI showed **three** identical $125.00 "AMARÉ Monthly 5 Classes" Sales — IDs **11719, 11720, 11721** — all dated 05/14/2026, all for the same client, all paid via Stripe. The client received **15 credits instead of 5**. This is a P0 production bug.

Webhook log evidence:

```
1010: stripe_webhook_recurring_event_received type=invoice.payment_succeeded   ← source 1
1011: stripe_webhook_recurring_event_received type=invoice.paid                 ← source 2
1012: stripe_webhook_test_mode_decision (for checkout.session.completed)        ← source 3
1013: stripe_webhook_subscription_session_completed (eager sync starts)
1014: stripe_webhook_invoice_synced_to_mindbody invoiceId=in_1TX382… mbSaleId=… ← Sale #1
1015: stripe_webhook_invoice_synced_to_mindbody invoiceId=in_1TX382… mbSaleId=… ← Sale #2 (SAME invoiceId!)
1016: stripe_webhook_invoice_synced_to_mindbody invoiceId=in_1TX382… mbSaleId=… ← Sale #3 (SAME invoiceId!)
1017: stripe_webhook_subscription_eager_first_invoice_synced
```

All 3 webhook deliveries arrived within milliseconds of each other and were processed concurrently. Each handler instance:

1. Read the SubscriptionRecord — saw `invoices: []`.
2. Did the dedup-by-find check — no existing entry → proceed.
3. Called Mindbody — succeeded → another Sale row.
4. Appended the entry to `invoices[]`.

The dedup-by-find at step 2 was racy: the read happens BEFORE any of the three has finished step 4. Each handler observes the world as if it were the only one running. Three independent calls to Mindbody = three Sales.

**Three independent root causes contributed**:

1. **`invoice.payment_succeeded` is a duplicate of `invoice.paid`**. Stripe fires both events for the same successful payment — they are nominally near-synonyms. Listening to BOTH guarantees a 2x amplification on every renewal. Removed `invoice.payment_succeeded` from the Dashboard webhook endpoint via `stripe webhook_endpoints update we_… -d "enabled_events[]=…"` (preserving all other events).
2. **Eager first-invoice sync vs real `invoice.paid` race**. The eager sync runs inside `handleSubscriptionCheckoutCompleted` to provision Mindbody immediately on checkout completion — designed precisely to bypass dependency on the `invoice.paid` webhook (see § 9.8). But when both DO fire (which is the happy path in production), they race. This race is intrinsic to the architecture, not a config issue.
3. **Read-modify-write dedup is not atomic**. `appendInvoiceSync` does `get → check → append → setJSON`, with `await` points in between. JavaScript's event loop interleaves other handlers between awaits, even in a single Lambda container. In a multi-container production deployment the problem is strictly worse.

**Fix** (landed 2026-05-14):

1. **Removed `invoice.payment_succeeded`** from the ngrok Dashboard endpoint's `enabled_events`. The full set is now: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted`, `charge.refunded`. Production must use this same set.
2. **Atomic per-invoice claim** in `stripe-subscription-store.mjs`: new method `claimInvoiceSlot(subscriptionId, invoiceId)` writes a single key into a dedicated `stripe-mindbody-invoice-claims` Blobs namespace using `setJSON(..., { onlyIfNew: true })`. Whoever wins the claim gets to run Mindbody — every other concurrent invocation receives `acquired: false` and returns early with `dedup_via_claim`. This works **across Lambda containers** because Netlify Blobs `onlyIfNew` is a store-level conditional write (not in-process state).
3. **Two-stage dedup** in `handleInvoicePaid`:
   - Stage 1 (cheap): `record.invoices[]` find. Catches webhook redeliveries that arrive AFTER the original sync completed (most common case in production).
   - Stage 2 (atomic): `claimInvoiceSlot`. Catches the eager-sync-vs-`invoice.paid` race that stage 1 misses.
4. The claim is **never automatically released** even after a successful sync — it acts as a permanent receipt. Subsequent webhook redeliveries hit stage 1 dedup. The only path that needs release is operational recovery (worker crashed mid-sync): admin would call `releaseInvoiceClaim` then redeliver. Not exposed in V1 admin endpoint.

**Production cleanup of the duplicate Sales from this test run**: the studio must manually delete **two of the three** Sales 11719/11720/11721 in Mindbody (keep one), and reduce the client's credits from 15 back to 5. Going forward, the claim mechanism prevents this from recurring.

**Production-rollout addendum** (added to § 11):

* Production webhook endpoint MUST listen to `invoice.paid` ONLY, never to `invoice.payment_succeeded`. The two are near-synonyms in Stripe but our pipeline only treats `invoice.paid` as the trigger; subscribing to both = guaranteed 2x duplicate sync.
* Verify with `stripe webhook_endpoints retrieve we_<production_id>` that `enabled_events` does NOT include `invoice.payment_succeeded`.
* If you ever see two consecutive `stripe_webhook_invoice_synced_to_mindbody` log entries with the same `invoiceId` and different `mbSaleId`, the claim mechanism has a bug — escalate immediately.

---

### 9.13. Late `invoice.paid` after subscription cancellation must NOT grant new credits

**Symptom (theoretical, surfaced during Test 18 design review):** A subscription has been canceled (`canceled_admin` or `canceled_payment_failure`), but Stripe still has an `invoice.paid` event in flight (e.g., a stale event re-delivered hours later, or a manually-paid late invoice). The original `handleInvoicePaid` had no `record.status` guard, so it would have happily called Mindbody and granted another month of credits to a client who is no longer subscribed.

**V1 policy decision (approved by product on 2026-05-14):** A canceled subscription must NEVER receive new Mindbody credits from a future `invoice.paid`, regardless of when the invoice was paid relative to the cancel time. The studio explicitly does NOT want "the customer paid before we canceled, so they earned this month's credits" — if the studio cancels, the client gets no further credits.

**Fix landed on 2026-05-14 (alongside Test 18):**

1. New `InvoiceSyncEntry.status`: `"skipped_subscription_canceled"` (added to `VALID_INVOICE_SYNC_STATUSES` in `stripe-subscription-store.mjs`).
2. **Cancellation guard in `handleInvoicePaid`** (`stripe-webhook.mjs`): immediately after the cheap dedup-by-find but BEFORE the atomic claim, check `record.status`. If `canceled_admin` or `canceled_payment_failure`, append a `skipped_subscription_canceled` entry with `mindbodySaleId: null`, log `stripe_webhook_invoice_paid_skipped_canceled`, and return. We do this BEFORE the claim because a "skipped" outcome doesn't need cross-container atomicity — the cheap dedup at line 1217 catches re-deliveries on its own.
3. **Defense-in-depth in `retry-sync`** (`stripe-admin-subscriptions.mjs`): `skipped_subscription_canceled` is added to the `not_retryable` 409 list alongside `skipped_payment_failed` and `skipped_zero_amount`. An admin clicking Retry on a canceled-sub row gets a clear refusal — never a silent Mindbody sync.
4. **`failures` view excludes it** by construction (the failures view only surfaces `paid_but_not_synced`; this status is not a "failure to be retried" but a deliberate skip).

**Why we record at all (instead of silent ack):** The studio needs an audit trail. If a client disputes "Stripe charged me $125 after cancellation but I have no credits", we can show:

* `record.status: canceled_admin` + `canceledAt: …`
* `record.invoices[]` with the late entry: `status: skipped_subscription_canceled`, `amountPaidCents: 12500`, `lastError: subscription_canceled`

This is exactly the right answer for that customer-support call: "Yes, Stripe charged you, but the subscription was already canceled — no Mindbody credits were granted. Refund through Stripe Dashboard."

**Edge case — cancellation race window:** If `customer.subscription.deleted` and a paid `invoice.paid` arrive within seconds of each other and the deleted-handler hasn't yet patched the record's status, the invoice handler may briefly observe `record.status: active` and proceed to sync. This is acceptable for V1 — the race window is tiny in practice (Stripe doesn't normally fire both within the same second), and the cancel-from-Dashboard flow is studio-controlled. If this becomes a problem in production, V2 should serialize event processing per `subscriptionId` (e.g., via a per-sub mutex on the Blobs store).

### 9.14. Abandoned Stripe Checkout permanently locked the buyer out (`pending_first_invoice` orphans)

**Symptoms (production smoke test, 2026-05-14):** Buyer clicked Subscribe, was redirected to Stripe Checkout, hit Back without paying, returned to `/pricing.html`, clicked Subscribe again — and the create-session endpoint returned 409 `subscription_already_active` ("You already have an active Amaré monthly membership. Please contact us to change plans."). Stripe Dashboard showed **no subscriptions and no payments** for the buyer's customer record. The block was driven entirely by our local store.

**Root cause — three issues stacked together:**

1. **Premature `SubscriptionRecord` creation.** `stripe-create-checkout-session.mjs` writes a `SubscriptionRecord { status: "pending_first_invoice" }` BEFORE the buyer ever sees Stripe Checkout. This is necessary for race-safety (the duplicate-block must check against an authoritative store, not just Stripe itself), but it means every aborted attempt leaves an orphan.
2. **`block_if_active_subscription` treated `pending_first_invoice` as active forever.** `findActiveSubscriptionForClient()` looped over `["active", "pending_first_invoice", "past_due"]` with no age cutoff. An orphan from yesterday blocked a new attempt today — even though Stripe Checkout Sessions expire after 24h and the orphan can never reach `active`.
3. **`checkout.session.expired` handler ignored subscriptions.** The handler only patched one-time `OrderRecord`s — the comment explicitly said "we leave the SubscriptionRecord at `pending_first_invoice`". Result: even when Stripe eventually fires `expired` (~24h later), our record stays orphan-locked forever.

**Combined effect:** any buyer who abandoned Stripe Checkout was permanently locked out of buying any monthly membership until a developer manually edited the Blobs store.

**Fix — three layers of defense:**

1. **Auto-cleanup on `checkout.session.expired`** (`stripe-webhook.mjs`): when `session.mode === "subscription"` and our `SubscriptionRecord.status === "pending_first_invoice"`, the handler now patches the record to `canceled_admin` with `cancelReason: "stripe_session_expired"`. Logs `stripe_webhook_subscription_session_expired_cleaned`. This eventually unblocks the buyer without any manual action — but Stripe doesn't fire `expired` until the session's TTL hits (~24h), so we still need defense-in-depth for faster retries.
2. **Age cutoff in the duplicate check** (`stripe-create-checkout-session.mjs::findActiveSubscriptionForClient`): `pending_first_invoice` records that (a) still carry the `pending_<id>` placeholder (real Stripe sub never bound) AND (b) are older than **30 minutes** are skipped during the duplicate match. 30 minutes is well beyond a reasonable in-flight checkout (typical Stripe Checkout completion is ~2 minutes) and well within the 24h TTL — sessions in this window are effectively dead even if Stripe hasn't sent `expired` yet. Active/`past_due` records are NEVER skipped regardless of age.
3. **Admin abandon endpoint** (`stripe-admin-subscriptions.mjs`): `POST /api/stripe/admin/subscriptions/abandon` with body `{ subscriptionId, reason? }` patches a `pending_first_invoice` orphan to `canceled_admin`. Hard guardrails refuse to operate on records that are `active`/`past_due`, have any invoice history, or are bound to a real `sub_…` ID — those need a real Stripe Dashboard cancellation. Use case: studio wants to unblock a buyer immediately without waiting 30 minutes. Mindbody is NEVER touched.

**Why we don't simply remove `pending_first_invoice` from the duplicate check:** During the ~2-minute window between create-session and `checkout.session.completed`, an honest buyer might hit Subscribe again (e.g., refresh, second tab). Without a check, both clicks would create two real Stripe subscriptions with two real charges. The 30-minute cutoff lets in-flight checkouts finish safely while expiring true orphans.

**Production lesson:** any state machine where a record is created BEFORE the user-facing action completes needs a TTL-based cleanup path. Stripe gives us `checkout.session.expired` (~24h), but that's too slow for "buyer immediately retries" UX. The 30-minute store-side cutoff bridges the gap.

### 9.15. Coupon support for monthly subscriptions (V1.5)

**Status (2026-05-15):** Implemented behind `ENABLE_STRIPE_RECURRING_COUPONS=1`. Default OFF — must be flipped explicitly in Netlify env vars after the four-test verification matrix below passes.

**Why coupons on subscriptions need a separate flag from one-time NCS coupons:** Stripe Subscription coupons have three `duration` semantics that one-time charges don't have:

* `duration: once` → first invoice discounted; renewals at full price
* `duration: forever` → every invoice discounted
* `duration: repeating` (`duration_in_months: N`) → discount on first N invoices

The webhook reads each invoice's `total_discount_amounts` independently, so this is handled implicitly — we don't store the coupon shape on our side, and we never have to "remember" that a subscription has a coupon. Each `invoice.paid` event carries its own discount math.

**Implementation:**

1. **`stripe-create-checkout-session.mjs`** — subscription branch sets `allow_promotion_codes: recurringCouponsEnabled()`. With the flag OFF, byte-identical to V1.
2. **`stripe-webhook.mjs::extractInvoiceDiscountSnapshot(invoice)`** — per-invoice analog of `extractStripeAmountSnapshot(session)`. Reads:
   * `subtotalCents` from `invoice.subtotal` (pre-discount, pre-tax — Mindbody "RegularPrice")
   * `discountAmountCents` from sum of `invoice.total_discount_amounts[].amount` (Mindbody "DiscountAmount")
   * `taxAmountCents` from `invoice.tax` (always 0 in our setup, future-proof)
   * `paidCents` from `invoice.amount_paid` (Mindbody "AmountPaid")
   * `couponId` and `promotionCode` from `invoice.discounts[]` (lazy-expanded — only fetched when a coupon is actually present)
   * `isHundredPercentOffCoupon` flag (`paidCents === 0 && discountAmountCents > 0 && subtotalCents > 0`)
3. **`stripe-webhook.mjs::handleInvoicePaid`** — computes the snapshot once and threads `auditFields` through every `appendInvoiceSync` call (skip paths AND success path). Mindbody Sale arithmetic stays consistent: `RegularPrice (monthlyAmountCents) - DiscountAmount = AmountPaid`.
4. **Eager first-invoice retrieve** — adds `expand: ["discounts.coupon", "discounts.promotion_code"]` so the first invoice arrives at `handleInvoicePaid` already enriched, no extra round-trip.
5. **`InvoiceSyncEntry` schema** — adds `subtotalCents`, `discountAmountCents`, `taxAmountCents`, `couponId`, `promotionCode`. All optional — pre-coupon entries omit them entirely.
6. **`stripe-admin-subscriptions.mjs`** — surfaces the new fields in both `/subscriptions` listing AND `/failures` view. `retry-sync` now reuses the stored discount when re-syncing a `paid_but_not_synced` invoice (instead of hardcoded 0), so manual retries produce the SAME Mindbody arithmetic as the original webhook would have.

**Why per-invoice instead of per-subscription audit:** A `forever` coupon could be added/removed mid-subscription via Stripe Dashboard. By recording discount on each invoice independently, we always see the truth of what was actually charged for that month. No drift between snapshotted-at-signup and actual-billed.

**100%-off coupon policy (defense in depth):** V1.5 does NOT support 100%-off promotion codes for monthly SKUs. Operationally, the studio simply does not create them. Code-side, when `snapshot.isHundredPercentOffCoupon` is true, `handleInvoicePaid` records the invoice with `status: "skipped_zero_amount"`, `lastError: "coupon_100_percent_off_unsupported"` and a clear `lastErrorMessage` documenting the subtotal/discount math. Mindbody is NEVER called. The buyer was not charged ($0), so this is not a billing problem; it is a "credits not granted" outcome the studio can resolve manually if needed (issue a Pricing Option directly in Mindbody, then refund inside Stripe). Distinguished from a regular `$0` proration credit (where `subtotal: 0`, `discount: 0`) by the snapshot flag — different `lastError` makes the operational signal clear in admin.

**Verification matrix — all four must pass before flipping the flag in production:**

1. **Regression** — subscription without coupon → Mindbody Sale unchanged byte-for-byte from V1 (Sale 11728 baseline).
2. **`duration: once` percentage coupon (e.g. AMARE10 = 10% off once)** — first invoice: Sale RegularPrice $125, Discount $12.50, Paid $112.50. Renewal one month later: Sale RegularPrice $125, Discount $0, Paid $125. SubscriptionRecord `invoices[0]` has `discountAmountCents: 1250`, `invoices[1]` has `discountAmountCents: 0`.
3. **`duration: forever` percentage coupon (e.g. WELCOME10F = 10% off forever)** — every invoice: $125 / $12.50 / $112.50. SubscriptionRecord every entry has `discountAmountCents: 1250`.
4. **Fixed-amount coupon (e.g. SAVE20 = $20 off forever)** — every invoice: $125 / $20.00 / $105.00. Verifies cents-rounding on a non-divisible-by-percent value.

**Audit/admin observability:** the admin endpoint output for each invoice now includes `subtotalCents`, `discountAmountCents`, `couponId`, `promotionCode`. Customer support querying `/api/stripe/admin/subscriptions?subscriptionId=...` can answer "what did the buyer pay last month and why" without opening Stripe Dashboard.

---

### 9.16. CRITICAL — `@netlify/blobs` `setJSON(..., { onlyIfNew: true })` silently drops the conditional → duplicate Mindbody Sales returned (2026-05-15)

**What we observed.** First production live smoke test of recurring coupons (`snir7@pic-smart.com`, Monthly 8 Classes, 99% off promo `snir1212`, $1.79 paid). Two `stripe_webhook_invoice_synced_to_mindbody` events fired in the same second — one from container `92671557` (eager first-invoice sync inside `checkout.session.completed`) and one from container `2b55891c` (the regular `invoice.paid` webhook), **both for the same `(subscriptionId, invoiceId)` pair**, both ending with `attempts: 1`. Mindbody created **two real Sales — 11744 and 11745** — for the single $1.79 charge. The customer's class-credits page showed two duplicate "AMARÉ Monthly 8 Classes — 8 of 8 visits left" cards.

Crucially: neither `stripe_webhook_invoice_paid_dedup` (cheap dedup via `record.invoices[]`) nor `dedup_via_claim` (atomic Netlify Blobs claim) appeared in either container's logs. The atomic claim — V1's last line of defence against this exact race, added on 2026-05-14 — was bypassed.

**Root cause — bug in `@netlify/blobs` itself.** Verified by reading `node_modules/@netlify/blobs/dist/main.js` AND the current `main` branch at `github.com/netlify/primitives/packages/blobs/src/store.ts` on 2026-05-15. The `setJSON()` method passes its conditions object incorrectly to the underlying request:

```ts
// src/store.ts — setJSON (BROKEN)
const conditions = Store.getConditions(options)  // { onlyIfNew: true }
const res = await this.client.makeRequest({
  ...conditions,  // ← spreads onto top-level
  body: payload,
  ...
})

// src/store.ts — set (CORRECT)
const conditions = Store.getConditions(options)
const res = await this.client.makeRequest({
  conditions,     // ← passed as named property
  body: data,
  ...
})
```

`Client.makeRequest` destructures conditions from a *named* property:

```ts
async makeRequest({ body, conditions = {}, ... }) {
  ...
  if ("onlyIfNew" in conditions && conditions.onlyIfNew) {
    headers["if-none-match"] = "*"   // ← only fires when conditions is the named prop
  }
}
```

Because `setJSON` spreads `{ onlyIfNew: true }` instead of passing it under `conditions`, `makeRequest` always sees `conditions = {}`. The `if-none-match: *` header is **never sent**. The Netlify Blobs server treats the request as an unconditional PUT, both racing writes succeed, and both the SDK helpers return `{ modified: true }`. Our `claimInvoiceSlot()` thinks both callers won the claim, and we proceed to call Mindbody twice.

This silently affected **every** `setJSON(..., { onlyIfNew: true })` call across the codebase since these helpers were introduced. Local tests passed because our in-memory shim's `setJSON` checks `backing.has(key)` directly and is unaffected by the SDK bug.

**The fix.** New helper `netlify/functions/blobs-conditional-create.mjs` exports `atomicCreateJSON(store, key, value)` that:

* Uses `store.set(key, JSON.stringify(value), { onlyIfNew: true })` when the real Netlify Blobs `Store.set()` is available (it correctly forwards `conditions`).
* Falls back to `setJSON(...)` for the in-memory shim (which has correct conditional logic).

Reads via `store.get(key, { type: "json" })` continue to work because the SDK calls `res.json()` regardless of stored `Content-Type`.

Patched call sites (all four):

* `stripe-subscription-store.mjs::put({ onlyIfNew })` — first-write protection on `SubscriptionRecord` creation.
* `stripe-subscription-store.mjs::claimInvoiceSlot()` — **the one that produced the duplicate Sales.**
* `stripe-order-store.mjs::put({ onlyIfNew })` — first-write protection on `OrderRecord` creation.
* `mindbody-checkout-idempotency.mjs::claimNewCheckoutAttempt()` — one-time NCS checkout idempotency.

**Why we didn't catch this in V1 testing.** V1's race-condition test ran against the in-memory shim only (the SDK conditional path was never exercised in `npm run dev`). Going forward, any cross-container mutex MUST also be smoke-tested against real Netlify Blobs in a preview deploy before being trusted in production.

**Manual remediation for the affected customer (`snir7@pic-smart.com`).**

1. In Mindbody, void Sale **11745** (keep 11744). The duplicate "AMARÉ Monthly 8 Classes" card disappears; the buyer is left with the correct 8 credits.
2. No Stripe refund — the buyer paid $1.79 once and received the correct one month of access. Sales 11744 and 11745 in Mindbody were both for the same Stripe charge; voiding one in Mindbody does not affect the Stripe charge.
3. Confirm in admin: `GET /api/stripe/admin/subscriptions?subscriptionId=sub_amare_KGFNWZXZ0HZK5CES` should still show `status: "active"`, `invoices.length: 1`, `invoices[0].status: "synced"`. The `mindbodySaleId` field will be the bogus `"1"` (separate, lower-priority bug in `shoppingSaleFingerprint`'s recursive ID scan — tracked separately) — that's a logging/audit issue, not a billing issue.

**Reporting upstream.** This bug needs to be reported to `github.com/netlify/primitives/issues` so future SDK consumers can rely on `setJSON` conditional writes. Reproduction is trivial: two parallel `setJSON(..., { onlyIfNew: true })` calls to the same key both return `{ modified: true }` against a real Netlify deploy.

---

## 10. Local development env vars

These flags activate **in-memory store fallbacks** for the three Blobs-backed stores. They are intended ONLY for `npm run dev` (or any Node process that runs the Netlify Functions locally without `netlify dev` providing a Blobs context).

| Variable                                       | Purpose                                                                                              |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `STRIPE_ORDER_STORE_LOCAL_MEMORY=1`            | In-memory shim for `stripe-order-store.mjs` (one-time orders).                                       |
| `STRIPE_SUBSCRIPTION_STORE_LOCAL_MEMORY=1`     | In-memory shim for `stripe-subscription-store.mjs` (recurring memberships).                          |
| `MINDBODY_MEMBERSHIP_CONSENT_LOCAL_MEMORY=1`   | In-memory shim for `membership-consent-blobs.mjs` (consent audit).                                   |

> ⚠ **DO NOT set these in production.** All three include a guard (`if process.env.NETLIFY → return null`) so they cannot accidentally activate on a Netlify deploy, but defence in depth: keep them out of any `netlify.toml`, Netlify UI env vars, or CI secrets.

For local dev the recommended set is:

```env
# Stripe one-time + recurring (TEST keys only)
STRIPE_SECRET_KEY=sk_test_…
STRIPE_PUBLISHABLE_KEY=pk_test_…
STRIPE_WEBHOOK_SECRET=whsec_…

ENABLE_STRIPE_ONE_TIME_CHECKOUT=1
ENABLE_STRIPE_RECURRING_CHECKOUT=1
ENABLE_STRIPE_RECURRING_CHECKOUT_FRONTEND=1

MINDBODY_MEMBERSHIP_CONSENT_BLOBS=1
STRIPE_TEST_MODE_MINDBODY_BEHAVIOR=live   # so Stripe-test events DO sync to Mindbody live

# Local-only Blobs fallbacks
STRIPE_ORDER_STORE_LOCAL_MEMORY=1
STRIPE_SUBSCRIPTION_STORE_LOCAL_MEMORY=1
MINDBODY_MEMBERSHIP_CONSENT_LOCAL_MEMORY=1
```

Restart `npm run dev` after editing `.env` — Node does not re-read `.env` on file change.

---

## 11. Production rollout checklist

> **Status as of 2026-05-14**: V1 fully verified locally (18/18 tests passed — see § 13.1). Code is ready. This checklist is the gate between local verification and a live first customer.
>
> Work top-to-bottom. Do not skip ahead. Each section's gates must pass before opening the next.

### 11.1 Production env vars

#### MUST NOT exist in production (Netlify UI → Site settings → Environment variables)
These three flags activate **in-memory store fallbacks** that only exist for `npm run dev`. If any of them leak into production, every Netlify Function cold start would create a fresh empty store and **all subscription records, consents, and orders would be silently lost on every container restart** (≈ every 15 min of inactivity in Netlify's serverless runtime).

- [ ] `STRIPE_SUBSCRIPTION_STORE_LOCAL_MEMORY` — must be UNSET (not present at all). Verify with `netlify env:list --context production | grep STRIPE_SUBSCRIPTION_STORE_LOCAL_MEMORY` — empty output is correct.
- [ ] `MINDBODY_MEMBERSHIP_CONSENT_LOCAL_MEMORY` — must be UNSET.
- [ ] `STRIPE_ORDER_STORE_LOCAL_MEMORY` — must be UNSET.

If any of these accidentally exists, **delete the variable** (do not just set it to `0` — the code only checks for presence of a truthy value, but deleting is the unambiguous fix and prevents future operator mistakes).

#### MUST stay OFF until per-SKU smoke test passes
- [ ] `ENABLE_STRIPE_RECURRING_CHECKOUT=0` on first deploy. Flip to `1` ONLY after § 11.5 passes.
- [ ] `ENABLE_STRIPE_RECURRING_CHECKOUT_FRONTEND=0` on first deploy. Flip to `1` ONLY after the server-side flag has been live for ≥1 hour with no errors AND § 11.5 passes. (Build-time flag — requires redeploy.)

#### Other env vars that must be set correctly
- [ ] `STRIPE_SECRET_KEY` is the **live** `sk_live_…` (NOT `sk_test_…`).
- [ ] `STRIPE_PUBLISHABLE_KEY` is the **live** `pk_live_…`.
- [ ] `STRIPE_WEBHOOK_SECRET` matches the **live** Stripe Dashboard webhook endpoint's `whsec_…` — see § 11.2.
- [ ] `MINDBODY_SITE_ID` is the **production** site id (NOT `5744068` sandbox).
- [ ] `MINDBODY_API_KEY` is the production key.
- [ ] `MINDBODY_STAFF_USERNAME` / `MINDBODY_STAFF_PASSWORD` are production-staff credentials with permissions to create Sales via `CheckoutShoppingCart`.
- [ ] `MINDBODY_STRIPE_PAYMENT_METHOD_ID` matches the production Mindbody Custom Payment Method id named "Stripe".
- [ ] `STRIPE_TEST_MODE_MINDBODY_BEHAVIOR=skip` (production setting — block any accidental test-mode invoice from creating a real Mindbody Sale). On the local sandbox this was `live`, but production must reject test events.
- [ ] `ADMIN_DEBUG_TOKEN` is set to a fresh random value (`openssl rand -hex 24`); the local sandbox value MUST be rotated.
- [ ] Verify Netlify Blobs is enabled for the production site (Site settings → General → Blobs).

### 11.2 Stripe webhook production setup

#### Required events on the live endpoint
Configure the production Stripe webhook endpoint (`https://www.amarewellness.com/api/stripe/webhook`) and subscribe to ALL of the following events:

- [ ] `checkout.session.completed` *(both one-time and subscription)*
- [ ] `invoice.paid` ⚠ **CRITICAL — without this, monthly renewals will silently fail. See § 12.**
- [ ] `invoice.payment_failed`
- [ ] `customer.subscription.updated`
- [ ] `customer.subscription.deleted`
- [ ] `charge.refunded` *(logged only in V1; reserved for V2 automatic credit-removal logic)*

#### MUST NOT enable
- [ ] `invoice.payment_succeeded` is **NOT** in the events list. It is a near-synonym of `invoice.paid` and listening to both is the documented cause of the 3-duplicate-Sale incident from 2026-05-14 (§ 9.12). Verify with `stripe webhook_endpoints retrieve we_<production_id>` — the `enabled_events` array must NOT contain `invoice.payment_succeeded`.

#### Verification commands
Run all of these BEFORE flipping any flag:

```bash
# 1. Confirm the endpoint exists and uses HTTPS
stripe webhook_endpoints list --api-key sk_live_...

# 2. Confirm the events list matches the required set above (no extras, no missing)
stripe webhook_endpoints retrieve we_<production_id> --api-key sk_live_...

# 3. Confirm the API version is compatible with our SDK pin
#    (see § 9.11 — mismatches cause silent payload-shape regressions)
#    Compare `api_version` to the pinned `apiVersion` in stripe-webhook.mjs / stripe-create-checkout-session.mjs.
#    If they differ, the extractInvoiceSubscriptionId helper (added 2026-05-14) handles both shapes, but
#    explicitly pinning is preferred for predictability.

# 4. Confirm STRIPE_WEBHOOK_SECRET in Netlify matches `whsec_…` from Dashboard
netlify env:get STRIPE_WEBHOOK_SECRET --context production

# 5. Send a synthetic test webhook from Dashboard → Webhooks → Events → Send test webhook
#    (any event type). Production logs MUST show the event reaching the handler — NOT
#    `stripe_webhook_signature_failed`.
```

Gates:
- [ ] All 6 required events present.
- [ ] `invoice.payment_succeeded` NOT present.
- [ ] API version compatible (or shape-tolerance helper covers it).
- [ ] `STRIPE_WEBHOOK_SECRET` matches Dashboard.
- [ ] Synthetic webhook reaches handler without signature error.

### 11.3 Catalog launch strategy — Monthly 5 only

The catalog (`netlify/functions/_embedded/stripe-mindbody-catalog.config.json`) controls which SKUs are exposed. Each monthly SKU has an `enabled` flag that gates BOTH the frontend tile AND the server-side checkout endpoint.

#### Initial production state
- [ ] `monthly_5.enabled: true`
- [ ] `monthly_8.enabled: false`
- [ ] `monthly_unlimited.enabled: false`

#### Promotion criteria for `monthly_8`
Do NOT enable Monthly 8 until ALL of the following are true:
- [ ] At least one real customer on `monthly_5` has completed a successful first month renewal cycle (cycle 2 `invoice.paid` → Mindbody Sale).
- [ ] No `paid_but_not_synced` failures in `/api/stripe/admin/subscriptions/failures` for the past 7 days.
- [ ] No customer-support tickets about missing credits or stuck subscriptions.

#### Promotion criteria for `monthly_unlimited`
Do NOT enable Monthly Unlimited until ALL of the following are true:
- [ ] `monthly_8` has been live for ≥7 days with same clean criteria.
- [ ] Smoke-test on `monthly_unlimited`: confirm Mindbody's "999999 sessions" sentinel does not surface in any admin UI as the literal number.

### 11.4 Mindbody production verification

#### API-only Service IDs (per § 13 — these were created on 2026-05-14 specifically for the Stripe recurring flow)
Verify in Mindbody (Pricing Options → search by name):
- [ ] **Monthly 5** → Service ID `100133`, name "AMARÉ Monthly 5 Classes", price $125, sessions 5
- [ ] **Monthly 8** → Service ID `100134`, name "AMARÉ Monthly 8 Classes", price $179, sessions 8
- [ ] **Monthly Unlimited** → Service ID `100135`, name "AMARÉ Monthly Unlimited", price $229, sessions 999999

#### Settings on each Service (must match exactly)
For each of the three IDs above:
- [ ] **Sell online: OFF** (these Services are API-only — preventing accidental classic-flow purchases that would conflict with Stripe billing).
- [ ] **Only allow clients to purchase this in a contract or package: NO** (we use direct Service sale via `CheckoutShoppingCart`, not Mindbody Contracts).
- [ ] **Repeat purchase: ALLOWED** (verified during API verification on 2026-05-14 — `--twice` test passed).
- [ ] **Expires: 1 month after sale date** (Mindbody auto-applies the 1-month window per renewal).
- [ ] **Membership type: matches** (`5 monthly classes` / `8 monthly classes` / `monthly unlimited`).
- [ ] **Revenue category: monthly packages**.

#### Old (legacy) Service IDs — DO NOT TOUCH
The Mindbody-Contract-flow IDs `100129` / `100130` / `100056` remain bound to the existing classic flow. They MUST NOT be deleted, modified, or repurposed. The new IDs above are SEPARATE entries created specifically for Stripe recurring.

#### `mb-contract-terms.config.json` mapping
The new Service IDs must map to the SAME contract product IDs as their legacy counterparts (so the consent agreement text stays consistent):
- [ ] `100133 → 101` (and legacy `100129 → 101` retained)
- [ ] `100134 → 102` (and legacy `100130 → 102` retained)
- [ ] `100135 → 100` (and legacy `100056 → 100` retained)

#### Custom Payment Method
- [ ] Production Mindbody site has a **Custom Payment Method** named exactly `Stripe` (matching `MINDBODY_STRIPE_PAYMENT_METHOD_NAME=Stripe`).
- [ ] That payment method's numeric id matches `MINDBODY_STRIPE_PAYMENT_METHOD_ID=17` (or update the env var to whatever the production id is — discover with `npm run stripe:find-mb-payment-id`).
- [ ] Payment method has **Allow >$0: YES** and **PayNotes enabled**.

### 11.5 First live smoke test (gate for general availability)

Run ONE real Monthly 5 checkout with an internal/test user using a real card. This is the final gate before flipping `ENABLE_STRIPE_RECURRING_CHECKOUT_FRONTEND=1`.

#### Pre-test
- [ ] § 11.1 / 11.2 / 11.4 are all green.
- [ ] `ENABLE_STRIPE_RECURRING_CHECKOUT=1` (server flag flipped).
- [ ] `ENABLE_STRIPE_RECURRING_CHECKOUT_FRONTEND` still `0` (frontend not yet exposing the Subscribe CTA to the public).
- [ ] Internal test user has a Mindbody ClientId and is reachable.

#### Bypass for the test
Either (a) build a one-off branch with `ENABLE_STRIPE_RECURRING_CHECKOUT_FRONTEND=1` deployed to a Netlify branch URL (`https://internal-test--amare.netlify.app/pricing`) for the internal user only, or (b) trigger the create-session endpoint directly with `curl` against the live API.

#### Verification (all must pass)
1. **Stripe** — Dashboard → Customers → snir test:
   - [ ] One subscription in `active` state.
   - [ ] One paid invoice ($125), `payment_method` is the real card used.
2. **SubscriptionRecord (Netlify Blobs)** — `GET /api/stripe/admin/subscriptions?subscriptionId=sub_amare_…`:
   - [ ] `status: "active"`.
   - [ ] `stripeSubscriptionId` is a real `sub_…` (not `pending_…`).
   - [ ] `mindbodyClientId` populated.
   - [ ] `invoices[0].status: "synced"` and `mindbodySaleId` populated.
3. **Consent record (Netlify Blobs)** — verify presence of a record with `agreementVersion`, `agreementTextHash`, `legalNameTyped`, `agreementAcceptedAt` matching the SubscriptionRecord.
4. **Mindbody** — Client → Purchases tab:
   - [ ] One Sale row, $125, AMARÉ Monthly 5 Classes, payment method "Stripe".
   - [ ] Client → Sessions Remaining shows 5 credits with 1-month expiration.
   - [ ] Client → Membership status shows the matching Monthly 5 status.
5. **Booking** — book a class on the test client:
   - [ ] Mindbody allows the booking using the new credits (no "Insufficient credits" error).
   - [ ] Sessions Remaining decrements from 5 to 4.
6. **Admin endpoint** — `GET /api/stripe/admin/subscriptions/failures`:
   - [ ] Returns `count: 0`.
7. **Logs** — production function logs (Netlify dashboard or `netlify logs`):
   - [ ] `stripe_webhook_subscription_session_completed` fired.
   - [ ] `stripe_webhook_invoice_synced_to_mindbody attempts: 1` fired.
   - [ ] No `stripe_webhook_signature_failed`.
   - [ ] No `stripe_webhook_invoice_paid_but_not_synced`.

#### Post-test cleanup
- [ ] Cancel the test subscription in Stripe Dashboard (immediate cancel).
- [ ] Manually void/refund the test charge in Stripe.
- [ ] Manually delete the Mindbody Sale + adjust credits on the test client (Sales → Return/Void).
- [ ] In Stripe Dashboard, archive the test customer or note their id for reference.

#### Promotion gate
ONLY if all 7 verification blocks above are green:
- [ ] Flip `ENABLE_STRIPE_RECURRING_CHECKOUT_FRONTEND=1` (requires redeploy).
- [ ] Announce internal go-live; first 24 hours = "soft launch", monitor closely (§ 11.6).

### 11.6 Operational monitoring (post-launch)

#### Daily checks (first 30 days, then weekly)
- [ ] **Admin subscriptions endpoint** — `GET /api/stripe/admin/subscriptions?status=active`. Verify count tracks expected business growth; no orphan `pending_first_invoice` records older than 5 minutes.
- [ ] **Failures endpoint** — `GET /api/stripe/admin/subscriptions/failures`. **Empty result = healthy.** ANY non-empty result requires investigation. Use `POST /retry-sync` to re-attempt; if the issue is non-retryable (`skipped_payment_failed` / `skipped_subscription_canceled` / `skipped_zero_amount`), confirm with the studio that no manual Mindbody intervention is needed.
- [ ] **Stripe Dashboard webhook delivery** — Webhooks → Events tab. Verify ≥99% delivery success rate. Investigate any failed deliveries within 24 hours.
- [ ] **Mindbody Sales** — daily cross-check: count of active SubscriptionRecords with `invoices[].status === "synced"` for the previous billing period MUST equal the count of new Mindbody Sales for the matching Service IDs (100133/100134/100135) on the production site.

#### Alert triggers (page on-call)
- [ ] **`stripe_webhook_invoice_paid_but_not_synced`** log event — paying customer without Mindbody credits. Resolve within 1 hour or refund.
- [ ] **`stripe_webhook_signature_failed`** — webhook secret mismatch or replay attack. Investigate immediately.
- [ ] **Two `stripe_webhook_invoice_synced_to_mindbody` entries with the same `invoiceId` but different `mbSaleId`** — claim mechanism (§ 9.12) failed. Stop new subscriptions and escalate.
- [ ] **`stripe_webhook_invoice_paid_no_record`** for a real production invoice — orphaned Stripe subscription with no matching local record. Manual cleanup required.

#### Status-specific monitoring
| Status                              | Expected | Action if seen                                                 |
| ----------------------------------- | -------- | -------------------------------------------------------------- |
| `synced`                            | Common   | Healthy. No action.                                            |
| `paid_but_not_synced`               | RARE     | Investigate within 1 hour. `POST /retry-sync` to retry.        |
| `skipped_payment_failed`            | Sometimes | Customer payment problem. Customer-support contacts customer.  |
| `skipped_subscription_canceled`     | Rare      | Customer paid AFTER cancellation. Refund through Stripe.       |
| `skipped_zero_amount`               | Sometimes | $0 invoice (proration credit). No action.                      |
| `test_mode_no_sync`                 | NEVER (production) | Test event leaked. Verify `STRIPE_TEST_MODE_MINDBODY_BEHAVIOR=skip`. |

#### Out-of-scope guardrails (V1 — do not "improve" without product approval)
- [ ] **No Stripe Customer Portal.** Verify no portal link is rendered in any UI. Verify `stripe.billingPortal.*` is never called from any function.
- [ ] **No customer self-cancellation.** All cancellations go through Stripe Dashboard. The admin endpoint has no `cancel` action.
- [ ] **No plan changes / upgrades / downgrades.** All plan moves are studio-managed: cancel old sub in Dashboard → customer self-signs-up on the new plan via the same checkout flow.
- [ ] **No automatic refund handling.** Refund events are logged only; manual Mindbody adjustment is required.

---

## 12. ⚠ CRITICAL production warning — renewals depend on `invoice.paid`

> **The eager first-invoice sync (§ 9.8) ONLY covers the very first invoice during checkout — i.e., the initial $125/$179/$229 charge.**
>
> **Monthly renewals (cycles 2, 3, 4, …) are processed exclusively through the `invoice.paid` Stripe webhook.**
>
> **If `invoice.paid` is not configured in the Stripe Dashboard webhook endpoint for production, renewals will silently fail: Stripe WILL charge the customer's card every month, but Mindbody will NOT receive new credits, and the customer will NOT be able to book classes after their first month expires.**

### Why this can't be fixed by the eager sync alone
The eager sync runs only once, at the moment `checkout.session.completed` fires. There is no equivalent "anchor event" each renewal cycle — Stripe's renewal flow consists solely of:

1. Stripe internally generates a new invoice.
2. Stripe charges the saved payment method.
3. Stripe fires `invoice.paid` (success) or `invoice.payment_failed` (failure).

There is no `checkout.session.*` event for renewals. There is no `subscription.renewed` event. The webhook is the **only** signal we receive that the customer just paid for another month of credits.

### Verification before going live
1. Configure the webhook endpoint with `invoice.paid` in the events list.
2. Use a **Stripe Test Clock** to fast-forward a real test subscription by one billing cycle.
3. Verify in the production logs:
   - `stripe_webhook_invoice_paid_received` with the renewal invoice id.
   - `stripe_webhook_invoice_synced_to_mindbody` with `attempts: 1` (or up to the retry budget).
4. Verify in Mindbody that a second Sale row has appeared on the test client.
5. Only after this verification passes — and you have alerting on `paid_but_not_synced` — flip the production flag to `1` for `monthly_5`.

### Detection in production
If `invoice.paid` ever stops being delivered (Stripe webhook signature change, endpoint URL change, network outage), the symptoms will be:

* New Stripe charges appearing in the Stripe Dashboard.
* No new Mindbody Sale rows for the affected client.
* `SubscriptionRecord.invoices[]` not gaining new entries.
* Customer complaint: "I was charged but I have no classes left."

The mitigation is to (a) replay missed events from the Stripe Dashboard (Events → Resend), and (b) for any invoice that cannot be replayed, manually call `POST /api/stripe/admin/subscriptions/retry-sync` with the relevant invoice id. Both paths are idempotent thanks to the dedup on `invoice.id`.

---

## 13. V1 test results (Monthly 5 — local sandbox, 2026-05-14)

Test client: **snir17@pic-smart.com** / Mindbody ClientId **100002753**.
Stripe Subscription used for verification: `sub_amare_9VT3XG2AF0X7784T` (local mock id) → bound to Stripe `sub_…`.
Mindbody Sale created by the eager first-invoice sync: **SaleId 11707**.

### 13.1 Passed (proven end-to-end on 2026-05-14)

| # | Test | Result | Evidence |
|---|------|--------|----------|
| 1 | Stripe Subscription Checkout opens (frontend fork → `mode: subscription`) | ✅ Passed | Dialog opened on pricing page, Submit button rendered, Promotion/Dry-run/Live fields hidden. |
| 2 | Membership consent dialog renders & validates | ✅ Passed | Required `agreementVersion` + `agreementTextHash` collected before `create-session`. |
| 3 | `SubscriptionRecord` created in store | ✅ Passed | Local in-memory store (`STRIPE_SUBSCRIPTION_STORE_LOCAL_MEMORY=1`) returned the record with full schema (sub id, customer id, sku, commitment dates, agreement hash, etc.). |
| 4 | `checkout.session.completed` handler bound subscription → mindbodyClientId | ✅ Passed | Webhook log: `subscription_bound mindbodyClientId=100002753`. |
| 5 | Eager first-invoice sync (no `invoice.paid` webhook needed for first month) | ✅ Passed | After bind, `stripe.invoices.retrieve(latest_invoice)` returned `status: "paid"`; `handleInvoicePaid` ran inline. |
| 6 | First invoice synced to Mindbody | ✅ Passed | `POST /sale/checkoutshoppingcart` returned Action != "Failed", credits added. |
| 7 | Mindbody Sale row created | ✅ Passed | **Sale ID 11707** — Description: "AMARÉ Monthly 5 Classes", Price $125.00, Amount Paid $125.00, Payment Method: **Stripe**. |
| 8 | Client received the correct Pricing Option | ✅ Passed | Service ID **100133** (new API-only id), 5 sessions, expires 06/14/2026 (1 month after sale). |
| 9 | Mindbody membership status flipped to **Active** | ✅ Passed | Client profile shows Membership: Active, Current membership: AMARÉ Monthly 5 Classes. |
| 10 | Success page renders subscription summary | ✅ Passed | `/checkout/success?session_id=…` showed "Your monthly membership is active. You can book classes now." with sub id + sku + amount. |
| 11 | `block_if_active_subscription` duplicate-purchase guard | ✅ Passed | While Monthly 5 was active, attempting Subscribe on Monthly 8 / Monthly Unlimited returned: **"You already have an active Amaré monthly membership. Please contact us to change plans."** Stripe Checkout Session was NOT created — request blocked at `create-session`. |
| 12 | **Booking access works from the new Service credits** (proves Option A's core assumption) | ✅ Passed | Successfully booked a class for `snir17@pic-smart.com` using one of the 5 credits added by the Stripe recurring flow. **Confirms Mindbody booking does NOT require an active Mindbody Contract — Service Pricing Option credits are sufficient.** This is the most important architectural validation in V1. |
| 13 | `GET /api/stripe/admin/subscriptions?status=active` (list) | ✅ Passed | Returned one active `monthly_5` record with `invoices[0].status: "synced"` and the full schema. Auth via `x-admin-token` enforced. Routes registered in `scripts/unified-local-dev.mjs` on 2026-05-14. |
| 14 | `GET /api/stripe/admin/subscriptions/failures` | ✅ Passed | Returned `count: 0` and empty `failures: []` array — as expected (no `paid_but_not_synced` invoices in this happy-path run). |
| 15 | `POST /api/stripe/admin/subscriptions/retry-sync` (idempotent) | ✅ Passed | Calling with already-synced invoice `in_1TX1ONAjsONx3mgIAVPvP68Y` returned `{ ok: true, status: "already_synced" }` and did NOT create a second Mindbody Sale. Confirms invoice-id-level idempotency. |
| 16a | Concurrent webhook race-condition fix (3 handlers / 1 invoice) | ✅ Passed | Subscription `sub_amare_MGBEPSX066G4TH9E` / Stripe sub `sub_1TX3LXAjsONx3mgIzgozDpuS` / invoice `in_1TX3LVAjsONx3mgIR58rpiF5`. Logs showed: `invoice.paid` and `checkout.session.completed`'s eager sync both raced. The eager sync's `handleInvoicePaid` was caught by the claim and emitted `dedup_via_claim`; only the real `invoice.paid` won. Mindbody: **exactly 1 Sale (11722)**, no duplicates. Validates § 9.12 fix. |
| 16b | `invoice.paid` resend → idempotency (cheap dedup-by-find) | ✅ Passed | Resent `evt_1TX3LZAjsONx3mgIxqrYiSz6` from Stripe Dashboard. Logs showed `dedupVia: "record_invoices_array"` and **no** `stripe_webhook_invoice_synced_to_mindbody` line. Mindbody Sales count unchanged. |
| 16c | Manual renewal simulation (`stripe invoices create + pay`) — month-2 sync | ✅ Passed | Created invoice item `ii_1TX3R9AjsONx3mgIWKVEB3bb` for $125 against `sub_1TX3LXAjsONx3mgIzgozDpuS`, finalized invoice `in_1TX3RqAjsONx3mgIgYV0maNN`, paid it. Logs: one `invoice.paid` received, one `invoice.synced_to_mindbody`. Admin endpoint after: `invoiceCount: 2`, both `synced`. **Mindbody: second Sale row created on snir15.** This is the closest possible validation of production renewal short of Stripe Test Clock. |
| 16d | Renewal `invoice.paid` resend → idempotency | ✅ Passed | Resent `evt_1TX3SUAjsONx3mgIRtizWcKQ` (the renewal). Logs: `dedupVia: "record_invoices_array"`, `existingStatus: "synced"`. No additional Mindbody Sale. |
| 16e | `customer.subscription.updated` handler | ✅ Passed | Side effect of the renewal flow: Stripe also fired `customer.subscription.updated` (eventId `evt_1TX3RqAjsONx3mgIXpnxorVG`). Handler logged `subscription_updated stripeStatus=active patchKeys=[cancelAt]`. Status remained `active`. |

| 17a | `invoice.payment_failed` — no Mindbody side-effect | ✅ Passed | Created standalone invoice `in_1TX3i9AjsONx3mgIwe3xOzyB` against `sub_1TX3LXAjsONx3mgIzgozDpuS`, attached `pm_card_chargeCustomerFail` (last4 `0341`), called `invoices.pay` with `off_session=true`. Stripe returned `card_declined / generic_decline`. Webhooks: `customer.subscription.updated stripeStatus=past_due patchKeys=["cancelAt","status"]` (line 954) → `invoice.payment_failed` (line 955-956). **No `stripe_webhook_invoice_synced_to_mindbody` line** for this invoice. Admin endpoint after: `record.status: "past_due"`, `invoiceCount: 3`, the new entry has `status: "skipped_payment_failed"`, `mindbodySaleId: null`, `amountPaidCents: 0`, `lastError: "stripe_invoice_payment_failed"`. |
| 17b | `failures` endpoint excludes `skipped_payment_failed` | ✅ Passed | `GET /api/stripe/admin/subscriptions/failures` returned `count: 0`. `skipped_payment_failed` is intentionally **not** retryable — it's a customer-side payment problem, not a Mindbody-side sync problem, so it must not appear in the studio's "needs attention" queue. |
| 17c | `retry-sync` rejects `skipped_payment_failed` (defense-in-depth) | ✅ Passed | `POST /api/stripe/admin/subscriptions/retry-sync` with the failed invoiceId returned `HTTP 409 { ok: false, error: "not_retryable", reason: "skipped_payment_failed" }`. The admin UI should hide the Retry button on these rows; the API still refuses to charge Mindbody on the studio's behalf. |
| 17d | `invoice.payment_failed` resend → idempotent append | ✅ Passed | Resent `evt_1TX3tdAjsONx3mgIKZVOkMUW` from Stripe Dashboard. The handler logged the event a second time but did NOT add a duplicate entry — `invoiceCount` stayed at 3 (guarded by `if (!existing)` on line 1452-1469 of `stripe-webhook.mjs`). |

| 18a | `customer.subscription.deleted` → `canceled_admin` | ✅ Passed | Fresh subscription `sub_amare_QJ0BSBQY0QAZ062F` / Stripe `sub_1TX4QwAjsONx3mgIoHzDNIJl` (Mindbody Sale **11724**, Payment Ref# 8897). Canceled via `DELETE /v1/subscriptions/sub_1TX4QwAjsONx3mgIoHzDNIJl` (immediate). Webhook `evt_1TX4chAjsONx3mgIGyS1PWaF` arrived → `stripe_webhook_subscription_deleted reason=cancellation_requested targetStatus=canceled_admin`. Admin after: `status: canceled_admin`, `canceledAt: 2026-05-14T19:08:43.000Z`, `cancellationReason: cancellation_requested`. |
| 18b | Late `invoice.paid` after cancellation → guard blocks Mindbody | ✅ Passed | Forged a signed `invoice.paid` webhook event for a NEW invoice id `in_FAKE_TEST18_LATE_001` linked to the canceled `sub_1TX4QwAjsONx3mgIoHzDNIJl` (via `parent.subscription_details.subscription`). POSTed to `http://127.0.0.1:4321/api/stripe/webhook` with valid HMAC. Response: `HTTP 200 { invoiceStatus: "skipped_subscription_canceled", noop: false }`. Logs: `stripe_webhook_invoice_paid_skipped_canceled subscriptionId=sub_amare_QJ0BSBQY0QAZ062F invoiceId=in_FAKE_TEST18_LATE_001 recordStatus=canceled_admin amountPaidCents=12500`. **No `stripe_webhook_invoice_synced_to_mindbody` for this invoice — Mindbody was not called.** Audit trail entry created: `status: skipped_subscription_canceled, mindbodySaleId: null, lastError: subscription_canceled, lastErrorMessage: "Subscription was already canceled_admin when this invoice arrived; Mindbody not called."`. See § 9.13 for the design decision. |
| 18c | `failures` endpoint excludes `skipped_subscription_canceled` | ✅ Passed | Same as 17b — failures view returned `count: 0` after the late-invoice arrival. |
| 18d | `retry-sync` rejects `skipped_subscription_canceled` (defense-in-depth) | ✅ Passed | `POST /api/stripe/admin/subscriptions/retry-sync` with `{ subscriptionId: "sub_amare_QJ0BSBQY0QAZ062F", invoiceId: "in_FAKE_TEST18_LATE_001" }` returned `HTTP 409 { ok: false, error: "not_retryable", reason: "skipped_subscription_canceled" }`. The studio cannot accidentally re-sync a canceled-sub invoice through the admin UI. |
| 18e | Late `invoice.paid` resend → idempotent | ✅ Passed | Re-POSTed the forged event a second time. Hit cheap dedup (`dedupVia: "record_invoices_array"`, `existingStatus: "skipped_subscription_canceled"`). Response: `HTTP 200 { noop: true }`. `invoiceCount` stayed at 2. |

### 13.2 Pending V1 tests (must pass before flipping prod flags)

_All V1 tests are passed as of 2026-05-14._ Remaining work is the production-rollout sequence in § 11, not additional verifications.

### 13.2.1 Bug found during admin test — `stripeSubscriptionId` stuck on `pending_<id>`

Surfaced while verifying the admin GET response on 2026-05-14: the record body still showed `"stripeSubscriptionId": "pending_sub_amare_5PAKP25NY3TV2JC1"` instead of the real Stripe `sub_…`. **Mindbody sync still worked correctly** because the `byStripeSubscriptionId` index was populated from the call-site to `bindStripeSubscription(stripeSubId, record.id)` — but the record's own field never converged.

**Root cause:** `stripe-subscription-store.mjs::patch()` was force-restoring `stripeSubscriptionId: before.stripeSubscriptionId` on every patch, silently overriding the legitimate `pending_<id>` → `sub_<id>` transition that `handleSubscriptionCheckoutCompleted` was attempting at line ~917.

**Fix (landed 2026-05-14):**
1. `stripe-subscription-store.mjs::patch()` now allows the one-time transition from `pending_<id>` (or empty / non-real-Stripe-format) → `sub_<…>`. It still rejects:
   * regression `sub_…` → `pending_…`
   * rebinding from one `sub_…` to a different `sub_…` (would silently steal a different customer's subscription — logs `stripe_subscription_patch_rejected_rebind_attempt`).
   * non-string or empty values that don't match `^sub_…$`.
2. `stripe-webhook.mjs::resolveSubscriptionRecord()` now auto-heals stale records: when the byStripe index points at a record whose `stripeSubscriptionId` field still mismatches, it issues the patch in place and logs `stripe_subscription_auto_heal_stripeSubId`. This means existing broken records in production will self-heal on the next `invoice.paid` / `subscription.updated` / `subscription.deleted` event — no manual migration script needed.

**Verification of fix** — passed 2026-05-14, ~20:00 UTC+3.

After dev server restart + dashboard webhook signature reconfig (see 13.2.2), a fresh `monthly_unlimited` subscription was created end-to-end with the following observed in webhook logs:

* `stripe_subscription_session_created` (create-session)
* `stripe_webhook_subscription_session_completed` — bound real Stripe id: `sub_1TX2euAjsONx3mgIS9iyX1Rg`
* eager first-invoice sync: `stripe_webhook_invoice_synced_to_mindbody` for invoice `in_1TX2esAjsONx3mgIvRuHnnjC`, status `synced`
* admin GET response now shows `stripeSubscriptionId: "sub_1TX2euAjsONx3mgIS9iyX1Rg"` — no `pending_…` placeholder.

The root-cause fix in `patch()` and the auto-heal in `resolveSubscriptionRecord()` are both confirmed working. No `stripe_subscription_patch_rejected_*` warnings emitted.

### 13.2.2 Webhook signature pitfall — `whsec_` per delivery channel

**Symptom** (during the verification re-run): every webhook delivery was logged as `stripe_webhook_signature_failed` even though the events were arriving and the Stripe CLI was running.

**Root cause**: the `STRIPE_WEBHOOK_SECRET` in `.env` was the `whsec_…` from a `stripe listen --forward-to …` invocation, but events were arriving via a **different channel** — an ngrok tunnel registered as a Stripe Dashboard webhook endpoint. Each Stripe webhook destination (CLI listener, Dashboard endpoint, separate ngrok endpoint) gets its **own** `whsec_…`. Mixing them = signature mismatch on every delivery.

**Fix**: copied the `whsec_…` from the **active Stripe Dashboard endpoint** (Developers → Webhooks → click the endpoint → "Signing secret") into `.env`, restarted dev server. Signature failures stopped immediately.

**Production lesson**: in production we will have exactly ONE webhook endpoint registered in Stripe Dashboard, and `STRIPE_WEBHOOK_SECRET` must come from that exact endpoint. Do NOT confuse it with any local CLI `whsec_` or staging endpoint secret. Validate after every webhook config change with a single `Send test webhook` and watch for `stripe_webhook_signature_failed` in logs.

### 13.3 Out of scope for V1 (do NOT test or implement)

* Stripe Customer Portal — disabled, no portal links anywhere in UI.
* Customer self-cancellation — studio handles via Stripe Dashboard manually.
* Plan changes / upgrades / downgrades — manual studio operation only.
* Trials / first-month discounts — to be added in V2 after base flow is stable.
* Automatic refund handling — `charge.refunded` is logged only, no Mindbody adjustment.

### 13.4 Production webhook configuration (required before going live)

See § 11.2 for the full checklist (verification commands + gates). Quick summary of required events on the live endpoint `https://www.amarewellness.com/api/stripe/webhook`:

* `checkout.session.completed` — binds Stripe subscription to Mindbody client + first-invoice eager sync.
* `invoice.paid` — **the renewal lifeline** (see § 12).
* `invoice.payment_failed` — marks subscription past_due, no Mindbody sync.
* `customer.subscription.updated` — picks up cancel-at-period-end and status changes.
* `customer.subscription.deleted` — stops future syncs.
* `charge.refunded` — log-only in V1.

⚠ **Do NOT add `invoice.payment_succeeded`** — see § 11.2 and § 9.12 for why (caused 3 duplicate Sales for one invoice on 2026-05-14).
