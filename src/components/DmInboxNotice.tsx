import { Inbox, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useDmInboxSetup } from "@/hooks/useDmInboxSetup";
import { useToast } from "@/hooks/useToast";
import { FormattedMessage, t, useIntl } from "@/i18n";
import { cn } from "@/lib/utils";

/**
 * One-tap kind 10050 setup for an account that has none. `dismissible` is the
 * DM list's variant; Settings always shows it while the list is missing.
 */
export function DmInboxNotice({ dismissible = false, className }: { dismissible?: boolean; className?: string }) {
  const { missing, dismissed, publishing, publish, dismiss } = useDmInboxSetup();
  const { toast } = useToast();
  const intl = useIntl();

  if (!missing || (dismissible && dismissed)) return null;

  const onPublish = () => {
    publish().then(() => {
      toast({ title: t({ id: "dmInboxNotice.published", defaultMessage: "Other apps can message you now" }) });
    }).catch((err) => {
      toast({
        title: t({ id: "dmInboxNotice.failed", defaultMessage: "Couldn't set up your inbox" }),
        description: err instanceof Error ? err.message : t({ id: "dmInboxNotice.tryAgain", defaultMessage: "Please try again." }),
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
            <FormattedMessage
              id="dmInboxNotice.body"
              defaultMessage="People using other Nostr apps can't message you yet."
            />
          </p>
          <Button size="sm" className="clip-corner-lg touch:h-11" disabled={publishing} onClick={onPublish}>
            {publishing ? (
              <FormattedMessage id="dmInboxNotice.settingUp" defaultMessage="Setting up…" />
            ) : (
              <FormattedMessage id="dmInboxNotice.publish" defaultMessage="Let them message me" />
            )}
          </Button>
        </div>
        {dismissible && (
          <Button
            variant="ghost"
            size="icon"
            aria-label={intl.formatMessage({ id: "dmInboxNotice.dismiss", defaultMessage: "Dismiss" })}
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
