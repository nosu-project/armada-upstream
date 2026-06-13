/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_NAME?: string;
  readonly VITE_PLATFORM_RELAYS?: string;
  readonly VITE_APP_RELAYS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
