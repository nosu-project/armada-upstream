import { createContext } from "react";

/**
 * The ACTIVE call's live activity sets, split out of {@link CallContextType}
 * because they change several times a second; merged, every `useCall()` consumer
 * re-rendered per frame. Setters stay on `CallContext` (reference-stable).
 */
export interface VoiceActivityContextType {
  /** Pubkeys speaking in the ACTIVE call (unverified Concord identities excluded). Empty when not in a call. */
  speakingPubkeys: ReadonlySet<string>;
  /** Pubkeys muted in the ACTIVE call (unverified Concord identities excluded). */
  mutedPubkeys: ReadonlySet<string>;
  /** Pubkeys screen sharing in the ACTIVE call, watched or not. */
  streamingPubkeys: ReadonlySet<string>;
  /** Streamers this client has opted into watching (see ScreenShareWatchContext). */
  watchedStreams: ReadonlySet<string>;
  /** Pubkeys with a raised hand (Concord calls only; see CallSignalsContext). */
  raisedHands: ReadonlySet<string>;
  /**
   * The ACTIVE call's live roster (local + remote, deduped pubkeys, unverified
   * excluded); null when not connected. AUTHORITATIVE while connected — prefer it
   * over presence events, which lag.
   */
  voiceRoomPubkeys: readonly string[] | null;
}

export const VoiceActivityContext = createContext<VoiceActivityContextType | undefined>(
  undefined,
);
