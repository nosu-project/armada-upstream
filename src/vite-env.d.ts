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
  /** Semver version from package.json (e.g., "0.25.4"). */
  readonly VERSION: string;
  /** ISO 8601 timestamp of when the app was built. */
  readonly BUILD_DATE: string;
  /** Short git commit SHA. Empty string if unavailable. */
  readonly COMMIT_SHA: string;
  /** Git tag for the current commit (e.g., "v0.25.4"). Empty string if untagged (pre-release build). */
  readonly COMMIT_TAG: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
