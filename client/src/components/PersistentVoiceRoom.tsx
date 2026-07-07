import {
  LiveKitRoom,
  RoomAudioRenderer,
  useLocalParticipant,
  useRoomContext,
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
  type RoomOptions,
} from "livekit-client";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";

import "@livekit/components-styles";

import { InCallView } from "@/components/chat/VoiceBar";
import { CallStage } from "@/components/chat/CallStage";
import { Button } from "@/components/ui/button";
import { useAuthor } from "@/hooks/useAuthor";
import { useCall } from "@/hooks/useCall";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useGroup } from "@/hooks/useGroup";
import { useLivekitToken } from "@/hooks/useLivekit";
import { useRelayInfo } from "@/hooks/useRelayInfo";
import { type ActiveCall, type ConcordVoiceContext } from "@/contexts/CallContext";
import { VoiceIdentityContext, type VoiceIdentityResolver } from "@/contexts/VoiceIdentityContext";
import { ServerScopeProvider } from "@/components/ServerScopeProvider";
import { random32, voiceSenderKey } from "@/concord-v2/lib/derive";
import { rendezvousCandidates, verifiedAuthorOf } from "@/concord-v2/lib/voice";
import { useAvToken2, useVoiceHeartbeat2, useVoicePresence2 } from "@/concord-v2/hooks/useVoice2";
import { getDisplayName } from "@/lib/getDisplayName";
import { relayToRouteParam } from "@/lib/platform";
import { playJoinSound, playLeaveSound } from "@/lib/callSounds";
import { getAudioProcessing, getPreferredCameraId, getPreferredMicId } from "@/lib/voiceDevices";
import { syncRnnoise } from "@/lib/voiceProcessor";
import { cn } from "@/lib/utils";
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
        ...audioPublishDefaults,
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

  useEffect(() => {
    const bar = ref.current;
    const shell = shellRef.current;
    if (!bar || !shell) return;
    const apply = () => {
      shell.style.setProperty("--call-bar-h", `${bar.offsetHeight}px`);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(bar);
    return () => {
      ro.disconnect();
      // Release the reservation when the bar unmounts.
      shell.style.removeProperty("--call-bar-h");
    };
  }, [shellRef]);

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

type PlaceStage = (stage: React.ReactNode) => React.ReactNode;

/**
 * Build the place-stage renderer: portal the call stage into every registered
 * top-of-chat slot (in practice the single chat surface matching the active
 * call). Returns null when no slot is registered yet.
 */
function makePlaceStage(slots: HTMLElement[]): PlaceStage {
  return (stage) => (
    <>
      {slots.map((el, i) => createPortal(stage, el, `call-stage-slot-${i}`))}
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
      audio
      video={false}
      options={options}
      onDisconnected={onDisconnected}
      // `display: contents` so the room container generates no box of its own.
      style={{ display: "contents" }}
    >
      <RoomAudioRenderer />
      <CallSoundEffects />
      <MicNoiseProcessor />
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
 * NIP-29 (group / DM) voice room: token from the relay's NIP-29 LiveKit
 * endpoint, authorized by group membership (or DM pair). No media E2EE — the
 * relay-trusted SFU is part of the trust model here.
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
      scopeRelayUrl={isDm ? undefined : call.relayUrl}
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
 * Concord (CORD-07, serverless, E2E) voice room: token from a blind broker
 * (authorized by channel-key-possession proof, not membership), media
 * encrypted end-to-end under per-sender keys the SFU never sees, and presence
 * announced over the channel itself so relays and brokers stay blind.
 */
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
  const { joinConcordCall } = useCall();
  const { data: tokenData, error, isLoading } = useAvToken2(channel, broker, true);

  // Live presence (§4): the identity→member verification input, the rendezvous
  // hint stream (§5), and our own heartbeat (joined every 30s, left on leave).
  const fold = useVoicePresence2(community, channel);
  useVoiceHeartbeat2(community, channel, tokenData?.identity, tokenData ? broker : undefined);

  // Build the E2EE-enabled Room once (the component remounts per room/epoch/broker).
  const e2ee = useMemo(() => {
    const keyProvider = new SenderKeyProvider();
    const worker = new Worker(new URL("livekit-client/e2ee-worker", import.meta.url), {
      type: "module",
    });
    const micId = getPreferredMicId();
    const cameraId = getPreferredCameraId();
    const processing = getAudioProcessing();
    const opts: RoomOptions = {
      adaptiveStream: true,
      dynacast: true,
      e2ee: { keyProvider, worker },
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
        ...audioPublishDefaults,
        videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360, VideoPresets.h720],
        screenShareEncoding: VideoPresets.h1080.encoding,
      },
    };
    return { room: new Room(opts), keyProvider, worker };
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
    const mediaKey = channel.voice?.mediaKey;
    if (!mediaKey) return;
    const room = e2ee.room;

    const syncKeys = () => {
      const identities = new Set<string>([tokenData.identity]);
      for (const p of room.remoteParticipants.values()) identities.add(p.identity);
      // Pre-warm keys for identities presence already claims, so audio decodes
      // from the first frame after their tracks subscribe.
      for (const p of fold.present) identities.add(p.identity);
      for (const identity of identities) {
        const verified = identity === tokenData.identity || Boolean(verifiedAuthorOf(fold, identity));
        const want = verified ? "sender" : "blocked";
        if (applied.current.get(identity) === want) continue;
        applied.current.set(identity, want);
        const material = verified ? voiceSenderKey(mediaKey, identity) : random32();
        void e2ee.keyProvider.setSenderMaterial(material, identity).catch(() => undefined);
      }
    };

    syncKeys();
    room.on(RoomEvent.ParticipantConnected, syncKeys);
    return () => {
      room.off(RoomEvent.ParticipantConnected, syncKeys);
    };
  }, [e2ee, tokenData, fold, channel]);

  // Enable E2EE once our own key is installed; terminate the worker on unmount.
  useEffect(() => {
    if (!tokenData) return;
    let cancelled = false;
    void (async () => {
      try {
        if (!cancelled) await e2ee.room.setE2EEEnabled(true);
      } catch (err) {
        console.warn("failed to enable Concord voice E2EE", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [e2ee, tokenData]);
  useEffect(() => () => e2ee.worker.terminate(), [e2ee]);

  // Split healing (§5): if presence shows the call occupied on an origin that
  // beats ours in the tie-break, migrate there (once per mount — the remount
  // key includes the broker, so a migration builds a fresh room).
  const migrated = useRef(false);
  useEffect(() => {
    if (!tokenData || migrated.current) return;
    const roomHex = channel.voice?.room.pk;
    if (!roomHex) return;
    const winner = rendezvousCandidates(roomHex, fold, [])[0];
    const occupiedByOther = fold.present.some(
      (p) => p.broker === winner && p.identity !== tokenData.identity,
    );
    if (winner && winner !== broker && occupiedByOther) {
      migrated.current = true;
      joinConcordCall({ ...ctx, broker: winner });
    }
  }, [fold, tokenData, broker, channel, ctx, joinConcordCall]);

  // Identity → member resolution for the call UI (§4): our own identity is
  // ourselves; anyone else's renders as a member only under a sole fresh
  // presence claim, and contested/unclaimed identities show as unverified.
  const resolveIdentity = useCallback<VoiceIdentityResolver>(
    (identity) => {
      if (tokenData && identity === tokenData.identity && user) {
        return { pubkey: user.pubkey, verified: true };
      }
      const author = verifiedAuthorOf(fold, identity);
      return author ? { pubkey: author, verified: true } : { pubkey: identity, verified: false };
    },
    [fold, tokenData, user],
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

  const label = (
    <span className="flex items-center gap-1 min-w-0">
      <span className="text-muted-foreground/70 truncate">{community.name}</span>
      <span className="shrink-0">#{channel.name}</span>
    </span>
  );

  return (
    <VoiceIdentityContext.Provider value={resolveIdentity}>
      <VoiceRoomShell
        serverUrl={tokenData.url}
        token={tokenData.token}
        options={{}}
        room={e2ee.room}
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
  stageSlots,
  stageOpen,
  exiting,
  shellRef,
}: {
  call: ActiveCall;
  onLeave: () => void;
  slots: HTMLElement[];
  stageSlots: HTMLElement[];
  stageOpen: boolean;
  exiting: boolean;
  shellRef: React.RefObject<HTMLDivElement | null>;
}) {
  const placeBar = useMemo(() => makePlaceBar(slots, exiting, shellRef), [slots, exiting, shellRef]);
  const placeStage = useMemo(() => makePlaceStage(stageSlots), [stageSlots]);

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
