AMARÉ Wellness — iOS / App Store release preparation (draft only)
==================================================================

This folder is LOCAL DRAFT MATERIAL for App Store Connect and TestFlight.
It is NOT part of the git-tracked app build. Do not commit secrets here.

Status: ios-shell branch — repo prep done on Windows; native ios/ pending Mac bootstrap.

Branch: ios-shell (from main @ 496f63e)
Mac handoff: docs/IOS-MAC-HANDOFF.md
Push diagnosis: push-diagnosis.txt
QA template: testflight/iphone-qa-report.txt

Canonical app reference (Android release baseline):
  origin/main @ 496f63e29e85d61f7ad49b5349feb5bec7c0adb6
  Package / Bundle ID: com.amarewellness.app
  Version: 1.0 (build 1)

What this folder contains:
  - Readiness plan and blockers
  - App Store Connect metadata drafts (copy-paste ready)
  - Asset requirements (icon, screenshots, launch screen)
  - TestFlight QA checklist and reviewer access notes

What this folder does NOT contain:
  - Signed .ipa / Archive exports
  - Xcode project (amare-app/ios/ does not exist yet)
  - GoogleService-Info.plist, APNs keys, or certificates
  - Final 1024x1024 icon or iPhone screenshots

Do NOT:
  - Reuse Google Play screenshots as final App Store screenshots
  - Upload draft copy without verifying against the current app build
  - Commit keystore, APNs .p8 keys, or provisioning profiles here

Recommended workflow:
  1. Resolve blockers.txt (D-U-N-S, Apple Developer Org, Mac/Xcode)
  2. Add iOS Capacitor project on Mac (when ready — not in this phase)
  3. Produce assets in assets-needed/ checklist
  4. Internal TestFlight QA using testflight/testflight-qa-checklist.txt
  5. Paste app-store-metadata/ into App Store Connect
  6. Submit for App Review

Related Android release folder (separate, do not mix uploads):
  AMARE_ANDROID_RELEASE_1.0/
