import { createContext } from "react";

export interface MutedPubkeysResult {
  /** The set of pubkeys the user has muted. */
  mutedPubkeys: Set<string>;
  /**
   * Whether the mute set is settled enough to filter on. False only during the
   * very first cold load (no locally-cached list and the network query still in
   * flight). Once a previously-cached list is read, or the network query
   * resolves, this is true — so consumers can wait to render until muted
   * content is already excluded, instead of showing it then hiding it.
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
 * The current user's mute list, resolved once for the whole app.
 *
 * A context rather than a hook each consumer runs, because "is this person
 * muted" is asked by nearly every component that renders another person — every
 * message row, member row, reaction pill, typing avatar. Running the query
 * subscription and the local-cache effect per row would put a per-row cost on
 * the two hot paths this codebase has perf tests for (channel switch, roster
 * paint) to answer one question with one answer.
 *
 * The default is "nobody is muted, and we know it", which is the safe reading
 * for a component rendered outside the provider: it shows everything rather
 * than hiding content on the strength of a set that was never loaded.
 */
export const MutedPubkeysContext = createContext<MutedPubkeysResult>({
  mutedPubkeys: NO_MUTES,
  ready: true,
  wireReady: true,
  configReady: true,
});
