# AMARÉ Annual Membership Architecture

Phase 1 foundation for prepaid annual memberships using **Model F** Mindbody allocation.

## Source of truth

| System | Role |
|---|---|
| **Stripe** | Financial source of truth — one annual invoice per paid term |
| **Postgres (`annual_memberships`, `annual_membership_periods`)** | Annual entitlement ledger — 12 canonical monthly periods per paid term |
| **Mindbody** | Monthly class-credit issuance via existing Pricing Options |

## Model F (live QA proven)

Reuse existing Mindbody Pricing Options with a fixed **15% allocation discount** per monthly period:

| SKU | ProductId | List | Discount (15%) | Net | 12× net |
|---|---|---:|---:|---:|---:|
| `annual_monthly_5` | 100133 | $125.00 | $18.75 | $106.25 | $1,275.00 |
| `annual_monthly_8` | 100134 | $179.00 | $26.85 | $152.15 | $1,825.80 |
| `annual_monthly_unlimited` | 100135 | $229.00 | $34.35 | $194.65 | $2,335.80 |

Issuance path (future phases):

- `POST /sale/checkoutshoppingcart`
- Custom Stripe payment method **id 17** (accounting allocation — no second Stripe charge)
- `SendEmail: false` for automated allocations
- Deterministic PayNote for staff forensics

## Canonical period model

- Timezone: **America/New_York**
- Stripe billing instants are converted once to a **business civil date** anchor.
- Twelve periods are persisted at term creation with **half-open** civil boundaries:

```
[start_date, end_date)
```

Example anchor `2026-09-17`:

| Period | Start | End (exclusive) |
|---:|---|---|
| 0 | 2026-09-17 | 2026-10-17 |
| 1 | 2026-10-17 | 2026-11-17 |
| … | … | … |
| 11 | 2027-08-17 | 2027-09-17 |

Month boundaries derive from the **original anchor + N months** (day clamped to target month length). The Stripe term end date remains authoritative for period 11’s `period_end_date`.

### Jan 31 behavior

Anchor day is preserved where possible and clamped when the target month is shorter:

- `2026-01-31` + 1 month → `2026-02-28`
- `2026-01-31` + 2 months → `2026-03-31`
- `2024-01-31` + 1 month → `2024-02-29` (leap year)

This avoids cumulative drift from chaining intermediate end dates.

## Mindbody ClientService dates (V1 limitation)

PO **100133** uses `ExpirationType = SaleDate`, `ActivationType = OnPurchase`.

`CheckoutShoppingCart` **cannot** set ActiveDate at purchase time. ClientService windows follow **issuance date**, not DB canonical period start.

Implication: a late reconciler run shifts the Mindbody window by the delay. DB periods remain canonical.

## Overlap policy (annual-linked only)

Before issuing annual period **N**, inspect **only** the Mindbody ClientService linked in DB to annual period **N−1**.

Defer period N when:

```
previous.Remaining > 0
AND previous.ExpirationDate > current.period_start_date
```

Do **not** block because an unrelated ClientService with the same ProductId exists — customers may legitimately hold separately purchased services.

## Ambiguous Mindbody writes

Public API does **not** return PayNotes on `GET /sale/sales` or `GET /client/clientpurchases`. PayNotes are staff-forensics only.

After a timeout/ambiguous checkout response:

1. **Do not** blind-retry `CheckoutShoppingCart`.
2. Run read-after-write reconciliation using persisted claim metadata.
3. Auto-retry only when reconciliation finds **zero** Mindbody candidates.

### Durable pre-write snapshot (Phase 1 store)

Before a future Mindbody POST, the period row persists:

- `claim_started_at`
- `pre_issue_client_service_ids` (JSONB)
- expected product / net amounts on the period row

This survives process crashes so a later worker can diff ClientServices.

## Period status machine

```
pending → claiming → issued
                  ↘ failed
                  ↘ ambiguous → issued | pending (safe retry) | manual_review
failed → pending (pre-request / safe retry only)
manual_review → issued | failed | skipped
```

`issued` is terminal — cannot return to `pending`.

## Term creation flow (future Phase)

```
invoice.paid (annual)
  → createAnnualTermWithPeriods() [idempotent on stripe_invoice_id]
  → reconcile period 0 immediately
  → scheduled reconciler repairs periods 1–11
```

Same issuance function for period 0 and periods 1–11.

## Phase 1 deliverables

| Artifact | Purpose |
|---|---|
| `netlify/database/migrations/20260901183000_annual_memberships.sql` | Postgres ledger |
| `netlify/functions/annual-membership-lib.mjs` | Pure domain: pricing, periods, overlap policy |
| `netlify/functions/annual-membership-store.mjs` | Postgres + memory store with CAS transitions |
| `scripts/qa-annual-membership-phase1.mjs` | Local test matrix |

Not in Phase 1: Stripe annual checkout, webhook branch, reconciler schedule, Mindbody writes.

## Phase 2 — Model F allocation engine

| Artifact | Purpose |
|---|---|
| `netlify/functions/stripe-mindbody-sync-lib.mjs` | `syncAnnualAllocationToMindbody()` wrapper |
| `netlify/functions/annual-membership-issue.mjs` | Single issuance engine for all periods |
| `scripts/qa-annual-membership-phase2.mjs` | Mocked issue-engine matrix |
| `scripts/qa-annual-allocation-testtrue.mjs` | Live Test:true probes (no writes) |

### Issuance sequence (`issueAnnualMembershipPeriod`)

1. Load period + parent membership.
2. Validate membership status (`active`), period status (`pending`), due date, SKU amounts.
3. For period N > 0: fetch **only** the Mindbody ClientService linked to annual period N−1. If `Remaining > 0` and `ExpirationDate > period_start_date` → **DEFER** (period stays `pending`).
4. CAS claim: `pending → claiming` (one winner).
5. Fetch ClientServices for expected ProductId; persist `pre_issue_client_service_ids` **before** Mindbody POST.
6. Call `syncAnnualAllocationToMindbody()`:
   - Custom Stripe payment method **17**
   - Fixed Model F list/discount/net from SKU config
   - **`SendEmail: false`** (annual allocations never email)
   - PayNote: `annual=<id>; inv=<invoice>; p=N/12; alloc=prepaid; sku=…; net=…`
7. Success → `claiming → issued` with `mindbody_sale_id` + `mindbody_client_service_id`.
8. Definitive MB rejection → `failed`.
9. Pre-request/config failure → release to `pending`.
10. Timeout / uncertain response → `ambiguous` — **no blind retry**.

Custom Stripe tender is **accounting allocation only** — no second Stripe charge.

### Ambiguous write recovery

`reconcileAmbiguousAnnualPeriod()` / `recoverStaleAnnualClaims()` (15-minute stale threshold):

1. Load persisted snapshot + claim window.
2. Diff ClientServices for expected ProductId.
3. Exactly one new service + matching purchase/sale (product, net, method 17, time window) → attach → `issued`.
4. Zero matches + fresh claim → remain `ambiguous`.
5. Zero matches + stale claim → `releaseSafeRetryToPending`.
6. Multiple candidates → `manual_review`.

**Blind retry after ambiguous write: NO.**

## Phase 3 — Stripe annual backend + reconciler

| Artifact | Purpose |
|---|---|
| `src/content/stripe-mindbody-catalog.config.json` | Annual SKUs (`annual_monthly_*`, `recurringInterval: year`) |
| `netlify/functions/stripe-catalog-lib.mjs` | `annualMembership` kind + `isAnnualMembershipCatalogItem()` |
| `netlify/functions/stripe-create-checkout-session.mjs` | Annual checkout (`interval: year`, `billingCadence: annual`) |
| `netlify/functions/annual-membership-webhook-lib.mjs` | `invoice.paid` / `payment_failed` annual handlers |
| `netlify/functions/stripe-webhook.mjs` | Routes annual vs monthly before monthly Mindbody sync |
| `netlify/functions/annual-membership-reconciler.mjs` | Daily due-period issuance + stale/ambiguous recovery |
| `scripts/qa-annual-membership-phase3.mjs` | Mock webhook + reconciler matrix |

### Stripe annual lifecycle

```
Checkout (annual SKU, mode=subscription, interval=year)
  → invoice.paid
  → classify SKU via catalog (NOT display price)
  → createAnnualTermWithPeriods() [UNIQUE stripe_invoice_id]
  → issueAnnualMembershipPeriod(period 0) [shared engine]
  → daily reconciler issues periods 1–11 when due
```

**Renewal:** each successful yearly `invoice.paid` creates a **new** annual term + 12 periods. Idempotent on `stripe_invoice_id`. Year N period 11 `period_end_date` must equal Year N+1 period 0 `period_start_date`.

**Term dates:** derived from Stripe invoice line / subscription period (`period.start` / `period.end`), converted to America/New_York civil dates — never from webhook arrival time or `Date.now()`.

### Invoice classification

| SKU family | Webhook path |
|---|---|
| `monthly_5`, `monthly_8`, `monthly_unlimited` | Existing monthly `handleInvoicePaid` Mindbody sync (unchanged) |
| `annual_monthly_5`, `annual_monthly_8`, `annual_monthly_unlimited` | `handleAnnualInvoicePaid` → Postgres ledger only |
| Unknown subscription SKU | Fail closed |

### Payment failure (annual renewal)

`invoice.payment_failed` on an annual subscription:

- Does **not** create a new annual term.
- Does **not** revoke already-paid Year 1 DB entitlement.
- Records `skipped_payment_failed` on the subscription record; logs `annual_renewal_failed`.

### Cancellation (V1)

`cancel_at_period_end` / Stripe subscription cancellation:

- Prevents **future** yearly renewal invoices.
- Already-paid annual DB term + pending periods remain until `term_end_date`.
- Refund-based entitlement revocation: **not implemented**.

Logged via `describeAnnualCancellationSemantics()` on `customer.subscription.deleted`.

### Daily reconciler

- **Schedule:** `30 9 * * *` UTC (`netlify.toml` + function `config.schedule`)
- **Order:** recover stale `claiming` rows → reconcile `ambiguous` → issue due `pending`/`failed`
- **Due rule:** `period_start_date <=` current America/New_York business date
- **Never:** scan all Mindbody clients, issue future periods early, blind-retry ambiguous writes
- **Concurrency:** `RECONCILER_MAX_CONCURRENCY = 3`

### Stripe listen local QA (test mode only)

Local webhook endpoint (from `scripts/start-stripe-listen-local.mjs`):

```bash
stripe listen --forward-to http://127.0.0.1:4321/api/stripe/webhook
```

- Use the signing secret emitted by `stripe listen` **only** in local env — never commit it.
- Set `ANNUAL_WEBHOOK_SKIP_MINDDBODY_ISSUE=1` to prove routing/idempotency without live Mindbody writes.
- Stripe TEST MODE only. No production charges.

### QA client (scripts/config only — not production defaults)

| Field | Value |
|---|---|
| Mindbody ClientId | `100002839` |
| Email | `snir26@pic-smart.com` |
| Phone | `(786) 503-4576` |

### Production status

- **DB migration:** not applied to production
- **Deploy:** pending
- **Pricing UI / Monthly↔Annual toggle:** Phase 4 implemented (flag-gated; default OFF)

## Phase 4 — Pricing UI, admin observability, regression prep

### UI cadence behavior

| Mode | Toggle visible | Cards | Checkout SKU source |
|---|---|---|---|
| Default page load (**Monthly** selected) | Yes | Monthly prices/copy | `byMindbodyServiceId` → `monthly_*` |
| **Annual** selected | Yes | Annual prices/copy | `byMindbodyServiceIdAnnual` → `annual_monthly_*` |

Default cadence: **Monthly**. Annual affordance: **Save 15%** on the toggle button.

Implementation files:

- `src/content/pricing.html` — cadence toggle + dual policy footer
- `src/js/pricing-api.js` — `membershipPricingCadence`, `lookupStripeRecurringSku()` map selection, card re-render
- `scripts/build.mjs` → embedded `mb-stripe-recurring-config` JSON
- `src/css/components-pricing.css` — toggle + `.plan-equiv` responsive styles

### Annual pricing display (catalog-authoritative)

| Tier | Primary | Secondary | Supporting copy |
|---|---|---|---|
| Annual 5 | $1,275 / year | $106.25/mo equivalent | Billed annually · Save 15% · 5 class credits refresh monthly |
| Annual 8 | $1,825.80 / year | $152.15/mo equivalent | Billed annually · Save 15% · 8 class credits refresh monthly |
| Annual Unlimited | $2,335.80 / year | $194.65/mo equivalent | Billed annually · Save 15% |

Monthly prices remain **$125 / $179 / $229** — unchanged when annual UI is enabled but Monthly is selected.

### Annual UI (version-controlled, always on)

| Setting | Default | Read at |
|---|---|---|
| `annualMembershipUiEnabled` in `src/content/annual-membership-ui.config.json` | `true` (ON) | `scripts/build.mjs` → `readAnnualMembershipUiEnabled()` → embedded `annualUiEnabled` in `#mb-stripe-recurring-config` on `pricing.html` |

**Default page cadence:** Monthly — the toggle is visible but pricing opens on Monthly until the user selects Annual.

**Release control:** do not deploy until QA/regression complete. No env var or build override — the committed JSON file is the only switch.

Backend annual SKU support, webhook path, reconciler, and admin read API are independent of the cadence the user selects on `/pricing`.

### Annual terms wording (approved)

- Pricing footer (`#mb-pricing-policy-annual`) and Terms §5 (`terms.html`) state upfront billing, automatic annual renewal, cancel-renewal anytime (effective end of paid term), non-refundable / no prorated refunds, and monthly credit refresh with no rollover.
- Monthly **3-month minimum** language is hidden when Annual cadence is selected on `/pricing`.

### Pre-deploy hardening (skip flag)

`resolveAnnualSkipMindbodyIssue()` in `annual-membership-webhook-lib.mjs` ensures Stripe **live-mode** annual invoices always attempt Mindbody issuance. `ANNUAL_WEBHOOK_SKIP_MINDDBODY_ISSUE=1` and `STRIPE_TEST_MODE_MINDBODY_BEHAVIOR=skip` apply only when `stripeLivemode === false`.

### Netlify Production ENV — annual QA variables

| Variable | Required in Production? | Notes |
|---|---|---|
| `ANNUAL_WEBHOOK_SKIP_MINDDBODY_ISSUE` | **No** | Local/Stripe TEST QA only. Ignored for live-mode Stripe events even if set. |
| `STRIPE_TEST_MODE_MINDBODY_BEHAVIOR` | **No** | Local/Stripe TEST QA only. Live Stripe fulfillment always uses live Mindbody behavior. |
| `annualMembershipUiEnabled` (JSON file) | **Yes (committed default `true`)** | Version-controlled in repo; not a Netlify env var. |

**Invariant:** `stripeLivemode === true` → annual Mindbody fulfillment is always live, regardless of QA env vars.

### Admin observability (read-only)

| Surface | Path |
|---|---|
| Admin UI | `/admin/annual-memberships` |
| Read API | `GET /api/admin/annual-memberships` (header `x-admin-token`) |

Lookup: `id`, `mindbodyClientId`, `stripeSubscriptionId`, `stripeInvoiceId`, or recent list (`limit` ≤ 20).

Highlights: `failed`, `ambiguous`, `manual_review`, `stale_claiming` (claiming > 15 minutes).

No retry/mutation endpoints in Phase 4.

### Production rollout sequence (not executed)

1. Apply Postgres migration to production (`20260901183000_annual_memberships.sql`)
2. Deploy backend + reconciler (annual webhook path already E2E proven in Stripe TEST)
3. Run **final purchase regression matrix** below in Stripe TEST + staging Mindbody
4. Deploy with `annualMembershipUiEnabled: true` (default) after regression PASS
5. Enable annual sales in production catalog/ops checklist (separate from code deploy)

### Final purchase regression matrix

Run before production deploy. Each row: verify ENTRY → STRIPE MODE → SKU → STRIPE OBJECT → WEBHOOK BRANCH → MINDBODY EFFECT → EMAIL → IDEMPOTENCY.

| # | Flow | Entry | Stripe mode | Expected SKU | Stripe object | Webhook branch | Mindbody effect | Email | Idempotency |
|---|---|---|---|---|---|---|---|---|---|
| R1 | Monthly 5 | `/pricing` Monthly CTA | TEST/LIVE | `monthly_5` | Subscription `interval=month` | Monthly `handleInvoicePaid` sync | PO 100133 full price | Membership receipt | Invoice id dedup |
| R2 | Monthly 8 | `/pricing` Monthly CTA | TEST/LIVE | `monthly_8` | Subscription `interval=month` | Monthly sync | PO 100134 | Membership receipt | Invoice id dedup |
| R3 | Monthly Unlimited | `/pricing` Monthly CTA | TEST/LIVE | `monthly_unlimited` | Subscription `interval=month` | Monthly sync | PO 100135 | Membership receipt | Invoice id dedup |
| R4 | Annual 5 | `/pricing` Annual CTA (flag ON) | TEST first | `annual_monthly_5` | Subscription `interval=year` | `handleAnnualInvoicePaid` | Period 0 PO 100133 @ 15% discount | Annual receipt | `stripe_invoice_id` unique |
| R5 | Annual 8 | `/pricing` Annual CTA | TEST | `annual_monthly_8` | `interval=year` | Annual webhook | Period 0 PO 100134 @ 15% | Annual receipt | Invoice dedup |
| R6 | Annual Unlimited | `/pricing` Annual CTA | TEST | `annual_monthly_unlimited` | `interval=year` | Annual webhook | Period 0 PO 100135 @ 15% | Annual receipt | Invoice dedup |
| R7 | Membership coupon | Stripe Checkout promo (if enabled) | TEST | `monthly_*` | Subscription + discount | Monthly sync w/ discount metadata | PO net matches invoice | Receipt | Coupon + invoice dedup |
| R8 | NCS / intro | `/pricing` NCS card | TEST/LIVE | `new_client_special` (catalog) | PaymentIntent / Checkout `mode=payment` | `checkout.session.completed` one-time | Mindbody service grant | NCS email | Session id dedup |
| R9 | Drop-in single | `/pricing` drop-in | TEST/LIVE | `drop_in_single_class` | One-time Checkout | One-time fulfill | Single visit service | Purchase email | Order store dedup |
| R10 | 10-pack | `/pricing` packs | TEST/LIVE | pack SKU | One-time | One-time fulfill | 10-visit service | Purchase email | Order dedup |
| R11 | 20-pack | `/pricing` packs | TEST/LIVE | pack SKU | One-time | One-time fulfill | 20-visit service | Purchase email | Order dedup |
| R12 | Member top-up | App / member flow | TEST/LIVE | top-up SKU | One-time | One-time fulfill | Credit add | Receipt | Order dedup |
| R13 | Anonymous recurring | `/pricing` guest membership | TEST | `monthly_*` | Subscription | Monthly sync | PO grant | Receipt | Subscription + invoice dedup |
| R14 | Authenticated recurring | Linked AMARÉ commerce | TEST | `monthly_*` | Subscription | Monthly sync | PO grant | Receipt | Same |
| R15 | Mobile PaymentSheet | App hosted checkout | TEST | catalog SKU | Checkout Session | Matching webhook branch | Same as web | Same | Same |
| R16 | One-time mobile/web | Express checkout | TEST | one-time SKU | Payment | `fulfillSession` | Mindbody sale | Email | Order dedup |
| R17 | Admin retry sync | `/api/stripe/admin/subscriptions/retry-sync` | n/a | n/a | n/a | Re-invoke monthly sync | PO add retry | n/a | Refuses if already synced |
| R18 | Refund webhook | Stripe Dashboard refund | TEST | any fulfilled | Refund event | Refund handler branch | Revoke / mark (per existing logic) | Refund email if configured | Event id dedup |
| R19 | Subscription cancel | Stripe Dashboard | TEST | `monthly_*` | `customer.subscription.deleted` | Cancellation semantics | No new PO | n/a | Status update |
| R20 | Subscription renewal | Natural billing cycle | TEST | `monthly_*` | `invoice.paid` renewal | Monthly sync | New period PO | Receipt | Invoice dedup |
| R21 | Annual renewal | Year 2 invoice | TEST | `annual_monthly_*` | `invoice.paid` | New annual term + 12 periods | Period 0 issue | Receipt | New term by invoice id |
| R22 | Deferred post-purchase MB | Classes handoff checkout | TEST | eligible SKU | Checkout | Deferred fulfill path | Delayed Mindbody | Deferred email | Handoff + session dedup |

**Shared infrastructure touched by annual work** (regression priority):

- `stripe-catalog-lib.mjs` — annual SKU definitions
- `stripe-create-checkout-session.mjs` — annual subscription checkout
- `stripe-webhook.mjs` — annual early branch in `handleInvoicePaid`
- `stripe-mindbody-sync-lib.mjs` — unchanged monthly one-time/recurring sync (must not regress)

### Production safety notes (Phase 4 audit)

| Env var | Verdict | Notes |
|---|---|---|
| `STRIPE_TEST_MODE_MINDBODY_BEHAVIOR` | **SAFE** | Pure Stripe live-mode events always use `behavior: "live"`. Env applies only when `stripeLivemode === false`. |
| `ANNUAL_WEBHOOK_SKIP_MINDDBODY_ISSUE` | **SAFE (test-mode only)** | Ignored when `stripeLivemode === true`; logs `annual_test_skip_ignored_in_live_mode` if set during a live event. Only applies with Stripe test-mode events. |

## QA client (documentation only)

Client `100002753` holds live Model F QA artifacts:

- SaleId `36921`
- ClientServiceId `32921`
- Product `100133`, 5 remaining

No cleanup required for architecture work.
