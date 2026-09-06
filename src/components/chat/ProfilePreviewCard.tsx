import { AtSign, Check, Copy, Flag, Globe, MessageSquare, MoreHorizontal, Music, UserCheck, UserMinus, UserX } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { DittoIcon } from "@/components/brand/DittoIcon";
import { BotPill } from "@/components/BotPill";
import { EmojifiedText } from "@/components/chat/CustomEmoji";
import { FollowButton } from "@/components/FollowButton";
import { ReportDialog } from "@/components/ReportDialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { FallbackImage } from "@/components/ui/FallbackImage";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useAuthor } from "@/hooks/useAuthor";
import { useChatScope } from "@/hooks/useChatScope";
import { useMuteToggle } from "@/hooks/useMuteList";
import { useNsite } from "@/hooks/useNsite";
import { useOpenProfile } from "@/hooks/useOpenProfile";
import { usePrefetchProfile } from "@/hooks/usePrefetchProfile";
import { useMemberRoles } from "@/hooks/useMemberRoles";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useAppContext } from "@/hooks/useAppContext";
import { useFollowToggle } from "@/hooks/useFollowToggle";
import { requestMention } from "@/hooks/useMentionBus";
import { useProfileTheme, usePrefetchProfileTheme } from "@/hooks/useProfileTheme";
import { isStatusExpired, useUserStatus } from "@/hooks/useUserStatus";
import { toast } from "@/hooks/useToast";
import { getAvatarShape } from "@/lib/avatarShape";
import { dittoProfileUrl } from "@/lib/dittoUrl";
import { getDisplayName } from "@/lib/getDisplayName";
import { reportDestination } from "@/lib/report";
import { tryNpubEncode } from "@/lib/safeNip19";
import { sanitizeImageSrc } from "@/lib/sanitizeUrl";
import { cn } from "@/lib/utils";
import { writeClipboardText } from "@/lib/clipboard";
import { buildThemeVarStyle } from "@/themes";

interface ProfilePreviewCardProps {
  pubkey: string;
  /** The trigger element (e.g. an avatar). Rendered as the popover trigger. */
  children: React.ReactNode;
}

/** The body of the profile preview — banner, avatar, name, npub, bio, actions. */
function ProfilePreviewBody({
  pubkey,
  onAction,
  onReport,
}: {
  pubkey: string;
  onAction?: () => void;
  /** Absent when this surface has no one to report to (see `reportDestination`). */
  onReport?: () => void;
}) {
  const author = useAuthor(pubkey);
  const navigate = useNavigate();
  const openProfile = useOpenProfile();
  const prefetchProfile = usePrefetchProfile();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const metadata = author.data?.metadata;
  // kind-0 is whatever its author typed.
  const banner = sanitizeImageSrc(metadata?.banner);
  const roles = useMemberRoles(pubkey);
  const status = useUserStatus(pubkey).data?.status;
  const rawMusicStatus = useUserStatus(pubkey, "music").data?.status;
  // Music statuses expire when the track ends; hide one whose NIP-40 expiration
  // has passed even if it's still cached (no refetch happens within a session).
  const musicStatus = isStatusExpired(rawMusicStatus) ? undefined : rawMusicStatus;
  const displayName = getDisplayName(metadata, pubkey);
  const avatarShape = getAvatarShape(metadata);
  const npub = tryNpubEncode(pubkey);
  const [copied, setCopied] = useState(false);
  const isSelf = user?.pubkey === pubkey;
  const mute = useMuteToggle(pubkey);
  const { isFollowing, isPending: followPending, toggle: toggleFollow } = useFollowToggle(pubkey);

  const copyNpub = () => {
    if (!npub) return;
    writeClipboardText(npub).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }, () => undefined);
  };

  const message = () => {
    if (!npub) return;
    onAction?.();
    navigate(`/dm/${npub}`);
  };

  const mention = () => {
    if (requestMention(pubkey)) {
      onAction?.();
    } else {
      toast({ title: "Open a channel to mention someone" });
    }
  };

  const shortNpub = npub ? `${npub.slice(0, 12)}…${npub.slice(-6)}` : "";
  const dittoProfileHref = dittoProfileUrl(pubkey);
  const nsite = useNsite(pubkey).data;

  const viewProfile = () => {
    onAction?.();
    openProfile(npub ?? pubkey);
  };

  return (
    <>
      {/* Mini banner */}
      <div className="h-16 bg-secondary relative">
        <FallbackImage src={banner} className="w-full h-full object-cover" loading="lazy" />

        {/* Overflow menu, floated top-right over the banner. Holds the negative,
            easy-to-misfire actions (unfollow, mute, report) so the card body
            reads as Message / Mention / Follow, not a stack of red buttons. */}
        {!isSelf && (isFollowing || mute.canMute || (user && onReport)) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                aria-label="More actions"
                className="absolute right-1.5 top-1.5 z-10 size-8 rounded-full text-foreground drop-shadow hover:bg-background/40"
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              {/* Unfollow leaves the card open so the state flip back to a
                  Follow button is visible. */}
              {isFollowing && (
                <DropdownMenuItem
                  disabled={followPending}
                  onSelect={() => void toggleFollow()}
                >
                  <UserMinus className="mr-2 size-4" />
                  Unfollow
                </DropdownMenuItem>
              )}
              {mute.canMute && (
                <DropdownMenuItem
                  disabled={mute.pending}
                  className={!mute.muted ? "text-destructive focus:text-destructive" : undefined}
                  onSelect={() => {
                    // Muting hides the person, which unmounts the card — close
                    // the popover first, as Report does.
                    onAction?.();
                    void mute.toggle();
                  }}
                >
                  {mute.muted
                    ? <UserCheck className="mr-2 size-4" />
                    : <UserX className="mr-2 size-4" />}
                  {mute.label}
                </DropdownMenuItem>
              )}
              {user && onReport && (
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onSelect={onReport}
                >
                  <Flag className="mr-2 size-4" />
                  Report
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      <div className="px-4 pb-4">
        {/* Avatar overlapping the banner */}
        <div className="-mt-8 mb-2">
          <Avatar shape={avatarShape} className="size-16 border-[3px] border-background">
            <AvatarImage src={metadata?.picture} alt={displayName} />
            <AvatarFallback className="bg-primary/20 text-primary text-lg">
              {displayName[0]?.toUpperCase()}
            </AvatarFallback>
          </Avatar>
        </div>

        {/* Name */}
        <div className="flex items-center gap-1.5 min-w-0">
          <div className="font-bold text-[15px] truncate">
            {author.data?.event
              ? <EmojifiedText tags={author.data.event.tags}>{displayName}</EmojifiedText>
              : displayName}
          </div>
          <BotPill metadata={metadata} />
        </div>

        {/* Roles in this community (Concord). Tinted per role, wrapping — the
            card is the one surface with room for every role, where the member
            row shows only the highest. */}
        {roles.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {roles.map((role) => (
              <span
                key={role.id}
                title={role.name}
                className={cn(
                  "inline-flex max-w-full items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                  !role.color && "bg-muted text-muted-foreground",
                )}
                style={
                  role.color
                    ? {
                        color: `#${(role.color & 0xffffff).toString(16).padStart(6, "0")}`,
                        backgroundColor: `#${(role.color & 0xffffff).toString(16).padStart(6, "0")}26`,
                      }
                    : undefined
                }
              >
                <span className="truncate">{role.name}</span>
              </span>
            ))}
          </div>
        )}

        {/* NIP-38 status */}
        {status?.content && (
          status.link ? (
            <a
              href={status.link}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 block text-sm text-muted-foreground truncate hover:text-foreground transition-colors"
              title={status.content}
            >
              <EmojifiedText tags={status.event.tags}>{status.content}</EmojifiedText>
            </a>
          ) : (
            <div className="mt-1 text-sm text-muted-foreground truncate" title={status.content}>
              <EmojifiedText tags={status.event.tags}>{status.content}</EmojifiedText>
            </div>
          )
        )}

        {/* NIP-38 music status ("now playing"). Linked to the track when the
            event carries an `r` tag (e.g. a Spotify / YouTube Music search). */}
        {musicStatus?.content && (
          musicStatus.link ? (
            <a
              href={musicStatus.link}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground truncate hover:text-foreground transition-colors"
              title={musicStatus.content}
            >
              <Music className="size-3.5 shrink-0" />
              <span className="truncate">
                <EmojifiedText tags={musicStatus.event.tags}>{musicStatus.content}</EmojifiedText>
              </span>
            </a>
          ) : (
            <div
              className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground truncate"
              title={musicStatus.content}
            >
              <Music className="size-3.5 shrink-0" />
              <span className="truncate">
                <EmojifiedText tags={musicStatus.event.tags}>{musicStatus.content}</EmojifiedText>
              </span>
            </div>
          )
        )}

        {/* npub (copyable) */}
        {npub && (
          <button
            type="button"
            onClick={copyNpub}
            className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            title="Copy npub"
          >
            <span className="font-mono">{shortNpub}</span>
            {copied ? <Check className="size-3 text-primary" /> : <Copy className="size-3" />}
          </button>
        )}

        {/* Bio */}
        {metadata?.about && (
          <p className={cn(
            "text-sm text-muted-foreground mt-2 whitespace-pre-wrap break-words line-clamp-4",
          )}>
            {metadata.about}
          </p>
        )}

        {/* Actions. Negative actions (unfollow, mute, report) live in the
            overflow menu floated over the banner, so this row stays a clean
            Message / Mention pair. */}
        {!isSelf && (
          <div className="mt-3 flex items-center gap-2">
            {!config.dmsDisabled && (
              <Button size="sm" className="flex-1 clip-corner-lg h-8" onClick={message}>
                <MessageSquare className="size-3.5 mr-1.5" />
                Message
              </Button>
            )}
            <Button
              size="sm"
              variant="secondary"
              className="flex-1 clip-corner-lg h-8"
              onClick={mention}
            >
              <AtSign className="size-3.5 mr-1.5" />
              Mention
            </Button>
          </div>
        )}

        {/* Follow. Its own row rather than a third of the one above: the card
            is w-72, and the two buttons there already carry icons. Hides itself
            for self / logged-out / already-following (unfollow lives in the
            overflow menu), and styled like the Mention button. */}
        <FollowButton pubkey={pubkey} className="mt-2 w-full h-8" />

        {/* The full profile view, with the two off-ramps beside it: this
            person on ditto.pub (the fuller social view) and their nsite,
            when they've published one. */}
        <div className="mt-2 flex items-center gap-2">
          <Button
            size="sm"
            className="flex-1 clip-corner-lg h-8"
            onClick={viewProfile}
            // Badges and follow counts are the profile's slowest queries and
            // the only ones this card hasn't already resolved. Hovering the
            // button is the earliest honest signal that they'll be needed.
            onPointerEnter={() => prefetchProfile(pubkey)}
            onFocus={() => prefetchProfile(pubkey)}
          >
            View profile
          </Button>
          {dittoProfileHref && (
            <Button size="icon" variant="secondary" className="size-8 clip-corner-lg shrink-0" asChild>
              <a
                href={dittoProfileHref}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => onAction?.()}
                title="View on Ditto"
                aria-label="View on Ditto"
              >
                <DittoIcon className="size-3.5" />
              </a>
            </Button>
          )}
          {nsite && (
            <Button size="icon" variant="secondary" className="size-8 clip-corner-lg shrink-0" asChild>
              <a
                href={nsite.url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => onAction?.()}
                title={nsite.title ?? "View website"}
                aria-label="View website"
              >
                <Globe className="size-3.5" />
              </a>
            </Button>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * Wraps a trigger element (typically an avatar) with a click-triggered popover
 * showing a compact profile preview: banner, avatar, display name, npub, and
 * bio. The card is tinted with the profile owner's Ditto theme when they have
 * one, so hovering a user shows their chosen colors.
 */
export function ProfilePreviewCard({ pubkey, children }: ProfilePreviewCardProps) {
  const [open, setOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const prefetchTheme = usePrefetchProfileTheme();
  // Where a report from this card goes is the surrounding room's business, not
  // the card's; in a DM or on a bare profile there is no room, and it's public.
  const chatScope = useChatScope();
  const reportTo = reportDestination(chatScope);

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          asChild
          onPointerEnter={() => prefetchTheme(pubkey)}
          onFocus={() => prefetchTheme(pubkey)}
        >
          {children}
        </PopoverTrigger>
        {open && (
          <ThemedPreviewContent
            pubkey={pubkey}
            onClose={() => setOpen(false)}
            onReport={
              reportTo
                ? () => {
                    setOpen(false);
                    setReportOpen(true);
                  }
                : undefined
            }
          />
        )}
      </Popover>
      {/* Outside the popover: choosing Report closes the card, which would
          otherwise unmount the dialog in the same tick. */}
      {reportOpen && reportTo && (
        <ReportDialog
          open={reportOpen}
          onOpenChange={setReportOpen}
          destination={reportTo}
          target={{ pubkey }}
        />
      )}
    </>
  );
}

/**
 * The popover content, mounted only while open so the profile + theme queries
 * don't fire until the card is shown. Applies the profile owner's Ditto theme
 * (if any) as scoped CSS variables on the card element.
 */
function ThemedPreviewContent({
  pubkey,
  onClose,
  onReport,
}: {
  pubkey: string;
  onClose: () => void;
  onReport?: () => void;
}) {
  const dittoTheme = useProfileTheme(pubkey).data?.theme;
  const themeStyle = dittoTheme ? buildThemeVarStyle(dittoTheme.colors) : undefined;

  return (
    <PopoverContent
      side="bottom"
      align="start"
      sideOffset={8}
      style={themeStyle}
      className="w-72 p-0 rounded-2xl overflow-hidden border border-border shadow-xl"
      onClick={(e) => e.stopPropagation()}
    >
      <ProfilePreviewBody pubkey={pubkey} onAction={onClose} onReport={onReport} />
    </PopoverContent>
  );
}
