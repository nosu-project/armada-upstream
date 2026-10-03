import {
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
  ScreenShare,
  Settings2,
  Video,
  Volume2,
} from "lucide-react";

import "@livekit/components-styles";

import { DisplayName } from "@/components/DisplayName";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Switch } from "@/components/ui/switch";
import { useCallback, useContext, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CameraButton, LeaveButton, MicButton, ScreenShareButton } from "@/components/chat/CallControls";
import { VolumeSliderRow } from "@/components/VoiceUserContextMenu";
import { useAuthor } from "@/hooks/useAuthor";
import { useCall } from "@/hooks/useCall";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { useScreenShareVolume, useUserVolume } from "@/hooks/useUserVolume";
import { useVoiceIdentity } from "@/contexts/VoiceIdentityContext";
import { VoiceRejoiningContext } from "@/contexts/VoiceRejoiningContext";
import { getAvatarShape } from "@/lib/avatarShape";
import {
  getAudioProcessing,
  rememberVoiceDevice,
  setAudioProcessing,
  supportsSpeakerSelection,
  type AudioProcessingPrefs,
} from "@/lib/voiceDevices";
import { syncRnnoise } from "@/lib/voiceProcessor";
import { rnnoiseSupported } from "@/lib/rnnoiseSupport";
import { cn } from "@/lib/utils";

function DeviceSelectGroup({
  kind,
  label,
  icon,
}: {
  kind: MediaDeviceKind;
  label: string;
  icon: React.ReactNode;
}) {
  // `requestPermissions` needs an active mic grant, which we have once in a call.
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

/** Call/audio settings gear: device pickers, audio processing and per-participant volume. */
function DeviceMenu({ className }: { className?: string }) {
  const { localParticipant } = useLocalParticipant();
  const [processing, setProcessing] = useState<AudioProcessingPrefs>(() => getAudioProcessing());

  // Browser constraints (noise/echo/gain) only apply at track creation, so they
  // need restartTrack; RNNoise is a processor toggled in place via syncRnnoise.
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
            // restartTrack drops any active processor, so re-apply RNNoise.
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
            <button
              type="button"
              aria-label="Audio settings"
              className={cn(
                "inline-flex items-center justify-center rounded-md size-8 touch:size-11 shrink-0 transition-colors",
                "bg-foreground/5 text-muted-foreground hover:bg-foreground/10",
                className,
              )}
            >
              <Settings2 className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Audio settings</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="max-w-72 max-h-[70vh] overflow-y-auto">
        <DeviceSelectGroup kind="audioinput" label="Microphone" icon={<Mic className="size-3.5" />} />
        {supportsSpeakerSelection() && (
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

/** Remote participant's mic and screen-share volume. Local participant is skipped (not played back locally). */
function ParticipantVolumeRow({ participant }: { participant: Participant }) {
  const resolveIdentity = useVoiceIdentity();
  const { pubkey, verified } = resolveIdentity(participant.identity);
  const author = useAuthor(verified ? pubkey : undefined);
  const metadata = author.data?.metadata;
  const scopedName = useScopedDisplayName(pubkey, metadata);
  const name = verified ? scopedName : "Unverified";
  const [volume, setVolume] = useUserVolume(pubkey);
  const [screenShareVolume, setScreenShareVolume] = useScreenShareVolume(pubkey);
  const hasScreenShareAudio = Boolean(
    participant.getTrackPublication(Track.Source.ScreenShareAudio),
  );

  return (
    <div className="px-2 py-1.5" onPointerDown={(e) => e.stopPropagation()}>
      <div className="flex items-center gap-2 mb-1.5">
        <Avatar shape={getAvatarShape(metadata)} className="size-5 shrink-0">
          <AvatarImage src={metadata?.picture} alt={name} />
          <AvatarFallback className="bg-success/20 text-success text-[9px]">
            {name[0]?.toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <span className="truncate text-sm flex-1">
          <DisplayName pubkey={verified ? pubkey : undefined} name={name} />
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {Math.round(volume * 100)}%
        </span>
      </div>
      <VolumeSliderRow volume={volume} apply={setVolume} displayName={name} />
      {hasScreenShareAudio && (
        <div className="mt-3 border-t border-border/60 pt-2">
          <div className="mb-1.5 flex items-center gap-2 text-xs text-muted-foreground">
            <ScreenShare className="size-3.5" />
            <span className="flex-1">Screen share</span>
            <span className="tabular-nums">{Math.round(screenShareVolume * 100)}%</span>
          </div>
          <VolumeSliderRow
            volume={screenShareVolume}
            apply={setScreenShareVolume}
            displayName={name}
            target="screenShare"
          />
        </div>
      )}
    </div>
  );
}

/** Per-user volume controls for every remote participant. */
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
  label?: React.ReactNode;
  onLabelClick?: () => void;
  stacked?: boolean;
  /** Single-row layout for the fixed mobile bar, without inline roster. */
  compact?: boolean;
}

/** In-call controls + summary. Must be rendered inside a LiveKitRoom context. */
export function InCallView({ label, onLabelClick, stacked, compact }: InCallViewProps) {
  // `stageVisible`, not `stageOpen`: away from the call's channel the visible
  // stage is the floating window, which `stageOpen` doesn't describe.
  const { stageVisible, toggleStage } = useCall();
  const participants = useParticipants();
  const connectionState = useConnectionState();
  const rejoining = useContext(VoiceRejoiningContext);

  // Between rejoin attempts the room reads Disconnected/Connecting; keep Leave reachable.
  if (
    connectionState === ConnectionState.Reconnecting ||
    (rejoining && connectionState !== ConnectionState.Connected)
  ) {
    return (
      <div className="flex items-center justify-center gap-2 px-3 py-2 min-h-12">
        <Loader2 className="size-4 animate-spin text-amber-500" />
        <span className="flex-1 min-w-0 truncate text-sm text-amber-500">Reconnecting…</span>
        <LeaveButton />
      </div>
    );
  }

  if (connectionState === ConnectionState.Connecting) {
    return (
      <div className="flex items-center justify-center gap-2 px-3 py-2 min-h-12">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
        <span className="text-sm text-muted-foreground">Connecting to voice…</span>
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
        aria-label={stageVisible ? "Hide call stage" : "Show call stage"}
        aria-pressed={stageVisible}
        className="shrink-0 flex items-center gap-1.5 rounded-md bg-foreground/10 px-2 py-1 touch:px-3 touch:py-2 text-[11px] font-medium text-foreground hover:bg-foreground/20"
      >
        <Video className="size-3.5" />
        <span className="tabular-nums">{participants.length}</span>
        <span>{stageVisible ? "Hide" : "Show"}</span>
      </button>
    </div>
  );

  if (compact) {
    // Controls are a single `shrink-0` group and the header is the only flexible
    // child, so a long label truncates instead of pushing controls past the clip edge.
    return (
      <div className="flex items-center gap-1.5 px-2 py-1.5 min-h-12">
        <div className="flex-1 min-w-0">{headerEl}</div>
        <div className="flex items-center gap-1.5 shrink-0">
          <MicButton />
          <CameraButton />
          <ScreenShareButton />
          <DeviceMenu />
          <LeaveButton />
        </div>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col gap-1.5 px-2 py-2", stacked && "min-w-0")}>
      {headerEl}
      <div className="flex items-center gap-1.5 pt-1.5 border-t border-foreground/10">
        <div className="flex items-center gap-1.5">
          <MicButton />
          <CameraButton />
          <ScreenShareButton />
          <DeviceMenu />
        </div>
        <div className="flex-1" />
        <LeaveButton />
      </div>
    </div>
  );
}
