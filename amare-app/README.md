# AMARÉ Mobile App (Phase 1)

Capacitor + React client for booking and member profile. Uses the **same backend** as [amare-site](../) — does not modify the website.

## Quick start (local)

### 1. Backend + website

Terminal 1 — from repo root:

```powershell
cd c:\Users\snir1\amare-site
npm run dev
```

Site + API: http://127.0.0.1:4321

### 2. Enable mobile auth in `.env` (repo root)

```env
ENABLE_MOBILE_BEARER_AUTH=1
MINDBODY_OAUTH_MOBILE_REDIRECT_URI=https://YOUR-TUNNEL.ngrok-free.app/api/mindbody/oauth/mobile-bridge
```

Register that **mobile-bridge** URL in Mindbody Developer Portal (same OAuth app — add redirect, do not replace web callback).

### 3. HTTPS tunnel (Mindbody requires HTTPS for OAuth)

Terminal 2:

```powershell
ngrok http 4321
```

Copy the `https://….ngrok-free.app` URL into:

- Root `.env` → `MINDBODY_OAUTH_MOBILE_REDIRECT_URI=https://….ngrok-free.app/api/mindbody/oauth/mobile-bridge`
- `amare-app/.env` → `VITE_OAUTH_API_BASE=https://….ngrok-free.app`

Restart `npm run dev` after changing root `.env`.

### 4. App

Terminal 3:

```powershell
cd c:\Users\snir1\amare-site\amare-app
copy .env.example .env
npm install
npm run dev
```

Open http://127.0.0.1:5178

### 5. Test flow

1. Browse **Schedule** (works without login)
2. **Sign in with Mindbody** → Mindbody Identity → returns to app
3. **Book** a class
4. **My Classes** / **Profile**

## Safety

- Website at :4321/classes is unchanged (cookie auth)
- Mobile auth is off until `ENABLE_MOBILE_BEARER_AUTH=1`

See also: [AMARE-APP-PHASE0.md](../docs/AMARE-APP-PHASE0.md)
