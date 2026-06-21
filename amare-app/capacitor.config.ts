import type { CapacitorConfig } from "@capacitor/cli";

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
