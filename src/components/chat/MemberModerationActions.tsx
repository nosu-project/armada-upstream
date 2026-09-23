import { Button } from "@/components/ui/button";
import { useMemberActions } from "@/hooks/useMemberActions";
import { cn } from "@/lib/utils";

/**
 * The moderation footer of a person surface: what the viewer may do to this
 * member, right where they clicked them.
 *
 * Renders nothing at all for the overwhelming majority of viewers — anyone
 * who isn't staff, and staff looking at someone they don't outrank — so the
 * card it sits in is unchanged for them. Staff get the actions without having
 * to find the person a second time in the member list, which is the whole
 * point of it living here rather than only on a roster row.
 *
 * Buttons rather than another overflow menu: on a touch device the person is
 * already two taps away (avatar, then the action), and a third tap into a
 * 32px `⋯` inside a popover is exactly the friction this is meant to remove.
 * They are safe to surface that directly because every destructive one opens
 * a confirmation dialog rather than acting on click — see the provider.
 */
export function MemberModerationActions({
  pubkey,
  onAction,
  className,
}: {
  pubkey: string;
  /** Called before the action runs, e.g. to close the surrounding popover. */
  onAction?: () => void;
  className?: string;
}) {
  const actions = useMemberActions(pubkey);
  if (actions.length === 0) return null;

  return (
    <div className={cn("border-t border-border/60 pt-3", className)}>
      <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/80">
        Moderation
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {actions.map((action) => (
          <Button
            key={action.id}
            size="sm"
            variant="outline"
            // Grows to the touch minimum rather than matching the card's other
            // h-8 rows: these are the actions where a mis-tap costs something.
            className={cn(
              "h-9 min-w-24 flex-1 clip-corner-lg touch:h-11",
              action.destructive &&
                "border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive",
            )}
            onClick={() => {
              onAction?.();
              action.onSelect();
            }}
          >
            <action.icon className="size-3.5 mr-1.5" />
            <span className="truncate">{action.label}</span>
          </Button>
        ))}
      </div>
    </div>
  );
}
