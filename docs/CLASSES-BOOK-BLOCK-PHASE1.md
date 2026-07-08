# `/classes` Book-block UX — Phase 1 plan & implementation

**Scope:** `/classes` Book dialog only (`src/js/classes-schedule.js`).  
**Out of scope (Phase 1):** Stripe checkout, `pricing-api.js`, backend `mindbody-class-book` guard.

**Related:** [MINDBODY-CONSUMER-STUDIO-LINK-DIAGNOSIS.md](MINDBODY-CONSUMER-STUDIO-LINK-DIAGNOSIS.md) (association flags, support playbook), [MINDBODY-CHECKOUT-OVERVIEW.md](MINDBODY-CHECKOUT-OVERVIEW.md) (anonymous `/pricing` path).

**Last updated:** 2026-06-24 (manual QA: snir26 / snir30 added)

---

## Problem (production incidents)

New Mindbody-global users hit **three separate gaps**, not one:

| Layer | Meaning | Example |
|-------|---------|---------|
| Studio Client | AMARÉ row in Mindbody (`clientId`) | OAuth `addclient` fails without `MobileNumber` |
| Credits | Active package / membership visits | Non-Member, empty wallet |
| Consumer association | OAuth token linked to studio (`bookingAllowed`) | `probeConsumerStudioAssociation` → 401, `not_associated` |

**VLADA:** OAuth without phone → `no_studio_client` → manual client → `not_associated` → Book blocked; “Contact studio” as primary CTA.

**Ayden (`aydenbuchwald@gmail.com`, client `100003087`):** Client + phone created ~1 min after first OAuth; stayed `not_associated`, **no Stripe checkout in logs**, Non-Member — stuck before purchase because UX did not route to Pricing.

**Key insight:** `not_associated` ≠ “buy again”. For **new** clients with **no credits**, primary CTA must be **View Packages**, not Contact studio.

---

## Before Phase 1 (old behavior)

### Book blocked on `!oauthBookingAllowed` only

Any signed-in user with `bookingAllowed === false` saw one generic modal — regardless of `linkStatus`, credits, or missing client:

```javascript
// src/js/classes-schedule.js (removed in Phase 1)
if (oauthLoggedIn && !oauthBookingAllowed) {
  bookDlgTitle.textContent = "Account not linked yet"; // or ambiguous / apple titles
  hint.textContent = STUDIO_NOT_LINKED_MSG; // → "Please contact us…"
  appendStudioNotLinkedCtas(bookDlgActions); // Contact studio + Sign out
  bookDlg.showModal();
  return;
}
```

`STUDIO_NOT_LINKED_MSG`:

```text
Your Mindbody account is connected, but it is not fully linked to AMARÉ yet.
Please contact us and we can connect your account or book the class for you.
```

### Phone form only in auth strip

`complete-studio-profile` existed on the **top auth bar** (`mindbody-auth.js`), not in the Book dialog:

```javascript
// src/js/mindbody-auth.js — still used in strip; Phase 1 adds Book modal too
fetch("/api/mindbody/oauth/complete-studio-profile", {
  method: "POST",
  body: JSON.stringify({ mobilePhone: phone }),
});
```

Easy to miss when user goes straight to **Book**.

### `/pricing` vs `/classes`

| | `/classes` (before) | `/pricing` |
|--|---------------------|------------|
| Checks `bookingAllowed` | Yes — blocks Book | No |
| Collects phone (anonymous) | No | Yes — Express dialog |
| Creates client on purchase | Only via OAuth / complete-profile | Webhook + Stripe phone |

---

## Target design (agreed spec)

### Decision order (canonical — Phase 1 shipped; step 2 superseded by Phase 1.2)

```text
1. !signed in              → existing Sign in modal
2. oauthBookingAllowed     → [Phase 1 only] Confirm booking — TOO PERMISSIVE; see Phase 1.2
3. ambiguous / apple     → Contact studio (unchanged copy)
4. no_studio_client        → Complete profile + phone → View Packages
5. wallet loading          → "Checking your AMARÉ credits…" (modal shown immediately; then wait up to ~5s)
6. wallet error/unknown    → "We couldn't confirm your AMARÉ package yet" + View Packages
7. client + !hasCredits    → Purchase a package first + View Packages
8. client + credits + !associated → Link Mindbody + refresh
9. else                    → Contact studio (ambiguous fallback)
```

**Phase 1.2 replaces step 2** — see [Phase 1.2 clarification](#phase-12-clarification--bookingallowed-is-not-enough) below.

### Anti-patterns (do not ship)

```javascript
// Wrong — sends new clients to Contact studio
if (!oauthBookingAllowed) showContactStudio();
if (oauthLinkStatus === "not_associated") showContactStudio();
```

### State → modal matrix

| State | Title | Primary CTA | Secondary CTA |
|-------|-------|-------------|---------------|
| `no_studio_client` / no client | Complete your AMARÉ profile | Continue (phone) → View Packages | Already purchased? Contact us |
| Client, no credits | Purchase a package first | View Packages | Already purchased? Contact us |
| Client, credits, `not_associated` | Link your Mindbody account | I've linked my account — refresh | Contact studio |
| `ambiguous_studio_client` / Apple relay | (existing titles) | Contact studio | Sign out |

### Credit detection

**Shared helper (implemented):** `src/js/mindbody-wallet-widget.js`

```javascript
function walletSummaryHasBookableCredits(sumPayload) {
  const vm = scheduleWalletViewModel(sumPayload);
  return vm.kind === "packs" || vm.kind === "membership";
}
globalThis.mbWalletSummaryHasBookableCredits = walletSummaryHasBookableCredits;
```

Book flow calls this via `walletHasBookableCredits()` in `classes-schedule.js` — no duplicate credit logic.

### Client-side state (from existing APIs)

```javascript
// classes-schedule.js — populated from GET /api/mindbody/oauth/session + member summary
let oauthLinkStatus = "";           // ready | not_associated | no_studio_client | …
let oauthClientExists = false;
let oauthConsumerAssociated = false;
let oauthBookingAllowed = true;
let walletLoadState = "idle";       // idle | loading | ok | error
let lastMemberSummaryPayload = null;
```

Session API shape (`mindbody-oauth-session.mjs`):

```javascript
{
  clientId, clientExists, consumerAssociated,
  bookingAllowed, linkStatus
}
```

### Logging (browser console, JSON)

Events to grep in support / replay:

| Event | When |
|-------|------|
| `book_block_variant` | Book clicked; includes variant + flags |
| `completeProfileShown` | Complete profile modal opened |
| `completeProfileSuccess` | `complete-studio-profile` OK |
| `book_block_cta` | CTA click; `selectedCTA`: `continue`, `view_packages`, `link_refresh`, … |

Fields: `linkStatus`, `clientExists`, `hasPhone`, `walletLoadState` (or `walletLoaded`), `hasActiveCredits`, `consumerAssociated`, `selectedCTA`.

---

## Phase 1 — implemented (2026-06-24, refined)

**Files:** `src/js/classes-schedule.js`, `src/js/mindbody-wallet-widget.js`

### Entry point

Book flow delegates logged-in users to `openLoggedInBookFlow`:

1. **`oauthBookingAllowed === true`** → skip all block modals → `openConfirmBookDialog` / booking API.
2. Else → `resolveBookBlockVariantAsync` → `showBookBlockModal` or legacy alert.

> **Known gap (Manual QA snir26/snir30):** Step 1 treats `bookingAllowed` as “may book” but it only means **Consumer ↔ studio client associated** — not “has credits”. Phase 1.2 removes this blanket bypass when wallet confirms zero credits.

```javascript
async function openLoggedInBookFlow(cls, cid, fallbackWidget) {
  if (oauthBookingAllowed === true) {
    // Confirm booking — do not block on stale/empty wallet
    openConfirmBookDialog(cls, cid);
    return;
  }
  let variant = await resolveBookBlockVariantAsync();
  if (variant === "wallet_checking") {
    showBookBlockModal(cls, "wallet_checking");
    await ensureMemberSummaryForBookBlock();
    variant = await resolveBookBlockVariantAsync();
  }
  if (variant) showBookBlockModal(cls, variant);
}
```

### Variant resolution (canonical order)

```javascript
async function resolveBookBlockVariantAsync() {
  if (ambiguous / apple relay) return "ambiguous";
  if (no_studio_client || !oauthClientExists) return "complete_profile";
  await ensureMemberSummaryForBookBlock();
  if (wallet loading/idle) return "wallet_checking";
  if (wallet error) return "wallet_unknown";
  if (!walletHasBookableCredits(payload)) return "purchase_first";
  if (!associated / not_associated / !bookingAllowed) return "link_mindbody";
  return "ambiguous"; // fallback → Contact studio
}
```

### Modals

| Variant | UI |
|---------|-----|
| `complete_profile` | Phone form → refresh session + summary → success + inline packages catalog |
| `wallet_checking` | “Checking your AMARÉ credits…” |
| `wallet_unknown` | Couldn’t confirm package + inline packages catalog + Buy + Already purchased? |
| `purchase_first` | Inline packages catalog + Buy + Already purchased? |
| `link_mindbody` | Refresh link + Contact studio |
| `ambiguous` | Contact studio + Sign out |

### Logging

```javascript
function logBookBlockEvent(event, extra) {
  console.log(JSON.stringify({
    event,
    linkStatus, clientExists, hasPhone,
    walletLoadState, hasActiveCredits, consumerAssociated,
    book_block_variant, selectedCTA,
    completeProfileShown, completeProfileSuccess,
    ...extra,
  }));
}
```

---

## Gaps vs canonical spec

All Phase 1.1 items addressed:

| Spec item | Status |
|-----------|--------|
| **`oauthBookingAllowed === true` first** | ✅ Bypasses block modals |
| **Wallet loading UI** | ✅ `wallet_checking` modal + 5s wait |
| **Wallet error fallback** | ✅ `wallet_unknown` + View Packages |
| **Shared wallet helper** | ✅ `mbWalletSummaryHasBookableCredits` |
| **Session + summary refresh after phone** | ✅ `refreshOAuthSessionForBookBlock` + `refreshMemberSummaryForBookBlock` |
| **Log field `walletLoadState`** | ✅ Replaces `walletLoaded` boolean |

---

## QA scenarios (Book-block)

| ID | Setup | Expected modal |
|----|--------|----------------|
| **N1** | New OAuth, `no_studio_client`, no phone | Complete profile → Continue → View Packages |
| **N2** | Ayden-like: client `100003087`, `not_associated`, 0 credits | Purchase first → View Packages (not Contact) |
| **N3** | Credits on account, `not_associated` | Link Mindbody → refresh |
| **N4** | `bookingAllowed: true`, any wallet state | Confirm booking immediately (API handles no credits) — **see Phase 1.2**: too permissive; allows unpaid booking in production |
| **N5** | `ambiguous_studio_client` | Contact studio |
| **N6** | Book click while wallet still loading | “Checking your AMARÉ credits…” then resolves |
| **N7** | Wallet fetch fails | “We couldn’t confirm your AMARÉ package yet” + View Packages |

**Automated (mocked APIs, no live Mindbody):**

```bash
node scripts/qa-book-block-logic.mjs      # decision-tree unit checks
node scripts/smoke-book-block-browser.mjs   # Playwright: N2, N4, N6 (+ bookingAllowed bypass)
```

Browser smoke mocks `/oauth/session`, `/class/classes` (guaranteed upcoming class), and `/member/summary`. Book button: `getByRole("button", { name: /^Book$/i })` or `data-testid="class-book-button"`.

---

## Manual QA findings — credits & unpaid booking (2026-06-24)

Phase 1 UX works for **routing** (Ayden-like → Purchase first, complete profile, etc.), but **manual tests on ngrok + production** exposed a separate problem: **Book succeeds without credits** and creates **Unpaid Visits** in Mindbody. This is **not fixed by Phase 1** (backend + `bookingAllowed` bypass).

### Two different “no credits” UX paths (do not confuse)

| Path | When | What the user sees | Still in code? |
|------|------|--------------------|----------------|
| **A. Pre-Confirm block** | User taps **Book** before Confirm | `purchase_first` / `wallet_unknown` → inline catalog + Buy (`appendInlinePackagesCatalog`) | Yes |
| **B. Post-Confirm packages** | User taps **Confirm booking**, API **fails** | “Packages & memberships · buy online” + Buy buttons (`hydrateBookingFailPackages`) | Yes — only if API returns failure + `suggestPackages` |

What many members remember is **B** (in-dialog packages after a failed Confirm). That flow is **still implemented** in `openConfirmBookDialog` when `result.suggestPackages === true` (e.g. Mindbody `"no available payments"`).

**Why B often does not appear now:** the booking API **succeeds** via staff fallback → `ok: true` → “You’re booked” — no failure, no package embed.

### Incident: snir30 (`snir30@pic-smart.com`, client `100003102`)

**Setup:** Brand-new Mindbody-global test user; **never entered a phone** at signup or on site.

**Observed:**

| Step | Result |
|------|--------|
| OAuth | Client auto-created (`MINDBODY_OAUTH_ENSURE_STUDIO_CLIENT=1`, `addclient` without `MobilePhone`) |
| Session | `clientExists: true`, `linkStatus: ready`, `bookingAllowed: true`, `consumerAssociated: true` |
| Complete profile modal | **Did not show** (requires `no_studio_client` / `!clientExists`) |
| Mindbody admin | Client row exists; **Mobile phone empty** (required field warning) |
| Wallet | “No class packages with visits left” |
| Book | Confirm booking → **success** without credits |
| Mindbody | **Unpaid Visit** (not paid from a package) |

**Browser log:**

```json
{
  "event": "book_block_variant",
  "book_block_variant": "none",
  "linkStatus": "ready",
  "clientExists": true,
  "hasPhone": true,
  "walletLoadState": "ok",
  "hasActiveCredits": false,
  "consumerAssociated": true,
  "bookingAllowedBypass": true
}
```

**Note:** `hasPhone: true` is **misleading** — frontend logs `hasPhone: oauthClientExists ? true : …` (not a real phone check).

**Server log:** `class_book_staff_payment_fallback_start` with `serviceIds: []` → `tryBookWith(staffHeaders, undefined)` → `ok: true`.

### Incident: snir26 (`snir26@pic-smart.com`)

**Setup:** Older test client; **no packages** initially; staff added **1 complimentary class** manually in Mindbody (`1 complimentary class`, Comp/Guest).

**Observed:**

| Booking | Credits before | API | Mindbody result |
|---------|----------------|-----|-----------------|
| **1st** | 1 remaining | Consumer or staff fallback **with** `ClientServiceId` | Visit paid from comp class → **Remaining 0 / 1** (inactive) |
| **2nd** | **0** remaining | Consumer fails → staff fallback with **empty** `serviceIds` → staff book **without** service | **Unpaid Group Classes** on Account Details |

**Expected for 2nd Book:** Pre-Confirm block (Purchase first) **or** Confirm failure → in-dialog packages (**B**).  
**Actual:** Confirm → “You’re booked” again; Mindbody shows **Unpaid Visits** (visit date 06/24/2026, service category Unpaid Group Classes).

This reproduces on **production** as well as local/ngrok — not a tunnel-only bug.

### Root causes (three layers)

```text
1. OAuth callback
   MINDBODY_OAUTH_ENSURE_STUDIO_CLIENT=1 can create/link client without phone
   → ready + bookingAllowed:true → Complete profile never runs

2. Frontend (Phase 1 as shipped)
   oauthBookingAllowed === true → skip ALL pre-Confirm blocks (including purchase_first)
   even when wallet shows hasActiveCredits: false

3. Backend mindbody-class-book.mjs
   After consumer "no available payments", staff payment fallback runs.
   If no active ClientService ids, code still calls:
     tryBookWith(staffHeaders, undefined)
   → Mindbody accepts booking as UNPAID (staff token), returns ok:true
   → Post-Confirm package UI (suggestPackages) never triggers
```

Relevant backend snippet:

```javascript
// netlify/functions/mindbody-class-book.mjs (current — problematic)
if (!r.ok && isPaymentRequiredError(summary)) {
  // … try staff with each active ClientServiceId …
  if (!r.ok) {
    r = await tryBookWith(staffHeaders, clientServiceId ?? undefined); // unpaid when no service
  }
}
```

### What Phase 1 did **not** change

| Area | Phase 1 status |
|------|----------------|
| `mindbody-class-book.mjs` staff unpaid fallback | **Unchanged** (explicitly out of scope) |
| Block Book when wallet = 0 and `bookingAllowed: true` | **Intentionally allowed** (API “source of truth”) — too permissive in practice |
| OAuth auto-create without phone | **Unchanged** |
| Post-Confirm `hydrateBookingFailPackages` | **Unchanged** — still works when API **fails** |

### Phase 1.2 — recommended fix (before production deploy)

**Priority order:**

1. **Backend (required):** Do **not** call `tryBookWith(staffHeaders, undefined)` when there are no active client services. Return `4xx` with a message that maps to `suggestPackages` on the frontend (restores **B** — in-dialog packages).
2. **Frontend:** When `walletLoadState === ok` and `!hasActiveCredits`, show **Purchase first** (or packages embed) **even if** `bookingAllowed === true`. Narrow `bookingAllowedBypass` to “wallet stale / loading only”, not “zero credits confirmed”.
3. **OAuth (optional but recommended):** Do not treat auto-created clients without `MobilePhone` as `ready` for Book; surface **Complete profile** or `needs_phone` until phone is collected.
4. **Logging:** Fix `hasPhone` to reflect session/Mindbody phone, not `clientExists`.

**QA after 1.2:**

| ID | Setup | Expected |
|----|--------|----------|
| **C1** | snir26-like: 1 credit, book twice | 1st OK; 2nd → Purchase first or package dialog — **no** Unpaid Visit |
| **C2** | snir30-like: new OAuth, no phone, 0 credits | Complete profile **or** Purchase first — **no** Unpaid Visit |
| **C3** | Linked member, credits exhausted mid-session | Wallet shows 0 → next Book blocked before Confirm |

---

## Files touched

| File | Phase 1 |
|------|---------|
| `src/js/classes-schedule.js` | Book-block state machine, modals, logs |
| `src/js/mindbody-auth.js` | Unchanged (strip phone form remains) |
| `src/js/mindbody-wallet-widget.js` | `mbWalletSummaryHasBookableCredits` export |
| `netlify/functions/mindbody-class-book.mjs` | Unchanged — 403 `studio_not_linked` guard kept |

---

## Phase 1.2 (approved spec — not implemented)

See **Manual QA findings** above (snir26, snir30).

### Phase 1.2 clarification — `bookingAllowed` is not enough

Manual QA proved that `bookingAllowed === true` only confirms that the Mindbody Consumer is **associated** with the AMARÉ studio client. It does **not** confirm that the client has active credits, a package, or a membership.

Therefore the Phase 1 rule:

```text
oauthBookingAllowed === true → Confirm booking immediately
```

is **too permissive** and is **superseded** by Phase 1.2.

#### What `bookingAllowed` means vs what it does not

| | `bookingAllowed: true` | Wallet `hasActiveCredits` |
|--|------------------------|---------------------------|
| **Means** | OAuth linked to studio client (`consumerAssociated` / probe OK) | Active pack or membership with visits |
| **Does not mean** | Has package / can consume a visit | Mindbody association status |

#### Updated frontend decision (Phase 1.2)

After steps 1 (signed in) and association/profile gates (ambiguous, complete profile, link Mindbody), **when `bookingAllowed === true`**:

```text
bookingAllowed === true + walletLoadState loading/idle
→ wallet_checking (then re-resolve)

bookingAllowed === true + walletLoadState error
→ wallet_unknown + View Packages

bookingAllowed === true + walletLoadState ok + hasActiveCredits === false
→ Purchase first / View Packages

bookingAllowed === true + walletLoadState ok + hasActiveCredits === true
→ Confirm booking
```

When `bookingAllowed === false`, keep Phase 1 order (complete profile, purchase first, link Mindbody, etc.) — unchanged.

**Remove:** unconditional early exit in `openLoggedInBookFlow` that skips variant resolution whenever `oauthBookingAllowed === true`.

#### Backend guard (required — not optional)

The frontend must not be the only guard. Even with correct Phase 1.2 UX, **`mindbody-class-book.mjs`** must:

- Reject bookings when the client has **no active bookable ClientService** (no visits left).
- **Not** call `tryBookWith(staffHeaders, undefined)` to create **Unpaid Visits**.
- Return a payment-required error that the frontend maps to **`suggestPackages`** (in-dialog packages after Confirm, as a second line of defense).

Defense in depth: **Purchase first before Confirm** (frontend) + **no unpaid staff fallback** (backend) + **suggestPackages on failure** (existing post-Confirm UI).

#### Implementation checklist

| Area | Change |
|------|--------|
| `classes-schedule.js` | Drop blanket `bookingAllowed` bypass; run wallet/credit checks for linked members |
| `mindbody-class-book.mjs` | No staff book-without-service; fail with suggestPackages-friendly message |
| OAuth (recommended) | Phone / complete profile when client exists but mobile missing |
| Logging | Real `hasPhone`; log when `purchase_first` blocks despite `bookingAllowed: true` |

#### QA after 1.2

| ID | Setup | Expected |
|----|--------|----------|
| **C1** | snir26-like: 1 credit, book twice | 1st OK; 2nd → Purchase first — **no** Unpaid Visit |
| **C2** | snir30-like: new OAuth, no phone, 0 credits | Complete profile **or** Purchase first — **no** Unpaid Visit |
| **C3** | Linked member, credits exhausted mid-session | Wallet 0 → next Book → Purchase first before Confirm |
| **C4** | Direct API, no credits | 402 `no_bookable_credits` + `suggestPackages: true` — **no** Unpaid Visit |
| **C5** | `bookingAllowed=true` + active credits | Confirm booking → book succeeds |

**Automated:** `node scripts/qa-book-block-logic.mjs`, `node scripts/qa-phase-12-book-credits.mjs`, `node scripts/smoke-book-block-browser.mjs` (after `npm run build`).

**Phase 1.2 implemented** — credits/entitlement gate on frontend + backend; `bookingAllowed` no longer bypasses zero-credit wallet.

**Open — monthly membership unpaid booking:** see [`CLASSES-BOOK-CREDITS-DIAGNOSIS.md`](CLASSES-BOOK-CREDITS-DIAGNOSIS.md) (snir5: staff fallback returns 200 but Unpaid Visit; wallet stays 5/5).

---

## Phase 2

### 2.1 OAuth — no studio client without phone ✅

**Implemented:** `ensureStudioClientForOAuthProfile` refuses `addclient` when OAuth claims have no valid US mobile. Session stays `no_studio_client` → `/classes` Book shows **Complete profile** (phone) before purchase.

**Also:** If Mindbody resolves an existing client (via `tryResolveClientId`) but **MobilePhone is empty**, session is treated as incomplete (`linkStatus: no_studio_client`, `clientExists: false`) until the user completes profile. `complete-studio-profile` **updates** phone on that existing client via `updateclient`.

- Existing test clients created without phone (e.g. snir30/snir31) — sign out and sign in again (or Book → session reprobe) to refresh cookie flags.

**Not started:**

- `pricing-api.js`: phone dialog for logged-in `no_studio_client` before Stripe Express
- Post-checkout banner when `not_associated` after successful purchase
