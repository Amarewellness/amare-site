import type { CapacitorConfig } from "@capacitor/cli";

/**
 * iOS (when the Xcode project is added):
 * - Target → General → Deployment Info → Device Orientation: Portrait only
 * - Or Info.plist: UISupportedInterfaceOrientations = UIInterfaceOrientationPortrait
 */
const config: CapacitorConfig = {
  appId: "com.amarewellness.app",
  appName: "AMARÉ",
  webDir: "dist",
  server: {
    androidScheme: "https",
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
