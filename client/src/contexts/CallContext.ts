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
  /**
   * Register a channel-sidebar DOM node into which the call bar should portal
   * (above the account pill). Multiple slots may be registered (e.g. the
   * desktop pane and the mobile drawer); the bar renders into all of them, and
   * each slot's host controls its own responsive visibility. Returns an
   * unregister function.
   */
  registerCallBarSlot: (el: HTMLElement) => () => void;
}

export const CallContext = createContext<CallContextType | undefined>(undefined);
