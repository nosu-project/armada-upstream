import { createContext, useContext } from "react";

import type { VoiceReactionEntry } from "@/concord-v2/lib/voice";

/**
 * In-call "raise hand" + emoji reactions — an Armada client feature layered on
 * CORD-07 voice, available in CONCORD calls only (they ride additive tags on
 * the channel's encrypted presence rumor, so brokers/relays stay blind; see
 * `voice.ts`). NIP-29 / DM calls have no encrypted channel to carry them, so
 * this context stays disabled there and the send controls hide themselves.
 *
 * Provided by `ConcordVoiceRoom`, which wraps the shared `VoiceRoomShell`. The
 * in-call controls (VoiceBar / FloatingControls) and the call stage are
 * portaled children of that shell, so they read this context through the React
 * tree even though they render into detached DOM.
 */
export interface CallSignals {
  /**
   * Whether raise-hand + reactions are available in this call. False in NIP-29
   * / DM calls (and before connect), so consumers render no send controls and
   * no badges/floaters.
   */
  enabled: boolean;
  /** Whether the local user's hand is currently raised. */
  myHandRaised: boolean;
  /** Toggle the local user's raised hand (publishes immediately). */
  toggleHand: () => void;
  /** Fire a transient emoji reaction from the local user. */
  sendReaction: (emoji: string) => void;
  /**
   * The live transient reactions to float, each authored by a real pubkey
   * (`author`) and keyed by its `nonce`. Consumers filter by the tile's pubkey
   * so an emoji floats up from its sender. Ages out on its own (~4s).
   */
  reactions: readonly VoiceReactionEntry[];
}

const DISABLED: CallSignals = {
  enabled: false,
  myHandRaised: false,
  toggleHand: () => {},
  sendReaction: () => {},
  reactions: [],
};

export const CallSignalsContext = createContext<CallSignals>(DISABLED);

/**
 * Access the in-call raise-hand + reactions surface. Returns a disabled,
 * no-op value outside a Concord call (or outside any voice room), so callers
 * can render unconditionally and simply gate on `enabled`.
 */
export function useCallSignals(): CallSignals {
  return useContext(CallSignalsContext);
}
