import { Inbox, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useDmInboxSetup } from "@/hooks/useDmInboxSetup";
import { useToast } from "@/hooks/useToast";
import { cn } from "@/lib/utils";

/**
 * One-tap kind 10050 setup for an account that has none. `dismissible` is the
 * DM list's variant; Settings always shows it while the list is missing.
 */
export function DmInboxNotice({ dismissible = false, className }: { dismissible?: boolean; className?: string }) {
  const { missing, dismissed, publishing, publish, dismiss } = useDmInboxSetup();
  const { toast } = useToast();

  if (!missing || (dismissible && dismissed)) return null;

  const onPublish = () => {
    publish().then(() => {
      toast({ title: "Other apps can message you now" });
    }).catch((err) => {
      toast({
        title: "Couldn't set up your inbox",
        description: err instanceof Error ? err.message : "Please try again.",
        variant: "destructive",
      });
    });
  };

  return (
    <div
      className={cn(
        "clip-hairline-lg [--fill:var(--muted)/0.4] [--fill-hover:var(--muted)/0.4] px-4 py-3 text-sm",
        className,
      )}
    >
      <div className="flex items-start gap-2.5">
        <Inbox className="size-4 mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-muted-foreground">
            People using other Nostr apps can't message you yet.
          </p>
          <Button size="sm" className="clip-corner-lg touch:h-11" disabled={publishing} onClick={onPublish}>
            {publishing ? "Setting up…" : "Let them message me"}
          </Button>
        </div>
        {dismissible && (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Dismiss"
            className="size-7 touch:size-11 -mr-2 -mt-1 shrink-0 text-muted-foreground"
            onClick={dismiss}
          >
            <X className="size-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
