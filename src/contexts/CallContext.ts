import { createContext } from "react";

import type { Channel, Community } from "@/concord/lib/types";

/**
 * A Concord (CORD-07, serverless, end-to-end-encrypted) voice room: the
 * community + voice channel whose key material derives the SFU room name, the
 * self-signed token grant, and the per-sender media keys, plus the blind
 * broker (`broker`, an https origin) the §5 rendezvous chose. Present only for
 * Concord calls.
 */
export interface ConcordVoiceContext {
  community: Community;
  channel: Channel;
  broker: string;
}

/**
 * A 1:1 DM voice room (see `src/lib/dmCall.ts`): the peer, the per-call
 * secret both sides derive the room + media keys from, the call id (the SFU
 * room name that secret derives), and the blind broker origin hosting the
 * call. Present only for DM calls; the room uses the same blind-broker token
 * path as Concord, with shared-key E2EE media.
 */
export interface DmVoiceContext {
  peer: string;
  callId: string;
  secretHex: string;
  broker: string;
}

/** Identifies a single voice room (a NIP-29 group, a 1:1 DM call, or a Concord channel). */
export interface ActiveCall {
  relayUrl: string;
  /** The LiveKit room id: a NIP-29 group id, or a DM call id (room pubkey). */
  groupId: string;
  /**
   * For DM calls, the peer's hex pubkey (mirror of `dm.peer`). Kept as its own
   * field so DM surfaces can test "am I in a call with this peer" without
   * reaching into the full context. Absent for group calls.
   */
  dmPeer?: string;
  /** For DM calls, the blind-broker voice context. */
  dm?: DmVoiceContext;
  /**
   * For Concord calls, the serverless voice context. When set, the room uses
   * the blind-broker token path + per-sender E2EE media instead of the NIP-29
   * relay token.
   */
  concord?: ConcordVoiceContext;
}

/**
 * How the active call reads outside the app — currently the Android ongoing-call
 * notification (see `useCallForegroundService`). Registered by the connected
 * voice room, which is the only place that knows what the room is CALLED: the
 * NIP-29 group's kind-39000 metadata, the DM peer's kind-0, or the Concord
 * channel's decrypted name. Plain strings, since the destination is an OS
 * notification rather than React.
 */
export interface CallSummary {
  /** The room as the user knows it: "#general", or a DM peer's display name. */
  title: string;
  /** Where that room lives: a server or community name. Absent for DMs. */
  subtitle?: string;
}

export interface CallContextType {
  /** The room the user is currently connected to, or null. */
  activeCall: ActiveCall | null;
  /** Connect to a group's voice room (replaces any current call). */
  joinCall: (relayUrl: string, groupId: string) => void;
  /**
   * Connect to a 1:1 DM voice room (replaces any current call). Uses the
   * blind-broker token path + shared-key E2EE media derived from the per-call
   * secret. Callers reach here from DmCallProvider, which owns the call
   * signaling (offer/answer/decline/end) around the room itself.
   */
  joinDmCall: (ctx: DmVoiceContext) => void;
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
  /**
   * Show/hide whichever stage the current route has (the corner call panel calls
   * this): the docked box on the call's channel, the floating window away from
   * it. Deliberately leaves `stageOpen` alone on the floating path — dismissing
   * or restoring the floating window must not rewrite how the docked stage will
   * appear when the user returns to the call's channel.
   */
  toggleStage: () => void;
  /** Explicitly set the call stage open state (the stage's close button uses this). */
  setStageOpen: (open: boolean) => void;
  /**
   * Whether a call stage is actually on screen right now, whichever destination
   * it is docked into. `stageOpen` alone can't answer this: it drives only the
   * DOCKED box, and the stage's floating branch ignores it entirely — so off the
   * call's channel `stageOpen` is a deferred preference (how the docked box will
   * look on return), not a description of anything visible.
   */
  stageVisible: boolean;
  /**
   * Whether the call stage is currently docked inside the compact floating
   * window (desktop-only). True only when no normal call-stage slot is
   * registered (the user has navigated away from the call's channel), the user
   * hasn't hidden the floating window, and the viewport is desktop-width. The
   * same persistent stage host is reparented into the floating window, so there
   * is never a second stage or duplicate media subscription.
   */
  stageFloating: boolean;
  /**
   * Which floating destination the stage is currently docked into, so the
   * stage's floating branch can adapt its chrome: the draggable desktop window
   * (`"desktop"`) renders the full media control row; the compact mobile
   * preview (`"mobile"`) omits it, because the fixed MobileCallBar already
   * carries mic/camera/screen-share/leave. Null when not floating. Only one
   * variant ever registers at a time (each floating host gates itself on the
   * `sidebar` breakpoint), so the two destinations never compete.
   */
  floatingVariant: "desktop" | "mobile" | null;
  /**
   * The fixed mobile call bar's measured height in pixels (including its bottom
   * safe-area padding), reported by MobileCallBar. The mobile preview positions
   * itself directly above the bar off THIS value rather than the `--call-bar-h`
   * CSS variable, so its placement is guaranteed regardless of DOM nesting or
   * CSS-inheritance timing, and re-evaluates reactively whenever the bar's
   * height changes (keyboard, participant count, safe-area/orientation). 0 when
   * the bar isn't mounted (desktop, or no active call).
   */
  callBarHeight: number;
  /** Internal: MobileCallBar reports its measured height (incl. safe area) here. */
  setCallBarHeight: (px: number) => void;
  /**
   * Whether the user has dismissed the floating video window without leaving
   * the call. While hidden, the stage parks off-DOM (video subscriptions stay
   * alive) and only the call bar remains visible. Reset whenever the stage
   * returns to a normal slot or a new call starts.
   */
  floatingHidden: boolean;
  /** Hide the floating video window (the floating window's close button). */
  setFloatingHidden: (hidden: boolean) => void;
  /**
   * Navigate to the active call's channel/conversation, registered by the
   * connected voice room (which owns the correct route for NIP-29 groups, DMs,
   * and Concord channels). The floating window's "expand" action calls this to
   * return the user to the full call view. Null before the room registers it.
   */
  focusActiveCall: (() => void) | null;
  /** Internal: the connected room registers its navigate-to-call handler here. */
  registerFocusActiveCall: (fn: (() => void) | null) => void;
  /**
   * Internal: the connected room registers how the call should be labelled
   * outside the app (the Android ongoing-call notification). Null while no room
   * has resolved its name yet, which the notification renders generically.
   */
  registerCallSummary: (summary: CallSummary | null) => void;
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
   * Pubkeys with a raised hand in the ACTIVE call (an Armada client feature,
   * Concord calls only — see CallSignalsContext). Surfaced here too, alongside
   * muted/speaking, so UI outside the LiveKit room — the sidebar's nested voice
   * roster — can show who has their hand up. Empty when not in a Concord call.
   */
  raisedHands: ReadonlySet<string>;
  /** Internal: the connected Concord room reports its raised-hand set here. */
  setRaisedHands: (pubkeys: Set<string>) => void;
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
