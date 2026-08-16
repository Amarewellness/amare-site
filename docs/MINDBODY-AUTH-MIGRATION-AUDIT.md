# AMARÉ — Full Mindbody Auth Dependency & Migration Readiness Audit

**Status:** Diagnosis only. Read-only. No code changes, no migrations, no env changes, no deploy, no commit.  
**Date:** 2026-08-16  
**Scope:** Website (production), Netlify Functions, Stripe fulfillment, mobile app (`amare-app/`, not live).  
**Question:** Can AMARÉ safely stop using Mindbody Consumer OAuth as the website/app identity, and instead authenticate with Google / Apple / Email OTP, while keeping Studio `clientId` + Staff/API behind the scenes?

---

## Hebrew brief (סיכום קצר)

האתר והאפליקציה מזהים היום את המשתמש **רק** דרך Mindbody Consumer OAuth ועוגיית `mb_sess`.  
קנייה ב־Stripe, יצירת לקוח סטודיו, והזמנה אחרי תשלום **כבר עובדות בלי** OAuth (Staff API).  
הזמנה חיה, waitlist, ביטול, ודשבורד **דורשים** סשן Consumer, והאתר חוסם Book אם `consumerAssociated === false` (כלל AMARÉ, לא חובת Mindbody לכל הזמנה).  
אין ישות `amare_user_id`. האפליקציה בנויה על אותו OAuth אבל **עוד לא באוויר** — זול יותר להחליף אותה עכשיו.

**פסק דין:** `GO WITH BLOCKERS`  
**כיוון:** `MOVE TO AMARÉ AUTH` עם מעבר היברידי (לא cutover חד).

---

# A. Executive Verdict

```text
GO WITH BLOCKERS
```

**Why not GO:** Live self-serve booking, waitlist, cancel, and member dashboard all enter through `resolveConsumerClient` / `getSessionWithConsumerHeaders`. The live Book path hard-gates on `bookingAllowed` (`=== consumerAssociated`). There is no durable AMARÉ user entity. Email-only matching is already failing for Apple relay, duplicate studio profiles, and email mismatch. Observability for the documented book-block matrix is not in production JS.

**Why not NO-GO:** Stripe one-time and membership fulfillment already run on Staff tokens with no Consumer OAuth. Deferred post-purchase booking is already Staff-only. Studio clients are already created without a global Mindbody account. Member booking APIs do **not** trust a frontend `clientId`. The mobile app is not in production. A dual-session transition is technically possible because `mb_sess` is a named HttpOnly cookie and mobile uses a separate Bearer JWT.

**Recommended auth direction:** `MOVE TO AMARÉ AUTH` (hybrid during rollout, then retire Consumer OAuth as the login).

---

# B. Current Auth Architecture

The assumed flow in the audit brief is **correct** for website identity. It is **not** the only identity path in the repo.

## B.1 Live website identity (production)

```text
User
 → "Sign in with Mindbody" (#mb-auth-strip / pricing / classes / member / checkout-success)
 → GET /api/mindbody/oauth/start
 → Mindbody IdP  {issuer}/connect/authorize
 → POST /api/mindbody/oauth/callback  (form_post: code + id_token)
 → exchangeAuthorizationCode()
 → buildSessionPayloadFromOAuthTokens()
 → Set-Cookie: mb_sess  (AES-256-GCM sealed JSON, HttpOnly, 30 days)
 → GET /api/mindbody/oauth/session
 → UI treats user as logged in
```

| Step | File | Function | Endpoint |
|------|------|----------|----------|
| Sign-in CTA | `src/js/mindbody-auth.js` | logged-out strip render (~458–473) | links to `/api/mindbody/oauth/start` |
| Also CTAs | `src/js/classes-schedule.js`, `pricing-api.js`, `stripe-express-cta.js`, `member-dashboard.js`, `checkout-success.js` | various | same start URL |
| OAuth start | `netlify/functions/mindbody-oauth-start.mjs` | `handler` | `GET /api/mindbody/oauth/start` |
| State/CSRF | `netlify/functions/oauth-lib.mjs` | `signState` / `verifyState` (~99–119) | HMAC + 15 min `exp` |
| Callback | `netlify/functions/mindbody-oauth-callback.mjs` | `handler` | `GET|POST /api/mindbody/oauth/callback` |
| Token exchange | `netlify/functions/mindbody-oauth-session-build.mjs` | `exchangeAuthorizationCode` (~98–134) | Mindbody `/connect/token` |
| Session build | same | `buildSessionPayloadFromOAuthTokens` (~143–270) | — |
| Session probe | `netlify/functions/mindbody-oauth-session.mjs` | `handler` | `GET /api/mindbody/oauth/session` |
| Logout | `netlify/functions/mindbody-oauth-logout.mjs` | `handler` | `GET /api/mindbody/oauth/logout` — **clears cookie only, no Mindbody revoke** |
| Complete profile | `netlify/functions/mindbody-oauth-complete-studio-profile.mjs` | `handler` | `POST /api/mindbody/oauth/complete-studio-profile` `{ mobilePhone }` |

**Depends on Consumer token?** YES for all of the above after callback.  
**Depends on clientId?** Session can exist with `client_id: null`.  
**Depends on consumerAssociated?** Session stores it; booking uses it.  
**Risk if Mindbody OAuth removed:** Website has no other login. Users appear logged out. Book/cancel/dashboard 401.

## B.2 Two Mindbody identities — verified

| Concept | What it is | How created today | Required for |
|---------|------------|-------------------|--------------|
| **Consumer Identity** | Global Mindbody login (`sub` + OAuth tokens) | Mindbody IdP only | `mb_sess`, Consumer API header `consumer-identity-token`, association probe |
| **Studio Client** | Site-scoped row (`clientId`) | Stripe webhook `addclient`, OAuth ensure, staff, guest-pass, admin register | Credits, sales, Staff booking, dashboard data |

Staff API can create and book a Studio Client **without** a Consumer account. Evidence: `resolveOrCreateMindbodyClient` in `stripe-mindbody-sync-lib.mjs` (~1368–1508) and `attemptDeferredClassBookForOrder` in `mindbody-deferred-class-book.mjs`.

The product pain (Link Account) is the join between these two. Documented in `docs/MINDBODY-CONSUMER-STUDIO-LINK-DIAGNOSIS.md`.

## B.3 Parallel commerce identity (already Staff, no OAuth)

```text
Anonymous or logged-in buyer
 → POST /api/stripe/checkout/create-session
 → Stripe Hosted Checkout
 → webhook fulfillSession
 → resolveOrCreateMindbodyClient (Staff)
 → CheckoutShoppingCart / Service grant (Staff)
 → optional deferred Staff addclienttoclass
```

OAuth is optional here (prefill, NCS dry-run, deferred-book confirmation email).

## B.4 Mobile (built, not live)

```text
startMindbodyOAuth()
 → /oauth/start?platform=mobile
 → Mindbody
 → /oauth/callback or /oauth/mobile-bridge
 → app /auth/callback
 → POST /oauth/mobile-exchange
 → localStorage amare_access_token + amare_refresh_token
 → Authorization: Bearer on same Netlify APIs
```

Kill switch: `ENABLE_MOBILE_BEARER_AUTH` default off (`mobile-auth-lib.mjs` ~21–24). Production website is cookie-only.

## B.5 Assumption corrections

| Assumption | Actual |
|------------|--------|
| Phase 1.2 book-block matrix is live | **No.** `book_block_variant` / `resolveBookBlockVariantAsync` are in `docs/CLASSES-BOOK-BLOCK-PHASE1.md` and `scripts/qa-book-block-logic.mjs` but **absent** from `src/js/classes-schedule.js`. Live UI gates on `oauthBookingAllowed` only. |
| `AMARE-APP-PHASE0.md` “UI not started” | **Stale.** `amare-app/` is a Phase 1 Capacitor+React app (Schedule, My Classes, Profile, OAuth). |
| Soft sign-in gate on pricing | **Removed.** Replaced by `showExpressDetailsDialog` for all anonymous one-time SKUs (`pricing-api.js` ~1657–1675). |
| Mindbody EXPRESS / stored-cards is live checkout | **Disabled.** `PRICING_MINDBODY_EXPRESS_CHECKOUT_ENABLED = false`, `AUTH_MINDBODY_WALLET_PROBE_ENABLED = false`. |
| Durable AMARÉ user exists | **No.** `amare_user_id` / `amare_sess` — zero matches in repo. |

---

# C. Mindbody OAuth Dependency Map

| Area | Consumer OAuth | Consumer Token | mb_sess | clientId | consumerAssociated | Staff API alternative | Migration risk |
| ---- | -------------: | -------------: | ------: | -------: | -----------------: | --------------------: | -------------- |
| Login | Required | Required | Created here | Optional | Stored | None today | **Critical** |
| Schedule browse | No | No | No | No | No | Public API Key already | Low |
| Live booking | Required | Required | Required | Server-resolved | **Hard 403 if false** | Payment-fallback + deferred only | **Critical** |
| Waitlist join | Required | Required | Required | Server-resolved | Same book gate | None | **High** |
| Waitlist leave | Required | Required | Required | Server-resolved | No | None | High |
| Cancellation | Required | Required | Required | Server-resolved | No | Staff late-cancel retry | High |
| Wallet / dashboard | Required | Required (primary reads) | Required | Required | No (data still loads) | Staff merge for services + waitlist entries | High |
| Pricing browse | No | No | No | No | No | — | Low |
| Stripe one-time buy | Optional | Optional | Optional prefill | Staff resolve | No | **Already Staff** | Low |
| Stripe membership | Optional | No | Optional | Staff resolve **pre-Stripe** | No | **Already Staff** | Medium (email match) |
| Deferred booking | Optional (email rebook) | Optional sealed refresh | Optional | From order | No | **Already Staff primary** | Low |
| Profile completion phone | Required | Required | Required | Created by Staff | N/A | Staff `addclient` already | Medium |
| Link Account UI | Required | Required | Required | Exists | **This is the flag** | Disappears if Staff-book | Product |
| Saved Mindbody cards | Required | Required | Required | Required | Implicit | Stripe wallets already | Low (feature off) |
| Mindbody EXPRESS checkout | Required | Required | Required | Required | Implicit | Disabled; Stripe replaced it | Low |
| Bring-a-friend | Required | Required | Required | Host from session | No | Guest create is Staff | Medium |
| Partner benefits | Required | Required | Required | From session | No | Need AMARÉ session | Medium |
| Mobile app | Required | Via mobile JWT wrapping same blob | No (Bearer) | Same | Same gate | Same backend | **High if launched first** |
| Header name cache | Indirect | No | Probe only | No | No | Display-only `localStorage["amare-mb-header"]` | Low |
| Admin / staff tools | No | No | No | Admin-supplied | No | Separate admin token | Out of scope |

---

# 3 / B continued — Auth component inventory

For every production auth surface:

### Sign-in button

```text
File: src/js/mindbody-auth.js
Function/component: logged-out strip (~470–473)
Endpoint: /api/mindbody/oauth/start?return=…
Purpose: Start Mindbody OAuth
Inputs: current path
Outputs: redirect
Depends on Consumer token? NO (start). After return: YES
Depends on clientId? NO
Depends on consumerAssociated? NO
Risk if Mindbody OAuth is removed: No login CTA target.
```

Same pattern in `classes-schedule.js`, `pricing-api.js`, `stripe-express-cta.js`, `member-dashboard.js`, `checkout-success.js`, `amare-app/src/api/auth.ts` `startMindbodyOAuth()`.

### OAuth start

```text
File: netlify/functions/mindbody-oauth-start.mjs
Function: handler
Endpoint: GET /api/mindbody/oauth/start
Purpose: Redirect to Mindbody authorize; sign state
Inputs: return, platform=mobile, app_return, prompt, login_hint
Outputs: 302 to {issuer}/connect/authorize
Depends on Consumer token? NO
Depends on clientId? NO
Depends on consumerAssociated? NO
Risk: Entire login entry dies. Mobile deep-link start dies.
```

### Callback

```text
File: netlify/functions/mindbody-oauth-callback.mjs
Function: handler
Endpoint: /api/mindbody/oauth/callback
Purpose: Verify state, exchange code, seal mb_sess OR bounce mobile to app
Inputs: code, state, id_token
Outputs: Set-Cookie mb_sess + 302 return  |  mobile 302 to app /auth/callback
Depends on Consumer token? Acquires it
Depends on clientId? Resolves during build
Depends on consumerAssociated? Computes and stores
Risk: No session issuance.
```

### Session

```text
File: netlify/functions/mindbody-oauth-session.mjs
Function: handler
Endpoint: GET /api/mindbody/oauth/session
Purpose: JSON profile + link flags; refresh tokens; optional ?reprobe_link=1
Inputs: mb_sess cookie
Outputs: { authenticated, email, name, clientId, clientExists, consumerAssociated, bookingAllowed, linkStatus }
Depends on Consumer token? YES (refresh). 503 fallback can return unverified profile
Depends on clientId? Exposed if resolved
Depends on consumerAssociated? Exposed
Risk: All “am I logged in?” UI breaks.
```

### Logout

```text
File: netlify/functions/mindbody-oauth-logout.mjs
Function: handler
Endpoint: GET /api/mindbody/oauth/logout
Purpose: Clear mb_sess
Inputs: return path
Outputs: 302 + Max-Age=0
Depends on Consumer token? NO
Risk: Need equivalent for amare_sess. Mindbody SSO cookies may still auto-login if OAuth kept as fallback.
```

### Browser storage

| Store | Key | Auth credential? |
|-------|-----|------------------|
| Cookie | `mb_sess` | **Yes** (sealed tokens) |
| Cookie | `mb_book_fail_intent` | No — sealed classId + server clientId |
| Cookie | `mb_anonymous_book_intent` | No — class intent, no clientId |
| localStorage | `amare-mb-header` | No — first name cache 24h (`header-members.js`) |
| localStorage (app) | `amare_access_token`, `amare_refresh_token`, `amare_profile` | **Yes** (mobile JWT) |
| sessionStorage | pricing/checkout flags | No |

**Server-side Consumer auth persistence:** none (no session DB). Exception: Stripe order may store `deferredBookConsumerAuthSealed` (refresh token + clientId + orderId) for confirmation-email rebook (`stripe-order-store.mjs`, `sealDeferredBookConsumerAuth`).

**Tab / refresh / incognito**

- Auth is **server cookie** (web). New tab on same host sends `mb_sess`. No BroadcastChannel sync.
- Refresh: `/oauth/session` re-reads cookie and may refresh Mindbody tokens + re-seal.
- Incognito / new device: empty cookie → logged out. Must OAuth again. Mindbody IdP may SSO if their cookies exist.
- Logout: clears `mb_sess` only. Mindbody IdP session can remain (`prompt=login` used for “different account”).

---

# 4 / mb_sess contents

Canonical payload from `buildSessionPayloadFromOAuthTokens()` (`mindbody-oauth-session-build.mjs` ~258–270):

| Field | Type | Meaning |
|-------|------|---------|
| `sub` | string \| null | Mindbody OIDC subject |
| `email` | string \| null | Normalized profile email |
| `name` | string | Display name |
| `client_id` | number \| null | Studio Client ID |
| `client_exists` | boolean | Studio row complete enough (phone on file) |
| `consumer_associated` | boolean | Consumer JWT passed `GET /client/clientcompleteinfo` |
| `booking_allowed` | boolean | Set equal to `consumer_associated` |
| `link_status` | string | `ready` \| `not_associated` \| `no_studio_client` \| `ambiguous_studio_client` \| `apple_relay_email` \| `incomplete_profile` |
| `access_token` | string \| null | Mindbody Consumer access JWT |
| `refresh_token` | string \| null | Mindbody refresh |
| `at` | number | Seal timestamp |

**Seal:** `sealCookiePayload` — AES-256-GCM, key `SHA256(MINDBODY_SESSION_SECRET)` (`oauth-lib.mjs` ~306–313).  
**Cookie:** `Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000` + `Secure` when `x-forwarded-proto=https`. Host-only (no Domain).  
**Browser JSON never includes tokens** (`mindbody-oauth-session.mjs` ~188–199).

### A. Identify client if Consumer token removed but clientId remains?

**Partially.** The cookie can still unseal `client_id` + email. `tryResolveClientId` uses `session.client_id` as a **hint** and **re-verifies** via Mindbody (`mindbody-consumer-lib.mjs` ~1799–1813, `verifyClientId` ~1762–1783).  
Today almost every member API first requires a **valid Consumer access token** via `getSessionWithConsumerHeaders` (refresh if needed). If the token is gone and refresh fails → 401, cookie cleared on `/oauth/session`.  
So: **the website cannot currently act on `clientId` alone.** A future AMARÉ session could, if endpoints stop requiring Consumer headers.

### B. Is mb_sess treated as proof that this browser owns this clientId?

**Yes, as OAuth-bound proof, not as a raw id.** Tampering fails GCM. `client_id` inside is re-verified. Booking additionally requires live association probe.  
The cookie **is** the website’s only proof of “who is logged in.” Theft of `mb_sess` = act as that Consumer until Max-Age or logout. **No server revocation list.**

### C. Which backend endpoints trust clientId derived from the cookie?

All `resolveConsumerClient` / `getSessionWithConsumerHeaders` routes (see §11 inventory). They resolve id from session + Mindbody, then persist it back into the cookie. They do **not** take booking `clientId` from the body.

### D. Does any endpoint accept clientId from frontend?

| Endpoint | Accepts body clientId? | Trust? |
|----------|------------------------|--------|
| `POST /api/mindbody/class/book` | **No** — `{ classId, waitlist?, … }` | Session only |
| `POST /api/mindbody/class/cancel` | **No** — `{ classId, visitId }` | Session only |
| Waitlist remove | **No** | Session only |
| Complete studio profile | **No** — `{ mobilePhone }` | Session only |
| `POST /api/stripe/checkout/create-session` | **Yes** — `knownMindbodyClientId` | Used for prefill, NCS dry-run, order metadata. Webhook later re-resolves with email check (see §K) |
| Admin follow-ups | Yes `mindbodyClientId` | Admin token |
| `mindbody-guest-pass-dev-reset` | Yes | Local dev only |

**CRITICAL for future architecture:** do not copy the Stripe body pattern into booking. Booking already follows the safe pattern.

### E. Can a future AMARÉ session replace the identity portion while retaining client resolution?

**Yes.** `mb_sess` already mixes (1) identity tokens and (2) resolved `client_id` + link flags. A future `amare_sess` should hold `amare_user_id` (+ email/subs). Server maps `amare_user_id → mindbody_client_id` in durable storage. Staff headers then act on that id. Consumer tokens become unnecessary for ordinary use.

---

# G / 5. Existing logged-in user migration

Cookie TTL is **30 days**. Mindbody refresh inside may be shorter; failed refresh **clears** `mb_sess` (`mindbody-oauth-session.mjs` ~36–57).

| # | Scenario | What happens today | If AMARÉ Auth deploys |
|---|----------|--------------------|------------------------|
| 1 | Valid `mb_sess` | Logged in; Book if `bookingAllowed` | **Hard cutover:** looks logged out until new login. **Dual:** old cookie still works if endpoints still accept it. |
| 2 | Expired Consumer token, cookie present | `/oauth/session` refresh fails → cookie cleared → logged out | Same. Cannot bootstrap claim from dead tokens. |
| 3 | Linked studio client (`link_status: ready`) | Full site | Best claim candidate: valid cookie proves `client_id`. Bind Google/Apple to that id **once**. |
| 4 | Global Mindbody, never linked (`not_associated`) | Link Account UI; Book 403 | New auth can skip Link Account **if** Staff-book + email/phone match finds the studio row. If no unique match → support. |
| 5 | Studio Client only, no global Mindbody | Cannot log in today unless they create Consumer | **Primary beneficiary** of AMARÉ Auth. Match email → `clientId`. |
| 6 | Stripe purchase, never logged in | Studio Client exists from webhook; no cookie | Google/Apple with **same email** should find them. Different email → duplicate risk. |
| 7 | Email changed later | Resolution is email + cookie id hint | Google email ≠ Mindbody email → miss or wrong person. Need claim/support. |
| 8 | Multiple studio clients same email | `ambiguous_studio_client`; no auto-create; OAuth auto-merge may merge into session client | **Must not** auto-pick. Keep contact-studio. |
| 9 | Google/Apple email ≠ Mindbody email | Today OAuth email is source of truth for ensure/search | **Will not auto-link.** Need verified claim (old `mb_sess`, phone, or staff). |
| 10 | Apple Hide My Email | `privaterelay.appleid.com` → `apple_relay_email`; no auto-create (`stripe-mindbody-sync-lib.mjs` ~621–622) | **Same trap** if Apple Sign-In hides email. Must require real email share or manual link. |
| 11 | Duplicate studio profiles | `pickCanonicalClient` phone/active tie-break; else ambiguous; post-OAuth `autoMergeDuplicatesByEmail` | Keep; do not create third row on Google login. |
| 12 | New AMARÉ login while old `mb_sess` exists | N/A today | **Collision risk.** See below. |

### Dual cookie: `amare_sess` + `mb_sess`

Technically they can coexist (different names).

**Do not silently prefer one if they disagree.**

Recommended rule (design only):

```text
if amare_sess valid:
  identity = amare_user_id → stored clientId
  if mb_sess also valid AND mb.client_id != amare.client_id:
    refuse privileged actions until user picks / support links
    (do not book, cancel, or show wallet)
if only mb_sess valid (transition):
  treat as legacy identity (current behavior)
```

Silent “amare wins” would let a stolen/confused Google account override a still-valid Mindbody session pointing at a different client. Silent “mb wins” would undo the migration.

---

# 6. Global dependency inventory (search)

Searched: `mb_sess`, `consumerAssociated`, `consumer_associated`, `bookingAllowed`, `access_token`, `refresh_token`, `oauth`, `clientId`, `client_id`, `clientExists`, `not_associated`, `apple_relay_email`, `privaterelay`, `pendingBook`, `book_block`, `walletLoadState`.

**Live code (not docs):**

- `netlify/functions/oauth-lib.mjs`
- `netlify/functions/mindbody-oauth-*.mjs` (start, callback, session, session-build, logout, complete-studio-profile, mobile-*)
- `netlify/functions/mindbody-consumer-lib.mjs`
- `netlify/functions/mobile-auth-lib.mjs`
- `netlify/functions/mindbody-class-book.mjs`, `mindbody-class-book-lib.mjs`
- `netlify/functions/mindbody-class-cancel.mjs`, `mindbody-class-waitlist-remove.mjs`
- `netlify/functions/mindbody-deferred-class-book.mjs`, `mindbody-pending-book-intent-lib.mjs`
- `netlify/functions/mindbody-member-summary.mjs`
- `netlify/functions/mindbody-client-stored-cards.mjs`
- `netlify/functions/mindbody-sale-checkout.mjs`, `sale-purchase-contract.mjs`, `sale-checkout-warmup.mjs`
- `netlify/functions/mindbody-member-bring-a-friend*.mjs`
- `netlify/functions/benefits-*.mjs`
- `netlify/functions/stripe-create-checkout-session.mjs`, `stripe-webhook.mjs`, `stripe-mindbody-sync-lib.mjs`, `stripe-order-store.mjs`
- `src/js/mindbody-auth.js`, `classes-schedule.js`, `member-dashboard.js`, `pricing-api.js`, `stripe-express-cta.js`, `checkout-success.js`, `header-members.js`, `mindbody-wallet-widget.js`
- `amare-app/src/auth/AuthContext.tsx`, `api/auth.ts`, `api/client.ts`, `lib/booking-link.ts`, `config.ts`

**Docs / QA (not all live):** `docs/CLASSES-BOOK-BLOCK-PHASE1.md`, `docs/MINDBODY-CONSUMER-STUDIO-LINK-DIAGNOSIS.md`, `scripts/qa-book-block-logic.mjs`.

---

# D / 7. Purchase flow — `/pricing`

## State machine (actual)

```text
Click Buy / Subscribe
 ├─ One-time SKU + Stripe express enabled?
 │    ├─ Anonymous → showExpressDetailsDialog (name/email/phone)
 │    └─ Logged in (GET /oauth/session) → showStripeExpressChooser
 │         → POST /api/stripe/checkout/create-session
 │         → Stripe Hosted Checkout (card / Apple Pay / Google Pay / Link)
 │         → /checkout/success?orderId=&session_id=  (poll only)
 │         → webhook fulfillSession
 │              resolveOrCreateMindbodyClient (Staff)
 │              syncOneTimePurchaseToMindbody (CheckoutShoppingCart, payment method "Stripe")
 │              optional new-client password email
 │              optional deferred book
 │
 ├─ Recurring membership + ENABLE_STRIPE_RECURRING_CHECKOUT?
 │    → consent dialog
 │    → resolveOrCreateMindbodyClient BEFORE Stripe
 │    → Stripe Subscription Checkout
 │    → invoice.paid → Staff Service grant per period
 │
 └─ Else → Mindbody Classic URL (new tab)
```

Mindbody EXPRESS (`PRICING_MINDBODY_EXPRESS_CHECKOUT_ENABLED`) is **false**. Stored-cards probe is **false**.

### Per SKU (catalog `stripe-mindbody-catalog.config.json`)

| localSku | Stripe? | OAuth required? | Client when? | Notes |
|----------|---------|-----------------|--------------|-------|
| `new_client_special_3_for_65` | Yes | No | Webhook; NCS dry-run only if `knownMindbodyClientId` | Anonymous duplicate catch is **webhook-time**, not pre-Stripe |
| `drop_in_single_class` | Yes | No | Webhook | |
| `drop_in_same_day` | Yes | No | Webhook | **Not** deferred-book eligible |
| `pack_10_classes` / `pack_20_classes` | Yes | No | Webhook | |
| `pack_5_classes` | **Disabled** | — | — | Falls to Classic if shown |
| `monthly_5` / `monthly_8` / `monthly_unlimited` | Subscription if flag on | No | **Pre-Stripe** Staff resolve | 409 if active sub |

### Answers

| Question | Answer |
|----------|--------|
| Require Mindbody OAuth? | **No** |
| Require `mb_sess`? | **No** (improves prefill / NCS precheck) |
| Anonymous purchase? | **Yes** (one-time; memberships collect email in dialog) |
| Email source | Dialog and/or Stripe Checkout and/or cookie email |
| Studio client | Staff `resolveOrCreateMindbodyClient` |
| Created when | Webhook (one-time) or create-session (membership) |
| Match by email? | Yes + optional phone tie-break |
| Duplicates | `pickCanonicalClient`; 2+ → no create / `paid_but_not_synced` |
| `consumerAssociated` affect purchase? | **No** |
| Consumer OAuth affect fulfillment? | **No** |
| Redirect/confirmation? | Success page **suggests** “Sign in with Mindbody” (`checkout-success.js`) — UX only |
| Package tied to `clientId`? | **Yes** |
| Session after purchase? | **None created.** Buyer is not logged in unless they already had `mb_sess` |
| Credits immediately bookable? | On Mindbody yes. On website **only after Consumer login + association** (live book gate) |
| Never linked? | Credits sit on Studio Client; website Book blocked until Link Account **or** deferred Staff book already ran |
| Hidden post-purchase OAuth dependency? | Live Book and dashboard. Deferred book from classes CTA does **not** need it |

---

# E / 8. Purchase flow — Booking (failed book → pay → auto-book)

```text
Book click
 → if !oauthLoggedIn → guest packages + optional anonymous intent cookie
 → if logged in && !oauthBookingAllowed → Link / complete profile (no purchase)
 → if logged in && bookingAllowed → Confirm → POST /class/book
      → 402 no_bookable_credits
           → Set-Cookie mb_book_fail_intent { classId, clientId from SESSION }
           → appendBookFailPackagesExtras(+ bookFailCls)
           → Stripe checkout with pendingBook + ctaLocation=classes_booking_fail_packages
           → validatePendingBookForCheckout(intent.clientId === knownClientId)
           → webhook sync
           → attemptDeferredClassBookForOrder (Staff addclienttoclass)
```

| Stage | mb_sess | Consumer token | consumerAssociated | clientId | Other |
|-------|---------|----------------|--------------------|----------|-------|
| Detect no credits | Yes | Yes | Must be true to reach 402 (else 403 first) | Session | |
| Intent cookie | Yes | — | — | Sealed server-side | HttpOnly |
| Checkout leave/return | Cookie + Stripe | Optional sealed refresh for email | No | Order + intent | |
| Deferred book | No | Optional | No | `resolvedMindbodyClientId` | Staff |

**Deferred booking can identify the Studio client without Consumer OAuth.** Evidence: `mindbody-deferred-class-book.mjs` uses Staff headers; client id comes from order sync.

**Caveat:** the **live** 402 path that *creates* `mb_book_fail_intent` is only reachable if the user was already Consumer-associated (otherwise 403). Anonymous path uses `mb_anonymous_book_intent` (no clientId) and resolves client at webhook.

Waitlist 402 shows packages **without** `bookFailCls` → **no** pendingBook / deferred book (`classes-schedule.js` ~3658–3661). Correctly excluded in `validatePendingBookForCheckout` (`waitlist === true` rejected).

---

# F / 9. Booking with existing credit

## Live frontend (`classes-schedule.js` `openBookFlow` ~3942–3974)

```text
!oauthLoggedIn → sign-in / guest packages
oauthLoggedIn && !oauthBookingAllowed
   → no_studio_client → phone complete-profile modal
   → else → “Account not linked” / ambiguous / apple_relay
oauthLoggedIn && oauthBookingAllowed → Confirm → POST { classId }  (NO clientId)
```

Credits are **not** pre-checked in live JS (Phase 1.2 matrix not shipped). Wallet bars are display-only.

## Live backend (`mindbody-class-book.mjs`)

```text
resolveConsumerClient          → 401 if no Consumer session
resolveSessionStudioLinkFlags  → 403 studio_not_linked if !bookingAllowed
listBookableClientServiceIds   → consumer + staff merge
if no services                 → 402 + book-fail intent
tryBookWith(consumer)          → POST /class/addclienttoclass SendEmail:true
retry with ClientServiceId
if payment-required error      → tryBookWith(staff) SendEmail:false
verifyBookPaymentApplied
rollback if verify fails
```

### Consumer vs Staff vs association

| Variable | Category | Live role |
|----------|----------|-----------|
| `oauthLoggedIn` / session | **Authentication** | Who is the browser |
| `clientExists` / `clientId` | **Business** | Studio row |
| `hasPhone` / `no_studio_client` | **Business** | Mindbody addclient completeness |
| `hasActiveCredits` | **Business** | Entitlement (backend 402; not FE pre-gate) |
| `classCapacity` / waitlist | **Business** | Inventory |
| `consumerAssociated` / `bookingAllowed` | **Legacy Consumer-association** | AMARÉ hard gate + Mindbody Consumer API success signal |
| `walletLoadState` | Documented, **not live** in book click | — |

`consumerAssociated` is **an AMARÉ application rule** for live Book (`mindbody-class-book.mjs` ~136–163). Mindbody Staff `addclienttoclass` does **not** need it (deferred path proves this). Mindbody **Consumer** `addclienttoclass` **does** need association (401 `DeniedAccess` / “Consumer not associated with studio”).

---

# 10 / J. Staff fallback / Staff booking

Staff credentials: `MINDBODY_STAFF_USERNAME` + `MINDBODY_STAFF_PASSWORD` → `POST …/usertoken/issue`, in-process cache (`mindbody-consumer-lib.mjs` ~947–1076). Optional legacy `MINDBODY_STAFF_USER_TOKEN`.

| Operation | Staff used? | Notes |
|-----------|-------------|-------|
| Create/find client | Yes | Stripe + OAuth ensure |
| Merge duplicates | Yes | Post-OAuth `autoMergeDuplicatesByEmail` |
| CheckoutShoppingCart / Service grant | Yes | Webhook |
| List client services (merge) | Yes | Book + member summary |
| Live addclienttoclass | **Fallback only** | Payment-required + bookableIds > 0 |
| Deferred addclienttoclass | **Primary** | |
| Payment verify / rollback | Yes fallback | |
| Waitlist entries read | Yes | Consumer returns 400 |
| Waitlist add/remove | **No** | Consumer only |
| Cancel | Late-cancel retry | Primary is Consumer |
| Confirmation email | Staff `SendEmail:true` often does not send | Rebook with consumer token (`mindbody-class-book-lib.mjs` ~410–413, `mindbody-pending-book-intent-lib.mjs` comment) |
| Directory search | Yes | Consumer JWT cannot search |

Staff does **not** accept arbitrary client IDs from the browser on book/cancel. Stripe `knownMindbodyClientId` is the exception (prefill).

### How close to 100% AMARÉ-authenticated Staff booking?

**~40% of the live self-serve surface. ~85% of commerce fulfillment.**

| Component | Staff-ready | Weight (self-serve) |
|-----------|-------------|---------------------|
| Deferred book | Yes | 15 → 15 |
| Entitlement merge | Partial | 10 → 8 |
| Verify + rollback | Partial | 10 → 7 |
| Live AddClientToClass | Consumer-first + association gate | 25 → 5 |
| Waitlist add/remove | Consumer | 15 → 0 |
| Cancel | Consumer-first | 10 → 3 |
| Client resolution / session | Consumer OAuth required | 15 → 0 |
| **Total** | | **~38–40%** |

Remaining work is application + session design, not a missing Staff capability for `addclienttoclass`.

---

# 11. Waitlist

```text
Join: same POST /class/book { waitlist: true }
      same Consumer session + bookingAllowed + credits
Leave: POST /api/mindbody/class/waitlist-remove → /class/removefromwaitlist (Consumer)
Summary map: Staff GET /class/waitlistentries
```

- Consumer token: **required**
- `consumerAssociated`: **required** (same 403)
- Staff add path: **none**
- Purchase-from-waitlist: packages UI only; **no** deferred auto-join
- `pendingBook` **not** shared (by design)

---

# 12. Cancellation

```text
UI: Cancel booking → POST { classId, visitId }  (no clientId)
Backend: resolveConsumerClient
  → POST /class/removeclientfromclass Consumer SendEmail:true
  → if outside window → Staff LateCancel:true
Guest-pass visits: Staff cancelGuestVisit
```

- Identity: Consumer session
- `consumerAssociated`: **not** checked
- Credit restore: Mindbody visit/service rules
- Late policy: Mindbody `LateCancelled` + FE 12h heuristic (`LATE_CANCEL_HOURS = 12`)
- Consumer OAuth: **essential today** for member cancel; Staff already handles late window

---

# 13. Dashboard / wallet

`GET /api/mindbody/member/summary` — requires `getSessionWithConsumerHeaders` then `tryResolveClientId`. If no clientId → empty profile.

| Data | Source | Consumer? | Staff? | clientId only enough? | consumerAssociated? | Cached |
|------|--------|-----------|--------|----------------------|---------------------|--------|
| Name / email / phone | `GET /client/clients` | Primary | — | Yes if Staff used | No | No (request) |
| Packages / remaining | `clientservices` | Primary | Merge fresher remaining | Yes | No | No |
| Purchases | `clientpurchases` | Yes | — | Yes | No | No |
| Memberships | `activeclientmemberships` + Stripe blob overlay | Yes | Stripe store | Yes | No | Stripe blobs |
| Balances | `clientaccountbalances` | Yes | — | Yes | No | No |
| Visits | `clientvisits` | Yes | Verify fallback elsewhere | Yes | No | No |
| Waitlist | `waitlistentries` | No (400) | **Yes** | Yes | No | No |
| Payment methods | stored-cards (off) | Yes | Probe exists | — | — | No |
| Waiver | Not loaded; in-studio / guest-pass copy | — | — | — | — | — |

**Replacing login is useless unless member-summary (or a Staff equivalent) accepts AMARÉ session + stored clientId.** Staff already reads services and waitlist. Profile/purchases/memberships/visits are callable with Staff headers in principle; **not wired** as the primary path today.

---

# 14. Saved cards and payment methods

| Mechanism | Status | Needs Consumer OAuth? |
|-----------|--------|------------------------|
| Mindbody stored-cards | Implemented, **UI probe off**, EXPRESS off | Yes if re-enabled |
| Stripe Hosted Checkout | **Live** for express SKUs | No |
| Apple Pay / Google Pay / Link | Via Stripe Checkout | No |
| Browser autofill | Stripe page | No |

If Consumer OAuth is removed: **no live payment feature is lost.** Mindbody wallet EXPRESS remains unavailable (already). Stripe wallets stay.

---

# 15. Stripe identity fields

Connecting a payment to a person today:

```text
email
knownMindbodyClientId          (optional, body or cookie-email search)
resolvedMindbodyClientId       (webhook)
stripeCustomerId
orderId / sessionId
pendingBook / deferredBook
membershipConsentId
metadata.mindbodyClientId on Stripe Customer
```

**No `amare_user_id`.** Adding it would **simplify** long-term (stable join across email changes) and **not conflict** if stored on the order + Stripe Customer metadata alongside `mindbodyClientId`.

Webhook fulfillment does **not** need Consumer OAuth.

---

# H / 16. Client creation and matching

| Trigger | Matching key | Duplicate protection | Creates? | Updates? | Requires Consumer? | Requires association? |
|---------|--------------|----------------------|----------|----------|--------------------|------------------------|
| Stripe webhook `resolveOrCreateMindbodyClient` | known id + email verify; else email; phone tie-break | No create if ambiguous | Yes if none | Opt-in email | **No** | **No** |
| Membership create-session | Same | 409 active sub | Yes | — | No | No |
| OAuth `resolveExistingStudioClientForOAuth` | Email + unique name | Ambiguous / Apple relay → no create | No | No | No (Staff lookup) | No |
| OAuth `ensureStudioClientForOAuthProfile` | After miss | Same | Yes if flag on + phone | — | No | No |
| OAuth `autoMergeDuplicatesByEmail` | Email → merge into session client | Kill switch `STRIPE_AUTO_MERGE_DUPLICATES` | No | Merge | Session id | No |
| `tryResolveClientId` | JWT claims → cookie id → CCI → email → name | Verify each id | No | Cookie persist | Token for some steps; Staff search fallback | No |
| Complete profile POST | Session + phone | Ambiguous / relay blocked | Yes | Phone | Yes | No |
| Guest pass | Host session + guest identity helper | Central find-or-create | Yes (guest) | — | Host yes | No |
| Admin register | Staff | — | Yes | — | No | No |

### Future race: Google login + Stripe + webhook

Today Stripe uses `onlyIfNew` order put + webhook terminal idempotency + addclient conflict re-search.  
**Missing:** a durable unique key `amare_user_id` or unique `(provider, sub)`.  
**Required before AMARÉ Auth:** one writer for “find or create studio client” (already `resolveOrCreateMindbodyClient`) called from **both** login and webhook, with the same ambiguous/Apple-relay rules. Do not add a third `addclient` path.

---

# 17. Link Account flow

**When UI appears:** `needsMindbodyEmailLink()` in `mindbody-auth.js` ~112–121 — studio client exists (or `linkStatus === not_associated`) and `consumerAssociated` / `bookingAllowed` / `ready` are false.

**What it calls:** No AMARÉ “link” API. Copy tells the user to open Mindbody’s email (“Add Amare Wellness Studio to your Mindbody account”) and tap **Link your account**. Refresh: `GET /oauth/session?reprobe_link=1` → `computeOAuthStudioLinkState` / `probeConsumerStudioAssociation` (`GET /client/clientcompleteinfo`).

**Local state after success:** cookie flags flip to `consumer_associated: true`, `booking_allowed: true`, `link_status: ready`. `client_id` usually unchanged. Consumer token unchanged.

**Failure:** flags stay `not_associated`; Book 403 `studio_not_linked`. Buying again does **not** fix association (Desiree case in diagnosis doc).

**Second global account / email mismatch:** new Consumer may not associate; email search may miss or hit ambiguous.

**If AMARÉ stops requiring Consumer OAuth:** this entire UI, `reprobe_link`, `not_associated` book block, and “Sign in with Mindbody” post-purchase CTAs **can disappear** from the happy path. Keep as optional fallback / support tool during hybrid.

---

# K / 18. Security findings

### P0 Critical

None found on **member book/cancel**: frontend `clientId` is not trusted.

### P1 High

1. **`POST /api/stripe/checkout/create-session` accepts `knownMindbodyClientId` from the body** (`stripe-create-checkout-session.mjs` ~1408–1415). Used for Mindbody contact prefill (PII: name/phone/email) and NCS dry-run. Webhook `resolveOrCreateMindbodyClient` trusts known id when `!email || !rowEmail || rowEmail === email` (~1416–1427). An unauthenticated caller who knows a victim `clientId` can prefill that profile; if they also use the victim email, fulfillment can attach to that client (paid gift / NCS burn). **Must not** become the pattern for AMARÉ Auth booking.

2. **No server-side session revocation** (web cookie or mobile JWT). Logout is client-state only. Stolen `mb_sess` or mobile refresh JWT works until expiry.

3. **Future Staff-on-behalf without a server-side `amare_user_id → clientId` bind** would allow User A to act as User B. This is the single biggest *migration* risk, not a current book-API bug.

4. **Mobile tokens in `localStorage`** (`amare-app/src/config.ts`) — XSS = full account. App not live; fix before launch if keeping Bearer-in-JS.

### P2 Medium

5. Dual `amare_sess` + `mb_sess` disagreement not designed — account mix-up during rollout.  
6. Logout does not revoke Mindbody IdP; `prompt=login` is a workaround.  
7. 30-day cookie containing refresh token — high impact if stolen.  
8. Email-only claim of a Studio Client after Google/Apple = takeover if attacker controls that inbox (same as today’s Stripe anonymous match). Need verified email + collision policy.

### P3 Low

9. `/oauth/session` 503 path can show signed-in UI with `session_consumer_unverified`.  
10. Mobile CORS `Access-Control-Allow-Origin: *` on exchange/refresh while flag is off in prod.  
11. Guest-pass dev reset accepts body `clientId` (local only).

**Future required pattern:**

```text
authenticated AMARÉ session
 → server resolves amare_user_id
 → server resolves associated mindbody_client_id
 → Staff operation
```

Never: `frontend sends clientId → backend trusts it` for book/cancel/wallet.

---

# 19. Mobile application audit

| Question | Finding |
|----------|---------|
| Mindbody OAuth? | **Yes** — only auth |
| Same web callback? | Start is shared; mobile uses `platform=mobile` + bridge or `amare://` |
| WebView? | **No** |
| Capacitor Browser? | Dependency installed, **unused**; `window.location.href` redirect |
| Deep links | `/auth/callback` after HTTPS bridge; native `amare://` documented, **no Capacitor App listener** in source |
| Token storage | `localStorage` |
| Refresh | `POST /oauth/mobile-refresh`; also `X-Amare-*` headers |
| Cookies | Not used in app |
| API session | Bearer wrapping **same sealed blob** as `mb_sess` |
| Shared package | Same Netlify functions |
| Booking / wallet / profile | Implemented against `/class/book`, `/member/summary` |
| Purchasing | Opens website `/pricing` |
| Complete-profile / Link Account UI | **Missing** vs website (blocks via `booking-link.ts`) |

**Cheaper to change auth before launch: YES.** UI exists but is not in stores. Changing after TestFlight/accounts is materially harder.

App files that would change later: `amare-app/src/api/auth.ts`, `auth/AuthContext.tsx`, `api/client.ts`, `config.ts`, `lib/booking-link.ts`, `screens/*`, `capacitor.config.ts`, plus all `mindbody-oauth-mobile-*` functions.

---

# 20. Website vs app unification

Natural shared model (conceptual — not implemented):

```text
amare_user_id
mindbody_client_id
identities: { google_sub, apple_sub, email, email_verified }
stripe_customer_id
```

Transport:

- Web: HttpOnly `amare_sess`  
- App: short-lived access JWT + rotating refresh in **secure storage** (not localStorage)  
- Same authorization middleware: session → `amare_user_id` → `clientId` → Staff

The repo already has dual transport (`mb_sess` vs Bearer) via `resolveSessionFromRequest()`. That is the right seam to swap identity source.

---

# 21. Waiver / phone / profile

| Requirement | Enforced how | Same as Link Account? |
|-------------|--------------|------------------------|
| Phone | `link_status: no_studio_client` if no phone; complete-profile POST | **No** — business/Mindbody addclient |
| Email | OAuth claims / Stripe | Business |
| Waiver | In-studio; guest-pass consent copy only | **No** |
| DOB / emergency | Not found as book gates | — |
| Consumer association | `bookingAllowed` | **Yes — different category** |

Do not treat “no phone” and “not associated” as one CTA after migration.

---

# 22. Book-block decision matrix

### Documented Phase 1.2 (QA script — **not live JS**)

| Order | Condition | Variant | Future |
|-------|-----------|---------|--------|
| 1 | ambiguous / apple_relay | `ambiguous` | **KEEP** |
| 2 | no_studio_client / !clientExists | `complete_profile` | **KEEP** (phone) |
| 3 | wallet loading | `wallet_checking` | KEEP if restored |
| 4 | wallet error | `wallet_unknown` | KEEP if restored |
| 5 | !hasActiveCredits | `purchase_first` | **KEEP** |
| 6 | !consumerAssociated | `link_mindbody` | **REMOVE** after Staff-book |
| 7 | else | Confirm | KEEP |

### Live runtime

| Condition | CTA | Future |
|-----------|-----|--------|
| !logged in | LOGIN / guest buy | **REPLACE** login provider |
| logged in && !bookingAllowed && no_studio_client | COMPLETE PROFILE | KEEP |
| logged in && !bookingAllowed else | LINK ACCOUNT / contact | **REMOVE** as default; keep contact for ambiguous/relay |
| logged in && bookingAllowed | BOOK (credits checked after) | REPLACE pre-check with credits |
| 402 | BUY PACKAGE + pendingBook | KEEP |
| class full | WAITLIST | KEEP |
| 403 | LINK / contact | REMOVE after Staff-book |

**`consumerAssociated` can be removed as a booking prerequisite** once live Book uses Staff (or Staff-first) and session identity is AMARÉ-owned. Until then, **KEEP** the backend 403 (it prevents known DeniedAccess loops).

---

# 23. Error handling (auth-related)

| Error | Generated | Interpreted | User message / CTA | Auth dependency |
|-------|-----------|-------------|--------------------|-----------------|
| `studio_not_linked` 403 | `mindbody-class-book.mjs` ~147–160 | `classes-schedule.js` | Link / contact studio | Consumer association |
| `client_not_linked` 400 | `resolveConsumerClient` | Book UI | Sign-in / contact | Session vs client |
| `no_bookable_credits` 402 | class-book | Packages embed | Buy | Session + credits |
| `DeniedAccess` / not associated | Mindbody | Logs + 403 gate | Same as link | Consumer token |
| `apple_relay_email` | link state | Book modal + app `booking-link.ts` | Contact / real email | Email match |
| `ambiguous_studio_client` | link state | Contact studio | Support | Matching |
| `invalid_session` / `token_refresh_failed` | consumer-lib / oauth-session | Cookie cleared | Sign in again | OAuth tokens |
| `mobile_auth_disabled` | mobile-exchange | App | Dev flag | Mobile |
| Checkout success “Sign in with Mindbody” | `checkout-success.js` | CTA | OAuth | UX leftover after migration |

Stale “Link your Mindbody account” copy will remain in `mindbody-auth.js`, `classes-schedule.js`, `booking-link.ts`, `checkout-success.js`, `checkout-success.html` unless explicitly retired.

---

# 24. Analytics / logging / observability

**Server JSON (good):** `oauth_callback_*`, `oauth_session_authenticated`, `oauth_link_state_summary`, `class_book_studio_not_linked`, `class_book_resolved_client`, `stripe_oauth_auto_merge_*`, `member_summary_*`, `mobile_oauth_exchange_*`.

**Phase 1.2 gap (real):** `book_block_variant`, `clientExists`, `hasPhone`, `walletLoadState`, `hasActiveCredits`, `consumerAssociated`, `selectedCTA` are **specified** in `docs/CLASSES-BOOK-BLOCK-PHASE1.md` and checked by `qa-book-block-logic.mjs`, but **`book_block_variant` is not in `src/js/classes-schedule.js`**. QA static check would fail today.

**Recommendation:** complete this observability **before** migration. Without it, “Link Account vs no credits vs no phone” will be indistinguishable in production during dual-auth.

GA4/gtag exists for Stripe funnels (`main.js`, `pricing-api.js`). Mobile app: no analytics found.

---

# 25. Tests

**No formal unit test files** (`*.test.js` / `*.spec.js` = 0).

| Test file | Protects | Valid after auth migration? | Missing |
|-----------|----------|-----------------------------|---------|
| `scripts/qa-book-block-logic.mjs` | Documented matrix + log field names | **Already stale vs live JS** | Must be rewritten for AMARÉ session flags |
| `scripts/qa-phase-12-book-credits.mjs` | Credits gate, consumer-first book | Partial (credits keep; consumer-first changes) | Staff-primary book |
| `scripts/qa-deferred-book-logic.mjs` | Intent + auto-book | **Yes** (Staff path) | AMARÉ session attach |
| `scripts/qa-classes-auto-book-logic.mjs` | Webhook auto-book | Yes | — |
| `scripts/qa-dropin-single-product.mjs` | Stripe product id | Yes | — |
| `scripts/smoke-book-block-browser.mjs` | Playwright book-block | Needs rewrite | New login |
| Stripe forge / NCS / guest-pass scripts | Commerce | Yes | Identity claim cases |

**Must add before implementation:** Google/Apple claim, relay, duplicate email, dual-cookie conflict, Staff-book without Consumer, session does not accept body `clientId`.

---

# 26. Environment / deploy

| Variable | Runtime | Frontend exposed? | Notes |
|----------|---------|-------------------|-------|
| `MINDBODY_OAUTH_CLIENT_ID/SECRET` | Runtime Functions | No (id used server-side start) | Portal app |
| `MINDBODY_OAUTH_REDIRECT_URI` | Runtime | No | Must match Mindbody portal **byte-for-byte** |
| `MINDBODY_OAUTH_ISSUER` | Runtime | No | Default `https://signin.mindbodyonline.com` |
| `MINDBODY_OAUTH_SCOPES` | Runtime | No | Need `Mindbody.Api.Public.v6` + `offline_access` |
| `MINDBODY_OAUTH_SUBSCRIBER_ID` | Runtime | No | Optional |
| `MINDBODY_SESSION_SECRET` | Runtime | No | Seals `mb_sess` + default mobile JWT |
| `MINDBODY_OAUTH_ENSURE_STUDIO_CLIENT` | Runtime | No | Default on |
| `ENABLE_MOBILE_BEARER_AUTH` | Runtime | No | Default off |
| `MINDBODY_OAUTH_MOBILE_REDIRECT_URI` | Runtime | No | Portal extra redirect |
| `MOBILE_JWT_*` | Runtime | No | |
| `MINDBODY_API_KEY`, `SITE_ID`, `STAFF_*` | Runtime | No | Staff path |
| `STRIPE_*` | Runtime | Publishable key only | |
| `VITE_API_BASE` / `VITE_OAUTH_API_BASE` | App build | Yes | |

External: Mindbody Application Integration redirect list; Netlify env; Apple/Google consoles **do not exist yet**.

Preview vs prod: different redirect URIs; cookies do not carry across hosts.

---

# 27. Data model / persistence

| Store | What | Identity link |
|-------|------|----------------|
| `mb_sess` / mobile JWT | Tokens + client_id + flags | Ephemeral |
| Netlify Blobs `stripe-mindbody-orders` | Order + emails + client ids + deferred book | Commerce |
| Blobs subscriptions / consents / guest-pass / benefits / SMS | Ops | `mindbodyClientId` |
| Stripe Customer metadata | `mindbodyClientId` | Commerce |
| Mindbody | Studio Client + optional Consumer | Source of truth for credits |

**No internal durable user entity.** `amare_user_id` would be new (blobs or external DB). Nothing in-repo is a drop-in.

Relationship today:

```text
browser cookie  ↔  Consumer tokens  ↔  email/sub  ↔  studio clientId
Stripe customer  ↔  email / metadata.mindbodyClientId
booking intent   ↔  sealed clientId + classId
```

---

# 28. Race conditions

| Race | Existing protection | Residual risk |
|------|---------------------|---------------|
| New signup + purchase | Webhook create + OAuth ensure + addclient conflict re-search | Two emails → two clients |
| Existing client + future Google login | Email unique pick | Wrong email → new client |
| Webhook before success page | Poll order status; sync async | UI may say processing; credits exist |
| Two-tab book | Mindbody class capacity | Double-click / two tabs possible |
| Old Mindbody + new AMARÉ | **None** | Must design refuse-on-conflict |
| Double purchase | Stripe idempotency + order `onlyIfNew` + NCS policy | Anonymous NCS precheck gap |
| Double addclient | Conflict regex + re-search | Ambiguous → manual review |
| Anonymous purchase claimed by later login | Email match / OAuth merge | Different email → orphan + new |
| OAuth expires during purchase | Stripe does not need it | Live book after return may 401 |
| Session change during deferred book | Order stores `resolvedMindbodyClientId`; confirm-email checks session id match | Good |

---

# 29. Multi-tab / remembered users

- Web auth is **cookie, server-authoritative**. Tab B sees same `mb_sess` without refresh.  
- UI state is per-tab until `/oauth/session` runs.  
- Logout clears cookie → next request 401; other tabs update on next API/session call (no live sync).  
- Old `mb_sess` **survives deploy** until Max-Age or refresh failure (up to 30 days).  
- Future: Tab A `mb_sess` + Tab B `amare_sess` can disagree — see §5 dual-cookie rule.

---

# 30. Migration compatibility strategy

| Option | Complexity | Security | UX | Risk | Effort | Rollback |
|--------|------------|----------|----|------|--------|----------|
| **A Hard cutover** | Medium | Forces re-login; drops claim chance | Worst for current members | High support load; Book 401 | Lower eng, higher ops | Flip flag back **if** OAuth code kept |
| **B Dual auth** `amare_sess` preferred, `mb_sess` accepted | High | Safe if conflict refuses | Best | Implementation bugs | Highest | Keep both paths |
| **C Silent claim** valid `mb_sess` bootstraps AMARÉ user | Medium | Strong if one-time + verified Google/Apple | Best for linked users | Claim to wrong Google if tab confusion | Medium | Claim rows reversible if additive |
| **D Force re-login** everyone | Low | Clean | Harsh | Orphans if email ≠ Google | Low | Easy |

**Recommend: B + C (hybrid).**  
Ship AMARÉ Auth; keep accepting `mb_sess` for a bounded window; offer one-time claim when both a valid `mb_sess` and a new Google/Apple login are present **and** `client_id`s match / email verified. Hard cutover only after metrics show AMARÉ logins dominate.

---

# 31. Existing Mindbody session as migration proof

**Technically possible with current data.**

A valid `mb_sess` contains `refresh_token` (proves Consumer) + `client_id` + `consumer_associated`. Server can still `getSessionWithConsumerHeaders` and re-probe.

Claim design (not implemented):

```text
valid mb_sess (refresh works, client_id known, preferably associated)
 + new AMARÉ login (Google/Apple sub, verified email)
 → write amare_user_id ↔ client_id
 → future logins skip Mindbody
```

**Safer if emails match** or user confirms. **Unsafe** if you bind solely because two cookies exist in one browser (shared computer).

Expired/unlinked sessions are **not** sufficient proof.

---

# 32. Rollback

Keep intact:

- All `mindbody-oauth-*` routes and `mb_sess` seal format  
- `resolveConsumerClient` book path + `bookingAllowed` gate behind a flag  
- No destructive merge of Consumer identities  
- Additive `amare_user_id` mappings only (do not rewrite Mindbody emails)

Feature flags (conceptual):

```text
ENABLE_AMARE_AUTH=0|1
ACCEPT_MB_SESS=1          # default on during hybrid
BOOKING_REQUIRE_CONSUMER_ASSOCIATION=1  # default on until Staff-book proven
ENABLE_MOBILE_BEARER_AUTH  # already exists
```

Rollback = flags off. Customers with only AMARÉ accounts would need to use Google/Apple still **or** sign in with Mindbody if they have it. Do **not** delete Studio Clients on rollback.

Avoid irreversible: auto-merge without audit, deleting `mb_sess` support, changing cookie name without dual-read.

---

# L. Migration blockers

### Must fix before migration

1. Member APIs require Consumer session (`resolveConsumerClient` / `getSessionWithConsumerHeaders`).  
2. Live Book 403 on `!bookingAllowed`.  
3. No `amare_user_id` store or session.  
4. Email collision policy for Google/Apple vs studio email (relay, mismatch, duplicates).

### Should fix before migration

5. Ship book-block observability (or stop relying on stale QA).  
6. Staff confirmation-email path (or AMARÉ-sent email).  
7. Dual-cookie conflict rule.  
8. Stop trusting body `knownMindbodyClientId` without session bind (or bind it to AMARÉ user).  
9. Tests for claim / Staff-book / no body clientId.

### Can fix later

10. Retire OAuth CTAs and Link Account copy.  
11. Mindbody EXPRESS / stored-cards (already off).  
12. Mobile secure storage.  
13. Classic Book URL fallback.

---

# M. Recommended target architecture

```text
Google / Apple / Email OTP
        ↓
   AMARÉ User (amare_user_id)
        ↓
 permanent association (server store)
        ↓
 Mindbody Studio clientId
        ↓
 Staff User Token + API Key
        ↓
 book / cancel / waitlist / wallet / fulfillment
```

- Users do not sign into global Mindbody for AMARÉ.  
- Link Account is not required for ordinary use.  
- `consumerAssociated` is not a book gate.  
- Consumer OAuth remains a **hidden fallback** (`ACCEPT_MB_SESS`) and a **one-time claim** tool.  
- Phone / waiver / credits stay business rules.

This matches what the repo already does for Stripe + deferred book.

---

# N. Recommended migration sequence (no code in this phase)

```text
Phase 0 — Observability + tests
  Restore/implement book-block structured logs.
  Add QA for Staff-book without association (behind flag, staging).

Phase 1 — Internal AMARÉ identity (additive)
  Design amare_user_id + identities + mindbody_client_id store.
  Do not change login UI yet.

Phase 2 — Dual auth transport
  Issue amare_sess; keep mb_sess.
  Middleware: prefer amare; accept mb; refuse on clientId conflict.

Phase 3 — Existing-account claim
  Valid mb_sess + new Google/Apple → bind.
  Apple relay / ambiguous → support, no auto-bind.

Phase 4 — Staff-based live booking (flag)
  BOOKING_REQUIRE_CONSUMER_ASSOCIATION=0 on staging.
  Book/waitlist/cancel/summary via Staff using server clientId.
  Compare confirmation email behavior.

Phase 5 — Remove consumerAssociated gate in production
  Only after Phase 4 metrics (book success, DeniedAccess=0, credit correctness).

Phase 6 — App auth switch (before store submit)
  Google + Apple native; Sign in with Apple required if Google is shown.
  Do not ship Mindbody-only app.

Phase 7 — Website login UI cutover
  Primary CTA Google/Apple/OTP. Mindbody link in “having trouble”.

Phase 8 — Monitor
  Link Account rate, 403 studio_not_linked, duplicate clients, claim conflicts.

Phase 9 — Retire Mindbody OAuth as login
  Keep Staff + portal credentials. Optionally keep OAuth app for claim/support.
```

---

# O. Rollback plan

1. Keep OAuth code and `mb_sess` format unchanged during Phases 1–8.  
2. Flags: disable AMARÉ login CTA; `ACCEPT_MB_SESS=1`; restore association gate.  
3. Do not require customers to be “migrated back” — their Studio Client and credits never moved.  
4. AMARÉ-only users (never had Mindbody login) keep AMARÉ login even if association gate returns (they cannot Book until Staff-book flag stays on **or** they create Consumer — product choice).  
5. No irreversible account transformation in Phases 1–3.

---

# P. QA matrix (required before rollout)

### Authentication

- [ ] Existing linked Mindbody user — claim + Book  
- [ ] Existing unlinked Mindbody user — Staff-book without Link Account  
- [ ] Studio client only (Stripe, never OAuth)  
- [ ] Brand-new user  
- [ ] Google login  
- [ ] Apple login + Hide My Email  
- [ ] Email OTP (if in scope)  
- [ ] Changed email  
- [ ] Duplicate email / duplicate studio profile  
- [ ] Logout / login / new browser / existing browser  
- [ ] Expired `mb_sess`  
- [ ] Dual cookie same client / different client  

### Booking

- [ ] Active credit / no credit / NCS / drop-in / membership / pack  
- [ ] Class full / waitlist / window closed / duplicate visit  
- [ ] Invalid credit / canceled class  

### Purchasing

- [ ] `/pricing` anonymous + logged-in  
- [ ] Package from failed book + auto-book  
- [ ] Membership + one-time  
- [ ] Abandoned / success / delayed webhook / duplicate webhook / webhook fail  
- [ ] Purchase without prior Studio client  

### Cancellation

- [ ] Early / late / waitlist remove / after auth transition  

### Account

- [ ] Wallet, upcoming, history, profile, phone, credits, expiration, membership  

---

# Q. Exact files likely to change later

**Do not modify in this audit.**

### Website frontend

`src/js/mindbody-auth.js`, `classes-schedule.js`, `member-dashboard.js`, `header-members.js`, `pricing-api.js`, `stripe-express-cta.js`, `checkout-success.js`, `mindbody-wallet-widget.js`, `member-bring-a-friend.js`, `benefits-redeem.js`  
`src/content/classes.html`, `pricing.html`, `mindbody-member.html`, `mindbody-login.html`, `checkout-success.html`

### Website backend / serverless

`netlify/functions/mindbody-oauth-*.mjs`, `oauth-lib.mjs`, `mobile-auth-lib.mjs`, `mindbody-consumer-lib.mjs`

### Mindbody integration

`mindbody-upstream.mjs`, `mindbody-class-book.mjs`, `mindbody-class-book-lib.mjs`, `mindbody-class-cancel.mjs`, `mindbody-class-waitlist-remove.mjs`, `mindbody-member-summary.mjs`, `mindbody-client-stored-cards.mjs`, `mindbody-sale-*.mjs`

### Stripe

`stripe-create-checkout-session.mjs`, `stripe-webhook.mjs`, `stripe-mindbody-sync-lib.mjs`, `stripe-order-store.mjs`, `stripe-subscription-store.mjs`

### Booking

`mindbody-deferred-class-book.mjs`, `mindbody-pending-book-intent-lib.mjs`, `classes-auto-book-lib.mjs`

### Mobile app

`amare-app/src/api/auth.ts`, `auth/AuthContext.tsx`, `api/client.ts`, `config.ts`, `lib/booking-link.ts`, `screens/*`, `capacitor.config.ts`

### Shared libraries / tests / config

`netlify.toml`, `.env.example`, `docs/MINDBODY.md`, `docs/AMARE-APP-*.md`, `docs/CLASSES-BOOK-BLOCK-PHASE1.md`, `scripts/qa-*.mjs`, `scripts/smoke-book-block-browser.mjs`

---

# R. Confidence / unknowns

| Item | Confidence | Why unresolved |
|------|------------|----------------|
| Live `classes-schedule.js` lacks Phase 1.2 matrix | **High** | Grep: no `book_block_variant` |
| Mindbody Staff `addclienttoclass` works without Consumer | **High** | Production deferred book + staff payment fallback |
| Staff `SendEmail:true` confirmation reliability | **Medium** | Code comments say staff 200 may not send email; not re-tested in this audit |
| Whether Mindbody will keep allowing Staff self-serve-scale booking | **Unknown** | Contract/ToS with Mindbody — not in repo |
| Exact production `ENABLE_MOBILE_BEARER_AUTH` | **Unknown** | `.env.example` default 0; Netlify prod values not read (secrets) |
| Whether Mindbody IdP still shows Google/Apple on their page | **Unknown** | External IdP UI; `AMARE-APP-PLAN.md` §10.3 asserts yes as of planning date |
| `pack_5` / Classic-only SKU live mix | **Medium** | Catalog `enabled: false` for 5-pack; Classic still used for some memberships if recurring flag off |
| Waiver as Mindbody field | **Low** | Not a website book gate; in-studio process not in code |
| Account deletion for App Store | **Unknown** | Checklist exists; no AMARÉ user store to delete yet |

Did **not** run production log queries or live Mindbody API calls in this audit.

---

# 35. Required questions — explicit answers

1. **Can a customer book entirely without Mindbody Consumer OAuth today using existing backend capabilities?**  
   **Partially.** Deferred/Staff book after Stripe **yes**. Live `/class/book` **no** (session + `bookingAllowed`).

2. **If not, what exact pieces prevent it?**  
   `resolveConsumerClient` (`mindbody-consumer-lib.mjs` ~1942) and `if (!link.bookingAllowed) 403` (`mindbody-class-book.mjs` ~136–163). Frontend `oauthBookingAllowed` (`classes-schedule.js` ~3949).

3. **Is `consumerAssociated` required by Mindbody for booking, or an AMARÉ rule?**  
   **Both layers.** AMARÉ **application rule** blocks before the call. Mindbody **Consumer** API also 401s if unassociated. Mindbody **Staff** API does not need it.

4. **Can Staff API safely replace every Consumer booking path?**  
   **Book/cancel/waitlist/credits: yes in capability.** Confirmation email and “user proved they own the Consumer” are the gaps. Safety depends on AMARÉ session binding, not Staff itself.

5. **Staff vs Consumer behavior differences?**  
   Staff: no association, may not send reservation email, can see/book services consumer cannot, used for late cancel. Consumer: email on book, association required, directory search often 401.

6. **Can `/pricing` operate without Mindbody OAuth?**  
   **Yes.**

7. **Can purchase-from-booking operate without OAuth?**  
   **Anonymous path yes.** Logged-in 402 path today requires association to reach 402. After Staff-book, yes.

8. **Can deferred booking operate without OAuth?**  
   **Yes** (already).

9. **Can waitlist operate without OAuth?**  
   **Not today.** No Staff add/remove.

10. **Can cancellation operate without OAuth?**  
    **Not today** for the primary member path. Staff late-cancel exists.

11. **Can wallet/dashboard load without OAuth?**  
    **Not today.** Endpoint requires Consumer session. Data is mostly Staff-fetchable.

12. **Saved-card features dependent on Consumer OAuth?**  
    Mindbody stored-cards **yes** (feature off). Stripe Pay **no**.

13. **What happens to users with remembered `mb_sess`?**  
    Cookie remains valid up to 30 days or until refresh fails. Hard cutover ignores it → logged out. Dual auth keeps them working.

14. **Can valid Mindbody sessions bootstrap AMARÉ identity?**  
    **Yes**, if refresh still works and `client_id` is known. One-time claim. See §31.

15. **Can `mb_sess` and `amare_sess` coexist?**  
    **Yes** (names differ). Safe only with an explicit conflict rule — do not silently trust one.

16. **What prevents User A acting on User B’s clientId?**  
    Today: sealed OAuth session + server resolution + no book body clientId. Future: must be `amare_user_id` bind. Stripe body `knownMindbodyClientId` is the weak spot.

17. **Endpoints that trust frontend `clientId`?**  
    Stripe create-session `knownMindbodyClientId` (prefill/NCS/order). Admin follow-ups. Dev guest-pass reset. **Not** book/cancel.

18. **How are duplicate Studio clients prevented?**  
    `pickCanonicalClient`; no create on ambiguous; addclient conflict re-search; optional post-OAuth merge.

19. **Google/Apple email ≠ Mindbody email?**  
    No auto-link. Risk of a second Studio Client if ensure/create runs. Need claim or staff.

20. **Apple Hide My Email?**  
    Already `apple_relay_email`; no auto-create. Same failure under native Apple Sign-In unless real email is shared.

21. **Is the mobile app deep enough on Mindbody OAuth that changing before launch is easier?**  
    **Yes.** Phase 1 UI exists; not in stores; auth is a thin redirect + exchange.

22. **Can website and app share one AMARÉ identity?**  
    **Yes.** Dual transport already exists (`resolveSessionFromRequest`).

23. **Minimum safe migration before removing Link Account?**  
    AMARÉ session → stored `clientId` + Staff live Book (flag) + collision policy + observability. Then drop `bookingAllowed` gate.

24. **Single biggest production risk?**  
    **Acting on the wrong `clientId` after email-based claim or dual-session conflict** (User A books/cancels as User B), plus support load if cutover logs everyone out.

25. **Final recommendation:**

```text
MOVE TO AMARÉ AUTH
```

Keep Mindbody as the **operations backend**, not the **login**. Use **HYBRID transport** during rollout (`mb_sess` accepted, `amare_sess` preferred). Do **not** keep Mindbody OAuth as the app’s primary login.

---

# Final block

```text
VERDICT:
GO WITH BLOCKERS

RECOMMENDED AUTH DIRECTION:
AMARÉ AUTH   (hybrid transition; Mindbody Staff/API remains)

CRITICAL BLOCKERS:
1. Live book / waitlist / cancel / member-summary require Consumer session + tokens.
2. bookingAllowed === consumerAssociated is a hard live-book gate.
3. No durable amare_user_id; email matching alone is unsafe for Apple relay, duplicates, and email mismatch.

HIGHEST-RISK CURRENT DEPENDENCY:
mb_sess Consumer tokens as the only website/app identity, combined with the consumerAssociated book gate — this is what forces Link Account. Highest migration risk is replacing that proof with email-only Staff actions on clientId.

SAFE FIRST IMPLEMENTATION PHASE:
Phase 0–1 only: observability/tests + additive identity store. Do not remove OAuth, do not flip bookingAllowed, do not launch the app on Mindbody-only auth.

FILES INSPECTED:
netlify/functions/oauth-lib.mjs
netlify/functions/mindbody-oauth-start.mjs
netlify/functions/mindbody-oauth-callback.mjs
netlify/functions/mindbody-oauth-session.mjs
netlify/functions/mindbody-oauth-session-build.mjs
netlify/functions/mindbody-oauth-logout.mjs
netlify/functions/mindbody-oauth-complete-studio-profile.mjs
netlify/functions/mindbody-oauth-mobile-*.mjs
netlify/functions/mobile-auth-lib.mjs
netlify/functions/mindbody-consumer-lib.mjs
netlify/functions/mindbody-class-book.mjs
netlify/functions/mindbody-class-book-lib.mjs
netlify/functions/mindbody-class-cancel.mjs
netlify/functions/mindbody-class-waitlist-remove.mjs
netlify/functions/mindbody-deferred-class-book.mjs
netlify/functions/mindbody-pending-book-intent-lib.mjs
netlify/functions/mindbody-member-summary.mjs
netlify/functions/stripe-create-checkout-session.mjs
netlify/functions/stripe-webhook.mjs
netlify/functions/stripe-mindbody-sync-lib.mjs
netlify/functions/stripe-order-store.mjs
src/js/mindbody-auth.js
src/js/classes-schedule.js
src/js/pricing-api.js
src/js/member-dashboard.js
src/js/checkout-success.js
amare-app/src/api/auth.ts
amare-app/src/auth/AuthContext.tsx
amare-app/src/lib/booking-link.ts
amare-app/src/config.ts
docs/MINDBODY-CONSUMER-STUDIO-LINK-DIAGNOSIS.md
docs/CLASSES-BOOK-BLOCK-PHASE1.md
docs/AMARE-APP-PLAN.md
docs/AMARE-APP-PHASE0.md
.env.example
scripts/qa-book-block-logic.mjs
(+ related sale/benefits/guest-pass references)

TESTS RUN:
NONE (read-only diagnosis; no test execution)

CODE CHANGES:
NONE
```
