import { Hand, Headphones, MicOff, ScreenShare } from "lucide-react";
import type { CSSProperties } from "react";

import { DisplayName } from "@/components/DisplayName";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { VoiceUserContextMenu, VoiceUserMenuButton } from "@/components/VoiceUserContextMenu";
import { useAuthor } from "@/hooks/useAuthor";
import { useCall } from "@/hooks/useCall";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { getAvatarShape, shapedAvatarSpeakingStyle } from "@/lib/avatarShape";
import { getDisplayName } from "@/lib/getDisplayName";
import { cn } from "@/lib/utils";

function ParticipantAvatar({ pubkey, className }: { pubkey: string; className?: string }) {
  const author = useAuthor(pubkey);
  const metadata = author.data?.metadata;
  const name = getDisplayName(metadata, pubkey);
  return (
    <Avatar
      shape={getAvatarShape(metadata)}
      className={cn("size-5 ring-2 ring-chrome", className)}
    >
      <AvatarImage src={metadata?.picture} imeta={author.data?.imeta?.picture} alt={name} />
      <AvatarFallback className="bg-success/20 text-success text-monogram">
        {name[0]?.toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
}

function ParticipantName({ pubkey }: { pubkey: string }) {
  return (
    <div className="truncate">
      <DisplayName pubkey={pubkey} />
    </div>
  );
}

/** The person is screen sharing; with `onWatch`, a button that tunes into the stream. */
export function LiveBadge({ onWatch, className }: { onWatch?: () => void; className?: string }) {
  const cls = cn(
    "shrink-0 inline-flex items-center gap-1 rounded-sm bg-destructive px-1.5 h-4 text-3xs font-bold tracking-wide text-destructive-foreground",
    className,
  );
  const content = (
    <>
      <ScreenShare className="size-3" aria-hidden />
      LIVE
    </>
  );
  if (!onWatch) {
    return (
      <span className={cls} aria-label="Streaming">
        {content}
      </span>
    );
  }
  return (
    <button
      type="button"
      // Rows and tiles have their own click/context-menu behaviour.
      onClick={(e) => {
        e.stopPropagation();
        onWatch();
      }}
      aria-label="Watch stream"
      title="Watch stream"
      className={cn(cls, "cursor-pointer hover:bg-destructive/85 touch:h-6 touch:px-2")}
    >
      {content}
    </button>
  );
}

/** Only streaming rows reach for the call context. */
function WatchableLiveBadge({ pubkey }: { pubkey: string }) {
  const { watchStream } = useCall();
  return <LiveBadge onWatch={() => watchStream(pubkey)} />;
}

/** Nested voice roster rows under a channel in the sidebar; `speaking` lights rows when in the call. */
export function VoiceParticipantList({
  participants,
  speaking,
  muted,
  streaming,
  raised,
  className,
}: {
  participants: readonly string[];
  speaking?: ReadonlySet<string>;
  muted?: ReadonlySet<string>;
  /** Pubkeys screen sharing (only known while in the call). */
  streaming?: ReadonlySet<string>;
  /** Pubkeys with a raised hand (Armada client feature; Concord calls only). */
  raised?: ReadonlySet<string>;
  className?: string;
}) {
  if (participants.length === 0) return null;
  // Sort so rows don't reshuffle as presence/LiveKit events land.
  const sorted = [...participants].sort();
  return (
    <div className={cn("flex flex-col pb-0.5", className)} aria-label={`${participants.length} in voice`}>
      {sorted.map((pk) => (
        <VoiceParticipantRow
          key={pk}
          pubkey={pk}
          isSpeaking={speaking?.has(pk) ?? false}
          isMuted={muted?.has(pk) ?? false}
          isStreaming={streaming?.has(pk) ?? false}
          isRaised={raised?.has(pk) ?? false}
        />
      ))}
    </div>
  );
}

/** One roster row. Right-click or the "⋮" button opens the voice user menu. */
function VoiceParticipantRow({
  pubkey,
  isSpeaking,
  isMuted,
  isStreaming,
  isRaised,
}: {
  pubkey: string;
  isSpeaking?: boolean;
  isMuted?: boolean;
  isStreaming?: boolean;
  isRaised?: boolean;
}) {
  const author = useAuthor(pubkey);
  const { user } = useCurrentUser();
  const metadata = author.data?.metadata;
  const name = getDisplayName(metadata, pubkey);
  const hasCustomShape = !!getAvatarShape(metadata);
  const isSelf = user?.pubkey === pubkey;

  // Emoji-shaped avatars have a mask that clips rings, so use a drop-shadow filter.
  const wrapperStyle: CSSProperties | undefined =
    hasCustomShape && isSpeaking ? { filter: shapedAvatarSpeakingStyle.filter } : undefined;

  return (
    <VoiceUserContextMenu pubkey={pubkey} displayName={name} showVolume={!isSelf}>
      <div className="group/voicerow flex items-center gap-2 pl-7 pr-1 py-1 text-sm text-muted-foreground">
        <div
          className={cn(
            "rounded-full shrink-0 transition-shadow",
            !hasCustomShape && isSpeaking && "ring-2 ring-success",
          )}
          style={wrapperStyle}
        >
          <Avatar shape={getAvatarShape(metadata)} className="size-6">
            <AvatarImage src={metadata?.picture} imeta={author.data?.imeta?.picture} alt={name} />
            <AvatarFallback className="bg-success/20 text-success text-3xs">
              {name[0]?.toUpperCase()}
            </AvatarFallback>
          </Avatar>
        </div>
        <span className={cn("truncate flex-1 min-w-0", isSpeaking && "text-success")}>
          <DisplayName pubkey={pubkey} name={name} />
        </span>
        {isStreaming && (isSelf ? <LiveBadge /> : <WatchableLiveBadge pubkey={pubkey} />)}
        {isRaised && (
          <Hand
            className="size-3.5 shrink-0 text-warning"
            aria-label="Hand raised"
          />
        )}
        {isMuted && (
          <MicOff
            className="size-3.5 shrink-0 text-destructive"
            aria-label="Muted"
          />
        )}
        {/* Hover-revealed on pointer devices, always visible on touch. */}
        <VoiceUserMenuButton
          pubkey={pubkey}
          displayName={name}
          showVolume={!isSelf}
          className="size-6 touch:size-8 opacity-0 group-hover/voicerow:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 touch:opacity-100 transition-opacity"
        />
      </div>
    </VoiceUserContextMenu>
  );
}

/** Overlapping avatar stack with "+N" overflow and a names tooltip. */
export function VoicePresence({
  participants,
  max = 3,
  className,
}: {
  participants: readonly string[];
  max?: number;
  className?: string;
}) {
  if (participants.length === 0) return null;
  const shown = participants.slice(0, max);
  const overflow = participants.length - shown.length;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn("flex items-center shrink-0 text-success", className)}
          aria-label={`${participants.length} in voice`}
        >
          <Headphones className="size-3.5 mr-1" />
          <span className="flex -space-x-1.5">
            {shown.map((pk) => (
              <ParticipantAvatar key={pk} pubkey={pk} />
            ))}
            {overflow > 0 && (
              <span className="flex items-center justify-center size-5 rounded-full ring-2 ring-chrome bg-success/20 text-success text-monogram font-semibold tabular-nums">
                +{overflow}
              </span>
            )}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-48">
        <div className="text-xs font-semibold mb-0.5">
          {participants.length} in voice
        </div>
        {participants.map((pk) => (
          <ParticipantName key={pk} pubkey={pk} />
        ))}
      </TooltipContent>
    </Tooltip>
  );
}
