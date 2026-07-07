import { Headphones } from "lucide-react";
import type { CSSProperties } from "react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAuthor } from "@/hooks/useAuthor";
import { getAvatarShape, shapedAvatarSpeakingStyle } from "@/lib/avatarShape";
import { getDisplayName } from "@/lib/getDisplayName";
import { cn } from "@/lib/utils";

/** A single participant's avatar in the voice presence stack. */
function ParticipantAvatar({ pubkey, className }: { pubkey: string; className?: string }) {
  const author = useAuthor(pubkey);
  const metadata = author.data?.metadata;
  const name = getDisplayName(metadata, pubkey);
  return (
    <Avatar
      shape={getAvatarShape(metadata)}
      className={cn("size-5 ring-2 ring-chrome", className)}
    >
      <AvatarImage src={metadata?.picture} alt={name} />
      <AvatarFallback className="bg-success/20 text-success text-[9px]">
        {name[0]?.toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
}

/** A participant's display name (for the tooltip listing). */
function ParticipantName({ pubkey }: { pubkey: string }) {
  const author = useAuthor(pubkey);
  const name = getDisplayName(author.data?.metadata, pubkey);
  return <div className="truncate">{name}</div>;
}

/**
 * Discord-style nested voice roster: one indented row per participant (small
 * avatar + name), rendered directly under a channel's row in the sidebar so a
 * live call reads as a first-class voice channel. When the viewer is in this
 * channel's call, `speaking` carries the live speaker set so rows light up
 * with voice activity.
 */
export function VoiceParticipantList({
  participants,
  speaking,
  className,
}: {
  participants: readonly string[];
  /** Pubkeys currently speaking (live, from the connected call), if known. */
  speaking?: ReadonlySet<string>;
  className?: string;
}) {
  if (participants.length === 0) return null;
  // Stable order: presence folds/LiveKit deliver participants in arrival (or
  // speaking) order, which reshuffles rows as events land. Sort by pubkey so
  // the roster holds still.
  const sorted = [...participants].sort();
  return (
    <div className={cn("flex flex-col pb-0.5", className)} aria-label={`${participants.length} in voice`}>
      {sorted.map((pk) => (
        <VoiceParticipantRow key={pk} pubkey={pk} isSpeaking={speaking?.has(pk) ?? false} />
      ))}
    </div>
  );
}

/** One row of the nested voice roster (green speaking ring while talking). */
function VoiceParticipantRow({ pubkey, isSpeaking }: { pubkey: string; isSpeaking?: boolean }) {
  const author = useAuthor(pubkey);
  const metadata = author.data?.metadata;
  const name = getDisplayName(metadata, pubkey);
  const hasCustomShape = !!getAvatarShape(metadata);

  // Emoji-shaped avatars carry a CSS mask that would clip a ring/box-shadow,
  // so their speaking indicator is a drop-shadow filter hugging the silhouette;
  // circular avatars get a plain ring (matches the call-stage treatment).
  const wrapperStyle: CSSProperties | undefined =
    hasCustomShape && isSpeaking ? { filter: shapedAvatarSpeakingStyle.filter } : undefined;

  return (
    <div className="flex items-center gap-2 pl-7 pr-2 py-1 text-sm text-muted-foreground">
      <div
        className={cn(
          "rounded-full shrink-0 transition-shadow",
          !hasCustomShape && isSpeaking && "ring-2 ring-success",
        )}
        style={wrapperStyle}
      >
        <Avatar shape={getAvatarShape(metadata)} className="size-6">
          <AvatarImage src={metadata?.picture} alt={name} />
          <AvatarFallback className="bg-success/20 text-success text-[10px]">
            {name[0]?.toUpperCase()}
          </AvatarFallback>
        </Avatar>
      </div>
      <span className={cn("truncate", isSpeaking && "text-success")}>{name}</span>
    </div>
  );
}

/**
 * Shows who is currently in a voice room: a small overlapping avatar stack
 * (capped, with a "+N" overflow) and a tooltip listing each participant by
 * name. Used in the channel list and DM list so you can see — and who is in —
 * an active call before joining.
 */
export function VoicePresence({
  participants,
  max = 3,
  className,
}: {
  participants: readonly string[];
  /** Max avatars to show before collapsing to a "+N" badge. */
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
              <span className="flex items-center justify-center size-5 rounded-full ring-2 ring-chrome bg-success/20 text-success text-[9px] font-semibold tabular-nums">
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
