import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  return {
    plugins: [react()],
    define: {
      "import.meta.env.VITE_ENABLE_AMARE_PUSH": JSON.stringify(env.VITE_ENABLE_AMARE_PUSH || "0"),
    },
    server: {
      port: 5178,
      strictPort: true,
    },
  };
});
