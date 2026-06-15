import { Check, Copy, Link2, Loader2, PartyPopper, RefreshCw, Share2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useGroupModeration } from "@/hooks/useGroupModeration";
import { toast } from "@/hooks/useToast";
import { relayToRouteParam } from "@/lib/platform";

import type { Nip29Group } from "@/lib/nip29";

interface InvitePeopleDialogProps {
  relayUrl: string;
  group: Nip29Group;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function randomInviteCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Build the shareable join URL for a group + invite code. */
function buildInviteUrl(relayUrl: string, groupId: string, code: string): string {
  const path = `/s/${relayToRouteParam(relayUrl)}/${encodeURIComponent(groupId)}?code=${encodeURIComponent(code)}`;
  return `${window.location.origin}${path}`;
}

/**
 * A delightfully simple invite flow: opening the dialog mints a fresh invite
 * code (kind 9009) and builds a shareable link. One click copies or shares it.
 */
export function InvitePeopleDialog({ relayUrl, group, open, onOpenChange }: InvitePeopleDialogProps) {
  const { createInvite } = useGroupModeration(relayUrl, group.id);
  const [url, setUrl] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);

  const generate = useCallback(async () => {
    setError(false);
    const newCode = randomInviteCode();
    try {
      await createInvite.mutateAsync({ code: newCode });
      setCode(newCode);
      setUrl(buildInviteUrl(relayUrl, group.id, newCode));
    } catch {
      setError(true);
    }
  }, [createInvite, relayUrl, group.id]);

  // Mint an invite as soon as the dialog opens (the silly-easy part).
  useEffect(() => {
    if (open) {
      setUrl(null);
      setCode(null);
      setCopied(false);
      setError(false);
      void generate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const copy = () => {
    if (!url) return;
    navigator.clipboard?.writeText(url).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      },
      () => toast({ title: "Copy failed", variant: "destructive" }),
    );
  };

  const share = () => {
    if (!url) return;
    navigator.share?.({
      title: `Join #${group.name} on Armada`,
      text: `You're invited to #${group.name}!`,
      url,
    }).catch(() => undefined);
  };

  const canShare = typeof navigator !== "undefined" && "share" in navigator;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md p-0 gap-0 overflow-hidden" aria-describedby={undefined}>
        <DialogHeader className="items-center text-center gap-2 px-6 pt-6 pb-5 bg-gradient-to-b from-primary/10 to-transparent">
          <div className="flex size-12 items-center justify-center rounded-2xl bg-primary/15 text-primary">
            <PartyPopper className="size-6" />
          </div>
          <DialogTitle className="text-lg max-w-full truncate">Invite people to #{group.name}</DialogTitle>
          <p className="text-sm text-muted-foreground">
            Share this link and anyone who opens it joins instantly.
          </p>
        </DialogHeader>

        <div className="px-6 pb-6 space-y-4 min-w-0">
          {error ? (
            <div className="text-center space-y-3 py-2">
              <p className="text-sm text-muted-foreground">Couldn&apos;t create an invite link.</p>
              <Button variant="outline" onClick={generate}>
                <RefreshCw className="size-4 mr-2" /> Try again
              </Button>
            </div>
          ) : !url ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Creating your invite link…
            </div>
          ) : (
            <>
              {/* The link, front and center. */}
              <button
                type="button"
                onClick={copy}
                className="group w-full min-w-0 max-w-full overflow-hidden flex items-center gap-2 rounded-xl border border-border bg-secondary/40 px-3 py-3 text-left transition-colors hover:border-primary/50 hover:bg-secondary/70"
              >
                <Link2 className="size-4 shrink-0 text-muted-foreground" />
                <span className="flex-1 min-w-0 truncate font-mono text-sm">{url}</span>
                {copied
                  ? <Check className="size-4 shrink-0 text-primary" />
                  : <Copy className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground" />}
              </button>

              <div className="flex gap-2">
                <Button className="flex-1" onClick={copy}>
                  {copied
                    ? <><Check className="size-4 mr-2" /> Copied!</>
                    : <><Copy className="size-4 mr-2" /> Copy link</>}
                </Button>
                {canShare && (
                  <Button variant="outline" onClick={share} aria-label="Share">
                    <Share2 className="size-4" />
                  </Button>
                )}
              </div>

              <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
                <span>Invite code:</span>
                <code className="font-mono text-foreground">{code}</code>
                <button
                  type="button"
                  className="hover:text-foreground inline-flex items-center gap-1"
                  onClick={generate}
                  disabled={createInvite.isPending}
                >
                  <RefreshCw className={createInvite.isPending ? "size-3 animate-spin" : "size-3"} />
                  New
                </button>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
