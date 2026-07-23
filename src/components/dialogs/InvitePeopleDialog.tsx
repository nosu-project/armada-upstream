import { Check, Copy, Link2, Loader2, PartyPopper, RefreshCw, Share2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { useIsBuzzRelay } from "@/buzz/detect";
import { buzzHttpPost } from "@/buzz/http";
import { buildBuzzInviteUrl } from "@/buzz/invite";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  ChromeDialogContent,
} from "@/components/ui/dialog";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useGroupModeration } from "@/hooks/useGroupModeration";
import { useRelayClaim } from "@/hooks/useRelayMembership";
import { useRelayInfo } from "@/hooks/useRelayInfo";
import { toast } from "@/hooks/useToast";
import { writeClipboardText } from "@/lib/clipboard";
import { buildGroupNaddr, type Nip29Group } from "@/lib/nip29";
import { relayToHttpUrl, relayToRouteParam } from "@/lib/platform";
import { canShare, share as nativeShare } from "@/lib/share";
import { shareOrigin } from "@/lib/shareOrigin";

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
  const { user } = useCurrentUser();
  const { createInvite } = useGroupModeration(relayUrl, group.id);
  const { mutateAsync: fetchRelayClaim } = useRelayClaim();
  const { isBuzz } = useIsBuzzRelay(relayUrl);
  const { data: relayInfo } = useRelayInfo(relayUrl);
  const [url, setUrl] = useState<string | null>(null);
  /** The minted NIP-29 invite code (undefined on Buzz relays, which mint over HTTP). */
  const [code, setCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [naddrCopied, setNaddrCopied] = useState(false);
  const [error, setError] = useState(false);

  // The standardized cross-client identifier: the group's kind-39000 naddr
  // with the `?invite=<code>` suffix. Needs the relay's `self` key (NIP-11);
  // without it only the Armada web link is available.
  const relaySelf = relayInfo?.self || relayInfo?.pubkey;
  const naddr =
    relaySelf && code
      ? buildGroupNaddr({ relaySelf, groupId: group.id, relay: relayUrl, inviteCode: code })
      : undefined;

  const generate = useCallback(async () => {
    setError(false);
    try {
      // Buzz relays mint invites over HTTP (NIP-98-signed POST /api/invites,
      // owner/admin only — kind 9009 is a stored no-op there). The response
      // carries a shareable landing URL on the workspace host, which Armada's
      // own Add dialog also understands.
      if (isBuzz) {
        if (!user) throw new Error("Sign in to mint invites");
        const origin = relayToHttpUrl(relayUrl).replace(/\/$/, "");
        const res = await buzzHttpPost<{ code: string; url: string }>(
          user.signer,
          `${origin}/api/invites`,
          {},
        );
        // The relay returns a landing URL on its own host; rebuild it on the
        // Armada host (armada.buzz) so the link deep-links into the app, and
        // carry the relay in `?r=` so the claim still targets it.
        setCode(null);
        setUrl(buildBuzzInviteUrl(shareOrigin(), relayUrl, res.code));
        return;
      }
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
    }
  }, [createInvite, fetchRelayClaim, relayUrl, group.id, isBuzz, user]);

  // Mint an invite as soon as the dialog opens (the silly-easy part).
  useEffect(() => {
    if (open) {
      setUrl(null);
      setCode(null);
      setCopied(false);
      setNaddrCopied(false);
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

  const copyNaddr = () => {
    if (!naddr) return;
    writeClipboardText(naddr).then(
      () => {
        setNaddrCopied(true);
        setTimeout(() => setNaddrCopied(false), 1800);
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

              {/* The standardized NIP-29 group identifier — understood by other
                  Nostr clients (they pre-fill the invite code on the kind-9021
                  join request), unlike the Armada web link above. */}
              {naddr && (
                <button
                  type="button"
                  onClick={copyNaddr}
                  className="mx-auto flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  {naddrCopied
                    ? <Check className="size-3.5 text-primary" />
                    : <Copy className="size-3.5" />}
                  {naddrCopied ? "Copied naddr" : "Copy naddr for other Nostr apps"}
                </button>
              )}
            </>
          )}
        </div>
      </ChromeDialogContent>
    </Dialog>
  );
}
