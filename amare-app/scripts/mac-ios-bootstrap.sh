#!/usr/bin/env bash
# AMARÉ iOS — one-time Mac bootstrap (run from amare-app/ on macOS with Xcode).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "== AMARÉ iOS bootstrap =="
echo "Node: $(node -v)"
echo "Platform: $(uname -s)"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "ERROR: This script requires macOS + Xcode." >&2
  exit 1
fi

if ! command -v xcodebuild >/dev/null 2>&1; then
  echo "ERROR: Xcode not found. Install Xcode from the Mac App Store." >&2
  exit 1
fi

echo "Xcode: $(xcodebuild -version | head -1)"

npm install

if [[ ! -d ios ]]; then
  echo "Adding iOS platform..."
  npx cap add ios
else
  echo "ios/ already exists — skipping cap add ios"
fi

echo "Building web assets (staging — set AMARE_IOS_STAGING_API_BASE for preview URL)..."
if [[ -z "${AMARE_IOS_STAGING_API_BASE:-}" ]]; then
  echo "WARN: AMARE_IOS_STAGING_API_BASE not set; using production API for sync."
  npm run cap:sync:ios-release
else
  npm run cap:sync:ios-staging
fi

echo "Configuring native plist (portrait, display name)..."
node scripts/configure-ios-native.mjs

echo "Installing CocoaPods..."
cd ios/App
pod install
cd "$ROOT"

echo ""
echo "Bootstrap complete. Next steps:"
echo "  1. open ios/App/App.xcworkspace"
echo "  2. Select Team, Bundle ID com.amarewellness.app, connect iPhone"
echo "  3. Run on device (⌘R)"
echo "  4. Complete testflight/testflight-qa-checklist.txt"
echo ""
echo "See docs/IOS-MAC-HANDOFF.md for full checklist."
