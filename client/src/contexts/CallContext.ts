import { createContext } from "react";

import type { ChannelV2, CommunityV2 } from "@/concord-v2/lib/types";

/**
 * A Concord (CORD-07, serverless, end-to-end-encrypted) voice room: the
 * community + voice channel whose key material derives the SFU room name, the
 * self-signed token grant, and the per-sender media keys, plus the blind
 * broker (`broker`, an https origin) the §5 rendezvous chose. Present only for
 * Concord calls.
 */
export interface ConcordVoiceContext {
  community: CommunityV2;
  channel: ChannelV2;
  broker: string;
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
   * the blind-broker token path + per-sender E2EE media instead of the NIP-29
   * relay token.
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
   * Connect to a Concord voice channel's serverless room (replaces any current
   * call). Uses the CORD-07 blind-broker token path + per-sender E2EE media
   * keyed by the channel epoch.
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
  /**
   * Pubkeys currently speaking in the ACTIVE call (resolved from LiveKit
   * identities; unverified Concord identities are excluded). Lets UI outside
   * the LiveKit room — e.g. the sidebar's nested voice roster — show live
   * voice activity. Empty when not in a call.
   */
  speakingPubkeys: ReadonlySet<string>;
  /** Internal: the connected room reports its live speaker set here. */
  setSpeakingPubkeys: (pubkeys: Set<string>) => void;
  /**
   * Pubkeys currently muted (microphone disabled) in the ACTIVE call (resolved
   * from LiveKit identities; unverified Concord identities are excluded). Lets
   * UI outside the LiveKit room — e.g. the sidebar's nested voice roster — show
   * who is muted. Empty when not in a call.
   */
  mutedPubkeys: ReadonlySet<string>;
  /** Internal: the connected room reports its live muted set here. */
  setMutedPubkeys: (pubkeys: Set<string>) => void;
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
  /** Internal: the connected room reports its live participant roster here. */
  setVoiceRoomPubkeys: (pubkeys: readonly string[] | null) => void;
}

export const CallContext = createContext<CallContextType | undefined>(undefined);
