import { Check, Copy, Link2, Loader2, PartyPopper, RefreshCw, Share2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  ChromeDialogContent,
} from "@/components/ui/dialog";
import { useGroupModeration } from "@/hooks/useGroupModeration";
import { useRelayClaim } from "@/hooks/useRelayMembership";
import { toast } from "@/hooks/useToast";
import { writeClipboardText } from "@/lib/clipboard";
import { relayToRouteParam } from "@/lib/platform";
import { canShare, share as nativeShare } from "@/lib/share";
import { shareOrigin } from "@/lib/shareOrigin";

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
  return `${shareOrigin()}${path}`;
}

/**
 * A delightfully simple invite flow: opening the dialog mints a fresh invite
 * code (kind 9009) and builds a shareable link. One click copies or shares it.
 */
export function InvitePeopleDialog({ relayUrl, group, open, onOpenChange }: InvitePeopleDialogProps) {
  const { createInvite } = useGroupModeration(relayUrl, group.id);
  const { mutateAsync: fetchRelayClaim } = useRelayClaim();
  const [url, setUrl] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  const [generating, setGenerating] = useState(false);

  const generate = useCallback(async () => {
    setError(false);
    setGenerating(true);
    try {
      // On community relays that gate access at the relay level (zooid/Coracle),
      // the invite must be a relay-issued `claim` (kind 28935) so the recipient
      // can become a relay member. Prefer that claim when the relay issues one;
      // fall back to a self-minted NIP-29 group invite code (kind 9009) for
      // relays that scope invites per group (e.g. Armada's own relay).
      const relayClaim = await fetchRelayClaim(relayUrl);
      let inviteCode = relayClaim;
      if (!inviteCode) {
        inviteCode = randomInviteCode();
        await createInvite.mutateAsync({ code: inviteCode });
      }
      setCode(inviteCode);
      setUrl(buildInviteUrl(relayUrl, group.id, inviteCode));
    } catch {
      setError(true);
    } finally {
      setGenerating(false);
    }
  }, [createInvite, fetchRelayClaim, relayUrl, group.id]);

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
    writeClipboardText(url).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      },
      () => toast({ title: "Copy failed", variant: "destructive" }),
    );
  };

  const share = () => {
    if (!url) return;
    void nativeShare({
      title: `Join #${group.name} on Armada`,
      text: `You're invited to #${group.name}!`,
      url,
    });
  };

  const showShare = canShare();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ChromeDialogContent title={`Invite people to #${group.name}`}>
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="flex size-12 items-center justify-center clip-corner-lg bg-primary/15 text-primary">
            <PartyPopper className="size-6" />
          </div>
          <h2 className="chrome-dialog-title font-mono font-bold lowercase tracking-tight text-foreground">
            invite people
          </h2>
          <p className="text-sm text-muted-foreground">
            Share this link and anyone who opens it joins <span className="text-foreground">#{group.name}</span> instantly.
          </p>
        </div>

        <div className="mt-6 space-y-4 min-w-0">
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
                className="group w-full min-w-0 max-w-full overflow-hidden flex items-center gap-2 clip-corner-lg border-transparent bg-background/40 px-3 py-3 text-left transition-colors hover:bg-background/70"
              >
                <Link2 className="size-4 shrink-0 text-muted-foreground" />
                <span className="flex-1 min-w-0 truncate font-mono text-sm">{url}</span>
                {copied
                  ? <Check className="size-4 shrink-0 text-primary" />
                  : <Copy className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground" />}
              </button>

              <div className="flex gap-2">
                <Button className="flex-1 clip-corner-lg" onClick={copy}>
                  {copied
                    ? <><Check className="size-4 mr-2" /> Copied!</>
                    : <><Copy className="size-4 mr-2" /> Copy link</>}
                </Button>
                {showShare && (
                  <Button variant="outline" className="clip-corner-lg" onClick={share} aria-label="Share">
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
                  disabled={generating}
                >
                  <RefreshCw className={generating ? "size-3 animate-spin" : "size-3"} />
                  New
                </button>
              </div>
            </>
          )}
        </div>
      </ChromeDialogContent>
    </Dialog>
  );
}
