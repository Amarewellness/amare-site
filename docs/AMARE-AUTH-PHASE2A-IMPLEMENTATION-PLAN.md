# AMARÉ Auth — Phase 2A Implementation Plan

**Status:** APPROVED for sequencing. **2A.1 implementation in progress / landed as store+schema only.**  
**Parent:** [`AMARE-AUTH-PHASE02-DESIGN.md`](./AMARE-AUTH-PHASE02-DESIGN.md) (APPROVED)  
**Do not start 2A.2 until 2A.1 is reviewed.**

```text
PHASE 2A QUESTION:  Who is this person?
PHASE 2A NON-QUESTION: May they Staff-operate this clientId?   → 2B
PHASE 2A NON-QUESTION: Should public Book use Staff?           → Phase 3+
```

No PR may combine 2A, 2B, and booking mutation.

---

## A. 2A Executive Plan

Phase 2A adds AMARÉ-owned authentication on top of the Phase 0+1 identity store.  
Apple / Google / Email OTP are primary. Mindbody OAuth stays as written and becomes an additive legacy identity bridge.

```text
Apple / Google / Email OTP / Mindbody legacy
        ↓
amare_user_id
        ↓
amare_sess  { amare_user_id, at }   — no clientId, no Mindbody tokens
```

Studio association stays a **separate** state machine. D26: a verified provider `sub` never implies ownership of a Studio `clientId`.

Live Book / Waitlist / Cancel / Dashboard stay on `mb_sess` + `resolveConsumerClient` + `bookingAllowed === consumerAssociated`.  
`promoteAssociationToLinked()` stays a throw.

**Recommended PR order** (session core inserted before the first provider; otherwise Google has no safe cookie/resolver):

```text
2A.1  Schema + provider groundwork
2A.2  AMARÉ auth / session core
2A.3  Google
2A.6  Mindbody legacy identity bridge
2A.4  Apple
2A.5  Email OTP
2A.7  Unified login UI + flags
```

Why this vs “Google then Mindbody then Apple then OTP then UI”:

- **2A.2 before Google** — `amare-sess-lib.mjs` can seal/unseal in tests but cannot Set-Cookie, expire in-payload, logout, or resolve “current AMARÉ user.” Google must not invent a second session format.
- **Mindbody bridge after Google** — proves find/create + claim-confirm on a new IdP first; then the existing callback grows an additive hook. Does not replace `/api/mindbody/oauth/*`.
- **Apple after Google** — same OIDC shape, harder email/relay rules.
- **Email OTP last among backends** — new table, Resend, abuse controls. Vendor already in-repo (`resend-email-client.mjs`).
- **UI last** — do not expose an unfinished provider. Book CTAs stay “Sign in with Mindbody” in 2A.7.

Do not enable a provider in production merely because its migration landed.

---

## B. Current Reusable Infrastructure

Inspected 2026-08-16. Use these; do not reimplement.

| Piece | Where | Reuse in 2A |
|-------|--------|-------------|
| Users / identities / associations + both unique indexes | `netlify/database/migrations/20260816000100_amare_identity.sql` | Keep. Expand provider CHECK only. |
| State machine + claim hierarchy + Crockford `usr_` | `netlify/functions/amare-identity-policy.mjs` | `resolveClaimCandidate`, `assertAssociationTransition`, `isApplePrivateRelayEmail`, `newAmareUserId` |
| Postgres adapter (`getDatabase` / `getConnectionString`) | `netlify/functions/amare-identity-store.mjs` | Writes. **No `handler` today (D16).** Add lookups; do not add `handler` on this file. |
| Dark `amare_sess` | `netlify/functions/amare-sess-lib.mjs` | Payload already `{ amare_user_id, at }`. Flag `ENABLE_AMARE_SESS_ISSUE` default off. |
| AES-256-GCM seal, HMAC state, cookie Secure | `netlify/functions/oauth-lib.mjs` — `sealCookiePayload`, `signState` / `verifyState`, `cookieSecureFlag`, `safeReturnPath` | Same crypto. **Different secret:** `AMARE_SESSION_SECRET` ≠ `MINDBODY_SESSION_SECRET`. |
| Mindbody OAuth | `mindbody-oauth-start.mjs`, `callback.mjs`, `session-build.mjs`, `session.mjs`, `logout.mjs`, `complete-studio-profile.mjs`, mobile-* | Untouched except additive hook in 2A.6 callback. |
| `mb_sess` | HttpOnly, SameSite=Lax, Max-Age 30d, optional Secure | Keep. |
| Live Book gate | `mindbody-class-book.mjs` ~136–163 `!link.bookingAllowed` → 403 `studio_not_linked` | **UNCHANGED** |
| Live cancel / waitlist remove | `mindbody-class-cancel.mjs`, `mindbody-class-waitlist-remove.mjs` via `resolveConsumerClient` | **UNCHANGED** |
| Session probe JSON | `mindbody-oauth-session.mjs` + `logAmareSessVersusMbSess` (log only) | Do not change Book-facing JSON in 2A. |
| Studio client search | `mindbody-guest-client-lib.mjs` `searchClients` (`request.searchText`) | Claim email-match count (Staff), not Consumer search. |
| Transactional email | `netlify/functions/resend-email-client.mjs` + `RESEND_API_KEY` | Email OTP sender. No new vendor. |
| Flag convention | `.env.example` — `ENABLE_*=0` until on | Follow this, not new naming schemes. |
| QA | `scripts/qa-amare-identity-phase01.mjs`, `qa-amare-identity-db.mjs`, `qa-amare-identity-preview-isolation.mjs` | Extend; do not replace. |
| Login page today | `src/content/mindbody-login.html` + `src/js/mindbody-auth.js` | 2A.7 may add `/login` AMARÉ UI behind flags. Do not rewrite Book dialogs. |

### Gaps to close before production auth (hardening, not redesign)

- `attachIdentity` JSDoc/CHECK allow only `google \| apple \| email` — 2A.1 adds `mindbody`.
- No `findIdentity(provider, provider_sub)` / `listIdentities(amare_user_id)`.
- `createAmareUser` + `attachIdentity` are not one transaction.
- `amare_sess` has cookie Max-Age only; sealed payload has `at` but no `exp`.
- No Set-Cookie / clear helpers for `amare_sess` (Mindbody has them in callback/logout).
- `logAmareSessVersusMbSess` option is named `lookupLinkedClientId` but `lookupActiveClientId` includes `verified` — rename in 2A.2 to avoid 2B confusion.
- `confirmAssociation` is library-only; a public confirm route must bind to `amare_sess` user and refuse `linked`.
- `lookupActiveClientId` must **not** be called from Book in 2A.

---

## C. PR Breakdown

### 2A.1 — Schema + provider groundwork

**Goal:** `provider = mindbody` is legal. Identity attach still does not verify a studio row.

**In:** new migration; store `findIdentity` / transactional `createUserWithIdentity`; `attachIdentity` accepts `mindbody`; DB tests.

**Out:** HTTP, cookies, UI, Book, OAuth rewrite, `ENABLE_AMARE_SESS_ISSUE=1`.

**Prove:** UNIQUE `(provider, provider_sub)` for google/apple/email/mindbody; creating a user+identity inserts **zero** `amare_studio_associations` rows.

**Hosted proof (2026-08-16):** Deploy Preview `6a814a263139780008515f24` on `feat/amare-auth-phase01-identity` applied exactly one migration (`20260816083000_amare_identities_provider_mindbody`) onto the existing Phase 1 preview DB. Status after apply: `applied = [20260816000100, 20260816083000]`, `pending = []`. Production remains `applied = []`.

### 2A.2 — AMARÉ auth / session core

**Goal:** Provider-neutral issue / read / clear / rotate `amare_sess`; `resolveAmareUser(event)` for future auth routes only.

**In:** cookie helpers; `exp` in sealed payload; logout clear; CSRF state helpers wrapping `signState`/`verifyState` with `AMARE_SESSION_SECRET`; current-user resolver that **does not** read `clientId` into the cookie.

**Out:** provider start/callback, login UI, Book adoption, production issue flag on.

**Cookie (lock):**

```text
Name:     amare_sess
Payload:  { amare_user_id, at, exp }
Secret:   AMARE_SESSION_SECRET (>= 24 chars)
Flags:    Path=/; HttpOnly; SameSite=Lax; Max-Age=<ttl>; Secure when x-forwarded-proto=https
TTL:      30 days (match mb_sess in mindbody-oauth-callback.mjs) unless review wants shorter
```

Rotate (new seal, new `at`) after every successful login. Do not copy Mindbody tokens or `clientId`.

### 2A.3 — Google authentication

**Goal:** Continue with Google → verified `sub` → find/create user → **propose** association only → optional confirm UI later → `amare_sess` if flag on.

**In:** start + callback Functions, redirects, env vars, claim **evaluation** (write `candidate`/`ambiguous`/`unlinked`, never `verified` in callback).

**Out:** Apple, OTP, unified UI, Book, credentials provisioning in this planning task (implementation PR may add env placeholders only).

### 2A.6 — Mindbody legacy bridge (after Google)

**Goal:** After existing OAuth success, if OIDC `sub` present, attach `provider=mindbody` per design §6.1. Always still write `mb_sess`.

**In:** additive call from `mindbody-oauth-callback.mjs` / `buildSessionPayloadFromOAuthTokens` **after** today’s session payload is built. Gated by `ENABLE_AMARE_AUTH_MINDBODY_BRIDGE`.

**Out:** New Mindbody IdP, changing session JSON, changing start/refresh/logout/mobile routes, making Mindbody a primary button.

### 2A.4 — Apple authentication (web)

**Goal:** Same as Google with relay + first-only email rules.

**Out:** Native Sign in with Apple, `amare-app/`.

### 2A.5 — Email OTP

**Goal:** Control of email → `provider=email`, `provider_sub=normalized email` → user → `amare_sess`. Studio match remains candidate.

**In:** challenge table, request/verify Functions, Resend, rate limits.

### 2A.7 — Unified login UI + rollout

**Goal:** `/login` (or successor of `mindbody-login.html`) shows primary Apple/Google/Email and secondary Mindbody. Flags per provider.

**Out:** Changing Book / Waitlist / Cancel / Dashboard CTAs. Those stay Mindbody until a post-2A UX PR.

---

## D. Database Changes

Preserve Phase 1 indexes. No high-volume audit table — use structured `console.log` JSON (existing identity events).

| Migration | PR | Purpose |
|-----------|----|---------|
| `20260816083000_amare_identities_provider_mindbody.sql` | 2A.1 | `DROP` + recreate CHECK `provider IN ('google','apple','email','mindbody')`. Do not rewrite 20260816000100 (already applied). |
| `YYYYMMDDHHMMSS_amare_otp_challenges.sql` | 2A.5 | OTP rows only |

**`amare_otp_challenges` (2A.5):**

```text
id              bigserial PK
email_normalized text not null
code_hash       text not null          -- HMAC-SHA256 of code + server secret
expires_at      timestamptz not null
consumed_at     timestamptz
attempt_count   int not null default 0
created_at      timestamptz not null default now()
request_key     text                   -- hashed IP + email for rate limit, not raw IP if avoidable
```

Index: `(email_normalized, created_at desc)`.  
TTL cleanup: delete consumed/expired in verify path and a later scheduled Function if volume needs it.

**Not needed in 2A:**

- `clientId` on identities
- account-link challenge table — use signed state + existing `candidate` rows
- session table — cookie is the session
- audit log table

**Unchanged:** `amare_studio_assoc_site_client_active_uidx`, `amare_studio_assoc_user_site_active_uidx`.

---

## E. Public Endpoint Contract

Phase 1 had no public identity-write HTTP. 2A adds **only** these. Prefix `/api/amare/auth/*` to match `/api/mindbody/*` + `netlify.toml` redirects.  
No `handler` on `amare-identity-store.mjs`.

Maximum association status any 2A route may write: **`verified`**, and only `/claim/confirm`. Callbacks max: `candidate` / `ambiguous` / `unlinked`. Never `linked`.

### `GET /api/amare/auth/google/start` — 2A.3

| | |
|--|--|
| Auth | None |
| CSRF | Signed `state` (`signState`, 15 min like Mindbody start) + PKCE `code_verifier` in HttpOnly cookie |
| Rate limit | Per IP, e.g. 20/hour |
| Input | `return` via `safeReturnPath` |
| Output | 302 to Google |
| DB writes | None |
| Session writes | Short-lived `amare_oauth_pkce` cookie (not `amare_sess`) |
| Replay | State single-use (expire in state `exp`; reject reused `state` jti if we add jti) |
| Association | None |

### `GET\|POST /api/amare/auth/google/callback` — 2A.3

| | |
|--|--|
| Auth | Valid state + PKCE |
| CSRF | State must match |
| Rate limit | Per IP |
| Input | `code`, `state` |
| Output | 302 `return` or claim interstitial |
| DB writes | `amare_users` / `amare_identities` if new; `proposeAssociation` only |
| Session writes | `amare_sess` **only if** `ENABLE_AMARE_SESS_ISSUE=1` **and** `ENABLE_AMARE_AUTH_GOOGLE=1` |
| Replay | Authorization `code` is one-time at Google; reject invalid/used state |
| Association | Propose only. **Cannot** set `verified` |

### `GET /api/amare/auth/apple/start` — 2A.4

Same as Google start. Apple web often uses `response_mode=form_post`.

### `POST /api/amare/auth/apple/callback` — 2A.4

Same write ceiling as Google callback. Missing email on subsequent Apple logins is OK if `sub` hits an existing identity.

### `POST /api/amare/auth/email/request-code` — 2A.5

| | |
|--|--|
| Auth | None |
| CSRF | Same-origin + optional signed form token |
| Rate limit | Per email + per IP (e.g. 1/60s, 5/hour/email, 20/hour/IP) |
| Input | email |
| Output | **Always 200** generic `{ ok: true }` (enumeration protection) |
| DB writes | OTP challenge row |
| Session | None |
| Association | None |

### `POST /api/amare/auth/email/verify-code` — 2A.5

| | |
|--|--|
| Auth | None (possession of code) |
| CSRF | Same-origin |
| Rate limit | Lock after N attempts (e.g. 5) |
| Input | email + code |
| Output | 302 or JSON `{ amareUser: true, claim }` — never “email not found” vs “bad code” |
| DB writes | consume challenge; find/create user + email identity; propose association only |
| Session | `amare_sess` if flags on |
| Association | Propose only |

### `GET /api/amare/auth/session` — 2A.2+

| | |
|--|--|
| Auth | Optional `amare_sess` |
| CSRF | GET, no mutation |
| Input | Cookie |
| Output | `{ signedIn, amare_user_id, claimStatus }` — **no** `clientId`, no Mindbody tokens |
| DB writes | None (read identities / non-secret association **status** only) |
| Session | None |
| Association | Read-only |

Must not replace `GET /api/mindbody/oauth/session`. Header “Members” (`header-members.js`) keeps calling Mindbody session in 2A.

### `POST /api/amare/auth/logout` — 2A.2

| | |
|--|--|
| Auth | Cookie present or not (idempotent) |
| CSRF | Same-origin POST |
| Output | Clear `amare_sess` only (see §I / logout) |
| DB | None |
| Association | None |

### `POST /api/amare/auth/logout/all` — 2A.2 or 2A.7

Clears `amare_sess` **and** `mb_sess` (compose existing Mindbody clear cookie). Used by “Sign out completely.”

### `POST /api/amare/auth/claim/confirm` — 2A.3+ (needed as soon as Google can propose)

A future `/api/amare/auth/claim/confirm` must NOT trust a frontend-provided `client_id` as authority.  
The server must resolve the current authenticated user's stored candidate association and verify the confirmation against that server-side state. Prefer an opaque claim identifier / confirmation nonce where practical. **Do not implement this endpoint in 2A.1.**

| | |
|--|--|
| Auth | Valid `amare_sess` |
| CSRF | Same-origin + confirm nonce from session GET |
| Rate limit | Per user |
| Input | `{ explicitConfirm: true }` plus opaque claim id / nonce — not a trusted raw `client_id` |
| Output | `{ status: "verified" }` or 409 conflict |
| DB writes | `confirmAssociation` only |
| Session | Optional rotate `amare_sess` |
| Association | **`candidate` → `verified` only.** Never `linked`. Never skip confirm. |

Mindbody routes stay as today. 2A.6 does not add a new Mindbody start URL.

---

## F. Provider Flows

### Google (2A.3)

```text
Continue with Google
  → GET start (state + PKCE)
  → Google consent
  → callback
  → verify id_token / userinfo
  → identity key = sub (never email)
  → email stored if email_verified; else email null, still allow login if sub present
  → findIdentity(google, sub)
       hit  → that amare_user_id
       miss → createUserWithIdentity (transaction)
  → resolveClaimCandidate (mb_sess, email match count via Staff search)
  → proposeAssociation (candidate | ambiguous | unlinked+relay)
  → issue amare_sess if flags on
  → redirect to return or claim UI
```

Handle: denied OAuth, bad state, replay, missing `sub` (fail login, no user), `sub` already on another user (impossible on find; attach-second-provider path refuses), email mismatch (candidate via `mb_sess` or ambiguous), duplicate studio emails (ambiguous).

Logout: AMARÉ logout only. Do not hit Google revoke or log the user out of Google.

**Preview:** register **production** `https://www.amarewellness.com/api/amare/auth/google/callback` and **one** stable preview/localhost URI. Do not add every `deploy-preview-*` host. Test Google on local + named preview; Deploy Preview without registered URI stays flag-off.

Env (do not provision now): `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`, `ENABLE_AMARE_AUTH_GOOGLE`.

### Apple (2A.4)

Web Services ID. Client secret is a short-lived JWT from Apple key (env: key id, team id, private key).  
`sub` is stable. Email often only on **first** authorize.  
`is_private_relay`: existing `isApplePrivateRelayEmail` (`@privaterelay.appleid.com`). Also treat current Hide My Email / iCloud relay addresses the same if they match Apple’s relay domains at implementation time — still **no** auto Studio Client, **no** auto association (D9).

Missing email + existing `(apple, sub)` → login succeeds.  
Missing email + new `sub` → create user, association `unlinked` (or relay block if email is relay).

Preview: same “two redirect URIs” rule as Google. Native app Sign in with Apple is out.

Env placeholders: `APPLE_OAUTH_CLIENT_ID`, `APPLE_OAUTH_TEAM_ID`, `APPLE_OAUTH_KEY_ID`, `APPLE_OAUTH_PRIVATE_KEY`, `APPLE_OAUTH_REDIRECT_URI`, `ENABLE_AMARE_AUTH_APPLE`.

### Email OTP (2A.5)

```text
enter email → normalize (trim, lower)
  → request-code: always 200; send via sendResendEmail if allowed
  → 6-digit cryptographically random code, HMAC stored, TTL ~10 min, one-time
  → verify: constant-time compare; consume; findIdentity(email, normalized) or create
  → propose association only
  → amare_sess if flags on
```

Verified email proves **control of the mailbox**, not Studio ownership (D26).

Reuse `RESEND_API_KEY` and a new `AMARE_OTP_FROM` (or existing transactional from). Hash pepper: `AMARE_OTP_PEPPER` or `AMARE_SESSION_SECRET`.

No third-party OTP SaaS unless Resend deliverability blocks us — decide in the 2A.5 PR, not now.

### Mindbody legacy (2A.6)

Existing: start → callback → `buildSessionPayloadFromOAuthTokens` → `mb_sess` (30d).

Additive after payload built, if `ENABLE_AMARE_AUTH` + `ENABLE_AMARE_AUTH_MINDBODY_BRIDGE`:

```text
sub missing → log mindbody_identity_sub_missing; do not invent sub; mb_sess unchanged
sub exists  → findIdentity(mindbody, sub) or attach/create per design §6.1
              if clientId already verified/linked to user A, do not create user B
              propose association only; confirm stays /claim/confirm
              optionally issue amare_sess if ENABLE_AMARE_SESS_ISSUE=1
```

Do not change mobile OAuth in 2A.6 unless the same hook is trivially shared from `session-build.mjs` (preferred: hook inside `buildSessionPayloadFromOAuthTokens` so web + future mobile share it without rewriting mobile-exchange).

---

## G. Existing User Migration Cases

Live Book column is **always** “unchanged: still `mb_sess` + today’s `bookingAllowed` gate.”

| | Auth result | AMARÉ user | Association | Confirm? | Conflict? | `amare_sess` | Book |
|--|-------------|------------|-------------|----------|-----------|--------------|------|
| **A** Valid `mb_sess`, studio linked in Mindbody | Mindbody OAuth as today | Bridge: find/create by `sub` if present | Propose candidate from `session.client_id` (rank 2). Not auto-verified | Yes to reach `verified` | No unless mapping disagrees | If flags + sub | Unchanged |
| **B** Studio Client exists, never Consumer | Google/Apple/Email or later Mindbody | New user from social/email `sub` | Email unique → candidate; else unlinked | Yes if candidate | No | If flags | Unchanged (likely still not `bookingAllowed`) |
| **C** Stripe purchase, never logged in | Same as B | New user | Email may match the Staff-created client → candidate | Yes | No | If flags | Unchanged; Stripe fulfillment already Staff |
| **D** Mindbody `sub` + known `clientId` | Legacy login | Existing or new by `sub` | Rank 2 candidate | Yes | If that `clientId` verified to someone else | If flags | Unchanged |
| **E** `sub`, no Studio Client | Legacy login | User by `sub` | `unlinked` | No verify | No | If flags | Unchanged (`studio_not_linked` as today) |
| **F** Google/Apple/email identity exists | Same `sub` → same user | Reuse | Rank 1 if already verified; else re-evaluate | Only if still candidate | If `sub` vs other user | Re-issue | Unchanged |
| **G** Social email = exactly one Studio Client | Auth OK | User from `sub` | Rank 3 candidate | Yes | No | If flags | Unchanged |
| **H** Social email matches many clients | Auth OK | User from `sub` | `ambiguous` | Cannot auto-pick | No (ambiguous ≠ conflict) | If flags | Unchanged |
| **I** Social email ≠ studio email | Auth OK | User from `sub` | Rank 2 if `mb_sess`; else unlinked/ambiguous | Yes if candidate | If verified mapping ≠ new proof | If flags | Unchanged |
| **J** Apple relay | Auth OK (`sub`) | User from `sub` | `unlinked` + `apple_relay` | No bind | No | If flags | Unchanged |
| **K** `mb_sess` person A, Google person B | Google auth = B | B’s user | Do not attach A’s `clientId` to B without confirm; shared-computer | Yes; likely refuse / conflict | Yes if B already verified to other id, or confirm would steal A | B only | Unchanged (still A’s `mb_sess` until logout) |
| **L** Google `sub` = user B; Mindbody proof = user A’s client | Google → B | Stay B | Cannot verified-bind A’s client to B (D17) | Confirm would fail unique | **Yes** | B | Unchanged |
| **M** Same person adds second provider | Second IdP auth | Same `amare_user_id` after explicit link/confirm | Unchanged mapping (rank 1) | Yes to attach provider | If that `sub` owned elsewhere | Re-issue | Unchanged |

---

## H. Claim State Machine

Do not add `hasProfile`. Map UI to existing statuses:

| UI state | Association `status` / reason |
|----------|-------------------------------|
| `SIGNED_IN_NO_STUDIO_PROFILE` | `unlinked` (no block) or no row |
| `STUDIO_PROFILE_CANDIDATE` | `candidate` |
| `STUDIO_PROFILE_AMBIGUOUS` | `ambiguous` |
| `STUDIO_PROFILE_CONFIRM_REQUIRED` | `candidate` awaiting `/claim/confirm` |
| `STUDIO_PROFILE_VERIFIED` | `verified` (stored; unused by Book in 2A) |
| `STUDIO_PROFILE_CONFLICT` | `conflict` |
| `APPLE_RELAY_BLOCKED` | `unlinked` + `block_reason=apple_relay` |

`linked` is not a 2A UI state.

API: `GET /api/amare/auth/session` returns this enum. Confirm is the only writer to `verified`.

---

## I. Session Coexistence

Phase 1: `mb_sess` wins; `amare_sess` dark.  
2A: `amare_sess` = AMARÉ identity on **AMARÉ auth surfaces only**. Book stays Phase 1.

| Cookies | AMARÉ `/api/amare/auth/*` | Book / Waitlist / Cancel / Dashboard / `/api/mindbody/oauth/session` |
|---------|---------------------------|---------------------------------------------------------------------|
| Only `mb_sess` | Signed out as AMARÉ user (unless bridge just issued sess) | Today |
| Only `amare_sess` | Signed in as `amare_user_id` | **Logged out** for live member APIs |
| Both, same studio `clientId` as verified mapping | Align; log `dual_session_aligned` | Today (`mb_sess`) |
| Both, different `clientId` | `dual_session_conflict`; no privileged AMARÉ claim write | Today (`mb_sess`). Do not book-as-AMARÉ. Do not switch Book to A or B. |
| Neither | Signed out | Signed out |

2A must not make `mindbody-class-book.mjs` call `lookupActiveClientId`.

### Logout

| Action | Clears |
|--------|--------|
| AMARÉ logout `POST /api/amare/auth/logout` | `amare_sess` only |
| Mindbody logout `GET /api/mindbody/oauth/logout` | `mb_sess` only (today). **Keep.** 2A.7 copy: “Studio sign-out” vs “AMARÉ sign-out” |
| Full logout `POST /api/amare/auth/logout/all` | Both |
| Google/Apple account logout | **Not attempted.** We only drop AMARÉ cookies |

---

## J. Security Model

| Threat | Control |
|--------|---------|
| OAuth CSRF | `signState`/`verifyState`, 15 min `exp`, `return` allowlist |
| PKCE | Google (and Apple if supported); verifier in HttpOnly cookie |
| Callback replay | One-time state; provider one-time `code` |
| Session fixation | New `amare_sess` after login |
| Cookie theft | HttpOnly, SameSite=Lax, Secure on HTTPS (`cookieSecureFlag`) |
| OTP brute force | Attempt cap + lockout |
| OTP replay | `consumed_at` |
| OTP request abuse | Cooldown + IP/email caps |
| Email enumeration | Generic request-code response; generic verify errors |
| Social takeover / shared `mb_sess` | D8 confirm; case K |
| Account linking | Explicit confirm; refuse if `sub` owned |
| Provider `sub` collision | UNIQUE `(provider, provider_sub)` |
| Studio collision | D17 indexes |
| Dual-session | Log + refuse AMARÉ privileged claim; Book unchanged |
| Token leak in logs | No access/refresh; no raw email (hash or omit) |

Phase 1 helpers before they are reachable: transactional create+attach; `findIdentity`; confirm requires `amare_sess` user match; keep `promoteAssociationToLinked` throwing.

---

## K. Feature Flags

Match existing `ENABLE_*=1` style. All default **unset/off**.

| Flag | Meaning |
|------|---------|
| `ENABLE_AMARE_AUTH` | Master. Off → all new `/api/amare/auth/*` 404/disabled |
| `ENABLE_AMARE_AUTH_GOOGLE` | Google start/callback |
| `ENABLE_AMARE_AUTH_APPLE` | Apple start/callback |
| `ENABLE_AMARE_AUTH_EMAIL_OTP` | OTP routes |
| `ENABLE_AMARE_AUTH_MINDBODY_BRIDGE` | Additive identity write after existing Mindbody OAuth. **Does not hide** today’s Sign in with Mindbody |
| `ENABLE_AMARE_AUTH_UI` | 2A.7 `/login` AMARÉ panel |
| `ENABLE_AMARE_SESS_ISSUE` | **Already exists.** Must stay 0 until 2A.2+ reviewed. Issue cookie only when this **and** master **and** the provider flag are on |

Do **not** add `ENABLE_MINDBODY_LEGACY_LOGIN` that disables current OAuth — that would change production login.

`AMARE_SESSION_SECRET` required before any issue. Keep `MINDBODY_SESSION_SECRET` for `mb_sess`.

---

## L. Testing Matrix

Per PR: unit/DB + regression. Manual on preview where OAuth allowlists allow.

**Identity (2A.1+):** same `sub` → same user; `sub` cannot attach to user B; user can attach provider B after confirm; create identity ⇒ 0 association rows.

**Claim:** `mb_sess` candidate; email-only; email+phone; duplicates; mismatch; Apple relay; shared-computer K/L.

**Session (2A.2+):** issue, revisit, logout, expiry, aligned, conflict, none.

**OTP (2A.5):** valid, expired, replay, wrong, retry limit, resend limit.

**Provider failures:** denied, bad state, replay, missing `sub`, unverified email (Google: still login if `sub`; do not treat unverified email as rank 3).

**Regression after every PR:**

```text
Mindbody OAuth start/callback/session/logout still work
Book still resolveConsumerClient + studio_not_linked
Waitlist / Cancel / Dashboard / Stripe unchanged
consumerAssociated / bookingAllowed unchanged
ENABLE_AMARE_SESS_ISSUE default off unless that PR’s flag matrix says otherwise
```

Reuse `qa-book-block-logic.mjs` / `qa-amare-identity-*` and add `scripts/qa-amare-auth-2a*.mjs`.

---

## M. Observability

JSON console events (no tokens, no raw email):

```text
login_provider
login_success
login_failure
amare_user_created          (already in store)

login_mindbody_already_linked
login_mindbody_claim_success
mindbody_identity_sub_missing

claim_candidate
claim_confirmed             (existing amare_association_confirmed)
claim_ambiguous
claim_conflict
claim_relay_blocked         (existing amare_association_blocked_relay)

identity_attached_after_mindbody
identity_attached_mindbody_after_social

amare_session_issued
amare_session_cleared
dual_session_aligned        (extend logAmareSessVersusMbSess)
dual_session_conflict
```

---

## N. Rollback

| PR | Disable | Data remains | `mb_sess` | Identities |
|----|---------|--------------|-----------|------------|
| 2A.1 | N/A (schema only) | Tables/CHECK | Works | Rows unused by Book |
| 2A.2 | `ENABLE_AMARE_SESS_ISSUE=0` | None required | Works | Safe |
| 2A.3 | `ENABLE_AMARE_AUTH_GOOGLE=0` | Google identity rows | Works | Retain |
| 2A.6 | `ENABLE_AMARE_AUTH_MINDBODY_BRIDGE=0` | mindbody identity rows | **Unchanged path** | Retain |
| 2A.4 | `ENABLE_AMARE_AUTH_APPLE=0` | Apple rows | Works | Retain |
| 2A.5 | `ENABLE_AMARE_AUTH_EMAIL_OTP=0` | OTP rows expire; email identities stay | Works | Retain |
| 2A.7 | `ENABLE_AMARE_AUTH_UI=0` | None | Works; old `/login` strip remains | Retain |

Never delete a Studio Client or credits. Identities are additive. Master `ENABLE_AMARE_AUTH=0` disables new routes without touching Mindbody.

---

## O. Exact Files

### Database migrations

| File | 2A |
|------|----|
| `netlify/database/migrations/20260816000100_amare_identity.sql` | **UNCHANGED** |
| `netlify/database/migrations/<ts>_amare_identities_provider_mindbody.sql` | **NEW** (2A.1) |
| `netlify/database/migrations/<ts>_amare_otp_challenges.sql` | **NEW** (2A.5) |

### Shared auth libraries

| File | 2A |
|------|----|
| `netlify/functions/amare-identity-policy.mjs` | **MODIFY** only if claim helper needs extra fields (prefer no behavior change) |
| `netlify/functions/amare-identity-store.mjs` | **MODIFY** (2A.1 lookups/transaction/`mindbody`; still no `handler`) |
| `netlify/functions/amare-sess-lib.mjs` | **MODIFY** (2A.2 cookie/exp/resolver) |
| `netlify/functions/amare-auth-lib.mjs` | **NEW** (2A.2 — flags, claim evaluate, current user) |
| `netlify/functions/oauth-lib.mjs` | **UNCHANGED** (import seal/state/safeReturn) |

### Google / Apple / Email

| File | 2A |
|------|----|
| `netlify/functions/amare-auth-google-start.mjs` | **NEW** 2A.3 |
| `netlify/functions/amare-auth-google-callback.mjs` | **NEW** 2A.3 |
| `netlify/functions/amare-auth-apple-start.mjs` | **NEW** 2A.4 |
| `netlify/functions/amare-auth-apple-callback.mjs` | **NEW** 2A.4 |
| `netlify/functions/amare-auth-email-request.mjs` | **NEW** 2A.5 |
| `netlify/functions/amare-auth-email-verify.mjs` | **NEW** 2A.5 |
| `netlify/functions/amare-auth-session.mjs` | **NEW** 2A.2 |
| `netlify/functions/amare-auth-logout.mjs` | **NEW** 2A.2 |
| `netlify/functions/amare-auth-claim-confirm.mjs` | **NEW** 2A.3 |
| `netlify/functions/resend-email-client.mjs` | **UNCHANGED** (call it) |

### Mindbody bridge

| File | 2A |
|------|----|
| `netlify/functions/mindbody-oauth-session-build.mjs` | **MODIFY** 2A.6 additive hook only |
| `netlify/functions/mindbody-oauth-callback.mjs` | **UNCHANGED** if hook is entirely in session-build; else **MODIFY** minimally |
| `mindbody-oauth-start.mjs`, `session.mjs`, `logout.mjs`, `complete-studio-profile.mjs`, `mobile-*` | **UNCHANGED** |

### Session / frontend

| File | 2A |
|------|----|
| `src/js/amare-auth.js` | **NEW** 2A.7 |
| `src/content/login.html` or evolve `mindbody-login.html` behind `ENABLE_AMARE_AUTH_UI` | **NEW/MODIFY** 2A.7 only |
| `src/js/mindbody-auth.js` | **UNCHANGED** in 2A.1–2A.6; 2A.7 may add a link to AMARÉ login, not Book CTA rewrite |
| `src/js/header-members.js` | **UNCHANGED** in 2A (still Mindbody session) |

### Tests / QA / config / docs

| File | 2A |
|------|----|
| `scripts/qa-amare-identity-*.mjs` | **MODIFY** 2A.1+ |
| `scripts/qa-amare-auth-2a*.mjs` | **NEW** |
| `package.json` scripts | **MODIFY** |
| `.env.example` | **MODIFY** (commented flags + secrets) |
| `netlify.toml` | **MODIFY** redirects for `/api/amare/auth/*` only when that PR adds the Function |
| `docs/AMARE-AUTH-PHASE02-DESIGN.md` | **UNCHANGED** after this approval except contradictions |
| this plan | living; update if a PR learns a fact |

---

## P. Explicitly Unchanged Live Flows (all of 2A)

Do not edit these for authentication work:

```text
netlify/functions/mindbody-class-book.mjs
netlify/functions/mindbody-class-book-lib.mjs
netlify/functions/mindbody-class-cancel.mjs
netlify/functions/mindbody-class-waitlist-remove.mjs
netlify/functions/mindbody-class-classes.mjs
netlify/functions/mindbody-member-summary.mjs
netlify/functions/mindbody-consumer-lib.mjs   (resolveConsumerClient / bookingAllowed)
src/js/classes-schedule.js                    (Book/Waitlist CTA + bookingAllowed gate)
src/js/member-dashboard.js
src/js/pricing-api.js
src/js/stripe-express-cta.js
src/js/checkout-success.js
netlify/functions/stripe-*.mjs
netlify/functions/mindbody-sale-*.mjs
```

2A.7 must not change Book dialog strings from “Sign in with Mindbody” to AMARÉ primary buttons.

---

## Q. GO / NO-GO per PR

| PR | GO to next only if |
|----|-------------------|
| **2A.1** | Migration applied local + preview; UNIQUE proven for all four providers; create user+identity ⇒ 0 association rows; `promoteAssociationToLinked` still throws; Book files untouched; `test:amare-identity` + `test:amare-identity-db` pass |
| **2A.2** | Seal/unseal/`exp`/logout tests pass; cookie has no `client_id`; `ENABLE_AMARE_SESS_ISSUE` default 0; `/oauth/session` JSON unchanged; Book untouched |
| **2A.3** | Google preview (or local) find/create + propose-only; callback cannot write `verified`; claim/confirm with `explicitConfirm` only; cases F/G/H/K covered in tests; Mindbody OAuth regression; flags off in prod until review |
| **2A.6** | Missing `sub` does not invent keys; `mb_sess` still set; bridge flag off = byte-compatible callback; D/E/L tests; OAuth start/logout/mobile unchanged |
| **2A.4** | Relay cannot bind; second Apple login without email works; no Studio Client create; web only |
| **2A.5** | OTP abuse tests; generic responses; email identity ≠ auto-verified association |
| **2A.7** | UI behind `ENABLE_AMARE_AUTH_UI`; Mindbody visually secondary; Book/Dashboard CTAs unchanged; each provider flag independently hides its button |

**2A.1 is implemented as schema + store groundwork only. Do not start 2A.2 until 2A.1 is reviewed.**

---

```text
PHASE 2 DESIGN:
APPROVED

PHASE 2A IMPLEMENTATION:
2A.1 LANDED (schema + identity-store only)
2A.2+ NOT STARTED

MIGRATION:
20260816083000_amare_identities_provider_mindbody.sql

PROVIDERS ALLOWED:
google | apple | email | mindbody

PUBLIC AUTH HTTP:
NONE

AMARE_SESS:
STILL DARK

NEXT SAFE STEP:
PR 2A.2 — AMARÉ session core
DO NOT START 2A.2 UNTIL 2A.1 IS REVIEWED.
```
