import { Check, Copy, Link as LinkIcon, Loader2 } from "lucide-react";
import { useState } from "react";

import { ArmadaCrest, ArmadaCrestKeyframes } from "@/components/brand/ArmadaCrest";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, ChromeDialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useConcordCommunityActions } from "@/concord-v1/hooks/useConcordCommunityActions";
import { toast } from "@/hooks/useToast";
import type { Community } from "@/concord-v1/lib/types";

/**
 * Invite people to a Concord V1 community via a shareable public link (the
 * secret rides in the URL fragment). Direct gift-wrapped invites are V2-only
 * now — V1 is being phased out and no longer touches the giftwrap inbox.
 * Styled in the cut-corner chrome idiom of the Add dialog.
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
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ChromeDialogContent title="Invite people">
        <InviteBody community={community} />
        <ArmadaCrestKeyframes />
      </ChromeDialogContent>
    </Dialog>
  );
}

function InviteBody({ community }: { community: Community | undefined }) {
  const { createInviteLink, isCreatingLink, revokeInviteLink } = useConcordCommunityActions(community);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [expiryDays, setExpiryDays] = useState<number>(0); // 0 = never
  const [label, setLabel] = useState("");
  const [revoking, setRevoking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleGenerate = async () => {
    setError(null);
    try {
      const expiresAt = expiryDays > 0 ? Math.floor(Date.now() / 1000) + expiryDays * 86400 : undefined;
      setLink(await createInviteLink({ expiresAt, label: label.trim() || undefined }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't create the link.");
    }
  };

  const handleRevoke = async () => {
    if (!link) return;
    setError(null);
    setRevoking(true);
    try {
      await revokeInviteLink({ url: link });
      setLink(null);
      setLabel("");
      toast({ title: "Invite link revoked", description: "It can no longer be used to join." });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't revoke the link.");
    } finally {
      setRevoking(false);
    }
  };

  const handleCopy = () => {
    if (!link) return;
    navigator.clipboard?.writeText(link).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => toast({ title: "Copy failed", variant: "destructive" }),
    );
  };

  return (
    <div className="flex flex-col items-center gap-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <ArmadaCrest size={72} />
        <div className="space-y-1">
          <h2 className="chrome-dialog-title font-mono font-bold lowercase tracking-tight text-foreground">
            invite people
          </h2>
          <p className="text-sm text-muted-foreground">
            {community?.name ? (
              <>Bring people into <span className="text-foreground">{community.name}</span>. The keys never touch a relay in the clear.</>
            ) : (
              <>The community keys never touch a relay in the clear.</>
            )}
          </p>
        </div>
      </div>

      {/* Public link — the only V1 invite path (direct invites are V2-only). */}
      <div className="w-full space-y-2">
        <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          <LinkIcon className="size-3.5" />
          Share a link
        </div>
        {link ? (
          <>
            <div className="flex items-center gap-2">
              <Input readOnly value={link} className="min-w-0 font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
              <Button type="button" size="icon" variant="outline" className="shrink-0" onClick={handleCopy} aria-label="Copy link">
                {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
              </Button>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleRevoke}
              disabled={revoking}
              className="text-destructive hover:text-destructive"
            >
              {revoking ? <><Loader2 className="size-3.5 mr-1.5 animate-spin" /> Revoking...</> : "Revoke this link"}
            </Button>
          </>
        ) : (
          <>
            <div className="flex gap-2">
              <select
                value={expiryDays}
                onChange={(e) => setExpiryDays(Number(e.target.value))}
                className="h-9 shrink-0 rounded-md border border-input bg-background px-2 text-sm"
                aria-label="Link expiry"
              >
                <option value={0}>Never expires</option>
                <option value={1}>1 day</option>
                <option value={7}>7 days</option>
                <option value={30}>30 days</option>
              </select>
              <Input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Label (optional)"
                className="min-w-0 text-sm"
                aria-label="Invite label"
              />
            </div>
            <Button
              type="button"
              variant="secondary"
              onClick={handleGenerate}
              disabled={isCreatingLink || !community}
              className="w-full clip-corner-lg"
            >
              {isCreatingLink ? <><Loader2 className="size-4 mr-2 animate-spin" /> Generating...</> : "Generate invite link"}
            </Button>
          </>
        )}
        <p className="text-xs text-muted-foreground">
          Anyone with the link can join. The secret lives in the # fragment, never sent to a server.
        </p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
