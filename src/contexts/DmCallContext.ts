import { createContext, useContext } from "react";

import type { DmCallSignal } from "@/lib/dmCall";

/**
 * 1:1 call signaling (`src/lib/dmCall.ts`, `DmCallProvider`): offer/answer/
 * decline/end, ring UI and timeout. The room itself lives in CallProvider.
 */
export interface DmCallState {
  /** The fresh incoming offer currently ringing, or null. */
  incoming: DmCallSignal | null;
  /** Start a call: mint the secret, resolve a broker, send the gift-wrapped offer, join. Failures toast. */
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
