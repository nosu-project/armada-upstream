import { Check, Copy, Link as LinkIcon, Loader2, UserPlus } from "lucide-react";
import { useState } from "react";

import { ArmadaCrest, ArmadaCrestKeyframes } from "@/components/brand/ArmadaCrest";
import { ProfileSearchSelect } from "@/components/chat/ProfileSearchSelect";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, ChromeDialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useConcordCommunityActions } from "@/hooks/useConcordCommunityActions";
import { toast } from "@/hooks/useToast";
import type { SearchProfile } from "@/hooks/useSearchProfiles";
import type { Community } from "@/lib/concord/types";

/**
 * Invite people to a Concord community two ways: a shareable public link (the
 * secret rides in the URL fragment) or a direct gift-wrapped invite to someone
 * found by name (NIP-50 search, follows first). Styled in the cut-corner chrome
 * idiom of the Add dialog.
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
  const { createInviteLink, isCreatingLink, revokeInviteLink, sendDirectInvite, isSendingInvite } =
    useConcordCommunityActions(community);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [expiryDays, setExpiryDays] = useState<number>(0); // 0 = never
  const [label, setLabel] = useState("");
  const [revoking, setRevoking] = useState(false);
  const [sentPubkey, setSentPubkey] = useState<string | null>(null);
  const [pendingPubkey, setPendingPubkey] = useState<string | null>(null);
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

  const handleSelect = async (profile: SearchProfile) => {
    setError(null);
    setPendingPubkey(profile.pubkey);
    try {
      await sendDirectInvite({ recipientPubkey: profile.pubkey });
      setSentPubkey(profile.pubkey);
      toast({
        title: "Invite sent",
        description: `${profile.metadata.name || profile.metadata.display_name || "They"} will be asked to accept.`,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't send the invite.");
    } finally {
      setPendingPubkey(null);
    }
  };

  const isCord = community?.proto === "cord";

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

      {/* Direct invite — search by name, follows first. (Link-only for the
          experimental CORD protocol until targeted invites land.) */}
      {!isCord && (
        <div className="w-full space-y-2">
          <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            <UserPlus className="size-3.5" />
            Invite someone directly
          </div>
          <ProfileSearchSelect onSelect={handleSelect} busyPubkey={pendingPubkey} autoFocus />
          {sentPubkey && !isSendingInvite && (
            <p className="flex items-center gap-1.5 text-xs text-success">
              <Check className="size-3.5" /> Invite sent. Search again to invite more.
            </p>
          )}
        </div>
      )}

      {/* Public link — the escape hatch / share-anywhere path. */}
      <div className={`w-full space-y-2 ${isCord ? "" : "border-t border-chrome pt-5"}`}>
        <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          <LinkIcon className="size-3.5" />
          {isCord ? "Share a link" : "Or share a link"}
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
