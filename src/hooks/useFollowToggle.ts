import { useCallback, useMemo } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useFollowActions } from "@/hooks/useFollowActions";
import { useFollowList } from "@/hooks/useFollowList";
import { toast } from "@/hooks/useToast";
import { impact } from "@/lib/haptics";

/** Shared by `FollowButton` and the profile card's unfollow menu entry. */
export function useFollowToggle(pubkey: string) {
  const { user } = useCurrentUser();
  const { data: followData } = useFollowList();
  const { isPending, follow, unfollow } = useFollowActions();

  const isFollowing = useMemo(() => {
    if (!followData?.pubkeys) return false;
    return followData.pubkeys.includes(pubkey);
  }, [pubkey, followData]);

  const canToggle = !!user && user.pubkey !== pubkey;

  const toggle = useCallback(async (e?: React.MouseEvent) => {
    e?.preventDefault();
    e?.stopPropagation();
    if (!user) return;

    try {
      if (isFollowing) {
        await unfollow(pubkey);
        impact("medium");
        toast({ title: "Unfollowed" });
      } else {
        await follow(pubkey);
        impact("medium");
        toast({ title: "Followed" });
      }
    } catch (err) {
      console.error("Follow toggle failed:", err);
      toast({
        title: "Failed to update follow list",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    }
  }, [user, pubkey, isFollowing, follow, unfollow]);

  return { canToggle, isFollowing, isPending, toggle };
}
