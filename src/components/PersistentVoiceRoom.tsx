import {
  LiveKitRoom,
  RoomAudioRenderer,
  useLocalParticipant,
  useParticipants,
  useRoomContext,
  useSpeakingParticipants,
} from "@livekit/components-react";
import {
  AudioPresets,
  BaseKeyProvider,
  ConnectionState,
  DisconnectReason,
  LocalAudioTrack,
  ParticipantEvent,
  Room,
  RoomEvent,
  Track,
  VideoPresets,
  type RemoteParticipant,
  type LocalTrack,
  type RoomOptions,
} from "livekit-client";
import { Capacitor } from "@capacitor/core";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";

import "@livekit/components-styles";

import { InCallView } from "@/components/chat/VoiceBar";
import { CallStage } from "@/components/chat/CallStage";
import { DisplayName } from "@/components/DisplayName";
import { DesktopPushToTalk } from "@/components/DesktopPushToTalk";
import { Button } from "@/components/ui/button";
import { useAuthor } from "@/hooks/useAuthor";
import { useCall } from "@/hooks/useCall";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useGroup } from "@/hooks/useGroup";
import { useLivekitToken } from "@/hooks/useLivekit";
import { useRelayInfo } from "@/hooks/useRelayInfo";
import { type ActiveCall, type ConcordVoiceContext, type DmVoiceContext } from "@/contexts/CallContext";
import { useVoiceIdentity, VoiceIdentityContext, type VoiceIdentityResolver } from "@/contexts/VoiceIdentityContext";
import { ServerScopeProvider } from "@/components/ServerScopeProvider";
import { random32, voiceSenderKey } from "@/concord/lib/derive";
import {
  canonicalOrigin,
  fetchAvToken,
  fetchAvTokenFromAny,
  isVerifiedScreenShareIdentity,
  occupantsElsewhere,
  rendezvousCandidates,
  verifiedAuthorOf,
  type AvToken,
} from "@/concord/lib/voice";
import { toast } from "@/hooks/useToast";
import { ToastAction } from "@/components/ui/toast";
import { dmCallKeys } from "@/lib/dmCall";
import { useCallSync } from "@/concord/hooks/useCallSync";
import {
  ownAvServers,
  useCommunityAvBrokers,
  useAvToken,
  useVoiceHeartbeat,
  useVoicePresence,
  useVoiceReactions,
} from "@/concord/hooks/useVoice";
import { CallSignalsContext, type CallSignals } from "@/contexts/CallSignalsContext";
import { getDisplayName } from "@/lib/getDisplayName";
import { relayToRouteParam } from "@/lib/platform";
import { playJoinSound, playLeaveSound } from "@/lib/callSounds";
import {
  getAudioProcessing,
  getPreferredCameraId,
  getPreferredMicId,
  getScreenShareVolume,
  getUserVolume,
  subscribeUserVolumes,
} from "@/lib/voiceDevices";
import { syncRnnoise } from "@/lib/voiceProcessor";
import { cn } from "@/lib/utils";
import { bytesToBase64 } from "@/lib/fileBytes";
import {
  HevcScreenShareSessionTracker,
  isHevcScreenShareParticipant,
  stopHevcCapturedMedia,
} from "@/lib/hevcScreenShare";
import {
  cancelDesktopHevcScreenShareFrames,
  desktopHevcScreenShareCapability,
  startDesktopHevcScreenShare,
  stopDesktopHevcScreenShare,
  subscribeDesktopHevcScreenShareStatus,
  type DesktopHevcScreenShareCapability,
  type DesktopHevcScreenShareStatus,
} from "@/lib/desktop";
import { SCREEN_SHARE_RESOLUTIONS, type ScreenShareQuality } from "@/lib/screenShareQuality";
import { nip19 } from "nostr-tools";

/**
 * The LiveKit half of the voice-call stack, split out of CallProvider and
 * loaded LAZILY on the first call join. The LiveKit SDK (~0.5MB of JS) was the
 * single largest contributor to the boot bundle; nothing here is needed until
 * the user actually joins voice, so it must never cost the cold start a byte.
 * CallProvider (the state/context shell) stays eager and mounts this module
 * behind `React.lazy` only while a call is active.
 */

/**
 * Reports the room's live speaker set (resolved to pubkeys) up to the call
 * context, so UI outside the LiveKit room — the sidebar's nested voice
 * roster — can show voice activity. Must render inside `LiveKitRoom` (and, for
 * Concord, inside the identity-resolver provider). Unverified identities are
 * skipped: their media never renders, so they can't meaningfully "speak".
 */
function SpeakingReporter() {
  const { setSpeakingPubkeys } = useCall();
  const resolveIdentity = useVoiceIdentity();
  const speakingParticipants = useSpeakingParticipants();

  useEffect(() => {
    const pubkeys = new Set<string>();
    for (const p of speakingParticipants) {
      if (isHevcScreenShareParticipant(p, resolveIdentity)) continue;
      const { pubkey, verified } = resolveIdentity(p.identity);
      if (verified) pubkeys.add(pubkey);
    }
    setSpeakingPubkeys(pubkeys);
  }, [speakingParticipants, resolveIdentity, setSpeakingPubkeys]);

  // Clear on room teardown (room switch or leave) so no stale rings linger.
  useEffect(() => () => setSpeakingPubkeys(new Set()), [setSpeakingPubkeys]);

  return null;
}

/**
 * Reports the room's muted participants (mic disabled, resolved to pubkeys) up
 * to the call context, so the sidebar's nested voice roster can show who has
 * their mic off — only while the viewer is connected to that call (mute state
 * is only available from the LiveKit room we're in). `useParticipants`
 * re-renders on the room's `TrackMuted`/`TrackUnmuted` events, so this effect
 * re-runs as mute state changes. Must render inside `LiveKitRoom` (and, for
 * Concord, inside the identity-resolver provider). Unverified identities are
 * skipped, matching the roster/speaking reporters.
 */
function MutedReporter() {
  const { setMutedPubkeys } = useCall();
  const resolveIdentity = useVoiceIdentity();
  const participants = useParticipants();

  useEffect(() => {
    const pubkeys = new Set<string>();
    for (const p of participants) {
      if (
        !p.identity ||
        p.isMicrophoneEnabled ||
        isHevcScreenShareParticipant(p, resolveIdentity)
      ) continue;
      const { pubkey, verified } = resolveIdentity(p.identity);
      if (verified) pubkeys.add(pubkey);
    }
    setMutedPubkeys(pubkeys);
  }, [participants, resolveIdentity, setMutedPubkeys]);

  // Clear on room teardown (room switch or leave) so no stale icons linger.
  useEffect(() => () => setMutedPubkeys(new Set()), [setMutedPubkeys]);

  return null;
}

/**
 * Reports the room's live participant roster (resolved to pubkeys) up to the
 * call context, so the active call's occupancy renders from LiveKit truth
 * everywhere — sidebar rosters, DM headers — instead of relay presence events
 * (kind 39004), which ride webhooks + a relay's in-memory map and desync far
 * too easily (missed webhooks, dropped subscriptions, relay restarts). The
 * SFU's participant list can't drift while we're connected: it IS the call.
 * Must render inside `LiveKitRoom` (and, for Concord, inside the
 * identity-resolver provider). Multiple sessions of one pubkey are deduped;
 * unverified Concord identities are skipped, matching the call stage.
 */
function RosterReporter() {
  const { setVoiceRoomPubkeys } = useCall();
  const resolveIdentity = useVoiceIdentity();
  const participants = useParticipants();

  useEffect(() => {
    const pubkeys: string[] = [];
    const seen = new Set<string>();
    for (const p of participants) {
      // The local participant exists before the connection completes, with an
      // empty identity — skip until it's real.
      if (!p.identity || isHevcScreenShareParticipant(p, resolveIdentity)) continue;
      const { pubkey, verified } = resolveIdentity(p.identity);
      if (!verified || seen.has(pubkey)) continue;
      seen.add(pubkey);
      pubkeys.push(pubkey);
    }
    setVoiceRoomPubkeys(pubkeys);
  }, [participants, resolveIdentity, setVoiceRoomPubkeys]);

  // Clear on room teardown (room switch or leave) so consumers fall back to
  // relay presence instead of showing a stale roster.
  useEffect(() => () => setVoiceRoomPubkeys(null), [setVoiceRoomPubkeys]);

  return null;
}

/**
 * Keeps every remote participant's microphone and screen-share playback gains
 * in sync with their independent persisted stores for the whole call. The
 * stage also re-applies on (re)subscribe, but this remains mounted while the
 * stage is closed so changes from the audio menu or sidebar take effect live.
 * Must render inside `LiveKitRoom` (and, for Concord, inside the identity
 * resolver provider).
 */
function PlaybackVolumeApplier() {
  const resolveIdentity = useVoiceIdentity();
  const participants = useParticipants();

  useEffect(() => {
    const apply = () => {
      for (const p of participants) {
        if (
          p.isLocal ||
          !p.identity ||
          isHevcScreenShareParticipant(p, resolveIdentity)
        ) continue;
        const { pubkey } = resolveIdentity(p.identity);
        const remote = p as RemoteParticipant;
        remote.setVolume(getUserVolume(pubkey), Track.Source.Microphone);
        remote.setVolume(getScreenShareVolume(pubkey), Track.Source.ScreenShareAudio);
      }
    };
    apply();
    // Re-apply whenever any stored volume changes (from any surface).
    return subscribeUserVolumes(apply);
  }, [participants, resolveIdentity]);

  return null;
}

/**
 * Plays a short chirp when you join the call, when another participant joins,
 * and when someone leaves. Must render inside a `LiveKitRoom`.
 */
function CallSoundEffects() {
  const room = useRoomContext();
  const resolveIdentity = useVoiceIdentity();
  const resolveRef = useRef(resolveIdentity);
  resolveRef.current = resolveIdentity;

  useEffect(() => {
    const timers = new Set<number>();
    const participantKey = (identity: string): string | null => {
      if (!identity) return null;
      const resolved = resolveRef.current(identity);
      return resolved.verified ? `pubkey:${resolved.pubkey}` : `identity:${identity}`;
    };
    const hasSibling = (participant: RemoteParticipant): boolean => {
      const key = participantKey(participant.identity);
      if (!key) return false;
      return [room.localParticipant, ...room.remoteParticipants.values()].some(
        (candidate) =>
          candidate !== participant && participantKey(candidate.identity) === key,
      );
    };
    const schedule = (participant: RemoteParticipant, kind: "join" | "leave") => {
      const timer = window.setTimeout(() => {
        timers.delete(timer);
        if (isHevcScreenShareParticipant(participant, resolveRef.current)) return;
        if (kind === "join" && room.remoteParticipants.get(participant.identity) !== participant) return;
        if (hasSibling(participant)) return;
        if (kind === "join") playJoinSound();
        else playLeaveSound();
      }, 750);
      timers.add(timer);
    };
    const onJoin = (participant: RemoteParticipant) => schedule(participant, "join");
    const onLeave = (participant: RemoteParticipant) => schedule(participant, "leave");
    const onConnected = () => playJoinSound();
    // Your own join: RoomEvent.Connected fires once the local participant has
    // joined. If the room is already connected by the time this mounts (e.g. a
    // fast reconnect), play it immediately so you always get audible feedback.
    if (room.state === ConnectionState.Connected) {
      playJoinSound();
    } else {
      room.on(RoomEvent.Connected, onConnected);
    }
    // Other participants joining/leaving after you're in.
    room.on(RoomEvent.ParticipantConnected, onJoin);
    room.on(RoomEvent.ParticipantDisconnected, onLeave);
    return () => {
      room.off(RoomEvent.Connected, onConnected);
      room.off(RoomEvent.ParticipantConnected, onJoin);
      room.off(RoomEvent.ParticipantDisconnected, onLeave);
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [room]);

  return null;
}

/**
 * Applies the user's RNNoise noise-cancellation preference to the published mic
 * track. Mounted inside the `LiveKitRoom`. The processor must be attached to the
 * `LocalAudioTrack` after it's published — `audioCaptureDefaults` only carries
 * browser constraints, not track processors — and re-attached whenever the mic
 * track is (re)published (initial join, unmute, device switch via restartTrack).
 */
function MicNoiseProcessor() {
  const { localParticipant } = useLocalParticipant();

  useEffect(() => {
    const apply = () => {
      const enabled = getAudioProcessing().rnnoise;
      const pub = localParticipant.getTrackPublication(Track.Source.Microphone);
      const track = pub?.audioTrack;
      if (track instanceof LocalAudioTrack) void syncRnnoise(track, enabled);
    };
    // Apply now (mic may already be published) and on every (re)publish.
    apply();
    localParticipant.on(ParticipantEvent.LocalTrackPublished, apply);
    return () => {
      localParticipant.off(ParticipantEvent.LocalTrackPublished, apply);
    };
  }, [localParticipant]);

  return null;
}

/**
 * Audio encoding defaults. LiveKit already defaults to
 * the `music` preset (48 kbps) with RED + DTX for mono; we bump to
 * `musicHighQuality` (96 kbps) for noticeably crisper voice and assert RED
 * (redundant audio, resilient to packet loss) + DTX (don't transmit silence)
 * explicitly so intent survives any future default change. Kept mono — stereo
 * doubles bandwidth for no benefit on voice.
 */
const audioPublishDefaults = {
  audioPreset: AudioPresets.musicHighQuality,
  red: true,
  dtx: true,
} as const;

/**
 * On the native APK, backgrounding the WebView (opening the system share sheet
 * for a link, or handing off to an external browser) fires the page-lifecycle
 * `freeze`/`pagehide` events on the document. LiveKit's `disconnectOnPageLeave`
 * default (true) treats those as the tab unloading and tears the room down —
 * which on Android kicks you out of an active call the moment you tap a link.
 * A Capacitor app's backgrounding is transient, not a page unload, and the call
 * is meant to persist across it (the room stays mounted in CallProvider), so we
 * disable that teardown on native. On the web (a real browser tab) it stays on,
 * so navigating away / closing the tab still cleanly leaves the call.
 */
const disconnectOnPageLeave = !Capacitor.isNativePlatform();

/**
 * Shared capture/encoding room options (mic device + audio processing + video
 * presets). Read per mount; rooms remount on room switch.
 */
function useRoomOptions(extra?: Partial<RoomOptions>): RoomOptions {
  return useMemo<RoomOptions>(() => {
    const micId = getPreferredMicId();
    const cameraId = getPreferredCameraId();
    const processing = getAudioProcessing();
    return {
      adaptiveStream: true,
      dynacast: true,
      disconnectOnPageLeave,
      audioCaptureDefaults: {
        ...(micId ? { deviceId: micId } : {}),
        noiseSuppression: processing.noiseSuppression,
        echoCancellation: processing.echoCancellation,
        autoGainControl: processing.autoGainControl,
        // Capture mono: a stereo interface that only populates one channel
        // otherwise publishes a track that plays back from a single side for
        // every listener, and a mono reference is cleaner for echo cancellation.
        channelCount: 1,
      },
      videoCaptureDefaults: {
        ...(cameraId ? { deviceId: cameraId } : {}),
        resolution: VideoPresets.h720.resolution,
      },
      publishDefaults: {
        ...audioPublishDefaults,
        videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360, VideoPresets.h720],
      },
      ...extra,
      // Route remote tracks through Web Audio GainNodes. Unlike media-element
      // volume, this supports real gain above 100% and source-specific mic and
      // screen-share controls. Keep this after `extra` so callers cannot
      // accidentally disable the required gain path.
      webAudioMix: true,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/** Loading bar shown while a token is being requested. */
function LoadingBar({ placeBar, label }: { placeBar: PlaceBar; label: string }) {
  return placeBar(
    <div className="flex items-center justify-center gap-2 px-3 py-2 clip-corner-lg bg-chrome-deep min-h-12 shadow-lg">
      <Loader2 className="size-4 animate-spin text-muted-foreground" />
      <span className="text-sm text-muted-foreground">{label}</span>
    </div>,
  );
}

/** Error bar shown when a token request fails. */
function ErrorBar({ placeBar, error, onLeave }: { placeBar: PlaceBar; error: unknown; onLeave: () => void }) {
  return placeBar(
    <div className="flex items-center gap-2 px-3 py-2 clip-corner-lg bg-chrome-deep min-h-12 shadow-lg">
      <span className="text-sm text-destructive flex-1 min-w-0 truncate">
        Could not join voice{error instanceof Error ? `: ${error.message}` : "."}
      </span>
      <Button className="h-8 px-3 text-sm shrink-0" variant="outline" onClick={onLeave}>
        Back
      </Button>
    </div>,
  );
}

type PlaceBar = (mobile: React.ReactNode, desktop?: React.ReactNode) => React.ReactNode;

/**
 * The fixed mobile call bar. Measures its own rendered height and writes it to
 * `--call-bar-h` on the shell, so the shell reserves *exactly* the bar's height
 * as bottom padding (the bar grows/shrinks with participant count). A fixed
 * estimate was wrong both ways — too short (covered the DM composer) and too
 * tall (left a big gap below the group composer).
 */
function MobileCallBar({
  shellRef,
  exiting,
  children,
}: {
  shellRef: React.RefObject<HTMLDivElement | null>;
  exiting: boolean;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { setCallBarHeight } = useCall();

  useEffect(() => {
    const bar = ref.current;
    const shell = shellRef.current;
    if (!bar || !shell) return;
    const apply = () => {
      const h = bar.offsetHeight;
      shell.style.setProperty("--call-bar-h", `${h}px`);
      // Also publish to call context: the mobile preview positions above the
      // bar off this shared value (a guaranteed source, unlike CSS-variable
      // inheritance), and re-evaluates whenever the bar resizes.
      setCallBarHeight(h);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(bar);
    return () => {
      ro.disconnect();
      // Release the reservation when the bar unmounts.
      shell.style.removeProperty("--call-bar-h");
      setCallBarHeight(0);
    };
  }, [shellRef, setCallBarHeight]);

  return (
    <div
      ref={ref}
      className={cn(
        "fixed bottom-0 inset-x-0 z-40 px-2 pb-safe sidebar:hidden",
        exiting
          ? "animate-out fade-out-0 slide-out-to-bottom-4 duration-200 fill-mode-forwards"
          : "animate-in fade-in-0 slide-in-from-bottom-4 duration-300",
      )}
    >
      {children}
    </div>
  );
}

/** Build the place-bar renderer (fixed mobile bar + portaled desktop slots). */
function makePlaceBar(
  slots: HTMLElement[],
  exiting: boolean,
  shellRef: React.RefObject<HTMLDivElement | null>,
): PlaceBar {
  return (mobile, desktop) => (
    <>
      <MobileCallBar shellRef={shellRef} exiting={exiting}>
        {mobile}
      </MobileCallBar>
      {slots.length === 0 && (
        // Desktop fallback: the current route registered no call-bar slot
        // (home, settings, or a route transition's slot gap), so float the
        // panel bottom-left — the call must keep visible presence + controls
        // everywhere, not just on pages with a channel sidebar. The entry
        // delay (with fill-mode-backwards holding it invisible) swallows the
        // one-frame gap while switching between two slot-owning pages.
        <div
          className={cn(
            "fixed bottom-3 left-3 z-40 w-80 max-w-[calc(100vw-1.5rem)] max-sidebar:hidden",
            exiting
              ? "animate-out fade-out-0 slide-out-to-bottom-2 duration-200 fill-mode-forwards"
              : "animate-in fade-in-0 slide-in-from-bottom-2 duration-200 delay-150 fill-mode-backwards",
          )}
        >
          {desktop ?? mobile}
        </div>
      )}
      {slots.map((el, i) =>
        createPortal(
          <div
            className={cn(
              // Hidden below the sidebar breakpoint: on mobile the fixed
              // MobileCallBar is the voice UI; showing this copy too (e.g. in
              // the channel-list drawer) would duplicate it.
              "px-1 pb-1 max-sidebar:hidden",
              exiting
                ? "animate-out fade-out-0 slide-out-to-bottom-2 duration-200 fill-mode-forwards"
                : "animate-in fade-in-0 slide-in-from-bottom-2 duration-300",
            )}
          >
            {desktop ?? mobile}
          </div>,
          el,
          `call-slot-${i}`,
        ),
      )}
    </>
  );
}

type PlaceStage = (stage: React.ReactNode) => React.ReactNode;

/**
 * Build the place-stage renderer: portal the call stage into the stable host
 * element owned by CallProvider. The host is reparented into whichever
 * top-of-chat slot is registered (or parked detached when none is), so the
 * stage stays MOUNTED for the whole call — unmounting it on navigation used to
 * pause every remote video via adaptiveStream and lose screenshares outright
 * on the E2EE Concord path, along with the focus/theater state.
 */
function makePlaceStage(host: HTMLElement): PlaceStage {
  return (stage) => createPortal(stage, host, "call-stage");
}

/**
 * The connected LiveKit room + its UI bars. Given a token, server url, room
 * options, and labels, renders the room context and the mobile/desktop bars.
 * Shared by the NIP-29 and Concord voice paths; only the token source, E2EE,
 * and labeling differ (computed by the wrappers).
 */
function VoiceRoomShell({
  serverUrl,
  token,
  options,
  room,
  onDisconnected,
  placeBar,
  placeStage,
  stageOpen,
  label,
  scopeRelayUrl,
}: {
  serverUrl: string;
  token: string;
  options: RoomOptions;
  /** Pre-constructed Room (used for the E2EE-enabled Concord path). */
  room?: Room;
  onDisconnected: (reason?: DisconnectReason) => void;
  placeBar: PlaceBar;
  placeStage: PlaceStage;
  stageOpen: boolean;
  label: React.ReactNode;
  /** Server scope for display names (NIP-29 relay url; undefined for DM/Concord). */
  scopeRelayUrl?: string;
}) {
  const mobileBar = (
    <ServerScopeProvider relayUrl={scopeRelayUrl}>
      <div className="clip-corner-lg bg-chrome-deep shadow-lg">
        <InCallView label={label} compact />
      </div>
    </ServerScopeProvider>
  );
  const desktopBar = (
    <ServerScopeProvider relayUrl={scopeRelayUrl}>
      <div className="clip-corner-lg bg-chrome-deep shadow-lg">
        <InCallView label={label} stacked />
      </div>
    </ServerScopeProvider>
  );

  return (
    <LiveKitRoom
      serverUrl={serverUrl}
      token={token}
      room={room}
      connect
      // Join muted by default: don't auto-publish the mic track on connect.
      // Users opt in via the mic button (setMicrophoneEnabled), which also
      // covers the permission prompt explicitly instead of surprising anyone
      // with live audio the instant they land in a call.
      audio={false}
      video={false}
      options={options}
      onDisconnected={onDisconnected}
      // `display: contents` so the room container generates no box of its own.
      style={{ display: "contents" }}
    >
      <RoomAudioRenderer />
      <CallSoundEffects />
      <MicNoiseProcessor />
      <DesktopPushToTalk />
      <SpeakingReporter />
      <MutedReporter />
      <RosterReporter />
      <PlaybackVolumeApplier />
      {placeStage(
        <ServerScopeProvider relayUrl={scopeRelayUrl}>
          <CallStage callLabel={label} open={stageOpen} />
        </ServerScopeProvider>,
      )}
      {placeBar(mobileBar, desktopBar)}
    </LiveKitRoom>
  );
}

/**
 * NIP-29 group voice room: token from the relay's NIP-29 LiveKit endpoint,
 * authorized by group membership. No media E2EE — the relay-trusted SFU is
 * part of the trust model here. (DM calls used to share this path via the
 * relay's `livekit-dm` endpoint; they now ride the blind-broker DmVoiceRoom
 * below.)
 */
function Nip29VoiceRoom({
  call,
  onLeave,
  placeBar,
  placeStage,
  stageOpen,
}: {
  call: ActiveCall;
  onLeave: () => void;
  placeBar: PlaceBar;
  placeStage: PlaceStage;
  stageOpen: boolean;
}) {
  const navigate = useNavigate();
  const { data: tokenData, error, isLoading } = useLivekitToken(call.relayUrl, call.groupId, true);
  const { data: details } = useGroup(call.relayUrl, call.groupId);
  const { data: relayInfo } = useRelayInfo(call.relayUrl);
  const channelName = details?.group?.name ?? "voice";
  const serverName = relayInfo?.name ?? call.relayUrl.replace(/^wss?:\/\//, "");
  const options = useRoomOptions();

  const handleDisconnected = useCallback(
    (reason?: DisconnectReason) => {
      if (reason !== undefined && reason !== DisconnectReason.CLIENT_INITIATED) {
        console.warn("voice disconnected", { reason: DisconnectReason[reason] ?? reason });
      }
      onLeave();
    },
    [onLeave],
  );

  const goToChannel = useCallback(() => {
    navigate(`/s/${relayToRouteParam(call.relayUrl)}/${encodeURIComponent(call.groupId)}`);
  }, [navigate, call.relayUrl, call.groupId]);

  // Register the navigate-to-call handler so the floating video window's
  // "return to call" action lands on this room's channel.
  const { registerFocusActiveCall, registerCallSummary } = useCall();
  useEffect(() => {
    registerFocusActiveCall(goToChannel);
    return () => registerFocusActiveCall(null);
  }, [registerFocusActiveCall, goToChannel]);

  // How the call reads in the Android ongoing-call notification. Plain text,
  // so unlike the bar's `label` it can carry no custom-emoji images — and it
  // re-registers as the group metadata resolves.
  useEffect(() => {
    registerCallSummary({ title: `#${channelName}`, subtitle: serverName });
    return () => registerCallSummary(null);
  }, [registerCallSummary, channelName, serverName]);

  if (isLoading) return <>{<LoadingBar placeBar={placeBar} label="Requesting voice access…" />}</>;
  if (error || !tokenData) return <>{<ErrorBar placeBar={placeBar} error={error} onLeave={onLeave} />}</>;

  const label = (
    <button type="button" onClick={goToChannel} className="hover:underline text-left">
      {/* The server name is desktop-only; on the compact mobile bar we show just
          the channel (e.g. "#general"). */}
      <span className="hidden sidebar:inline text-muted-foreground/70">{serverName} </span>#{channelName}
    </button>
  );

  return (
    <VoiceRoomShell
      serverUrl={tokenData.url}
      token={tokenData.token}
      options={options}
      onDisconnected={handleDisconnected}
      placeBar={placeBar}
      placeStage={placeStage}
      stageOpen={stageOpen}
      label={label}
      scopeRelayUrl={call.relayUrl}
    />
  );
}

/**
 * A per-sender key provider for Concord AV (CORD-07 §3): every publisher
 * encrypts under its own key, derived from the channel's media root and the
 * publisher's broker-assigned identity — so members never share one AEAD
 * nonce domain. Configured to CORD-07's profile:
 *
 *   - `sharedKey: false`   — keys are per participant identity;
 *   - `keySize: 256`       — AES-256-GCM frame keys (LiveKit defaults to 128);
 *   - `ratchetWindowSize: 0`, `failureTolerance: -1` — keys are EXTERNALLY
 *     derived; LiveKit's auto-ratchet-on-failure would silently diverge every
 *     receiver from the deterministic derivation, so it must never fire.
 */
class SenderKeyProvider extends BaseKeyProvider {
  constructor() {
    super({ sharedKey: false, ratchetWindowSize: 0, failureTolerance: -1, keySize: 256 });
  }

  /** Install `material` as `identity`'s frame-key material (HKDF input). */
  async setSenderMaterial(material: Uint8Array, identity: string): Promise<void> {
    const key = await crypto.subtle.importKey("raw", material.slice().buffer, "HKDF", false, [
      "deriveBits",
      "deriveKey",
    ]);
    this.onSetEncryptionKey(key, identity);
  }
}

/**
 * A single shared frame key for every publisher — the profile DM calls use.
 * A 1:1 call has exactly two senders and a fresh random per-call secret, so
 * the nonce-domain-partitioning rationale behind Concord's per-sender keys
 * (many members, one derivation root per epoch) doesn't apply, and a shared
 * key needs no in-band identity exchange — which a DM call, having no
 * presence plane, could not carry anyway. Ratchet/failure knobs match
 * SenderKeyProvider: the key is externally derived and must never drift.
 */
class SharedKeyProvider extends BaseKeyProvider {
  constructor() {
    super({ sharedKey: true, ratchetWindowSize: 0, failureTolerance: -1, keySize: 256 });
  }

  /** Install the call-wide frame-key material (HKDF input). */
  async setSharedMaterial(material: Uint8Array): Promise<void> {
    const key = await crypto.subtle.importKey("raw", material.slice().buffer, "HKDF", false, [
      "deriveBits",
      "deriveKey",
    ]);
    this.onSetEncryptionKey(key);
  }
}

/**
 * Construct the E2EE worker + Room for a blind-broker call (Concord or DM).
 * Runs during render (inside a useMemo), so the worker construction is
 * guarded: a stale tab after a deploy whose hashed e2ee-worker chunk now 404s
 * (answered by the SPA fallback as HTML), a browser that rejects the module
 * worker, or a CSP that blocks it would otherwise take down the whole tree as
 * an opaque hard join error. E2EE-required rooms must never fall back to
 * plaintext, so the failure is captured and rendered as a clean, leavable
 * error by the caller instead.
 */
function buildE2eeRoom(keyProvider: BaseKeyProvider): {
  room: Room | null;
  worker: Worker | null;
  error?: unknown;
} {
  let worker: Worker;
  try {
    worker = new Worker(new URL("livekit-client/e2ee-worker", import.meta.url), {
      type: "module",
    });
  } catch (err) {
    console.error("voice: E2EE worker failed to start", err);
    return { room: null, worker: null, error: err };
  }
  const micId = getPreferredMicId();
  const cameraId = getPreferredCameraId();
  const processing = getAudioProcessing();
  const opts: RoomOptions = {
    adaptiveStream: true,
    dynacast: true,
    // See useRoomOptions: source-specific 0–200% playback needs GainNodes.
    webAudioMix: true,
    disconnectOnPageLeave,
    e2ee: { keyProvider, worker },
    audioCaptureDefaults: {
      ...(micId ? { deviceId: micId } : {}),
      noiseSuppression: processing.noiseSuppression,
      echoCancellation: processing.echoCancellation,
      autoGainControl: processing.autoGainControl,
      // Capture mono: a stereo interface that only populates one channel
      // otherwise publishes a track that plays back from a single side for
      // every listener, and a mono reference is cleaner for echo cancellation.
      channelCount: 1,
    },
    videoCaptureDefaults: {
      ...(cameraId ? { deviceId: cameraId } : {}),
      resolution: VideoPresets.h720.resolution,
    },
    publishDefaults: {
      ...audioPublishDefaults,
      videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360, VideoPresets.h720],
      screenShareEncoding: VideoPresets.h1080.encoding,
    },
  };
  return { room: new Room(opts), worker };
}

/**
 * The Concord call bar's title. A button — like the NIP-29 and DM titles — so
 * clicking the call's name returns to its voice channel, running the same
 * handler the room registers as `focusActiveCall`. Exported so the regression
 * test can render it without standing up a LiveKit room.
 */
export function ConcordCallLabel({
  community,
  channel,
  onFocus,
}: {
  community: string;
  channel: string;
  onFocus: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onFocus}
      className="flex items-center gap-1 min-w-0 hover:underline text-left"
    >
      <span className="text-muted-foreground/70 truncate">{community}</span>
      <span className="shrink-0">#{channel}</span>
    </button>
  );
}

/**
 * Concord (CORD-07, serverless, E2E) voice room: token from a blind broker
 * (authorized by channel-key-possession proof, not membership), media
 * encrypted end-to-end under per-sender keys the SFU never sees, and presence
 * announced over the channel itself so relays and brokers stay blind.
 */
interface ActiveHevcCapture {
  stream: MediaStream;
  identity: string;
  audioTrack?: LocalTrack;
}

function ConcordVoiceRoom({
  ctx,
  onLeave,
  placeBar,
  placeStage,
  stageOpen,
}: {
  ctx: ConcordVoiceContext;
  onLeave: () => void;
  placeBar: PlaceBar;
  placeStage: PlaceStage;
  stageOpen: boolean;
}) {
  const { community, channel, broker } = ctx;
  const { user } = useCurrentUser();
  const { joinConcordCall, registerFocusActiveCall, registerCallSummary, setRaisedHands } =
    useCall();
  const navigate = useNavigate();
  // Live presence (§4): the identity→member verification input, the rendezvous
  // hint stream (§5), and the input to our own heartbeat below. Resolved before
  // the token so a failed mint has somewhere to fall through to.
  const fold = useVoicePresence(community, channel);
  // Followed live rather than snapshotted into `ctx`: a staff edit to the
  // community's brokers reaches a mounted call, like a relay change does.
  const communityBrokers = useCommunityAvBrokers(community);

  // The remaining candidates behind `ctx.broker`. `resolveVoiceBroker` already
  // probed one at join time, but a probe only proves the broker answered a
  // moment ago — it can still fail to mint, and without these that is a dead
  // end. Same config-only set, so a fall-through can't leave the community's
  // brokers either.
  const fallbackBrokers = useMemo(
    () =>
      channel.voice.room.pk
        ? rendezvousCandidates(channel.voice.room.pk, ownAvServers(), communityBrokers).filter((o) => o !== broker)
        : (communityBrokers.length > 0 ? communityBrokers : ownAvServers()).filter((o) => o !== broker),
    [channel.voice.room.pk, broker, communityBrokers],
  );

  const { data: tokenData, error, isLoading } = useAvToken(channel, broker, true, fallbackBrokers);

  // Raise-hand + emoji reactions (Armada client feature; Concord calls only —
  // they ride additive tags on the encrypted presence rumor, so brokers stay
  // blind). Own hand state is local; it feeds the heartbeat (below) and renders
  // our own tile instantly without waiting for the presence echo.
  const [handRaised, setHandRaised] = useState(false);

  // Live enforcement (CORD-07 §7): `ctx` is a join-time snapshot, so follow
  // the vault + Control fold while connected — rejoin the freshly-derived room
  // when the channel's key rolls (the rotation that severs a removed member
  // from chat must move the call too), and hang up on a ban verdict, vault
  // removal, or channel deletion.
  useCallSync(ctx, onLeave);

  // Navigate back to this Concord voice channel. The route params are the
  // community + channel idHex (matching /c/:communityId/:channelId).
  const goToChannel = useCallback(() => {
    navigate(`/c/${encodeURIComponent(community.idHex)}/${encodeURIComponent(channel.idHex)}`);
  }, [navigate, community.idHex, channel.idHex]);

  // Register the navigate-to-call handler so the floating video window's
  // "return to call" action lands on this Concord voice channel; the call bar's
  // title (ConcordCallLabel) runs the same handler.
  useEffect(() => {
    registerFocusActiveCall(goToChannel);
    return () => registerFocusActiveCall(null);
  }, [registerFocusActiveCall, goToChannel]);

  // How the call reads in the Android ongoing-call notification. The names are
  // the decrypted Concord ones — they never leave the device, and the
  // notification is drawn locally by a service in this same process.
  useEffect(() => {
    registerCallSummary({ title: `#${channel.name}`, subtitle: community.name });
    return () => registerCallSummary(null);
  }, [registerCallSummary, channel.name, community.name]);

  // Our own heartbeat (§4): `joined` every 30s, `left` on leave — also carrying
  // the sticky raised-hand state and, via `sendReaction`, transient emoji (both
  // Armada client extensions on the same rumor). The broker announced is the one
  // that actually minted the token, not the one the rendezvous nominated: after
  // a fall-through those differ, and advertising the unreachable origin would
  // steer everyone else at a broker that is not hosting this call.
  const [hevcIdentities, setHevcIdentities] = useState<string[]>([]);
  const { sendReaction, announceAdditionalIdentities } = useVoiceHeartbeat(
    community,
    channel,
    tokenData?.identity,
    tokenData?.origin,
    handRaised,
    hevcIdentities,
  );
  // Live in-call emoji reactions from every member (own reactions echo back).
  const reactions = useVoiceReactions(community, channel);

  // Who has a hand up: the fresh presence fold, plus ourselves the instant we
  // raise (before our own heartbeat echoes back). Pushed to the app-level call
  // context so the sidebar voice roster can show it alongside muted/speaking.
  const raisedHands = useMemo(() => {
    const set = new Set<string>();
    for (const p of fold.present) if (p.hand) set.add(p.author);
    if (handRaised && user) set.add(user.pubkey);
    return set;
  }, [fold, handRaised, user]);
  useEffect(() => {
    setRaisedHands(raisedHands);
  }, [raisedHands, setRaisedHands]);
  useEffect(() => () => setRaisedHands(new Set()), [setRaisedHands]);

  // Build the E2EE-enabled Room once (the component remounts per
  // room/epoch/broker). Concord media MUST be end-to-end encrypted — the
  // broker/SFU are blind and untrusted — so a failed worker construction is
  // captured and rendered as a leavable error below (see buildE2eeRoom).
  const e2ee = useMemo((): {
    room: Room | null;
    keyProvider: SenderKeyProvider;
    worker: Worker | null;
    error?: unknown;
  } => {
    const keyProvider = new SenderKeyProvider();
    return { keyProvider, ...buildE2eeRoom(keyProvider) };
  }, []);

  // Key management (§3 + §7): every VERIFIED participant's frame key derives
  // from the media root + their identity; an unverified identity (unclaimed,
  // or contested by more than one fresh presence claim) gets a random key
  // instead, so its tracks fail to decode and are never rendered — the §7
  // SHOULD. Own identity is always keyed (we don't wait for our own heartbeat
  // to echo back). `applied` makes key writes idempotent across fold changes.
  const applied = useRef(new Map<string, string>());
  useEffect(() => {
    if (!tokenData) return;
    const mediaKey = channel.voice.mediaKey;
    if (!mediaKey) return;
    const room = e2ee.room;
    if (!room) return;

    const syncKeys = () => {
      const identities = new Set<string>([tokenData.identity]);
      for (const p of room.remoteParticipants.values()) identities.add(p.identity);
      // Pre-warm keys for identities presence already claims, so audio decodes
      // from the first frame after their tracks subscribe.
      for (const identity of fold.claims.keys()) identities.add(identity);
      for (const identity of hevcIdentities) identities.add(identity);
      for (const identity of identities) {
        const verified =
          identity === tokenData.identity ||
          hevcIdentities.includes(identity) ||
          Boolean(verifiedAuthorOf(fold, identity));
        const want = verified ? "sender" : "blocked";
        if (applied.current.get(identity) === want) continue;
        applied.current.set(identity, want);
        const material = verified ? voiceSenderKey(mediaKey, identity) : random32();
        void e2ee.keyProvider
          .setSenderMaterial(material, identity)
          // A failed key install means this identity's frames won't decrypt —
          // for our OWN identity that is exactly the "joined but Unverified to
          // peers" symptom — so make it observable rather than a silent no-op.
          .catch((err) =>
            console.error("Concord voice: failed to install frame key", {
              own: identity === tokenData.identity,
              err,
            }),
          );
      }
    };

    syncKeys();
    room.on(RoomEvent.ParticipantConnected, syncKeys);
    return () => {
      room.off(RoomEvent.ParticipantConnected, syncKeys);
    };
  }, [e2ee, tokenData, fold, channel, hevcIdentities]);

  // Enable E2EE once our own key is installed; terminate the worker on unmount.
  useEffect(() => {
    if (!tokenData || !e2ee.room) return;
    const room = e2ee.room;
    let cancelled = false;
    void (async () => {
      try {
        if (!cancelled) await room.setE2EEEnabled(true);
      } catch (err) {
        // Media won't encrypt if this throws (e.g. the browser lacks the
        // insertable-streams / RTCRtpScriptTransform path LiveKit needs), which
        // leaves us undecodable to peers. Surface it loudly; the render guard
        // below already refuses to join without a live E2EE worker.
        console.error("Concord voice: failed to enable E2EE", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [e2ee, tokenData]);
  useEffect(() => () => e2ee.worker?.terminate(), [e2ee]);

  // Chromium does not expose H.265 encoding through WebRTC on Linux. The
  // desktop shell's FFmpeg/VA-API path publishes a pre-encoded encrypted track
  // as a second LiveKit identity. This controller keeps that identity bound to
  // the real member, owns capture/audio cleanup, and rejects stale async starts.
  const [hevcCapability, setHevcCapability] =
    useState<DesktopHevcScreenShareCapability | null>(null);
  const [hevcStatus, setHevcStatus] = useState<DesktopHevcScreenShareStatus>({
    state: "idle",
    active: false,
  });
  const [hevcPreview, setHevcPreview] = useState<{
    track: MediaStreamTrack;
    identity: string;
  } | null>(null);
  const hevcIdentitiesRef = useRef<string[]>([]);
  hevcIdentitiesRef.current = hevcIdentities;
  const activeHevc = useRef<ActiveHevcCapture | null>(null);
  const pendingHevcCaptures = useRef(new Set<MediaStream>());
  const hevcSessionGeneration = useRef(0);
  const hevcStartGeneration = useRef(0);
  const shellHevcSessions = useRef(new HevcScreenShareSessionTracker());

  const stopHevc = useCallback(async (stopShell: boolean) => {
    hevcStartGeneration.current += 1;
    hevcSessionGeneration.current += 1;
    const active = activeHevc.current;
    activeHevc.current = null;
    for (const pending of pendingHevcCaptures.current) stopHevcCapturedMedia(pending);
    pendingHevcCaptures.current.clear();
    shellHevcSessions.current.retire();
    setHevcPreview(null);
    const remainingIdentities = active
      ? hevcIdentitiesRef.current.filter((identity) => identity !== active.identity)
      : hevcIdentitiesRef.current;
    if (active) {
      // Retiring the session id above means the shell's own "stopped" event is
      // refused from here on, so nothing else will clear this. Leaving it set
      // keeps the whole UI — the active dropdown, the diagnostics panel, the
      // quality path — acting on a share that has already ended, which is what
      // stopping from the OS affordance does.
      setHevcStatus({ state: "stopped", active: false });
      hevcIdentitiesRef.current = remainingIdentities;
      setHevcIdentities(remainingIdentities);
      // End trusted capture immediately. Shell IPC and relay delivery are
      // asynchronous and must never keep local screen/audio capture alive.
      stopHevcCapturedMedia(active.stream);
    }
    cancelDesktopHevcScreenShareFrames();

    const shellCleanup = stopShell
      ? stopDesktopHevcScreenShare()
        .then((status) => shellHevcSessions.current.retire(status.sessionId))
        .catch((error) => {
          console.warn("failed to stop H.265 shell publisher", error);
        })
      : Promise.resolve();
    const audioCleanup = (async () => {
      if (!active?.audioTrack || !e2ee.room) return;
      try {
        await e2ee.room.localParticipant.unpublishTrack(active.audioTrack, true);
      } catch (error) {
        console.warn("failed to stop H.265 screen-share audio", error);
      }
    })();

    // Shell and LiveKit audio cleanup are isolated: either one rejecting must
    // not prevent the other. Presence withdrawal happens last and is only a
    // best-effort state update after all local media has already ended.
    await Promise.all([shellCleanup, audioCleanup]);
    if (active) {
      try {
        await announceAdditionalIdentities(remainingIdentities);
      } catch (error) {
        console.warn("failed to withdraw H.265 screen-share identity", error);
      }
    }
  }, [announceAdditionalIdentities, e2ee.room]);

  // `stopHevc` is rebuilt whenever the Concord fold hands down a new channel
  // object, so nothing whose *cleanup* stops the share may depend on it: React
  // runs a cleanup on every dependency change, not only on unmount, and that
  // would retire a live screen share with no user action and no error. Reach
  // for the latest callback through a ref instead — the same idiom the
  // heartbeat effect uses for the identical reason.
  const stopHevcRef = useRef(stopHevc);
  stopHevcRef.current = stopHevc;

  useEffect(() => {
    let cancelled = false;
    void desktopHevcScreenShareCapability().then((capability) => {
      if (!cancelled) setHevcCapability(capability);
    });
    const unsubscribe = subscribeDesktopHevcScreenShareStatus((status) => {
      if (!shellHevcSessions.current.accept(status, Boolean(activeHevc.current))) return;
      setHevcStatus(status);
      if (status.state === "error" || status.state === "stopped") {
        shellHevcSessions.current.retire(status.sessionId);
        void stopHevcRef.current(false);
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  useEffect(
    () => () => {
      void stopHevcRef.current(true);
    },
    [],
  );

  const startHevc = useCallback(async (stream: MediaStream, quality: ScreenShareQuality) => {
    const room = e2ee.room;
    if (!tokenData || !room) {
      stopHevcCapturedMedia(stream);
      throw new Error("The Concord voice room is not connected.");
    }
    const video = stream.getVideoTracks()[0];
    if (!video) {
      stopHevcCapturedMedia(stream);
      throw new Error("The selected source did not provide a video track.");
    }

    for (const pending of pendingHevcCaptures.current) stopHevcCapturedMedia(pending);
    pendingHevcCaptures.current.clear();
    pendingHevcCaptures.current.add(stream);
    const stopCandidateCapture = () => {
      pendingHevcCaptures.current.delete(stream);
      stopHevcCapturedMedia(stream);
    };

    const startGeneration = ++hevcStartGeneration.current;
    const initialSessionGeneration = ++hevcSessionGeneration.current;
    const initialCurrent = () =>
      startGeneration === hevcStartGeneration.current &&
      initialSessionGeneration === hevcSessionGeneration.current;
    const assertInitialCurrent = () => {
      if (!initialCurrent()) throw new Error("The H.265 screen share was cancelled.");
    };

    // Everything below awaits at least a capability probe, an AV-broker mint
    // and a relay round-trip, and DOM events are not buffered: a listener
    // attached after those awaits never hears a capture the user cancelled
    // during them, and the publisher then starts on a dead track. `stop()`
    // does not fire this event, so a programmatic teardown cannot trip it.
    let adopted: ActiveHevcCapture | null = null;
    video.addEventListener(
      "ended",
      () => {
        if (startGeneration !== hevcStartGeneration.current) return;
        if (adopted) {
          if (activeHevc.current === adopted) void stopHevcRef.current(true);
          return;
        }
        // Cancel the start still in flight; its next generation check refuses
        // and releases the capture down the ordinary failure path.
        hevcStartGeneration.current += 1;
      },
      { once: true },
    );

    let capability: DesktopHevcScreenShareCapability;
    try {
      capability = hevcCapability ?? await desktopHevcScreenShareCapability();
      assertInitialCurrent();
    } catch (error) {
      stopCandidateCapture();
      throw error;
    }
    setHevcCapability(capability);
    if (!capability.available) {
      stopCandidateCapture();
      throw new Error(capability.reason || "The Linux H.265 encoder is unavailable.");
    }

    const previous = activeHevc.current;
    activeHevc.current = null;
    shellHevcSessions.current.retire();
    setHevcPreview(null);
    const remainingIdentities = previous
      ? hevcIdentitiesRef.current.filter((identity) => identity !== previous.identity)
      : hevcIdentitiesRef.current;
    if (previous) {
      hevcIdentitiesRef.current = remainingIdentities;
      setHevcIdentities(remainingIdentities);
      stopHevcCapturedMedia(previous.stream);
    }
    cancelDesktopHevcScreenShareFrames();
    const shellCleanup = stopDesktopHevcScreenShare();
    const audioCleanup = (async () => {
      if (!previous?.audioTrack) return;
      await room.localParticipant.unpublishTrack(previous.audioTrack, true);
    })();
    const [shellResult, audioResult] = await Promise.allSettled([
      shellCleanup,
      audioCleanup,
    ]);
    if (shellResult.status === "fulfilled") {
      shellHevcSessions.current.retire(shellResult.value.sessionId);
    }
    if (audioResult.status === "rejected") {
      console.warn("failed to replace H.265 screen-share audio", audioResult.reason);
    }
    if (previous) {
      try {
        await announceAdditionalIdentities(remainingIdentities);
      } catch (error) {
        console.warn("failed to withdraw replaced H.265 screen-share identity", error);
      }
    }
    if (shellResult.status === "rejected") {
      stopCandidateCapture();
      const detail = shellResult.reason instanceof Error
        ? shellResult.reason.message
        : String(shellResult.reason);
      throw new Error(
        previous
          ? `The previous H.265 screen share stopped locally, but its publisher could not be retired before switching: ${detail}`
          : `The previous H.265 publisher could not be retired: ${detail}`,
      );
    }
    if (startGeneration !== hevcStartGeneration.current) {
      stopCandidateCapture();
      throw new Error(
        previous
          ? "The previous H.265 screen share stopped while switching, and the replacement was cancelled."
          : "The H.265 screen share was cancelled.",
      );
    }

    const sessionGeneration = ++hevcSessionGeneration.current;
    const current = () =>
      startGeneration === hevcStartGeneration.current &&
      sessionGeneration === hevcSessionGeneration.current;
    const assertCurrent = () => {
      if (!current()) throw new Error("The H.265 screen share was cancelled.");
    };

    let publisherToken;
    let keyMaterial: Uint8Array;
    try {
      publisherToken = await fetchAvToken(tokenData.origin, channel.voice.room);
      assertCurrent();
      keyMaterial = voiceSenderKey(channel.voice.mediaKey, publisherToken.identity);
    } catch (error) {
      stopCandidateCapture();
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        previous
          ? `The previous H.265 screen share stopped while switching, and the replacement could not obtain access: ${detail}`
          : detail,
      );
    }
    const resolution = SCREEN_SHARE_RESOLUTIONS.find(
      (option) => option.id === quality.resolution,
    );
    if (!resolution) {
      stopCandidateCapture();
      throw new Error(
        previous
          ? "The previous H.265 screen share stopped while switching, and the replacement resolution is invalid."
          : "The selected H.265 resolution is invalid.",
      );
    }

    const active: ActiveHevcCapture = { stream, identity: publisherToken.identity };
    adopted = active;
    pendingHevcCaptures.current.delete(stream);
    activeHevc.current = active;
    hevcIdentitiesRef.current = [publisherToken.identity];
    setHevcIdentities([publisherToken.identity]);
    setHevcStatus({
      state: "starting",
      active: true,
      backend: capability.backend ?? undefined,
      encoder: capability.encoder ?? undefined,
      device: capability.device ?? undefined,
      width: resolution.width,
      height: resolution.height,
      frameRate: quality.frameRate,
      bitrate: quality.maxBitrate,
      pipelineStage: "Waiting for first captured frame",
    });

    try {
      // Publish signed role metadata before the auxiliary participant connects.
      // This prevents a transient extra caller in remote rosters and ensures a
      // named track alone can never make an ordinary participant disappear.
      await announceAdditionalIdentities([publisherToken.identity]);
      assertCurrent();
      const status = await startDesktopHevcScreenShare(video, {
        url: publisherToken.url,
        token: publisherToken.token,
        keyMaterial: bytesToBase64(keyMaterial),
        width: resolution.width,
        height: resolution.height,
        frameRate: quality.frameRate,
        bitrate: quality.maxBitrate,
      });
      assertCurrent();
      if (!shellHevcSessions.current.bind(status.sessionId)) {
        throw new Error("The H.265 publisher returned a retired or uncorrelated session.");
      }
      setHevcPreview({ track: video, identity: publisherToken.identity });

      const audio = stream.getAudioTracks()[0];
      if (audio) {
        const publication = await room.localParticipant.publishTrack(audio, {
          source: Track.Source.ScreenShareAudio,
        });
        if (!current()) {
          if (publication.track) {
            await room.localParticipant.unpublishTrack(publication.track, true);
          }
          throw new Error("The H.265 screen share was cancelled.");
        }
        if (publication.track) active.audioTrack = publication.track;
      }
      setHevcStatus(status);
    } catch (error) {
      if (current() && activeHevc.current === active) {
        await stopHevc(true);
        setHevcStatus({
          state: "error",
          active: false,
          error: error instanceof Error ? error.message : "The H.265 publisher failed to start.",
        });
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        previous
          ? `The previous H.265 screen share stopped while switching, and the replacement could not start: ${detail}`
          : detail,
      );
    }
  }, [
    announceAdditionalIdentities,
    channel.voice,
    e2ee.room,
    hevcCapability,
    stopHevc,
    tokenData,
  ]);

  const hevcScreenShare = useMemo(
    () => ({
      capability: hevcCapability,
      status: hevcStatus,
      active: hevcStatus.active,
      previewTrack: hevcPreview?.track ?? null,
      publisherIdentity: hevcPreview?.identity ?? null,
      start: startHevc,
      stop: async () => {
        await stopHevc(true);
        setHevcStatus({ state: "stopped", active: false, reason: "requested" });
      },
    }),
    [hevcCapability, hevcPreview, hevcStatus, startHevc, stopHevc],
  );

  // The raise-hand/reaction and custom media surface for portaled call UI.
  const signals = useMemo<CallSignals>(
    () => ({
      enabled: Boolean(tokenData),
      myHandRaised: handRaised,
      toggleHand: () => setHandRaised((raised) => !raised),
      sendReaction,
      reactions,
      hevcScreenShare,
    }),
    [tokenData, handRaised, sendReaction, reactions, hevcScreenShare],
  );

  // No split healing: §5's heal is a migration TO whichever broker presence
  // says is winning, which is the same untrusted hint this client declines to
  // route on — one member announcing a broker could otherwise pull a whole
  // call off the community's list mid-flight, which is the migration working
  // exactly as designed. Candidates come from config, so members converge
  // before anyone joins instead of after; what's left is a member whose fold
  // is stale or whose network reached a different candidate, and that is
  // reported (`occupantsElsewhere`) rather than chased.
  //
  // Compared against `tokenData.origin`, the origin we ACTUALLY minted
  // through: after a fall-through it differs from the one `ctx` nominated.
  const strandedFrom = useMemo(
    () => (tokenData ? occupantsElsewhere(fold, tokenData.origin) : []),
    [fold, tokenData],
  );
  // Where most of them are, so the offer names one server rather than a set.
  const elsewhereOrigin = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of strandedFrom) {
      const origin = p.broker ? canonicalOrigin(p.broker) : null;
      if (origin) counts.set(origin, (counts.get(origin) ?? 0) + 1);
    }
    let best: string | null = null;
    let bestCount = 0;
    for (const [origin, count] of counts) {
      if (count > bestCount) [best, bestCount] = [origin, count];
    }
    return best;
  }, [strandedFrom]);

  // Offered, never taken automatically. Following the crowd is what turns an
  // untrusted hint into routing; a member choosing to follow it, told plainly
  // that the server is in nobody's settings, is a decision rather than a
  // redirect — and the one case (a stale fold either side) where the crowd is
  // simply right is the one where they'd want to.
  const warnedSplit = useRef(false);
  useEffect(() => {
    if (warnedSplit.current || strandedFrom.length === 0 || !elsewhereOrigin) return;
    warnedSplit.current = true;
    const host = elsewhereOrigin.replace(/^https:\/\//, "");
    toast({
      title: `${strandedFrom.length} ${strandedFrom.length === 1 ? "member is" : "members are"} on another voice server`,
      description: `They're on ${host}, ${communityBrokers.length > 0 ? "not one this community sets" : "not your voice server"}, so they're in a separate call you won't hear.`,
      action: (
        <ToastAction
          altText={`Join the call on ${host}`}
          onClick={() => joinConcordCall({ ...ctx, broker: elsewhereOrigin })}
        >
          Join them
        </ToastAction>
      ),
    });
  }, [strandedFrom, elsewhereOrigin, communityBrokers, ctx, joinConcordCall]);

  // Identity → member resolution for the call UI (§4): our own identity is
  // ourselves; anyone else's renders as a member only under a sole fresh
  // presence claim, and contested/unclaimed identities show as unverified.
  const resolveIdentity = useCallback<VoiceIdentityResolver>(
    (identity) => {
      if (
        tokenData &&
        (identity === tokenData.identity || hevcIdentities.includes(identity)) &&
        user
      ) {
        return {
          pubkey: user.pubkey,
          verified: true,
          role: identity === tokenData.identity ? "member" : "screen-share",
        };
      }
      const author = verifiedAuthorOf(fold, identity);
      return author
        ? {
            pubkey: author,
            verified: true,
            role: isVerifiedScreenShareIdentity(fold, identity) ? "screen-share" : "member",
          }
        : { pubkey: identity, verified: false, role: "member" };
    },
    [fold, tokenData, user, hevcIdentities],
  );

  const handleDisconnected = useCallback(
    (reason?: DisconnectReason) => {
      if (reason !== undefined && reason !== DisconnectReason.CLIENT_INITIATED) {
        console.warn("concord voice disconnected", { reason: DisconnectReason[reason] ?? reason });
      }
      onLeave();
    },
    [onLeave],
  );

  if (isLoading) return <>{<LoadingBar placeBar={placeBar} label="Requesting voice access…" />}</>;
  if (error || !tokenData) return <>{<ErrorBar placeBar={placeBar} error={error} onLeave={onLeave} />}</>;
  // E2EE couldn't come up (worker failed to construct above). Never join a
  // Concord room without it — the SFU is blind and untrusted — so surface a
  // clear, leavable error instead of connecting as an undecodable ghost.
  const room = e2ee.room;
  if (e2ee.error || !room) {
    const e2eeError =
      e2ee.error instanceof Error
        ? e2ee.error
        : new Error("Voice encryption couldn’t start in this browser. Reload to update, then rejoin.");
    return <>{<ErrorBar placeBar={placeBar} error={e2eeError} onLeave={onLeave} />}</>;
  }

  const label = (
    <ConcordCallLabel community={community.name} channel={channel.name} onFocus={goToChannel} />
  );

  return (
    <VoiceIdentityContext.Provider value={resolveIdentity}>
      <CallSignalsContext.Provider value={signals}>
        <VoiceRoomShell
          serverUrl={tokenData.url}
          token={tokenData.token}
          options={{}}
          room={room}
          onDisconnected={handleDisconnected}
          placeBar={placeBar}
          placeStage={placeStage}
          stageOpen={stageOpen}
          label={label}
        />
      </CallSignalsContext.Provider>
    </VoiceIdentityContext.Provider>
  );
}

/**
 * DM (1:1) voice room: the blind-broker path applied to a direct conversation
 * (see src/lib/dmCall.ts). Token from a Concord AV broker, authorized by
 * possession of the per-call room key both sides derive from the offer's
 * secret; media end-to-end encrypted under one shared per-call key. The
 * broker only coordinates — it never learns who is calling whom and never
 * sees plaintext media. Ring/answer/decline signaling lives in
 * DmCallProvider, not here; this component is only the connected room.
 */
function DmVoiceRoom({
  ctx,
  onLeave,
  placeBar,
  placeStage,
  stageOpen,
}: {
  ctx: DmVoiceContext;
  onLeave: () => void;
  placeBar: PlaceBar;
  placeStage: PlaceStage;
  stageOpen: boolean;
}) {
  const { user } = useCurrentUser();
  const navigate = useNavigate();
  const keys = useMemo(() => dmCallKeys(ctx.secretHex), [ctx.secretHex]);

  // Mint from the call's broker first, falling through to our own defaults —
  // the same fall-through shape as Concord's §5 (a reachable broker can still
  // fail to mint). Never refetch while mounted: the token embeds our identity.
  const { data: tokenData, error, isLoading } = useQuery<AvToken>({
    queryKey: ["dm", "av-token", ctx.callId, ctx.broker],
    queryFn: () =>
      fetchAvTokenFromAny(
        [ctx.broker, ...ownAvServers().filter((o) => o !== ctx.broker)],
        keys.room,
      ),
    staleTime: Infinity,
    gcTime: 0,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: 1,
  });

  const peerAuthor = useAuthor(ctx.peer);
  const peerName = getDisplayName(peerAuthor.data?.metadata, ctx.peer);

  // DM media MUST be end-to-end encrypted (the broker/SFU only coordinate and
  // are never trusted with plaintext), so a failed worker construction renders
  // a leavable error below rather than ever joining plaintext.
  const e2ee = useMemo((): {
    room: Room | null;
    keyProvider: SharedKeyProvider;
    worker: Worker | null;
    error?: unknown;
  } => {
    const keyProvider = new SharedKeyProvider();
    return { keyProvider, ...buildE2eeRoom(keyProvider) };
  }, []);

  // Install the shared frame key. Both sides derive it from the call secret,
  // so there is nothing to exchange and nothing to sync per participant.
  useEffect(() => {
    if (!e2ee.room) return;
    void e2ee.keyProvider
      .setSharedMaterial(keys.mediaKey)
      .catch((err) => console.error("DM voice: failed to install frame key", err));
  }, [e2ee, keys]);

  // Enable E2EE once connected material is in place; terminate the worker on
  // unmount (mirrors ConcordVoiceRoom).
  useEffect(() => {
    if (!tokenData || !e2ee.room) return;
    const room = e2ee.room;
    let cancelled = false;
    void (async () => {
      try {
        if (!cancelled) await room.setE2EEEnabled(true);
      } catch (err) {
        console.error("DM voice: failed to enable E2EE", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [e2ee, tokenData]);
  useEffect(() => () => e2ee.worker?.terminate(), [e2ee]);

  // End the call when the peer leaves the SFU room. A 1:1 room with nobody else
  // in it is over (the same reasoning the "end" signal applies in
  // DmCallProvider), and LiveKit's ParticipantDisconnected is a RELIABLE
  // teardown where the ephemeral "end" wrap is not: that wrap rides a 21059
  // relays neither store nor retry, so a peer's hangup that misses this socket
  // would otherwise leave us alone in the room with activeCall stuck non-null —
  // permanently "busy", dropping every future incoming offer and hiding the
  // call button, i.e. never able to rejoin. The SFU reports the peer gone
  // (clean hangup or connection timeout) regardless, so this recovers either
  // way. Fires only on a transition to empty, so it can't trip before the peer
  // has joined.
  useEffect(() => {
    const room = e2ee.room;
    if (!room) return;
    const onParticipantDisconnected = () => {
      if (room.remoteParticipants.size === 0) onLeave();
    };
    room.on(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
    return () => {
      room.off(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
    };
  }, [e2ee.room, onLeave]);

  // Identity → member resolution: our broker-assigned identity is ourselves;
  // anyone else in a 1:1 room is the peer. Only the two secret-holders can
  // sign this room's token grant, and a party without the media key (a
  // hostile broker seating itself) produces no decodable media — at worst a
  // silent tile, never impersonated audio or video.
  const resolveIdentity = useCallback<VoiceIdentityResolver>(
    (identity) => {
      // A 1:1 room has no auxiliary publisher identities: the custom H.265
      // sidecar is a Concord-only path, so both parties are ordinary members.
      if (tokenData && identity === tokenData.identity && user) {
        return { pubkey: user.pubkey, verified: true, role: "member" };
      }
      return { pubkey: ctx.peer, verified: true, role: "member" };
    },
    [tokenData, user, ctx.peer],
  );

  const goToConversation = useCallback(() => {
    navigate(`/dm/${nip19.npubEncode(ctx.peer)}`);
  }, [navigate, ctx.peer]);

  const { registerFocusActiveCall, registerCallSummary } = useCall();
  useEffect(() => {
    registerFocusActiveCall(goToConversation);
    return () => registerFocusActiveCall(null);
  }, [registerFocusActiveCall, goToConversation]);

  // The Android ongoing-call notification label: the peer's name, plain text.
  useEffect(() => {
    registerCallSummary({ title: peerName });
    return () => registerCallSummary(null);
  }, [registerCallSummary, peerName]);

  const handleDisconnected = useCallback(
    (reason?: DisconnectReason) => {
      if (reason !== undefined && reason !== DisconnectReason.CLIENT_INITIATED) {
        console.warn("dm voice disconnected", { reason: DisconnectReason[reason] ?? reason });
      }
      onLeave();
    },
    [onLeave],
  );

  if (isLoading) return <>{<LoadingBar placeBar={placeBar} label="Requesting voice access…" />}</>;
  if (error || !tokenData) return <>{<ErrorBar placeBar={placeBar} error={error} onLeave={onLeave} />}</>;
  const room = e2ee.room;
  if (e2ee.error || !room) {
    const e2eeError =
      e2ee.error instanceof Error
        ? e2ee.error
        : new Error("Voice encryption couldn’t start in this browser. Reload to update, then rejoin.");
    return <>{<ErrorBar placeBar={placeBar} error={e2eeError} onLeave={onLeave} />}</>;
  }

  const label = (
    <button type="button" onClick={goToConversation} className="truncate hover:underline text-left">
      <DisplayName pubkey={ctx.peer} name={peerName} />
    </button>
  );

  return (
    <VoiceIdentityContext.Provider value={resolveIdentity}>
      <VoiceRoomShell
        serverUrl={tokenData.url}
        token={tokenData.token}
        options={{}}
        room={room}
        onDisconnected={handleDisconnected}
        placeBar={placeBar}
        placeStage={placeStage}
        stageOpen={stageOpen}
        label={label}
      />
    </VoiceIdentityContext.Provider>
  );
}

/**
 * The persistent voice room. Mounted (lazily) by `CallProvider` — which lives
 * in the never-unmounting MainLayout — so the LiveKit connection survives
 * navigation between channels and servers.
 *
 * The call UI renders in two places: a fixed bottom bar on mobile, and — when a
 * channel sidebar registers a slot — portaled above the account pill on desktop.
 */
export default function PersistentVoiceRoom({
  call,
  onLeave,
  slots,
  stageHost,
  stageOpen,
  exiting,
  shellRef,
}: {
  call: ActiveCall;
  onLeave: () => void;
  slots: HTMLElement[];
  /** Stable stage host element (owned + reparented by CallProvider). */
  stageHost: HTMLElement;
  stageOpen: boolean;
  exiting: boolean;
  shellRef: React.RefObject<HTMLDivElement | null>;
}) {
  const placeBar = useMemo(() => makePlaceBar(slots, exiting, shellRef), [slots, exiting, shellRef]);
  const placeStage = useMemo(() => makePlaceStage(stageHost), [stageHost]);

  if (call.concord) {
    return (
      <ConcordVoiceRoom
        ctx={call.concord}
        onLeave={onLeave}
        placeBar={placeBar}
        placeStage={placeStage}
        stageOpen={stageOpen}
      />
    );
  }
  if (call.dm) {
    return (
      <DmVoiceRoom
        ctx={call.dm}
        onLeave={onLeave}
        placeBar={placeBar}
        placeStage={placeStage}
        stageOpen={stageOpen}
      />
    );
  }
  return (
    <Nip29VoiceRoom
      call={call}
      onLeave={onLeave}
      placeBar={placeBar}
      placeStage={placeStage}
      stageOpen={stageOpen}
    />
  );
}
