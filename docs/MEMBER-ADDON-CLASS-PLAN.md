# Member Add-On Class — Implementation Plan (AMARÉ)

**Status:** Decisions locked — ready for implementation
**Last updated:** 2026-06-17
**Scope:** Allow active **Monthly 5 / Monthly 8** members who have **no usable credits left** to buy a **discounted single class** ("Member Add-On Class"), capped per calendar month.
**Related:** [`MEMBERSHIP-RECURRING-CHECKOUT.md`](./MEMBERSHIP-RECURRING-CHECKOUT.md), [`bring-a-friend-guest-pass-plan.md`](./bring-a-friend-guest-pass-plan.md), [`MINDBODY.md`](./MINDBODY.md)

---

## Locked Decisions (V1)

| Decision | Value |
|----------|-------|
| Price | **$30** fixed (regular drop-in is $40). $25 only as a future limited "Founding Members" promo. |
| Cap | **2 add-ons per calendar month** |
| Period | Calendar month, `America/New_York` |
| Expiration | **14 days** from purchase |
| Eligible memberships | **monthly_5, monthly_8 only** |
| Unlimited | **Not eligible** |
| `past_due` subscriptions | **Not eligible in V1** (active only; revisit later) |
| Credits condition | **Zero usable credits across ALL active Mindbody services** |
| Allocation storage | **Numbered slots** (`:1`, `:2`), not a counter |
| Mindbody Sell Online | **Off** (sold server-side via staff bearer) |
| UI placement (V1) | **Primary:** Class Credits card on Book-a-Class when balance = 0. **Fallback:** booking-failure dialog. **NOT** the public Pricing page or an open Profile button. |
| Legacy tier mapping | **Fail safe** — if a Mindbody-native membership can't be confidently classified as 5 vs 8, treat as **not eligible**. |

---

## TL;DR (עברית)

מנויות **Monthly 5 / Monthly 8** שניצלו את כל הקרדיטים שלהן יוכלו לקנות **שיעור בודד במחיר מנויות מוזל** ("Member Add-On Class").

- **לא** ל-Unlimited (אין לו הגבלה).
- זכאות רק כש**אין שום קרדיט זמין בכלל** (לא רק שנגמר המנוי — גם לא 10-pack/drop-in פעיל).
- מגבלה: **עד 2 בחודש קלנדרי** (אזור זמן `America/New_York`).
- תוקף הקרדיט: **14 יום** מהקנייה.
- נמכר **רק דרך האתר/אפליקציה** אחרי בדיקת זכאות בצד שרת — ב-Mindbody ה-Pricing Option יהיה **Sell Online = Off** ויימכר דרך staff bearer (כמו ה-Guest Pass).
- **לא** מגלגל, **לא** משנה את כמות הקרדיטים של המנוי עצמו.

רוב התשתית כבר קיימת: סנכרון Stripe→Mindbody, זיהוי מנוי פעיל, ו-pattern ה-allocation של ה-Guest Pass. עיקר העבודה החדשה: **שכבת הזכאות** + **התאמת מגבלת 2/חודש** (ה-Guest Pass נועל מפתח יחיד = 1; כאן צריך 2).

---

## Goal

Allow active **Monthly 5** and **Monthly 8** members who have **no usable credits remaining** to purchase a **discounted single-class add-on**, sold only through our own checkout (never Mindbody's online store), capped per calendar month.

This is positioned as a **membership perk** ("Need one more class this month?"), **not** an open discounted drop-in.

---

## Principles

| Principle | Detail |
|-----------|--------|
| **Mindbody = source of truth for credits** | Add-on is a normal `ClientService` (Pricing Option) row; booking consumes it via Mindbody, unchanged |
| **"Active member" = Stripe store OR Mindbody** | A monthly membership can originate from the new Stripe recurring path **or** the legacy Mindbody Classic contract path. Both must count (see §"Detecting an active monthly member") |
| **Server-side eligibility is mandatory** | Discounted price must never be reachable without passing the gate (no client-trusted SKU/price) |
| **Reuse, don't reinvent** | Stripe→Mindbody sync, member-summary, and the Guest Pass allocation pattern already exist |
| **No rollover, no membership mutation** | Add-on never changes the monthly allowance; expires on its own 14-day clock |
| **Perk framing** | Member-only, gated, limited — feels like a benefit, not a price leak |

---

## Business Rules

- Eligible only for **active Monthly 5** and **active Monthly 8** members (status **active** only in V1 — **`past_due` not eligible**).
- **Monthly Unlimited is NOT eligible** (no credit cap to relieve).
- Member must have **zero usable credits across all active Mindbody services** (membership + any packs/drop-ins).
- Limited to **2 add-on purchases per calendar month** (`America/New_York`).
- Add-on **expires 14 days** after purchase.
- Add-on **does not roll over**.
- Sold **only through the app/site**, after a server eligibility check.
- Mindbody Pricing Option has **Sell Online disabled**.
- Price: **$30 fixed** (regular drop-in is $40). $25 reserved for a future limited "Founding Members" promo only.

---

## Mindbody Setup (one-time, manual)

Create a new Pricing Option in Mindbody Manager:

| Field | Value |
|-------|-------|
| Name | `Member Add-On Single Class` |
| Type | Service / Class Credit |
| Visits | 1 |
| Expiration | 14 days from sale date (static — set on the Pricing Option) |
| Sell Online | **Off** |
| Eligible class types | Same as Monthly 5 / Monthly 8 cover |
| Price | $30 (the list price the cart will charge against) |

➡️ **Record the Mindbody Service ID** and pin it in the catalog config (do not rely on name-match resolution).

> **Why static 14-day expiration (not "end of billing cycle"):** Mindbody sets expiration from the Pricing Option configuration, not per-transaction. A dynamic per-sale expiration aligned to each member's renewal date is not supported cleanly via `CheckoutShoppingCart`. 14-day fixed is the simplest correct option and matches the Guest Pass `expirationMonths` pattern.

---

## Stripe Setup (one-time, manual)

Create a one-time Product/Price:

- Product: `Member Add-On Single Class`
- Type: **one-time** payment (not subscription)
- Price: $30 (or $25 promo)

The existing one-time checkout path (`stripe-create-checkout-session` → `stripe-webhook` → `syncOneTimePurchaseToMindbody`) handles the rest. No new payment plumbing needed.

---

## Catalog Config

Add a new item to `src/content/stripe-mindbody-catalog.config.json`:

```json
{
  "_note": "Member-only add-on single class. Sell Online disabled in Mindbody; sold server-side via staff bearer after eligibility check. NOT a public drop-in. Gated by addonEligibility.",
  "localSku": "member_addon_single_class",
  "displayName": "Member Add-On Class",
  "description": "One extra class at a member rate, for active Monthly 5 / Monthly 8 members who have used all their credits.",
  "amountCents": 3000,
  "currency": "usd",
  "mindbodyItemType": "Service",
  "mindbodyServiceId": 0,
  "_mindbodyServiceId_doc": "PIN the new Pricing Option id here after creating it in Mindbody.",
  "mindbodyServiceNameMatchAny": ["member add-on", "member add on", "add-on single class"],
  "mindbodyServiceNameMatchExclude": ["drop in", "monthly", "membership"],
  "enabled": false,
  "_enabled_doc": "Flip to true once Mindbody Pricing Option + Stripe Price exist and ADDON env is set.",
  "enabledForExpressCheckout": false,
  "newClientsAllowed": false,
  "oneTimePerClient": false,
  "duplicatePolicy": "allow_additional",
  "ga4SkuType": "addon",
  "kind": "memberAddon",
  "addonEligibility": {
    "eligibleMemberSkus": ["monthly_5", "monthly_8"],
    "requiresZeroUsableCredits": true,
    "allocationPerPeriod": 2,
    "periodType": "calendar_month",
    "timezone": "America/New_York",
    "expirationDays": 14
  }
}
```

`kind: "memberAddon"` is a **new** catalog kind. Wherever the catalog lib switches on `kind` (drop-in / pack / membership / newClient), add the new branch so this SKU is recognized but **never** surfaced in public pricing lists or Express Checkout.

---

## Eligibility Check (server-side, authoritative)

New endpoint, e.g. `GET /api/member/addon/eligibility` → `netlify/functions/member-addon-eligibility.mjs`.

Returns `{ eligible: boolean, reason, remainingThisPeriod, priceCents }`.

The server MUST verify, in order:

1. **Authenticated** member (existing OAuth session → resolve Mindbody `clientId`).
2. **Active monthly_5 / monthly_8 membership** — detected from **either** source (see §"Detecting an active monthly member" below). **Reject `monthly_unlimited`.**
3. **Zero usable credits** — call `mindbody-member-summary` logic and confirm **no active, non-expired `ClientService` with `Remaining > 0`** across ALL services (membership, packs, drop-ins). Treat `Remaining >= 999999` (unlimited sentinel) as "has credits" → not eligible.
4. **Under the monthly cap** — usage count for the current `calendarMonthPeriodKey` is `< 2`.

The **same** function is re-run server-side at **Checkout Session creation** (`stripe-create-checkout-session.mjs`) so the discounted SKU cannot be purchased by tampering with the client. Never trust the browser for SKU/price/eligibility.

### Detecting an active monthly member (BOTH paths)

A Monthly 5 / Monthly 8 membership can originate from two flows in this codebase, and **both** must make a member eligible:

| Source | How it was bought | How we detect it |
|--------|-------------------|------------------|
| **Stripe recurring (new)** | Stripe Subscription → `invoice.paid` sync (service IDs 100133 / 100134) | `openSubscriptionStore().listActiveByMindbodyClientId(clientId)` → record with `status === "active"` (V1: **exclude `past_due`**) and `localSku ∈ {monthly_5, monthly_8}` |
| **Mindbody Classic (legacy)** | `/sale/purchasecontract` (display service IDs 100129 / 100130 / 100056) | Mindbody `GET /client/activeclientmemberships` (already fetched by `mindbody-member-summary`) and/or `ClientServices` name-match, mapped to a tier via `mb-contract-terms.config.json` (`byCheckoutServiceId`) |

Eligibility step 2 passes if **either** source confirms an active **monthly_5 / monthly_8** membership. Unlimited (Stripe `monthly_unlimited` or legacy `100056`) is excluded in both.

> ⚠️ **Do NOT gate solely on the Stripe subscription store.** Members on the legacy Mindbody contract have no `SubscriptionRecord` and would be wrongly rejected. The Mindbody `activeclientmemberships` check is what covers them. (For the tier mapping, reuse the same `mb-contract-terms.config.json` lookup that `mindbody-member-summary` already uses to overlay membership rows.)

> **Ambiguity to resolve:** `activeclientmemberships` may not always cleanly distinguish a "5" vs "8" tier by name alone. Decide whether to map strictly by membership/contract id (preferred) or fall back to a ClientService name-match. If a member's monthly tier cannot be confidently classified as 5 or 8, default to **not eligible** (fail safe) rather than guess.

> **Edge case — member also holds a pack:** If a Monthly 5 member also has an active 10-pack with credits, she is **NOT** eligible (step 4 fails). She has something to book with; the add-on must not undercut a pack she already bought at full price.

> **Edge case — past_due (V1 decision: NOT eligible):** If a member's monthly payment is failing, we do not extend a discounted perk. They can still pay full price (drop-in / pack). Revisit after launch if this blocks too many legitimate members mid-retry.

---

## Usage Tracking (the 2-per-month cap)

Reuse the **Guest Pass allocation pattern** (`guest-pass-lib.mjs` + `guest-pass-blobs.mjs`): calendar-month period key, atomic reserve → commit → fail, concurrency-safe writes via `atomicCreateJSON` / `atomicUpdateJSON`, Netlify Blobs backing.

**New, separate namespace** (do not mix with guest-pass keys):

```
memberAddonUsage:{memberClientId}:{periodKey}:{slot}
```

⚠️ **Key difference from Guest Pass — this is the main new logic:**
The Guest Pass enforces allocation = **1** by locking a **single** key per period (`atomicCreateJSON` on `guestPassUsage:{clientId}:{periodKey}` — second attempt fails). For an allocation of **2**, a single key won't work. Two safe options:

- **Option A — numbered slots (recommended):** try `:1`, then `:2`. Each slot is an `atomicCreateJSON` lock. Reserve the first slot that succeeds; if both already exist → cap reached. Simple, no read-modify-write race.
- **Option B — counter with CAS:** a single `{ count }` record updated via `atomicUpdateJSON`, rejecting when `count >= allocationPerPeriod`. Slightly more compact but needs careful CAS handling.

Lifecycle per purchase:
1. **Reserve** a slot (status `pending`, short TTL) before creating the Stripe Checkout Session.
2. On Stripe success + Mindbody sync success → **commit** (status `confirmed`).
3. On failure / abandoned checkout / TTL expiry → **release** the reservation so the slot frees up.

---

## Checkout Flow

**Entry point (primary):** the Class Credits card shows the add-on CTA as soon as the balance reaches 0 and the eligibility endpoint returns `eligible: true` — proactively, before any booking error.
**Entry point (fallback):** the booking-failure dialog, when Mindbody returns "no available payments" (existing behavior in `mindbody-class-book.mjs`).

1. Book-a-Class loads → existing wallet/member-summary shows the balance. When it reads 0 for a monthly member, the UI calls the **eligibility endpoint**.
2. If **eligible**, show the **"Add 1 class — $30"** CTA in the credits card (and in the booking-failure dialog if reached that way).
3. Member confirms → server **reserves a slot** → creates a **one-time Stripe Checkout Session** for `member_addon_single_class` (server re-checks the full eligibility gate here — never trust the client).
4. `stripe-webhook` → `syncOneTimePurchaseToMindbody` sells the pinned Pricing Option via **staff bearer** (Sell-Online bypass), granting a 1-visit, 14-day `ClientService`.
5. On sync success → **commit** the usage slot.
6. Member books the class; Mindbody auto-selects the new credit (existing `listActiveClientServiceIds` picks the active 1-visit service).

### After a successful purchase (return UX)

On Stripe success, redirect the member **back to Book-a-Class** (not a generic receipt page) with a transient message and force a wallet/member-summary refresh:

> **Your member add-on class is being added. Refreshing your credits…**

- Re-fetch `mindbody-member-summary` / wallet. If the new 1-visit credit appears → the credits card flips to a bookable state and the member books immediately.
- If it has **not** appeared yet (sync lag or failure), fall back to the locked message:
  > **Payment received. We're adding your class credit now. If it doesn't appear shortly, please contact support.**
- Mindbody consumer-API lag is already handled by the staff/consumer merge in `mindbody-member-summary` — a short poll/refresh is usually enough.

### Stripe success but Mindbody sync failure

Reuse the existing failure posture from the one-time order flow:
- Order is marked `paid_but_not_synced` (existing `stripe-order-store` + admin retry via `stripe-admin-orders.mjs`).
- The reserved usage slot is marked **failed / released** so it does not permanently consume one of the member's 2 monthly add-ons.
- **Never** tell the member the credit was added when the sync failed. Use exactly this tone:
  > **Payment received. We're adding your class credit now. If it doesn't appear shortly, please contact support.**
- Admin must clearly see the order in `paid_but_not_synced` state (existing admin orders view) for a quick manual retry.

---

## UI

The CTA is shown **only when the eligibility endpoint returns `eligible: true`**. V1 has **two placements** (no public Pricing page, no open Profile button):

### Primary placement — the Class Credits card (Book-a-Class)

The Book-a-Class screen already shows a **Class Credits** card with the remaining balance (e.g. "AMARÉ Monthly 5 Classes — 5 of 5 visits left"). This is the most natural place: surface the add-on **the moment the balance hits 0**, *before* the member ever hits a booking error. It reads as good service, not as an error.

Render an "add-on" block **inside / directly below** the Class Credits card, **above** the Bring-a-Friend card (hierarchy: Credits → Add-on → Bring-a-Friend).

**State-by-state UX (credits card).** The copy uses `remainingThisPeriod` from the eligibility endpoint so the member sees exactly how many add-ons she has left:

| Member state | Card shows | Add-on CTA |
|--------------|-----------|------------|
| Has credits (e.g. 3 of 5) | `3 of 5 visits left` | none |
| 1 credit left | `Last class credit available this month` (optional soft note) | none |
| **0 credits, eligible, `remainingThisPeriod` = 2** | `You've used all 5 classes this month. You can add up to 2 extra classes this month.` | **`Add 1 class — $30`** + small print: *Valid for 14 days. Resets monthly.* |
| **0 credits, eligible, `remainingThisPeriod` = 1** | `You have 1 add-on class left this month.` | **`Add 1 class — $30`** + small print |
| 0 credits, already used 2 add-ons (`remainingThisPeriod` = 0) | `You've used your 2 add-on classes this month. Add-ons reset on the 1st.` | none |
| 0 monthly credits **but** has an active 10-pack / drop-in | show the other usable credits; **no** add-on CTA (she has something to book with) | none |
| Unlimited member | normal unlimited display | none |

> The CTA label is always **`Add 1 class — $30`** (never "Buy credit" / "Discounted drop-in" — those read like a separate product; "Add 1 class" frames it as a membership action).

Suggested "needs one more" block (the precedent layout is the existing Bring-a-Friend card; the count line is driven by `remainingThisPeriod`):

> **NEED ONE MORE CLASS?**
> You've used all your monthly classes. You can add up to {remainingThisPeriod} extra classes this month.
> *Add 1 class — $30* · Valid for 14 days. Resets monthly.

### Frontend gating contract (important)

The CTA visibility is **NOT** decided by the balance display alone. The rule is:

1. Balance for the monthly membership reads **0** → the frontend **calls the eligibility endpoint**.
2. Render the add-on block **only if** the endpoint returns `eligible: true`.
3. Use `remainingThisPeriod` from the response for the count copy and to hide the CTA when it's `0`.

> A member can show "0 of 5" on the membership row yet still hold an active 10-pack — in that case the endpoint returns `eligible: false` (step 3 of the eligibility gate) and **no CTA is shown**. Never infer eligibility from "0 of N" on the client.

### Fallback placement — booking-failure dialog

Keep the CTA in the booking-failure path too (web: `src/js/classes-schedule.js`; app: `BookClassDialog.tsx` / `ScheduleScreen.tsx`), in case the member didn't notice the card and just tapped **Book**. Instead of a dry error:

> **You're out of class credits.**
> As a member, you can add 1 extra class for $30.
> *Add 1 class*

### Not in V1

- ❌ Public **Pricing & Membership** page — would "teach" all members a permanent way to bypass upgrading (hurts Monthly 5→8 / →Unlimited upgrades).
- ❌ An always-on Profile button — same reason. The add-on appears **only** in the 0-credits, eligible state.

---

## What we will NOT do

- ❌ Expose this as an open Pricing Option / public drop-in on the site.
- ❌ Offer it to non-members or to Unlimited members.
- ❌ Allow unlimited purchases (hard cap of 2/calendar-month).
- ❌ Change the membership's own monthly credit count.
- ❌ Roll unused add-on credits into the next period.

---

## Edge Cases

| Case | Behavior |
|------|----------|
| Member also has an active 10/20-pack with credits | **Not eligible** (has usable credits) |
| Member has a drop-in credit | **Not eligible** |
| Unlimited member | **Not eligible** |
| Monthly member (Stripe path), 0 credits, under cap | **Eligible** |
| Monthly member (legacy Mindbody contract), 0 credits, under cap | **Eligible** (detected via `activeclientmemberships`, not Stripe store) |
| Monthly tier can't be confidently classified as 5 or 8 | **Not eligible** (fail safe) |
| Already used 2 this calendar month | **Not eligible** until the 1st |
| Stripe paid but Mindbody sync failed | Order `paid_but_not_synced`; slot released; admin retry; "we're adding it now" message (never claim success) |
| Double-click / duplicate checkout | Prevented by reserve/commit slot locks |
| Member abandons Stripe Checkout | Reservation TTL expires → slot freed |
| `past_due` subscription | **Not eligible in V1** (active only) |
| Late-cancel the add-on class | Mindbody policy applies (credit may be forfeited), same as any class |

---

## Implementation Checklist

**Mindbody / Stripe (manual, prerequisites):**
- [ ] Create Mindbody Pricing Option (1 visit, 14-day, Sell Online off); record Service ID.
- [ ] Create Stripe one-time Price ($30).

**Config:**
- [ ] Add `member_addon_single_class` item to `stripe-mindbody-catalog.config.json` with pinned `mindbodyServiceId` + `addonEligibility`.
- [ ] Add `kind: "memberAddon"` handling to the catalog lib (recognized, never public).
- [ ] Add an enable flag (e.g. `ENABLE_MEMBER_ADDON=1`) so it ships dark.

**Backend:**
- [ ] `member-addon-eligibility.mjs` — the gate (reuses subscription store **and** Mindbody `activeclientmemberships` + `mb-contract-terms` tier mapping; covers BOTH membership origins).
- [ ] Usage-tracking lib (new namespace, 2-slot allocation) — adapt Guest Pass reserve/commit/fail.
- [ ] Wire eligibility re-check + slot reserve into `stripe-create-checkout-session.mjs`.
- [ ] Wire slot commit on `syncOneTimePurchaseToMindbody` success; release on failure/abandon.

**Frontend:**
- [ ] **Primary:** add-on block in the Class Credits card (Book-a-Class), state-by-state per the UI table. Gating contract: balance = 0 → call eligibility endpoint → render **only if** `eligible: true` (never infer from "0 of N").
- [ ] Use `remainingThisPeriod` for the count copy ("up to 2" / "1 left") and hide the CTA when it's `0`.
- [ ] CTA label fixed as **`Add 1 class — $30`**.
- [ ] **Fallback:** CTA in the booking-failure dialog (web + app), gated on eligibility response.
- [ ] **Post-purchase:** redirect to Book-a-Class, show "being added… refreshing credits", re-fetch member-summary/wallet; on lag/failure show the locked support message.
- [ ] Do **not** add to public Pricing page or as an always-on Profile button.

**Tests:**
- [ ] Eligibility matrix (each edge case above), incl. legacy Mindbody-contract member.
- [ ] Cap enforcement + concurrency (two simultaneous purchases → only 2 succeed/period).
- [ ] Stripe-success/Mindbody-fail releases the slot and shows the "adding it now" message.

---

## Open Decisions

> ✅ **All V1 decisions are locked — see the "Locked Decisions (V1)" table at the top.** Items below are explicitly deferred to a later version.

- **Price experiment:** $25 "Founding Members" promo (deferred; launch at $30 first).
- **Cap of 3/month** (deferred; launch at 2).
- **`past_due` eligibility** (deferred; revisit if it blocks too many legitimate members).
- **Profile / Membership surface** (deferred; V1 is credits-card + booking-failure only).

### One implementation detail still to confirm (not a blocker)

**Legacy-tier mapping:** how to classify a Mindbody-native membership as 5 vs 8 — by contract/membership id (preferred) vs `ClientService` name-match. This depends on what `activeclientmemberships` returns for your site. Already covered by the **fail-safe rule** (ambiguous → not eligible), so it does not block starting implementation.
