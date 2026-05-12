# Stripe → Mindbody One-Time Checkout — Decisions Log

> **Status:** answered. Implementation lives in `netlify/functions/stripe-*.mjs`,
> `netlify/functions/_embedded/stripe-mindbody-catalog.config.json`,
> `src/content/checkout-success.html` / `checkout-cancel.html`, and the
> Express-checkout CTA in `src/js/pricing-api.js`.
>
> See also: `docs/MINDBODY-CHECKOUT-OVERVIEW.md` (Stripe section) and `.env.example`.

For context, the inspection finding is settled:

> **One-time packages (New Client Special, drop-in, 5/10/20 class packs) are sold as `Type: "Service"` in Mindbody CheckoutShoppingCart** — i.e., Mindbody Pricing Options sourced from `GET /public/v6/sale/services?SellOnline=true`, identified by `Metadata.ServiceId`. They are **not** `Product`, **not** `PricingOption` (not a real Mindbody type), and **not** `Contract` (contracts are recurring memberships only and stay on Mindbody classic).
>
> Verified in `netlify/functions/mindbody-sale-checkout.mjs` lines 302–334, the catalog endpoint in `netlify/functions/mindbody-sale-services.mjs` line 31, the bucketing logic in `src/js/pricing-api.js` lines 974–984, and the contracts-only path in `netlify/functions/mindbody-sale-purchase-contract.mjs` line 393. Repo-wide search for `Type: "Product"` / `sale/products` / `productpurchase` / `RetailProduct` / `SaleProductId` returned **zero matches**.

---

## Question 1 — Mindbody accounting approach

**Answer:** **A — Custom payment type.**

A Mindbody Payment Method named **`Stripe`** has been created in the studio with:

- Active: yes
- Allow > $0: yes
- PayNotes: yes (Label: `Stripe Order ID`)
- Allow $0: no
- CashEQ: no
- Allow Refund: no (for now)

Production mode is `MINDBODY_STRIPE_PAYMENT_MODE=custom` (default). `comp` is kept as a
fallback / test mode only; it is **not** auto-selected if `custom` fails. If Mindbody rejects the
custom payment method during a live sync, the order is marked `paid_but_not_synced` /
`manual_review` so staff can reconcile by hand — we never silently downgrade to Comp.

Each Mindbody sale carries a payment note (PayNotes) that does **not** include card details or
secrets:

```
orderId={orderId}; session={checkoutSessionId}; sku={localSku}
```

The customer is charged once, in Stripe. Mindbody records the sale as paid via the **`Stripe`**
custom payment method.

## Question 2 — Order storage

**Answer:** **C — Netlify Blobs now, adapter seam for later.**

Lives in `netlify/functions/stripe-order-store.mjs`. The adapter exposes:

- `OrderStore.get(orderId)`
- `OrderStore.put(orderId, record, { onlyIfNew })`
- `OrderStore.patch(orderId, partial)`
- `OrderStore.listByStatus(status, { limit })`
- `OrderStore.getByCheckoutSessionId(sessionId)`

Backed by the Netlify Blobs store `stripe-mindbody-orders` plus a sibling
`stripe-mindbody-orders-by-session` index store so the webhook can look up orders by
`checkout_session_id` quickly. We can swap the backing store to Supabase/Postgres later by
replacing the implementation behind this interface — webhook and sync logic do not change.

## Question 3 — New Client Special duplicate policy

**Answer:** **A — `block_before_checkout_if_known`.**

- If the client is logged into Mindbody (we have a confident `mindbodyClientId` in session),
  `stripe-create-checkout-session` calls Mindbody to verify NCS eligibility before issuing the
  Stripe Checkout Session. If the client already used NCS we return a 409 and the frontend
  shows a "you've already used this offer" message (with a fallback to classic checkout for
  any other package).
- If the client is anonymous (no Mindbody session), Stripe payment is allowed. After the
  webhook resolves the client by email and the matched client has prior NCS history, the order
  is parked at `paid_but_not_synced` with `reason: ncs_for_existing_client` for staff review.
- For `dropin`, `pack_5`, `pack_10`, `pack_20` the policy is `allow_additional` — never block,
  never duplicate-flag.

Per-SKU configuration is in `netlify/functions/_embedded/stripe-mindbody-catalog.config.json`
(`oneTimePerClient` + `duplicatePolicy`).

## Question 4 — Scope of first PR

**Answer:** **B — Phase 1 wired for all one-time SKUs, only NCS enabled by default.**

The catalog config knows about every one-time SKU we sell today (NCS, drop-in, 5/10/20 class
packs). Each row has an independent `enabledForExpressCheckout` flag. **Only the New Client
Special row ships with `enabledForExpressCheckout: true`**; everything else stays `false` until
we are ready to flip them per-row.

Recurring memberships / contracts are excluded from this code path entirely — the only entry
point is `Type: "Service"` rows, and the create-session function rejects any SKU whose catalog
entry has `mindbodyItemType !== "Service"`.

The whole feature is gated by `ENABLE_STRIPE_ONE_TIME_CHECKOUT=0|1`. Default off until
deployment + Stripe webhook secret are configured.

## Question 5 — Internal alert channel for `paid_but_not_synced`

**Answer:** **D — `console.error` JSON only for MVP.**

`stripe-mindbody-sync-lib.mjs` and `stripe-webhook.mjs` emit structured `console.error` /
`console.warn` JSON for every `paid_but_not_synced`, `sync_failed_retryable`,
`sync_failed_manual_review`, and `manual_review` transition. Order state is written to the
order store first, so retries are safe. A protected admin/retry endpoint
(`stripe-admin-orders.mjs`, gated by `ADMIN_DEBUG_TOKEN`) lets us list, inspect, and retry
broken orders by hand.

A future PR can add Slack / email by reading the same order store + log payloads.

---

## Implementation summary

| Concern | File / location |
|---|---|
| Server-side SKU → Stripe + Mindbody mapping | `netlify/functions/_embedded/stripe-mindbody-catalog.config.json` |
| Catalog loader + validation | `netlify/functions/stripe-catalog-lib.mjs` |
| Order store (Netlify Blobs adapter) | `netlify/functions/stripe-order-store.mjs` |
| Stripe → Mindbody sync (resolve client + add Service line) | `netlify/functions/stripe-mindbody-sync-lib.mjs` |
| `POST /api/stripe/checkout/create-session` | `netlify/functions/stripe-create-checkout-session.mjs` |
| `POST /api/stripe/webhook` | `netlify/functions/stripe-webhook.mjs` |
| `GET /api/stripe/order-status?orderId=…` | `netlify/functions/stripe-order-status.mjs` |
| Admin retry / list (gated) | `netlify/functions/stripe-admin-orders.mjs` |
| Customer-facing pages | `src/content/checkout-success.html`, `src/content/checkout-cancel.html`, `src/js/checkout-success.js` |
| Express CTA on `/pricing` | `src/js/pricing-api.js` (gated on per-SKU `enabledForExpressCheckout`) |
| Redirects | `netlify.toml` (`/api/stripe/*`, `/checkout/success`, `/checkout/cancel`) |
| Local dev routes | `scripts/unified-local-dev.mjs` |

Phases in `.env.example`:

- Phase 1 (today): `ENABLE_STRIPE_ONE_TIME_CHECKOUT=0`. Wire envs, deploy in test mode,
  exercise webhook with Stripe CLI.
- Phase 2: flip `ENABLE_STRIPE_ONE_TIME_CHECKOUT=1` after creating the production webhook
  endpoint in Stripe and confirming the `Stripe` payment method id in Mindbody.
- Phase 3: flip `enabledForExpressCheckout` for drop-in / 5 / 10 / 20 packs in the catalog
  config when ready. Recurring memberships stay on Mindbody classic indefinitely.
