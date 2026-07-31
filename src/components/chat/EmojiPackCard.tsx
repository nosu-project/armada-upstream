import { Loader2, Plus, Smile, Trash2 } from "lucide-react";
import { useState } from "react";

import { DisplayName } from "@/components/DisplayName";
import { CustomEmojiImg } from "@/components/chat/CustomEmoji";
import { ProfilePreviewCard } from "@/components/chat/ProfilePreviewCard";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  emojiPackAbout,
  emojiPackEntries,
  emojiPackName,
  emojiPackPicture,
  useAddEmojiPack,
  useHasEmojiPack,
  useRemoveEmojiPack,
} from "@/hooks/useEmojiPacks";
import { useAuthor } from "@/hooks/useAuthor";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { toast } from "@/hooks/useToast";
import { getAvatarShape } from "@/lib/avatarShape";
import { getDisplayName } from "@/lib/getDisplayName";
import { cn } from "@/lib/utils";

import type { NostrRumor } from "@/lib/nostrRumor";

/** How many emojis to show in the preview grid before "+N more". */
const PREVIEW_LIMIT = 16;

interface EmojiPackCardProps {
  /** The kind-30030 emoji set event. */
  event: NostrRumor;
  className?: string;
}

/**
 * Discord/Ditto-style preview card for a NIP-30 emoji pack (kind 30030) posted
 * in chat: the pack name + author, a grid preview of its emojis, and a one-tap
 * "Add" button that appends it to the viewer's kind-10030 emoji list.
 */
export function EmojiPackCard({ event, className }: EmojiPackCardProps) {
  const { user } = useCurrentUser();
  const author = useAuthor(event.pubkey);
  const metadata = author.data?.metadata;
  const displayName = getDisplayName(metadata, event.pubkey);

  const name = emojiPackName(event);
  const about = emojiPackAbout(event);
  const picture = emojiPackPicture(event);
  const identifier = event.tags.find((t) => t[0] === "d")?.[1] ?? "";
  const entries = emojiPackEntries(event);

  const coord = `30030:${event.pubkey}:${identifier}`;
  const alreadyAdded = useHasEmojiPack(coord);
  const { mutateAsync: addPack, isPending: isAdding } = useAddEmojiPack();
  const { mutateAsync: removePack, isPending: isRemoving } = useRemoveEmojiPack();
  // Local override of the read-back state so the button flips instantly on a
  // successful add/remove without waiting for the list re-read to settle.
  const [override, setOverride] = useState<"added" | "removed" | null>(null);

  const visible = entries.slice(0, PREVIEW_LIMIT);
  const extra = entries.length - visible.length;

  const onAdd = async () => {
    if (!user) {
      toast({ title: "Sign in to add emoji packs" });
      return;
    }
    try {
      await addPack({ pubkey: event.pubkey, identifier });
      setOverride("added");
      toast({ title: "Emoji pack added", description: name });
    } catch (e) {
      toast({
        title: "Couldn't add pack",
        description: e instanceof Error ? e.message : "Publishing failed.",
        variant: "destructive",
      });
    }
  };

  const onRemove = async () => {
    try {
      await removePack({ coord });
      setOverride("removed");
      toast({ title: "Emoji pack removed", description: name });
    } catch (e) {
      toast({
        title: "Couldn't remove pack",
        description: e instanceof Error ? e.message : "Publishing failed.",
        variant: "destructive",
      });
    }
  };

  const isAdded = override ? override === "added" : alreadyAdded;

  return (
    <div
      className={cn(
        "flex flex-col max-w-sm w-full rounded-xl border border-border/60 bg-card overflow-hidden my-1.5",
        className,
      )}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="px-3.5 py-3 flex flex-col flex-1 gap-2.5">
        {/* Header: pack icon + name + author */}
        <div className="flex items-center gap-2 min-w-0">
          {picture ? (
            <img
              src={picture}
              alt=""
              className="size-8 shrink-0 rounded-md object-cover border border-border/60"
            />
          ) : (
            <Smile className="size-4 shrink-0 text-primary" />
          )}
          <p className="font-semibold truncate leading-tight flex-1">{name}</p>
          {/* Legible while scanning a Discover grid, where the Add button at
              the card's foot is the only other signal. */}
          <span
            className={cn(
              "text-[10px] px-1.5 py-px rounded-full shrink-0",
              isAdded ? "bg-success/15 text-success" : "bg-secondary text-muted-foreground",
            )}
          >
            {isAdded ? "Added" : "Emoji pack"}
          </span>
        </div>

        {about && (
          <p className="text-xs text-muted-foreground line-clamp-2 -mt-1">{about}</p>
        )}

        <ProfilePreviewCard pubkey={event.pubkey}>
          <button
            type="button"
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground min-w-0"
            onClick={(e) => e.stopPropagation()}
          >
            <Avatar shape={getAvatarShape(metadata)} className="size-4 shrink-0">
              <AvatarImage src={metadata?.picture} alt={displayName} />
              <AvatarFallback className="bg-primary/20 text-primary text-[8px]">
                {displayName[0]?.toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <span className="truncate">
              by <DisplayName pubkey={event.pubkey} name={displayName} />
            </span>
          </button>
        </ProfilePreviewCard>

        {/* Emoji preview grid */}
        {visible.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {visible.map((e) => (
              <CustomEmojiImg
                key={e.shortcode}
                name={e.shortcode}
                url={e.url}
                className="h-7 w-7 object-contain"
              />
            ))}
            {extra > 0 && (
              <span className="flex h-7 min-w-7 items-center justify-center rounded px-1 text-xs font-medium text-muted-foreground">
                +{extra}
              </span>
            )}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">This pack has no emojis.</p>
        )}

        {/* Add / Remove button — pinned to the card bottom so cards align in a
            grid. Added packs offer a one-tap remove instead of a dead "Added". */}
        {isAdded ? (
          <Button
            variant="ghost"
            className="mt-auto w-full clip-corner-lg hover:text-destructive"
            onClick={onRemove}
            disabled={isRemoving}
          >
            {isRemoving ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Removing…
              </>
            ) : (
              <>
                <Trash2 className="size-4" />
                Remove
              </>
            )}
          </Button>
        ) : (
          <Button
            className="mt-auto w-full clip-corner-lg"
            onClick={onAdd}
            disabled={isAdding || entries.length === 0}
          >
            {isAdding ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Adding…
              </>
            ) : (
              <>
                <Plus className="size-4" />
                Add {entries.length > 0 ? `${entries.length} emoji${entries.length === 1 ? "" : "s"}` : "pack"}
              </>
            )}
          </Button>
        )}
      </div>
    </div>
  );
}
