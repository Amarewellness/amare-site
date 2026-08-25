# AMARÉ App — Samsung S25 Staging QA

Native Android QA against **Netlify deploy-preview / branch-deploy** (HTTPS). Not localhost, not Vite dev server, not production unless explicitly approved.

Related: [`AMARE-APP-STORE-REVIEW-NOTES.md`](./AMARE-APP-STORE-REVIEW-NOTES.md), account deletion migration `netlify/database/migrations/20260825103000_amare_account_deletion.sql`.

---

## Prerequisites (Netlify — deploy-preview / branch-deploy context)

Set on the **preview/staging deploy** only. Do **not** enable on production.

| Flag | Required | Notes |
|------|----------|-------|
| `ENABLE_MOBILE_BEARER_AUTH` | `1` | AMARÉ Bearer tokens for app |
| `ENABLE_AMARE_AUTH` | `1` | AMARÉ auth routes |
| `ENABLE_AMARE_AUTH_EMAIL_OTP` | `1` | Email OTP login |
| `ENABLE_AMARE_SESS_ISSUE` | `1` | Session issue (if cookie paths tested) |
| `ENABLE_AMARE_MEMBER_READ` | `1` | Member access / profile |
| `ENABLE_AMARE_STUDIO_OPERATIONS` | `1` | Linked studio operations |
| `ENABLE_AMARE_COMMERCE` | `1` | Only if testing Purchase |
| `ENABLE_STRIPE_ONE_TIME_CHECKOUT` | `1` | Purchase one-time (if testing) |
| Mobile PaymentSheet flags | as needed | If testing in-app Stripe on Android |
| `VITE_ENABLE_AMARE_PUSH` | `0` | Push OFF for MVP QA |
| `AMARE_SESSION_SECRET` | set | Required for AMARÉ sessions |
| OTP / email provider vars | set | Same as local AMARÉ OTP |

**Staging DB migration (preview DB only — never production):**

```sql
-- netlify/database/migrations/20260825103000_amare_account_deletion.sql
```

Apply via Netlify DB migrate on deploy-preview, or run manually against the preview database branch.

**Deploy:** Create a deploy-preview or branch-deploy with uncommitted work **before** S25 QA. Production env must remain unchanged.

---

## Staging URL patterns

Netlify site slug: `silly-bubblegum-ad7f6c`

| Type | URL pattern |
|------|-------------|
| Deploy preview | `https://deploy-preview-{N}--silly-bubblegum-ad7f6c.netlify.app` |
| Branch deploy | `https://{branch-slug}--silly-bubblegum-ad7f6c.netlify.app` |

Record the exact HTTPS URL from Netlify after deploy — that becomes `AMARE_ANDROID_STAGING_API_BASE` and `VITE_API_BASE` in the APK.

---

## Build (production-like assets, staging API)

From `amare-app/` on Windows (JDK 21, Android SDK):

```powershell
$env:JAVA_HOME = "C:\Program Files\Microsoft\jdk-21.0.12.8-hotspot"
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:AMARE_ANDROID_STAGING_API_BASE = "https://deploy-preview-N--silly-bubblegum-ad7f6c.netlify.app"
npm run android:assemble-staging-debug
```

- **Vite mode:** `android-staging` → gitignored `.env.android-staging` (HTTPS only, no localhost)
- **Capacitor:** syncs built `dist/` into Android assets (not dev server)
- **APK:** `amare-app/android/app/build/outputs/apk/debug/app-debug.apk`
- **Signing:** debug-signed (`assembleDebug`) — OK for S25 QA

### Install on Samsung S25

```powershell
adb devices
adb install -r amare-app\android\app\build\outputs\apk\debug\app-debug.apk
```

Enable USB debugging on the phone. Use `-r` to replace an existing debug install.

---

## App build confirmations

| Check | Expected |
|-------|----------|
| Login | Email OTP only |
| Mindbody login UI | Absent |
| `/auth/callback` | Redirects to `/login` |
| Account deletion | Profile → Delete AMARÉ app account |
| API base | Staging HTTPS URL baked in (verify in Network tab) |
| Production env | Not changed |

---

## S25 QA checklist

1. **Fresh install** → Login shows Email OTP only (no Mindbody / Google / Apple login).
2. **OTP login** works for a linked member (schedule + profile data).
3. **Legacy `sessionKind: "mindbody"`** storage cleared on startup (install old debug APK with mindbody session, then staging APK → forced login).
4. **Schedule** loads.
5. **Book** a class.
6. **Cancel** a class.
7. **Waitlist** join/remove if available.
8. **Profile** loads (credits, membership sections when linked).
9. **Purchase** screen opens; copy describes studio passes/memberships (in-studio services, not digital content).
10. **Delete AMARÉ app account:**
    - sends OTP
    - wrong OTP fails
    - correct OTP deletes
    - user signed out
    - old token fails (`account_deleted` / not authenticated)
11. **Same email** can OTP again as new AMARÉ user; must re-link/claim normally.
12. **No Stripe cancellation** from deletion flow.
13. **No Mindbody mutation** from deletion flow.
14. **Website auth** unchanged (cookie / Mindbody OAuth on www still works).

---

## Website untouched

This QA path only changes the Capacitor app build env. Website Mindbody OAuth, cookie auth, and backend Mindbody endpoints for the website are not modified by the Android staging build.
