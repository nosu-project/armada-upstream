import { createContext } from "react";

/** Identifies a single voice room (a NIP-29 group or a 1:1 DM room). */
export interface ActiveCall {
  relayUrl: string;
  /** The LiveKit room id: a NIP-29 group id, or a `dm:<a>:<b>` DM room id. */
  groupId: string;
  /**
   * For DM calls, the peer's hex pubkey. Set drives DM-specific labeling and
   * navigation (back to the conversation rather than a channel). Absent for
   * group calls.
   */
  dmPeer?: string;
}

export interface CallContextType {
  /** The room the user is currently connected to, or null. */
  activeCall: ActiveCall | null;
  /** Connect to a group's voice room (replaces any current call). */
  joinCall: (relayUrl: string, groupId: string) => void;
  /**
   * Connect to a 1:1 DM voice room with `peer` (replaces any current call).
   * `roomId` is the shared `dm:<a>:<b>` id; `relayUrl` is a LiveKit-capable
   * relay that hosts the room.
   */
  joinDmCall: (relayUrl: string, roomId: string, peer: string) => void;
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
  /**
   * Register the top-of-chat DOM node into which the call stage (the
   * dismissable box of participants + cameras/screenshares) should portal. Only
   * the chat surface that matches the active call should register, so the stage
   * appears at the top of the right conversation. Returns an unregister
   * function.
   */
  registerCallStageSlot: (el: HTMLElement) => () => void;
  /** Whether the call stage box is currently expanded. */
  stageOpen: boolean;
  /** Toggle the call stage open/closed (the corner call panel calls this). */
  toggleStage: () => void;
  /** Explicitly set the call stage open state (the stage's close button uses this). */
  setStageOpen: (open: boolean) => void;
}

export const CallContext = createContext<CallContextType | undefined>(undefined);
