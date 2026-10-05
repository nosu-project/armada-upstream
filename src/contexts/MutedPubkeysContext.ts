import { createContext } from "react";

export interface MutedPubkeysResult {
  mutedPubkeys: Set<string>;
  /**
   * Whether the mute set is settled enough to filter on (false only during a cold
   * first load), so consumers can avoid showing then hiding muted content.
   */
  ready: boolean;
  /**
   * True only after a successful current relay read (or explicit local
   * mutation built on one). A folded seed is last-good data, not prune proof.
   */
  wireReady?: boolean;
  /**
   * A complete current wire read OR a versioned last-good folded snapshot.
   * This is enough to write a privacy-safe notification config, but only
   * `wireReady` may authorize pruning gateway registrations.
   */
  configReady?: boolean;
}

/** Stable identity, so a consumer's `useMemo` on the set doesn't rerun. */
const NO_MUTES: Set<string> = new Set();

/**
 * The current user's mute list, resolved once app-wide: nearly every row asks,
 * and a per-row query would hit the perf-tested hot paths. The default (outside
 * the provider) is "nobody muted", which shows everything.
 */
export const MutedPubkeysContext = createContext<MutedPubkeysResult>({
  mutedPubkeys: NO_MUTES,
  ready: true,
  wireReady: true,
  configReady: true,
});
