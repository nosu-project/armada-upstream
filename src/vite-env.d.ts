/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_NAME?: string;
  readonly VITE_PLATFORM_RELAYS?: string;
  readonly VITE_PIN_PLATFORM_RELAYS?: string;
  readonly VITE_APP_RELAYS?: string;
  readonly VITE_SEARCH_RELAYS?: string;
  readonly VITE_APP_BLOSSOM_SERVERS?: string;
  readonly VITE_CONCORD_AV_SERVERS?: string;
  readonly VITE_DM_VOICE_RELAYS?: string;
  readonly VITE_DEFAULT_NOISE_SUPPRESSION?: string;
  readonly VITE_DEFAULT_ECHO_CANCELLATION?: string;
  readonly VITE_DEFAULT_AUTO_GAIN_CONTROL?: string;
  readonly VITE_DEFAULT_RNNOISE?: string;
  readonly VITE_SANDBOX_DOMAIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
