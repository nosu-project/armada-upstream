import { Check, ChevronRight, Copy, Info, Link as LinkIcon, Loader2, Share2, UserPlus, X } from "lucide-react";
import { useState } from "react";

import { ArmadaCrest, ArmadaCrestKeyframes } from "@/components/brand/ArmadaCrest";
import { ProfileSearchSelect } from "@/components/chat/ProfileSearchSelect";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, ChromeDialogContent } from "@/components/ui/dialog";
import { Drawer, DrawerClose, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useInviteActions2 } from "@/concord-v2/hooks/useInvites2";
import { useIsMobile } from "@/hooks/useIsMobile";
import { toast } from "@/hooks/useToast";
import type { SearchProfile } from "@/hooks/useSearchProfiles";
import { writeClipboardText } from "@/lib/clipboard";
import { canShare, share } from "@/lib/share";
import { cn } from "@/lib/utils";
import type { CommunityV2 } from "@/concord-v2/lib/types";

/**
 * Invite people to a Concord V2 community two ways (CORD-05): a direct
 * gift-wrapped key handoff to someone found by name (NIP-50 search, follows
 * first), or a shareable public link — the path carries the bundle's naddr
 * locator, the `#fragment` carries the unlock token, never sent to any server.
 * Links revoke without re-keying; a direct invite is unrevocable and keeps the
 * community Private.
 *
 * Presented as a full-screen bottom sheet on a phone and a centered modal on a
 * pointer device. The body is a tall stack — a search field with results, a
 * link row, a collapsible options panel and the live-link list — which a
 * centered card can only ever show a slice of on a 360px screen.
 */
export function InviteDialog2({
  community,
  open,
  onOpenChange,
}: {
  community: CommunityV2 | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const isMobile = useIsMobile();

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent className="mt-0 h-[100dvh] max-h-[100dvh] rounded-t-none bg-chrome pt-[env(safe-area-inset-top)]">
          <DrawerTitle className="sr-only">Invite people</DrawerTitle>
          {/* A full-screen sheet has no visible edge to swipe from, so the
              drag handle alone isn't a discoverable way out. */}
          <DrawerClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Close"
              className="absolute right-2 top-[calc(env(safe-area-inset-top)+0.5rem)] z-10 size-9 touch:size-11"
            >
              <X className="size-5" />
            </Button>
          </DrawerClose>
          <div className="chrome-dialog flex-1 overflow-y-auto overscroll-contain px-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-6">
            <InviteBody community={community} />
          </div>
          <ArmadaCrestKeyframes />
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ChromeDialogContent title="Invite people">
        <InviteBody community={community} />
        <ArmadaCrestKeyframes />
      </ChromeDialogContent>
    </Dialog>
  );
}

function InviteBody({ community }: { community: CommunityV2 | undefined }) {
  const { createLink, revokeLink, myLinks, sendDirectInvite, isSendingInvite, isPublic, revokeWouldPrivatize } =
    useInviteActions2(community);
  const [sharing, setSharing] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [expiryDays, setExpiryDays] = useState<number>(0); // 0 = never
  const [label, setLabel] = useState("");
  const [listPublicly, setListPublicly] = useState(false);
  const [listingDescription, setListingDescription] = useState("");
  const [listingTopics, setListingTopics] = useState("");
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [sentPubkey, setSentPubkey] = useState<string | null>(null);
  const [pendingPubkey, setPendingPubkey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  /**
   * My newest link that can still be joined. "Invite" reuses it instead of
   * minting one per tap: every extra live link is another door to revoke later
   * and they all lead to the same community.
   */
  const liveLink = (() => {
    const now = Math.floor(Date.now() / 1000);
    return (
      [...myLinks]
        .filter((e) => !e.expires_at || e.expires_at > now)
        .sort((a, b) => b.created_at - a.created_at)[0]?.url ?? null
    );
  })();

  /** Mint a link with the options as set, confirming the two lines it crosses. */
  const mintLink = async (): Promise<string> => {
    // The first live link flips the derived mode Public (CORD-05 §5). Whether
    // bans still rotate is per-banner (foreign links gate rotations, own links
    // don't) — the ban dialog's step list tells that truth case by case.
    if (
      !isPublic &&
      !confirm(
        "Creating an invite link makes this community public: anyone with the link can join. Revoking every link makes it private again.",
      )
    ) {
      throw new Error("Cancelled");
    }
    // Announcing publishes the full link (secret included) as a public note —
    // a real privacy step, so confirm it explicitly.
    if (
      listPublicly &&
      !confirm(
        "Sharing to Discover posts a public note from your account with this invite link — including its secret — so anyone can find and join. Only do this for a community you want strangers to join.",
      )
    ) {
      throw new Error("Cancelled");
    }
    return createLink({
      expiresAtMs: expiryDays > 0 ? Date.now() + expiryDays * 86400_000 : undefined,
      label: label.trim() || undefined,
      listPublicly: listPublicly
        ? {
            description: listingDescription.trim() || undefined,
            topics: listingTopics
              .split(/[,\s]+/)
              .map((t) => t.trim())
              .filter(Boolean),
          }
        : undefined,
    });
  };

  /**
   * One tap: hand a live link straight to the system share sheet, minting one
   * first ONLY when there is none to reuse. Reusing skips the relay round trip
   * entirely — which is also what keeps the click's user activation alive, since
   * `navigator.share` refuses to open once an await has swallowed it.
   */
  const handleInvite = async (forceNew = false) => {
    setError(null);
    setSharing(true);
    try {
      const url = forceNew || !liveLink ? await mintLink() : liveLink;
      const shared = await share({
        title: community?.name ? `Join ${community.name}` : "Join my community",
        url,
        dialogTitle: "Share invite link",
      });
      if (!shared) {
        await handleCopy(url);
        toast({ title: "Invite link copied", description: "It's on your clipboard, ready to paste." });
      }
    } catch (e) {
      if (e instanceof Error && e.message === "Cancelled") return;
      setError(e instanceof Error ? e.message : "Couldn't create the link.");
    } finally {
      setSharing(false);
    }
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
          bundle giftwraps straight to them, and the community stays Private.
          Deliberately NOT autofocused: on a phone that throws the keyboard up
          over the rest of the sheet before the user has seen it. */}
      <div className="w-full space-y-2">
        <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          <UserPlus className="size-3.5" />
          Invite someone directly
        </div>
        <ProfileSearchSelect onSelect={handleSelect} busyPubkey={pendingPubkey} />
        {sentPubkey && !isSendingInvite && (
          <p className="flex items-center gap-1.5 text-xs text-success">
            <Check className="size-3.5" /> Invite sent. Search again to invite more.
          </p>
        )}
      </div>

      {/* Public link — the escape hatch / share-anywhere path. */}
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
        {/* One button, one job, one shape: it hands a link to the share sheet.
            It does not become a link row afterwards — the minted link is
            already listed under "Your live links" below, and swapping the
            control out from under the tap that just succeeded means the next
            invite needs a different gesture than the last one. */}
        <Button
          type="button"
          variant="secondary"
          onClick={() => void handleInvite()}
          disabled={sharing || !community}
          className="w-full clip-corner-lg"
        >
          {sharing ? (
            <Loader2 className="size-4 mr-2 animate-spin" />
          ) : canShare() ? (
            <Share2 className="size-4 mr-2" />
          ) : (
            <Copy className="size-4 mr-2" />
          )}
          Invite
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
                    Post this link in a public note so anyone can find and join the community.
                    The link's secret becomes public.
                  </span>
                </span>
                <Switch id="list-publicly" checked={listPublicly} onCheckedChange={setListPublicly} />
              </Label>
              {listPublicly && (
                <div className="space-y-2 pt-1">
                  <Textarea
                    value={listingDescription}
                    onChange={(e) => setListingDescription(e.target.value)}
                    placeholder="Short description (optional)"
                    className="min-h-16 text-sm"
                    maxLength={280}
                    aria-label="Listing description"
                  />
                  <Input
                    value={listingTopics}
                    onChange={(e) => setListingTopics(e.target.value)}
                    placeholder="Topics, comma-separated (optional)"
                    className="text-sm"
                    aria-label="Listing topics"
                  />
                </div>
              )}
            </div>

            {/* "Invite" reuses the newest live link; these options only mean
                anything for a link that doesn't exist yet, so they get their
                own action rather than silently changing what the tap above
                does. */}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mt-3 w-full text-muted-foreground"
              onClick={() => void handleInvite(true)}
              disabled={sharing || !community}
            >
              Create a new link with these options
            </Button>
          </CollapsibleContent>
        </Collapsible>
      </div>

      {myLinks.length > 0 && (
        <div className="w-full space-y-1.5 border-t border-chrome pt-4">
          <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Your live links</div>
          {myLinks.map((e) => (
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
    </div>
  );
}
