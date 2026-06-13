import {
  DisconnectButton,
  LiveKitRoom,
  RoomAudioRenderer,
  useConnectionState,
  useLocalParticipant,
  useParticipants,
  useTracks,
} from "@livekit/components-react";
import { ConnectionState, Track } from "livekit-client";
import { Headphones, Loader2, Mic, MicOff, PhoneOff } from "lucide-react";
import { useCallback } from "react";

import "@livekit/components-styles";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAuthor } from "@/hooks/useAuthor";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { pubkeyFromLivekitIdentity, useLivekitToken } from "@/hooks/useLivekit";
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

/** In-call controls + live participant avatars (inside LiveKitRoom context). */
function InCallView() {
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

  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <Headphones className="size-4 text-success shrink-0" />
      <div className="flex -space-x-1.5 flex-1 min-w-0 overflow-hidden">
        {participants.map((p) => (
          <ParticipantAvatar
            key={p.identity}
            pubkey={pubkeyFromLivekitIdentity(p.identity)}
            isSpeaking={speaking.has(p.identity)}
          />
        ))}
      </div>
      <Button
        variant={localParticipant.isMicrophoneEnabled ? "default" : "outline"}
        size="icon"
        className="size-8"
        aria-label={localParticipant.isMicrophoneEnabled ? "Mute microphone" : "Unmute microphone"}
        onClick={() => localParticipant.setMicrophoneEnabled(!localParticipant.isMicrophoneEnabled)}
      >
        {localParticipant.isMicrophoneEnabled ? <Mic className="size-3.5" /> : <MicOff className="size-3.5" />}
      </Button>
      <DisconnectButton className="inline-flex items-center justify-center rounded-md size-8 bg-destructive text-destructive-foreground hover:bg-destructive/90">
        <PhoneOff className="size-3.5" />
      </DisconnectButton>
    </div>
  );
}

interface VoiceBarProps {
  relayUrl: string;
  groupId: string;
  /** Whether the local user wants to be in the call. Controlled by the parent. */
  active: boolean;
  /** Called when the call ends (disconnect / error back). */
  onLeave: () => void;
}

/**
 * Active voice call bar for a NIP-29 group with the `livekit` tag.
 *
 * Renders nothing unless `active` is true. When active, it fetches a LiveKit
 * JWT from the relay's NIP-29 token endpoint (NIP-98 signed) and connects
 * audio-only. The "Join voice" affordance lives in the channel header.
 */
export function VoiceBar({ relayUrl, groupId, active, onLeave }: VoiceBarProps) {
  const { user } = useCurrentUser();
  const { data: tokenData, error: tokenError, isLoading } = useLivekitToken(relayUrl, groupId, active);

  const handleDisconnected = useCallback(() => onLeave(), [onLeave]);

  if (!user || !active) return null;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 px-3 py-2 border-b bg-muted/30 min-h-12">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
        <span className="text-sm text-muted-foreground">Requesting voice access…</span>
      </div>
    );
  }

  if (tokenError || !tokenData) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/30 min-h-12">
        <span className="text-sm text-destructive flex-1">
          Could not join voice{tokenError instanceof Error ? `: ${tokenError.message}` : "."}
        </span>
        <Button className="h-8 px-3 text-sm" variant="outline" onClick={onLeave}>
          Back
        </Button>
      </div>
    );
  }

  return (
    <div className="border-b bg-muted/30">
      <LiveKitRoom
        serverUrl={tokenData.url}
        token={tokenData.token}
        connect
        audio
        video={false}
        onDisconnected={handleDisconnected}
        data-lk-theme="default"
      >
        <RoomAudioRenderer />
        <InCallView />
      </LiveKitRoom>
    </div>
  );
}
