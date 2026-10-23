# AMARÉ Admin — Change Membership

Admin feature for upgrading or downgrading an existing **Stripe-managed monthly membership** (Monthly 5 / Monthly 8 / Monthly Unlimited) from `/admin/monthly-memberships`.

| | |
|---|---|
| Status | Live in production, always on (no feature flags) |
| Admin page | `https://www.amarewellness.com/admin/monthly-memberships` |
| API | `/api/admin/monthly-memberships` → `netlify/functions/membership-change-admin.mjs` |
| Production commit | `f3747229e997c707cd11cb3514e9ed7e950c0cdd` |
| Production deploy | `6adbab2bae6d566f6870c8db` (2026-10-23) |
| Customer self-service | Not enabled (admin only) |

> **Before the first real billing change:** an owner must be enrolled (see [Runbook → Enroll the first owner](#enroll-the-first-owner)). Live billing execution has not yet been performed in production; only Stripe previews were verified there.

## Source of truth

| System | Role |
|---|---|
| **AMARÉ catalog** (`src/content/stripe-mindbody-catalog.config.json` → `getCatalogItem()`) | Plan prices, names, Mindbody service ids, contract product ids. Nothing is hardcoded in the UI or accepted from the browser. |
| **Stripe** | Financial source of truth. The existing subscription and item are updated in place (never cancelled and recreated). |
| **Netlify Blobs SubscriptionRecord** | Plan fields used by the `invoice.paid` webhook to issue the Mindbody package (`localSku`, `mindbodyServiceId`, `monthlyAmountCents`). |
| **Postgres** | Operation ledger and per-subscription lock (`amare_membership_change_operations`), billing administrators, auth attempts and audit log. |
| **Mindbody** | Entitlement. One package per paid Stripe invoice, issued by the existing webhook sync. |

Current catalog prices (read from the catalog at runtime): Monthly 5 **$125**, Monthly 8 **$179**, Monthly Unlimited **$229**.

## Supported changes

Direction is derived from catalog prices.

| Direction | Billing option (`policy`) | Stripe call | Charge today |
|---|---|---|---|
| Upgrade | **Immediately — new cycle, full price, no credit** (`new_cycle_no_credit`) | `billing_cycle_anchor: now`, `proration_behavior: none` | Full new-plan price |
| Upgrade | **Immediately — new cycle, credit for unused time** (`new_cycle_with_credit`) | `billing_cycle_anchor: now`, `proration_behavior: always_invoice` | New price minus Stripe credit |
| Upgrade or downgrade | **At next billing date** (`scheduled_no_charge`) | Stripe Subscription Schedule (phase 0 = current price until period end, phase 1 = new plan) | $0 |

- **Downgrades** are only offered at the next billing date. No refund is issued; the member keeps the current entitlement until renewal.
- Immediate changes always reset the billing cycle to the change time. Mindbody dates packages from the sale day, so keeping the old anchor would misalign the entitlement.
- Immediate changes use `payment_behavior: error_if_incomplete`: either the payment succeeds and the change applies, or nothing changes.

### Blockers (change refused)

Not a Stripe-managed monthly plan · not linked to Stripe · record or Stripe not `active` (including past-due) · billing paused (frozen) · cancellation scheduled · Stripe pending update · open or draft invoice · another plan change in progress · existing (non-AMARÉ) Stripe schedule · renewal less than **2 hours** away (immediate only) · catalog Stripe product not prepared · unexpected invoice lines in the preview (e.g. pending invoice items) · preview would not collect a payment (immediate).

### Warnings that require explicit acknowledgement

| Code | Meaning |
|---|---|
| `grandfathered_price` | Current Stripe price differs from today's catalog price; the old price is not kept. |
| `subscription_discount_present` | A Stripe coupon/discount keeps applying after the change. |
| `target_agreement_not_on_file` | The signed agreement covers the original plan, not the new one. The existing consent record is never modified; the admin confirms the customer agreed to the new terms. |
| `future_bookings_after_effective` | Booked classes fall on or after the change date and were booked with the current package. |
| `unused_credits_with_stripe_credit` | The current package still has credits and Stripe will also credit unused time. |

Informational notes: commitment end date preserved, unused credits remaining, Unlimited policy changes ($10 late-cancel / no-show fee and daily limits), unknown future bookings (Mindbody unavailable).

## Admin flow

1. **Find** a membership: email, name, Mindbody client id, `sub_…` or `sub_amare_…`.
2. **Current membership**: plan, Stripe price (catalog price shown if different), status, next billing date, commitment end, credits / Unlimited, future bookings, pending change, change history.
3. **Change Membership** dialog: choose the new plan, then timing and billing (only valid options are enabled).
4. **Preview with Stripe**: a real `invoices.createPreview` for immediate changes. It shows charge today, credits, discounts, tax, Stripe line items, next renewal amount and date, commitment impact, Mindbody impact and warnings.
5. **Confirmation dialog** with the exact amount ("Charge $X and change plan" / "Schedule plan change").
6. **Operation status** with polling.

"Completed" means the payment is confirmed **and** the Mindbody sale for that invoice is recorded **and** the new service is visible on the client.

### Operation statuses

| Status | Meaning | Holds the per-subscription lock |
|---|---|---|
| `executing` | Change in progress | Yes |
| `scheduled` | Stripe schedule created; switches at the next billing date | Yes |
| `syncing` | Payment confirmed; waiting for the Mindbody package | Yes |
| `needs_reconciliation` | Needs attention (uncertain Stripe outcome, Mindbody sync failed, webhook not received). Never re-charged automatically. | Yes |
| `completed` | Payment and Mindbody verified | No |
| `payment_required` | Card declined or 3D Secure required; nothing changed or charged | No |
| `failed` | Stripe rejected or never applied the change; record restored | No |
| `canceled` | Scheduled change canceled | No |

## Stripe ↔ Mindbody synchronization

### Immediate upgrade

1. Re-validate the preview: signature, 10-minute expiry, subscription fingerprint, exact amount, acknowledgements, then a fresh Stripe preview with the same amount.
2. Insert a ledger row (`executing`). The Postgres unique index allows one active operation per subscription.
3. Patch the Blob record to the target plan, plus a `planChangeInFlight` marker holding the previous plan fields.
4. `stripe.subscriptions.update` on the existing item with catalog `price_data` + catalog product, metadata `localSku` / `mindbodyServiceId` / `lastPlanChangeOperationId`, and idempotency key `amare-mc-<operationId>`.
5. Success: store the new period dates on the record, append `planChangeHistory`, set the ledger to `syncing`. The existing `invoice.paid` webhook issues the new Mindbody service because the record already carries the target SKU.
6. Error: re-read Stripe.
   - Applied → forward recovery.
   - Declined / 3D Secure / invalid → restore the record (only while this operation still owns the in-flight marker and no invoice synced since) → `payment_required` / `failed`.
   - Uncertain (timeout, read failure) → `needs_reconciliation` with the lock held. Never retried blindly.

Commitment dates, consent pointer (`membershipConsentId`), agreement hash and invoice history are never rewritten.

### Scheduled change (next billing date)

1. Create a Stripe Subscription Schedule from the subscription:
   - Phase 0: the current price until the current period end.
   - Phase 1: catalog `price_data` for the target plan for one month, with the target metadata; `end_behavior: release`.
2. Mark the Blob record with `pendingPlanChange` (`operationId`, `toSku`, `effectiveAt`, `scheduleId`). `localSku` is **not** changed early.
3. At renewal, `invoice.paid` runs `applyPendingPlanChangeOnInvoicePaid` (`netlify/functions/membership-change-webhook.mjs`) **before** the Mindbody sync. It switches the record's plan only when the paid invoice is the transition renewal: `billing_reason = subscription_cycle`, period starts at or after the effective date, and the line amount or subscription metadata matches the target plan. Other invoices are untouched; redeliveries are no-ops. If the record write fails the webhook returns 500 so Stripe retries.
4. The ledger moves `scheduled` → `syncing` → `completed` when the transition invoice's Mindbody sale is verified.
5. Cancel (allowed until 2 hours before renewal): release the Stripe schedule and clear `pendingPlanChange`.

Verified in Stripe test mode with test clocks, including a schedule on an archived checkout price.

## Billing authorization

| Layer | Check |
|---|---|
| Read | `x-admin-token` (shared `ADMIN_DEBUG_TOKEN`), same as every admin page. Lookup, details, operation status. |
| Billing | `x-billing-actor` + `x-billing-key`, verified against Postgres `amare_billing_admins` (salted scrypt N=16384, r=8, p=1). Required for preview, execute, cancel, reconcile, prepare-catalog and admin management. |

- The shared admin token alone **never** authorizes a billing action.
- Roles: `owner`, `superadmin`. Owners enroll owners or superadmins and revoke admins; superadmins can only enroll superadmins and cannot revoke. The last active owner cannot be revoked.
- **Rate limiting:** after 5 failed attempts for one admin id, or 20 from one client IP, within 15 minutes, further attempts return 429. Every attempt is recorded in `amare_billing_auth_attempts`; IPs are stored hashed.
- **must_rotate:** keys set by someone else (bootstrap migration, enrolling owner) must be changed by the admin before any billing action works.
- **expires_at:** optional hard expiry for temporary credentials.
- **Audit:** every billing action (preview, execute, cancel, reconcile, prepare-catalog, enroll, revoke, key rotation) is written to `amare_billing_audit_log` with the real admin id. The ledger also stores the initiating admin on each operation.
- No public enrollment or bootstrap route exists. The first owner is enrolled through a deploy migration (production database access from the Netlify CLI is read-only).
- Same-origin only: no CORS allow-origin header. Header-based credentials, so no cookie/CSRF exposure.

## API reference — `/api/admin/monthly-memberships`

| Method | Request | Auth |
|---|---|---|
| GET | `?q=<email / name / Mindbody id / sub_… / sub_amare_…>` | Admin token |
| GET | `?subscriptionId=sub_amare_…` (details + allowed changes) | Admin token |
| GET | `?operationId=<uuid>` (status; reconciles active operations) | Admin token |
| POST | `{ action: "whoami" }` | Billing |
| POST | `{ action: "preview", subscriptionId, toSku, policy }` | Billing |
| POST | `{ action: "execute", previewToken, confirmAmountCents, requestId, acknowledgements }` | Billing |
| POST | `{ action: "cancel-scheduled", operationId }` | Billing |
| POST | `{ action: "reconcile", operationId, retryMindbodySync }` | Billing |
| POST | `{ action: "prepare-catalog", toSku }` (one-time technical Stripe product, no charge) | Billing |
| POST | `{ action: "billing-admins-list" }` | Billing |
| POST | `{ action: "billing-admin-enroll", actorId, role, displayName, key }` | Billing (owner; superadmin → superadmin only) |
| POST | `{ action: "billing-admin-revoke", actorId }` | Billing (owner) |
| POST | `{ action: "billing-key-rotate", newKey }` | Billing (self) |

Customer, subscription and item ids, prices, service ids and amounts are always resolved server-side; client-supplied values are ignored. `requestId` is the client idempotency key: a repeated submit returns the original operation.

## Webhook retry changes (`invoice.paid`)

Applies to ordinary monthly renewals and to the membership-change flow.

| Change | File |
|---|---|
| Retryable outcomes (`claim_store_unavailable`, `claim_in_progress`, `stripe_retrieve_failed`, pre-request Mindbody failures, annual retryable) now return **503** so Stripe redelivers. Previously 200, which could drop a renewal. | `stripe-webhook.mjs` (`invoicePaidHttpStatus`) |
| The per-invoice claim is released when the sync exits before any Mindbody request (Stripe read failure, invoice not paid). | `stripe-monthly-period-sync.mjs` |
| An abandoned claim with no invoice record (holder stopped before contacting Mindbody) is taken over by compare-and-swap after **10 minutes**; only one taker wins. | `stripe-subscription-store.mjs` (`takeOverStaleInvoiceClaim`), `stripe-webhook.mjs` |
| Pre-request Mindbody failures are stored as `paid_but_not_synced` with `retryOnRedelivery: true` and retried on redelivery. Older rows without the marker stay admin-only. | `stripe-monthly-period-sync.mjs` |
| Admin retry-sync (`/api/stripe/admin/subscriptions/retry-sync` and "Retry Mindbody sync" in this feature) now actually re-attempts `paid_but_not_synced` (it was a no-op), but never re-posts a cart that may already have been sent. | `stripe-monthly-period-sync.mjs` (`adminRetry`), `stripe-admin-subscriptions.mjs` |

Invoice-level idempotency is unchanged: record dedup by `invoiceId`, per-invoice claim, and `checkoutRequestSentAt` written before any cart.

## Database migrations

All applied in production (verified with `netlify database status --branch production`).

| Migration | Purpose |
|---|---|
| `20261023190000_amare_membership_change_ops.sql` | Operation ledger; partial unique index = one active operation per subscription |
| `20261023210000_amare_billing_admins.sql` | `amare_billing_admins`, `amare_billing_auth_attempts`, `amare_billing_audit_log` |
| `20261023230000_amare_billing_admins_lifecycle.sql` | `must_rotate`, `expires_at` |
| `20261023230001_amare_billing_release_check.sql` | Temporary `qa-release-check` superadmin used for production verification (expired 2026-10-23 20:36 UTC) |

Netlify checksums applied migrations byte for byte. `.gitattributes` marks `netlify/database/migrations/*.sql -text` so checkouts never change line endings. Never edit an applied migration.

## Files

| File | Role |
|---|---|
| `netlify/functions/membership-change-admin.mjs` | HTTP API (modern runtime: `export default withLambda(lambdaHandler)`, required for the Netlify Database binding) |
| `netlify/functions/membership-change-service.mjs` | Details, preview, execute, schedule, cancel, reconcile, status |
| `netlify/functions/membership-change-lib.mjs` | Pure policy: plans, directions, blockers, warnings, preview token, fingerprint, pending-change matching |
| `netlify/functions/membership-change-store.mjs` | Ledger (Postgres + memory adapter) |
| `netlify/functions/membership-change-auth.mjs` | Admin token check, billing credential verification, rate limiting, key hashing |
| `netlify/functions/membership-billing-auth-store.mjs` | Billing admins, attempts, audit (Postgres + memory) |
| `netlify/functions/membership-change-webhook.mjs` | `invoice.paid` hook for scheduled changes |
| `netlify/functions/stripe-membership-stripe-product-lib.mjs` | Catalog-aligned Stripe product resolve / create (subscription `price_data` needs a product id) |
| `src/content/admin-monthly-memberships.html`, `src/js/admin-monthly-memberships.js` | Admin page (registered in `scripts/build.mjs`, linked from `/admin`) |
| `scripts/membership-billing-admin-enroll.mjs` | Owner bootstrap migration generator, read-only admin list |
| `scripts/dev-membership-change-ui-harness.mjs` | Local UI harness against Stripe test mode |

`netlify/functions/stripe-amanda-upgrade-lib.mjs` (one-off upgrade) was removed and replaced by the generic service.

## Runbook

### Enroll the first owner

1. `node scripts/membership-billing-admin-enroll.mjs --bootstrap-owner` — choose an admin id and a one-time key (hidden input). Refuses if production already has an active owner.
2. Commit the generated `netlify/database/migrations/<version>_amare_billing_owner_<id>.sql` (hash only).
3. Deploy using the [release procedure](#release-procedure).
4. At `/admin/monthly-memberships`: unlock with the admin login → Billing permission → enter the id and one-time key → **Manage billing admins → Change my key**. Billing actions stay blocked until the key is changed.

### Enroll, rotate or revoke other admins

Owners use **Manage billing admins** in the Billing permission panel. Enrolled admins must change their initial key on first sign-in. List admins read-only with `node scripts/membership-billing-admin-enroll.mjs --list`.

### Recover a change stuck in "Needs attention"

- `mindbody_sync_failed`: payment is confirmed; use **Retry Mindbody sync** (never charges again).
- `webhook_not_received` / uncertain Stripe outcome: **Refresh status** re-reads Stripe and the record and moves the operation forward; it never re-sends a charge.

### Prepare a catalog Stripe product

If a target plan shows "Stripe product needs preparing" (for example Monthly 8 in production as of 2026-10-23), a billing admin clicks **Prepare Stripe product** in the dialog. It is a one-time, no-charge product creation; Stripe search can take about a minute to index it.

## Release procedure

Deploy only from a committed revision in a clean clone with real dependencies:

```powershell
git clone --local --no-checkout C:\Users\snir1\amare-site C:\Users\snir1\amare-release-<sha>
git -C C:\Users\snir1\amare-release-<sha> checkout --detach <sha>
Copy-Item C:\Users\snir1\amare-site\.env C:\Users\snir1\amare-release-<sha>\.env   # build input only
cd C:\Users\snir1\amare-release-<sha>
npm ci
node node_modules\netlify-cli\bin\run.js deploy --prod --site f315d80d-f61e-4fef-9a06-68bb09192d56
```

- **Never link `node_modules` (junction/symlink) from another folder.** The packager drops external modules (`@netlify/database`) and every database-backed function fails.
- **Do not use `git worktree`.** Its `.git` is a file, so the CLI walks above the checkout looking for the project root.
- After deploy, check a function zip in `.netlify/functions/` (e.g. `stripe-webhook.zip` should have ~640 entries including `node_modules/@netlify/database`).
- Confirm `netlify database status --branch production` shows no pending migrations.

## Tests

| Command | Coverage | Result (2026-10-23) |
|---|---|---|
| `npm run test:membership-change` | Policy, service, scheduled downgrades, payment failures, concurrency, stale previews, recovery, API auth, rate limits, enrollment rules, no-flag check | 139 passed |
| `npm run test:membership-change-stripe-e2e` | Stripe **test mode** with test clocks (sk_test only) | 38 passed |
| `npm run test:membership-change-postgres` | Ledger lock, billing tables, bootstrap SQL, expiry (local Netlify DB only) | 28 passed |
| `npm run test:webhook-invoice-retry` | `invoice.paid` retry / recovery, no duplicate Mindbody sales | 29 passed |
| `npm run test:final-purchase-regression-gate` | Purchase regression gate | Pass |

Five older suites fail identically before and after this work (anonymous recurring checkout, member top-up, one-time fulfillment claim, webhook foundation, monthly entitlement); they are unrelated to this feature.

## Production verification (2026-10-23)

- Page loads, search and details work; requests without the admin token get 401.
- Admin token without billing credential: preview and execute → 403. Wrong key → 403 and recorded.
- Postgres credential verification and audit rows confirmed with the temporary `qa-release-check` superadmin.
- Stripe preview: Amanda Curry Unlimited → Monthly 5 at next billing date: $0 today, effective 2026-11-23, renews at $125, commitment end 2027-01-08 unchanged. Immediate downgrade refused.
- No execute call was made. Ledger has 0 operations; Amanda's Stripe invoices unchanged.

## Known limitations

- **Email/name search only returns `active` and `past_due` memberships.** Canceled or pending records are found only by exact `sub_amare_…` / `sub_…` id.
- No prorated change that keeps the old billing date; no immediate downgrade; no refunds.
- Declined or 3D Secure cards: the change is not applied; the customer must update the card first (no hosted payment link flow).
- Future bookings are flagged and acknowledged, not moved automatically.
- Billing identities are separate from the shared admin login (no SSO / per-user admin login).
- Existing Stripe schedules created outside this feature block changes until released in Stripe.

## Change log

| Date | Commit | Change |
|---|---|---|
| 2026-10-23 | `0aec584` | Feature introduced (flags, env-stored billing hashes) |
| 2026-10-23 | `891581c` | Admin function moved to the modern runtime (database binding) |
| 2026-10-23 | `3aa88aa` | "Prepare Stripe product" action in the dialog |
| 2026-10-23 | `a01c43c` | Flags removed; billing credentials moved to Postgres; `invoice.paid` retry fixes |
| 2026-10-23 | `d75e16e` | Migrations stored byte-exact (`.gitattributes`) |
| 2026-10-23 | `f374722` | must-rotate / expiry; migration-based owner bootstrap; temporary release-check credential |

### Incidents during release (2026-10-23)

- **Missing function dependencies (~21:29–21:45 Israel time):** deploys `6adba60d…` and `6adba8ac…` were built from a clean clone whose `node_modules` was a junction; function zips shipped without `@netlify/database`, so database-backed functions (including `stripe-webhook` and auth functions) failed. Fixed by redeploying with `npm ci` (`6adba9fb…`, then `6adbab2b…`). Stripe reported no undelivered live events for the window.
- **Untracked function in production:** `amare-account-link-repair.mjs` (no handler; returned 502) had shipped with earlier working-directory deploys. Removed from production by the clean-revision deploys (now 404); the local file is untouched.
- **Obsolete env vars removed:** `MEMBERSHIP_CHANGE_ADMIN_ENABLED`, `MEMBERSHIP_CHANGE_DEFERRED_ENABLED`. No new environment variables were added; functions are close to the 4 KB AWS Lambda environment limit.
