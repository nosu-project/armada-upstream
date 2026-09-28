import { createContext, useContext } from "react";

import type { VoiceReactionEntry } from "@/concord/lib/voice";
import type {
  DesktopHevcScreenShareCapability,
  DesktopHevcScreenShareStatus,
} from "@/lib/desktop";
import type { ScreenShareQuality } from "@/lib/screenShareQuality";

export interface HevcScreenShareController {
  capability: DesktopHevcScreenShareCapability | null;
  status: DesktopHevcScreenShareStatus;
  active: boolean;
  /** The trusted local capture used for the presenter's preview only. */
  previewTrack: MediaStreamTrack | null;
  /** The auxiliary LiveKit identity publishing the encoded HEVC track. */
  publisherIdentity: string | null;
  start: (stream: MediaStream, quality: ScreenShareQuality) => Promise<void>;
  stop: () => Promise<void>;
}

/**
 * In-call raise-hand + emoji reactions — an Armada extension riding additive tags
 * on the encrypted CORD-07 presence rumor (`voice.ts`), so Concord calls only.
 * Provided by `ConcordVoiceRoom`; portaled controls still read it via the React tree.
 */
export interface CallSignals {
  /** False in NIP-29/DM calls (and before connect): render no controls or badges. */
  enabled: boolean;
  myHandRaised: boolean;
  /** Toggle the local user's raised hand (publishes immediately). */
  toggleHand: () => void;
  /** Fire a transient emoji reaction from the local user. */
  sendReaction: (emoji: string) => void;
  /** Live transient reactions (keyed by `nonce`; filter by `author`). Age out after ~4s. */
  reactions: readonly VoiceReactionEntry[];
  /** Custom Linux H.265 publishing; null outside an encrypted Concord call. */
  hevcScreenShare: HevcScreenShareController | null;
}

const DISABLED: CallSignals = {
  enabled: false,
  myHandRaised: false,
  toggleHand: () => {},
  sendReaction: () => {},
  reactions: [],
  hevcScreenShare: null,
};

export const CallSignalsContext = createContext<CallSignals>(DISABLED);

/** Access raise-hand + reactions; a disabled no-op value outside a Concord call. */
export function useCallSignals(): CallSignals {
  return useContext(CallSignalsContext);
}
