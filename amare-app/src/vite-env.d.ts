/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE: string;
  readonly VITE_OAUTH_API_BASE: string;
  readonly VITE_PRICING_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
