# `/classes` Auto-Book after Stripe — Implementation Summary

**Status:** Implemented locally (pending deploy / manual QA on tunnel or production).  
**Last updated:** 2026-07-22

**Related:** [CLASSES-BOOK-BLOCK-PHASE1.md](CLASSES-BOOK-BLOCK-PHASE1.md) (Book dialog UX), [CLASSES-BOOK-CREDITS-DIAGNOSIS.md](CLASSES-BOOK-CREDITS-DIAGNOSIS.md) (Unpaid Visits), [MINDBODY-CHECKOUT-OVERVIEW.md](MINDBODY-CHECKOUT-OVERVIEW.md) (Stripe checkout).

---

## Problem

Clients purchase from `/classes` (Express one-time or membership via `/pricing` handoff) but are **not automatically booked** into the class they selected (Laura / Linda cases). Root causes included:

- Cookie-dependent `pendingBook` path that often never sealed
- No durable `selectedClass` persisted before Stripe
- Mindbody lookup attempted at wrong lifecycle stage
- Duplicate webhook attempts and duplicate admin emails

**Policy:** Payment must **never** be blocked for book intent, validation, or auto-book failures.

---

## Approved design (in scope)

| Rule | Detail |
|------|--------|
| No seal wait | Do not `await` anonymous book intent seal before Stripe |
| No Mindbody at create-session | Only persist context; lookup + book in webhook after sync |
| Checkout always continues | Failures → admin email, not blocked checkout |
| Admin email | Resend → `SMS_ADMIN_REPORT_TO`; studio time = `America/New_York` |
| Cookie fallback | Existing sealed cookie / `pendingBook` remains temporary fallback |
| **Out of scope** | Recovery queue, admin page, cron, Slack, retry system, `drop_in_same_day` |

---

## Four focused corrections (implemented)

### 1. Membership handoff — delete only after successful create-session

**Before:** `pricing-api.js` removed `mb_pending_signup_sale_service` from `sessionStorage` on parse or before auto-click.

**After flow:**

```text
Read handoff from sessionStorage
→ validate TTL (30 min) and selected product (serviceId)
→ build subscription checkout payload (+ selectedClass)
→ POST create-session
→ receive valid Stripe Checkout URL
→ clear handoff from sessionStorage
→ redirect to Stripe
```

- **create-session failure:** handoff kept for retry; existing error UX unchanged
- **Expired / mismatched handoff:** deleted, not sent to Stripe
- **After successful redirect:** handoff cleared so an old class cannot leak into a future purchase

**Handoff payload** (from `classes-schedule.js` → `pricing-api.js`):

```json
{
  "serviceId": 12345,
  "name": "Monthly Unlimited",
  "ts": 1710000000000,
  "purchaseSource": "classes",
  "selectedClass": {
    "classId": 678,
    "classStartIso": "2026-07-22T18:00:00",
    "className": "Vinyasa Flow",
    "instructorName": "Laura",
    "selectedDayKey": "2026-07-22"
  }
}
```

### 2. Duplicate auto-book prevention (CAS)

Separate `classesAutoBook` status on **Order** (one-time) and **Subscription** (membership).

**One-time** — key: `orderId`

```json
{
  "classesAutoBook": {
    "status": "pending|processing|booked|already_enrolled|failed",
    "attemptedAt": null,
    "completedAt": null,
    "result": null,
    "reason": null
  }
}
```

Before booking: atomic `pending → processing` via `store.mutate()` (Netlify Blobs `atomicUpdateJSON`). Terminal states (`processing`, `booked`, `already_enrolled`, `failed`) block new attempts.

**Membership** — key: `subscriptionId + firstInvoiceId`

Both webhook paths call the **same function**:

- `handleInvoicePaid` (including `invoice.paid` webhook)
- Eager first-invoice sync from `handleSubscriptionCheckoutCompleted` → `handleInvoicePaid`

Shared guard: `runClassesAutoBookAfterMembershipFirstInvoiceSync` with `subStore.mutate()` — not only `initialAutoBookProcessed !== true` (parallel calls could both see `false`).

### 3. Booking status vs admin email status (separate)

```json
{
  "classesAutoBook": { "status": "failed", "result": "class_full", "completedAt": "..." },
  "bookingFailureAdminEmail": {
    "status": "not_sent|sending|sent|failed",
    "attemptedAt": null,
    "sentAt": null,
    "reason": "class_full",
    "lastError": null,
    "checkoutSessionId": "...",
    "firstInvoiceId": null
  }
}
```

**Webhook redelivery:**

- Do **not** retry booking if `classesAutoBook.status === "failed"`
- **May** retry email if `bookingFailureAdminEmail.status` is `not_sent` or `failed`
- Skip if email is `sending` or `sent`
- No admin email if booking succeeded or client already enrolled

Temporary Resend failure therefore does **not** trigger another book attempt.

### 4. Duplicate admin email prevention

Allowed email transitions only:

```text
not_sent → sending
failed   → sending
sending  → skip
sent     → skip
```

After send: `sending → sent` or `sending → failed`.

Dedup key:

- **One-time:** `orderId`
- **Membership:** `subscriptionId + firstInvoiceId`

New purchase by same client → new order / first-invoice context → fresh `not_sent`. Previous purchase record is **not** reset.

---

## End-to-end flows

### One-time Express (from `/classes`)

```text
/classes → user selects package → POST create-session
  body: purchaseSource=classes, selectedClass, pendingBook (cookie fallback)
→ Stripe Checkout
→ webhook: payment + Mindbody sync
→ runClassesAutoBookAfterMindbodySync
  → Mindbody class lookup (ET timezone)
  → attemptDeferredClassBookForOrder
  → on failure: admin email (separate CAS)
```

### Membership (from `/classes` → `/pricing`)

```text
/classes → queuePricingCheckoutAndGo(item, cls)  [handoff in sessionStorage]
→ /pricing → auto-click matching row (handoff retained)
→ membership consent → POST create-session [selectedClass in body]
→ valid URL → clear handoff → Stripe
→ webhook + Mindbody sync on first invoice (billing_reason=subscription_create)
→ runClassesAutoBookAfterMembershipFirstInvoiceSync
```

---

## Files changed

| File | Role |
|------|------|
| `netlify/functions/classes-auto-book-lib.mjs` | Core orchestration, CAS guards, redelivery, admin email |
| `netlify/functions/mindbody-studio-time.mjs` | `America/New_York` wall-time parsing |
| `netlify/functions/deferred-book-admin-email.mjs` | Resend admin alert |
| `netlify/functions/stripe-create-checkout-session.mjs` | Persist `selectedClassContext`, init status fields |
| `netlify/functions/stripe-webhook.mjs` | Wire auto-book + redelivery + sync-failure notify |
| `netlify/functions/stripe-order-store.mjs` | New fields + atomic `mutate()` |
| `netlify/functions/stripe-subscription-store.mjs` | New fields + `mutate()` (existing CAS) |
| `netlify/functions/mindbody-deferred-class-book.mjs` | ET timezone for class-past check |
| `src/js/classes-schedule.js` | `selectedClass`, `purchaseSource`, membership handoff |
| `src/js/pricing-api.js` | TTL, handoff delete after successful create-session only |
| `scripts/qa-classes-auto-book-logic.mjs` | Static + in-memory CAS QA |
| `scripts/qa-deferred-book-logic.mjs` | Updated for new webhook symbols |

---

## Store fields reference

### OrderRecord (one-time)

| Field | Purpose |
|-------|---------|
| `purchaseSource` | `"classes"` \| `"pricing"` |
| `selectedClassContext` | Class snapshot at checkout (not authoritative start time) |
| `classesAutoBook` | Booking attempt lifecycle |
| `bookingFailureAdminEmail` | Admin email dedup for this order |

### SubscriptionRecord (membership)

Same fields plus:

| Field | Purpose |
|-------|---------|
| `classesAutoBook.firstInvoiceId` | Dedup scope for membership auto-book |
| `bookingFailureAdminEmail.firstInvoiceId` | Dedup scope for membership admin email |
| `initialAutoBookProcessed` | Legacy flag; CAS on `classesAutoBook` is authoritative |

---

## QA (local, static)

```bash
node scripts/qa-classes-auto-book-logic.mjs   # 15 checks — CAS, handoff, shared membership guard
node scripts/qa-deferred-book-logic.mjs       # 36 checks — integration symbols + deferred book
```

In-memory simulations confirm:

- Parallel webhooks: only one `pending → processing` wins
- Parallel admin email: only one `not_sent → sending` wins
- New `orderId` starts fresh at `not_sent`

**Not yet run:** live tunnel/production tests (duplicate webhook, Resend failure retry, new purchase by same client).

---

## Local dev notes

- Server: `npm run dev` → `http://127.0.0.1:4321/`
- Tunnel: `ngrok http 4321` (not port 8787)
- Fixed during bring-up: duplicate `subStore` in create-session; import fixes in `classes-auto-book-lib.mjs`

---

## Manual QA checklist (before deploy)

- [ ] Express from `/classes` sends `selectedClass` + opens Stripe without seal wait
- [ ] Membership handoff survives auto-click; cleared only after valid checkout URL
- [ ] create-session failure keeps handoff for retry
- [ ] Webhook books class after Mindbody sync (ET timezone for past class)
- [ ] Duplicate webhook → single book attempt
- [ ] Booking failure → one admin email; Resend retry on redelivery does not re-book
- [ ] Second purchase by same client → new admin email allowed
- [ ] Membership renewal invoice → no book, no email
- [ ] Cookie-only fallback still works for legacy path
