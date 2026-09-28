import { UserPlus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useFollowToggle } from "@/hooks/useFollowToggle";
import { cn } from "@/lib/utils";

interface FollowButtonProps {
  pubkey: string;
  className?: string;
  size?: "default" | "sm" | "lg" | "icon";
}

/** Follow button (from Ditto). Follow-only; hidden for self, logged-out, or already following. */
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
