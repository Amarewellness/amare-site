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
  plugins: {},
};

export default config;
