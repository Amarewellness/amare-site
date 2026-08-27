# AMARÉ iOS — Mac / Xcode handoff checklist

**Created:** ios-shell branch prep (Windows environment — native iOS not built here)

## Environment status (Windows prep machine)

| Requirement | Status |
|-------------|--------|
| macOS | **NOT AVAILABLE** (Windows 10/11) |
| Xcode | **NOT INSTALLED** |
| CocoaPods | **NOT AVAILABLE** |
| Real iPhone QA | **NOT RUN** — requires Mac + signing |
| Apple Developer account | **UNKNOWN** — studio must confirm |

**Do not claim iOS build or iPhone QA complete until this checklist is done on Mac.**

---

## Prerequisites (studio / Mac operator)

- [ ] Apple Developer Program enrolled (Organization recommended; D-U-N-S if org)
- [ ] Mac with **Xcode 15+** (App Store)
- [ ] Xcode Command Line Tools: `xcode-select --install`
- [ ] **CocoaPods**: `sudo gem install cocoapods` (or Homebrew `brew install cocoapods`)
- [ ] Node.js 20+ (match dev machine: v22 OK)
- [ ] Git: checkout branch `ios-shell`
- [ ] Physical **iPhone** (iOS 16+ recommended) + USB cable
- [ ] iPhone registered in Apple Developer → Devices (automatic when connecting to Xcode)

---

## One-time bootstrap (Mac)

From repo root:

```bash
git fetch origin
git checkout ios-shell
cd amare-app
chmod +x scripts/mac-ios-bootstrap.sh
```

### Option A — staging QA against Netlify preview

```bash
export AMARE_IOS_STAGING_API_BASE="https://YOUR-DEPLOY-PREVIEW.netlify.app"
./scripts/mac-ios-bootstrap.sh
```

### Option B — production API (TestFlight candidate)

```bash
# Uses https://www.amarewellness.com — push OFF by default in iOS release env
./scripts/mac-ios-bootstrap.sh
# Or manually:
npm run cap:sync:ios-release
node scripts/configure-ios-native.mjs
cd ios/App && pod install && cd ../..
```

---

## Xcode configuration (manual)

Open workspace (not .xcodeproj):

```bash
open ios/App/App.xcworkspace
```

| Setting | Value |
|---------|--------|
| **Bundle Identifier** | `com.amarewellness.app` |
| **Display Name** | AMARÉ |
| **Version** | 1.0 |
| **Build** | 1 (increment per upload) |
| **Deployment Target** | iOS 14.0+ (Capacitor 7 default — confirm in Podfile) |
| **Device Orientation** | Portrait only (script sets Info.plist; verify in General) |
| **Signing** | Automatic + your Team |
| **Launch Screen** | Background `#faf3eb` — match Android cream splash |
| **App Icons** | AppIcon asset catalog; App Store needs 1024×1024 separately |

### Capabilities — do NOT enable until ready

| Capability | When |
|------------|------|
| **Push Notifications** | After Firebase iOS app + `GoogleService-Info.plist` + APNs .p8 in Firebase |
| **Sign in with Apple** | **NOT NEEDED** — app uses email OTP only |

### Privacy manifest

If Xcode reports missing privacy manifest for a pod, add/update `PrivacyInfo.xcprivacy` per Apple guidance. Capacitor 7 plugins may ship their own — verify at first Archive.

---

## Run on physical iPhone

1. Connect iPhone → trust computer
2. Xcode target: **App** → destination: your iPhone
3. **Product → Run** (⌘R)
4. First install: Settings → General → VPN & Device Management → trust developer
5. Execute QA: `AMARE_IOS_RELEASE_1.0/testflight/testflight-qa-checklist.txt`

---

## Archive / TestFlight

1. **Product → Archive**
2. **Distribute App → App Store Connect**
3. Upload build → Internal Testing group
4. Install **TestFlight** on iPhone → open build

---

## What Windows prep already did (ios-shell branch)

- Added `@capacitor/ios` to `package.json`
- Added `write-ios-release-env.mjs` / `write-ios-staging-env.mjs`
- Added npm scripts: `build:ios-*`, `cap:sync:ios-*`, `ios:configure-native`
- Added `configure-ios-native.mjs` + `mac-ios-bootstrap.sh`
- **Did NOT** run `npx cap add ios` (requires Mac for CocoaPods)
- **Did NOT** modify Android release or `AMARE_ANDROID_RELEASE_1.0/FINAL_PLAY_UPLOAD/`

---

## Shared dist — Android release safety

Do not run bare `npx cap sync android` after an iOS or generic Vite build, because `amare-app/dist/` is shared. For Android release builds, always use `npm run android:bundle-release` or `npm run cap:sync:android-release`, which rebuilds Android with `.env.android-release` and `VITE_ENABLE_AMARE_PUSH=1`.

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `pod install` fails | `pod repo update`; Xcode license: `sudo xcodebuild -license accept` |
| Signing error | Select Team; enable Automatic Signing; register device |
| White flash on launch | Launch Screen `#faf3eb`; confirm `launchAutoHide: false` in capacitor.config.ts |
| OTP email not received | Production API must have auth enabled; use staging preview with flags |
| Checkout opens blank | Ensure HTTPS API base; check Safari not blocking |

---

## Push (deferred)

See `AMARE_IOS_RELEASE_1.0/push-diagnosis.txt`. **Ship iOS v1 with push disabled** (`VITE_ENABLE_AMARE_PUSH=0`) until Firebase iOS verified.
