import {
  Check,
  ChevronLeft,
  Loader2,
  MailPlus,
  Radio,
  ShieldCheck,
  UserRoundCheck,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import * as nip19 from "nostr-tools/nip19";

import { ArmadaCrest, ArmadaCrestKeyframes } from "@/components/brand/ArmadaCrest";
import { DisplayName } from "@/components/DisplayName";
import { ProfilePreviewCard } from "@/components/chat/ProfilePreviewCard";
import { ServerRail } from "@/components/layout/ServerRail";
import { SwipeReveal } from "@/components/layout/SwipeReveal";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { BannedFromCommunityError, bundleToEntry } from "@/concord/hooks/useCommunityActions";
import { useDecryptedImage } from "@/concord/hooks/useDecryptedImage";
import {
  useAcceptDirectInvite,
  useDeclineDirectInvite,
  useInviteInbox,
  type InviteInboxItem,
  type ParkedInvite,
} from "@/concord/hooks/useDirectInvites";
import { InviteTide } from "@/concord/components/InviteTide";
import { useGuestbook } from "@/concord/hooks/useGuestbook";
import { rehydrateCommunity } from "@/concord/lib/communityList";
import { directInviteExpired } from "@/concord/lib/directInvite";
import type { Community, ImagePointer } from "@/concord/lib/types";
import { useAuthor } from "@/hooks/useAuthor";
import { useFollowList } from "@/hooks/useFollowList";
import { concordInviteReadKey, useReadState } from "@/hooks/useReadState";
import { toast } from "@/hooks/useToast";
import { getAvatarShape } from "@/lib/avatarShape";
import { relativeTime, shortTimeAgo } from "@/lib/formatTime";
import { getDisplayName } from "@/lib/getDisplayName";
import { cn } from "@/lib/utils";

/**
 * The seal-verified sender as a short npub. Shown BESIDE the resolved profile
 * rather than instead of it: the kind-0 name and picture are whatever the
 * sender chose to publish, so the key that actually signed the seal stays on
 * screen as the thing the user can compare against.
 */
function senderLabel(pubkeyHex: string): string {
  try {
    return `${nip19.npubEncode(pubkeyHex).slice(0, 16)}…`;
  } catch {
    return `${pubkeyHex.slice(0, 16)}…`;
  }
}

/**
 * A stable hue (0-359) for a community, from its self-certifying id — the
 * fallback artwork for a bundle that carries no icon or banner, so a community
 * without images still gets a face of its own instead of a grey slab. djb2,
 * the same hash `meshIdentity.ts` uses for peer colors.
 */
function communityHue(id: string): number {
  let hash = 5381;
  for (let i = 0; i < id.length; i++) hash = (Math.imul(hash, 33) + id.charCodeAt(i)) >>> 0;
  return hash % 360;
}

/** The generated wash behind a community's monogram tile / banner strip. */
function communityWash(hue: number, strength = 1): string {
  return (
    `linear-gradient(135deg, hsl(${hue} 70% 52% / ${0.42 * strength}) 0%,`
    + ` hsl(${(hue + 48) % 360} 72% 46% / ${0.16 * strength}) 55%,`
    + ` hsl(${(hue + 96) % 360} 70% 40% / ${0.06 * strength}) 100%)`
  );
}

/**
 * How many private channels this bundle actually hands over. Read straight off
 * the decrypted bundle — the Control plane would have to be swept for the
 * community's full channel list, and that is a read the Members menu below
 * pays for only when it's opened.
 */
function channelCount(invite: ParkedInvite): number {
  return Array.isArray(invite.bundle.channels) ? invite.bundle.channels.length : 0;
}

/**
 * The community's icon — the bundle's encrypted {@link ImagePointer}, decrypted
 * with the key the invite itself carries, falling back to its initial on the
 * generated wash while it loads or when the bundle has no icon at all.
 */
function CommunityAvatar({
  name,
  communityId,
  icon,
  className,
}: {
  name: string;
  communityId: string;
  icon: ImagePointer | undefined;
  className?: string;
}) {
  const iconUrl = useDecryptedImage(icon);

  return (
    <span
      style={iconUrl ? undefined : { backgroundImage: communityWash(communityHue(communityId)) }}
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden clip-corner-lg bg-secondary font-bold uppercase leading-none text-foreground/80",
        className,
      )}
    >
      {iconUrl ? (
        <img src={iconUrl} alt="" className="size-full object-cover" />
      ) : (
        name.trim().charAt(0).toUpperCase() || "·"
      )}
    </span>
  );
}

/** One person in the members menu. */
function MemberRow({ pubkey }: { pubkey: string }) {
  const author = useAuthor(pubkey);
  const metadata = author.data?.metadata;
  const name = getDisplayName(metadata, pubkey);

  return (
    <div className="flex items-center gap-3 px-3.5 py-2">
      <Avatar shape={getAvatarShape(metadata)} className="size-9 shrink-0">
        <AvatarImage src={metadata?.picture} alt={name} />
        <AvatarFallback className="bg-primary/20 text-xs font-semibold text-primary">
          {name[0]?.toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <span className="min-w-0 truncate text-sm">
        <DisplayName pubkey={pubkey} name={name} />
      </span>
    </div>
  );
}

/**
 * Who's already in there, read from the Guestbook Plane (CORD-02 §5) with the
 * keys the invite carries.
 *
 * Runs for the SELECTED invite only — sweeping the guestbook connects to the
 * community's own relays, so it is scoped to the one community the user opened
 * rather than every invite sitting in the inbox. The count has to be known
 * before the menu is opened (it's on the button), which is what puts this in
 * the detail pane instead of inside the popover.
 */
function useInviteMembers(community: Community | undefined) {
  const { coalesced, isLoading } = useGuestbook(community);
  const members = useMemo(
    () =>
      [...coalesced.values()]
        .filter((m) => m.state === "join")
        .sort((a, b) => a.ms - b.ms)
        .map((m) => m.pubkey),
    [coalesced],
  );
  return { members, isLoading };
}

/** The members menu's body: everyone the guestbook says is currently in. */
function MembersList({
  community,
  members,
  isLoading,
}: {
  community: Community | undefined;
  members: string[];
  isLoading: boolean;
}) {
  if (!community) {
    return (
      <p className="px-3.5 py-3 text-sm text-muted-foreground">
        This invite can&rsquo;t show who&rsquo;s in here.
      </p>
    );
  }
  if (members.length === 0) {
    return (
      <p className="flex items-center gap-2 px-3.5 py-3 text-sm text-muted-foreground">
        {isLoading ? (
          <>
            <Loader2 className="size-4 shrink-0 animate-spin" />
            Looking up members…
          </>
        ) : (
          "No one to show yet."
        )}
      </p>
    );
  }

  return (
    <>
      <p className="px-3.5 pb-1.5 pt-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {members.length} member{members.length === 1 ? "" : "s"}
      </p>
      <div className="max-h-96 overflow-y-auto pb-2">
        {members.map((pubkey) => (
          <MemberRow key={pubkey} pubkey={pubkey} />
        ))}
      </div>
    </>
  );
}

/**
 * The relays the community's traffic actually runs over, straight off the
 * bundle. Worth seeing before accepting: they are the hosts this account will
 * connect to, and the only thing the invite says about where the community
 * physically lives.
 */
function RelayList({ relays }: { relays: string[] }) {
  return (
    <>
      <p className="px-3.5 pb-1.5 pt-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Hosted on
      </p>
      <div className="max-h-80 overflow-y-auto pb-2.5">
        {relays.map((url) => (
          <p
            key={url}
            className="break-all px-3.5 py-1.5 font-mono text-xs leading-snug text-muted-foreground"
          >
            {url}
          </p>
        ))}
      </div>
    </>
  );
}

/**
 * A fact in the stats line that opens something. Reads as plain running text
 * until hovered: underlining items in a middot-separated row of facts turns
 * the whole line into a link farm. Its icon is what marks it as more than
 * text.
 */
function StatPopover({
  icon: Icon,
  label,
  hint,
  width,
  loading,
  className,
  children,
}: {
  icon: LucideIcon;
  label: string;
  hint?: string;
  /** Panel width — member names and relay URLs want different room. */
  width: string;
  /** Swaps the icon for a spinner while the number behind the label lands. */
  loading?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // Dismiss on the outside pointerdown itself. Radix defers a TOUCH dismissal
  // to the `click` that follows it, and a tap on a non-interactive element
  // doesn't reliably produce one (iOS dispatches click only for targets it
  // considers clickable), which is how the panel ends up stuck open with the
  // page still scrolling behind it. Capture phase, so a handler that stops
  // propagation on the way down can't take the dismissal with it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (triggerRef.current?.contains(target) || contentRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [open]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          title={hint}
          className={cn(
            "inline-flex items-center gap-1 align-[-0.15em] transition-colors hover:text-foreground",
            className,
          )}
        >
          {loading ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin" />
          ) : (
            <Icon className="size-3.5 shrink-0" />
          )}
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent
        ref={contentRef}
        align="start"
        // Closed explicitly rather than left to the layer's default dismiss:
        // Radix only calls `onDismiss` when nothing has prevented the outside
        // event's default, so one handler anywhere in the tree that does is
        // enough to leave the panel stuck open with no way back out of it.
        onInteractOutside={() => setOpen(false)}
        className={cn(width, "border-0 p-0 clip-corner-lg bg-chrome")}
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}

/** One face in the friend stack. */
function FriendFace({ pubkey, className }: { pubkey: string; className?: string }) {
  const author = useAuthor(pubkey);
  const metadata = author.data?.metadata;
  const name = getDisplayName(metadata, pubkey);

  return (
    <Avatar
      shape={getAvatarShape(metadata)}
      title={name}
      className={cn("size-6 ring-2 ring-background", className)}
    >
      <AvatarImage src={metadata?.picture} alt={name} />
      <AvatarFallback className="bg-primary/20 text-[9px] font-semibold text-primary">
        {name[0]?.toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
}

/** One name in the friend line, resolved the same way the faces are. */
function FriendName({ pubkey }: { pubkey: string }) {
  const author = useAuthor(pubkey);
  return <DisplayName pubkey={pubkey} name={getDisplayName(author.data?.metadata, pubkey)} />;
}

/**
 * The people you already follow who are in there: their faces, then their
 * names in a sentence. Sits beside the member count, which says how big the
 * room is; this says whether it's a room you know anyone in, which is usually
 * the part that actually decides an invite — and a row of anonymous circles
 * doesn't answer that, so the names are spelled out beside them. Narrow
 * screens collapse the sentence to a count; the faces stay either way.
 */
function FriendStack({ pubkeys }: { pubkeys: string[] }) {
  if (pubkeys.length === 0) return null;
  const faces = pubkeys.slice(0, 4);
  // Up to three fit as a list; past that it's two names and a remainder.
  const named = pubkeys.slice(0, pubkeys.length <= 3 ? pubkeys.length : 2);
  const rest = pubkeys.length - named.length;

  return (
    <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
      <span className="flex shrink-0 items-center">
        {faces.map((pubkey, i) => (
          <FriendFace key={pubkey} pubkey={pubkey} className={i > 0 ? "-ml-2" : undefined} />
        ))}
      </span>
      {/* Narrow screens get the count instead of the names. Beside the member
          count there is only so much room left on a phone, and the sentence
          truncates mid-name there — a half-spelled name reads worse than no
          name at all, while the number still answers the same question. */}
      <span className="shrink-0 sm:hidden">
        {pubkeys.length} friend{pubkeys.length === 1 ? " is" : "s are"} here
      </span>
      <span className="hidden min-w-0 truncate sm:inline">
        {named.map((pubkey, i) => (
          <Fragment key={pubkey}>
            {i > 0 && (i === named.length - 1 && rest === 0 ? " and " : ", ")}
            <span className="font-medium text-foreground">
              <FriendName pubkey={pubkey} />
            </span>
          </Fragment>
        ))}
        {rest > 0 && ` and ${rest} other${rest === 1 ? "" : "s"}`}
        {pubkeys.length === 1 ? " is here" : " are here"}
      </span>
    </div>
  );
}

/** One invite in the master list: which community, who sent it, and when. */
function InviteRow({
  item,
  selected,
  onOpen,
}: {
  item: InviteInboxItem;
  selected: boolean;
  onOpen: (item: InviteInboxItem) => void;
}) {
  const { invite, unread } = item;
  const isCatchUp = Boolean(invite.catchUp);
  const channels = channelCount(invite);
  const sender = useAuthor(invite.sender);
  const senderName = getDisplayName(sender.data?.metadata, invite.sender);

  return (
    <button
      type="button"
      onClick={() => onOpen(item)}
      className={cn(
        "flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors clip-corner-lg",
        selected ? "bg-primary/10" : "hover:bg-foreground/5",
        unread && !selected && "bg-primary/[0.06]",
      )}
    >
      <CommunityAvatar
        name={invite.name}
        communityId={invite.communityId}
        icon={invite.bundle.icon}
        className="size-11 text-lg"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className={cn("min-w-0 truncate", unread ? "font-semibold" : "font-medium")}>
            {invite.name}
          </span>
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">
            {shortTimeAgo(invite.receivedAt)}
          </span>
        </div>
        <p
          className={cn(
            "mt-0.5 flex min-w-0 items-center gap-1 text-xs",
            unread ? "text-foreground" : "text-muted-foreground",
          )}
        >
          <ShieldCheck className="size-3 shrink-0 text-success" />
          <span className="truncate">
            {isCatchUp ? "Updated keys" : "Invited"} by {senderName}
          </span>
        </p>
        {channels > 0 && (
          <p className="mt-0.5 truncate text-[11px] leading-snug text-muted-foreground/70">
            {channels} channel{channels === 1 ? "" : "s"} included
          </p>
        )}
      </div>
      {unread && <span className="size-2 shrink-0 rounded-full bg-primary" aria-label="Unread" />}
    </button>
  );
}

/**
 * The detail pane for the selected invite — the consent surface, carrying the
 * same copy and Accept/Decline semantics the blocking modal used to. Accepting
 * keeps the keys (records the entry in the Community List vault) and announces
 * a Guestbook Join; declining tombstones it so it stops re-appearing. A
 * catch-up (a key update for a community you're already in) declines by local
 * dismissal only — never a tombstone, which would leave the community.
 *
 * Everything the bundle knows is on screen before the decision: the decrypted
 * banner and icon, the name and description, what the keys actually grant, and
 * the sender's resolved profile beside the pubkey that signed the seal. The
 * one thing that costs a relay read — who's already inside — is behind the
 * Members menu.
 */
function InviteDetail({
  invite,
  onDone,
  onBack,
}: {
  invite: ParkedInvite;
  /** The invite left the inbox (accepted or declined) — drop the selection. */
  onDone: () => void;
  /** Mobile back to the list. */
  onBack: () => void;
}) {
  const { mutateAsync: accept, isPending: accepting } = useAcceptDirectInvite();
  const { mutateAsync: decline, isPending: declining } = useDeclineDirectInvite();
  const navigate = useNavigate();
  const busy = accepting || declining;
  const isCatchUp = Boolean(invite.catchUp);

  const { bundle } = invite;
  const hue = communityHue(invite.communityId);
  const channels = channelCount(invite);
  const relayUrls = Array.isArray(bundle.relays) ? bundle.relays : [];
  const relays = relayUrls.length;
  const description = bundle.description?.trim();
  const expired = directInviteExpired(bundle);
  const bannerUrl = useDecryptedImage(bundle.banner);
  const iconUrl = useDecryptedImage(bundle.icon);

  const sender = useAuthor(invite.sender);
  const senderMeta = sender.data?.metadata;
  const senderName = getDisplayName(senderMeta, invite.sender);

  // The community the bundle describes, assembled without joining it — the
  // same conversion `useAcceptDirectInvite` runs, so the Members menu reads
  // the plane the keys actually open.
  const previewCommunity = useMemo(() => {
    try {
      return rehydrateCommunity(bundleToEntry(bundle));
    } catch {
      return undefined;
    }
  }, [bundle]);

  const { members, isLoading: membersLoading } = useInviteMembers(previewCommunity);

  // Whether the sender is someone the viewer already follows. The strongest
  // signal on this whole screen: a name and picture are anyone's to choose,
  // but a pubkey on your own follow list is a person you decided to trust.
  const { data: followList } = useFollowList();
  const followsSender = Boolean(followList?.pubkeys.includes(invite.sender));
  // The subset of the room you already follow, for the stack beside the count.
  const followedMembers = useMemo(() => {
    const following = new Set(followList?.pubkeys ?? []);
    return members.filter((pubkey) => following.has(pubkey));
  }, [followList, members]);

  // The count is only meaningful once the guestbook sweep has landed: a
  // community mid-read would otherwise read "0 members", which is a different
  // claim from "not known yet".
  const membersPending = membersLoading && members.length === 0;
  const memberLabel = membersPending
    ? "Members"
    : `${members.length} member${members.length === 1 ? "" : "s"}`;

  const handleDecline = async () => {
    // A CATCH-UP is a key update for a community I'm already in — declining must
    // NOT tombstone (that would leave the community). The parked copy is simply
    // dismissed by the accept/decline round below re-scanning; here we just drop
    // it from view. A fresh invite tombstones so it stops re-appearing.
    if (!isCatchUp) {
      try {
        await decline({ communityId: invite.communityId });
      } catch {
        // Best-effort; drop it from view regardless.
      }
    }
    onDone();
  };

  const handleAccept = async () => {
    try {
      const { communityId, name } = await accept({ invite });
      toast({ title: "Joined encrypted community", description: name });
      navigate(`/c/${encodeURIComponent(communityId)}`);
    } catch (e) {
      if (e instanceof BannedFromCommunityError) {
        toast({
          title: "You're banned",
          description: "You can't join this community.",
          variant: "destructive",
        });
        await handleDecline();
        return;
      }
      toast({
        title: "Couldn't join",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="relative flex flex-1 flex-col min-h-0 safe-area-top h-full overflow-hidden">
      {/* Behind everything, and behind the quiet space below the copy in
          particular. Positioned siblings after it paint on top. */}
      <InviteTide hue={hue} />
      <header className="relative h-12 touch:h-14 mx-2 mt-3 px-2 sidebar:px-3 flex items-center gap-1.5 shrink-0 clip-corner-lg bg-chrome">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Back to invites"
          className="size-9 touch:size-11 shrink-0 sidebar:hidden"
          onClick={onBack}
        >
          <ChevronLeft className="size-5" />
        </Button>
        <ShieldCheck className="size-5 text-success shrink-0" />
        <h1 className="font-semibold truncate leading-tight">
          {isCatchUp ? "Updated community keys" : "Encrypted community invite"}
        </h1>
      </header>

      <div className="relative flex-1 min-h-0 overflow-y-auto">
        {/* The banner is the pane's own top edge rather than a card floating
            in it. Centred in a wide desktop pane, a card left a large empty
            margin all around itself, and the community's own artwork is
            exactly the thing that should be filling that width. A bundle with
            no banner gets its icon blown up behind a blur, and one with
            neither falls back to the generated wash, so the hero is always the
            same shape. */}
        <div
          className="relative h-40 w-full overflow-hidden bg-secondary sm:h-56"
          style={{
            ...(bannerUrl ? undefined : { backgroundImage: communityWash(hue) }),
            // Feather the top edge. Butted straight under the floating header
            // the banner ended in a hard horizontal line across the gap; this
            // mirrors the way its bottom already dissolves into the page.
            maskImage: "linear-gradient(to bottom, transparent 0%, black 15%)",
            WebkitMaskImage: "linear-gradient(to bottom, transparent 0%, black 15%)",
          }}
        >
          {bannerUrl ? (
            <img src={bannerUrl} alt="" className="size-full object-cover" />
          ) : iconUrl ? (
            <img
              src={iconUrl}
              alt=""
              className="size-full scale-125 object-cover opacity-50 blur-2xl"
            />
          ) : (
            /* Decorative — wrapped rather than passed `aria-hidden`, since
               the crest is a `role="img"` with its own label. */
            <span
              aria-hidden
              className="pointer-events-none absolute -right-8 -top-6 opacity-[0.14]"
            >
              <ArmadaCrest size={240} />
            </span>
          )}
          <span
            aria-hidden
            className="absolute inset-0 bg-gradient-to-t from-background via-background/30 to-transparent"
          />
        </div>

        <div className="mx-auto w-full max-w-2xl px-4 pb-8 sm:px-6">
          <div className="-mt-12 sm:-mt-14">
            <CommunityAvatar
              name={invite.name}
              communityId={invite.communityId}
              icon={bundle.icon}
              className="size-20 text-3xl sm:size-24 sm:text-4xl"
            />
          </div>

          <h2 className="mt-3 break-words text-2xl font-bold leading-tight sm:text-3xl">
            {invite.name}
          </h2>

          {/* What the keys grant, then where it runs and when it arrived. */}
          <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            {channels > 0 && (
              <>
                <span title="Channels this invite gets you into. There may be more inside.">
                  {channels} channel{channels === 1 ? "" : "s"}
                </span>
                <span aria-hidden>·</span>
              </>
            )}
            {relays > 0 && (
              <>
                <StatPopover
                  icon={Radio}
                  label={`${relays} relay${relays === 1 ? "" : "s"}`}
                  hint="Servers that carry this community's messages."
                  width="w-80"
                >
                  <RelayList relays={relayUrls} />
                </StatPopover>
                <span aria-hidden>·</span>
              </>
            )}
            <span>Sent {relativeTime(invite.receivedAt)}</span>
            {expired && (
              <>
                <span aria-hidden>·</span>
                <span
                  title="This invite can no longer be accepted."
                  className="text-destructive"
                >
                  Expired
                </span>
              </>
            )}
          </p>

          {/* Who's inside, with the people you already follow named beside the
              count — the count sizes the room, the faces say whether it's one
              you know anyone in. */}
          {previewCommunity && (
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
              <StatPopover
                icon={Users}
                label={memberLabel}
                loading={membersPending}
                hint="Who has announced themselves in this community."
                width="w-72"
                className="shrink-0 gap-2 clip-corner-lg bg-secondary/60 px-3 py-1.5 text-sm font-medium text-foreground hover:bg-secondary"
              >
                <MembersList
                  community={previewCommunity}
                  members={members}
                  isLoading={membersLoading}
                />
              </StatPopover>
              <FriendStack pubkeys={followedMembers} />
            </div>
          )}

          {description && (
            <p className="mt-3.5 whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground">
              {description}
            </p>
          )}

          {/* Who sent it. The profile is resolved like anywhere else in the
              app; the npub under it is the key that signed the seal, which
              is the part no one can choose for themselves. */}
          <div className="mt-4 clip-corner-lg bg-secondary/40 p-3.5">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {isCatchUp ? "Keys sent by" : "Invited by"}
            </p>
            <ProfilePreviewCard pubkey={invite.sender}>
              <button
                type="button"
                className="mt-2 flex w-full min-w-0 items-center gap-3 text-left"
              >
                <div className="relative shrink-0">
                  <Avatar shape={getAvatarShape(senderMeta)} className="size-11">
                    <AvatarImage src={senderMeta?.picture} alt={senderName} />
                    <AvatarFallback className="bg-primary/20 font-semibold text-primary">
                      {senderName[0]?.toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  {followsSender && (
                    <span
                      title="Following"
                      className="absolute -bottom-0.5 -right-0.5 grid size-4 place-items-center rounded-full bg-success text-success-foreground ring-2 ring-background"
                    >
                      <UserRoundCheck className="size-2.5" />
                    </span>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium leading-tight">
                    <DisplayName pubkey={invite.sender} name={senderName} />
                  </p>
                  <p className="truncate font-mono text-[11px] leading-snug text-muted-foreground">
                    {senderLabel(invite.sender)}
                  </p>
                </div>
              </button>
            </ProfilePreviewCard>
            {/* The sender's own bio, on wide screens only. It is the least
                load-bearing thing in this panel — self-written prose, where
                the name and the npub beside it are what the decision rests
                on — and on a phone it pushes the buttons off the screen. */}
            {senderMeta?.about?.trim() && (
              // The wrapper carries the hiding, not the paragraph: `line-clamp`
              // is itself a `display` (`-webkit-box`), so putting `hidden` on
              // the same element makes two utilities fight over one property.
              <div className="hidden sm:block">
                <p className="mt-2 line-clamp-2 break-words text-xs text-muted-foreground">
                  {senderMeta.about.trim()}
                </p>
              </div>
            )}
          </div>

          {/* `text-pretty` so the browser reflows the last line rather than
              stranding two or three words under a full-width paragraph. */}
          <p className="mt-4 text-pretty text-sm leading-relaxed text-muted-foreground">
            {isCatchUp ? (
              <>
                Someone sent you access to more channels in a community you&rsquo;re already in.
                Accepting just adds those channels, and nothing else changes.
              </>
            ) : (
              <>
                Accepting adds this community to your list. What&rsquo;s said inside stays private
                to the people in it.
              </>
            )}
          </p>

          {/* The decision goes directly under the copy it follows. Pinning it
              to the bottom of the pane only moved the empty space to between
              the two, and took the primary action out of the reading and tab
              order it belongs to. The tide fills whatever is left below. */}
          <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row">
            <Button
              variant="ghost"
              className="h-12 min-w-0 flex-1 clip-corner-lg text-base"
              onClick={handleDecline}
              disabled={busy}
            >
              {declining ? <Loader2 className="size-4 animate-spin" /> : <X className="size-4" />}
              {isCatchUp ? "Not now" : "Decline"}
            </Button>
            <Button
              className="h-12 min-w-0 flex-1 clip-corner-lg text-base font-medium"
              onClick={handleAccept}
              disabled={busy || expired}
            >
              {accepting ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
              {expired
                ? "Invite expired"
                : accepting
                  ? isCatchUp
                    ? "Adding…"
                    : "Joining…"
                  : isCatchUp
                    ? "Add channels"
                    : "Accept invite"}
            </Button>
          </div>
        </div>
      </div>
      <ArmadaCrestKeyframes />
    </div>
  );
}

/**
 * The direct-invite inbox: every gift-wrapped Concord invite (CORD-05 §6) that
 * hasn't been accepted or declined, as a mail-client-style master/detail list
 * rather than the queue of blocking modals it used to be. Selecting an invite
 * opens its consent surface (Accept/Decline) inline — a two-pane master/detail
 * on desktop, a list→detail push on mobile.
 *
 * Opening the page marks the whole inbox seen (the rail badge clears); the
 * individual accept/decline is still an explicit, per-invite consent action.
 */
export function InvitesPage() {
  const { items, unreadCount } = useInviteInbox();
  const { markRead } = useReadState();
  const [selectedWrapId, setSelectedWrapId] = useState<string | undefined>(undefined);

  const selected = items.find((it) => it.invite.wrapId === selectedWrapId)?.invite;

  // Opening the inbox (or a fresh invite arriving while it's open) marks
  // everything seen — one high-water mark for the whole inbox, so the rail
  // badge clears. Consent is still separate: seeing an invite isn't accepting
  // it. `markRead` no-ops when the stored stamp is already past the newest.
  const newest = items[0]?.invite.receivedAt ?? 0;
  useEffect(() => {
    if (newest > 0) markRead(concordInviteReadKey(), newest);
  }, [newest, markRead]);

  // Drop a stale selection when its invite leaves the inbox (accepted/declined
  // elsewhere, or the scan refreshed it out).
  useEffect(() => {
    if (selectedWrapId && !items.some((it) => it.invite.wrapId === selectedWrapId)) {
      setSelectedWrapId(undefined);
    }
  }, [items, selectedWrapId]);

  return (
    <SwipeReveal
      open={!selected}
      onReveal={() => setSelectedWrapId(undefined)}
      onClose={() => undefined}
      underlay={
        <>
          <ServerRail />
          <div className="flex flex-1 sidebar:flex-none sidebar:w-80 min-w-0 flex-col safe-area-top h-full">
            <header className="relative h-12 touch:h-14 mx-2 mt-3 px-2 sidebar:px-3 flex items-center gap-1.5 shrink-0 clip-corner-lg bg-chrome">
              <MailPlus className="size-5 text-muted-foreground shrink-0" />
              <h1 className="font-semibold truncate leading-tight">Invites</h1>
              {unreadCount > 0 && (
                <span className="ml-1 flex min-w-5 h-5 px-1.5 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-bold leading-none">
                  {unreadCount}
                </span>
              )}
            </header>
            <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2">
              {items.length === 0 ? (
                <div className="flex flex-col items-center gap-3 px-3 py-16 text-center text-muted-foreground">
                  <MailPlus className="size-10 opacity-40" />
                  <p className="text-sm">
                    No invites. When someone hands you the keys to an encrypted community, it&rsquo;ll
                    show up here.
                  </p>
                </div>
              ) : (
                <div className="space-y-0.5">
                  {items.map((item) => (
                    <InviteRow
                      key={item.invite.wrapId}
                      item={item}
                      selected={item.invite.wrapId === selectedWrapId}
                      onOpen={(it) => setSelectedWrapId(it.invite.wrapId)}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      }
    >
      <main className="flex flex-1 min-w-0 flex-col bg-background h-full">
        {selected ? (
          <InviteDetail
            key={selected.wrapId}
            invite={selected}
            onDone={() => setSelectedWrapId(undefined)}
            onBack={() => setSelectedWrapId(undefined)}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center p-8 text-center text-muted-foreground">
            <div className="flex flex-col items-center gap-3 max-w-sm">
              <MailPlus className="size-12 opacity-30" />
              <p className="text-sm">
                {items.length === 0 ? "You have no pending invites." : "Select an invite to review it."}
              </p>
            </div>
          </div>
        )}
      </main>
    </SwipeReveal>
  );
}

export default InvitesPage;
