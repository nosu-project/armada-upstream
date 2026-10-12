import { AtSign, Check, Copy, Globe, MessageSquare, MoreHorizontal, Music, UserCog, UserMinus } from "lucide-react";
import { Slot } from "@radix-ui/react-slot";
import { useState, type MouseEvent } from "react";
import { useNavigate } from "react-router-dom";

import { DittoIcon } from "@/components/brand/DittoIcon";
import { BotPill } from "@/components/BotPill";
import { EmojifiedText } from "@/components/chat/CustomEmoji";
import { UserModerationMenuSection } from "@/components/chat/ModerationMenuSection";
import { RolePickerItems } from "@/components/chat/RolePickerItems";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { FallbackImage } from "@/components/ui/FallbackImage";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useAuthor } from "@/hooks/useAuthor";
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
import { useUserModeration, type UserModeration } from "@/hooks/useUserModeration";
import { toast } from "@/hooks/useToast";
import { getAvatarShape } from "@/lib/avatarShape";
import { dittoProfileUrl } from "@/lib/dittoUrl";
import { getDisplayName } from "@/lib/getDisplayName";
import { tryNpubEncode } from "@/lib/safeNip19";
import { sanitizeImageSrc } from "@/lib/sanitizeUrl";
import { cn } from "@/lib/utils";
import { writeClipboardText } from "@/lib/clipboard";
import { buildThemeVarStyle } from "@/themes";

const MENU_PARTS = {
  Item: DropdownMenuItem,
  Sub: DropdownMenuSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent,
};

interface ProfilePreviewCardProps {
  pubkey: string;
  children: React.ReactNode;
}

function ProfilePreviewBody({
  pubkey,
  onAction,
  moderation,
}: {
  pubkey: string;
  onAction?: () => void;
  moderation: UserModeration;
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
  // Hide an expired NIP-40 music status even if cached.
  const musicStatus = isStatusExpired(rawMusicStatus) ? undefined : rawMusicStatus;
  const displayName = getDisplayName(metadata, pubkey);
  const avatarShape = getAvatarShape(metadata);
  const npub = tryNpubEncode(pubkey);
  const [copied, setCopied] = useState(false);
  const isSelf = user?.pubkey === pubkey;
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
      <div className="h-16 bg-secondary relative">
        <FallbackImage src={banner} imeta={author.data?.imeta?.banner} className="w-full h-full object-cover" loading="lazy" />

        {/* Negative actions (unfollow, roles, moderation) live in this overflow menu. */}
        {(moderation.rolePicker || (!isSelf && (isFollowing || moderation.actions.length > 0))) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                aria-label="More actions"
                className="absolute right-1.5 top-1.5 z-10 size-8 touch:size-11 clip-corner-lg text-foreground drop-shadow hover:bg-background/40"
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              {!isSelf && isFollowing && (
                <DropdownMenuItem disabled={followPending} onSelect={() => void toggleFollow()}>
                  <UserMinus className="size-4" />
                  Unfollow
                </DropdownMenuItem>
              )}
              {moderation.rolePicker && (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <UserCog className="size-4" />
                    Roles
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-56 max-h-72 overflow-y-auto">
                    <RolePickerItems
                      CheckboxItem={DropdownMenuCheckboxItem}
                      pubkey={pubkey}
                      catalog={moderation.rolePicker.catalog}
                      heldRoleIds={moderation.rolePicker.heldRoleIds}
                      isToggling={moderation.rolePicker.isToggling}
                      onToggle={moderation.rolePicker.onToggle}
                    />
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              )}
              {moderation.actions.length > 0 && (
                <>
                  {!isSelf && (isFollowing || moderation.rolePicker) && <DropdownMenuSeparator />}
                  {/* Blocking or kicking unmounts the card, so close it first. */}
                  <UserModerationMenuSection parts={MENU_PARTS} actions={moderation.actions} onBeforeSelect={onAction} />
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      <div className="px-4 pb-4">
        <div className="-mt-8 mb-2">
          <Avatar shape={avatarShape} className="size-16 border-[3px] border-background">
            <AvatarImage src={metadata?.picture} imeta={author.data?.imeta?.picture} alt={displayName} />
            <AvatarFallback className="bg-primary/20 text-primary text-lg">
              {displayName[0]?.toUpperCase()}
            </AvatarFallback>
          </Avatar>
        </div>

        <div className="flex items-center gap-1.5 min-w-0">
          <div className="font-bold text-chat truncate">
            {author.data?.event
              ? <EmojifiedText tags={author.data.event.tags}>{displayName}</EmojifiedText>
              : displayName}
          </div>
          <BotPill metadata={metadata} />
        </div>

        {/* Concord roles; the card shows every role, the member row only the highest. */}
        {roles.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {roles.map((role) => (
              <span
                key={role.id}
                title={role.name}
                className={cn(
                  "inline-flex max-w-full items-center rounded-full px-1.5 py-0.5 text-3xs font-medium",
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

        {/* NIP-38 music status, linked via its `r` tag when present. */}
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

        {metadata?.about && (
          <p className={cn(
            "text-sm text-muted-foreground mt-2 whitespace-pre-wrap break-words line-clamp-4",
          )}>
            {metadata.about}
          </p>
        )}

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

        {/* Full profile, plus ditto.pub and the person's nsite when published. */}
        <div className="mt-2 flex items-center gap-2">
          <Button
            size="sm"
            className="flex-1 clip-corner-lg h-8"
            onClick={viewProfile}
            // Prefetch the profile's slowest queries on hover.
            onPointerEnter={() => prefetchProfile(pubkey)}
            onFocus={() => prefetchProfile(pubkey)}
          >
            View profile
          </Button>
          {dittoProfileHref && (
            <Button size="icon" variant="secondary" className="size-8 touch:size-11 clip-corner-lg shrink-0" asChild>
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
            <Button size="icon" variant="secondary" className="size-8 touch:size-11 clip-corner-lg shrink-0" asChild>
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
 * Click-triggered profile preview popover, tinted with the owner's Ditto theme
 * when they have one.
 */
export function ProfilePreviewCard({ pubkey, children }: ProfilePreviewCardProps) {
  const [open, setOpen] = useState(false);
  // The Popover is built on first open (every row has two triggers); latched.
  const [armed, setArmed] = useState(false);
  const prefetchTheme = usePrefetchProfileTheme();

  if (!armed) {
    return (
      <Slot
        aria-haspopup="dialog"
        aria-expanded={false}
        onPointerEnter={() => prefetchTheme(pubkey)}
        onFocus={() => prefetchTheme(pubkey)}
        onClick={(e: MouseEvent) => {
          if (e.defaultPrevented) return;
          setArmed(true);
          setOpen(true);
        }}
      >
        {children}
      </Slot>
    );
  }

  return (
    <ArmedPreviewCard pubkey={pubkey} open={open} onOpenChange={setOpen} prefetchTheme={prefetchTheme}>
      {children}
    </ArmedPreviewCard>
  );
}

/** Split out so rows that were never opened don't pay for the moderation hook. */
function ArmedPreviewCard({
  pubkey,
  open,
  onOpenChange,
  prefetchTheme,
  children,
}: {
  pubkey: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  prefetchTheme: (pubkey: string) => void;
  children: React.ReactNode;
}) {
  const moderation = useUserModeration(pubkey);
  return (
    <>
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger
          asChild
          onPointerEnter={() => prefetchTheme(pubkey)}
          onFocus={() => prefetchTheme(pubkey)}
        >
          {children}
        </PopoverTrigger>
        {open && (
          <ThemedPreviewContent pubkey={pubkey} onClose={() => onOpenChange(false)} moderation={moderation} />
        )}
      </Popover>
      {/* Outside the popover: Report closes the card, which would unmount the dialog. */}
      {moderation.dialogs}
    </>
  );
}

/** Mounted only while open so profile/theme queries wait; applies the owner's Ditto theme. */
function ThemedPreviewContent({
  pubkey,
  onClose,
  moderation,
}: {
  pubkey: string;
  onClose: () => void;
  moderation: UserModeration;
}) {
  const dittoTheme = useProfileTheme(pubkey).data?.theme;
  const themeStyle = dittoTheme ? buildThemeVarStyle(dittoTheme.colors) : undefined;

  return (
    <PopoverContent
      side="bottom"
      align="start"
      sideOffset={8}
      style={themeStyle}
      // Scrolls when taller than Radix's available height rather than clipping.
      className="w-72 p-0 overflow-x-hidden overflow-y-auto overscroll-contain"
      onClick={(e) => e.stopPropagation()}
    >
      <ProfilePreviewBody pubkey={pubkey} onAction={onClose} moderation={moderation} />
    </PopoverContent>
  );
}
