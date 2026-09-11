import { Check, Loader2, Plus } from "lucide-react";
import { useCallback, useState } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useAddEmojiPack, useHasEmojiPack } from "@/hooks/useEmojiPacks";
import { useEmojiSource } from "@/hooks/useEmojiSource";
import { toast } from "@/hooks/useToast";

/**
 * Attribution footer for a custom emoji: which NIP-30 pack it came from, plus a
 * one-tap add so seeing an emoji you like — as a reaction or inline in a
 * message — is enough to get it.
 *
 * While the author-scoped relay lookup is in flight it shows a skeleton rather
 * than an empty gap — that lookup is several relay round-trips, so the answer
 * can arrive a beat after the popover opens. Renders nothing only once it
 * settles with no pack — a reaction tag (and an inline `emoji` tag) carries only
 * `[emoji, code, url]`, so a pack we've never seen stays unnamed rather than
 * being guessed at. When `authorPubkey` (who typed the message / left the
 * reaction) is known, an unknown pack is chased down over THAT author's own
 * relays before giving up.
 */
export function EmojiSourceFooter({ url, authorPubkey }: { url: string; authorPubkey?: string }) {
  const { user } = useCurrentUser();
  const { source, isLoading } = useEmojiSource(url, authorPubkey);
  const alreadyAdded = useHasEmojiPack(source?.coord);
  const { mutateAsync: addPack, isPending } = useAddEmojiPack();
  // Flip the button the moment the publish lands, rather than waiting for the
  // list re-read to settle (mirrors EmojiPackCard).
  const [justAdded, setJustAdded] = useState(false);

  const onAdd = useCallback(async () => {
    if (!source) return;
    if (!user) {
      toast({ title: "Sign in to add emoji packs" });
      return;
    }
    try {
      await addPack({ pubkey: source.pubkey, identifier: source.identifier });
      setJustAdded(true);
      toast({ title: "Emoji pack added", description: source.name });
    } catch (e) {
      toast({
        title: "Couldn't add pack",
        description: e instanceof Error ? e.message : "Publishing failed.",
        variant: "destructive",
      });
    }
  }, [addPack, source, user]);

  if (!source) {
    if (!isLoading) return null;
    // Author-scoped lookup in flight — mirror the resolved footer's layout so
    // the popover doesn't jump when the name lands.
    return (
      <div className="flex items-center gap-2 border-t border-border/60 px-3 py-2">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">From</div>
          <Skeleton className="h-3 w-24" />
        </div>
        <Skeleton className="h-7 w-14 shrink-0 rounded-lg touch:h-9" />
      </div>
    );
  }
  const isAdded = justAdded || alreadyAdded;

  return (
    <div className="flex items-center gap-2 border-t border-border/60 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">From</div>
        <div className="truncate text-xs font-medium">{source.name}</div>
      </div>
      {isAdded ? (
        <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
          <Check className="size-3" /> Added
        </span>
      ) : (
        <Button
          size="sm"
          variant="secondary"
          className="h-7 touch:h-9 shrink-0 rounded-lg px-2 text-xs"
          onClick={onAdd}
          disabled={isPending}
        >
          {isPending ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3" />}
          Add
        </Button>
      )}
    </div>
  );
}
