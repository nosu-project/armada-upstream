import { LiveKitRoom, RoomAudioRenderer, useRoomContext } from "@livekit/components-react";
import {
  ConnectionState,
  DisconnectReason,
  ExternalE2EEKeyProvider,
  Room,
  RoomEvent,
  VideoPresets,
  type RoomOptions,
} from "livekit-client";
import { Loader2, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";

import "@livekit/components-styles";

import { InCallView } from "@/components/chat/VoiceBar";
import { VideoStage } from "@/components/chat/VideoStage";
import { Button } from "@/components/ui/button";
import { useAuthor } from "@/hooks/useAuthor";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useGroup } from "@/hooks/useGroup";
import { useLivekitToken } from "@/hooks/useLivekit";
import { useConcordVoiceToken } from "@/hooks/useConcordVoiceToken";
import { useConcordVoiceHeartbeat } from "@/hooks/useConcordVoice";
import { useRelayInfo } from "@/hooks/useRelayInfo";
import { CallContext, type ActiveCall, type ConcordVoiceContext } from "@/contexts/CallContext";
import { ServerScopeProvider } from "@/components/ServerScopeProvider";
import { getDisplayName } from "@/lib/getDisplayName";
import { relayToRouteParam } from "@/lib/platform";
import { playJoinSound, playLeaveSound } from "@/lib/callSounds";
import { getAudioProcessing, getPreferredCameraId, getPreferredMicId } from "@/lib/voiceDevices";
import { voiceMediaKey } from "@/lib/concord/voice";
import { cn } from "@/lib/utils";
import { bytesToHex } from "@noble/hashes/utils.js";
import { nip19 } from "nostr-tools";

/**
 * Plays a short chirp when you join the call, when another participant joins,
 * and when someone leaves. Must render inside a `LiveKitRoom`.
 */
function CallSoundEffects() {
  const room = useRoomContext();

  useEffect(() => {
    const onJoin = () => playJoinSound();
    const onLeave = () => playLeaveSound();
    // Your own join: RoomEvent.Connected fires once the local participant has
    // joined. If the room is already connected by the time this mounts (e.g. a
    // fast reconnect), play it immediately so you always get audible feedback.
    if (room.state === ConnectionState.Connected) {
      playJoinSound();
    } else {
      room.on(RoomEvent.Connected, onJoin);
    }
    // Other participants joining/leaving after you're in.
    room.on(RoomEvent.ParticipantConnected, onJoin);
    room.on(RoomEvent.ParticipantDisconnected, onLeave);
    return () => {
      room.off(RoomEvent.Connected, onJoin);
      room.off(RoomEvent.ParticipantConnected, onJoin);
      room.off(RoomEvent.ParticipantDisconnected, onLeave);
    };
  }, [room]);

  return null;
}

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
      audioCaptureDefaults: {
        ...(micId ? { deviceId: micId } : {}),
        noiseSuppression: processing.noiseSuppression,
        echoCancellation: processing.echoCancellation,
        autoGainControl: processing.autoGainControl,
      },
      videoCaptureDefaults: {
        ...(cameraId ? { deviceId: cameraId } : {}),
        resolution: VideoPresets.h720.resolution,
      },
      publishDefaults: {
        videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360, VideoPresets.h720],
        screenShareEncoding: VideoPresets.h1080.encoding,
      },
      ...extra,
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

/** Build the place-bar renderer (fixed mobile bar + portaled desktop slots). */
function makePlaceBar(slots: HTMLElement[], exiting: boolean): PlaceBar {
  return (mobile, desktop) => (
    <>
      <div
        className={cn(
          "fixed bottom-0 inset-x-0 z-40 px-2 pb-safe sidebar:hidden",
          exiting
            ? "animate-out fade-out-0 slide-out-to-bottom-4 duration-200 fill-mode-forwards"
            : "animate-in fade-in-0 slide-in-from-bottom-4 duration-300",
        )}
      >
        {mobile}
      </div>
      {slots.map((el, i) =>
        createPortal(
          <div
            className={cn(
              "px-1 pb-1",
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
  label: React.ReactNode;
  /** Server scope for display names (NIP-29 relay url; undefined for DM/Concord). */
  scopeRelayUrl?: string;
}) {
  const mobileBar = (
    <ServerScopeProvider relayUrl={scopeRelayUrl}>
      <div className="clip-corner-lg bg-chrome-deep shadow-lg">
        <InCallView label={label} />
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
      audio
      video={false}
      options={options}
      onDisconnected={onDisconnected}
      // `display: contents` so the room container generates no box of its own.
      style={{ display: "contents" }}
    >
      <RoomAudioRenderer />
      <CallSoundEffects />
      <VideoStage callLabel={label} />
      {placeBar(mobileBar, desktopBar)}
    </LiveKitRoom>
  );
}

/**
 * NIP-29 (group / DM) voice room: token from the relay's NIP-29 LiveKit
 * endpoint, authorized by group membership (or DM pair). No media E2EE — the
 * relay-trusted SFU is part of the trust model here.
 */
function Nip29VoiceRoom({
  call,
  onLeave,
  placeBar,
}: {
  call: ActiveCall;
  onLeave: () => void;
  placeBar: PlaceBar;
}) {
  const navigate = useNavigate();
  const isDm = Boolean(call.dmPeer);
  const { data: tokenData, error, isLoading } = useLivekitToken(call.relayUrl, call.groupId, true);
  const { data: details } = useGroup(call.relayUrl, isDm ? undefined : call.groupId);
  const { data: relayInfo } = useRelayInfo(call.relayUrl);
  const peerAuthor = useAuthor(isDm ? call.dmPeer : undefined);
  const peerName = getDisplayName(peerAuthor.data?.metadata, call.dmPeer ?? "");
  const channelName = isDm ? peerName : details?.group?.name ?? "voice";
  const serverName = isDm ? "Direct message" : relayInfo?.name ?? call.relayUrl.replace(/^wss?:\/\//, "");
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
    if (isDm && call.dmPeer) {
      navigate(`/dms/${nip19.npubEncode(call.dmPeer)}`);
      return;
    }
    navigate(`/s/${relayToRouteParam(call.relayUrl)}/${encodeURIComponent(call.groupId)}`);
  }, [navigate, isDm, call.dmPeer, call.relayUrl, call.groupId]);

  if (isLoading) return <>{<LoadingBar placeBar={placeBar} label="Requesting voice access…" />}</>;
  if (error || !tokenData) return <>{<ErrorBar placeBar={placeBar} error={error} onLeave={onLeave} />}</>;

  const label = isDm ? (
    <button type="button" onClick={goToChannel} className="truncate hover:underline text-left">
      {channelName}
    </button>
  ) : (
    <button type="button" onClick={goToChannel} className="hover:underline text-left">
      <span className="text-muted-foreground/70">{serverName}</span> #{channelName}
    </button>
  );

  return (
    <VoiceRoomShell
      serverUrl={tokenData.url}
      token={tokenData.token}
      options={options}
      onDisconnected={handleDisconnected}
      placeBar={placeBar}
      label={label}
      scopeRelayUrl={isDm ? undefined : call.relayUrl}
    />
  );
}

/**
 * Concord (serverless, E2E) voice room: token from a blind broker (authorized
 * by channel-key-possession proof, not membership) and media encrypted
 * end-to-end with a per-epoch key the SFU never sees. The SFU forwards
 * ciphertext it cannot decode.
 */
function ConcordVoiceRoom({
  ctx,
  onLeave,
  placeBar,
}: {
  ctx: ConcordVoiceContext;
  onLeave: () => void;
  placeBar: PlaceBar;
}) {
  const { community, channel, voiceServer } = ctx;
  const { data: tokenData, error, isLoading } = useConcordVoiceToken(community, channel, voiceServer, true);

  // Announce voice presence over sealed kind-3306 while we're in the room, so
  // other members see us in voice (and we age out on disconnect). The broker we
  // joined through rides the announcement as the rendezvous hint, so members on
  // other hosts converge here. Active once a token is in hand; the relay never
  // learns this — it's sealed under the channel key.
  useConcordVoiceHeartbeat(community, channel, tokenData ? voiceServer : undefined);

  // Build the E2EE-enabled Room once. The media key is derived from the channel
  // epoch key, so every member computes the same one and the SFU only ever
  // forwards ciphertext. The key provider + worker are constructed up front and
  // the key is set + E2EE enabled in an effect (both are async).
  const room = useMemo(() => {
    const keyProvider = new ExternalE2EEKeyProvider();
    const worker = new Worker(new URL("livekit-client/e2ee-worker", import.meta.url), {
      type: "module",
    });
    const opts: RoomOptions = {
      adaptiveStream: true,
      dynacast: true,
      e2ee: { keyProvider, worker },
      audioCaptureDefaults: (() => {
        const micId = getPreferredMicId();
        const processing = getAudioProcessing();
        return {
          ...(micId ? { deviceId: micId } : {}),
          noiseSuppression: processing.noiseSuppression,
          echoCancellation: processing.echoCancellation,
          autoGainControl: processing.autoGainControl,
        };
      })(),
      videoCaptureDefaults: (() => {
        const cameraId = getPreferredCameraId();
        return {
          ...(cameraId ? { deviceId: cameraId } : {}),
          resolution: VideoPresets.h720.resolution,
        };
      })(),
      publishDefaults: {
        videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360, VideoPresets.h720],
        screenShareEncoding: VideoPresets.h1080.encoding,
      },
    };
    const r = new Room(opts);
    return { room: r, keyProvider, worker };
    // Rebuild only when the channel/epoch changes (component remounts via key anyway).
  }, []);

  // Apply the derived media key and enable E2EE, then clean up on unmount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mediaKey = voiceMediaKey(channel);
        // setKey takes a raw ArrayBuffer; hand it a fresh copy of the 32 bytes.
        const buf = mediaKey.slice().buffer;
        await room.keyProvider.setKey(buf);
        if (!cancelled) await room.room.setE2EEEnabled(true);
      } catch (err) {
        console.warn("failed to enable Concord voice E2EE", err);
      }
    })();
    return () => {
      cancelled = true;
      room.worker.terminate();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room]);

  const handleDisconnected = useCallback(
    (reason?: DisconnectReason) => {
      if (reason !== undefined && reason !== DisconnectReason.CLIENT_INITIATED) {
        console.warn("concord voice disconnected", { reason: DisconnectReason[reason] ?? reason });
      }
      onLeave();
    },
    [onLeave],
  );

  if (isLoading) return <>{<LoadingBar placeBar={placeBar} label="Requesting encrypted voice…" />}</>;
  if (error || !tokenData) return <>{<ErrorBar placeBar={placeBar} error={error} onLeave={onLeave} />}</>;

  const label = (
    <span className="flex items-center gap-1 min-w-0">
      <ShieldCheck className="size-3.5 text-success shrink-0" />
      <span className="text-muted-foreground/70 truncate">{community.name}</span>
      <span className="shrink-0">#{channel.name}</span>
    </span>
  );

  return (
    <VoiceRoomShell
      serverUrl={tokenData.url}
      token={tokenData.token}
      options={{}}
      room={room.room}
      onDisconnected={handleDisconnected}
      placeBar={placeBar}
      label={label}
    />
  );
}

/**
 * The persistent voice room. Mounted once by `CallProvider` (which lives in the
 * never-unmounting MainLayout), so the LiveKit connection survives navigation
 * between channels and servers. Dispatches to the NIP-29 or Concord variant.
 *
 * The call UI renders in two places: a fixed bottom bar on mobile, and — when a
 * channel sidebar registers a slot — portaled above the account pill on desktop.
 */
function PersistentVoiceRoom({
  call,
  onLeave,
  slots,
  exiting,
}: {
  call: ActiveCall;
  onLeave: () => void;
  slots: HTMLElement[];
  exiting: boolean;
}) {
  const placeBar = useMemo(() => makePlaceBar(slots, exiting), [slots, exiting]);

  if (call.concord) {
    return <ConcordVoiceRoom ctx={call.concord} onLeave={onLeave} placeBar={placeBar} />;
  }
  return <Nip29VoiceRoom call={call} onLeave={onLeave} placeBar={placeBar} />;
}

/**
 * App-level voice call state. Holds the active room and renders the persistent
 * LiveKitRoom so navigation doesn't tear down the call.
 */
export function CallProvider({ children }: { children: React.ReactNode }) {
  const { user } = useCurrentUser();
  const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);
  const [exiting, setExiting] = useState(false);
  const [slots, setSlots] = useState<HTMLElement[]>([]);
  const exitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const joinCall = useCallback((relayUrl: string, groupId: string) => {
    if (exitTimer.current) {
      clearTimeout(exitTimer.current);
      exitTimer.current = null;
    }
    setExiting(false);
    setActiveCall({ relayUrl, groupId });
  }, []);

  const joinDmCall = useCallback((relayUrl: string, roomId: string, peer: string) => {
    if (exitTimer.current) {
      clearTimeout(exitTimer.current);
      exitTimer.current = null;
    }
    setExiting(false);
    setActiveCall({ relayUrl, groupId: roomId, dmPeer: peer });
  }, []);

  const joinConcordCall = useCallback((ctx: ConcordVoiceContext) => {
    if (exitTimer.current) {
      clearTimeout(exitTimer.current);
      exitTimer.current = null;
    }
    setExiting(false);
    // relayUrl/groupId are unused for the Concord path (the broker + room id are
    // derived inside ConcordVoiceRoom); set sentinel values for the remount key.
    setActiveCall({
      relayUrl: ctx.voiceServer,
      groupId: bytesToHex(ctx.channel.id),
      concord: ctx,
    });
  }, []);

  // Trigger the exit animation, then tear down the room once it finishes. The
  // LiveKit connection lives in PersistentVoiceRoom, so we keep it mounted for
  // the brief slide-out before unmounting (which disconnects). The leave chirp
  // is played by the hangup button's onClick (in VoiceBar), inside the user
  // gesture and before teardown — playing it here would be too late and get cut.
  const leaveCall = useCallback(() => {
    setExiting(true);
    if (exitTimer.current) clearTimeout(exitTimer.current);
    exitTimer.current = setTimeout(() => {
      setActiveCall(null);
      setExiting(false);
      exitTimer.current = null;
    }, 200);
  }, []);

  useEffect(() => () => {
    if (exitTimer.current) clearTimeout(exitTimer.current);
  }, []);

  const registerCallBarSlot = useCallback((el: HTMLElement) => {
    setSlots((prev) => (prev.includes(el) ? prev : [...prev, el]));
    return () => setSlots((prev) => prev.filter((s) => s !== el));
  }, []);

  return (
    <CallContext.Provider value={{ activeCall, joinCall, joinDmCall, joinConcordCall, leaveCall, registerCallBarSlot }}>
      <div
        className={cn(
          "relative flex h-full w-full overflow-hidden",
          // On mobile the call bar is a fixed bottom overlay; reserve space so
          // it doesn't cover the chat composer. On desktop the bar lives in the
          // sidebar slot, so no reservation is needed.
          user && activeCall && "max-sidebar:pb-[var(--call-bar-h)]",
        )}
        style={
          user && activeCall
            ? ({
                // Reserve the stacked call panel's height so the fixed mobile
                // bar doesn't cover the composer. The panel is header +
                // roster (scrolls past its cap) + control bar; reserve a
                // typical few-participant height plus the bar's own pb-safe
                // bottom inset (0.75rem + the home-indicator inset).
                "--call-bar-h":
                  "calc(11rem + 0.75rem + var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)))",
              } as React.CSSProperties)
            : undefined
        }
      >
        {children}
        {user && activeCall && (
          // `key` remounts the connection only when switching rooms.
          <PersistentVoiceRoom
            key={
              activeCall.concord
                ? `concord|${bytesToHex(activeCall.concord.channel.id)}|${activeCall.concord.channel.epoch}`
                : `${activeCall.relayUrl}|${activeCall.groupId}`
            }
            call={activeCall}
            onLeave={leaveCall}
            slots={slots}
            exiting={exiting}
          />
        )}
      </div>
    </CallContext.Provider>
  );
}
