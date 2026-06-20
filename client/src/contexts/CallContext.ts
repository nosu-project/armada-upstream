import { createContext } from "react";

import type { Channel, Community } from "@/lib/concord/types";

/**
 * A Concord (serverless, end-to-end-encrypted) voice room: the community +
 * channel whose key material derives the LiveKit room name, the self-signed
 * grant, and the E2EE media key, plus the blind broker (`voiceServer`) that
 * mints the token. Present only for Concord calls.
 */
export interface ConcordVoiceContext {
  community: Community;
  channel: Channel;
  /** The chosen blind LiveKit token broker (https origin). */
  voiceServer: string;
}

/** Identifies a single voice room (a NIP-29 group, a 1:1 DM room, or a Concord channel). */
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
  /**
   * For Concord calls, the serverless voice context. When set, the room uses
   * the blind-broker token path + E2EE media instead of the NIP-29 relay token.
   */
  concord?: ConcordVoiceContext;
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
  /**
   * Connect to a Concord channel's serverless voice room (replaces any current
   * call). Uses the blind-broker token path + end-to-end-encrypted media keyed
   * by the channel epoch.
   */
  joinConcordCall: (ctx: ConcordVoiceContext) => void;
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
