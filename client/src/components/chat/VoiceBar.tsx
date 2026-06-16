import {
  DisconnectButton,
  useConnectionState,
  useLocalParticipant,
  useMediaDeviceSelect,
  useParticipants,
  useRemoteParticipants,
  useSpeakingParticipants,
} from "@livekit/components-react";
import { ConnectionState, LocalAudioTrack, Track } from "livekit-client";
import type { RemoteParticipant } from "livekit-client";
import {
  Check,
  Headphones,
  Loader2,
  Mic,
  MicOff,
  PhoneOff,
  Settings2,
  Volume2,
  VolumeX,
} from "lucide-react";

import "@livekit/components-styles";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import type { CSSProperties } from "react";
import { useCallback, useEffect, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAuthor } from "@/hooks/useAuthor";
import { pubkeyFromLivekitIdentity } from "@/hooks/useLivekit";
import { playLeaveSound, playMuteSound, playUnmuteSound } from "@/lib/callSounds";
import {
  getAudioProcessing,
  getUserVolume,
  rememberUserVolume,
  rememberVoiceDevice,
  setAudioProcessing,
  type AudioProcessingPrefs,
} from "@/lib/voiceDevices";
import {
  getAvatarShape,
  shapedAvatarBorderStyle,
  shapedAvatarSpeakingStyle,
} from "@/lib/avatarShape";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { cn } from "@/lib/utils";

function ParticipantAvatar({
  pubkey,
  isSpeaking,
  participant,
}: {
  pubkey: string;
  isSpeaking?: boolean;
  /** When set (remote participant), the avatar opens a per-user volume control. */
  participant?: RemoteParticipant;
}) {
  const author = useAuthor(pubkey);
  const metadata = author.data?.metadata;
  const displayName = useScopedDisplayName(pubkey, metadata);
  const shape = getAvatarShape(metadata);
  const hasCustomShape = !!shape;

  // The speaking indicator + background separator border are drawn on a
  // wrapper, never on the <Avatar> itself. For emoji-shaped avatars the
  // Avatar carries a CSS mask, which would clip any ring/box-shadow to the
  // emoji silhouette — so we use drop-shadow filters that hug the shape. For
  // circular avatars a plain ring + box-shadow looks crisper.
  const wrapperStyle: CSSProperties | undefined = hasCustomShape
    ? {
        // When speaking, a tight solid green outline hugs the emoji silhouette
        // on its own (no wide white separator pushing it out). Otherwise just
        // the background separator border.
        filter: isSpeaking
          ? shapedAvatarSpeakingStyle.filter
          : shapedAvatarBorderStyle.filter,
      }
    : undefined;

  const avatar = (
    // Wrapper keeps the indicator outside the (overflow-hidden / masked)
    // Avatar so it never gets cropped.
    <div
      className={cn(
        "rounded-full transition-shadow",
        !hasCustomShape && "ring-2 ring-background",
        !hasCustomShape && isSpeaking && "ring-success shadow-[0_0_0_2px_hsl(var(--success))]",
      )}
      style={wrapperStyle}
    >
      <Avatar shape={shape} className="size-7">
        <AvatarImage src={metadata?.picture} alt={displayName} />
        <AvatarFallback className="bg-primary/20 text-primary text-[10px]">
          {displayName[0]?.toUpperCase()}
        </AvatarFallback>
      </Avatar>
    </div>
  );

  // Local participant (no `participant` prop): plain avatar with a name tooltip.
  if (!participant) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{avatar}</TooltipTrigger>
        <TooltipContent>{displayName}</TooltipContent>
      </Tooltip>
    );
  }

  // Remote participant: clicking opens a per-user volume control.
  return (
    <ParticipantVolumeMenu participant={participant} pubkey={pubkey} displayName={displayName}>
      {avatar}
    </ParticipantVolumeMenu>
  );
}

/**
 * A dropdown anchored on a remote participant's avatar with a playback-volume
 * slider (0–200%). The chosen volume is applied live via LiveKit's
 * `RemoteParticipant.setVolume` and persisted per pubkey so it sticks across
 * calls. This is the per-user volume control (à la Discord).
 */
function ParticipantVolumeMenu({
  participant,
  pubkey,
  displayName,
  children,
}: {
  participant: RemoteParticipant;
  pubkey: string;
  displayName: string;
  children: React.ReactNode;
}) {
  const [volume, setVolume] = useState(() => getUserVolume(pubkey));

  // Re-apply the remembered volume whenever this participant (re)joins or their
  // track changes, since LiveKit resets to 1 on a fresh subscription.
  useEffect(() => {
    participant.setVolume(volume);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [participant]);

  const apply = useCallback(
    (next: number) => {
      setVolume(next);
      participant.setVolume(next);
      rememberUserVolume(pubkey, next);
    },
    [participant, pubkey],
  );

  const muted = volume === 0;
  const pct = Math.round(volume * 100);

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label={`Volume for ${displayName}`} className="shrink-0">
              {children}
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{displayName}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" className="w-56 p-3">
        <div className="flex items-center justify-between gap-2 mb-2">
          <span className="text-sm font-medium truncate">{displayName}</span>
          <span className="text-xs text-muted-foreground tabular-nums">{pct}%</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label={muted ? "Unmute user" : "Mute user"}
            className="shrink-0 text-muted-foreground hover:text-foreground"
            onClick={() => apply(muted ? 1 : 0)}
          >
            {muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
          </button>
          <Slider
            value={[volume]}
            min={0}
            max={2}
            step={0.05}
            aria-label={`Volume for ${displayName}`}
            onValueChange={([v]) => apply(v)}
          />
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Whether this browser supports choosing the audio output (speaker) sink. */
const supportsSpeakerSelection =
  typeof document !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;

function DeviceSelectGroup({
  kind,
  label,
  icon,
}: {
  kind: MediaDeviceKind;
  label: string;
  icon: React.ReactNode;
}) {
  // `requestPermissions` enumerates labelled devices (needs an active mic grant,
  // which we already have once in a call). Selecting persists the choice.
  const { devices, activeDeviceId, setActiveMediaDevice } = useMediaDeviceSelect({
    kind,
    requestPermissions: true,
  });

  if (devices.length === 0) return null;

  return (
    <>
      <DropdownMenuLabel className="flex items-center gap-2 text-xs">
        {icon}
        {label}
      </DropdownMenuLabel>
      {devices.map((device) => {
        const active = device.deviceId === activeDeviceId;
        return (
          <DropdownMenuItem
            key={device.deviceId}
            onSelect={() => {
              void setActiveMediaDevice(device.deviceId);
              rememberVoiceDevice(kind, device.deviceId);
            }}
            className="gap-2"
          >
            <Check className={cn("size-3.5 shrink-0", active ? "opacity-100" : "opacity-0")} />
            <span className="truncate">{device.label || "Unnamed device"}</span>
          </DropdownMenuItem>
        );
      })}
    </>
  );
}

/** A gear button opening a mic (and, when supported, speaker) device picker. */
function DeviceMenu() {
  const { localParticipant } = useLocalParticipant();
  const [processing, setProcessing] = useState<AudioProcessingPrefs>(() => getAudioProcessing());

  // Apply a processing change live: persist it, then restart the published mic
  // track with the new capture constraints so it takes effect this call (not
  // just the next one). audioCaptureDefaults only applies at track creation, so
  // an explicit restartTrack is required to re-acquire the mic with the new
  // noise-suppression / echo-cancellation / auto-gain constraints.
  const update = useCallback(
    (patch: Partial<AudioProcessingPrefs>) => {
      setProcessing((prev) => {
        const next = { ...prev, ...patch };
        setAudioProcessing(next);
        const pub = localParticipant.getTrackPublication(Track.Source.Microphone);
        const track = pub?.audioTrack;
        if (track instanceof LocalAudioTrack) {
          void track
            .restartTrack({
              noiseSuppression: next.noiseSuppression,
              echoCancellation: next.echoCancellation,
              autoGainControl: next.autoGainControl,
            })
            .catch((err) => console.warn("failed to apply audio processing", err));
        }
        return next;
      });
    },
    [localParticipant],
  );

  const toggles: { key: keyof AudioProcessingPrefs; label: string }[] = [
    { key: "noiseSuppression", label: "Noise suppression" },
    { key: "echoCancellation", label: "Echo cancellation" },
    { key: "autoGainControl", label: "Auto gain control" },
  ];

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="icon" className="size-8 shrink-0" aria-label="Audio settings">
              <Settings2 className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Audio settings</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="max-w-72">
        <DeviceSelectGroup kind="audioinput" label="Microphone" icon={<Mic className="size-3.5" />} />
        {supportsSpeakerSelection && (
          <>
            <DropdownMenuSeparator />
            <DeviceSelectGroup
              kind="audiooutput"
              label="Speaker"
              icon={<Volume2 className="size-3.5" />}
            />
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs">Processing</DropdownMenuLabel>
        {toggles.map(({ key, label }) => (
          <label
            key={key}
            className="flex items-center justify-between gap-3 px-2 py-1.5 text-sm cursor-pointer"
            // Keep the menu open while toggling.
            onPointerDown={(e) => e.preventDefault()}
          >
            <span>{label}</span>
            <Switch
              checked={processing[key]}
              onCheckedChange={(checked) => update({ [key]: checked })}
            />
          </label>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface InCallViewProps {
  /** Optional label (e.g. the channel name) shown before the participants. */
  label?: React.ReactNode;
  /** When set, the label becomes a button (e.g. to jump to the channel). */
  onLabelClick?: () => void;
  /** Stack the label above the controls (for narrow side-panel placement). */
  stacked?: boolean;
}

/**
 * In-call controls + live participant avatars. Must be rendered inside a
 * LiveKitRoom context (uses room hooks).
 */
export function InCallView({ label, onLabelClick, stacked }: InCallViewProps) {
  const participants = useParticipants();
  const remoteParticipants = useRemoteParticipants();
  const connectionState = useConnectionState();
  const { localParticipant } = useLocalParticipant();
  // `useSpeakingParticipants` subscribes to the room's ActiveSpeakersChanged
  // events (which include the LOCAL participant) and re-renders on every
  // change — unlike deriving from useTracks(), which only updates on track
  // publish/mute and so missed `isSpeaking` toggles (notably one's own voice).
  const speakingParticipants = useSpeakingParticipants();

  const speaking = new Set(speakingParticipants.map((p) => p.identity));
  const remoteByIdentity = new Map(remoteParticipants.map((p) => [p.identity, p]));

  if (connectionState === ConnectionState.Connecting) {
    return (
      <div className="flex items-center justify-center gap-2 px-3 py-2 min-h-12">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
        <span className="text-sm text-muted-foreground">Connecting to voice…</span>
      </div>
    );
  }

  if (connectionState === ConnectionState.Reconnecting) {
    return (
      <div className="flex items-center justify-center gap-2 px-3 py-2 min-h-12">
        <Loader2 className="size-4 animate-spin text-amber-500" />
        <span className="text-sm text-amber-500">Reconnecting…</span>
      </div>
    );
  }

  const labelEl = label && (
    onLabelClick ? (
      <button
        type="button"
        onClick={onLabelClick}
        className="flex items-center gap-1.5 min-w-0 text-xs font-medium text-foreground hover:underline text-left"
      >
        <Headphones className="size-4 text-success shrink-0" />
        <span className="truncate">{label}</span>
      </button>
    ) : (
      <span className="flex items-center gap-1.5 min-w-0 text-xs font-medium text-muted-foreground">
        <Headphones className="size-4 text-success shrink-0" />
        <span className="truncate">{label}</span>
      </span>
    )
  );

  const participantsEl = (
    // No `overflow-hidden` here: it would crop the speaking ring/glow off the
    // edge avatars. Padding gives the ring room; `min-w-0` still lets the row
    // shrink. Avatars overlap via negative spacing.
    <div className="flex -space-x-1.5 flex-1 min-w-0 px-0.5 py-1">
      {participants.map((p) => (
        <ParticipantAvatar
          key={p.identity}
          pubkey={pubkeyFromLivekitIdentity(p.identity)}
          isSpeaking={speaking.has(p.identity)}
          participant={remoteByIdentity.get(p.identity)}
        />
      ))}
    </div>
  );

  const micBtn = (
    <Button
      variant={localParticipant.isMicrophoneEnabled ? "default" : "outline"}
      size="icon"
      className="size-8 shrink-0"
      aria-label={localParticipant.isMicrophoneEnabled ? "Mute microphone" : "Unmute microphone"}
      onClick={() => {
        const enabling = !localParticipant.isMicrophoneEnabled;
        // Self-only feedback, played on the click gesture (AudioContext is
        // unlocked) so you hear a blip even though no roster change occurs.
        if (enabling) playUnmuteSound();
        else playMuteSound();
        localParticipant.setMicrophoneEnabled(enabling);
      }}
    >
      {localParticipant.isMicrophoneEnabled ? <Mic className="size-3.5" /> : <MicOff className="size-3.5" />}
    </Button>
  );

  const hangupBtn = (
    <DisconnectButton
      // Play the leave chirp on the click itself, before LiveKit disconnects.
      // Doing it in CallProvider's leaveCall is too late: the disconnect tears
      // down the room's audio around the same tick and the sound gets cut off.
      // This fires inside the user's gesture, so the AudioContext is unlocked.
      onClick={() => playLeaveSound()}
      className="inline-flex items-center justify-center rounded-md size-8 shrink-0 bg-destructive text-destructive-foreground hover:bg-destructive/90"
    >
      <PhoneOff className="size-3.5" />
    </DisconnectButton>
  );

  if (stacked) {
    return (
      <div className="flex flex-col gap-2 px-3 py-2">
        {labelEl}
        <div className="flex items-center gap-2">
          {participantsEl}
          {micBtn}
          <DeviceMenu />
          {hangupBtn}
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 px-3 py-2">
      {labelEl && <span className="shrink-0 max-w-40 truncate">{labelEl}</span>}
      {participantsEl}
      {micBtn}
      <DeviceMenu />
      {hangupBtn}
    </div>
  );
}
