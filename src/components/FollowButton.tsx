import { UserPlus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useFollowToggle } from "@/hooks/useFollowToggle";
import { cn } from "@/lib/utils";

interface FollowButtonProps {
  /** The pubkey of the user to follow/unfollow. */
  pubkey: string;
  /** Optional class name overrides. */
  className?: string;
  /** Button size variant. Defaults to "sm". */
  size?: "default" | "sm" | "lg" | "icon";
}

/**
 * Reusable follow button. Ported from Ditto.
 *
 * Renders only the positive (follow) action — the same style as the card's
 * Mention button. Unfollow is a negative action and lives behind the profile
 * card's overflow menu. Hides itself for self, when logged out, or when the
 * user is already following.
 */
export function FollowButton({ pubkey, className, size = "sm" }: FollowButtonProps) {
  const { canToggle, isFollowing, isPending, toggle } = useFollowToggle(pubkey);

  if (!canToggle || isFollowing) return null;

  return (
    <Button
      type="button"
      size={size}
      variant="secondary"
      className={cn("clip-corner-lg", className)}
      onClick={toggle}
      disabled={isPending}
    >
      <UserPlus className="size-3.5 mr-1.5" />
      {isPending ? "…" : "Follow"}
    </Button>
  );
}
