import { AtSign, Ban, CalendarClock, CheckCheck, ChevronDown, ChevronLeft, Bell, BellOff, FolderGit2, Hash, Headphones, HeartPulse, Link as LinkIcon, Loader2, Lock, LogOut, MessagesSquare, MoreVertical, Phone, Plus, RefreshCw, ScrollText, Search, Settings, Shield, Trash2, UserPlus, Users, X } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";

import { CallStageSlot } from "@/components/chat/CallStageSlot";
import { ChatComposer } from "@/components/chat/ChatComposer";
import { ChatMessage, ReplyContextLine, ReplyPreview, ReplyThumbnail } from "@/components/chat/ChatMessage";
import { firstImageRef, getQuoteReplyToId } from "@/components/chat/messageHelpers";
import { LoginArea } from "@/components/auth/LoginArea";
import { JoinButton } from "@/components/auth/JoinButton";
import { MemberList } from "@/components/chat/MemberList";
import { MessageTimeline, type MessageTimelineHandle } from "@/components/chat/MessageTimeline";
import { CalendarEventsBar } from "@/components/chat/CalendarEventsBar";
import { CreateEventDialog } from "@/components/dialogs/CreateEventDialog";
import { ThreadPanel } from "@/components/chat/ThreadPanel";
import { GitTimelineRow, TicketSidePanel } from "@/components/chat/GitTimeline";
import { isGitTimelineEntry, mergeChannelTimeline } from "@/components/chat/channelTimeline";
import { TypingIndicator } from "@/components/chat/TypingIndicator";
import { VoiceParticipantList } from "@/components/VoicePresence";
import { CommunityInfoDialog2 } from "@/concord-v2/components/CommunityInfoDialog2";
import { ImageLightbox2 } from "@/concord-v2/components/ImageLightbox2";
import { InviteDialog2 } from "@/concord-v2/components/InviteDialog2";
import { RolesDialog2 } from "@/concord-v2/components/RolesDialog2";
import { AuditLogView } from "@/concord-v2/components/AuditLogView2";
import { BannedView } from "@/concord-v2/components/BannedView2";
import { SuspiciousActivityBanner2 } from "@/concord-v2/components/SuspiciousActivityBanner2";
import { useBanSelfRemove2 } from "@/concord-v2/hooks/useBanSelfRemove2";
import { useLinkAuthorityWatch2 } from "@/concord-v2/hooks/useInvites2";
import { InvitesView } from "@/concord-v2/components/InvitesView2";
import { DebugHealView } from "@/concord-v2/components/DebugHealView2";
import { ChannelSidebarView } from "@/components/layout/ChannelSidebarView";
import { ServerRail } from "@/components/layout/ServerRail";
import { SwipeReveal } from "@/components/layout/SwipeReveal";
import { SyncStatusIndicator } from "@/components/SyncStatusIndicator";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ChannelNavContext } from "@/contexts/ChannelNavContext";
import { ComposerBoundsProvider } from "@/contexts/ComposerBoundsContext";
import { useAppContext } from "@/hooks/useAppContext";
import { useActiveRoom } from "@/hooks/useActiveRoom";
import { useCall } from "@/hooks/useCall";
import { useChannelNavValue } from "@/hooks/useChannelNav";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useIsTouch } from "@/hooks/useIsMobile";
import { useAuthor } from "@/hooks/useAuthor";
import { useChannelGitActivity } from "@/hooks/useChannelGitActivity";
import { useGitProjects } from "@/hooks/useGitProjects";
import { useGitWorkItemActions, type GitWorkItemRepository } from "@/hooks/useGitWorkItemActions";
import { NewChannelDialog2, type WizardRepository } from "@/concord-v2/components/NewChannelDialog2";
import { NewIssueDialog } from "@/components/projects/NewIssueDialog";
import { ProjectsView } from "@/components/projects/ProjectsView";
import type { ProjectWorkItem } from "@/components/projects/projectData";
import { useCommunityGitActivity } from "@/hooks/useCommunityGitActivity";
import { useNewMessagesDivider } from "@/hooks/useNewMessagesDivider";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { useDelayedFlag } from "@/hooks/useDelayedFlag";
import { useSyncTasks } from "@/hooks/useSyncActivity";
import { concordChannelMuteKey, useMutes } from "@/hooks/useMutes";
import { useNotifLevels, concordChannelScopeKey } from "@/hooks/useNotifLevels";
import { NotifLevelMenu } from "@/components/NotifLevelMenu";
import { toast } from "@/hooks/useToast";
import { useCommunity2, useIsExcluded2 } from "@/concord-v2/hooks/useCommunityList2";
import { useCommunityManagement2, useStrandedRecovery2 } from "@/concord-v2/hooks/useCommunityActions2";
import { useChannels2, useControlFold2, useDissolved2 } from "@/concord-v2/hooks/useControlPlane2";
import { BanMemberDialog } from "@/concord-v2/components/BanMemberDialog2";
import type { BanPhase } from "@/concord-v2/hooks/useModeration2";
import { hasForeignLiveLinks } from "@/concord-v2/lib/control";
import { replyTargetOf } from "@/concord-v2/lib/chat";
import { useDecryptedImage2 } from "@/concord-v2/hooks/useDecryptedImage2";
import { useGuestbook2 } from "@/concord-v2/hooks/useGuestbook2";
import { useModeration2, useReadCutRetry2 } from "@/concord-v2/hooks/useModeration2";
import { useChannelRekeyWatch2, useLinkRefreshWatch2, useRekeyWatch2 } from "@/concord-v2/hooks/useRekey2";
import { useRelayFollow2 } from "@/concord-v2/hooks/useRelayFollow2";
import { useRoles2 } from "@/concord-v2/hooks/useRoles2";
import { useSendMessage2 } from "@/concord-v2/hooks/useChannel2";
import { useTransport2 } from "@/concord-v2/hooks/useTransport2";
import { useConcord2Unread, type Concord2Unread } from "@/concord-v2/hooks/useConcord2Unread";
import { useConcord2Mentions } from "@/concord-v2/hooks/useConcord2Mentions";
import { useConcordSearch2 } from "@/concord-v2/hooks/useConcordSearch2";
import { SearchFiltersPopover, SearchResultsView } from "@/concord-v2/components/Search2";
import { EMPTY_SEARCH_FILTERS, type SearchFilters2 } from "@/concord-v2/lib/search";
import { useConcord2Threads, type Concord2Thread } from "@/concord-v2/hooks/useConcord2Threads";
import { useTyping2, useTypingPublisher2 } from "@/concord-v2/hooks/useTyping2";
import { resolveVoiceBroker, useVoiceBroker2, useVoicePresence2 } from "@/concord-v2/hooks/useVoice2";
import type { VoicePresenceFold } from "@/concord-v2/lib/voice";
import { useRegisterChannelStreamKeys2 } from "@/concord-v2/hooks/useStreamAuth2";
import { completeMemberlist } from "@/concord-v2/lib/guestbook";
import { badgeOf, isAuthorized, Permissions } from "@/concord-v2/lib/roles";
import { channelGitRepositoryAttachments, type ChannelV2, type CommunityV2, type ImagePointer } from "@/concord-v2/lib/types";
import { matchGitTicketRepository, parseGitRepositoryAddress, sortAndDedupeGitTimelineActivities, trustedGitStatusAuthors, type GitComment, type GitStatusKind, type GitTicket } from "@/lib/gitActivity";
import { cn, pickDefaultChannel } from "@/lib/utils";
import { getAvatarShape } from "@/lib/avatarShape";
import { shortTimeAgo } from "@/lib/formatTime";

import { authorsByRecency, threadSummary } from "@/components/chat/transport";
import type { ChatMsg, MessageCalendar, MessagePoll, MessageReactions, MessageZaps, OnchainZapAnnouncement, SendStatus, ZapPayment } from "@/components/chat/transport";

/** Stable empty replies array so a thread-less row keeps a constant prop. */
const EMPTY_REPLIES: ChatMsg[] = [];

/** The community's decrypted icon for the channel-list title. Renders nothing
 *  when the community has no icon (the header falls back to a name-only
 *  layout). */
function TitleIcon2({ icon }: { icon: ImagePointer | undefined }) {
  const url = useDecryptedImage2(icon);
  if (!url) return null;
  return <img src={url} alt="" className="size-6 rounded object-cover shrink-0" />;
}

/** Larger community avatar for the mobile chat header, with an initial fallback. */
function TitleAvatar2({ icon, name }: { icon: ImagePointer | undefined; name: string | undefined }) {
  const url = useDecryptedImage2(icon);
  if (url) {
    return <img src={url} alt="" className="size-8 rounded object-cover shrink-0" />;
  }
  return (
    <div className="size-8 rounded shrink-0 bg-muted text-muted-foreground flex items-center justify-center text-sm font-semibold uppercase">
      {name?.trim()?.[0] ?? "#"}
    </div>
  );
}

function Banner2({ banner }: { banner: ImagePointer | undefined }) {
  const url = useDecryptedImage2(banner);
  const [open, setOpen] = useState(false);
  if (!url) return null;
  return (
    <>
      <button
        type="button"
        className="size-full overflow-hidden cursor-zoom-in"
        aria-label="View banner"
        onClick={() => setOpen(true)}
      >
        <img src={url} alt="" className="size-full object-cover" />
      </button>
      {open && <ImageLightbox2 src={url} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Concord V2 inline-reply context: resolve the replied-to rumor from the
 *  in-memory decoded set (rumors aren't relay-fetchable) and render the shared
 *  "replying to …" chrome. Clicking jumps the timeline to the parent. */
function ReplyContext2({ parent, onJump }: { parent: ChatMsg | undefined; onJump: (id: string) => void }) {
  const author = useAuthor(parent?.pubkey);
  const name = useScopedDisplayName(parent?.pubkey, author.data?.metadata);
  if (!parent) return null;
  const image = firstImageRef(parent);
  return (
    <ReplyContextLine
      name={name}
      pubkey={parent.pubkey}
      preview={<ReplyPreview content={parent.content} hideMediaPlaceholder={!!image} />}
      thumbnail={image ? <ReplyThumbnail image={image} /> : undefined}
      onClick={() => onJump(parent.id)}
    />
  );
}

interface ChatMessage2Props {
  event: ChatMsg;
  reactions: MessageReactions;
  zaps: MessageZaps | undefined;
  onSendZap: ((target: ChatMsg, payment: ZapPayment) => Promise<void>) | undefined;
  onSendOnchainZap: ((target: ChatMsg, announcement: OnchainZapAnnouncement) => Promise<void>) | undefined;
  /** Poll tally + vote callback when this message is a poll (kind 1068). */
  poll: MessagePoll | undefined;
  /** Calendar event + RSVP state when this message is a calendar event (31922/31923). */
  calendar: MessageCalendar | undefined;
  /** This message's thread replies (stable ref from the transport), for the badge. */
  replies: ChatMsg[];
  continuation: boolean;
  canWrite: boolean;
  canModerate: boolean;
  sendStatus: SendStatus | undefined;
  active: boolean;
  onToggleActive: (id: string) => void;
  onOpenThread: ((event: ChatMsg) => void) | undefined;
  onReply: ((event: ChatMsg) => void) | undefined;
  /**
   * The inline reply's parent: its id (undefined when this isn't a reply) and
   * the resolved message (undefined when it isn't in the decoded set). Passed
   * as plain values rather than a ready-made element — a fresh element on every
   * caller render would defeat this component's `memo` for every reply row.
   */
  replyToId: string | undefined;
  replyParent: ChatMsg | undefined;
  onJumpToReply: (id: string) => void;
  onDelete: ((event: ChatMsg) => void) | undefined;
  onRetry: ((event: ChatMsg) => void) | undefined;
  onDiscard: ((id: string) => void) | undefined;
  isEditing: boolean;
  onEdit: ((event: ChatMsg) => void) | undefined;
  onEditSubmit: ((event: ChatMsg, content: string) => Promise<void>) | undefined;
  onEditCancel: () => void;
}

/** Memoized per-message binding (mirrors V1's ConcordChatMessage). A normal
 *  reply quotes the parent inline (`onReply`); "reply in thread" opens the
 *  thread panel (`onOpenThread`). */
const ChatMessage2 = memo(function ChatMessage2({
  event,
  reactions,
  zaps,
  onSendZap,
  onSendOnchainZap,
  poll,
  calendar,
  replies,
  continuation,
  canWrite,
  canModerate,
  sendStatus,
  active,
  onToggleActive,
  onOpenThread,
  onReply,
  replyToId,
  replyParent,
  onJumpToReply,
  onDelete,
  onRetry,
  onDiscard,
  isEditing,
  onEdit,
  onEditSubmit,
  onEditCancel,
}: ChatMessage2Props) {
  const threadInfo = threadSummary(replies);
  const replyContext = replyToId ? (
    <ReplyContext2 parent={replyParent} onJump={onJumpToReply} />
  ) : undefined;
  // Concord V2 messages are unsigned rumors sealed at the channel's stream
  // address — there's no relay-addressable event id, so the "Copy message ID" /
  // "View on Ditto" off-ramps are nonsensical. Pass the rumor through so the
  // context menu offers "View event JSON" instead. Drop the synthetic empty
  // `sig` the transport adds for rendering (a rumor has no signature).
  const rumor = useMemo(() => {
    const { sig: _sig, ...rest } = event;
    return rest;
  }, [event]);
  return (
    <ChatMessage
      event={event}
      rumor={rumor}
      canWrite={canWrite}
      canModerate={canModerate}
      reactions={reactions}
      zapEnabled={Boolean(onSendZap)}
      zaps={zaps}
      onSendZap={onSendZap}
      onSendOnchainZap={onSendOnchainZap}
      poll={poll}
      calendar={calendar}
      sendStatus={sendStatus}
      continuation={continuation}
      active={active}
      onToggleActive={onToggleActive}
      replyCount={replies.length}
      threadParticipants={threadInfo.participants}
      lastReplyAt={threadInfo.lastReplyAt}
      onOpenThread={onOpenThread}
      onReply={onReply}
      replyContext={replyContext}
      onDelete={onDelete}
      onRetry={onRetry ? () => onRetry(event) : undefined}
      onDiscard={onDiscard ? () => onDiscard(event.id) : undefined}
      isEditing={isEditing}
      onEdit={onEdit}
      onEditSubmit={onEditSubmit}
      onEditCancel={onEditCancel}
    />
  );
});

/**
 * The pinned footer for the V2 channel sidebar: the persistent voice call-bar
 * slot (the call UI portals here, above the account area) — mirroring the
 * NIP-29 ChannelSidebar footer. Each rendered instance (desktop pane + mobile
 * drawer) registers its own slot.
 */
function SidebarFooter2() {
  const { user } = useCurrentUser();
  const { registerCallBarSlot } = useCall();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return registerCallBarSlot(el);
  }, [registerCallBarSlot]);
  return (
    <>
      {/* Voice call bar slot — the persistent call UI portals here. */}
      <div ref={ref} className="empty:hidden shrink-0 px-2 pb-2" />
      {/* Account area. The inner pb-2 mirrors the composer's inner `p-2` so the
          switcher and the chat composer end at the SAME line above the safe-area
          inset (without it the switcher sat ~8px lower). */}
      <div className="px-3 pb-safe shrink-0">
        {user ? (
          <div className="pb-2">
            <LoginArea className="w-full flex" />
          </div>
        ) : (
          <div className="p-2 flex justify-center">
            <JoinButton className="w-full max-w-xs clip-corner-lg font-medium" />
          </div>
        )}
      </div>
    </>
  );
}

function ChannelRow2({
  community,
  channel,
  active,
  inCall,
  speaking,
  muted: mutedVoice,
  unread,
  onSelect,
  onJoinVoice,
}: {
  community: CommunityV2 | undefined;
  channel: ChannelV2;
  active: boolean;
  /** Whether the user's current call is THIS channel's voice room. */
  inCall: boolean;
  /** Live speaker set (only passed when `inCall`), for roster voice activity. */
  speaking?: ReadonlySet<string>;
  /** Live muted set (only passed when `inCall`), for the roster mute indicator. */
  muted?: ReadonlySet<string>;
  unread?: Concord2Unread;
  onSelect: () => void;
  onJoinVoice: (channel: ChannelV2, broker: string | null, fold?: VoicePresenceFold) => void;
}) {
  // Every Channel is callable (CORD-07): live presence drives the Discord-style
  // nested roster under the row whenever a call is active, and the rendezvous
  // broker is resolved ahead of the click so joining a call is instant.
  const fold = useVoicePresence2(community, channel);
  const { data: broker } = useVoiceBroker2(channel, fold);
  const { voiceRoomPubkeys } = useCall();
  const { isConcordChannelMuted } = useMutes();
  const { concordChannelLevel, setLevel: setNotifLevel } = useNotifLevels();
  const muted = community
    ? isConcordChannelMuted("c2", community.idHex, channel.idHex)
    : false;
  const foldedParticipants = useMemo(() => fold.present.map((p) => p.author), [fold]);
  // Raised hands (Armada client feature) read straight off the presence fold,
  // so the roster shows them even for a call you haven't joined.
  const raisedVoice = useMemo(
    () => new Set(fold.present.filter((p) => p.hand).map((p) => p.author)),
    [fold],
  );
  // While YOU are in this call, the connected room's live LiveKit roster is
  // authoritative — presence heartbeats lag (30s cadence, 90s staleness) and
  // desync. Folded presence remains the source for calls you're not in.
  const participants = inCall && voiceRoomPubkeys ? voiceRoomPubkeys : foldedParticipants;

  const Icon = channel.isPrivate ? Lock : Hash;
  const hasUnread = Boolean(unread);
  const hasMention = Boolean(unread?.mention);
  // A call is live in this channel when anyone is present.
  const occupied = participants.length > 0;
  return (
    <ContextMenu>
      <ContextMenuTrigger className="block">
        <div>
          <div
            className={cn(
              "group/row relative flex w-full items-center",
              !active && "hover:bg-foreground/5 clip-corner-lg",
              active && "clip-corner-lg bg-primary text-primary-foreground",
            )}
          >
            <button
              type="button"
              onClick={() => {
                onSelect();
              }}
              className={cn(
                // Slack-style selection: the active channel sits on a filled primary
                // rectangle with the house cut-corner chamfer (matches ChannelSidebar).
                "flex flex-1 min-w-0 items-center gap-2 pl-3 pr-2 py-1.5 touch:py-3 text-sm transition-colors text-left",
                !active && "text-muted-foreground group-hover/row:text-foreground",
                // Unread (but not selected) channels read brighter + bold (Slack).
                // Muted channels never bold — their unread is deliberately silent.
                !active && hasUnread && !muted && "text-foreground font-semibold",
                // Muted channels read dimmer (Discord-style).
                !active && muted && "opacity-60",
                active && "font-medium",
              )}
            >
              <Icon className={cn("size-4 shrink-0", occupied && !active && "text-success")} />
              <span className="truncate flex-1 min-w-0">{channel.name}</span>
              {inCall && <Headphones className={cn("size-3.5 shrink-0", !active && "text-success")} />}
              {muted && <BellOff className="size-3 shrink-0 opacity-60" aria-label="Muted" />}
              {/* Mention indicator: an "@" pill. Plain unread is conveyed by the row's
                  brighter + bold text (no dot). */}
              {hasMention ? (
                <span
                  className="shrink-0 flex items-center justify-center min-w-4 h-4 px-1 rounded-full bg-primary text-primary-foreground text-[10px] font-bold leading-none"
                  aria-label="You were mentioned"
                >
                  @
                </span>
              ) : null}
            </button>
            {/* Quick call CTA (Discord-style): join/start a call in this channel
                without leaving the list. Always visible while a call is live;
                otherwise appears on hover/focus (desktop only — touch devices
                have no hover, so it stays hidden there until a call is live). */}
            {!inCall && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onJoinVoice(channel, broker ?? null, fold);
                }}
                aria-label={occupied ? "Join call" : "Start call"}
                title={occupied ? "Join call" : "Start call"}
                className={cn(
                  "shrink-0 flex items-center justify-center size-7 mr-1 rounded transition-opacity",
                  "opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100",
                  // No hover on touch devices: keep it hidden there unless a call
                  // is already live in the channel.
                  !occupied && "touch:hidden",
                  occupied && "opacity-100",
                  active
                    ? "text-primary-foreground hover:bg-primary-foreground/20"
                    : "text-muted-foreground hover:text-foreground hover:bg-foreground/10",
                  occupied && !active && "text-success",
                )}
              >
                <Phone className="size-3.5" />
              </button>
            )}
          </div>
          {/* Discord-style nested voice roster: who's in the call, under the row
              (with live speaking rings while you're in it). Shown whenever a
              call is live in the channel. */}
          {occupied && (
            <VoiceParticipantList
              participants={participants}
              speaking={speaking}
              muted={mutedVoice}
              raised={raisedVoice}
            />
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        {community && (
          <NotifLevelMenu
            label="Channel notifications"
            level={concordChannelLevel("c2", community.idHex, channel.idHex)}
            onChange={(lvl) =>
              setNotifLevel(concordChannelScopeKey("c2", community.idHex, channel.idHex), lvl)
            }
          />
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * The community-wide "@ Mentions" pane: every cached kind-9 message that
 * p-tags the current user, across all channels, newest-first — read purely
 * from the local decrypted rumor cache. Each message is grouped under a header
 * naming its source channel; clicking a mention jumps to that message in its
 * channel. The rows reuse the shared `ChatMessage` shell (read-only — no
 * react/reply/delete in this aggregate view).
 */
function MentionsView({
  channels,
  mentions,
  isLoading,
  onJump,
}: {
  channels: ChannelV2[];
  mentions: ChatMsg[];
  isLoading: boolean;
  onJump: (channelIdHex: string, messageId: string) => void;
}) {
  const nameByChannel = useMemo(() => {
    const m = new Map<string, ChannelV2>();
    for (const c of channels) m.set(c.idHex, c);
    return m;
  }, [channels]);

  if (mentions.length === 0) {
    return (
      <p className="px-2 py-8 text-center text-sm text-muted-foreground">
        {isLoading ? "Loading mentions…" : "No mentions yet. When someone @-mentions you, it'll show up here."}
      </p>
    );
  }

  return (
    <div className="flex flex-col py-2 px-2">
      {mentions.map((msg) => {
        const channelIdHex = msg.tags.find((t) => t[0] === "channel")?.[1] ?? "";
        const ch = nameByChannel.get(channelIdHex);
        return (
          <div key={msg.id} className="pb-1">
            <div className="flex items-center gap-1 px-3 pt-2 pb-0.5 text-xs font-medium text-muted-foreground">
              {ch?.isPrivate ? (
                <Lock className="size-3 shrink-0" />
              ) : (
                <Hash className="size-3 shrink-0" />
              )}
              <span className="truncate">{ch?.name ?? "unknown channel"}</span>
            </div>
            <MentionMessage
              event={msg}
              onJump={ch ? () => onJump(channelIdHex, msg.id) : undefined}
            />
          </div>
        );
      })}
    </div>
  );
}

/**
 * A single read-only mention row (unsigned rumor → "View event JSON" menu).
 * The row is a button that jumps to the message in its channel; the inner
 * `ChatMessage`'s own controls (context menu, links) stop propagation so they
 * still work, and text remains selectable.
 */
const MentionMessage = memo(function MentionMessage({
  event,
  onJump,
}: {
  event: ChatMsg;
  onJump?: () => void;
}) {
  const rumor = useMemo(() => {
    const { sig: _sig, ...rest } = event;
    return rest;
  }, [event]);
  return (
    <div
      role={onJump ? "button" : undefined}
      tabIndex={onJump ? 0 : undefined}
      onClick={onJump ? () => onJump() : undefined}
      onKeyDown={
        onJump
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onJump();
              }
            }
          : undefined
      }
      className={cn("clip-corner-lg", onJump && "cursor-pointer hover:bg-foreground/5 transition-colors")}
      aria-label={onJump ? "Jump to this message" : undefined}
    >
      <ChatMessage event={event} rumor={rumor} canWrite={false} canModerate={false} />
    </div>
  );
});

/**
 * The community-wide "Threads" pane: every thread the current user has
 * participated in (authored the root or a reply), newest-reply first, read
 * purely from the local rumor cache. Each row shows the thread root plus a
 * reply summary; clicking it switches to that channel and opens the thread
 * panel. Unread rows (a newer reply than last opened) light up.
 */
function ThreadsView({
  channels,
  threads,
  isLoading,
  onOpen,
}: {
  channels: ChannelV2[];
  threads: Concord2Thread[];
  isLoading: boolean;
  onOpen: (thread: Concord2Thread) => void;
}) {
  const nameByChannel = useMemo(() => {
    const m = new Map<string, ChannelV2>();
    for (const c of channels) m.set(c.idHex, c);
    return m;
  }, [channels]);

  if (threads.length === 0) {
    return (
      <p className="px-2 py-8 text-center text-sm text-muted-foreground">
        {isLoading
          ? "Loading threads…"
          : "No threads yet. Threads you start or reply in will show up here."}
      </p>
    );
  }

  return (
    <div className="flex flex-col py-2 px-2">
      {threads.map((t) => {
        const ch = nameByChannel.get(t.channelIdHex);
        return (
          <div key={t.root.id} className="pb-1">
            <div className="flex items-center gap-1 px-3 pt-2 pb-0.5 text-xs font-medium text-muted-foreground">
              {ch?.isPrivate ? (
                <Lock className="size-3 shrink-0" />
              ) : (
                <Hash className="size-3 shrink-0" />
              )}
              <span className="truncate">{ch?.name ?? "unknown channel"}</span>
              {t.hasNew ? (
                <span
                  className="ml-1 shrink-0 size-1.5 rounded-full bg-primary"
                  aria-label="New replies"
                />
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => onOpen(t)}
              className={cn(
                "block w-full text-left clip-corner-lg cursor-pointer hover:bg-foreground/5 transition-colors",
                t.hasNew && "bg-primary/5",
              )}
              aria-label="Open thread"
            >
              <ThreadRootPreview event={t.root} />
              <div className="flex items-center gap-2 pl-[3.875rem] pr-3 pb-1.5 -mt-1">
                <ThreadReplyAvatars pubkeys={t.participants} />
                <span
                  className={cn(
                    "text-xs font-medium",
                    t.hasNew ? "text-primary" : "text-muted-foreground",
                  )}
                >
                  {t.replyCount} {t.replyCount === 1 ? "reply" : "replies"}
                </span>
                <span className="text-xs text-muted-foreground">· {shortTimeAgo(t.lastReplyAt)}</span>
              </div>
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** The thread root message, read-only (its click is handled by the row wrapper). */
const ThreadRootPreview = memo(function ThreadRootPreview({ event }: { event: ChatMsg }) {
  const rumor = useMemo(() => {
    const { sig: _sig, ...rest } = event;
    return rest;
  }, [event]);
  return (
    <div className="pointer-events-none">
      <ChatMessage event={event} rumor={rumor} canWrite={false} canModerate={false} />
    </div>
  );
});

/** A small newest-first avatar stack of the thread's repliers. */
function ThreadReplyAvatars({ pubkeys }: { pubkeys: string[] }) {
  const shown = pubkeys.slice(0, 4);
  if (shown.length === 0) return null;
  return (
    <div className="flex -space-x-1.5">
      {shown.map((pk) => (
        <ThreadReplyAvatar key={pk} pubkey={pk} />
      ))}
    </div>
  );
}

function ThreadReplyAvatar({ pubkey }: { pubkey: string }) {
  const author = useAuthor(pubkey);
  const metadata = author.data?.metadata;
  const name = metadata?.name ?? pubkey.slice(0, 8);
  return (
    <Avatar shape={getAvatarShape(metadata)} className="size-5 ring-2 ring-chrome" title={name}>
      <AvatarImage src={metadata?.picture} alt={name} />
      <AvatarFallback className="bg-primary/20 text-primary text-[9px] font-semibold uppercase">
        {name.slice(0, 1)}
      </AvatarFallback>
    </Avatar>
  );
}

/**
 * A Concord V2 community — CORD-01..06 Private Streams over interchangeable
 * relays, no host, no `#z` tags: every plane is kind-1059 traffic at derived
 * stream addresses. Lives at `/c/:communityId`, rehydrated from the
 * self-encrypted Community List. Renders through the SAME shared chat
 * components as NIP-29 / DMs / Concord V1; only the transport differs.
 */
export function ConcordV2Page() {
  const { communityId, channelId: routeChannelId } = useParams<{ communityId: string; channelId: string }>();
  const { user } = useCurrentUser();
  const isTouchDevice = useIsTouch();
  const composerBoundsRef = useRef<HTMLElement | null>(null);
  const { config, updateConfig } = useAppContext();
  const { mutedChannels, isCommunityMuted, toggleCommunityMute, toggleConcordChannelMute } = useMutes();
  const lastChannelKey = communityId ? `c2:${communityId}` : "";

  const baseCommunity = useCommunity2(communityId);
  const { data: folded } = useControlFold2(baseCommunity);
  // Overlay the folded, owner-controlled metadata onto the bundle preview.
  const community = useMemo<CommunityV2 | undefined>(() => {
    if (!baseCommunity) return undefined;
    if (!folded?.metadata) return baseCommunity;
    return { ...baseCommunity, name: folded.metadata.name || baseCommunity.name };
  }, [baseCommunity, folded]);
  const channels = useChannels2(baseCommunity);
  // Only show channel skeletons if there's nothing to render yet AND that has
  // lasted long enough to be worth a placeholder. On a cache hit the bundle
  // resolves within a frame or two, so the skeleton would otherwise flash for a
  // nanosecond — which reads as a glitch. Delay it so fast loads show nothing.
  const showChannelSkeleton = useDelayedFlag(!community || channels.length === 0);

  // Per-channel unread badges, computed purely from the local rumor cache
  // (which the wire keeps fed for every channel of every community).
  const gitAttachmentsByChannel = useMemo(() => new Map(channels.map((candidate) => [
    candidate.idHex,
    channelGitRepositoryAttachments(folded?.channels.get(candidate.idHex)?.metadata ?? { name: candidate.name, private: candidate.isPrivate }),
  ])), [channels, folded]);
  const communityGitActivity = useCommunityGitActivity(gitAttachmentsByChannel);
  // The Projects tab exists only once some channel is tied to a repository.
  const hasProjects = useMemo(
    () => [...gitAttachmentsByChannel.values()].some((list) => list.some((attachment) => attachment.detachedAt === undefined)),
    [gitAttachmentsByChannel],
  );
  const { byChannel: unreadByChannel, markRead: markChannelRead } = useConcord2Unread(channels, communityGitActivity.byChannel);

  // "Mark all as read": stamp every unread channel to its newest unread
  // message (monotonic stamps, so already-read channels no-op).
  const markAllChannelsRead = useCallback(() => {
    for (const [idHex, unread] of Object.entries(unreadByChannel)) {
      markChannelRead(idHex, unread.latest);
    }
  }, [unreadByChannel, markChannelRead]);

  // Community-wide "@ Mentions" — every cached kind-9 that p-tags the user,
  // across all channels, served from the local rumor cache only. Its unread
  // indicator has its OWN read state (not the channel read state), so opening
  // the Mentions tab clears it without visiting every mentioning channel
  // (issue #53; see the auto-mark effect below).
  const {
    mentions,
    isLoading: mentionsLoading,
    hasNew: hasUnreadMention,
    markRead: markMentionsRead,
    markAllRead: markAllMentionsRead,
  } = useConcord2Mentions(channels, community?.idHex);

  // Community-wide "Threads" — threads the user participated in (authored the
  // root or a reply), newest-reply first, from the local rumor cache only.
  // Lights up when any has replies newer than the user last opened it; opening
  // the Threads pane marks everything in it read (see the auto-mark effect
  // below).
  const {
    threads,
    isLoading: threadsLoading,
    hasNew: hasNewThreadReplies,
    markRead: markThreadRead,
    markAllRead: markAllThreadsRead,
  } = useConcord2Threads(channels);

  // Authenticate the connection as this community's per-channel stream keys
  // (control/guestbook/dissolved keys are registered app-wide in MainLayout).
  useRegisterChannelStreamKeys2(communityId);

  // React to base-rekey rotations (adopt the new epoch, or discover removal).
  // `stranded`: a stale invite dropped us onto a superseded epoch with no wire
  // path forward — the link is out of date and only a refresh/Direct Invite heals.
  const { stranded } = useRekeyWatch2(baseCommunity);
  // And per-held-private-channel rotations (CORD-06 §2): adopt fresh channel
  // keys or drop a channel we've been removed from. No-op without any.
  useChannelRekeyWatch2(baseCommunity);
  // Keep our OWN live invite links vending the current epoch (CORD-05 §2), so a
  // rotation on another device / by another admin doesn't leave them stale.
  useLinkRefreshWatch2(baseCommunity);
  // Follow the fold's relay list (CORD-02 §6): a Metadata edition that moves
  // the community's relays re-points this member (and, via the 13302
  // write-back, their other devices) at the new set.
  useRelayFollow2(baseCommunity);
  // Honest-client compliance: a stripped CREATE_INVITE means my own live
  // links must die — only my signer_sk can tombstone their bundles.
  useLinkAuthorityWatch2(baseCommunity);
  // Durable read-cut: finish a rotating ban's rotation that a relay outage
  // dropped, from the keep-list persisted at ban time. Mounted ONCE here.
  useReadCutRetry2(baseCommunity);
  // Stranded self-heal: while stranded, quietly re-resolve the link we joined
  // through; once its creator refreshes the bundle, merge the fresh epoch in.
  const { canRecover, checking: recoveryChecking, checkNow: recoveryCheckNow } = useStrandedRecovery2(baseCommunity, stranded);

  // Kicked/banned: the community stays on the rail but goes read-only (the
  // composer is swapped for a banner). Cleared automatically if re-included.
  const excluded = useIsExcluded2(communityId);

  const [channelIdHex, setChannelIdHex] = useState<string | null>(routeChannelId ?? null);
  useEffect(() => {
    if (routeChannelId) setChannelIdHex(routeChannelId);
  }, [routeChannelId]);
  // Which pane the main area shows: the selected channel's chat, the
  // community-wide "@ Mentions" list, the "Threads" list, or the "Projects"
  // view. Selecting a channel returns to chat.
  const [view, setView] = useState<"channel" | "mentions" | "threads" | "projects" | "audit" | "invites" | "banned" | "health">("channel");
  useEffect(() => {
    if (routeChannelId) setView("channel");
  }, [routeChannelId]);
  const selectChannel = useCallback((idHex: string) => {
    setChannelIdHex(idHex);
    setView("channel");
  }, []);
  // Projects data loads lazily: the first time the tab is opened this session,
  // or when a ticket conversation opens (its trust set and thread need it).
  const [projectsTouched, setProjectsTouched] = useState(false);
  const [openTicket, setOpenTicket] = useState<GitTicket | undefined>();
  const channelNameById = useMemo(() => new Map(channels.map((c) => [c.idHex, c.name])), [channels]);
  const projects = useGitProjects(gitAttachmentsByChannel, channelNameById, projectsTouched || Boolean(openTicket));
  // A pending "jump to message" target set by clicking a mention: switch to its
  // channel, then scroll+highlight it once that channel's timeline has loaded
  // it (an effect below fires when the message appears in `allMessages`).
  const [jumpTarget, setJumpTarget] = useState<{ channelIdHex: string; messageId: string } | null>(null);
  const timelineRef = useRef<MessageTimelineHandle | null>(null);
  const jumpToMention = useCallback(
    (channelIdHex: string, messageId: string) => {
      setJumpTarget({ channelIdHex, messageId });
      selectChannel(channelIdHex);
      setChannelsOpen(false);
    },
    [selectChannel],
  );
  // Opening a thread from the Threads tab: switch to its channel, then open the
  // thread panel once that channel's transport has the root loaded (an effect
  // below fires when the root appears in `allMessages`). Marks the thread read
  // and drops its "new" highlight (the auto-mark below keeps rows lit for the
  // visit, but actually opening one means it's been read for real).
  const [pendingThread, setPendingThread] = useState<Concord2Thread | null>(null);
  const openThreadFromList = useCallback(
    (thread: Concord2Thread) => {
      markThreadRead(thread.root.id, thread.lastReplyAt);
      setFreshThreadIds((prev) => {
        if (!prev.has(thread.root.id)) return prev;
        const next = new Set(prev);
        next.delete(thread.root.id);
        return next;
      });
      setPendingThread(thread);
      selectChannel(thread.channelIdHex);
      setChannelsOpen(false);
    },
    [selectChannel, markThreadRead],
  );

  // Having the Mentions pane on screen counts as reading it, same as Threads
  // below: the list is flat and newest-first, so the pane being visible means
  // the newest mention is too — advance the last-seen stamp immediately, and
  // again as new mentions land while the pane stays open. Visibility-gated so
  // a background tab doesn't silently eat the badge. (Unlike Threads there's
  // no per-row "new" highlight to preserve, so no snapshot.)
  useEffect(() => {
    if (view !== "mentions" || !user || !hasUnreadMention) return;
    const stamp = () => {
      if (document.visibilityState === "visible") markAllMentionsRead();
    };
    stamp();
    document.addEventListener("visibilitychange", stamp);
    return () => document.removeEventListener("visibilitychange", stamp);
  }, [view, user, hasUnreadMention, markAllMentionsRead]);

  // Having the Threads pane on screen counts as reading it: every listed
  // thread with unseen replies is marked read (the sidebar dot clears by just
  // looking — no manual "mark all"), immediately and as new replies or the
  // initial scan land while the pane stays open. The rows keep their "new"
  // highlight for the visit, though: `freshThreadIds` snapshots each root as
  // it's auto-cleared so the visual survives the read map advancing, and
  // resets on leaving the pane. Visibility-gated like the channel read stamp
  // below, so a background tab doesn't silently eat unread threads.
  const [freshThreadIds, setFreshThreadIds] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (view !== "threads") {
      setFreshThreadIds((prev) => (prev.size === 0 ? prev : new Set()));
      return;
    }
    if (!user || !hasNewThreadReplies) return;
    const stamp = () => {
      if (document.visibilityState !== "visible") return;
      setFreshThreadIds((prev) => {
        let next: Set<string> | undefined;
        for (const t of threads) {
          if (t.hasNew && !prev.has(t.root.id)) (next ??= new Set(prev)).add(t.root.id);
        }
        return next ?? prev;
      });
      markAllThreadsRead();
    };
    stamp();
    document.addEventListener("visibilitychange", stamp);
    return () => document.removeEventListener("visibilitychange", stamp);
  }, [view, user, hasNewThreadReplies, threads, markAllThreadsRead]);

  // What the Threads pane renders: the live list, with the just-auto-cleared
  // roots still lit as "new" for this visit.
  const displayedThreads = useMemo(
    () =>
      threads.map((t) =>
        !t.hasNew && freshThreadIds.has(t.root.id) ? { ...t, hasNew: true } : t,
      ),
    [threads, freshThreadIds],
  );
  // Let `#channel-name` hashtags in chat jump to that local channel.
  const navChannels = useMemo(
    () => channels.map((c) => ({ name: c.name, go: () => selectChannel(c.idHex) })),
    [channels, selectChannel],
  );
  const channelNav = useChannelNavValue(navChannels);

  const channel = useMemo(() => {
    if (channels.length === 0) return undefined;
    if (channelIdHex) return channels.find((c) => c.idHex === channelIdHex) ?? channels[0];
    return pickDefaultChannel(
      channels,
      config.lastChannelByServer[lastChannelKey],
      (c) => c.idHex,
      (c) => c.name,
    );
  }, [channels, channelIdHex, config.lastChannelByServer, lastChannelKey]);

  // Individual mute states for the ⋮ menu. Like GroupPage, the side-by-side
  // "Mute channel" / "Mute community" items each reflect only their own scope
  // (no cascade), so a muted community doesn't flip the channel item.
  const channelMuted = Boolean(
    community && channel &&
    mutedChannels.has(concordChannelMuteKey("c2", community.idHex, channel.idHex)),
  );
  const communityMuted = Boolean(community && isCommunityMuted(`c2:${community.idHex}`));

  useEffect(() => {
    if (!lastChannelKey || !channel) return;
    updateConfig((c) =>
      c.lastChannelByServer[lastChannelKey] === channel.idHex
        ? c
        : { ...c, lastChannelByServer: { ...c.lastChannelByServer, [lastChannelKey]: channel.idHex } },
    );
  }, [channel, lastChannelKey, updateConfig]);

  const { setTier } = useRoles2(community);
  const ownerHex = folded?.ownerHex ?? community?.owner;
  const iAmOwner = Boolean(user && ownerHex && user.pubkey === ownerHex);
  const roster = folded?.roster;
  const canManageRoles = Boolean(user && folded && isAuthorized(folded.roster, user.pubkey, ownerHex, Permissions.MANAGE_ROLES));
  const canManageMetadata = Boolean(user && folded && isAuthorized(folded.roster, user.pubkey, ownerHex, Permissions.MANAGE_METADATA));
  const canManageChannels = Boolean(user && folded && isAuthorized(folded.roster, user.pubkey, ownerHex, Permissions.MANAGE_CHANNELS));
  const canCreateInvite = Boolean(user && folded && isAuthorized(folded.roster, user.pubkey, ownerHex, Permissions.CREATE_INVITE));
  const canKickAny = Boolean(user && folded && isAuthorized(folded.roster, user.pubkey, ownerHex, Permissions.KICK));
  const canBanAny = Boolean(user && folded && isAuthorized(folded.roster, user.pubkey, ownerHex, Permissions.BAN));
  const canModerateMessages = Boolean(user && folded && isAuthorized(folded.roster, user.pubkey, ownerHex, Permissions.MANAGE_MESSAGES));
  // A dissolved community is terminal: the owner has torn it down, so no key
  // rotation or new messages will ever land. Keep it fully readable (members
  // asked to still see the history), but freeze every write path.
  //
  // `excluded` (a moderator rotated the keys without us) and `stranded` (a stale
  // invite dropped us onto a superseded epoch) are equally write-dead: our new
  // messages would be encrypted to keys nobody keeps. All three replace the main
  // composer with a notice; folding them into `canWrite` freezes the same write
  // paths everywhere else too — timeline reply/edit and the thread composer.
  const { data: dissolved } = useDissolved2(community);
  const canWrite = Boolean(user && channel && !dissolved && !excluded && !stranded);

  const { transport: baseTransport, reactionsFor, allMessages, calendar } = useTransport2(community, channel, canWrite, canModerateMessages);
  // Git activity remains its own event domain. The store-first channel hook
  // supplies attached repository activity; this page only merges its display
  // order with decrypted chat rumors.
  const gitAttachments = useMemo(
    () => channelGitRepositoryAttachments(folded?.channels.get(channel?.idHex ?? "")?.metadata ?? { name: channel?.name ?? "", private: Boolean(channel?.isPrivate) }),
    [folded, channel?.idHex, channel?.name, channel?.isPrivate],
  );
  const gitActivity = useChannelGitActivity(channel?.idHex, gitAttachments);
  const mixedEntries = useMemo(() => mergeChannelTimeline(baseTransport.messages, gitActivity.activities), [baseTransport.messages, gitActivity.activities]);
  const newDividerId = useNewMessagesDivider(
    channel?.idHex ?? "",
    mixedEntries.map((entry) => ({
      id: entry.id,
      createdAt: entry.createdAt,
      author: entry.type === "chat" ? entry.message.pubkey : entry.type === "dm-timer" ? entry.author : entry.type === "git-ticket-opened" ? entry.activity.ticket.author : entry.type === "git-comment" ? entry.activity.comment.author : entry.type === "git-ci-run" ? entry.activity.run.author : entry.activity.status.author,
    })),
    user?.pubkey,
  );
  const openProjectItem = useCallback((item: ProjectWorkItem) => {
    const ticket = projects.ticketsById.get(item.id);
    if (!ticket) return;
    setOpenTicket(ticket);
    void projects.refreshTicket(ticket);
  }, [projects]);
  // The conversation panel merges gated channel activity with the Projects
  // view's full history, so a ticket opened from either surface reads complete.
  const panelActivities = useMemo(
    () => projects.activities.length === 0
      ? gitActivity.activities
      : sortAndDedupeGitTimelineActivities([...gitActivity.activities, ...projects.activities]),
    [gitActivity.activities, projects.activities],
  );
  const gitActions = useGitWorkItemActions();
  // The ticket's repository as this community holds it (address + trust set).
  // No first-tag fallback: `a` tag order is author-controlled, so guessing
  // could grant a fork owner status controls (and mis-tag emitted statuses)
  // while the projects data is still loading. Controls appear once it lands.
  const ticketRepository = useCallback((ticket: GitTicket): GitWorkItemRepository | undefined => {
    const held = new Set(projects.repos.map((repo) => repo.coord));
    const address = matchGitTicketRepository(ticket, held);
    if (!address) return undefined;
    const repo = projects.repos.find((candidate) => candidate.coord === address.coordinate);
    return { address, maintainers: repo?.contributors ?? [] };
  }, [projects.repos]);
  const canSetTicketStatus = useMemo(() => {
    if (!user?.pubkey || !openTicket) return false;
    const repository = ticketRepository(openTicket);
    if (!repository) return false;
    return trustedGitStatusAuthors(
      openTicket,
      { owner: repository.address.owner, maintainers: [...repository.maintainers] },
    ).has(user.pubkey);
  }, [user?.pubkey, openTicket, ticketRepository]);
  const ticketActions = useMemo(() => ({
    viewerPubkey: user?.pubkey,
    onComment: user
      ? async (ticket: GitTicket, content: string, media?: readonly string[][]) => {
          await gitActions.commentOnTicket(ticket, content, projects.relaysForCoordinates(ticket.repositoryAddresses.map((address) => address.coordinate)), media);
        }
      : undefined,
    onEditComment: user
      ? async (ticket: GitTicket, comment: GitComment, content: string) => {
          await gitActions.editTicketComment(ticket, comment, content, projects.relaysForCoordinates(ticket.repositoryAddresses.map((address) => address.coordinate)));
        }
      : undefined,
    onDeleteComment: user
      ? async (ticket: GitTicket, comment: GitComment) => {
          await gitActions.deleteTicketComment(ticket, comment, projects.relaysForCoordinates(ticket.repositoryAddresses.map((address) => address.coordinate)));
        }
      : undefined,
    onSetStatus: async (ticket: GitTicket, statusKind: GitStatusKind) => {
      const repository = ticketRepository(ticket);
      if (!repository) return;
      await gitActions.setTicketStatus(ticket, repository, statusKind, projects.relaysForCoordinates([repository.address.coordinate]));
    },
    canSetStatus: canSetTicketStatus,
  }), [user, gitActions, projects, ticketRepository, canSetTicketStatus]);
  const handleCreateIssue = useCallback(async (repoCoord: string, subject: string, body: string, media?: readonly string[][], labels?: readonly string[]) => {
    const address = parseGitRepositoryAddress(repoCoord);
    if (!address) throw new Error("Unknown repository.");
    const repo = projects.repos.find((candidate) => candidate.coord === repoCoord);
    await gitActions.openIssue({ address, maintainers: repo?.contributors ?? [] }, subject, body, projects.relaysForCoordinates([repoCoord]), media, labels);
  }, [gitActions, projects]);
  const { mutateAsync: send } = useSendMessage2(community, channel);

  // (useActiveRoom is called below, after `threadRoot` is defined, so it can
  // also pass thread-level keys for notification suppression.)

  // Fulfil a pending mention jump once the target channel is active and its
  // timeline has loaded the target message. MessageTimeline queues the jump
  // while its opening window is still mounting, so this can run immediately
  // after the channel switch without a timing delay.
  useEffect(() => {
    if (!jumpTarget || view !== "channel") return;
    if (channel?.idHex !== jumpTarget.channelIdHex) return;
    if (!allMessages.some((m) => m.id === jumpTarget.messageId)) return;
    if (timelineRef.current?.scrollToMessage(jumpTarget.messageId)) {
      setJumpTarget(null);
    }
  }, [jumpTarget, view, channel?.idHex, allMessages]);

  // Mark the open channel read up to its newest timeline entry (chat or git)
  // while it's on screen —
  // immediately and again on tab refocus (mirrors GroupChat's NIP-29 behavior).
  // Reading a channel naturally also consumes what it shows: mentions of the
  // user and new replies in threads they participate in get their own stamps
  // advanced too, so the Mentions/Threads tabs don't re-badge what was already
  // read here.
  const channelIdForRead = channel?.idHex;
  const readerPubkey = user?.pubkey;
  useEffect(() => {
    if (!readerPubkey || !channelIdForRead || mixedEntries.length === 0) return;
    const latest = mixedEntries[mixedEntries.length - 1]?.createdAt ?? 0;
    if (latest <= 0) return;

    // The newest visible mention of the user (never self-authored — the tab
    // doesn't surface self-mentions), and the newest visible reply per
    // participated thread.
    let newestMention = 0;
    const followedRoots = new Set(threads.map((t) => t.root.id));
    const replyStamps = new Map<string, number>();
    for (const m of allMessages) {
      if (
        m.pubkey !== readerPubkey &&
        m.created_at > newestMention &&
        m.tags.some(([n, v]) => n === "p" && v === readerPubkey)
      ) {
        newestMention = m.created_at;
      }
      const root = replyTargetOf(m);
      if (root && followedRoots.has(root) && m.created_at > (replyStamps.get(root) ?? 0)) {
        replyStamps.set(root, m.created_at);
      }
    }

    const stamp = () => {
      if (document.visibilityState !== "visible") return;
      markChannelRead(channelIdForRead, latest);
      if (newestMention > 0) markMentionsRead(newestMention);
      for (const [root, ts] of replyStamps) markThreadRead(root, ts);
    };
    stamp();
    document.addEventListener("visibilitychange", stamp);
    return () => document.removeEventListener("visibilitychange", stamp);
  }, [readerPubkey, channelIdForRead, mixedEntries, allMessages, threads, markChannelRead, markMentionsRead, markThreadRead]);

  const { leave, isLeaving, dissolve, createChannel } = useCommunityManagement2(community);
  const handleCreateTextChannel = useCallback(async (name: string) => {
    const { channelIdHex: created } = await createChannel({ name });
    selectChannel(created);
  }, [createChannel, selectChannel]);
  const handleCreateRepositoryChannel = useCallback(async (name: string, repository: WizardRepository) => {
    const { channelIdHex: created } = await createChannel({
      name,
      repository: { address: repository.coordinate, relayHints: repository.relayHints },
    });
    selectChannel(created);
  }, [createChannel, selectChannel]);
  // Repositories already connected anywhere in this community (wizard dedupe).
  const connectedCoordinates = useMemo(
    () => new Set([...gitAttachmentsByChannel.values()].flatMap((list) => list.filter((a) => a.detachedAt === undefined).map((a) => a.address.coordinate))),
    [gitAttachmentsByChannel],
  );
  const { coalesced } = useGuestbook2(community);

  // Voice (CORD-07): the active channel's live presence + rendezvous broker
  // (both no-op for text channels) power the join button.
  const { joinConcordCall, activeCall, speakingPubkeys, mutedPubkeys } = useCall();
  const activeFold = useVoicePresence2(community, channel);
  const { data: activeBroker } = useVoiceBroker2(channel, activeFold);
  const inThisVoice = Boolean(
    activeCall?.concord && channel && activeCall.concord.channel.idHex === channel.idHex,
  );

  const handleJoinVoice = useCallback(
    async (ch: ChannelV2, broker: string | null, fold?: VoicePresenceFold) => {
      if (!community || !user) return;
      if (activeCall?.concord?.channel.idHex === ch.idHex) return; // already there
      let resolved = broker;
      if (!resolved) {
        // The broker query may still be loading, or a transient probe failure
        // cached `null` — re-run the rendezvous live instead of refusing.
        const roomHex = ch.voice.room.pk;
        resolved = roomHex
          ? await resolveVoiceBroker(roomHex, fold ?? { present: [], claims: new Map() })
          : null;
      }
      if (!resolved) {
        toast({
          title: "Voice unavailable",
          description: "No reachable voice server. You can set one under Settings → Voice.",
          variant: "destructive",
        });
        return;
      }
      joinConcordCall({ community, channel: ch, broker: resolved });
    },
    [community, user, activeCall, joinConcordCall],
  );

  const navigateTo = useNavigate();
  // Compliant self-removal: if the folded Banlist names ME, silently tear
  // down the local copy and route home (CORD-04 §4).
  useBanSelfRemove2(baseCommunity, useCallback(() => navigateTo("/"), [navigateTo]));
  const [creatingChannel, setCreatingChannel] = useState(false);

  // Close the create-channel wizard when switching communities — the user's
  // MANAGE_CHANNELS permission doesn't carry over.
  useEffect(() => {
    setCreatingChannel(false);
    setCommunityMenuOpen(false);
  }, [communityId]);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [rolesOpen, setRolesOpen] = useState(false);
  const [banTarget, setBanTarget] = useState<string | null>(null);
  // The community-name header menu (Discord-style): expands inline below the
  // header, pushing the channel list down with a height animation.
  const [communityMenuOpen, setCommunityMenuOpen] = useState(false);
  /** Member roster pane, persisted in app config (`memberListVisible`). Defaults
   * OFF on touch devices (a landscape phone crosses the 900px breakpoint but is
   * too short to spare the roster width); openable from the header toggle. On
   * real desktop it stays on. Once the user hides or shows it, that choice is
   * remembered across visits. */
  const membersVisible = config.memberListVisible ?? !isTouchDevice;
  const toggleMembersVisible = () =>
    updateConfig((c) => ({ ...c, memberListVisible: !(c.memberListVisible ?? !isTouchDevice) }));
  const [membersOpen, setMembersOpen] = useState(false);
  // Header message search: expands inline over the header, swapping the timeline
  // for community-wide (cross-channel) results while active. `searchFilters`
  // holds the structured query (text + channels + authors + media facet).
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchFilters, setSearchFilters] = useState<SearchFilters2>(EMPTY_SEARCH_FILTERS);
  const [eventsOpen, setEventsOpen] = useState(false);
  const [createEventOpen, setCreateEventOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Mobile: landing on the community root (no channel in the URL) shows the
  // channel list, not a chat pane — selecting a community should let you pick a
  // channel, not auto-dive into one. A deep link with a channel opens chat
  // directly. (On desktop the SwipeReveal is inert — both panes always show.)
  const [channelsOpen, setChannelsOpen] = useState(!routeChannelId);
  // This page instance is reused across community switches (the route pattern
  // is stable), so the initial state above only applies to the first mount.
  // Reset the reveal state to match the destination route *during render* (not
  // in a post-paint effect): switching community navigates to its root
  // (no channel), so `channelsOpen` must already be `true` on the first render
  // after the route change. A lagging effect would paint one frame of the
  // (stale) chat pane first — the "flash of the previous chat" glitch. A deep
  // link with a channel opens chat directly.
  const [navKey, setNavKey] = useState(`${communityId}\u0000${routeChannelId ?? ""}`);
  const curNavKey = `${communityId}\u0000${routeChannelId ?? ""}`;
  if (navKey !== curNavKey) {
    setNavKey(curNavKey);
    setChannelsOpen(!routeChannelId);
  }
  const [threadRoot, setThreadRoot] = useState<ChatMsg | undefined>(undefined);
  const [threadAutoFocus, setThreadAutoFocus] = useState(false);
  const [lastThreadRoot, setLastThreadRoot] = useState<ChatMsg | undefined>(undefined);
  const [threadExpanded, setThreadExpanded] = useState(false);
  // Close the thread panel when the channel or community changes. The scope
  // key includes `communityId` because the page is reused across concord
  // switches (no route `key`), and `channel?.idHex` alone can lag during the
  // transition. `lastThreadRoot` is cleared here (not just via the slide-out
  // timeout) because the timeout only re-runs when `threadRoot` changes; if
  // the panel was already closed, it wouldn't fire.
  const threadScopeKey = `${communityId}\u0000${channel?.idHex ?? ""}`;
  const [threadChannelKey, setThreadChannelKey] = useState(threadScopeKey);
  if (threadChannelKey !== threadScopeKey) {
    setThreadChannelKey(threadScopeKey);
    if (!pendingThread) {
      setThreadRoot(undefined);
      setLastThreadRoot(undefined);
    }
  }
  // Search is community-wide, so it survives channel switches but resets when
  // the community changes.
  const [searchCommunityKey, setSearchCommunityKey] = useState(communityId);
  if (searchCommunityKey !== communityId) {
    setSearchCommunityKey(communityId);
    setSearchOpen(false);
    setSearchFilters(EMPTY_SEARCH_FILTERS);
  }
  const [replyTo, setReplyTo] = useState<ChatMsg | undefined>(undefined);
  const [activeId, setActiveId] = useState<string | undefined>(undefined);
  const [editingId, setEditingId] = useState<string | undefined>(undefined);
  const toggleActive = useCallback((id: string) => setActiveId((cur) => (cur === id ? undefined : id)), []);

  // Tell the native notification service this channel (and, if a thread panel
  // is open, that specific thread) is on screen, so it suppresses redundant
  // tray entries. Cleared on unmount/background. The roomKey shapes must match
  // the service: `c2:<channelIdHex>` for the channel, `c2:<channelIdHex>:t:<rootId>`
  // for a specific open thread.
  useActiveRoom(
    channel?.idHex ? `c2:${channel.idHex}` : undefined,
    channel?.idHex && threadRoot ? `c2:${channel.idHex}:t:${threadRoot.id}` : undefined,
  );

  // Member list: the coalesced Guestbook (joins) ∪ observed authors ∪ roster,
  // minus the banned — the Complete Memberlist (CORD-02 §5).
  const memberAdmins = useMemo(() => {
    const out: Array<{ pubkey: string; roles: string[] }> = [];
    if (ownerHex) out.push({ pubkey: ownerHex, roles: ["owner"] });
    if (roster) {
      for (const g of roster.grants) {
        if (g.member === ownerHex) continue;
        const badge = badgeOf(roster, g.member);
        if (badge) out.push({ pubkey: g.member, roles: [badge] });
      }
    }
    return out;
  }, [roster, ownerHex]);

  const memberPubkeys = useMemo(() => {
    const banned = folded?.banned ?? new Set<string>();
    // Observed authors: newest ms each pubkey was seen publishing. `created_at`
    // is seconds; the Guestbook fold compares against millisecond kick/leave
    // times, so scale up. This lets `completeMemberlist` drop a kicked member
    // whose only presence is stale chat history, while an author still active
    // AFTER their kick correctly re-enters.
    const observed = new Map<string, number>();
    for (const m of allMessages) {
      const seenMs = m.created_at * 1000;
      const prev = observed.get(m.pubkey);
      if (prev === undefined || seenMs > prev) observed.set(m.pubkey, seenMs);
    }
    const set = completeMemberlist(coalesced, observed, banned, folded?.bannedAt);
    for (const g of roster?.grants ?? []) if (g.roleIds.length > 0 && !banned.has(g.member)) set.add(g.member);
    if (ownerHex) set.add(ownerHex);
    if (user && !banned.has(user.pubkey)) set.add(user.pubkey);
    return [...set];
  }, [coalesced, allMessages, roster, ownerHex, user, folded]);

  const openThread = useCallback((event: ChatMsg, focusReply = false) => {
    setThreadAutoFocus(focusReply);
    setThreadRoot(event);
    // Mark the thread read up to its newest reply so the Threads tab clears
    // its "new" highlight no matter which entry point opened it (inline
    // reply badge, reply icon, /thread command, or the Threads-tab list).
    // `openThreadFromList` stamps eagerly on click; this is the catch-all.
    const replies = baseTransport.threadRepliesFor?.(event.id) ?? EMPTY_REPLIES;
    const latest = replies.length > 0 ? replies[replies.length - 1].created_at : event.created_at;
    markThreadRead(event.id, latest);
  }, [baseTransport, markThreadRead]);

  // Inline-reply plumbing: a by-id lookup over the decoded set (rumors aren't
  // relay-fetchable, so the "replying to …" line resolves the parent locally),
  // and a jump-to-message handler for clicking that line.
  const messagesById = useMemo(() => {
    const m = new Map<string, ChatMsg>();
    for (const msg of allMessages) m.set(msg.id, msg);
    return m;
  }, [allMessages]);
  const jumpWithinChannel = useCallback((id: string) => {
    timelineRef.current?.scrollToMessage(id);
  }, []);

  // Focus the search field when it expands. `preventScroll` matters: the input
  // starts off-screen (translated right) and slides in, so a default focus()
  // would scroll the page to reveal it — a visible jolt.
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus({ preventScroll: true });
  }, [searchOpen]);
  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchFilters(EMPTY_SEARCH_FILTERS);
  }, []);
  // Every channel in the community — the default search scope when the filter
  // picks no specific channels.
  const allChannelIds = useMemo(() => channels.map((c) => c.idHex), [channels]);
  // Community-wide message search over the local decrypted rumor store. The
  // filters are only fed in while the bar is open, so closing it stops search.
  const {
    results: searchResults,
    isLoading: searchLoading,
    active: searching,
  } = useConcordSearch2(allChannelIds, searchOpen ? searchFilters : EMPTY_SEARCH_FILTERS);

  // Fulfil a pending Threads-tab open: once its channel is active and the
  // transport has loaded the root, open the thread panel with the freshly
  // resolved root (so replies bucket correctly), then clear the target.
  useEffect(() => {
    if (!pendingThread) return;
    if (channel?.idHex !== pendingThread.channelIdHex) return;
    const loaded = allMessages.find((m) => m.id === pendingThread.root.id);
    if (!loaded) return;
    openThread(loaded);
    setPendingThread(null);
  }, [pendingThread, channel?.idHex, allMessages, openThread]);

  // Auto-open the thread panel when arrived via a notification deep-link
  // (`?thread=<rootId>` — the service appends it for kind-1111 Concord
  // replies). Mirrors the NIP-29 GroupChat behavior: fires once per param,
  // then clears it so a later load doesn't snap back.
  const [searchParams, setSearchParams] = useSearchParams();
  const ticketParam = searchParams.get("ticket");
  // Git notification deep links use the stable ticket event id. Wait for the
  // local activity query, focus the matching panel, then consume the parameter.
  useEffect(() => {
    if (!ticketParam || openTicket) return;
    const activity = gitActivity.activities.find((item) => item.type !== "ci-run" && item.ticket.id === ticketParam);
    if (!activity || activity.type === "ci-run") return;
    setOpenTicket(activity.ticket);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("ticket");
      return next;
    }, { replace: true });
  }, [ticketParam, openTicket, gitActivity.activities, setSearchParams]);
  const threadParam = searchParams.get("thread");
  useEffect(() => {
    if (!threadParam || threadRoot || view !== "channel") return;
    const root = allMessages.find((m) => m.id === threadParam);
    if (root) {
      openThread(root);
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete("thread");
          return next;
        },
        { replace: true },
      );
    }
  }, [threadParam, threadRoot, view, allMessages, openThread, setSearchParams]);

  // Keep the thread panel content mounted through its slide-out animation.
  useEffect(() => {
    if (threadRoot) {
      setLastThreadRoot(threadRoot);
      return;
    }
    const t = setTimeout(() => setLastThreadRoot(undefined), 200);
    return () => clearTimeout(t);
  }, [threadRoot]);

  // Inject `openThread` (page-owned panel state) onto the data transport.
  const transport = useMemo(() => ({
    ...baseTransport,
    // A scroll-up page is one mixed operation. Both stores may prepend entries;
    // MessageTimeline owns the single scroll-height restoration around this
    // promise, so chat and Git cannot fight over the reader's anchor.
    isLoading: baseTransport.isLoading || gitActivity.isLoading,
    hasMore: Boolean(baseTransport.hasMore || gitActivity.hasMore),
    isLoadingOlder: Boolean(baseTransport.isLoadingOlder || gitActivity.isLoadingOlder),
    loadOlder: async () => {
      const [chatAdded, gitAdded] = await Promise.all([baseTransport.loadOlder?.() ?? Promise.resolve(0), gitActivity.loadOlder()]);
      return chatAdded + gitAdded;
    },
    openThread,
  }), [baseTransport, gitActivity, openThread]);
  // Recently-active members, for a bot command's `user`-argument picker. Concord
  // hands its timeline to ChatComposer as `messages: []`, so it must supply this.
  const recentAuthors = useMemo(() => authorsByRecency(transport.messages), [transport.messages]);

  // Background catch-up. `channelSyncing` = a sync task scoped to the channel
  // on screen (its backfill/gap-bridge round is running); the timeline uses it
  // for its own quiet catching-up affordance. The passive corner indicator on
  // the header icon surfaces whatever is in flight (self-gated so a
  // sub-second sync never paints), so it needn't hide once the focused channel
  // is live — it simply goes away when there's no work left.
  const syncTasks = useSyncTasks();
  const channelScope = channel ? `c2:${channel.idHex}` : undefined;
  const channelSyncing = Boolean(channelScope && syncTasks.some((t) => t.scope === channelScope));

  const onOpenThreadCb = useMemo(
    () => (canWrite ? (event: ChatMsg) => openThread(event, true) : undefined),
    [canWrite, openThread],
  );

  // Stable identities so an unchanged message row's props don't churn and its
  // `memo` can bail out. `transport` is rebuilt on every message, so reach it
  // through a ref rather than depending on it.
  const transportRef = useRef(transport);
  transportRef.current = transport;
  const startEditing = useCallback((e: ChatMsg) => setEditingId(e.id), []);
  const cancelEditing = useCallback(() => setEditingId(undefined), []);

  const handleEditSubmit = useCallback(async (original: ChatMsg, content: string) => {
    const trimmed = content.trim();
    if (!trimmed || trimmed === original.content.trim()) {
      setEditingId(undefined);
      return;
    }
    setEditingId(undefined);
    try {
      await transportRef.current.editMessage?.(original, trimmed);
    } catch {
      toast({
        title: "Edit failed",
        description: "Could not publish the edit.",
        variant: "destructive",
      });
    }
  }, []);

  // Keep the open thread's read stamp advancing as new replies land while its
  // panel is on screen — mirrors the channel read effect above so the Threads
  // tab's "new" highlight clears for replies that arrive mid-view, not just
  // for replies that were present at open time. Visibility-gated so a
  // backgrounded tab doesn't silently eat the badge.
  const threadRootId = threadRoot?.id;
  useEffect(() => {
    if (!user || !threadRootId) return;
    const replies = transport.threadRepliesFor?.(threadRootId) ?? EMPTY_REPLIES;
    const latest = replies.length > 0 ? replies[replies.length - 1].created_at : threadRoot?.created_at ?? 0;
    if (latest <= 0) return;
    const stamp = () => {
      if (document.visibilityState === "visible") markThreadRead(threadRootId, latest);
    };
    stamp();
    document.addEventListener("visibilitychange", stamp);
    return () => document.removeEventListener("visibilitychange", stamp);
  }, [user, threadRootId, threadRoot?.created_at, transport, markThreadRead]);

  const moderation = useModeration2(community, memberPubkeys);

  const publishTyping = useTypingPublisher2(community, channel);
  const typingPubkeys = useTyping2(community, channel);

  // A dissolved community stays viewable (read-only) rather than redirecting
  // home — members asked to keep seeing the history. `canWrite` (above) is
  // already false when `dissolved`, freezing every write path; the timeline
  // renders a banner + explicit "Remove" button (below) so the member can
  // reap their own list entry when they're ready. The owner's dissolution
  // can't reach into each member's self-encrypted list, so removal MUST be a
  // local, per-member action.

  if (!communityId) return <Navigate to="/" replace />;

  const handleSend = async (content: string, tags: string[][]) => {
    // The composer's content-derived tags (emoji, imeta, mentions) are sealed
    // verbatim; NIP-29 `h` and stray `e` tags are always dropped. An INLINE
    // reply keeps its NIP-C7 `q` (+ the `p` notifying the replied-to author) so
    // it renders quoted in the timeline; a top-level message keeps neither.
    // THREAD replies are a separate path (kind-1111, via `sendThreadReply`).
    const isReply = Boolean(replyTo);
    const extraTags = tags.filter(([name]) =>
      name !== "h" && name !== "e" && (isReply || name !== "q"),
    );
    await send({ content, extraTags });
    setReplyTo(undefined);
  };

  const handleLeave = async () => {
    try {
      await leave();
      navigateTo("/");
    } catch {
      // best-effort
    }
  };

  const handleDissolve = async () => {
    if (!confirm("Permanently dissolve this community for everyone? This cannot be undone.")) return;
    try {
      await dissolve();
      toast({ title: "Community dissolved" });
      navigateTo("/");
    } catch (e) {
      toast({ title: "Couldn't dissolve", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    }
  };

  const handleSetRole = async (pubkey: string, roles: string[]) => {
    const tier = roles.includes("admin") ? ("admin" as const) : roles.includes("moderator") ? ("moderator" as const) : null;
    try {
      await setTier({ member: pubkey, tier });
      toast({ title: tier === "admin" ? "Made admin" : tier === "moderator" ? "Made moderator" : "Role removed" });
    } catch (e) {
      toast({ title: "Couldn't change role", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    }
  };

  // A ban rotates keys unless someone ELSE holds a live link (a rotation
  // would strand it; my own links refresh with the rotation). Judged as-of
  // after this ban: the target's links die with their authority.
  const banWillRotate =
    banTarget !== null && !!folded && !!user && !hasForeignLiveLinks(folded, user.pubkey, banTarget) &&
    moderation.canRekey;

  const runBan = async (target: string, onPhase: (phase: BanPhase) => void) => {
    const { rekeyed, publicBan } = await moderation.ban({ target, onPhase });
    if (rekeyed || publicBan) {
      toast({ title: "Member banned", description: "They are silenced for everyone in this community." });
    } else {
      toast({ title: "Member banned", description: "Added to the banlist; key rotation didn't complete (you can retry)." });
    }
  };

  const channelList = (onNavigate?: () => void, className?: string) => (
    <ChannelSidebarView
      className={className ?? (onNavigate ? "flex-1" : "hidden sidebar:flex")}
      title={
        <button
          type="button"
          className="group flex w-full items-center gap-1 min-w-0 text-left cursor-pointer rounded outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default"
          onClick={() => community && setCommunityMenuOpen((v) => !v)}
          disabled={!community}
          aria-label="Community menu"
          aria-expanded={communityMenuOpen}
        >
          <TitleIcon2 icon={folded?.metadata?.icon} />
          <span className="flex-1 truncate">{community?.name ?? "…"}</span>
          {community && (
            <ChevronDown
              className={cn(
                "size-4 shrink-0 text-muted-foreground transition-transform duration-200",
                communityMenuOpen && "rotate-180",
              )}
            />
          )}
        </button>
      }
      titleExpansion={
        community ? (
          <Collapsible open={communityMenuOpen} onOpenChange={setCommunityMenuOpen}>
            <CollapsibleContent className="overflow-hidden data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up">
              <div className="mx-2 mb-2 mt-1 p-1 space-y-0.5 clip-corner-lg bg-secondary">
                {[
                  {
                    show: Object.keys(unreadByChannel).length > 0,
                    icon: <CheckCheck className="size-4" />,
                    label: "Mark all as read",
                    onClick: markAllChannelsRead,
                  },
                  {
                    show: true,
                    icon: <Settings className="size-4" />,
                    label: "Community settings",
                    onClick: () => setInfoOpen(true),
                  },
                  {
                    show: !!user && !dissolved,
                    icon: <UserPlus className="size-4" />,
                    label: "Invite people",
                    onClick: () => setInviteOpen(true),
                  },
                  {
                    show: canManageChannels && !dissolved,
                    icon: <Plus className="size-4" />,
                    label: "Create channel",
                    onClick: () => setCreatingChannel(true),
                  },
                  {
                    show: canManageRoles && !dissolved,
                    icon: <Shield className="size-4" />,
                    label: "Manage roles",
                    onClick: () => setRolesOpen(true),
                  },
                  {
                    show: true,
                    icon: <ScrollText className="size-4" />,
                    label: "Audit log",
                    // Also close the mobile channel drawer so the view slides
                    // into the <main> overlay (inert on desktop).
                    onClick: () => {
                      setView("audit");
                      setChannelsOpen(false);
                    },
                  },
                  {
                    show: true,
                    icon: <LinkIcon className="size-4" />,
                    label: "Invite links",
                    onClick: () => {
                      setView("invites");
                      setChannelsOpen(false);
                    },
                  },
                  {
                    show: canBanAny,
                    icon: <Ban className="size-4" />,
                    label: "Banned members",
                    onClick: () => {
                      setView("banned");
                      setChannelsOpen(false);
                    },
                  },
                  {
                    show: canManageRoles || canKickAny || canBanAny || canCreateInvite,
                    icon: <HeartPulse className="size-4" />,
                    label: "Member health",
                    onClick: () => {
                      setView("health");
                      setChannelsOpen(false);
                    },
                  },
                  {
                    show: true,
                    icon: communityMuted ? <Bell className="size-4" /> : <BellOff className="size-4" />,
                    label: communityMuted ? "Unmute community" : "Mute community",
                    onClick: () => toggleCommunityMute(`c2:${community.idHex}`),
                  },
                ]
                  .filter((i) => i.show)
                  .map((i) => (
                    <button
                      key={i.label}
                      type="button"
                      className="flex w-full items-center gap-3 px-3 py-2 text-sm text-left transition-colors clip-corner-lg hover:bg-foreground/10"
                      onClick={() => {
                        i.onClick();
                        setCommunityMenuOpen(false);
                      }}
                    >
                      {i.icon}
                      {i.label}
                    </button>
                  ))}
                {user && (
                  <>
                    <div className="mx-1 my-1 h-px bg-border" />
                    <button
                      type="button"
                      disabled={isLeaving}
                      className="flex w-full items-center gap-3 px-3 py-2 text-sm text-left text-destructive transition-colors clip-corner-lg hover:bg-destructive/10 disabled:opacity-50"
                      onClick={() => {
                        handleLeave();
                        setCommunityMenuOpen(false);
                      }}
                    >
                      <LogOut className="size-4" />
                      {dissolved ? "Remove community" : "Leave community"}
                    </button>
                    {iAmOwner && !dissolved && (
                      <button
                        type="button"
                        className="flex w-full items-center gap-3 px-3 py-2 text-sm text-left text-destructive transition-colors clip-corner-lg hover:bg-destructive/10"
                        onClick={() => {
                          handleDissolve();
                          setCommunityMenuOpen(false);
                        }}
                      >
                        <Trash2 className="size-4" />
                        Dissolve community
                      </button>
                    )}
                  </>
                )}
              </div>
            </CollapsibleContent>
          </Collapsible>
        ) : undefined
      }
      banner={folded?.metadata?.banner ? <Banner2 banner={folded.metadata.banner} /> : undefined}
      addChannelLabel={user && community && canManageChannels ? "Add channel" : undefined}
      onAddChannel={user && community && canManageChannels ? () => setCreatingChannel((v) => !v) : undefined}
      addChannelOpen={creatingChannel}
      footer={<SidebarFooter2 />}
      preChannels={
        user && community ? (
          <>
            <SuspiciousActivityBanner2 community={community} folded={folded} ban={moderation.ban} />
            <button
              type="button"
              onClick={() => {
                setView("mentions");
                onNavigate?.();
              }}
              className={cn(
                "flex w-full items-center gap-2 pl-3 pr-2 py-1.5 touch:py-3 text-sm transition-colors text-left clip-corner-lg",
                view === "mentions"
                  ? "bg-primary text-primary-foreground font-medium"
                  : "text-muted-foreground hover:text-foreground hover:bg-foreground/5",
                // Unread (but not selected) mentions read brighter + bold, matching
                // an unread channel row.
                view !== "mentions" && hasUnreadMention && "text-foreground font-semibold",
              )}
              aria-current={view === "mentions"}
            >
              <AtSign className="size-4 shrink-0" />
              <span className="truncate flex-1 min-w-0">Mentions</span>
              {view !== "mentions" && hasUnreadMention ? (
                <span
                  className="shrink-0 flex items-center justify-center min-w-4 h-4 px-1 rounded-full bg-primary text-primary-foreground text-[10px] font-bold leading-none"
                  aria-label="You have unread mentions"
                >
                  @
                </span>
              ) : null}
            </button>
            <button
              type="button"
              onClick={() => {
                setView("threads");
                onNavigate?.();
              }}
              className={cn(
                "flex w-full items-center gap-2 pl-3 pr-2 py-1.5 touch:py-3 text-sm transition-colors text-left clip-corner-lg",
                view === "threads"
                  ? "bg-primary text-primary-foreground font-medium"
                  : "text-muted-foreground hover:text-foreground hover:bg-foreground/5",
                // Unread (but not selected) thread replies read brighter + bold.
                view !== "threads" && hasNewThreadReplies && "text-foreground font-semibold",
              )}
              aria-current={view === "threads"}
            >
              <MessagesSquare className="size-4 shrink-0" />
              <span className="truncate flex-1 min-w-0">Threads</span>
              {view !== "threads" && hasNewThreadReplies ? (
                <span
                  className="shrink-0 size-2 rounded-full bg-primary"
                  aria-label="New thread replies"
                />
              ) : null}
            </button>
            {hasProjects && (
              <button
                type="button"
                onClick={() => {
                  setProjectsTouched(true);
                  setView("projects");
                  onNavigate?.();
                }}
                className={cn(
                  "flex w-full items-center gap-2 pl-3 pr-2 py-1.5 touch:py-3 text-sm transition-colors text-left clip-corner-lg",
                  view === "projects"
                    ? "bg-primary text-primary-foreground font-medium"
                    : "text-muted-foreground hover:text-foreground hover:bg-foreground/5",
                )}
                aria-current={view === "projects"}
              >
                <FolderGit2 className="size-4 shrink-0" />
                <span className="truncate flex-1 min-w-0">Projects</span>
              </button>
            )}
          </>
        ) : undefined
      }
    >
      {!community || channels.length === 0 ? (
        showChannelSkeleton ? (
          <div className="space-y-2 px-2 py-1">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-7 w-full" />
            ))}
          </div>
        ) : null
      ) : (
        channels.map((c) => {
          const inCall = Boolean(activeCall?.concord && activeCall.concord.channel.idHex === c.idHex);
          return (
            <ChannelRow2
              key={c.idHex}
              community={community}
              channel={c}
              active={Boolean(view === "channel" && channel && channel.idHex === c.idHex)}
              inCall={inCall}
              speaking={inCall ? speakingPubkeys : undefined}
              muted={inCall ? mutedPubkeys : undefined}
              unread={unreadByChannel[c.idHex]}
              onSelect={() => {
                selectChannel(c.idHex);
                onNavigate?.();
              }}
              onJoinVoice={handleJoinVoice}
            />
          );
        })
      )}
    </ChannelSidebarView>
  );

  return (
    <ChannelNavContext.Provider value={channelNav}>
      <SwipeReveal
        open={channelsOpen}
        onReveal={() => setChannelsOpen(true)}
        onClose={() => setChannelsOpen(false)}
        underlay={
          <>
            {/* The rail only ever navigates to *other* servers/communities, so
                it must NOT close this community's channel list on click: doing
                so slides this community's chat pane back in for a frame before
                the route changes — the "flash of the previous chat" glitch. The
                destination governs its own reveal state. (DMsPage omits the prop
                for the same reason.) */}
            <ServerRail />
            {channelList(() => setChannelsOpen(false), "flex-1 sidebar:flex-none")}
          </>
        }
      >
        <main className="flex-1 min-w-0 flex flex-col safe-area-top h-full">
          <header className="relative h-12 touch:h-14 max-sidebar:h-auto max-sidebar:py-2 mx-2 mt-3 px-2 sidebar:px-3 flex items-center gap-1.5 shrink-0 clip-corner-lg bg-chrome">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Back to channels"
              className="size-9 touch:size-11 shrink-0 sidebar:hidden"
              onClick={() => setChannelsOpen(true)}
            >
              <ChevronLeft className="size-5" />
            </Button>

            {/* Desktop / wide: "# channel-name" (or "@ Mentions" / "Threads"). */}
            <div className="relative hidden sidebar:flex items-center gap-1.5 min-w-0">
              {/* Passive background-sync indicator, pinned to the corner of the
                  leading title icon (replaces the old full-width sync bar). */}
              <SyncStatusIndicator
                priorityScope={channelScope}
                className="absolute -bottom-0.5 left-2 z-10"
              />
              {view === "mentions" ? (
                <>
                  <AtSign className="size-5 text-muted-foreground shrink-0" />
                  <h1 className="font-semibold truncate leading-tight">Mentions</h1>
                </>
              ) : view === "audit" ? (
                <>
                  <ScrollText className="size-5 text-muted-foreground shrink-0" />
                  <h1 className="font-semibold truncate leading-tight">Audit log</h1>
                </>
              ) : view === "invites" ? (
                <>
                  <LinkIcon className="size-5 text-muted-foreground shrink-0" />
                  <h1 className="font-semibold truncate leading-tight">Invite links</h1>
                </>
              ) : view === "banned" ? (
                <>
                  <Ban className="size-5 text-muted-foreground shrink-0" />
                  <h1 className="font-semibold truncate leading-tight">Banned members</h1>
                </>
              ) : view === "health" ? (
                <>
                  <HeartPulse className="size-5 text-muted-foreground shrink-0" />
                  <h1 className="font-semibold truncate leading-tight">Member health</h1>
                </>
              ) : view === "threads" ? (
                <>
                  <MessagesSquare className="size-5 text-muted-foreground shrink-0" />
                  <h1 className="font-semibold truncate leading-tight">Threads</h1>
                </>
              ) : view === "projects" ? (
                <>
                  <FolderGit2 className="size-5 text-muted-foreground shrink-0" />
                  <h1 className="font-semibold truncate leading-tight">Projects</h1>
                </>
              ) : (
                <>
                  {channel?.isPrivate ? (
                    <Lock className="size-5 text-muted-foreground shrink-0" />
                  ) : (
                    <Hash className="size-5 text-muted-foreground shrink-0" />
                  )}
                  <h1 className="font-semibold truncate leading-tight">{channel?.name ?? "…"}</h1>
                </>
              )}
            </div>

            {/* Mobile: community avatar + name large, channel muted below */}
            <div className="relative flex sidebar:hidden items-center min-w-0">
              {/* Passive background-sync indicator, pinned to the avatar corner
                  (can't live inside the info button — nested buttons). */}
              <SyncStatusIndicator
                priorityScope={channelScope}
                className="absolute bottom-0 left-5 z-10"
              />
              <button
                type="button"
                className="flex items-center gap-2.5 min-w-0 text-left"
                onClick={() => community && setInfoOpen(true)}
                disabled={!community}
                aria-label="Community info"
              >
              <TitleAvatar2 icon={folded?.metadata?.icon} name={community?.name} />
              <div className="min-w-0 flex flex-col">
                <span className="font-semibold text-base leading-tight truncate">{community?.name ?? "…"}</span>
                <span className="text-xs text-muted-foreground leading-tight truncate flex items-center gap-0.5">
                  {view === "mentions" ? (
                    <>
                      <AtSign className="size-3 shrink-0" />
                      Mentions
                    </>
                  ) : view === "audit" ? (
                    <>
                      <ScrollText className="size-3 shrink-0" />
                      Audit log
                    </>
                  ) : view === "invites" ? (
                    <>
                      <LinkIcon className="size-3 shrink-0" />
                      Invite links
                    </>
                  ) : view === "banned" ? (
                    <>
                      <Ban className="size-3 shrink-0" />
                      Banned members
                    </>
                  ) : view === "health" ? (
                    <>
                      <HeartPulse className="size-3 shrink-0" />
                      Member health
                    </>
                  ) : view === "threads" ? (
                    <>
                      <MessagesSquare className="size-3 shrink-0" />
                      Threads
                    </>
                  ) : view === "projects" ? (
                    <>
                      <FolderGit2 className="size-3 shrink-0" />
                      Projects
                    </>
                  ) : (
                    <>
                      {channel?.isPrivate ? (
                        <Lock className="size-3 shrink-0" />
                      ) : (
                        <Hash className="size-3 shrink-0" />
                      )}
                      {channel?.name ?? "…"}
                    </>
                  )}
                </span>
              </div>
            </button>
            </div>
            <div className="ml-auto flex items-center gap-0.5">
              {/* Voice — the primary channel action, inline at every width
                  (mirrors the DM header's Call). Search + the members toggle
                  stay inline on desktop; Invite and Mute always live in the …
                  menu, and on mobile Search + Members join them there. */}
              {user && view === "channel" && channel && !dissolved && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className={cn("size-8 touch:size-11", inThisVoice && "text-success")}
                      aria-label={inThisVoice ? "In voice" : "Join voice"}
                      disabled={inThisVoice}
                      onClick={() => channel && handleJoinVoice(channel, activeBroker ?? null, activeFold)}
                    >
                      {inThisVoice ? <Headphones className="size-4" /> : <Phone className="size-4" />}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{inThisVoice ? "In voice" : "Join voice"}</TooltipContent>
                </Tooltip>
              )}
              {view === "channel" && channel && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Search messages"
                      aria-pressed={searchOpen}
                      className={cn("size-8 hidden sidebar:inline-flex text-muted-foreground", searchOpen && "text-foreground")}
                      onClick={() => setSearchOpen(true)}
                    >
                      <Search className="size-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Search messages</TooltipContent>
                </Tooltip>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn("size-8 hidden sidebar:inline-flex text-muted-foreground", membersVisible && "text-foreground")}
                    aria-label={membersVisible ? "Hide members" : "Show members"}
                    aria-pressed={membersVisible}
                    onClick={toggleMembersVisible}
                  >
                    <Users className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{membersVisible ? "Hide members" : "Show members"}</TooltipContent>
              </Tooltip>

              {view === "channel" && channel && (calendar.events.length > 0 || calendar.canModerate) && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className={cn("size-8 touch:size-11 text-muted-foreground", eventsOpen && "text-foreground")}
                      aria-label={eventsOpen ? "Hide events" : "Show events"}
                      aria-pressed={eventsOpen}
                      onClick={() => setEventsOpen((v) => !v)}
                    >
                      <CalendarClock className="size-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Events</TooltipContent>
                </Tooltip>
              )}

              {/* Overflow … menu — shown at every width. Invite and Mute always
                  live here (they were the least-used inline buttons cluttering
                  the desktop bar); Search + Members are here only on mobile,
                  where they aren't already inline. */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="More options"
                    className="size-8 touch:size-11 shrink-0 text-muted-foreground"
                  >
                    <MoreVertical className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52 p-1.5">
                  {view === "channel" && channel && (
                    <DropdownMenuItem className="px-3 py-2 sidebar:hidden" onClick={() => setSearchOpen(true)}>
                      <Search className="size-4" />
                      Search messages
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem className="px-3 py-2 sidebar:hidden" onClick={() => setMembersOpen(true)}>
                    <Users className="size-4" />
                    Members
                  </DropdownMenuItem>
                  {user && !dissolved && (
                    <DropdownMenuItem className="px-3 py-2" onClick={() => setInviteOpen(true)}>
                      <UserPlus className="size-4" />
                      Invite people
                    </DropdownMenuItem>
                  )}
                  {user && community && channel && (
                    <DropdownMenuItem
                      className="px-3 py-2"
                      onClick={() => toggleConcordChannelMute("c2", community.idHex, channel.idHex)}
                    >
                      {channelMuted ? <Bell className="size-4" /> : <BellOff className="size-4" />}
                      {channelMuted ? "Unmute channel" : "Mute channel"}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            {/* Inline search bar: slides in over the header when open, covering
                the title + actions (leaves the mobile back button visible; on
                desktop it covers the full bar). Slides via a GPU-composited
                transform so it never forces a per-frame reflow. Mirrors NIP-29. */}
            {view === "channel" && channel && (
              <div
                className={cn(
                  "absolute inset-y-0 right-0 left-10 sidebar:left-0 z-10 flex items-center gap-1.5 px-2 sidebar:px-3",
                  "bg-chrome clip-corner-lg overflow-hidden",
                  "transition-transform duration-300 ease-in-out",
                  searchOpen
                    ? "translate-x-0 pointer-events-auto"
                    : "translate-x-full pointer-events-none",
                )}
              >
                <Search className="size-4 text-muted-foreground shrink-0" />
                <Input
                  ref={searchInputRef}
                  value={searchFilters.query}
                  onChange={(e) => setSearchFilters((f) => ({ ...f, query: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") closeSearch();
                  }}
                  placeholder="Search all channels…"
                  className="h-8 touch:h-10 flex-1 border-0 bg-transparent px-1 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
                />
                <SearchFiltersPopover
                  channels={channels}
                  members={memberPubkeys}
                  filters={searchFilters}
                  onChange={setSearchFilters}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Close search"
                  className="size-8 touch:size-10 shrink-0 text-muted-foreground"
                  onClick={closeSearch}
                >
                  <X className="size-4" />
                </Button>
              </div>
            )}
          </header>

          {/* Top-of-chat call stage portal target (active when this channel is
              the one in encrypted voice). */}
          <CallStageSlot active={inThisVoice} />

          <div className="relative flex flex-1 min-h-0">
            <ComposerBoundsProvider value={composerBoundsRef}>
            <div className={cn(
              "flex-1 min-w-0 flex flex-col",
              "sidebar:transition-[width,opacity] sidebar:duration-300 sidebar:ease-out",
              threadRoot && threadExpanded && "sidebar:flex-none sidebar:w-0 sidebar:opacity-0 sidebar:overflow-hidden sidebar:pointer-events-none",
            )}>
              {view === "mentions" ? (
                <div className="flex-1 min-h-0 overflow-y-auto overflow-x-clip overscroll-contain scrollbar-stable pb-safe">
                  <MentionsView
                    channels={channels}
                    mentions={mentions}
                    isLoading={mentionsLoading}
                    onJump={jumpToMention}
                  />
                </div>
              ) : view === "audit" ? (
                <div className="flex-1 min-h-0 overflow-y-auto overflow-x-clip overscroll-contain scrollbar-stable pb-safe">
                  {community && <AuditLogView community={community} />}
                </div>
              ) : view === "invites" ? (
                <div className="flex-1 min-h-0 overflow-y-auto overflow-x-clip overscroll-contain scrollbar-stable pb-safe">
                  {community && <InvitesView community={community} />}
                </div>
              ) : view === "banned" ? (
                <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain scrollbar-stable pb-safe">
                  {community && <BannedView community={community} />}
                </div>
              ) : view === "health" ? (
                <div className="flex-1 min-h-0 overflow-y-auto overflow-x-clip overscroll-contain scrollbar-stable pb-safe">
                  {community && (
                    <DebugHealView
                      community={community}
                      canHeal={canManageRoles || canKickAny || canBanAny || canCreateInvite}
                    />
                  )}
                </div>
              ) : view === "threads" ? (
                <div className="flex-1 min-h-0 overflow-y-auto overflow-x-clip overscroll-contain scrollbar-stable pb-safe">
                  <ThreadsView
                    channels={channels}
                    threads={displayedThreads}
                    isLoading={threadsLoading}
                    onOpen={openThreadFromList}
                  />
                </div>
              ) : view === "projects" ? (
                <div className="flex-1 min-h-0 overflow-y-auto overflow-x-clip overscroll-contain scrollbar-stable pb-safe">
                  <ProjectsView
                    repos={projects.repos}
                    items={projects.items}
                    isLoading={projects.isLoading}
                    intro="Browse this community's repositories and activity."
                    emptyHint="Repositories attached to this community's channels will appear here."
                    onOpenItem={openProjectItem}
                    headerExtra={
                      <div className="flex items-center gap-1.5">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-8 text-muted-foreground"
                              aria-label="Refresh repository activity"
                              disabled={projects.isSyncing}
                              onClick={projects.refresh}
                            >
                              <RefreshCw className={cn("size-4", projects.isSyncing && "animate-spin")} />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Refresh repository activity</TooltipContent>
                        </Tooltip>
                        {user && <NewIssueDialog repos={projects.repos} items={projects.items} onCreate={handleCreateIssue} />}
                      </div>
                    }
                  />
                </div>
              ) : searching ? (
                /* Community-wide search results replace the timeline + composer
                   in-place. Clicking a result jumps to its channel. */
                <div className="flex-1 min-h-0 overflow-y-auto overflow-x-clip overscroll-contain scrollbar-stable pb-safe">
                  <SearchResultsView
                    channels={channels}
                    results={searchResults}
                    isLoading={searchLoading}
                    query={searchFilters.query}
                    onJump={(channelIdHex, messageId) => {
                      closeSearch();
                      jumpToMention(channelIdHex, messageId);
                    }}
                  />
                </div>
              ) : (
                <>
                  <CalendarEventsBar
                    open={eventsOpen}
                    calendar={calendar}
                    onClose={() => setEventsOpen(false)}
                    onCreate={() => setCreateEventOpen(true)}
                    onDelete={(event) => { void calendar.remove(event); }}
                  />
                  <MessageTimeline
                    key={channel?.idHex ?? "none"}
                    transport={transport}
                    entries={mixedEntries}
                    newDividerId={newDividerId}
                    renderEntry={(entry, relatedEntries) => isGitTimelineEntry(entry) ? <GitTimelineRow entry={entry} members={new Set(memberPubkeys)} onOpen={(ticket) => { setOpenTicket(ticket); void gitActivity.refreshTicket(ticket); }} commentEntries={entry.type === "git-comment" ? relatedEntries as Extract<typeof entry, { type: "git-comment" }>[] : undefined} activities={gitActivity.activities} /> : null}
                    handleRef={timelineRef}
                    syncing={channelSyncing}
                    className="flex-1 min-h-0"
                    emptyState={
                      <p className="px-2 py-8 text-center text-sm text-muted-foreground">
                        No messages yet. Say something — only members can read it.
                      </p>
                    }
                    renderMessage={(msg, continuation) => {
                      const replyId = getQuoteReplyToId(msg);
                      return (
                      <ChatMessage2
                        key={msg.id}
                        event={msg}
                        reactions={reactionsFor(msg.id)}
                        zaps={transport.zapsFor?.(msg.id)}
                        onSendZap={config.zapsEnabled ? transport.sendZap : undefined}
                        onSendOnchainZap={config.zapsEnabled ? transport.sendOnchainZap : undefined}
                        poll={transport.pollFor?.(msg.id)}
                        calendar={transport.calendarFor?.(msg.id)}
                        replies={transport.threadRepliesFor?.(msg.id) ?? EMPTY_REPLIES}
                        continuation={continuation}
                        canWrite={transport.canWrite}
                        canModerate={transport.canModerate}
                        sendStatus={transport.sendStatusFor?.(msg.id)}
                        active={activeId === msg.id}
                        onToggleActive={toggleActive}
                        onOpenThread={onOpenThreadCb}
                        onReply={canWrite ? setReplyTo : undefined}
                        replyToId={replyId}
                        replyParent={replyId ? messagesById.get(replyId) : undefined}
                        onJumpToReply={jumpWithinChannel}
                        onDelete={transport.deleteMessage}
                        onRetry={transport.retry}
                        onDiscard={transport.discard}
                        isEditing={editingId === msg.id}
                        onEdit={canWrite ? startEditing : undefined}
                        onEditSubmit={handleEditSubmit}
                        onEditCancel={cancelEditing}
                      />
                      );
                    }}
                  />

                  {typingPubkeys.length > 0 && <TypingIndicator pubkeys={typingPubkeys} />}
                  {dissolved ? (
                    <div className="mx-2 mb-3 mt-1 px-3 py-3 clip-corner-lg bg-destructive/10 flex items-center gap-3">
                      <Trash2 className="size-5 shrink-0 text-destructive" />
                      <div className="min-w-0 flex-1 text-sm">
                        <p className="font-medium text-destructive">This community was dissolved by its owner.</p>
                        <p className="text-muted-foreground">
                          It's now read-only. You can still browse the history, or remove it from your list.
                        </p>
                      </div>
                      <Button
                        variant="destructive"
                        size="sm"
                        className="shrink-0 clip-corner-lg"
                        disabled={isLeaving}
                        onClick={handleLeave}
                      >
                        {isLeaving ? <Loader2 className="size-4 animate-spin" /> : "Remove"}
                      </Button>
                    </div>
                  ) : excluded ? (
                    <div className="mx-2 mb-3 mt-1 px-3 py-3 clip-corner-lg bg-muted/60 flex items-center gap-3">
                      <Lock className="size-5 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1 text-sm">
                        <p className="font-medium">You no longer have access to this community.</p>
                        <p className="text-muted-foreground">
                          A moderator rotated its keys without you. Your history stays readable; new
                          messages won't. It reappears if you're re-invited — or you can leave.
                        </p>
                      </div>
                      <Button
                        variant="secondary"
                        size="sm"
                        className="shrink-0 clip-corner-lg"
                        disabled={isLeaving}
                        onClick={handleLeave}
                      >
                        {isLeaving ? <Loader2 className="size-4 animate-spin" /> : "Leave"}
                      </Button>
                    </div>
                  ) : stranded ? (
                    <div className="mx-2 mb-3 mt-1 px-3 py-3 clip-corner-lg bg-muted/60 flex items-center gap-3">
                      <Lock className="size-5 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1 text-sm">
                        <p className="font-medium">This invite link is out of date.</p>
                        <p className="text-muted-foreground">
                          The community rotated its keys after this link was made, so you're on an
                          older version and can't read new messages.
                          {canRecover
                            ? " This checks for updated keys automatically; you can also ask whoever invited you for a fresh invite, or ask a moderator to send you the current keys."
                            : " Ask whoever invited you for a fresh invite, or ask a moderator to send you the current keys."}
                        </p>
                      </div>
                      {canRecover && (
                        <Button
                          variant="secondary"
                          size="sm"
                          className="shrink-0 clip-corner-lg"
                          disabled={recoveryChecking}
                          onClick={() => void recoveryCheckNow()}
                        >
                          {recoveryChecking ? <Loader2 className="size-4 animate-spin" /> : "Check again"}
                        </Button>
                      )}
                    </div>
                  ) : (
                    channel && (
                      <ChatComposer
                        relayUrl="dm"
                        groupId={channel.idHex}
                        messages={[]}
                        mentionPubkeys={memberPubkeys}
                        botCommands
                        recentAuthors={recentAuthors}
                        conversationRelays={community?.relays}
                        placeholder={user ? `Message #${channel.name}` : "Sign in to send"}
                        sendOverride={handleSend}
                        onPollSubmit={transport.sendPoll}
                        replyTo={replyTo}
                        replyMarker="nipc7"
                        onCancelReply={() => setReplyTo(undefined)}
                        onTyping={publishTyping}
                        encryptAttachments
                      />
                    )
                  )}
                </>
              )}
            </div>

            <TicketSidePanel ticket={openTicket} members={new Set(memberPubkeys)} activities={panelActivities} onClose={() => setOpenTicket(undefined)} actions={ticketActions} />
            <NewChannelDialog2
              open={creatingChannel}
              onOpenChange={setCreatingChannel}
              connectedCoordinates={connectedCoordinates}
              onCreateText={handleCreateTextChannel}
              onCreateRepository={handleCreateRepositoryChannel}
            />
            <CreateEventDialog
              calendar={calendar}
              open={createEventOpen}
              onOpenChange={setCreateEventOpen}
            />
            </ComposerBoundsProvider>

            {/* Thread panel. Desktop: in-flow sibling whose width animates open.
                Mobile: overlays the chat. Mirrors GroupChat. */}
            <div
              className={cn(
                "overflow-hidden",
                "absolute inset-0 z-20 sidebar:static sidebar:z-auto",
                "sidebar:transition-[width] sidebar:duration-200 sidebar:ease-out",
                threadRoot
                  ? (threadExpanded ? "sidebar:flex-1 sidebar:w-full" : "sidebar:shrink-0 sidebar:w-[23rem]")
                  : "sidebar:shrink-0 sidebar:w-0 pointer-events-none sidebar:pointer-events-auto",
              )}
            >
              <div
                className={cn(
                  "absolute inset-0 bg-background transition-opacity duration-200 ease-out sidebar:hidden",
                  threadRoot ? "opacity-100" : "opacity-0",
                )}
              />
              <div
                className={cn(
                  "relative h-full flex w-full transition-transform duration-200 ease-out",
                  threadRoot ? "translate-x-0" : "translate-x-full",
                  threadExpanded ? "sidebar:w-full" : "sidebar:w-[23rem]",
                )}
              >
                {lastThreadRoot && channel && (
                  <ThreadPanel
                    root={lastThreadRoot}
                    transport={transport}
                    relayUrl="dm"
                    groupId={channel.idHex}
                    canWrite={canWrite}
                    mentionPubkeys={memberPubkeys}
                    botCommands
                    conversationRelays={community?.relays}
                    autoFocus={threadAutoFocus}
                    onClose={() => { setThreadRoot(undefined); setThreadExpanded(false); }}
                    onExpandChange={setThreadExpanded}
                  />
                )}
              </div>
            </div>

            {/* Member panel: width-animated on desktop, slide overlay on mobile. */}
            <div
              className={cn(
                "overflow-hidden",
                "absolute inset-0 z-20 sidebar:static sidebar:z-auto",
                "sidebar:shrink-0 sidebar:w-0 sidebar:transition-[width] sidebar:duration-200 sidebar:ease-out",
                membersOpen ? "" : "pointer-events-none sidebar:pointer-events-auto",
                membersVisible && "sidebar:w-[16.5rem]",
              )}
            >
              <div
                className={cn(
                  "absolute inset-0 bg-background transition-opacity duration-200 ease-out sidebar:hidden",
                  membersOpen ? "opacity-100" : "opacity-0",
                )}
              />
              <div
                className={cn(
                  "relative h-full flex w-full sidebar:w-[16.5rem] transition-transform duration-200 ease-out",
                  membersOpen ? "translate-x-0" : "translate-x-full",
                  membersVisible ? "sidebar:translate-x-0" : "sidebar:translate-x-full",
                )}
              >
                <MemberList
                  admins={memberAdmins}
                  members={memberPubkeys}
                  canModerate={canManageRoles || canKickAny || canBanAny}
                  viewerIsAdmin={iAmOwner}
                  currentUserPubkey={user?.pubkey}
                  onSetRole={canManageRoles ? handleSetRole : undefined}
                  onKick={canKickAny ? (pk) => moderation.kick({ target: pk }).catch(() => {}) : undefined}
                  onBan={canBanAny ? setBanTarget : undefined}
                  banLabel={(pk) =>
                    folded && user && moderation.canRekey && !hasForeignLiveLinks(folded, user.pubkey, pk)
                      ? "Ban & lock out"
                      : "Ban"
                  }
                  onUnban={canBanAny ? (pk) => moderation.unban({ target: pk }).catch(() => {}) : undefined}
                  bannedPubkeys={moderation.banned}
                  onClose={() => setMembersOpen(false)}
                />
              </div>
            </div>
          </div>
        </main>
      </SwipeReveal>

      <InviteDialog2 community={community} open={inviteOpen} onOpenChange={setInviteOpen} />
      <BanMemberDialog
        target={banTarget}
        willRotate={banWillRotate}
        onClose={() => setBanTarget(null)}
        onConfirm={runBan}
      />
      <CommunityInfoDialog2
        community={community}
        metadata={folded?.metadata}
        ownerHex={ownerHex}
        memberCount={memberPubkeys.length}
        canManageMetadata={canManageMetadata}
        canManageChannels={canManageChannels}
        open={infoOpen}
        onOpenChange={setInfoOpen}
      />
      <RolesDialog2 community={community} open={rolesOpen} onOpenChange={setRolesOpen} />
    </ChannelNavContext.Provider>
  );
}
