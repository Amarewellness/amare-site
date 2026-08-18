# AMARÉ Mobile Purchase — Hosted Checkout → PaymentSheet

Status: **LOCKED — approve with hardening below. No implementation in this document.**  
Scope: one-time studio packs in the Capacitor app, after UX V1.  
Does not change production flags, D28/D29, `mb_sess`, or website `/pricing`.

This is the architecture target for a **separate commerce project**. Close Home / Schedule / Classes / Profile and a real APK first. Do not block UX V1 on payments.

---

## 1. Decision

- **Do not** embed existing Stripe Checkout in a WebView.
- **Do not** start PaymentSheet before a native Purchase screen exists.
- **Do not** fulfill from the app. Webhook + atomic claim stay the only Mindbody sale path.
- **Do** keep website Hosted Checkout forever. Same catalog, same `OrderRecord`, same `fulfillOneTimeMindbodySale`. Two payment UIs, one fulfillment function.
- **Do** route webhook events by an explicit payment-flow tag. `claimOneTimeFulfillment` is the last safety net, not the only gate.

Stripe Checkout already creates a PaymentIntent. Today that Intent is fulfilled only via `checkout.session.completed`. A naive `payment_intent.succeeded → find order → fulfill` handler would put Hosted Checkout onto the new path. That is the bug this design forbids.

---

## 2. Phases

| Phase | What ships | Payment UI | Fulfillment trigger |
| --- | --- | --- | --- |
| **A** | Native `/purchase` in the app | Existing Hosted Checkout (Capacitor Browser / Custom Tab) | Existing `checkout.session.completed` |
| **B** | One-time PaymentSheet | PaymentIntent + PaymentSheet | `payment_intent.succeeded` **only** for `mobile_payment_sheet` orders |
| **C** | Saved cards + Google Pay | CustomerSession + PaymentSheet | Same as B |
| **D** | Monthly 5 / 8 / Unlimited | Subscription + PaymentSheet | Existing `invoice.paid` (not PI.succeeded) |
| **E** | iOS + Apple Pay | Same as C/D | Same |

Phase A is worth doing even if B is months later. The pack list is AMARÉ-owned. Only the last hop changes in B.

Phase B SKUs only (catalog `kind` `newClient` / `dropin` / `packs`, `stripeMode` payment):

| SKU | Display | Amount |
| --- | --- | --- |
| `new_client_special_3_for_65` | New Client Special — 3 Classes | $65 |
| `drop_in_single_class` | Drop-In | $40 |
| `drop_in_same_day` | Same-Day Visit | $30 |
| `pack_10_classes` | 10 Class Pack | $269 |
| `pack_20_classes` | 20 Class Pack | $479 |

`pack_5_classes` stays out until the catalog row is enabled. Monthly SKUs stay out until Phase D.

First PaymentSheet methods: **card** and **Google Pay**. No ACH / delayed methods. Apple Pay is Phase E.

---

## 3. What already exists (reuse map)

### 3.1 Identity

Current app **Buy a pass**:

```
Bearer JWT
  → POST /api/amare/commerce/app-checkout-start
  → handoff URL
  → browser cookie amare_sess
  → /pricing
  → POST /api/stripe/checkout/create-session
```

`create-session` already refuses browser `clientId` as ownership. Linked buyer identity comes from `resolveCommerceCustomer` (`amare_sess` and/or `mb_sess`). Stripe Customer reuse is already:

```
amare_user_id → linked Studio clientId → customers.search(metadata.mindbodyClientId) → cus_…
```

Phase A/B app buyers must use **Bearer → same `resolveCommerceCustomer`**. No email form, no anonymous checkout, no clientId from the device.

The app already has `createHostedCheckoutSession()` (`amare-app/src/api/checkout.ts`). Buy a pass does not use it today. Phase A should: Purchase screen → that function → Browser. Not a second create-session.

### 3.2 Catalog and price

Source of truth: `src/content/stripe-mindbody-catalog.config.json` via `stripe-catalog-lib.mjs`.

`create-session` already:

- looks up `localSku`
- rejects unknown / disabled / non-Service
- uses **server** `amountCents`
- ignores client amount
- blocks NCS when `duplicatePolicy === block_before_checkout_if_known`
- blocks a second monthly when `block_if_active_subscription`

Phase A needs a **read-only catalog** for the Purchase screen (display name, amount, eligibility). Display prices are UX only. Charge price stays server-side.

### 3.3 OrderRecord

`stripe-order-store.mjs` already has everything Phase B needs except an explicit payment-flow tag:

- `orderId`, `localSku`, `amountCents`, `currency`
- `stripeCheckoutSessionId`, `stripePaymentIntentId`, `stripeCustomerId`
- `amareUserId`, `knownMindbodyClientId`, `commerceAuthSource`
- `mindbodySyncStatus`, `fulfillmentClaimId`
- existing `flow` = `"stripe_to_mindbody_one_time"` (product path, **not** UI path)
- Phase B adds `paymentFlow`, `purchaseAttemptId`, `prepareStatus` (`creating_payment_intent` \| `ready`)

Lookup today is **by `orderId`** or **by Checkout Session id** (`sessionIndex`). There is no PaymentIntent index. `stripePaymentIntentId` is stored on the record after session create.

### 3.4 Hosted Checkout create

`stripe-create-checkout-session.mjs` persists the `OrderRecord` **before** redirect, then:

```js
metadata: { localSku, orderId, flow: "stripe_to_mindbody_one_time", source: "amare_site", … }
payment_intent_data: { metadata }  // same bag copied onto the Checkout PaymentIntent
```

So every current Hosted Checkout PaymentIntent already carries `orderId` and `flow: stripe_to_mindbody_one_time`. It does **not** carry a UI-flow tag.

### 3.5 Webhook today

`stripe-webhook.mjs` one-time path listens to:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `checkout.session.expired`

Then `fulfillOneTimeMindbodySale` → `claimOneTimeFulfillment(orderId)` → Mindbody `CheckoutShoppingCart`.

**`payment_intent.succeeded` is not handled.** Unknown types return `{ received: true, ignored: true }`.

That is why Hosted Checkout is safe today. It is also why a generic PI handler would be a behavior change for every existing paid Checkout Session.

Recurring stays on `invoice.paid` + `claimInvoiceSlot`. Phase D must not fulfill memberships from `payment_intent.succeeded`.

### 3.6 After pay

Website `GET /api/stripe/order-status?orderId=` is read-only and never fulfills. Hosted Checkout success may keep using it. After PaymentSheet the app polls a **Bearer-owned** mobile status (§9.1), then invalidates `member/summary`.

Copy already exists: “Payment received. We're finishing your package setup…”.

---

## 4. Phase A — Purchase screen, still Hosted Checkout

```
Home / Profile  →  Buy a pass  →  /purchase
  → Bearer create-session (existing)
  → Capacitor Browser (Checkout URL)
  → success/cancel
  → poll order-status
  → refresh member/summary
```

App sends only `localSku` (+ existing deferred-book fields if we later wire “buy then book”). No price, no clientId.

Website `/pricing` stays for desktop and unsigned buyers.

**`paymentFlow` hardening:** optional in the Phase A PR, **required before Phase B** (before any `payment_intent.succeeded` handler exists):

- Stamp Stripe Session + PI metadata `amarePaymentFlow=hosted_checkout`
- Stamp `OrderRecord.paymentFlow = "hosted_checkout"`
- Treat **missing** `paymentFlow` as `hosted_checkout` (all historical orders)

World after that stamp:

| Order | `paymentFlow` / `amarePaymentFlow` |
| --- | --- |
| Legacy (already paid or already created) | missing → treat as `hosted_checkout` |
| New web / Phase A Hosted Checkout | `hosted_checkout` |
| New app PaymentSheet (Phase B) | `mobile_payment_sheet` |

Phase B does not ship until every **new** Checkout Session writes the explicit Hosted tag. Missing remains a legacy alias only.

---

## 5. Phase B — PaymentSheet for one-time packs

```
/purchase  →  POST /api/amare/mobile-payments/prepare
  body: { sku, purchaseAttemptId }
  server: see §5.1
  app:
    StripePayment.present({ clientSecret, merchantDisplayName: "AMARÉ" })
    on completed → poll mobile order-status (do not fulfill)
```

`purchaseAttemptId` is a client-generated UUID. It is **not** authority. The server still owns user, SKU, price, and Studio client.

Capacitor: thin native plugin over official Stripe Android (then iOS) SDKs. Not a WebView. Not a React Native rewrite. Community wrappers are optional later; money path prefers official SDKs.

Payment methods in B: card + Google Pay. Immediate result only.

### 5.1 `/prepare` idempotency and recovery

Double-tap / hung network must not create two orders and two PaymentIntents.

```
user taps Purchase
  → POST /prepare { sku, purchaseAttemptId }
  → network hangs
  → user taps again
  → POST /prepare { same sku, same purchaseAttemptId }
  → same orderId + same PaymentIntent + same clientSecret
```

Dedupe key (server):

```
amare_user_id + sku + purchaseAttemptId
```

Stripe idempotency key **after** `orderId` exists:

```
amare-mobile-payment:<orderId>
```

Create order **first**, then the Intent:

1. Resolve Bearer → linked commerce customer. Reject if not linked.
2. Catalog lookup + server price + NCS / duplicate gates (same as create-session).
3. Reuse Stripe Customer.
4. Find existing in-progress order for this dedupe key. If found and `prepareStatus=ready` with a PI, return that `orderId` + client secret.
5. Else create `OrderRecord`:
   - `paymentFlow=mobile_payment_sheet`
   - `prepareStatus=creating_payment_intent`
   - `purchaseAttemptId`
   - no `stripeCheckoutSessionId`
6. `paymentIntents.create` with Stripe idempotency key `amare-mobile-payment:<orderId>` and metadata:
   - `amarePaymentFlow=mobile_payment_sheet` (**required**)
   - `orderId` (**required**)
   - `localSku` (**required**, server catalog SKU)
   - `flow=stripe_to_mindbody_one_time`
7. Patch order: `stripePaymentIntentId`, `prepareStatus=ready`.
8. Return `{ orderId, paymentIntentClientSecret, customerId, amount, currency }`.

If Stripe create fails before a clear side effect, retry the **same** Stripe idempotency key. Do not mint a second `orderId` for the same attempt.

Concurrent identical prepares (P1): one `OrderRecord`, one PaymentIntent, same response.

---

## 6. Required isolation: Hosted Checkout PI must never enter the PaymentSheet path

### 6.1 Why claim is not enough

`claimOneTimeFulfillment` prevents two Mindbody carts for one `orderId`. It does **not** prevent the wrong event from entering `fulfillOneTimeMindbodySale`.

If both `checkout.session.completed` and `payment_intent.succeeded` call fulfill for the same Hosted Checkout order:

- both enter the function
- one wins the claim, one noops
- logs, retries, admin tools, and “which event owns this sale” become ambiguous
- a lookup bug (wrong order, missing claim, new store) can sell twice — the failure mode we already hit

Routing must drop the wrong event **before** fulfill.

### 6.2 New field (do not overload `flow`)

| Field | Meaning | Values |
| --- | --- | --- |
| `OrderRecord.flow` / Stripe `metadata.flow` | **Product path** (already exists) | `stripe_to_mindbody_one_time` |
| `OrderRecord.paymentFlow` / Stripe `metadata.amarePaymentFlow` | **Who collected the card** | `hosted_checkout` \| `mobile_payment_sheet` |

Mobile packs are still `flow: stripe_to_mindbody_one_time`. Using `flow` for UI routing would collide with every current Checkout PaymentIntent.

### 6.3 Invariant

A one-time order is fulfilled by **exactly one** event class:

| `paymentFlow` | Allowed fulfill event | Forbidden fulfill event |
| --- | --- | --- |
| `hosted_checkout` or **missing** (legacy) | `checkout.session.completed` / `async_payment_succeeded` | `payment_intent.succeeded` |
| `mobile_payment_sheet` | `payment_intent.succeeded` | any `checkout.session.*` |

Shared tail after the gate:

```
fulfillOneTimeMindbodySale(orderId)
  → claimOneTimeFulfillment(orderId)
  → CheckoutShoppingCart
```

### 6.4 Handler rules (Phase B)

**`checkout.session.completed` / `async_payment_succeeded`**

1. Existing event-deposit and membership branches unchanged.
2. Load order by Session id / `client_reference_id` / metadata.orderId (current logic).
3. If `order.paymentFlow === "mobile_payment_sheet"` → **ack 200, do not fulfill** (should never happen; mobile create must not make a Session).
4. Else treat as Hosted Checkout (including legacy missing field) → existing fulfill.

**`payment_intent.succeeded` (new)**

Enter fulfill only if **all** of these are true (fail-closed):

1. `pi.metadata.amarePaymentFlow === "mobile_payment_sheet"`
2. `pi.metadata.orderId` is a real `orderId`
3. `get(orderId)` exists
4. `order.paymentFlow === "mobile_payment_sheet"`
5. `pi.metadata.localSku` **MUST exist** AND `pi.metadata.localSku === order.localSku`  
   Missing SKU → no fulfill. Do not treat “both unset” as a match.
6. Catalog item is one-time payment mode (not `monthlyMembership`)
7. `pi.amount_received === order.amountCents`
8. `pi.currency === order.currency`
9. If `order.stripeCustomerId` is set: `pi.customer === order.stripeCustomerId`

Then and only then: `fulfillOneTimeMindbodySale(orderId)` → claim → Mindbody.

Otherwise **ack 200 and stop**. Do not fulfill. Do not claim. Do not “find any order by PaymentIntent id”.

Especially: if metadata is missing, or `amarePaymentFlow` is absent/`hosted_checkout`, this is a Hosted Checkout (or unknown) Intent. Ignore for fulfillment. Hosted Checkout continues to use Session events only.

### 6.5 Why Hosted Checkout Intents cannot pass the gate

Today every Checkout Session copies metadata onto the PaymentIntent (`payment_intent_data.metadata`). Those Intents have:

- `metadata.orderId` — yes
- `metadata.flow` = `stripe_to_mindbody_one_time` — yes
- `metadata.amarePaymentFlow` — **no**

Rule 1 fails. The new handler returns without calling fulfill.

After Phase A hardening, new Checkout Intents have `amarePaymentFlow=hosted_checkout`. Rule 1 still fails.

Even if someone later indexes orders by `stripePaymentIntentId` (create-session already writes that field), lookup-by-PI is **not** an input to fulfill. Only `metadata.orderId` + matching `paymentFlow` + exact SKU/amount/currency/customer is.

Mobile prepare must:

- create a PaymentIntent directly (not `checkout.sessions.create`)
- never set `stripeCheckoutSessionId`
- set `amarePaymentFlow=mobile_payment_sheet` on the Intent **and** the OrderRecord

So a mobile PI cannot be mistaken for a Session, and a Session PI cannot pass the mobile gate.

### 6.6 Proof cases (must be written as tests before Phase B ships)

| # | Event | Object | Expected |
| --- | --- | --- | --- |
| H1 | `payment_intent.succeeded` | Current production Checkout PI (`orderId` set, **no** `amarePaymentFlow`) | 200, **no** fulfill, **no** claim |
| H2 | `payment_intent.succeeded` | Checkout PI with `amarePaymentFlow=hosted_checkout` | 200, no fulfill |
| H3 | `checkout.session.completed` | Same order as H1/H2 | Existing fulfill once |
| H4 | `payment_intent.succeeded` then `checkout.session.completed` | Hosted order | Only Session fulfills; PI is a no-op |
| M1 | `payment_intent.succeeded` | `amarePaymentFlow=mobile_payment_sheet` + matching OrderRecord | Fulfill once |
| M2 | Second `payment_intent.succeeded` (Stripe retry) | Same mobile order | Claim noop, no second cart |
| M3 | `checkout.session.completed` | Forged/stray session pointing at a mobile `orderId` | 200, no fulfill |
| M4 | `payment_intent.succeeded` | Mobile metadata but OrderRecord `paymentFlow=hosted_checkout` | 200, no fulfill |
| M5 | `payment_intent.succeeded` | `amarePaymentFlow` set, unknown `orderId` | 200, no fulfill |
| M6 | `payment_intent.succeeded` | Subscription invoice PI (Phase D later) | 200, no one-time fulfill |
| M7 | `payment_intent.succeeded` | Mobile PI, correct orderId/flow/SKU, **wrong amount** | 200, no fulfill, no claim |
| M8 | `payment_intent.succeeded` | Mobile PI, **wrong currency** | 200, no fulfill, no claim |
| M9 | `payment_intent.succeeded` | Mobile PI, **wrong Stripe Customer** (order has `stripeCustomerId`) | 200, no fulfill, no claim |
| M10 | `payment_intent.succeeded` | Mobile PI, **missing `localSku` metadata** | 200, no fulfill, no claim |
| P1 | `POST /prepare` | Same `purchaseAttemptId` concurrently ×5 | One OrderRecord, one PaymentIntent, same `orderId` + clientSecret |
| S1 | `GET` mobile status | User A requests User B’s mobile order | **403** |
| X1 | `payment_intent.succeeded` | Event-deposit / other metadata | 200, no class-pack fulfill |

H1 is the production-safety case. If H1 fails, Phase B does not ship. P1 and S1 are required with `/prepare` and mobile status.

---

## 7. CustomerSession and saved cards (Phase C)

Stripe Customer is already durable per linked Studio client. Phase C: server creates a CustomerSession with the PaymentIntent and returns both client secrets.

Do not auto-charge a saved card. PaymentSheet still confirms the amount.

Saving a card needs recorded consent. Phase B may omit “save for next time” and only charge the card used for that Intent.

---

## 8. Phase D — monthly (later)

Do not mix into B.

Subscriptions already: `create-session` `mode: subscription` → `SubscriptionRecord` → `invoice.paid` → Pricing Option. Electronic consent is required on the web path.

PaymentSheet subscription uses the first invoice’s PaymentIntent to confirm. Fulfillment stays **`invoice.paid`**, same `claimInvoiceSlot`. `payment_intent.succeeded` for that invoice must hit M6 (ignore one-time path).

---

## 9. App UX after pay

PaymentSheet `completed` means Stripe accepted the attempt, not that Mindbody has credits.

```
PaymentSheet completed
  → “Payment received”
  → poll mobile order-status (owned order only)
  → when mindbody_synced: invalidate member/summary
  → Home/Profile credits update
```

If the user kills the app, webhook still fulfills. Next summary load shows credits.

### 9.1 Mobile order-status ownership

Do not poll a guessable `orderId` without proving the caller owns it.

Website `GET /api/stripe/order-status?orderId=` may stay as-is for Hosted Checkout success (legacy, session return). The app must not rely on that alone.

Mobile status (preferred: `GET /api/amare/mobile-payments/status?orderId=`, or the existing endpoint **only when** a Bearer is present and the order is `mobile_payment_sheet`):

```
Bearer → amare_user_id
  → load order
  → order.amareUserId === current amare_user_id
  → else 403
```

No user may read another user’s mobile order. S1 covers this.

---

## 10. Explicit non-goals

- Second OrderRecord store
- Client-trusted price or clientId
- Fulfillment in the Capacitor plugin
- WebView Checkout
- ACH / bank / delayed methods in B
- Changing website `/pricing` identity
- Production `ENABLE_*` flips from this design
- React Native rewrite
- IAP / Play Billing for studio packs (physical studio service)

---

## 11. Implementation gate

Do not write PaymentSheet code until:

1. UX V1 is closed enough for a real APK (book / cancel / session).
2. Phase A Purchase screen design is agreed (catalog list + existing create-session).
3. **`amarePaymentFlow=hosted_checkout` is written on every new Hosted Checkout Session + PI** (required before the PI.succeeded handler exists).
4. Tests H1–H4, M1–M10, P1, S1, and X1 are specified in the Phase B PR (H1 can run against a fixture of today’s Checkout PI metadata **before** prepare exists).

If H1 is green, PaymentSheet is an extension of the current backend — not a second commerce system.

Return to UX V1 / APK. This document does not need more research.
