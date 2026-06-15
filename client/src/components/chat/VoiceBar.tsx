import {
  DisconnectButton,
  useConnectionState,
  useLocalParticipant,
  useParticipants,
  useTracks,
} from "@livekit/components-react";
import { ConnectionState, Track } from "livekit-client";
import { Headphones, Loader2, Mic, MicOff, PhoneOff } from "lucide-react";

import "@livekit/components-styles";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAuthor } from "@/hooks/useAuthor";
import { pubkeyFromLivekitIdentity } from "@/hooks/useLivekit";
import { getAvatarShape } from "@/lib/avatarShape";
import { getDisplayName } from "@/lib/getDisplayName";
import { cn } from "@/lib/utils";

function ParticipantAvatar({ pubkey, isSpeaking }: { pubkey: string; isSpeaking?: boolean }) {
  const author = useAuthor(pubkey);
  const metadata = author.data?.metadata;
  const displayName = getDisplayName(metadata, pubkey);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Avatar
          shape={getAvatarShape(metadata)}
          className={cn(
            "size-7 ring-2 ring-background transition-shadow",
            isSpeaking && "ring-success shadow-[0_0_0_2px_hsl(var(--success))]",
          )}
        >
          <AvatarImage src={metadata?.picture} alt={displayName} />
          <AvatarFallback className="bg-primary/20 text-primary text-[10px]">
            {displayName[0]?.toUpperCase()}
          </AvatarFallback>
        </Avatar>
      </TooltipTrigger>
      <TooltipContent>{displayName}</TooltipContent>
    </Tooltip>
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
  const connectionState = useConnectionState();
  const { localParticipant } = useLocalParticipant();
  const micTracks = useTracks([Track.Source.Microphone], { onlySubscribed: false });

  const speaking = new Set(
    micTracks.filter((t) => t.participant.isSpeaking).map((t) => t.participant.identity),
  );

  if (connectionState === ConnectionState.Connecting) {
    return (
      <div className="flex items-center justify-center gap-2 px-3 py-2 min-h-12">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
        <span className="text-sm text-muted-foreground">Connecting to voice…</span>
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
    <div className="flex -space-x-1.5 flex-1 min-w-0 overflow-hidden">
      {participants.map((p) => (
        <ParticipantAvatar
          key={p.identity}
          pubkey={pubkeyFromLivekitIdentity(p.identity)}
          isSpeaking={speaking.has(p.identity)}
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
      onClick={() => localParticipant.setMicrophoneEnabled(!localParticipant.isMicrophoneEnabled)}
    >
      {localParticipant.isMicrophoneEnabled ? <Mic className="size-3.5" /> : <MicOff className="size-3.5" />}
    </Button>
  );

  const hangupBtn = (
    <DisconnectButton className="inline-flex items-center justify-center rounded-md size-8 shrink-0 bg-destructive text-destructive-foreground hover:bg-destructive/90">
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
      {hangupBtn}
    </div>
  );
}
