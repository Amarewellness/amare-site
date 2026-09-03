import type { CapacitorConfig } from "@capacitor/cli";

/**
 * iOS (when the Xcode project is added):
 * - Target → General → Deployment Info → iPhone only (TARGETED_DEVICE_FAMILY = 1)
 * - Device Orientation: Portrait only (UISupportedInterfaceOrientations)
 * - Do not set iPad orientations — avoids App Store iPad multitasking error 90474
 */
const config: CapacitorConfig = {
  appId: "com.amarewellness.app",
  appName: "AMARÉ",
  webDir: "dist",
  server: {
    androidScheme: "https",
    /** WKWebView origin; matches Android https scheme for secure context APIs. */
    iosScheme: "https",
  },
  ios: {
    contentInset: "automatic",
  },
  plugins: {
    SplashScreen: {
      /** Hand off to the in-app StartupScreen as soon as the WebView shell mounts. */
      launchAutoHide: false,
      launchFadeOutDuration: 220,
      backgroundColor: "#faf3eb",
    },
  },
};

export default config;
