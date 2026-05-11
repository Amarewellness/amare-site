# Stripe → Mindbody One-Time Checkout — Open Questions Before Implementation

These four decisions block a clean, safe implementation. Please pick one option per question (or write a custom answer) and I will then build the feature accordingly.

For context, the inspection finding is already settled:

> **One-time packages (New Client Special, drop-in, 5/10/20 class packs) are sold as `Type: "Service"` in Mindbody CheckoutShoppingCart** — i.e., Mindbody Pricing Options sourced from `GET /public/v6/sale/services?SellOnline=true`, identified by `Metadata.ServiceId`. They are **not** `Product`, **not** `PricingOption` (not a real Mindbody type), and **not** `Contract` (contracts are recurring memberships only and stay on Mindbody classic).
>
> Verified in `netlify/functions/mindbody-sale-checkout.mjs` lines 302–334, the catalog endpoint in `netlify/functions/mindbody-sale-services.mjs` line 31, the bucketing logic in `src/js/pricing-api.js` lines 974–984, and the contracts-only path in `netlify/functions/mindbody-sale-purchase-contract.mjs` line 393. Repo-wide search for `Type: "Product"` / `sale/products` / `productpurchase` / `RetailProduct` / `SaleProductId` returned **zero matches**.

---

## Question 1 — Mindbody accounting approach for the post-Stripe sync

The MVP must not double-charge the customer in Mindbody. The Stripe payment has already cleared; we just need to record the package on the client's Mindbody account. Which path do you want?

- [ ] **A. Custom payment type** — Mindbody sale recorded as paid by a "Custom" / "Other" payment type (e.g., `"Stripe External"`).
  Cleanest for revenue reports. Requires you to confirm that a Custom payment type exists in **Mindbody → Site Settings → Payment Methods** (or that we can create one). I'll add a server-side payment-type id env var (e.g. `MINDBODY_STRIPE_PAYMENT_TYPE_ID`) and verify on first run.

- [ ] **B. Comp + note** — Mindbody line booked as `Type: "Comp"` (zero) with a note `"Paid via Stripe order {orderId}, session {sessionId}, sku {localSku}"`.
  This is exactly what the existing dry-run path already does (`buildCheckoutPayload` already emits a `Comp` payment row), so it Just Works without any Mindbody site config — but it will **under-report Mindbody revenue** and you'll need to reconcile against Stripe daily.

- [ ] **C. Both, env-flagged** — I don't know yet; please draft the catalog/order/webhook code in a way that supports both, gated by an env flag `MINDBODY_STRIPE_PAYMENT_MODE=custom|comp`, and I'll decide before flipping the live feature flag.

> **Your answer:**

---

## Question 2 — Order storage for `orderId → status / Mindbody sync state`

The repo already has Netlify Blobs wired for membership consent and checkout idempotency (see `netlify/functions/mindbody-checkout-idempotency.mjs` and `netlify/functions/membership-consent-blobs.mjs`). What should I use for Stripe orders?

- [ ] **A. Netlify Blobs** — new store, e.g. `stripe-mindbody-orders`.
  Lowest-friction, matches the existing pattern, no new infra. Reads/writes are eventually consistent globally but strongly consistent per-key, which is fine for our single-checkout-session-key flow.

- [ ] **B. Supabase / Postgres** — adds a real DB.
  More queryable for the admin/retry tools, gives us proper SQL for the daily Stripe-vs-Mindbody reconciliation, but adds a new dependency, new env vars, and another moving part.

- [ ] **C. Blobs now, adapter seam for later** — default to Netlify Blobs for the MVP but write a thin storage-adapter interface (`OrderStore.get/put/patch/listByStatus`) so we can swap to Supabase later without touching the webhook logic.

> **Your answer:**

---

## Question 3 — New Client Special duplicate policy at MVP launch

You listed three options in the spec — please confirm one:

- [ ] **A. `block_before_checkout_if_known`** — only block when we have a confident Mindbody `clientId` from session (because the user is already OAuthed in); otherwise allow Stripe payment and flag the order for manual review if a same-email match later turns out to have prior NCS history.

- [ ] **B. `manual_review_after_payment`** — always let Stripe charge, but **never auto-sync** NCS for an existing client; tag every NCS for an existing-client match as `paid_but_not_synced / reason: ncs_for_existing_client` and require staff to release.

- [ ] **C. `allow_additional`** — let it through; trust staff to handle abuse. Tag the order with a `possible_duplicate_ncs` note when an existing client is matched.

> **Your answer:**

---

## Question 4 — Scope of the first PR

This is a large change set; I'd rather ship a smaller first slice and iterate. Which of these matches what you want from the first PR?

- [ ] **A. Phase 1 only — NCS, fully wired** — feature-flagged `ENABLE_STRIPE_ONE_TIME_CHECKOUT=0` by default, enabled for **New Client Special only**, with full webhook + idempotency + order store + success/cancel pages + admin retry function + GA4 events. UI on `/pricing-api` shows "Express checkout" only on the NCS card.

- [ ] **B. Phase 1 wired for all one-time SKUs** — NCS + drop-in + 5/10/20 packs, all gated per-SKU in the server-side catalog config (`enabled: true|false`, `enabledForExpressCheckout: true|false`). Default config has only NCS enabled; you flip the rest in env/config when you're ready.

- [ ] **C. Skeleton first** — catalog mapping, Checkout Session function, webhook signature verification, order store, success/cancel pages, and **one happy-path NCS test** in Stripe test mode + Mindbody `Test=true`. **No** retries / admin tools / GA4 / multi-SKU / paid_but_not_synced alerting yet — those come in a follow-up PR. Smallest reviewable unit, fastest to merge.

> **Your answer:**

---

## Question 5 (optional) — Internal alert channel for `paid_but_not_synced`

The spec asks for an internal alert when Stripe payment succeeds but Mindbody sync fails. Where should the alert go?

- [ ] **A. `console.error` JSON only** — Netlify function logs are searchable; we'll wire Slack/email later.
- [ ] **B. Email** — send to a `STUDIO_ALERT_EMAIL` env var via Netlify's built-in SendGrid / a transactional provider you already use. (If yes — which provider?)
- [ ] **C. Slack webhook** — post to a `STUDIO_ALERT_SLACK_WEBHOOK_URL` env var.
- [ ] **D. Console-only for MVP, channel TBD later.**

> **Your answer:**

---

## After you answer

Once these are filled in, I will, in this order:

1. Add the server-side catalog mapping file (`netlify/functions/_embedded/stripe-mindbody-catalog.config.json`) with the SKUs you confirm — `mindbodyItemType: "Service"` for every row, `mindbodyServiceId` from the existing `/sale/services` ids, and `enabledForExpressCheckout` flags.
2. Add `netlify/functions/stripe-create-checkout-session.mjs` (server-side validation, Stripe SDK, metadata, `client_reference_id`, idempotency).
3. Add `netlify/functions/stripe-webhook.mjs` (signature verification, idempotent fulfillment, calls into the new sync helpers).
4. Add `netlify/functions/stripe-mindbody-sync-lib.mjs` with `resolveOrCreateMindbodyClient(order)` and `syncOneTimePurchaseToMindbody(order)`, reusing the existing `Type: "Service"` payload shape from `mindbody-sale-checkout.mjs` and the existing staff-token cache.
5. Add the order store adapter (Netlify Blobs by default per Q2).
6. Add `/checkout/success` and `/checkout/cancel` pages + a `stripe-order-status` read-only function for the success page.
7. Wire the "Express checkout" CTA into `src/js/pricing-api.js` behind the feature flag, only on rows whose SKU resolves to `enabledForExpressCheckout: true`.
8. Add the four GA4 events listed in the spec.
9. Update `.env.example`, `netlify.toml`, and `docs/MINDBODY-CHECKOUT-OVERVIEW.md`.
10. Add a tiny admin/retry function gated by an `ADMIN_DEBUG_TOKEN` env var (only if you pick option A or B in Q4).

I will not start until I have your answers above.
