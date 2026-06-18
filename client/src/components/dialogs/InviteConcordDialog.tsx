import { Copy, Loader2, Send } from "lucide-react";
import { nip19 } from "nostr-tools";
import { useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useConcordCommunityActions } from "@/hooks/useConcordCommunityActions";
import { toast } from "@/hooks/useToast";
import type { Community } from "@/lib/concord/types";

/** Decode an npub to hex, or return undefined. */
function npubToHex(value: string): string | undefined {
  try {
    const decoded = nip19.decode(value);
    return decoded.type === "npub" ? (decoded.data as string) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Invite people to a Concord community two ways: a shareable public link (the
 * secret rides in the URL fragment) or a direct gift-wrapped invite to a
 * specific npub (parked for the recipient's consent).
 */
export function InviteConcordDialog({
  community,
  open,
  onOpenChange,
}: {
  community: Community | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { createInviteLink, isCreatingLink, sendDirectInvite, isSendingInvite } =
    useConcordCommunityActions(community);
  const [link, setLink] = useState<string | null>(null);
  const [recipient, setRecipient] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleGenerate = async () => {
    setError(null);
    try {
      setLink(await createInviteLink({}));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't create the link.");
    }
  };

  const handleCopy = () => {
    if (!link) return;
    navigator.clipboard?.writeText(link).then(
      () => toast({ title: "Invite link copied" }),
      () => toast({ title: "Copy failed", variant: "destructive" }),
    );
  };

  const handleSendDirect = async () => {
    setError(null);
    const hex = recipient.trim().startsWith("npub1") ? npubToHex(recipient.trim()) : recipient.trim();    if (!hex || !/^[0-9a-f]{64}$/i.test(hex)) {
      setError("Enter a valid npub or hex pubkey.");
      return;
    }
    try {
      await sendDirectInvite({ recipientPubkey: hex });
      toast({ title: "Invite sent", description: "It's waiting for their consent." });
      setRecipient("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't send the invite.");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Invite people</DialogTitle>
          <DialogDescription>
            Share a link, or send a private invite to someone's Nostr key. The community keys never
            touch a relay in the clear.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <section className="space-y-2">
            <Label>Public invite link</Label>
            {link ? (
              <div className="flex items-center gap-2">
                <Input readOnly value={link} className="font-mono text-xs" />
                <Button type="button" size="icon" variant="secondary" onClick={handleCopy} aria-label="Copy link">
                  <Copy className="size-4" />
                </Button>
              </div>
            ) : (
              <Button type="button" onClick={handleGenerate} disabled={isCreatingLink}>
                {isCreatingLink ? <><Loader2 className="size-4 mr-2 animate-spin" /> Generating…</> : "Generate link"}
              </Button>
            )}
            <p className="text-xs text-muted-foreground">
              Anyone with the link can join. The secret lives in the `#` fragment — never sent to a server.
            </p>
          </section>

          <section className="space-y-2">
            <Label htmlFor="invite-npub">Direct invite</Label>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleSendDirect();
              }}
              className="flex items-center gap-2"
            >
              <Input
                id="invite-npub"
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                placeholder="npub1… or hex pubkey"
                autoComplete="off"
              />
              <Button type="submit" size="icon" disabled={isSendingInvite || !recipient.trim()} aria-label="Send invite">
                {isSendingInvite ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
              </Button>
            </form>
          </section>

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
