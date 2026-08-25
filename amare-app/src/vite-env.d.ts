/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE: string;
  readonly VITE_OAUTH_API_BASE: string;
  readonly VITE_PRICING_URL: string;
  readonly VITE_ENABLE_AMARE_PUSH: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
