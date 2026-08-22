/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_NAME?: string;
  /** KLIPY GIF API key, injected at build time. */
  readonly VITE_KLIPY_API_KEY?: string;
  readonly VITE_APP_RELAYS?: string;
  /** Comma-separated write-only relays: published to, never read from. */
  readonly VITE_BROADCAST_RELAYS?: string;
  readonly VITE_SEARCH_RELAYS?: string;
  /** Comma-separated NIP-65 indexers used only for bounded login discovery. */
  readonly VITE_NIP65_DISCOVERY_RELAYS?: string;
  /** NIP-34 repository directory relay. Empty = no directory search. */
  readonly VITE_GIT_DISCOVERY_RELAY?: string;
  readonly VITE_APP_BLOSSOM_SERVERS?: string;
  readonly VITE_CONCORD_AV_SERVERS?: string;
  readonly VITE_DEFAULT_NOISE_SUPPRESSION?: string;
  readonly VITE_DEFAULT_ECHO_CANCELLATION?: string;
  readonly VITE_DEFAULT_AUTO_GAIN_CONTROL?: string;
  readonly VITE_DEFAULT_RNNOISE?: string;
  readonly VITE_SANDBOX_DOMAIN?: string;
  /** Generic link-preview proxy template, `{url}` = encoded target. Empty = generic previews disabled. */
  readonly VITE_LINK_PREVIEW_ENDPOINT?: string;
  /** Discord bridge portal origin (e.g. "https://bridge.armada.buzz"). Empty/unset = Discord import UI hidden. */
  readonly VITE_BRIDGE_PORTAL_URL?: string;
  /** NIP-34 repo identifier whose releases `/downloads` offers (the 30617 `d`). Unset = "armada". */
  readonly VITE_RELEASE_REPO_ID?: string;
  /** Comma-separated hex pubkeys whose kind-30622 releases are trusted. Unset = Armada's release signer. */
  readonly VITE_RELEASE_AUTHORS?: string;
  /** Comma-separated relays `/downloads` reads releases from. Unset = the repository's own relays. */
  readonly VITE_RELEASE_RELAYS?: string;
  /** Plausible site domain (e.g. "armada.buzz"). Empty/unset = analytics disabled. */
  readonly VITE_PLAUSIBLE_DOMAIN?: string;
  /** Plausible API endpoint (self-hosted instance or proxy). Empty/unset = Plausible Cloud default. */
  readonly VITE_PLAUSIBLE_ENDPOINT?: string;
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
