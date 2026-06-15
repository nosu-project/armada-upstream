import { createContext } from "react";

/** Identifies a single NIP-29 voice room. */
export interface ActiveCall {
  relayUrl: string;
  groupId: string;
}

export interface CallContextType {
  /** The room the user is currently connected to, or null. */
  activeCall: ActiveCall | null;
  /** Connect to a group's voice room (replaces any current call). */
  joinCall: (relayUrl: string, groupId: string) => void;
  /** Disconnect from the current call. */
  leaveCall: () => void;
}

export const CallContext = createContext<CallContextType | undefined>(undefined);
