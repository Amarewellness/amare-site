# AMARÉ Mobile App

Capacitor + React client for booking and member profile. Uses the **same backend** as [amare-site](../).

Primary login is **Email OTP** against AMARÉ identity (`amare_user_id`). Mindbody is a fallback only. Apple and Google are not exposed.

## Quick start (local)

### 1. Backend + website

From repo root:

```powershell
npm run dev
```

Site + API: http://127.0.0.1:4321

Local `.env` must include:

```env
ENABLE_AMARE_AUTH=1
ENABLE_MOBILE_BEARER_AUTH=1
```

Production stays off. Do not deploy these flags.

### 2. App

```powershell
cd amare-app
copy .env.example .env
npm install
npm run dev
```

Open http://127.0.0.1:5178

### 3. Test flow

1. Schedule works without login
2. **Sign in** → Email OTP (primary)
3. Existing customer: confirm the found profile (no “Continue as a new account”)
4. New customer: first / last / mobile → D28 profile
5. Kill the app and reopen — AMARÉ session should restore
6. Optional: **Sign in with Mindbody** on the login screen (fallback)

Mindbody OAuth still needs an HTTPS tunnel. See below.

## Session

The app does **not** share website cookies.

- Web site: HttpOnly `amare_sess` / `mb_sess`
- App: `Authorization: Bearer` AMARÉ mobile JWT (`amare_mobile_access` / `amare_mobile_refresh`)
- Mindbody fallback: existing `mobile_access` / `mobile_refresh` pair

Native builds store tokens in Keychain / Keystore via `@aparajita/capacitor-secure-storage`. The Vite browser uses localStorage only because it is not a native app.

## Mindbody fallback (optional)

```env
MINDBODY_OAUTH_MOBILE_REDIRECT_URI=https://YOUR-TUNNEL.ngrok-free.app/api/mindbody/oauth/mobile-bridge
```

```powershell
ngrok http 4321
```

Set `amare-app/.env` → `VITE_OAUTH_API_BASE=https://….ngrok-free.app` and restart `npm run dev`.

## Android debug APK on LAN (physical phone)

Do not use this for production. Production API URLs stay unchanged.

1. Computer and phone on the same Wi-Fi.
2. From repo root: `npm run dev:lan` (binds `0.0.0.0:4321`).
3. From `amare-app/`:

Needs JDK 21 (`JAVA_HOME` → Microsoft OpenJDK 21). Capacitor Android 7 will not compile on JDK 17.

```powershell
$env:JAVA_HOME = "C:\Program Files\Microsoft\jdk-21.0.12.8-hotspot"
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
npm run cap:sync:android-debug
cd android
.\gradlew.bat assembleDebug
```

APK: `amare-app/android/app/build/outputs/apk/debug/app-debug.apk`

The debug build embeds `http://<LAN-IP>:4321`. Debug-only cleartext HTTP is allowed so the phone can reach that URL. Release/store config is not changed.

Mindbody OAuth still needs an HTTPS tunnel. Email OTP works over LAN HTTP.

## Safety

- Website cookie auth is unchanged
- Mobile bearer is off until `ENABLE_MOBILE_BEARER_AUTH=1`
- Do not enable in production in this phase

See also: [AMARE-APP-PHASE0.md](../docs/AMARE-APP-PHASE0.md)
