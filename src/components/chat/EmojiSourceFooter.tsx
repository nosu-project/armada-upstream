import { Check, Loader2, Plus } from "lucide-react";
import { useCallback, useState } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useAddEmojiPack, useHasEmojiPack } from "@/hooks/useEmojiPacks";
import { useEmojiSource } from "@/hooks/useEmojiSource";
import { toast } from "@/hooks/useToast";

/**
 * Which NIP-30 pack a custom emoji came from, plus one-tap add. An unknown pack
 * is looked up over `authorPubkey`'s relays (skeleton meanwhile); renders
 * nothing if unresolved, since emoji tags carry no pack reference.
 */
export function EmojiSourceFooter({ url, authorPubkey }: { url: string; authorPubkey?: string }) {
  const { user } = useCurrentUser();
  const { source, isLoading } = useEmojiSource(url, authorPubkey);
  const alreadyAdded = useHasEmojiPack(source?.coord);
  const { mutateAsync: addPack, isPending } = useAddEmojiPack();
  // Flip instantly on success (mirrors EmojiPackCard).
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
    // Mirror the resolved layout so the popover doesn't jump.
    return (
      <div className="flex items-center gap-2 border-t border-border/60 px-3 py-2">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="text-3xs uppercase tracking-wide text-muted-foreground">From</div>
          <Skeleton className="h-3 w-24" />
        </div>
        <Skeleton className="h-7 w-14 shrink-0 clip-corner-lg touch:h-11" />
      </div>
    );
  }
  const isAdded = justAdded || alreadyAdded;

  return (
    <div className="flex items-center gap-2 border-t border-border/60 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-3xs uppercase tracking-wide text-muted-foreground">From</div>
        <div className="truncate text-xs font-medium">{source.name}</div>
      </div>
      {isAdded ? (
        <span className="flex shrink-0 items-center gap-1 text-2xs text-muted-foreground">
          <Check className="size-3" /> Added
        </span>
      ) : (
        <Button
          size="sm"
          variant="secondary"
          className="h-7 touch:h-11 shrink-0 clip-corner-lg px-2 text-xs"
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
