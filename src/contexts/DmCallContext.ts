import { createContext, useContext } from "react";

import type { DmCallSignal } from "@/lib/dmCall";

/**
 * The 1:1 call signaling surface (see `src/lib/dmCall.ts` and
 * `DmCallProvider`). The provider owns the offer/answer/decline/end rumor
 * traffic, the incoming-call ring UI, and the outgoing ring timeout; the
 * connected room itself lives in CallProvider/PersistentVoiceRoom.
 */
export interface DmCallState {
  /** The fresh incoming offer currently ringing, or null. */
  incoming: DmCallSignal | null;
  /**
   * Start a call to `peer`: mint the per-call secret, resolve a broker, send
   * the gift-wrapped offer, and join the room. Surfaces failures as toasts.
   */
  startCall: (peer: string) => Promise<void>;
  /** Accept the ringing offer (sends "answer" and joins the room). */
  acceptCall: () => void;
  /** Decline the ringing offer (sends "decline"). */
  declineCall: () => void;
  /** Whether this login can place calls at all (NIP-44-capable signer). */
  canCall: boolean;
}

const DISABLED: DmCallState = {
  incoming: null,
  startCall: async () => {},
  acceptCall: () => {},
  declineCall: () => {},
  canCall: false,
};

export const DmCallContext = createContext<DmCallState>(DISABLED);

/** Access DM call signaling. Inert outside DmCallProvider / logged-out. */
export function useDmCall(): DmCallState {
  return useContext(DmCallContext);
}
