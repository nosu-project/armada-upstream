import { AlertTriangle, Check, ChevronRight, Copy, Info, Link as LinkIcon, Loader2, UserPlus } from "lucide-react";
import { useState } from "react";

import { ArmadaCrest, ArmadaCrestKeyframes } from "@/components/brand/ArmadaCrest";
import { ProfileSearchSelect } from "@/components/chat/ProfileSearchSelect";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, ChromeDialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useInviteActions2 } from "@/concord-v2/hooks/useInvites2";
import { toast } from "@/hooks/useToast";
import type { SearchProfile } from "@/hooks/useSearchProfiles";
import { writeClipboardText } from "@/lib/clipboard";
import { shareOrigin } from "@/lib/shareOrigin";
import { cn } from "@/lib/utils";
import type { CommunityV2 } from "@/concord-v2/lib/types";

/**
 * Invite people to a Concord V2 community two ways (CORD-05): a direct
 * gift-wrapped key handoff to someone found by name (NIP-50 search, follows
 * first), or a shareable public link — the path carries the bundle's naddr
 * locator, the `#fragment` carries the unlock token, never sent to any server.
 * Links revoke without re-keying; a direct invite is unrevocable and keeps the
 * community Private.
 */
export function InviteDialog2({
  community,
  open,
  onOpenChange,
  canCreateLink,
}: {
  community: CommunityV2 | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Owner/admin only. Members still invite people one by one, but the shareable
      link section (mint/revoke/live links) is hidden from them. */
  canCreateLink: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ChromeDialogContent title="Invite people">
        <InviteBody community={community} canCreateLink={canCreateLink} />
        <ArmadaCrestKeyframes />
      </ChromeDialogContent>
    </Dialog>
  );
}

function InviteBody({ community, canCreateLink }: { community: CommunityV2 | undefined; canCreateLink: boolean }) {
  const { createLink, isCreatingLink, revokeLink, myLinks, sendDirectInvite, isSendingInvite, isPublic, revokeWouldPrivatize } =
    useInviteActions2(community);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [expiryDays, setExpiryDays] = useState<number>(0); // 0 = never
  const [label, setLabel] = useState("");
  const [listPublicly, setListPublicly] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [sentPubkey, setSentPubkey] = useState<string | null>(null);
  const [pendingPubkey, setPendingPubkey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

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

  // The first live link flips the community Public (CORD-05 §5): anyone with the
  // link can then read the public-channel history up to that point, and revoking
  // the link or removing them later doesn't take that back. Announcing to
  // Discover publishes the secret too. Both are consequential, so a click routes
  // through an in-app confirm rather than firing straight away.
  const needsConfirm = !isPublic || listPublicly;

  const doGenerate = async () => {
    setError(null);
    try {
      const expiresAtMs = expiryDays > 0 ? Date.now() + expiryDays * 86400_000 : undefined;
      setLink(
        await createLink({
          expiresAtMs,
          label: label.trim() || undefined,
          listPublicly: listPublicly || undefined,
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't create the link.");
    }
  };

  const handleGenerateClick = () => {
    if (needsConfirm) {
      setConfirmOpen(true);
      return;
    }
    void doGenerate();
  };

  const handleRevoke = async (url: string) => {
    setError(null);
    const privatizes = revokeWouldPrivatize(url);
    if (
      privatizes &&
      !confirm(
        "This is the last live invite link. Revoking it makes the community private: new members can then only be added by direct invite, and banning a member will rotate the community keys.",
      )
    ) {
      return;
    }
    setRevoking(url);
    try {
      await revokeLink({ url });
      if (link === url) setLink(null);
      toast({
        title: "Invite link revoked",
        description: privatizes
          ? "It can no longer be used to join. This community is now private."
          : "It can no longer be used to join.",
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't revoke the link.");
    } finally {
      setRevoking(null);
    }
  };

  const handleCopy = async (url: string) => {
    try {
      await writeClipboardText(url);
      setCopied(url);
      setTimeout(() => setCopied((c) => (c === url ? null : c)), 1500);
    } catch {
      toast({ title: "Copy failed", variant: "destructive" });
    }
  };

  const existing = myLinks.filter((e) => e.url !== link);

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
              <>
                Bring people into <span className="text-foreground">{community.name}</span>.
              </>
            ) : (
              <>Bring people into your community.</>
            )}
          </p>
        </div>
      </div>

      {/* Direct invite — search by name, follows first. A key handoff: the
          bundle giftwraps straight to them, and the community stays Private. */}
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

      {/* Public link — the escape hatch / share-anywhere path. Owner/admin only;
          a plain member invites people one by one above. */}
      {canCreateLink && (
      <div className="w-full space-y-2 border-t border-chrome pt-5">
        <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          <LinkIcon className="size-3.5" />
          Or share a link
          <Popover>
            <PopoverTrigger asChild>
              <button type="button" className="ml-auto text-muted-foreground/70 hover:text-foreground" aria-label="About invite links">
                <Info className="size-3.5" />
              </button>
            </PopoverTrigger>
            <PopoverContent side="top" className="w-64 p-3 text-xs normal-case tracking-normal font-normal text-muted-foreground">
              Anyone with the link can join. The secret lives in the # fragment, never sent to a server. Revoking a
              link doesn't require changing anyone's keys.
            </PopoverContent>
          </Popover>
        </div>
        {link ? (
          <>
            <div className="flex items-center gap-2">
              <Input readOnly value={link} className="min-w-0 font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
              <Button type="button" size="icon" variant="outline" className="shrink-0" onClick={() => handleCopy(link)} aria-label="Copy link">
                {copied === link ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
              </Button>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => handleRevoke(link)}
              disabled={revoking === link}
              className="text-destructive hover:text-destructive"
            >
              {revoking === link ? <><Loader2 className="size-3.5 mr-1.5 animate-spin" /> Revoking...</> : "Revoke this link"}
            </Button>
          </>
        ) : (
          <>
            {/* The consequence is shown up front, before the click — not sprung
                in a popup after — the first time a link would make this public. */}
            {!isPublic && (
              <Alert variant="destructive" className="normal-case tracking-normal">
                <AlertTriangle className="size-4" />
                <AlertTitle>Anyone with the link can read public-channel history</AlertTitle>
                <AlertDescription>
                  Creating a link makes this community public. Anyone who gets it can read every
                  message sent up to this point in the community's public channels, and keeps that
                  access even if you later revoke the link or remove them from the community.
                </AlertDescription>
              </Alert>
            )}
            <Button
              type="button"
              variant="secondary"
              onClick={handleGenerateClick}
              disabled={isCreatingLink || !community}
              className="w-full clip-corner-lg"
            >
              {isCreatingLink ? <><Loader2 className="size-4 mr-2 animate-spin" /> Generating...</> : "Generate invite link"}
            </Button>
            <Collapsible open={optionsOpen} onOpenChange={setOptionsOpen}>
              <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground">
                <ChevronRight className={cn("size-3.5 transition-transform", optionsOpen && "rotate-90")} />
                Link options
                {!optionsOpen && (expiryDays > 0 || label.trim()) && (
                  <span className="text-foreground/70">
                    {" · "}
                    {[expiryDays > 0 ? `expires in ${expiryDays} day${expiryDays > 1 ? "s" : ""}` : null, label.trim() ? `"${label.trim()}"` : null]
                      .filter(Boolean)
                      .join(", ")}
                  </span>
                )}
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-2">
                <div className="flex gap-2">
                  <Select value={String(expiryDays)} onValueChange={(v) => setExpiryDays(Number(v))}>
                    <SelectTrigger className="w-40 shrink-0" aria-label="Link expiry">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="0">Never expires</SelectItem>
                      <SelectItem value="1">Expires in 1 day</SelectItem>
                      <SelectItem value="7">Expires in 7 days</SelectItem>
                      <SelectItem value="30">Expires in 30 days</SelectItem>
                    </SelectContent>
                  </Select>
                  <Input
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder="Label (optional)"
                    className="min-w-0 text-sm"
                    aria-label="Invite label"
                  />
                </div>

                {/* Opt-in public directory listing. */}
                <div className="mt-3 rounded-lg border border-chrome p-3 space-y-2.5">
                  <Label
                    htmlFor="list-publicly"
                    className="flex items-start justify-between gap-3 cursor-pointer"
                  >
                    <span className="space-y-0.5">
                      <span className="block text-sm font-medium normal-case tracking-normal">
                        Share to Discover
                      </span>
                      <span className="block text-xs font-normal normal-case tracking-normal text-muted-foreground">
                        List the community publicly on the Discover page so anyone can find and
                        join it. The link's secret becomes public.
                      </span>
                    </span>
                    <Switch id="list-publicly" checked={listPublicly} onCheckedChange={setListPublicly} />
                  </Label>
                </div>
              </CollapsibleContent>
            </Collapsible>
          </>
        )}
      </div>
      )}

      {canCreateLink && existing.length > 0 && (
        <div className="w-full space-y-1.5 border-t border-chrome pt-4">
          <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Your live links</div>
          {existing.map((e) => (
            <div key={e.token} className="flex items-center gap-2">
              <Input readOnly value={e.url} className="min-w-0 font-mono text-[0.65rem]" onFocus={(ev) => ev.currentTarget.select()} />
              <Button type="button" size="icon" variant="outline" className="shrink-0" aria-label="Copy link" onClick={() => handleCopy(e.url)}>
                {copied === e.url ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="shrink-0 text-destructive hover:text-destructive"
                disabled={revoking === e.url}
                onClick={() => handleRevoke(e.url)}
              >
                {revoking === e.url ? <Loader2 className="size-3.5 animate-spin" /> : "Revoke"}
              </Button>
            </div>
          ))}
        </div>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {!isPublic
                ? "Are you sure you want to make this community\u00A0public?"
                : "Share this link to Discover?"}
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              {!isPublic && (
                <span className="block">
                  Creating an invite link makes this community public. If you want to keep the room
                  private, you can still invite users individually. Invite them to create an account
                  at {shareOrigin()}.
                </span>
              )}
              {listPublicly && (
                <span className="block">
                  Sharing to Discover publishes this link, including its secret, from your account, so
                  anyone can find and join.
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void doGenerate()}>
              {!isPublic ? "Make Room Public and Create Link" : "Create Link"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
