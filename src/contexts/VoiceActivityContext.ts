import { createContext } from "react";

/**
 * The ACTIVE call's live activity — the four sets the connected LiveKit room
 * reports as they change, split out of {@link CallContextType} on purpose.
 *
 * These are the only per-frame values in the call state. `speakingPubkeys`
 * moves on every `ActiveSpeakersChanged`, which during an ordinary
 * conversation is several times a second; `mutedPubkeys` and
 * `voiceRoomPubkeys` move on every track/participant event. The other ~22
 * fields of `CallContext` (the active call, the join/leave actions, the
 * stage/slot registration) change at human speed or never.
 *
 * Merged into one context, a single speaker starting to talk invalidated all
 * of them for all 14 files that call `useCall()` — including the ones that
 * only wanted `activeCall` or `joinCall`, and including `PersistentVoiceRoom`,
 * which reads `useCall()` four times purely to obtain setters and so
 * re-rendered (and re-ran its effects) on every frame of its own reports.
 *
 * Only the VALUES live here. The setters stay on `CallContext`: they are
 * `useCallback([])` and reference-stable, so a component that only writes —
 * which is exactly `PersistentVoiceRoom` — subscribes to nothing that moves.
 */
export interface VoiceActivityContextType {
  /**
   * Pubkeys currently speaking in the ACTIVE call (resolved from LiveKit
   * identities; unverified Concord identities are excluded). Lets UI outside
   * the LiveKit room — e.g. the sidebar's nested voice roster — show live
   * voice activity. Empty when not in a call.
   */
  speakingPubkeys: ReadonlySet<string>;
  /**
   * Pubkeys currently muted (microphone disabled) in the ACTIVE call (resolved
   * from LiveKit identities; unverified Concord identities are excluded).
   * Empty when not in a call.
   */
  mutedPubkeys: ReadonlySet<string>;
  /**
   * Pubkeys with a raised hand in the ACTIVE call (an Armada client feature,
   * Concord calls only — see CallSignalsContext). Empty when not in a Concord
   * call.
   */
  raisedHands: ReadonlySet<string>;
  /**
   * The ACTIVE call's live roster: every participant currently in the
   * connected LiveKit room (local + remote), resolved to pubkeys (deduped
   * across multiple sessions; unverified Concord identities excluded). Null
   * while not connected to a call (or before the first report).
   *
   * While connected, this is the AUTHORITATIVE occupancy for the active room —
   * prefer it over relay presence events (kind 39004) or presence heartbeats,
   * which lag and desync (missed webhooks, dropped subscriptions, relay
   * restarts). The SFU's own participant list can't drift: it IS the call.
   */
  voiceRoomPubkeys: readonly string[] | null;
}

export const VoiceActivityContext = createContext<VoiceActivityContextType | undefined>(
  undefined,
);
