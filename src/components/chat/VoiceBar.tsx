import {
  DisconnectButton,
  useConnectionState,
  useLocalParticipant,
  useMediaDeviceSelect,
  useParticipants,
} from "@livekit/components-react";
import { ConnectionState, LocalAudioTrack, Track } from "livekit-client";
import type { Participant } from "livekit-client";
import {
  Check,
  Headphones,
  Loader2,
  Mic,
  MicOff,
  MonitorOff,
  MonitorUp,
  PhoneOff,
  Settings2,
  Video,
  VideoOff,
  Volume2,
} from "lucide-react";

import "@livekit/components-styles";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useCallback, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ReactionsMenu } from "@/components/chat/ReactionsMenu";
import { VolumeSliderRow } from "@/components/VoiceUserContextMenu";
import { useAuthor } from "@/hooks/useAuthor";
import { useCall } from "@/hooks/useCall";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { useUserVolume } from "@/hooks/useUserVolume";
import { useVoiceIdentity } from "@/contexts/VoiceIdentityContext";
import { getAvatarShape } from "@/lib/avatarShape";
import { playLeaveSound, playMuteSound, playUnmuteSound } from "@/lib/callSounds";
import {
  getAudioProcessing,
  rememberVoiceDevice,
  setAudioProcessing,
  type AudioProcessingPrefs,
} from "@/lib/voiceDevices";
import { rnnoiseSupported, syncRnnoise } from "@/lib/voiceProcessor";
import { cn } from "@/lib/utils";

/** Whether this browser supports choosing the audio output (speaker) sink. */
const supportsSpeakerSelection =
  typeof document !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;

/** Whether this browser can capture the screen (absent on most mobile). */
const supportsScreenShare =
  typeof navigator !== "undefined" &&
  typeof navigator.mediaDevices?.getDisplayMedia === "function";

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

/**
 * The call/audio settings gear: mic/speaker/camera device pickers, audio
 * processing toggles, and per-participant volume controls. Shown on both the
 * desktop (stacked) bar and the compact mobile bar — the single call settings
 * entry point, à la Discord. `className` sizes the trigger to match the bar
 * it's placed in.
 */
function DeviceMenu({ className }: { className?: string }) {
  const { localParticipant } = useLocalParticipant();
  const [processing, setProcessing] = useState<AudioProcessingPrefs>(() => getAudioProcessing());

  // Apply a processing change live: persist it, then make it take effect this
  // call (not just the next one). The browser constraints (noise/echo/gain) only
  // apply at track creation, so they need an explicit restartTrack to re-acquire
  // the mic. RNNoise is a track processor, added/removed in place via
  // syncRnnoise without re-acquiring the device.
  const update = useCallback(
    (patch: Partial<AudioProcessingPrefs>) => {
      setProcessing((prev) => {
        const next = { ...prev, ...patch };
        setAudioProcessing(next);
        const pub = localParticipant.getTrackPublication(Track.Source.Microphone);
        const track = pub?.audioTrack;
        if (track instanceof LocalAudioTrack) {
          if ("rnnoise" in patch) {
            void syncRnnoise(track, next.rnnoise);
          } else {
            // restartTrack re-acquires the mic and drops any active processor,
            // so re-apply RNNoise afterwards if it's enabled.
            void track
              .restartTrack({
                noiseSuppression: next.noiseSuppression,
                echoCancellation: next.echoCancellation,
                autoGainControl: next.autoGainControl,
              })
              .then(() => syncRnnoise(track, next.rnnoise))
              .catch((err) => console.warn("failed to apply audio processing", err));
          }
        }
        return next;
      });
    },
    [localParticipant],
  );

  const toggles: { key: keyof AudioProcessingPrefs; label: string }[] = [
    ...(rnnoiseSupported()
      ? [{ key: "rnnoise" as const, label: "Noise cancellation" }]
      : []),
    { key: "noiseSuppression", label: "Noise suppression" },
    { key: "echoCancellation", label: "Echo cancellation" },
    { key: "autoGainControl", label: "Auto gain control" },
  ];

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="icon" className={cn("size-8 touch:size-11 shrink-0", className)} aria-label="Audio settings">
              <Settings2 className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Audio settings</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="max-w-72 max-h-[70vh] overflow-y-auto">
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
        <DeviceSelectGroup kind="videoinput" label="Camera" icon={<Video className="size-3.5" />} />
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs">Processing</DropdownMenuLabel>
        {toggles.map(({ key, label }) => (
          <label
            key={key}
            className="flex items-center justify-between gap-3 px-2 py-1.5 touch:py-3 text-sm cursor-pointer"
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
        <ParticipantVolumeGroup />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * One remote participant's per-user volume control inside the Audio settings
 * menu: avatar + name + the shared mute-toggle/volume slider (`VolumeSliderRow`,
 * backed by the per-pubkey `useUserVolume` store, so changes apply to live
 * audio immediately via the room's `UserVolumeApplier`). The local participant
 * is skipped by the caller (no local playback of your own audio to adjust).
 */
function ParticipantVolumeRow({ participant }: { participant: Participant }) {
  const resolveIdentity = useVoiceIdentity();
  const { pubkey, verified } = resolveIdentity(participant.identity);
  const author = useAuthor(verified ? pubkey : undefined);
  const metadata = author.data?.metadata;
  const scopedName = useScopedDisplayName(pubkey, metadata);
  const name = verified ? scopedName : "Unverified";
  const [volume, setVolume] = useUserVolume(pubkey);

  return (
    // Keep the menu open while dragging the slider / toggling mute.
    <div className="px-2 py-1.5" onPointerDown={(e) => e.stopPropagation()}>
      <div className="flex items-center gap-2 mb-1.5">
        <Avatar shape={getAvatarShape(metadata)} className="size-5 shrink-0">
          <AvatarImage src={metadata?.picture} alt={name} />
          <AvatarFallback className="bg-success/20 text-success text-[9px]">
            {name[0]?.toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <span className="truncate text-sm">{name}</span>
      </div>
      <VolumeSliderRow volume={volume} apply={setVolume} displayName={name} />
    </div>
  );
}

/**
 * The "Participants" section of the Audio settings menu: a per-user volume
 * control for every *remote* participant. Gives mobile (and desktop) a
 * discoverable path to per-participant volume from the one call/audio settings
 * button, à la Discord — no separate participants button needed.
 */
function ParticipantVolumeGroup() {
  const participants = useParticipants();
  const remotes = participants.filter((p) => !p.isLocal && p.identity);
  if (remotes.length === 0) return null;
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel className="text-xs">Participants</DropdownMenuLabel>
      {remotes.map((p) => (
        <ParticipantVolumeRow key={p.sid || p.identity} participant={p} />
      ))}
    </>
  );
}

interface InCallViewProps {
  /** Optional label (e.g. the channel name) shown before the participants. */
  label?: React.ReactNode;
  /** When set, the label becomes a button (e.g. to jump to the channel). */
  onLabelClick?: () => void;
  /** Stack the label above the controls (for narrow side-panel placement). */
  stacked?: boolean;
  /**
   * Compact single-row layout for the fixed mobile bar: header + controls on
   * one line, no inline participant roster (the full roster/tiles live in the
   * expandable call stage, toggled from the header). Keeps the bar from
   * dominating the small screen.
   */
  compact?: boolean;
}

/**
 * In-call controls + connection/participant summary. Must be rendered inside a
 * LiveKitRoom context (uses room hooks). Intentionally shows NO participant
 * roster: who's in the call already lives in the sidebar's nested voice list
 * (and the expandable call stage, toggled from the header's Show/Hide button) —
 * a roster here would duplicate it right above.
 */
export function InCallView({ label, onLabelClick, stacked, compact }: InCallViewProps) {
  const { stageOpen, toggleStage } = useCall();
  const participants = useParticipants();
  const connectionState = useConnectionState();
  // These flags are reactive (the hook re-renders on the local participant's
  // track publish/mute), so the toggle buttons reflect live publish state.
  const { localParticipant, isMicrophoneEnabled, isCameraEnabled, isScreenShareEnabled } =
    useLocalParticipant();

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

  const headerEl = (
    <div className="flex items-center gap-1.5 min-w-0 px-1">
      <Headphones className="size-4 text-success shrink-0" />
      {label ? (
        onLabelClick ? (
          <button
            type="button"
            onClick={onLabelClick}
            className="flex-1 min-w-0 truncate text-xs font-semibold text-foreground hover:underline text-left"
          >
            {label}
          </button>
        ) : (
          <span className="flex-1 min-w-0 truncate text-xs font-semibold text-foreground">
            {label}
          </span>
        )
      ) : (
        <span className="flex-1 min-w-0 truncate text-xs font-semibold text-success">
          {compact ? "Connected" : "Voice connected"}
        </span>
      )}
      <button
        type="button"
        onClick={toggleStage}
        aria-label={stageOpen ? "Hide call stage" : "Show call stage"}
        aria-pressed={stageOpen}
        className="shrink-0 flex items-center gap-1.5 rounded-md bg-foreground/10 px-2 py-1 touch:px-3 touch:py-2 text-[11px] font-medium text-foreground hover:bg-foreground/20"
      >
        <Video className="size-3.5" />
        <span className="tabular-nums">{participants.length}</span>
        <span>{stageOpen ? "Hide" : "Show"}</span>
      </button>
    </div>
  );

  const micBtn = (
    <Button
      variant={isMicrophoneEnabled ? "default" : "outline"}
      size="icon"
      className="size-9 touch:size-11 shrink-0"
      aria-label={isMicrophoneEnabled ? "Mute microphone" : "Unmute microphone"}
      onClick={() => {
        const enabling = !isMicrophoneEnabled;
        // Self-only feedback, played on the click gesture (AudioContext is
        // unlocked) so you hear a blip even though no roster change occurs.
        if (enabling) playUnmuteSound();
        else playMuteSound();
        localParticipant.setMicrophoneEnabled(enabling);
      }}
    >
      {isMicrophoneEnabled ? <Mic className="size-4" /> : <MicOff className="size-4" />}
    </Button>
  );

  const cameraBtn = (
    <Button
      variant={isCameraEnabled ? "default" : "outline"}
      size="icon"
      className="size-9 touch:size-11 shrink-0"
      aria-label={isCameraEnabled ? "Turn off camera" : "Turn on camera"}
      onClick={() => {
        void localParticipant
          .setCameraEnabled(!isCameraEnabled)
          .catch((err) => console.warn("failed to toggle camera", err));
      }}
    >
      {isCameraEnabled ? <Video className="size-4" /> : <VideoOff className="size-4" />}
    </Button>
  );

  const screenShareBtn = (
    <Button
      variant={isScreenShareEnabled ? "default" : "outline"}
      size="icon"
      className="size-9 touch:size-11 shrink-0"
      aria-label={isScreenShareEnabled ? "Stop sharing screen" : "Share screen"}
      onClick={() => {
        // Screenshare publishes its own track regardless of the camera; the
        // browser shows its native picker. Audio capture of the shared tab is
        // requested too (best-effort — not all sources provide it).
        void localParticipant
          .setScreenShareEnabled(!isScreenShareEnabled, { audio: true })
          .catch((err) => {
            // The user cancelling the OS picker rejects with NotAllowedError —
            // that's expected, not an error worth surfacing.
            if (err instanceof Error && err.name === "NotAllowedError") return;
            console.warn("failed to toggle screen share", err);
          });
      }}
    >
      {isScreenShareEnabled ? (
        <MonitorOff className="size-4" />
      ) : (
        <MonitorUp className="size-4" />
      )}
    </Button>
  );

  const hangupBtn = (
    <DisconnectButton
      // Play the leave chirp on the click itself, before LiveKit disconnects.
      // Doing it in CallProvider's leaveCall is too late: the disconnect tears
      // down the room's audio around the same tick and the sound gets cut off.
      // This fires inside the user's gesture, so the AudioContext is unlocked.
      onClick={() => playLeaveSound()}
      aria-label="Leave call"
      className="inline-flex items-center justify-center rounded-md size-9 touch:size-11 shrink-0 bg-destructive text-destructive-foreground hover:bg-destructive/90"
    >
      <PhoneOff className="size-4" />
    </DisconnectButton>
  );

  // A stacked panel (à la Discord): header → control bar. `stacked` only
  // widens the layout (desktop side-panel); the structure is the same on
  // mobile so the controls are never crammed onto the activity row.
  if (compact) {
    // Mobile: a single compact row. The roster/tiles live in the expandable
    // call stage (toggled from the header's Show/Hide button), so the bar stays small.
    // The control cluster is a single `shrink-0` group and the header is the
    // only flexible child, so the header truncates instead of the controls
    // overflowing — otherwise a long channel label pushes the rightmost
    // controls (the audio-settings gear, hangup) past the `clip-corner-lg`
    // clip edge and they vanish (intermittently, depending on label width and
    // whether screenshare is available). min-w-0 lets the header shrink fully.
    return (
      <div className="flex items-center gap-1.5 px-2 py-1.5 min-h-12">
        <div className="flex-1 min-w-0">{headerEl}</div>
        <div className="flex items-center gap-1.5 shrink-0">
          {micBtn}
          {cameraBtn}
          {supportsScreenShare && screenShareBtn}
          <ReactionsMenu className="size-9" />
          <DeviceMenu className="size-9" />
          {hangupBtn}
        </div>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col gap-1.5 px-2 py-2", stacked && "min-w-0")}>
      {headerEl}
      <div className="flex items-center gap-1.5 pt-1.5 border-t border-foreground/10">
        <div className="flex items-center gap-1.5">
          {micBtn}
          {cameraBtn}
          {supportsScreenShare && screenShareBtn}
          <ReactionsMenu />
          <DeviceMenu />
        </div>
        <div className="flex-1" />
        {hangupBtn}
      </div>
    </div>
  );
}
