# סיכום: Mindbody Checkout, `/pricing` ומסלולי הרכישה

מסמך זה מתאר את האינטגרציה הנוכחית ואת ההבחנה בין **מצב Classic** (פרודקשן כעת) לבין **מצב EXPRESS** עם Mindbody Public API ובין **EXPRESS עתידי** (Stripe או PSP אחר ללא ארנק Mindbody בתוך הדף).

פירוט ארוך (משתני סביבה, Sandbox מול Live, טונלים): **`MINDBODY.md`**  
מפת נתיבים: **`URL-MAP.md`**  
מיפוי ל־Functions: **`netlify.toml`**  
שאלות טרם החלטה ל־Stripe: **`docs/STRIPE-MINDBODY-QUESTIONS.md`**, **`docs/products-checkout.md`** (הפניות)

---

## מצב פרודקשן כעת — Classic במחירון

ברירת המחדל ב־**`src/js/pricing-api.js`** היא **`PRICING_MINDBODY_EXPRESS_CHECKOUT_ENABLED = false`**.

| התנהגות | תיאור |
|--------|--------|
| Subscribe / Buy | לחיצה פותחת **מיד** (בלי דיאלוג ביניים) קישור **Mindbody Classic** בטאב חדש, עם `noopener noreferrer`. |
| בניית URL | פונקציה **`buyHref(row)`**: `https://clients.mindbodyonline.com/classic/ws?studioid=<cfg>&stype=<saleType>&prodid=<id>` כאשר **`stype`** — חבילות מ־`packageSaleType`, מנוי חוזה מ־`contractSaleType`; **`prodid`** מזהות השירות/מוצר מהשורה (`productOrServiceId`). |
| Studio id | מתוך קונפיג הדף (למשל `classicStudioId` ב־`mb-pricing-config`). |
| מגבלה | רק כשלא ניתן לבנות Classic URL (חסר `studioid` / מזהה מוצר) נשמרת הגישה הישנה עם **דיאלוג** והודעת שגיאה. |

**חשוב:** הפתיחה לטאב נעשית **בלי `await`** לפני כל הבדיקות, כדי לשמור על מחוות משתמש ולצמצם חסימת popup.

---

## דגל EXPRESS — זרימת Mindbody בתוך האתר (מושבתת כעת)

כאשר **`PRICING_MINDBODY_EXPRESS_CHECKOUT_ENABLED = true`** בתוך `pricing-api.js`:

1. למחירון חוזר **דיאלוג checkout** עם OAuth, פרומו, dry-run / חיוב, וקריאות ל־API.
2. **Preflight ארנק:** נקרא **`GET /api/mindbody/client/stored-cards`** לאחר **`/oauth/session`** (לא להריצם במקביל — אותה רוטציית refresh token).
3. **רכישה חיה** מתוך הדף: **`POST /api/mindbody/sale/checkout`** (חבילות) ואו **`POST /api/mindbody/sale/purchase-contract`** (חוזים/מנויים מתאימים), כפופה להגדרות סביבה (למשל **`MINDBODY_ALLOW_LIVE_PRICING_CHECKOUT`**).

כל לוגיקת הדיאלוג, פרומוטים והטפסים למנוי **נשארת בקוד** לצורך חידוש מלא של מסלול Mindbody בעת הצורך.

---

## בר הזדהות — בדיקת כרטיס שמור Mindbody (`mindbody-auth.js`)

קבוע **`AUTH_MINDBODY_WALLET_PROBE_ENABLED = false`** (באותה תקופת Classic-first).

| מצב | התנהגות |
|-----|----------|
| `false` | **אין** קריאת `/client/stored-cards` בשביל Badge; הפונקציות לרצועת ארנק **נשארות** למועד החיבור של EXPRESS שאינו דרך Mindbody (Stripe וכדומה). |
| `true` + דף pricing בר־pathname | מתבצעת בדיקה אסינכרונית ומוצג/מוסתר הסטטוס הרלוונטי ברצועת ההתחברות. |

---

## ארנק Mindbody וה־PurchaseContract (מתוך הקוד הנוכחי)

- **`GET /api/mindbody/client/stored-cards`** — המשמש כמקור ל־`hasStoredCard` ל־UI כשה־Mindbody APIs מוחזקים במצב EXPRESS בלבד (`reliableLastFourFromWalletCards` בתוך `mindbody-consumer-lib.mjs`; דחייה של placeholder **`0000`**).
- **`POST …/purchase-contract`** (חייב live): משתמש ב־**`StoredCardInfo` בלבד בצורת המודל המתועד `{ LastFour: "abcd" }`**. **לא נשלחים** בתוך הבקשה `StoredCardId` / מזהי Id של כרטיס עד שהתקבלות מול Mindbody מאומתת בבדיקה חיה/דריי־ראן מפורשת.
- **`CreditCardInfo`** (הזנה מלאת כרטיס בבקשה) — **לא מומש** בהכוונה.

אם חסר last-four מה־Public API מהימן — מתקבל **`no_stored_card`** מהשרת; המפתח הפך גם אל מסלול hosted/classic (כשנדליק Express עם Mindbody).

---

## מה קיים בשכבת השרת (תזכורת)

- **`POST /api/mindbody/sale/checkout`** — עוטף `CheckoutShoppingCart` עם טוקן צוות ובקשות Consumer OAuth בהתאם למימוש.
- **`POST /api/mindbody/sale/purchase-contract`** — חוזים חוזרים כשמתאימים לשירות.
- **`GET /api/mindbody/sale/services`**, **`GET /api/mindbody/sale/contracts`** — פרוקסי קטלוג.
- **`POST /api/mindbody/sale/checkout-warmup`** — הקדמה לזמינות סשן צוות.
- **Blobs** — הסכמות מנוי / idempotency לפי env (פרטים ב־`.env.example` / `MINDBODY.md`).
- פונקציות נוספות כגון **`mindbody-client-register.mjs`** / **`mindbody-wallet-widget.js`** מתועדות בקבציהן וב־`netlify.toml`.

---

## זרימת משתמש — Classic (ברירת מחדל)

1. כניסה ל־**/pricing** עם קטלוג ממשקי Sale.
2. לחיצה על Subscribe או Buy — **פתיחה ישירה** של Classic (`buyHref`).
3. אין דרישת OAuth באתר לצורך לחיצת הכפתור (אין דיאלוג ביניים).

---

## זרימת משתמש — כשמפעילים EXPRESS ב־`pricing-api.js`

1. פתיחת דיאלוג → ספינר “Checking your account…” עד לסיום `fetchSession` + `stored-cards` (כשנדליק).
2. Dry run ברירת מחדל; חיוב חי עם אישורים ומשתני אבטחה בסביבה.
3. פרומוטים והתנהגות עגלה — כפי שנבנית בשרת וב־`pricing-api.js`.

---

## בעיות שטופלו חשובות (Mindbody quirks)

### כפילות שורות בעגלה

ב**CheckoutShoppingCart** ניסויים קודמים עם כפילות מפתחות (`items`/`Items`) יצרו **שורה כפולה** וכפילות סכום.  
**פתרון:** גוף בקשה **PascalCase אחיד**, שורת עגלה אחת, בלי במקביל משקלי camelCase מכפילים.

### פרומוטים ובעיקר 100% הנחה

- סכום שורות **Payments** צריך להתאים ל־**GrandTotal** אחרי פרומו.
- עגלה ב־$0 דורשת שורת **Comp** מתאימה (לא `Payments` ריק).
- טיפול בשגיאות טקסט מסוג *payment total … does not match …* בשרת.

### תצוגת הנחה בתשובה

**`DiscountTotal`** / **`GrandTotal`** לעומת **SubTotal** — נורמלי ש־`DiscountAmount` בשורת פריט הוא 0 כשפרומוט מוזן רק ברמת העגלה.

---

## פיתוח מקומי וטונל

- **`npm run dev`** / **`dev:full`** → **`scripts/unified-local-dev.mjs`** (בדרך־כלל פורט **4321**) שמריץ את **אותן Functions** כמו Netlify.
- מנהרה (ngrok וכדומה) צריכה להצביע אל **4321**, לא פרוקסי Mindbody‑only על 8787 בלבד — אחרת **`POST …/checkout`** עלול להחזיר 404/HTML.

---

## פריסה (Netlify)

אחרי `git push`: וידוא ש־**`netlify.toml`** כולל redirects ל־`sale/checkout`, `sale/purchase-contract`, `client/stored-cards`, וכו’. Functions תחת **`netlify/functions/`**.

---

## קבצים מרכזיים

| נושא | קבצים |
|------|--------|
| UI מחירון + Classic ישיר / דיאלוג EXPRESS | **`src/js/pricing-api.js`**, **`src/content/pricing.html`** |
| OAuth strip + ארנק (אופציונלי) | **`src/js/mindbody-auth.js`** |
| ספריית לקוח / ארנק | **`netlify/functions/mindbody-consumer-lib.mjs`** |
| ארנק ב־API | **`netlify/functions/mindbody-client-stored-cards.mjs`** |
| Checkout / PurchaseContract | **`netlify/functions/mindbody-sale-checkout.mjs`**, **`mindbody-sale-purchase-contract.mjs`** |
| הסכמות מנוי | **`netlify/functions/mindbody-membership-electronic-consent.mjs`** |
| עיצוב | **`src/css/components-pricing.css`**, **`src/css/components-mindbody.css`** |
| Stripe / שאלות לפני מימוש | **`docs/STRIPE-MINDBODY-QUESTIONS.md`** |

---

## Stripe → Mindbody one-time express checkout

Stripe-hosted checkout (Apple Pay / Google Pay / Card / Link) for **one-time** AMARÉ packages.
Recurring memberships and contracts continue to use Mindbody classic / `purchase-contract`
and are intentionally **excluded** from this flow. Decisions log:
**`docs/STRIPE-MINDBODY-QUESTIONS.md`**.

> **TL;DR for support:** Stripe collects payment + customer details (email/name/phone). The
> webhook then resolves-or-creates a Mindbody client, adds the purchased Service to that
> client, and (for brand-new clients) triggers Mindbody's password-setup email. Mindbody is
> source of truth for clients & class credits. Stripe is source of truth for the money. The
> local order store is only for sync state and reconciliation.

### Inspection finding (verified before code)

One-time packages (NCS, drop-in, 10/20 class packs) are **`Type: "Service"`** in
CheckoutShoppingCart, identified by `Metadata.ServiceId` — Mindbody Pricing Options sourced
from `GET /sale/services?SellOnline=true`. Verified in `mindbody-sale-checkout.mjs`
(`buildCheckoutPayload`). They are **not** `Product`, **not** `Contract`. Pinned IDs live in
the catalog config so we never rely on name-matching at runtime.

### High-level flow

```
Anonymous buyer (or logged-in member) clicks "Buy Now" on /pricing
        │
        │  (drop-in / packs only) anonymous → Soft sign-in gate dialog
        │       ┌────────────────────────────┐
        │       │ "Sign in" → Mindbody OAuth │   "Continue" → Stripe
        │       │                            │   "Cancel"   → close
        │       └────────────────────────────┘
        ▼
POST /api/stripe/checkout/create-session     (server validates SKU, amount, NCS-by-known-client)
        │
        ▼
Stripe-hosted Checkout (collects email + name + phone; Apple Pay / Google Pay / Card / Link)
        │
        │  (Stripe → /checkout/success?orderId=…&session_id=… on completion)
        │  (Stripe → POST /api/stripe/webhook  signed webhook = source of truth)
        ▼
Webhook decideTestModeBehavior():
        │   • Stripe live    → behavior=live, sync to Mindbody for real
        │   • Stripe test    → behavior from STRIPE_TEST_MODE_MINDBODY_BEHAVIOR
        │       └ skip          → mark order "test_mode_no_sync", DO NOT touch Mindbody
        │       └ mindbody_test → call Mindbody APIs with `Test:true` (dry-run, nothing persisted)
        │       └ live          → operator override; sync for real (rarely used)
        ▼
Resolve or create Mindbody Client:
        │   • known clientId from session → use it
        │   • else search by email
        │       ├ exactly 1 confident match → use it
        │       ├ multiple matches         → mark paid_but_not_synced (manual review)
        │       └ zero matches             → addclient (NEW client created)
        ▼
[NCS-only, anonymous] If client was matched (not created) and they have NCS history:
        → mark paid_but_not_synced, reason "ncs_for_existing_client"
        ▼
syncOneTimePurchaseToMindbody (CheckoutShoppingCart):
        │   Items: [{ Type:"Service", Metadata:{ ServiceId } }]
        │   Payments: [{ Type:"Custom", Name:"Stripe", PayNotes:"orderId=…; session=…; sku=…" }]
        │   GrandTotal must match Stripe amount; idempotent.
        ▼
Order → "mindbody_synced". If a NEW Mindbody client was created in this flow AND we are not
in mindbody_test dry-run, fire Mindbody's POST /client/sendpasswordresetemail (best-effort).
        ▼
Customer lands on /checkout/success which polls /api/stripe/order-status:
        │   bucket=synced, clientWasNewlyCreated, welcomeEmailSent → masked email "sn***@…"
        │   CTA primary swaps to "Sign in with Mindbody" (?return=/classes) for new clients
        │   CTA primary stays "Book a class" for existing/logged-in clients
        ▼
New client clicks email link → sets password → signs in via Mindbody OAuth → returns to
/classes with their NCS package live in their account.
```

### Files

| Concern | Path |
|---|---|
| Catalog (server-side, source of truth for amount + Mindbody Service IDs + per-SKU enable flags) | `netlify/functions/_embedded/stripe-mindbody-catalog.config.json` |
| Catalog loader / validation / public embed builder | `netlify/functions/stripe-catalog-lib.mjs` |
| Order store (Netlify Blobs adapter — Q2 = C; in-memory dev fallback) | `netlify/functions/stripe-order-store.mjs` |
| Sync lib: resolve-or-create client, NCS history, sync, password-setup email, `splitFullName` | `netlify/functions/stripe-mindbody-sync-lib.mjs` |
| `POST /api/stripe/checkout/create-session` | `netlify/functions/stripe-create-checkout-session.mjs` |
| `POST /api/stripe/webhook` (source of truth for fulfillment) | `netlify/functions/stripe-webhook.mjs` |
| `GET /api/stripe/order-status` (public, masks email, used by /checkout/success) | `netlify/functions/stripe-order-status.mjs` |
| Admin retry / list (gated by `ADMIN_DEBUG_TOKEN`) | `netlify/functions/stripe-admin-orders.mjs` |
| Discovery script for Mindbody Service IDs (one-shot) | `scripts/stripe-find-mindbody-service-ids.mjs` (`npm run stripe:find-mb-ids`) |
| Customer pages (centered card, mobile-responsive, onboarding banner, dynamic CTAs) | `src/content/checkout-success.html`, `src/content/checkout-cancel.html`, `src/js/checkout-success.js`, `src/css/components-checkout-status.css` |
| Express CTA + soft sign-in gate on `/pricing` | `src/js/pricing-api.js` (`stripeExpressEligibilityForRow`, `showSoftSignInGate`, `openCheckoutFlow`) |
| Static NCS card on `/pricing` (above-the-fold; uses `pricing-api.js`'s `[data-mb-checkout]` delegation) | `src/content/pricing.html` |
| Static NCS card on `/` (homepage promo) and `/first-visit` (landing page) — shared standalone handler | `src/content/home.html`, `src/content/first-visit.html`, `src/js/stripe-express-cta.js` |

### Catalog (source of truth)

`netlify/functions/_embedded/stripe-mindbody-catalog.config.json` — never trust the client.
The frontend reads a sanitized embed (`buildPublicCatalogEmbed`); pricing and Mindbody IDs
are read server-side at create-session and webhook time.

| `localSku` | Display | `mindbodyItemType` | `mindbodyServiceId` | Amount | `enabledForExpressCheckout` | Notes |
|---|---|---|---|---|---|---|
| `new_client_special_3_for_65` | New Client Special — 3 Classes | Service | **100012** | $65.00 | ✅ | NCS — anonymous OK; `oneTimePerClient`, `duplicatePolicy: "block_before_checkout_if_known"` |
| `drop_in_single_class` | Drop-in Single Class | Service | (pinned) | $40.00 | ✅ | Soft sign-in gate for anonymous |
| `drop_in_same_day` | Drop-in Same-Day | Service | (pinned) | (pinned) | ✅ | Soft sign-in gate for anonymous |
| `pack_10_classes` | 10 Class Pack | Service | (pinned) | $269.00 | ✅ | Soft sign-in gate for anonymous |
| `pack_20_classes` | 20 Class Pack | Service | (pinned) | $479.00 | ✅ | Soft sign-in gate for anonymous |
| `pack_5_classes` | 5 Class Pack | Service | `null` | — | ❌ | Disabled — does not exist in Mindbody |

To rediscover IDs after Mindbody catalog edits: `npm run stripe:find-mb-ids` (uses staff token,
prints `Service` rows with `Metadata.ServiceId` and prices).

### Money flow & Mindbody accounting (Q1)

The customer is charged **once, in Stripe**. The Mindbody sync books the same line as paid via
the **custom payment method named `Stripe`** (Mindbody Site Settings → Payment Methods → add
custom method `Stripe`, `Type: "Custom"`, with PayNotes enabled, label `Stripe Order ID`).
PayNotes are populated with a safe, non-PII reference:

```
orderId={orderId}; session={checkoutSessionId}; sku={localSku}
```

Production setting: `MINDBODY_STRIPE_PAYMENT_MODE=custom`. `comp` is a dev fallback that is
**never** silently selected on failure — if Mindbody rejects the custom payment row in
production, the order is parked at `paid_but_not_synced` for manual review via the admin
endpoint. There is no automatic Comp fallback in the live path.

### Status machine

```
checkout_created
  → payment_completed
  → client_resolving
  → (client_created | client_found)
  → mindbody_checkout_started
  → mindbody_synced
```

Failure terminals: `paid_but_not_synced`, `sync_failed_retryable`, `manual_review`,
`refunded`, `canceled`, `test_mode_no_sync` (Stripe-test skip mode).

**Idempotency.** The webhook is gated by status transitions. Once an order reaches
`mindbody_synced` (or `refunded` / `test_mode_no_sync`), duplicate Stripe deliveries return
200 with `noop: true`. Stripe is configured with a single endpoint URL (idempotency key per
event-id is enforced by Stripe). The order store uses `setJSON({ onlyIfNew })` for
order-create races and per-orderId reads for transitions.

### Anonymous-buyer onboarding (welcome email + first sign-in)

When a brand-new Mindbody client is created during a Stripe checkout, two things happen:

1. **Mindbody auto-sends the "Welcome New Client" email** as soon as `addclient` runs. This
   is the studio-level template (managed in Mindbody Manager → Communications → Email
   templates → "Welcome to <STUDIONAME>"). Our customised version of that template is
   documented in [`./EMAIL-DESIGN-SYSTEM.md`](./EMAIL-DESIGN-SYSTEM.md). It tells the buyer
   to come back to `/classes` and click "Sign in with Mindbody".
2. **Best-effort follow-up:** we also call `POST /public/v6/client/sendpasswordresetemail`
   with `{ UserEmail, UserFirstName, UserLastName }`. This is purely belt-and-braces — the
   API returns 200 even when no email is actually sent (Mindbody silently skips the call
   for clients that don't have a Mindbody Identity record yet, which is the common case
   for fresh `addclient` accounts).

**Important Mindbody behaviour we discovered empirically**:

- For clients created via the Public API, `<CLIENTPASSWORD>` in the Welcome template is
  **always empty**. Mindbody does NOT generate a temporary password for API-created
  clients — this is a security feature, not a bug.
- On the very first sign-in attempt, Mindbody recognises the client has no password set
  and prompts them to **create one inline**. There is no temporary password to enter and
  no separate password-reset link required.
- Therefore the Welcome email template **must not** include `<CLIENTPASSWORD>`. The
  current AMARÉ template instead shows a 3-step "Getting started" walkthrough that ends
  with "you'll be prompted to set your password on first sign-in".

**Code policy**:
- The `sendpasswordresetemail` call is gated on `resolved.clientCreated === true` AND
  `!testModeDecision.mindbodyTest` (no emails to real customers from dry-run flows).
- Failure does NOT roll back the order. The webhook patches `welcomeEmailSent: false` +
  `welcomeEmailError: <safe>` and logs `console.warn`.
- Customers who matched an **existing** Mindbody client get no extra welcome email —
  they already have an account and a password.

**Success-page UX for new clients**:
- Banner: "Check your email · sn\*\*\*@… — your welcome from Mindbody is on the way."
- Primary CTA swaps to **"Sign in with Mindbody"** instead of "Book a class".
- After they sign in (and set a password on first attempt), they land on `/classes`
  and can book.

#### Anonymous-buyer name capture on Stripe Checkout (`custom_fields`)

Stripe-hosted Checkout exposes `customer_details.name` as a **single string**. Sources
vary widely and are unsplittable when the value has no spaces:

| Wallet / source | Typical value |
|---|---|
| Card cardholder textbox | "snir" (whatever they typed) |
| Apple Pay / Google Pay | name from the wallet provider |
| Link saved profile | display name on the Link account |
| Klarna / Affirm | name supplied during the BNPL flow |

A wrong split sabotages Mindbody Identity's auto-link logic on first sign-in (more on
that just below). Fix: when we don't already have a clean Mindbody profile name
(`mindbodyContact.firstName && mindbodyContact.lastName`), `stripe-create-checkout-session.mjs`
adds `custom_fields: [{ key: "first_name" }, { key: "last_name" }]` to the session
(both required, 1–80 chars). The webhook reads `session.custom_fields[]` via
`extractCustomFieldNames` and passes the values straight to `resolveOrCreateMindbodyClient`,
which **prefers them over `splitFullName(fullName)`** when both are present.

Logged-in members are not asked again — `mindbodyContact` already carries first+last from
their Mindbody profile. The `OrderRecord` persists `customerFirstName` /
`customerLastName` so admin retries get the same clean signal without re-parsing.

#### Mindbody Identity auto-link behaviour (verified May 13 2026)

When the buyer signs in for the first time via OAuth on `/classes`, Mindbody Identity
applies the following logic against the studio's existing Studio Clients:

| First+Last+Email match? | Identity's action |
|---|---|
| Exact match on first+last+email | **Auto-links** the new Identity account to the existing Studio Client. No duplicate. |
| Email matches but names differ (or one of them is empty) | **Creates a brand-new Studio Client** at this site bound to Identity. The email-twin Studio Client (created earlier by `addclient` with the package) is left orphaned. |

This is why `custom_fields` matters: clean first+last from the buyer themselves
maximises the chance of an auto-link, which is the **happiest** path (no merge needed).
If Identity still creates a duplicate (typos, different name conventions), the
auto-merge below cleans it up.

#### Auto-merge duplicate Studio Clients on OAuth callback

The auto-merge runs every OAuth callback as a safety net for the cases where
`custom_fields` couldn't prevent the duplicate. Mindbody's Public API V6 ships a native
`POST /public/v6/client/mergeclients` endpoint that atomically transfers all Source data
(services, visits, contracts, purchase history) into Target and consumes Source.

We call it from `mindbody-oauth-callback.mjs` immediately after the token exchange and
**before** the cookie + redirect, so by the time the user lands on `/classes` the merge
is already complete and the wallet shows the package right away.

```
mindbody-oauth-callback.mjs (handler)
  ├─ exchangeAuthorizationCode(code) → tokens
  ├─ decodeJwtPayload(id_token + access_token) ⊕ fetchUserInfo(access_token) → claims
  ├─ profileFromClaims(claims) → { sub, email, name }
  ├─ pickMindbodyClientId(claims) ?? scanMindbodyClientIdFromClaims(claims) → mbClientId
  │
  ├─ if mbClientId == null:                                   ← see "JWT reality" below
  │     ├─ log claims-shape diagnostic (keys + value types only, no values)
  │     ├─ build mindbodyConsumerHeaders(access_token)
  │     └─ tryResolveClientId(synthSession, email, headers, access_token)
  │           ├─ /public/v6/client/clientcompleteinfo  ← canonical "who am I?"
  │           ├─ search by email (single match → use it)
  │           └─ search by name (single match → use it)
  │
  ├─ ★ runPostOAuthAutoMerge({ mbClientId, email }) ★         ← see "Merge logic"
  │     ├─ search clients by email (staff token)
  │     ├─ for each row whose id !== mbClientId:
  │     │     POST /client/mergeclients
  │     │       SourceClientId = duplicate (orphan)
  │     │       TargetClientId = mbClientId  ← Identity-bound, kept
  │     └─ wrapped in 12s overall race + try/catch (NEVER fails OAuth)
  │
  ├─ Set-Cookie mb_sess  (sealed payload includes resolved mbClientId)
  └─ 302 → /classes
```

**JWT reality — Mindbody Identity does NOT include numeric Studio Client ID in claims**

Verified empirically (snir14@pic-smart.com, May 13 2026): the JWT id/access tokens
returned by Mindbody Identity contain only **Identity-side** identifiers, not the
numeric Mindbody Studio Client ID. Concretely the claims set looks like this:

| Claim | Format | What it is |
|---|---|---|
| `sub` | 24-char GUID | Identity user GUID |
| `client_id` | 36-char UUID | **Our OAuth app's** client_id, NOT the buyer's Studio Client |
| `legacy_identifier` | 36-char UUID | Identity-side legacy id, NOT a Mindbody numeric id |
| `nameid` / `unique_name` | usually the email | not numeric |
| `https://auth.mindbodyonline.com/claims/membershipidentifier` | 36-char UUID | Identity membership id, NOT site client |

Both `pickMindbodyClientId` (which checks well-known keys) and
`scanMindbodyClientIdFromClaims` (regex scan) return `null` because nothing matches
`^\d+$`. The early-return in `runPostOAuthAutoMerge` would skip the whole merge with
`reason: "invalid_mb_client_id"` and the orphan duplicate would persist forever.

**The fallback resolver** (`tryResolveClientId`, imported from `mindbody-consumer-lib.mjs`):

This is the same multi-strategy resolver `/api/mindbody/member/summary` uses for the
wallet on `/classes`. The OAuth callback now calls it whenever the JWT path misses, with
consumer headers built from the user's fresh access token. It walks four strategies in
order, the first verified hit wins:

1. JWT claims (already failed if we got here).
2. Synthetic session's `client_id` (always `null` in this fallback path).
3. **`GET /public/v6/client/clientcompleteinfo`** — the canonical "who is the linked
   client for this Identity user?" endpoint. Returns the Identity-bound Studio Client
   directly. This is the strategy that resolves `100002746` for snir14@pic-smart.com.
4. Email search → name search (only if `clientcompleteinfo` failed).

**Merge logic — direction rule** (which one is kept vs consumed):

- **Target = `mbClientId`** (whether resolved from JWT or via the fallback above). This
  is the Studio Client that Mindbody Identity is bound to — every future OAuth login
  resolves to it, so it must survive.
- **Source = every other Studio Client at this site sharing the email.** They get
  consumed by Mindbody (history transferred, then removed).
- The orphan with the package becomes Source; its package transfers into Target.

**Safety rails** (intentional belt-and-braces — do not remove):

- `STRIPE_AUTO_MERGE_DUPLICATES=0` env var — kill switch without redeploy.
- Skip when `mbClientId` is still missing or non-positive after fallback (no target).
- Skip when email is missing or doesn't contain `@`.
- Per-call 8s search timeout + 15s merge timeout in the lib; 12s overall race in the
  OAuth callback wrapper. Slow Mindbody never blocks sign-in indefinitely.
- Blanket try/catch in the callback — auto-merge errors are logged (`console.warn`,
  event `stripe_oauth_auto_merge_error`) but never fail the OAuth flow. The user lands
  on `/classes` either way; the next sign-in retries (idempotent).

**Idempotency**: once Source is merged Mindbody removes it. A re-run of the search
returns only the surviving Target, the loop finds nothing to do, returns
`merged: [], skipped: [is_session_client_target], failed: []`.

**Logging contract** (visible in Netlify Function logs for `mindbody-oauth-callback`):

| Event | When | Useful for |
|---|---|---|
| `stripe_oauth_claims_shape_no_client_id` | Whenever JWT extraction misses the clientId. Logs `claimsKeys` + value types (no values). | Diagnosing future Mindbody Identity claim-shape changes. |
| `stripe_oauth_client_id_resolved_via_fallback` | Fallback resolver succeeded. Includes resolved `mbClientId` and `via: "tryResolveClientId"`. | Confirms the merge has a valid target. |
| `stripe_oauth_client_id_unresolved` | JWT and fallback both returned `null`. | Indicates the user has no Studio Client at this site at all (very rare). |
| `stripe_oauth_client_id_fallback_error` | Fallback threw. Includes truncated `error`. | Investigate Mindbody outages / staff-token issues. |
| `stripe_oauth_auto_merge_invoked` | Always emitted at entry. Logs `mbClientIdRaw`, `mbClientId`, `hasEmail`, `killSwitch`. | Confirms the OAuth callback reached this code path. |
| `stripe_oauth_auto_merge_skipped` | Early-return: kill-switch off, missing/invalid clientId or email. Includes `reason`. | Tells exactly why merge was skipped. |
| `stripe_auto_merge_search_results` | After email search inside `autoMergeDuplicatesByEmail`. Logs `matchCount` + `matchIds`. | Distinguishes "no duplicates exist" from "API search returned nothing". |
| `stripe_oauth_auto_merge` | Merge ran to completion. Logs full `result: { ok, merged[], skipped[], failed[] }`. | Operational success record. |
| `stripe_oauth_auto_merge_error` | Overall timeout / unexpected throw. | Flag staff for manual merge. |

**What this does NOT do**:

- It does not retroactively walk historical orders and merge old duplicates — only the
  user's *next* OAuth sign-in cleans up their pair. To clean up legacy duplicates en
  masse, use the Mindbody dashboard "Merge Duplicate Clients" tool or invoke the helper
  manually via `__testing.mergeMindbodyClients` in a one-off script.
- It does not delete or modify clients with different emails. The same-email constraint
  is non-negotiable safety.

#### Risk matrix — which buyer flows can produce a duplicate?

| Buyer state | Stripe checkout flow | Webhook behaviour | OAuth follow-up | Duplicate risk |
|---|---|---|---|---|
| Logged-in member | `knownMindbodyClientId` + Stripe customer prefill | `resolveOrCreateMindbodyClient` returns the known ID immediately, skips `addclient` | Re-uses existing Identity-linked client | **None** — single client throughout |
| Returning client (has Mindbody Account but signed out) | Anonymous → custom_fields collect first/last | Email search finds existing client, uses it. No new client created. | Identity recognises the email and uses the same client | **None** — email-search resolves it |
| Brand-new client (anonymous) — first+last match what Identity will provision | custom_fields collect first/last | `addclient` creates Studio Client A | Identity auto-links to A on first sign-in | **None** — Identity matches A |
| Brand-new client (anonymous) — first+last differ from what Identity provisions | custom_fields collect first/last | `addclient` creates Studio Client A (with package) | Identity creates Studio Client B (linked, empty), auto-merge moves A → B | **Auto-resolved on first sign-in** |
| Client manually created in Mindbody dashboard with same email as an Identity-linked one | n/a (out-of-band) | n/a | Next OAuth sign-in: auto-merge moves manual → Identity-linked | **Auto-resolved on next sign-in** |

### Soft sign-in gate (drop-in / packs only)

Anonymous purchase of NCS goes straight to Stripe (no friction — NCS is the acquisition
offer). Anonymous purchase of drop-in or 10/20-pack triggers a one-shot dialog before Stripe:

> **Already have an account?**
> Sign in first so your package is added to your existing Mindbody account.
> [ Sign in with Mindbody ] [ Continue without signing in ] [ Cancel ]

- "Sign in" → `/api/mindbody/oauth/start?return=<current-url>`
- "Continue without signing in" → proceeds to Stripe; the webhook resolves by email afterwards
- "Cancel" → closes the dialog, no Stripe session created

The dialog is purely advisory — there is **no hard block**. The decision is per-SKU `kind`
(`stripeExpressEligibilityForRow` returns `kind: "newClient" | "dropin" | "packs"`).

### Static New Client Special card (on `/`, `/first-visit`, AND `/pricing`)

The New Client Special card is rendered as **static HTML** on every public page that
features it: the homepage promo (`/`), the dedicated first-visit landing
(`/first-visit`), and the above-the-fold position of `/pricing`. Price, duration, and
feature list are baked into the page source at build time, not fetched from Mindbody.
The motivation is purchase-funnel speed: NCS is a fixed promotional offer (no
per-customer variance, no contract terms to fetch) so showing a "Loading…" flash for
~300–800ms only to render the exact same `$65 / 3 classes / 21 days` card hurts
conversion measurably on first paint, especially on the home page where it competes
with the hero-fold attention budget.

| | `/pricing` (rest of cards) | `/pricing` (NCS only) | `/first-visit` | `/` (homepage) |
|---|---|---|---|---|
| Source | Live `GET /sale/services` + `/sale/contracts` | Static HTML | Static HTML | Static HTML |
| Time to render | ~300–800ms (API roundtrip) | Instant | Instant | Instant |
| Click handler | `pricing-api.js` `[data-mb-checkout]` delegation | **same as left** — `data-mb-checkout="100012"` | `stripe-express-cta.js` (`[data-mb-fv-buy]`) | `stripe-express-cta.js` (same script) |
| GA4 `cta_location` | `pricing_api_modal_express` | `pricing_api_modal_express` | `first_visit_new_client_special` | `home_new_client_special` |
| Picks up Mindbody price changes automatically | Yes | **No — must re-edit HTML** | **No — must re-edit HTML** | **No — must re-edit HTML** |

**Why two different mechanisms** for the same flow:
- On `/pricing`, the rest of the page already loads `pricing-api.js`. Adding the NCS
  card to its existing `[data-mb-checkout]` click delegation is one line of HTML — no
  new script. The button uses `data-mb-checkout="100012"` (Service ID), `data-mb-label`,
  `data-mb-price`. Click → `pricing-api.js` reconstructs a synthetic row → routes
  through `stripeExpressEligibilityForRow` → `showStripeExpressChooser` → Stripe.
- On `/` and `/first-visit`, `pricing-api.js` is intentionally NOT loaded (these pages
  only have a single fixed card, no need for the contract-terms fetcher / monthly
  renderer / etc.). A small shared handler `stripe-express-cta.js` (~250 LoC) provides
  the same chooser dialog UX. The button uses `data-mb-fv-buy="<localSku>"`. The script
  listens via document-level click delegation, so any future page can drop a button
  with the same data attribute and pick up the flow without code changes — as long as
  the page also includes `<dialog id="mb-pricing-checkout-dialog">`, the
  `mb-stripe-onetime-config` JSON blob, and a `[data-mb-proxy]` element.

**The price the customer is charged is identical in all four paths** — every Buy Now
ultimately calls `/api/stripe/checkout/create-session`, which always uses the
server-side `stripe-mindbody-catalog.config.json` for the actual amount. The only thing
that can drift on the static cards is the **displayed** price/feature list, which is
why the maintenance runbook below lists `home.html`, `pricing.html`, and
`first-visit.html` as "must update when NCS price/copy changes" alongside the catalog
config.

To keep `pricing-api.js` working without an `#mb-pricing-mount-new-client` element, its
boot guard tolerates any subset of section mounts (`mountNew`, `mountMonthly`,
`mountPacks`, `mountDrop`) — at least one must be present, but missing ones are simply
skipped. This lets a future page render any subset of categories statically without
breaking the others.

### NCS duplicate policy (Q3 = `block_before_checkout_if_known`)

| Buyer state | What happens |
|---|---|
| Logged-in Mindbody member with confirmed `clientId` and prior NCS history | `create-session` returns **409 `ncs_already_used`** before Stripe is touched. Frontend toasts a non-redirecting error. |
| Logged-in Mindbody member with no NCS history | Stripe session is created with `knownMindbodyClientId` in metadata. |
| Anonymous buyer | Stripe session is created. Webhook resolves by email after payment. If we resolve to an existing client who already used NCS, order parks at `paid_but_not_synced` with `errorCode: "ncs_for_existing_client"`. We never duplicate-create clients. |

NCS history detection lives in `fetchClientNcsHistory()` and uses
`/client/clientpurchases` + `/client/clientservices`.

### Stripe test mode safety guard

A Stripe test-mode payment must NEVER create a real active package in Mindbody production.
Two-layer enforcement:

1. **`event.livemode` + `session.livemode`** — webhook computes `stripeLivemode` per event.
2. **`STRIPE_TEST_MODE_MINDBODY_BEHAVIOR`** env var (default **`skip`**) decides the action
   when Stripe is in test mode:

| Value | Behavior on Stripe test events | When to use |
|---|---|---|
| `skip` (default) | Order is parked at `test_mode_no_sync`. Mindbody is not touched at all. No `addclient`, no service add, no welcome email, no email of any kind. | Production default. Use for routine local development and most testing. |
| `mindbody_test` | Mindbody APIs called with `Test: true`. The Sale is NOT persisted (no row in Purchases, no Service granted) but Mindbody DOES allocate a Sale ID counter and DOES send a receipt email. We mitigate the email by sending `SendEmail: false` on the CheckoutShoppingCart payload. | Pre-launch validation of the CheckoutShoppingCart payload schema (Service IDs, payment method id, GrandTotal, currency) against a live Mindbody site without creating real sales. |
| `live` | Sync runs against live Mindbody normally. Welcome email sent. | Operator override only — almost never used. |

`testModeDecision.stripeLivemode === true` (real Stripe live) ALWAYS syncs live regardless of
the env var. The setting only governs what happens in Stripe-test mode.

The success page surfaces a `bucket: "test_mode"` UI for `test_mode_no_sync` orders so
developers see a clear "test payment received, no Mindbody changes" confirmation.

#### What `Test: true` actually does — verified empirically (May 12 2026)

| Endpoint | Behaviour with `Test: true` |
|---|---|
| `POST /client/addclient` | **400 rejected** with "Test mode is not allowed for this endpoint." Mindbody refuses dry-run on this endpoint at all. |
| `POST /sale/checkoutshoppingcart` | **200 success** — Mindbody validates the payload (returns mock Sale ID, mock SaleDateTime), but **no row is written to Sales / Purchases / Services**. The client's Mindbody account is unchanged. **However**, Mindbody DOES send the receipt email to the client (the email is generated at request time, before persistence). We avoid this side effect by sending `SendEmail: false` on the CheckoutShoppingCart payload when `mindbodyTest === true`. |
| `POST /client/sendpasswordresetemail` | Not invoked at all in `mindbody_test` mode (gate `!testModeDecision.mindbodyTest` blocks the call). |

The only operator-visible side effects of `mindbody_test`:

1. A receipt email is delivered to the buyer's inbox (suppressed by us via `SendEmail: false`,
   but historic test runs before this fix produced one). The customer's Mindbody account is
   not actually credited — staff can ignore the email and reassure customers if they ask.
2. Mindbody's Sale ID counter advances (e.g. `Sale ID 11588` is allocated even though the row
   never lands in the database). Harmless.
3. The `mbSaleId` field in the order record will be `null` (no real sale was created).

`testModeDecision.stripeLivemode === true` (real Stripe live) ALWAYS syncs live regardless of
the env var. The setting only governs what happens in Stripe-test mode.

The success page surfaces a `bucket: "test_mode"` UI for `test_mode_no_sync` orders so
developers see a clear "test payment received, no Mindbody changes" confirmation.

#### Mindbody quirk: `addclient` does not support `Test: true`

Discovered during dry-run testing (May 2026): Mindbody's `POST /public/v6/client/addclient`
rejects requests that include `Test: true` with the message:

```
Test mode is not allowed for this endpoint.
```

Implication: `mindbody_test` mode can only validate payloads end-to-end for buyers who are
**already known Mindbody clients** (logged-in flow with `knownMindbodyClientId`, where
`addclient` is bypassed). For anonymous buyers in `mindbody_test`, the webhook detects this
specific Mindbody response and parks the order at `test_mode_no_sync` with errorCode
`mindbody_test_addclient_unsupported` instead of polluting `paid_but_not_synced`. Log:
`stripe_order_mindbody_test_addclient_unsupported`.

To dry-run validate the **anonymous** buyer flow end-to-end, you must use real (live) Stripe
keys against a real Mindbody site — there is no other way. The CheckoutShoppingCart payload,
which DOES support `Test: true`, can still be validated by re-running the test with a
logged-in Mindbody member.

### Email masking on success page

The customer's email never crosses the wire to `/checkout/success` in raw form.
`stripe-order-status.mjs::publicSummary` masks the address before returning:

```
snir3@pic-smart.com  →  sn***@pic-smart.com
a@example.com        →  a***@example.com
ab@example.com       →  a*@example.com
```

The masking helper is `maskEmailForUi()` (server) with a mirrored client-side fallback
`maskEmailFallback()` in `checkout-success.js` (defense-in-depth). The admin endpoint
`/api/stripe/admin/orders` returns the raw email — staff need it for support.

### Customer-facing pages

- **`/checkout/success`** — `src/content/checkout-success.html`, `src/js/checkout-success.js`
  - Centered card, mobile-responsive (`src/css/components-checkout-status.css`).
  - Polls `/api/stripe/order-status` with backoff so the customer sees `synced` instead of
    `pending` if the webhook fires within seconds.
  - For **new clients**: shows the onboarding banner ("Check your email · sn\*\*\*@…"); CTAs
    swap to "Sign in with Mindbody" + "Book a class".
  - For **existing/logged-in clients**: keeps default CTAs ("Book a class" + "View my account").
  - For **`test_mode`**: clear notice that no Mindbody changes were made.
  - GA4 events: `stripe_payment_success_page_view`, `stripe_order_synced_to_mindbody`
    (with `new_client` and `welcome_email_sent` flags), `stripe_order_sync_failed`,
    `stripe_order_test_mode_skipped`.
  - **GA4 conversion events** (fire only when `bucket === "synced"`, idempotent per
    `orderId` via `sessionStorage`):
    - `purchase` — GA4 standard ecommerce event with `transaction_id`, `value`,
      `currency`, `affiliation: "Stripe"`, and `items: [{ item_id: localSku,
      item_name: displayName, item_category: "package", price, quantity: 1 }]`. Maps
      directly to GA4's Monetization reports and is the conversion event Google Ads
      reads for ROAS bidding. Also carries `cta_location` and `new_client` as custom
      params.
    - `new_client_special_purchase` — extra event, fires only for SKU
      `new_client_special_3_for_65`. Carries `cta_location` (e.g.
      `home_new_client_special`, `first_visit_new_client_special`,
      `pricing_static_new_client`, `pricing_api_modal_express`,
      `pricing_api_soft_gate`) so the team can attribute NCS conversions to the
      surface that drove them — NCS is offered on Home, First Visit, and Pricing.
- **`/checkout/cancel`** — same styling, no order mutation.

### Stripe Checkout Session details

- Built with **dynamic `price_data`** server-side from the catalog. We do NOT pre-create
  Stripe Products/Prices.
- `phone_number_collection: { enabled: true }` (always — needed for Mindbody client matching).
- **Contact information prefill for logged-in members** — `stripe-create-checkout-session.mjs`
  resolves the buyer's Mindbody identity in three layers, all silent on failure:
  1. **`knownMindbodyClientId`** posted by `pricing-api.js` (works only if the frontend has
     it cached — usually it doesn't because `mb_sess` only carries email/name/sub).
  2. **Server-side cookie unseal**: if no clientId came in, the function unseals the same
     `mb_sess` cookie the browser sent and reads the email field (cheap — no Mindbody token
     refresh, just crypto).
  3. **Email → clientId search**: with the unsealed email and the staff headers we already
     need for NCS / contact lookup, the function calls Mindbody `GET /client/clients?
     searchText=<email>`. A single confident match is treated as the buyer's clientId; multi/
     no-match gracefully falls back to anonymous (the post-payment webhook still resolves
     them properly via its own duplicate-tolerant path).

  Once the clientId is known, the function reads the Mindbody client profile (email +
  FirstName/LastName + MobilePhone) and calls `stripe.customers.list({ email })` to find or
  create a Stripe `Customer` tied to that Mindbody `clientId` (via
  `metadata.mindbodyClientId`). The Checkout Session is created with `customer: <id>` and
  `customer_update: { name: "auto", address: "auto" }`, so Stripe-hosted Checkout shows the
  buyer their email/name/phone already filled in. Email becomes read-only on the page, but
  name & phone remain editable. Any failure (Mindbody lookup error, Stripe API error) silently
  falls back to `customer_email` only — checkout still works, just without full prefill.

  This server-side resolve also runs **before** the NCS `block_before_checkout_if_known`
  duplicate check, so a returning member can't bypass the NCS block just because the browser
  cookie didn't expose their numeric clientId.

  Log line `stripe_checkout_session_created` includes:
    - `knownClientResolvedFrom` = `"frontend_payload"` | `"server_cookie_email"` | `"none"`
    - `prefillEnabled`, `prefillBudgetMs`, `prefillTotalMs`, `clientIdResolveMs`,
      `contactLookupMs`, `stripeCustomerMs` so you can watch real prefill cost in production.

  **Safety controls** (each independently honored):
    - `STRIPE_CHECKOUT_PREFILL_FROM_MINDBODY` — default `1`. Set to `0` (or `false`/`off`)
      to disable prefill entirely without a redeploy. Logged-in members will then see the
      same blank Contact form as anonymous buyers.
    - `STRIPE_CHECKOUT_PREFILL_TIMEOUT_MS` — default `5000`, bounded between 2000–10000.
      Hard cap per Mindbody round-trip inside the prefill flow. Anything slower silently
      falls back to anonymous-style checkout — the customer never waits longer than this
      for prefill.
- Anonymous buyers (no `knownMindbodyClientId`): `customer_email` is set if the frontend posted
  one; otherwise Stripe collects everything fresh.
- **First/Last name capture for anonymous buyers** — Stripe-hosted Checkout exposes
  `customer_details.name` as a single string. Sources vary widely (cardholder textbox,
  Apple Pay wallet, Link saved profile, Klarna form), so the value is unreliable as a
  clean first/last split — and a wrong split sabotages Mindbody Identity's first+last+
  email auto-link logic. Fix: when we don't already have a clean Mindbody profile name
  (`mindbodyContact.firstName && mindbodyContact.lastName`), the session is created with
  `custom_fields: [{ key: "first_name" }, { key: "last_name" }]` (both required, 1–80
  chars). Stripe renders these as two text inputs after the Contact section. The webhook
  reads `session.custom_fields[]` and passes `firstName` / `lastName` straight to
  `resolveOrCreateMindbodyClient`, which prefers them over `splitFullName(fullName)`.
  Logged-in members are not asked again — `mindbodyContact` already has both names.
- `billing_address_collection: "auto"` (no extra friction).
- `client_reference_id = orderId`; `metadata` carries `localSku`, `mindbodyServiceId`,
  `mindbodyItemType`, `flow`, `knownMindbodyClientId`, `oneTimePerClient`, `duplicatePolicy`,
  `ctaLocation` for traceability.
- `success_url = ${origin}/checkout/success?orderId=…&session_id={CHECKOUT_SESSION_ID}` and
  `cancel_url = ${origin}/checkout/cancel?orderId=…`.

### Environment variables

Required to enable the flow in production:

| Var | Value | Notes |
|---|---|---|
| `ENABLE_STRIPE_ONE_TIME_CHECKOUT` | `1` to turn on; `0` to deploy code but keep CTA hidden + create-session returning 503 | Default `0`. Frontend embed and server gates both check this. |
| `STRIPE_SECRET_KEY` | `sk_live_…` (or `sk_test_…` in test) | Required. |
| `STRIPE_PUBLISHABLE_KEY` | `pk_live_…` (or `pk_test_…`) | Currently informational; Stripe Checkout is a redirect flow, no client-side Stripe.js calls. |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` | Required. Verifies every webhook delivery. |
| `STRIPE_SUCCESS_URL` | optional override (full URL) | Defaults to `${SITE_URL}/checkout/success?orderId=…&session_id={CHECKOUT_SESSION_ID}`. |
| `STRIPE_CANCEL_URL` | optional override | Defaults to `${SITE_URL}/checkout/cancel?orderId=…`. |
| `MINDBODY_STRIPE_PAYMENT_MODE` | `custom` (production) or `comp` (dev fallback only) | Defaults to `custom`. |
| `MINDBODY_STRIPE_PAYMENT_METHOD_NAME` | `Stripe` | Must match Mindbody Site Settings → Payment Methods exactly. |
| `MINDBODY_STRIPE_PAYMENT_METHOD_ID` | optional integer | If you want to bind by ID instead of name (rare). |
| `STRIPE_TEST_MODE_MINDBODY_BEHAVIOR` | `skip` (default) / `mindbody_test` / `live` | Governs what happens when a Stripe TEST event arrives. See "Stripe test mode safety guard". |
| `ADMIN_DEBUG_TOKEN` | random string | Required header `x-admin-debug-token` for `/api/stripe/admin/orders`. |
| `STRIPE_ORDER_STORE_LOCAL_MEMORY` | `1` only in `npm run dev` | Activates in-memory order store fallback when Netlify Blobs context is missing. **Refuses to activate** when `NETLIFY` env is set. |
| `STRIPE_AUTO_MERGE_DUPLICATES` | `1` (default) / `0` to disable | Auto-merges orphan Studio Clients into the Identity-bound client during the OAuth callback. See "Auto-merge duplicate Studio Clients on OAuth callback". |

`STRIPE_ORDER_STORE_LOCAL_MEMORY` is documented in `.env.example` with a strong warning.
Never set it in Netlify production.

### Stripe webhook configuration

Endpoint URL (Netlify): `https://<your-site>/api/stripe/webhook`
(redirected to `/.netlify/functions/stripe-webhook` via `netlify.toml`).

Subscribe to exactly these four events:

```
checkout.session.completed
checkout.session.async_payment_succeeded
checkout.session.async_payment_failed
checkout.session.expired
```

Use the same `STRIPE_WEBHOOK_SECRET` for the endpoint. Do NOT subscribe to
`payment_intent.*` events — the webhook is keyed on Checkout Sessions only.

For local dev with `npm run dev` + ngrok, point the Stripe webhook at your ngrok URL pointing
to port 4321.

### Mindbody configuration prerequisites

1. **Custom payment method** — Mindbody dashboard → Settings → Payment Methods → "Add". Type
   `Custom`, name **exactly** `Stripe`, PayNotes enabled with label `Stripe Order ID`.
2. **Capture the numeric id** of that payment method. **Required.** Run:
   ```
   npm run stripe:find-mb-payment-id
   ```
   The script calls `GET /public/v6/sale/custompaymentmethods` and prints all id+name pairs.
   Paste the matching id into `MINDBODY_STRIPE_PAYMENT_METHOD_ID` in `.env` and Netlify env.
   Without this id Mindbody returns 400 "The received Custom's Metadata was missing key id."
   on every CheckoutShoppingCart sync, and `syncOneTimePurchaseToMindbody` fails fast with
   `reason: "missing_payment_method_id"`.
3. **Staff API user** — `MINDBODY_STAFF_USERNAME` + `MINDBODY_STAFF_PASSWORD` must be set
   (the integration staff used by the rest of the app). The webhook calls `addclient`,
   `clientpurchases`, `clientservices`, `checkoutshoppingcart`, and
   `sendpasswordresetemail` with this staff token.
4. **Pricing options exist & are sellable online.** Run
   `npm run stripe:find-mb-ids` and confirm the IDs in
   `stripe-mindbody-catalog.config.json` match. NCS is currently pinned to **`100012`**.
5. **Welcome email template** — verify Mindbody Site Settings → Email Templates → "Password
   Reset" is enabled and has a sensible subject/body. The link in that email is what new
   clients click to set their password.

#### Mindbody quirk: `Custom` payment Metadata schema

Verified May 12 2026 against this site:

```jsonc
{
  "Type": "Custom",
  "Metadata": {
    "id": 17,                        // REQUIRED — lowercase. The numeric Mindbody payment method id.
    "Id": 17,                        // belt-and-suspenders for parsers that prefer PascalCase
    "PaymentMethodId": 17,
    "Name": "Stripe",                // the display name (must match Mindbody Site Settings)
    "Amount": 40,
    "AmountPaid": 40,
    "Notes": "orderId=ord_…; session=cs_test_…; sku=drop_in_single_class",
    "PayNotes": "orderId=ord_…; session=cs_test_…; sku=drop_in_single_class"
  }
}
```

The endpoint `GET /sale/custompaymentmethods` returns rows under `PaymentMethods[]` (not
`CustomPaymentMethods[]` despite its URL name). The discovery script handles both shapes.

### Operations / admin tools

- `GET /api/stripe/admin/orders` (header `x-admin-debug-token: <ADMIN_DEBUG_TOKEN>`):
  list orders by `status` query param, e.g. `?status=paid_but_not_synced`. Returns raw
  `OrderRecord` (incl. unmasked email + `welcomeEmailError`).
- `POST /api/stripe/admin/orders` with `{ action: "retry", orderId }` to re-attempt
  Mindbody sync for a stuck `sync_failed_retryable` order.
- Structured logs (JSON) at every transition. Search Netlify Function logs for events
  like `stripe_order_synced_to_mindbody`, `stripe_order_welcome_email_sent`,
  `stripe_order_welcome_email_failed`, `stripe_order_test_mode_skipped`,
  `stripe_order_ncs_for_existing_client`.
- The order record schema (`stripe-order-store.mjs::OrderRecord`) carries all support
  signals: `stripeLivemode`, `mindbodyTestModeBehavior`, `clientWasNewlyCreated`,
  `welcomeEmailSent`, `welcomeEmailError`, `mindbodyResponseSummary`,
  `lastSyncAttemptAt`, `syncAttempts`, `errorCode`, `errorMessageSafe`.

### Rollout phases

1. **Phase 0 (current default)** — `ENABLE_STRIPE_ONE_TIME_CHECKOUT=0`. Functions deploy but
   the create-session endpoint returns 503 and the Express CTA is hidden on `/pricing`.
2. **Phase 1 — bring up in test** — set `STRIPE_*` to test keys, leave
   `STRIPE_TEST_MODE_MINDBODY_BEHAVIOR=skip`, flip `ENABLE_STRIPE_ONE_TIME_CHECKOUT=1`. Pay
   with `4242 4242 4242 4242`. Verify success page shows "Test mode · No Mindbody changes".
3. **Phase 2 — Mindbody dry-run** — set `STRIPE_TEST_MODE_MINDBODY_BEHAVIOR=mindbody_test` for
   one round. Confirm `Test: true` payloads against a real Mindbody site with zero side
   effects. Welcome email is NOT sent in this mode.
4. **Phase 3 — go live** — switch `STRIPE_*` to live keys, leave
   `STRIPE_TEST_MODE_MINDBODY_BEHAVIOR=skip`. The behavior is forced to `live` automatically
   for any Stripe live event regardless of the env var.

### Internal alerting (Q5 — MVP)

`console.error` JSON-structured logs for every `paid_but_not_synced`, `sync_failed_*`,
`manual_review`, `multiple_client_matches`, and `welcome_email_failed` transition. The order
store always carries the authoritative status. Email/Slack alerting is a follow-up PR
(channel TBD).

### What is intentionally excluded

- **Recurring memberships / contracts** — stay on Mindbody classic / `purchase-contract`. The
  catalog gates non-`oneTimePerClient` SKUs out of Express checkout.
- **Stored card / wallet payment via Mindbody** — only used by the EXPRESS-with-Mindbody
  flow; not used for Stripe Express.
- **`CreditCardInfo` payloads to Mindbody** — never. We do not collect raw card details.
- **Auto-Comp fallback** — never silently downgrades to Comp. Failed custom payment rows park
  at `paid_but_not_synced`.
- **Stripe Customer creation in advance** — we use guest sessions; Stripe creates the
  Customer at session completion if needed.

---

## Maintenance runbook — changing prices, names, or SKUs

Because the New Client Special card is rendered **statically on `/`, `/first-visit`,
and `/pricing`** (see "Static New Client Special card" above), the SKU catalog is
intentionally redundant in a few places: the canonical Mindbody Service, the
server-side catalog config (which controls the actual Stripe charge), the three
static NCS markups (homepage promo, first-visit landing, pricing top card), and
(for non-NCS SKUs) the live `/pricing` cards rendered from API. Use this runbook
whenever a SKU changes so the displayed price never disagrees with the charged price.

> Server-side rule of thumb: the price the customer is **charged** lives in
> `netlify/functions/_embedded/stripe-mindbody-catalog.config.json`. Mindbody's price
> field is shown on `/pricing` for marketing parity but is **not** what Stripe bills.
> Forgetting to update the catalog config when Mindbody changes is the most common bug.

### A. Change the price of an existing SKU (e.g. NCS $65 → $69)

1. **Mindbody dashboard** — Sales → Services & Pricing → edit the row. Studio source of
   truth.
2. **`netlify/functions/_embedded/stripe-mindbody-catalog.config.json`** — update
   `amountCents` for the matching `localSku`. **This is the value Stripe charges.** If
   you skip this, customers pay the OLD price even though Mindbody shows the new one.
3. **`/pricing`** — depends on which SKU:
   - **NCS** — the card is **static**. Edit `src/content/pricing.html` and update:
     - `<div class="plan-price">$XX</div>`
     - `<div class="per-class">~ $YY per class</div>`
     - the `data-mb-price="XX"` attribute on the Buy Now button (drives the price
       label inside the Stripe Express dialog).
     - any feature copy referring to the price.
   - **Drop-ins / packs / monthly memberships** — no manual change needed;
     `pricing-api.js` reads the live Mindbody price and rebuilds the card.
4. **`/first-visit`** — only if the SKU is the New Client Special: edit
   `src/content/first-visit.html` and update:
   - `<div class="plan-price">$XX</div>`
   - `<div class="per-class">~ $YY per class</div>`
   - the `data-mb-fv-price="$XX"` attribute on the Buy Now button.
   - any feature copy referring to the price.
5. **`/` homepage** — only if the SKU is the New Client Special: edit
   `src/content/home.html` and update:
   - `<p class="home-ncs-card__price" aria-label="XX dollars">$XX</p>` (note: also
     update the `aria-label` for screen readers).
   - `<p class="home-ncs-card__per">~ $YY per class</p>`
   - the `data-mb-fv-price="$XX"` attribute on the Buy Now button.
   - any feature copy referring to the price.
6. **`docs/MINDBODY-CHECKOUT-OVERVIEW.md`** — update the catalog table near the
   "Catalog (source of truth)" header.
7. `npm run build` and verify the new price appears in `dist/index.html`,
   `dist/pricing.html`, and `dist/first-visit.html`.
8. Deploy. Run a low-amount Stripe test purchase end-to-end before announcing the price
   change publicly.

### B. Change the display name of an existing SKU (e.g. "New Client Special" → "Welcome 3-Pack")

1. Mindbody dashboard — rename the Service.
2. `stripe-mindbody-catalog.config.json` — update `displayName` for the matching
   `localSku`. This is the line item label on the Stripe Checkout page and the receipt.
3. **For NCS** — update the static cards on **all three pages**:
   - `src/content/pricing.html`: visible plan name + the `data-mb-label` button attribute.
   - `src/content/first-visit.html`: visible plan name + section heading + page copy.
   - `src/content/home.html`: `home-ncs-card__title` + supporting copy in the promo
     section. (No `data-mb-label` here — the dialog header reads from the SKU
     `displayName` in the catalog config.)
4. `docs/EMAIL-DESIGN-SYSTEM.md` — if the new name should appear in the welcome email,
   update the template.
5. `expressEnabledSkus[*].nameMatchAny` (in `stripe-mindbody-catalog.config.json`) —
   only update if the live Mindbody name no longer matches any of the existing
   heuristics. Otherwise the existing patterns still resolve correctly.

### C. Add a brand-new one-time SKU (e.g. a "5 Class Pack")

1. Mindbody — create the Service with `SellOnline=true`. Note the Mindbody Service ID.
2. `npm run stripe:find-mb-ids` — verify the new ID and its price are visible to the
   integration staff token.
3. `stripe-mindbody-catalog.config.json` → `items[]` — add a new entry with
   `localSku`, `displayName`, `mindbodyServiceId`, `amountCents`,
   `mindbodyItemType: "Service"`, `enabledForExpressCheckout: true`, and the appropriate
   `kind: "newClient" | "dropin" | "packs"`.
4. Same file → `expressEnabledSkus[]` (the public embed) — add the SKU here too so
   `pricing-api.js` knows to render the Express CTA on the matching card. Include
   `nameMatchAny` patterns that match the live Mindbody display name.
5. `/pricing` — the new card appears automatically once Mindbody returns it from
   `/sale/services`. Verify the soft sign-in gate triggers correctly (`drop-in`/`packs`
   show the gate, `newClient` does not).
6. `/first-visit` — usually skip. Only add a new card here if the new SKU should be
   promoted on the first-visit onboarding page (today only NCS qualifies).
7. Welcome email (`docs/EMAIL-DESIGN-SYSTEM.md`) — if the new SKU is part of the
   onboarding funnel, mention it in the "Getting started" steps.

### D. Disable an SKU from Express Checkout (e.g. end of a promo, but keep the SKU around)

Set `enabledForExpressCheckout: false` in `stripe-mindbody-catalog.config.json` for the
matching `localSku`. After redeploy:

- `/pricing` — the card still appears (live from Mindbody) but the Express CTA is
  hidden; clicking Buy Now opens Mindbody Classic in a new tab.
- `/first-visit` — the static card still shows. Buy Now opens the chooser dialog, the
  server returns `sku_not_enabled_for_express_checkout`, and the dialog falls back to
  the "Continue to Mindbody" link. (If you want Buy Now to skip the dialog and go
  straight to Mindbody Classic instead, also remove the `data-mb-fv-buy` attribute and
  swap the `<button>` for an `<a href="…mindbodyonline.com/classic/...">`.)

### E. Remove an SKU entirely (retire a package)

1. Mindbody — set `SellOnline=false` (recommended — preserves history) or delete the
   Service. Note the Service ID before deleting in case you need to reconcile orders.
2. **Wait** for any in-flight Stripe Checkout sessions for that SKU to expire.
   `checkout.session.expired` is one of the four subscribed webhook events, so this is
   safe — the order will park instead of attempting to sync. Stripe Checkout Sessions
   expire after 24h by default.
3. `stripe-mindbody-catalog.config.json` — remove the `localSku` from both `items[]`
   and `expressEnabledSkus[]`. Do this AFTER step 2 so the webhook can still reconcile
   any straggler payment.
4. `/first-visit` — if the removed SKU was the NCS card on this page, remove the static
   card markup from `src/content/first-visit.html` (and probably reword the page).
5. Update this doc's catalog table.

### F. Sanity-check before deploying any catalog change

```
npm run build                         # verify static pages re-render correctly
npm run stripe:find-mb-ids            # confirm Service IDs against live Mindbody
```

A small ($0.50 or test-mode) end-to-end Stripe purchase against a logged-in Mindbody
member is the cheapest full-stack regression. If you only changed visual price/feature
copy on `/first-visit`, a visual smoke test of `dist/first-visit.html` followed by a
production smoke test of one anonymous NCS purchase is sufficient.

### Quick checklist by change type

NCS = New Client Special (rendered statically on **`/`, `/pricing`, AND `/first-visit`**).
All other SKUs (drop-ins, packs, memberships) are dynamic on `/pricing` only.

| Change | `stripe-mindbody-catalog.config.json` | `pricing-api.js` (dynamic cards) | `pricing.html` (static NCS) | `first-visit.html` (static NCS) | `home.html` (static NCS) | Mindbody dashboard | This doc |
|---|---|---|---|---|---|---|---|
| NCS price changed | ✅ `amountCents` | n/a | ✅ price + `data-mb-price` | ✅ price + `data-mb-fv-price` | ✅ price + `aria-label` + `data-mb-fv-price` | ✅ | ✅ |
| Non-NCS price changed | ✅ `amountCents` | (auto) | n/a | n/a | n/a | ✅ | ✅ |
| NCS name changed | ✅ `displayName` | n/a | ✅ name + `data-mb-label` | ✅ name + section heading | ✅ name + supporting copy | ✅ | optional |
| Non-NCS name changed | ✅ `displayName` | (auto) | n/a | n/a | n/a | ✅ | optional |
| New SKU added | ✅ `items[]` + `expressEnabledSkus[]` | (auto) | optional | optional | optional | ✅ | ✅ |
| SKU disabled from Express | ✅ `enabledForExpressCheckout=false` | (auto) | (no change — falls back to Mindbody Classic in dialog) | (no change) | (no change) | (no change) | optional |
| NCS retired | ✅ remove (after sessions expire) | n/a | ✅ remove the static section | ✅ remove or rework page | ✅ remove the promo section | `SellOnline=false` or delete | ✅ |
| Non-NCS retired | ✅ remove (after sessions expire) | (auto) | n/a | n/a | n/a | `SellOnline=false` or delete | ✅ |

---

*מסמך זה משקף את המימוש בסביבות האתר מאז מעבר ל־Classic ישיר במחירון, דגלים ל־Mindbody EXPRESS, הגבלות PurchaseContract/StoredCardInfo, ומסלול Stripe → Mindbody one-time express checkout (NCS / drop-in / 10/20 packs) עם soft sign-in gate, כרטיס סטטי ב־/first-visit עם handler ייעודי לאותו דיאלוג checkout, אונבורדינג מייל setup-password, מיסוך אימייל בדף ההצלחה, ומגן test-mode מלא.*
