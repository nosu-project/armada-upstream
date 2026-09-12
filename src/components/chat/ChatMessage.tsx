import { AlertCircle, Ban, Braces, Copy, EyeOff, Flag, Forward, Link, Link2, MessagesSquare, Pencil, Pin, PinOff, Reply, Trash2, UserCheck, UserMinus, UserX, Zap } from "lucide-react";
import { nip19 } from "nostr-tools";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ChatContent } from "@/components/chat/ChatContent";
import { emojify } from "@/components/chat/emojify";
import { MessageActionSheet } from "@/components/chat/MessageActionSheet";
import { MessageActionToolbar } from "@/components/chat/MessageActionToolbar";
import { MessageRow, type MessageIdentity } from "@/components/chat/MessageRow";
import { CalendarEventMessageCard } from "@/components/chat/CalendarEventCard";
import { PollCard } from "@/components/chat/PollCard";
import { PollView } from "@/components/chat/PollView";
import { ReactionBar } from "@/components/chat/ReactionBar";
import { ReportDialog } from "@/components/ReportDialog";
import { ZapDialog } from "@/components/chat/ZapDialog";
import { ZapPill } from "@/components/chat/ZapPill";
import { DisplayName } from "@/components/DisplayName";
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
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EventJsonDialog } from "@/components/EventJsonDialog";
import { useAutosizeTextarea } from "@/hooks/useAutosizeTextarea";
import { useAuthor } from "@/hooks/useAuthor";
import { useChatScope } from "@/hooks/useChatScope";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useHiddenMessages } from "@/hooks/useHiddenMessages";
import { useIsTouch } from "@/hooks/useIsMobile";
import { useMuteToggle } from "@/hooks/useMuteList";
import { useMediaWithFallback } from "@/hooks/useMediaWithFallback";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { getComposerCollisionPadding, useComposerBoundsRef } from "@/contexts/ComposerBoundsContext";
import { ChatImageMenuContext, withImageActions, type ChatImageMenu } from "@/contexts/ChatImageMenuContext";
import { getAvatarShape } from "@/lib/avatarShape";
import { buildEmojiMap } from "@/lib/customEmoji";
import { writeClipboardText } from "@/lib/clipboard";
import { chatUrl, type ChatRoute } from "@/lib/routes";
import { KIND_GROUP_CHAT } from "@/lib/nip29";
import { expirationOf, KIND_DM_CHAT } from "@/lib/nip17/protocol";
import { parseProxyTag } from "@/lib/nip48";
import { reportDestination, type ReportTarget } from "@/lib/report";
import { requestCommand } from "@/hooks/useCommandBus";
import { commandLine } from "@/lib/botCommands";
import { isMeAction, meActionText } from "@/lib/slashCommands";
import { shortTimeAgo } from "@/lib/formatTime";
import { cn } from "@/lib/utils";

import type { MessageActionItem } from "@/components/chat/messageActions";
import type { ChatMsg, MessageCalendar, MessagePoll, MessageReactions, MessageZaps, OnchainZapAnnouncement, SendStatus, ZapPayment } from "@/components/chat/transport";
import type { EncryptedRef } from "@/hooks/useResolvedMediaSrc";
import type { ReactNode } from "react";

import { KIND_CALENDAR_DATE, KIND_CALENDAR_TIME } from "@/lib/calendar";
import { KIND_POLL } from "@/lib/polls";

/** A `nostr:npub…`/`nostr:nprofile…`/bare-bech32 mention inside preview text. */
const REPLY_MENTION_RE =
  /(?:nostr:)?(npub1|nprofile1)([023456789acdefghjklmnpqrstuvwxyz]+)/gi;

/** Resolve a single mention pubkey to `@displayname` for the preview line. */
function ReplyMentionName({ pubkey }: { pubkey: string }) {
  return <span className="text-primary">@<DisplayName pubkey={pubkey} /></span>;
}

/** The bot an invocation was addressed to, by display name. */
function InvokedBotName({ pubkey }: { pubkey: string }) {
  return <span className="font-semibold not-italic text-primary"><DisplayName pubkey={pubkey} /></span>;
}

/**
 * A one-line reply preview that renders `@mentions` as resolved display names
 * (via {@link ReplyMentionName}) instead of a raw `nostr:npub…`/hex string, and
 * collapses URLs to 📎 — matching how the message body shows them. Falls back to
 * 📎 for an all-URL/empty body. Used inside the reply-context line, the
 * composer's reply banner and the composer's quote bar.
 *
 * `hideMediaPlaceholder` drops the 📎 placeholder (used when a {@link
 * ReplyThumbnail} already shows the image, so an image-only reply reads as just
 * the thumbnail, not "📎"). When `tags` are supplied, NIP-30 `:shortcode:`
 * custom emojis in the text are rendered as inline images (matching the body).
 */
export function ReplyPreview({ content, hideMediaPlaceholder = false, tags }: { content: string; hideMediaPlaceholder?: boolean; tags?: string[][] }) {
  // Collapse URLs first (they'd blow out the single line), then split on
  // mentions so each resolves to @name.
  const placeholder = hideMediaPlaceholder ? "" : "📎";
  const withoutUrls = content.replace(/https?:\/\/\S+/g, placeholder);
  // NIP-30 custom emojis, when the caller passes the event's tags: each plain
  // text run is emojified so `:shortcode:` shows the image, not the raw code.
  const emojiMap = tags ? buildEmojiMap(tags) : undefined;
  const renderText = (text: string): ReactNode =>
    emojiMap && emojiMap.size > 0
      ? emojify(text, emojiMap, "inline h-[1.15em] w-[1.15em] object-contain align-text-bottom")
      : text;
  const parts: ReactNode[] = [];
  let last = 0;
  let key = 0;
  let hasText = false;
  for (const m of withoutUrls.matchAll(REPLY_MENTION_RE)) {
    const start = m.index ?? 0;
    if (start > last) {
      const text = withoutUrls.slice(last, start);
      if (text.trim()) hasText = true;
      parts.push(<span key={key++}>{renderText(text)}</span>);
    }
    try {
      const decoded = nip19.decode(`${m[1]}${m[2]}`);
      const pubkey = decoded.type === "npub" ? decoded.data : decoded.type === "nprofile" ? decoded.data.pubkey : undefined;
      if (pubkey) {
        hasText = true;
        parts.push(<ReplyMentionName key={key++} pubkey={pubkey} />);
      } else {
        parts.push(<span key={key++}>{m[0]}</span>);
        hasText = true;
      }
    } catch {
      parts.push(<span key={key++}>{m[0]}</span>);
      hasText = true;
    }
    last = start + m[0].length;
  }
  if (last < withoutUrls.length) {
    const text = withoutUrls.slice(last);
    if (text.trim()) hasText = true;
    parts.push(<span key={key++}>{renderText(text)}</span>);
  }
  if (!hasText) return hideMediaPlaceholder ? null : <>📎</>;
  return <>{parts}</>;
}

/**
 * A small square image thumbnail for the reply preview. Resolves the media the
 * same way the message body does ({@link useResolvedMediaSrc}) so Concord's
 * encrypted attachments decrypt too; renders nothing until it's ready (so the
 * line never flashes a broken image).
 */
export function ReplyThumbnail({ image }: { image: EncryptedRef }) {
  const { resolved, onError } = useMediaWithFallback(image);
  if (resolved.status !== "ready") return null;
  return (
    <img
      src={resolved.src}
      alt=""
      className="size-4 shrink-0 rounded-[3px] object-cover"
      loading="lazy"
      onError={onError}
    />
  );
}

/**
 * The "replying to …" context line shown ABOVE a reply message: the replied-to
 * author's round avatar, their name (accent-highlighted) and a one-line
 * snippet, tied down to the replying message's own avatar by a thin
 * `.chat-reply-connector` elbow. The `pl-[3.25rem]` indent aligns it with the
 * message body (past the avatar gutter) so the connector has the gutter to run
 * in; `mb-1` keeps it off the avatar below. Purely presentational: the
 * transport resolves WHO is replied to and hands the resolved `name` /
 * `preview` here so the chrome is defined once. Renders nothing until a name is
 * resolved (avoids a flash of an empty line). When `onClick` is supplied the
 * line jumps the timeline to the replied-to message.
 *
 * Must be placed in the row directly above the avatar (see MessageRow) for the
 * connector geometry to land.
 */
export function ReplyContextLine({
  name,
  pubkey,
  preview,
  thumbnail,
  onClick,
}: {
  name: string | undefined;
  /** The replied-to author, when known — supplies their avatar + emoji tags. */
  pubkey?: string;
  preview?: ReactNode;
  /** Optional media thumbnail shown before the preview (e.g. an image reply). */
  thumbnail?: ReactNode;
  onClick?: () => void;
}) {
  const author = useAuthor(pubkey);
  const metadata = author.data?.metadata;
  if (!name) return null;
  const content = (
    <>
      <span aria-hidden className="chat-reply-connector" />
      {pubkey && (
        <Avatar shape={getAvatarShape(metadata)} className="size-4 shrink-0">
          <AvatarImage src={metadata?.picture} alt="" />
          <AvatarFallback className="bg-primary/20 text-primary text-[8px]">
            {name[0]?.toUpperCase()}
          </AvatarFallback>
        </Avatar>
      )}
      <span className="font-semibold shrink-0 text-primary group-hover/reply:underline">
        {pubkey ? <DisplayName pubkey={pubkey} name={name} /> : name}
      </span>
      {thumbnail}
      {preview && <span className="line-clamp-1 break-words min-w-0 text-muted-foreground/70">{preview}</span>}
    </>
  );
  const className =
    "chat-reply group/reply relative flex items-center gap-1.5 min-w-0 max-w-full pl-[3.25rem] pr-2 pt-1.5 pb-1 mb-1 text-xs";
  if (!onClick) {
    return <div className={className}>{content}</div>;
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(className, "text-left cursor-pointer")}
    >
      {content}
    </button>
  );
}

/** One reply participant's avatar in the thread badge's overlapping stack. */
function ThreadParticipantAvatar({ pubkey }: { pubkey: string }) {
  const author = useAuthor(pubkey);
  const metadata = author.data?.metadata;
  const name = useScopedDisplayName(pubkey, metadata);
  return (
    <Avatar shape={getAvatarShape(metadata)} className="size-5 ring-2 ring-background">
      <AvatarImage src={metadata?.picture} alt={name} />
      <AvatarFallback className="bg-primary/25 text-primary text-[9px] font-semibold">
        {name[0]?.toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
}

/**
 * The prominent, Slack-style "thread" affordance shown under a message that has
 * replies: an overlapping avatar stack of the (distinct) repliers, the reply
 * count, "Last reply …" recency, and a chevron. Clicking opens the thread.
 */
function ThreadBadge({
  count,
  participants,
  lastReplyAt,
  onClick,
}: {
  count: number;
  participants: string[];
  lastReplyAt?: number;
  onClick: () => void;
}) {
  const shown = participants.slice(0, 4);
  const overflow = participants.length - shown.length;
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-1 inline-flex max-w-full items-center gap-2 rounded-lg border border-transparent bg-primary/[0.07] py-1 pl-1 pr-2.5 touch:py-2 touch:pr-3.5 text-left transition-colors hover:border-primary/30 hover:bg-primary/[0.12]"
    >
      <span className="flex shrink-0 -space-x-1.5">
        {shown.map((pk) => (
          <ThreadParticipantAvatar key={pk} pubkey={pk} />
        ))}
        {overflow > 0 && (
          <span className="flex size-5 items-center justify-center rounded-full ring-2 ring-background bg-primary/25 text-primary text-[9px] font-semibold tabular-nums">
            +{overflow}
          </span>
        )}
      </span>
      <span className="text-[13px] font-semibold text-primary">
        {count} {count === 1 ? "reply" : "replies"}
      </span>
      {lastReplyAt ? (
        <span className="truncate text-[11px] text-muted-foreground">
          {shortTimeAgo(lastReplyAt)}
        </span>
      ) : null}
    </button>
  );
}

export interface ChatMessageProps {
  event: ChatMsg;
  canWrite: boolean;
  canModerate: boolean;
  /**
   * Explicit author identity for non-Nostr authors (Bluetooth mesh peers). When
   * set, the message header renders this name/color/suffix instead of resolving
   * a Nostr profile from `event.pubkey` (which is a mesh peer id, not a key).
   */
  identityOverride?: MessageIdentity;
  /**
   * Context for rendering/voting on NIP-88 polls in this message. Only NIP-29
   * group chat carries polls (kind 1068); transports without polls omit this
   * and a poll kind would never appear in their timeline.
   */
  pollContext?: { relayUrl: string; groupId: string };
  /**
   * Resolved poll tally + vote callback for a poll (kind 1068) message, for
   * transports that carry the tally themselves (Concord's sealed chat fold)
   * rather than querying a relay. When present it renders the poll; NIP-29 uses
   * {@link pollContext} instead.
   */
  poll?: MessagePoll;
  /**
   * Resolved calendar event + RSVP state for a calendar (kind 31922/31923)
   * message. When present it renders the inline event card with RSVP controls.
   * Both NIP-29 and Concord supply it; transports without calendar events omit
   * it and a calendar kind would never appear in their timeline.
   */
  calendar?: MessageCalendar;
  /** Resolved reaction tallies + toggle for this message. */
  reactions?: MessageReactions;
  /** Whether this surface supports zaps (shows the ⚡ button on others' messages). */
  zapEnabled?: boolean;
  /** Aggregated zaps for this message (feeds the ⚡ total chip). */
  zaps?: MessageZaps;
  /**
   * CORD.md announcement publisher (Concord). Passed through to the zap
   * dialog; absent means the NIP-57 public-receipt flow.
   */
  onSendZap?: (target: ChatMsg, payment: ZapPayment) => Promise<void>;
  /** CORD.md on-chain zap announcement publisher (Concord). */
  onSendOnchainZap?: (target: ChatMsg, announcement: OnchainZapAnnouncement) => Promise<void>;
  /** Optimistic send status, if this message is locally-published & unconfirmed. */
  sendStatus?: SendStatus;
  /** Search term to highlight in the message body (search-results mode). */
  highlight?: string;
  /** Whether this message is currently being edited inline. */
  isEditing?: boolean;
  /** Whether this message is currently pinned (moderators only see the control). */
  isPinned?: boolean;
  /** Threaded-reply count, for the inline "N replies" thread badge. */
  replyCount?: number;
  /**
   * Distinct pubkeys that have replied in this message's thread (newest-first),
   * for the thread badge's avatar stack. Deduped by the transport.
   */
  threadParticipants?: string[];
  /** Timestamp (epoch seconds) of the latest reply, shown as "Last reply …". */
  lastReplyAt?: number;
  /**
   * A rendered "replying to …" context line, shown above the body. The
   * transport owns resolving the referenced message (different per protocol),
   * so it's passed in as a node rather than computed here.
   */
  replyContext?: ReactNode;
  /**
   * A heading rendered at the top of the body, above the content — a titled
   * post's subject (Concord forum posts, CORD-03 §3). Its presence also keeps
   * the row out of continuation collapsing: a titled post is a new topic, and
   * needs its author line however soon it follows the same author's chatter.
   */
  heading?: ReactNode;
  onRetry?: () => void;
  onDiscard?: () => void;
  /** Pin or unpin this message (moderators only; hidden when absent). */
  onTogglePin?: (event: ChatMsg) => void;
  /** Delete this message (hidden when absent). */
  onDelete?: (event: ChatMsg) => void;
  /**
   * Kick this message's author from the community (Concord moderation). The
   * callback is stable; visibility for THIS author is gated by {@link canKick},
   * which the page computes (and which already excludes self and the owner).
   * Opens a confirmation rather than acting on select. Hidden when absent.
   */
  onKick?: (pubkey: string) => void;
  /** Whether the viewer may kick this message's author — gates the Kick item. */
  canKick?: boolean;
  /**
   * Ban this message's author from the community (Concord moderation). Stable
   * callback; visibility gated per-author by {@link canBan}. Opens a
   * confirmation (which may rotate the community's keys). Hidden when absent.
   */
  onBan?: (pubkey: string) => void;
  /** Whether the viewer may ban this message's author — gates the Ban item. */
  canBan?: boolean;
  /** Open the threaded-replies side panel — the "reply in thread" action (hidden when absent). */
  onOpenThread?: (event: ChatMsg) => void;
  /**
   * Begin an inline reply to this message (Signal/Discord style — quoted in the
   * timeline, distinct from a thread reply). Hidden when absent.
   */
  onReply?: (event: ChatMsg) => void;
  /**
   * Forward this message's content to another conversation — Signal's
   * semantics: the text (and its attachments) are re-sent as a NEW message
   * authored by the forwarder, with nothing identifying the original sender or
   * the thread it came from. Hidden when absent.
   */
  onForward?: (event: ChatMsg) => void;
  /** Begin editing this message (own, non-poll messages only; hidden when absent). */
  onEdit?: (event: ChatMsg) => void;
  /** Submit an inline edit with new content. */
  onEditSubmit?: (event: ChatMsg, content: string) => void;
  /** Cancel an in-progress inline edit. */
  onEditCancel?: () => void;
  /** Whether this message's tap-to-reveal toolbar is active (mobile only). */
  active?: boolean;
  /** Toggle this message's active state (mobile tap-to-reveal toolbar). */
  onToggleActive?: (id: string) => void;
  /** Render compactly as a continuation of the previous same-author message. */
  continuation?: boolean;
  /**
   * Whether p-tagging the current user highlights the row as a mention.
   * Defaults on (group surfaces). DMs turn it off: a NIP-17 kind-14 rumor
   * always p-tags the recipient (the `p` set IS the conversation), so every
   * received message would light up as a "mention".
   */
  mentionHighlight?: boolean;
  /** This Concord message contains an authorized channel-wide @everyone. */
  everyoneMention?: boolean;
  /**
   * A small badge rendered next to the author's name (after the bot pill) —
   * e.g. the DM page's "NIP-04" legacy-encryption marker.
   */
  nameBadge?: ReactNode;
  /**
   * Where this message lives: the room, plus the thread when the row is a
   * reply inside one. When present, the menu offers "Copy message link" — the
   * same route with `/m/<id>` appended, so a reply's link opens its thread
   * rather than sending the reader hunting a timeline it was never in.
   * Omitted on surfaces where a row isn't addressable (the inbox digest, mesh).
   */
  permalink?: ChatRoute;
  /**
   * When set, this message is an unsigned rumor (e.g. a Concord sealed chat
   * event) rather than a relay-addressable signed event. "View event JSON" then
   * shows this object (pretty-printed); the "Copy message ID" off-ramp, which
   * references a relay-addressable event id that doesn't exist for a rumor, is
   * suppressed. Signed events show "View event JSON" for the event itself.
   */
  rumor?: unknown;
  /**
   * Command names a bot in this conversation declares. Lets an untagged `/cmd`
   * with arguments render as an action line in a 1:1 DM (which sends
   * invocations untagged), without ever promoting undeclared `/word` prose.
   */
  knownCommands?: ReadonlySet<string>;
}

/**
 * Transport-agnostic presentational shell for a single chat message: the action
 * toolbar (react/reply/thread/edit/pin/delete), inline edit field, reaction bar,
 * reply-context line and send-status — all driven purely by props. NIP-29 group
 * chat and Concord communities both render through this component; the data and
 * mutations come from a {@link ChatTransport}, never from a relay hook here.
 *
 * Capabilities are presence-gated: a control renders only when its callback is
 * supplied (e.g. no `onTogglePin` ⇒ no pin button), so a transport that can't
 * do a thing shows no dead control for it.
 */
export function ChatMessage(props: ChatMessageProps) {
  return <ChatMessageInner {...props} />;
}

/**
 * Memoized to avoid re-rendering every message row when the timeline re-renders
 * (e.g. a new message or reaction arrives, or the channel polls). The transport
 * supplies stable `event`/`reactions`/callback identities for unchanged rows, so
 * `React.memo`'s shallow prop compare keeps untouched rows from re-tokenizing
 * content, rebuilding emoji maps, and re-running author queries.
 */
const ChatMessageInner = memo(function ChatMessageInner({
  event,
  canWrite,
  canModerate,
  identityOverride,
  pollContext,
  poll,
  calendar,
  reactions,
  zapEnabled,
  zaps,
  onSendZap,
  onSendOnchainZap,
  sendStatus,
  highlight,
  isEditing,
  isPinned,
  replyCount = 0,
  threadParticipants,
  lastReplyAt,
  replyContext,
  heading,
  onRetry,
  onDiscard,
  onTogglePin,
  onDelete,
  onKick,
  canKick,
  onBan,
  canBan,
  onOpenThread,
  onReply,
  onForward,
  onEdit,
  onEditSubmit,
  onEditCancel,
  active = false,
  onToggleActive,
  continuation = false,
  mentionHighlight = true,
  everyoneMention = false,
  nameBadge,
  permalink,
  rumor,
  knownCommands,
}: ChatMessageProps) {
  const { user } = useCurrentUser();
  const isTouch = useIsTouch();
  const composerBoundsRef = useComposerBoundsRef();
  const author = useAuthor(identityOverride ? undefined : event.pubkey);
  const scopedName = useScopedDisplayName(identityOverride ? undefined : event.pubkey, author.data?.metadata);
  const displayName = identityOverride?.name ?? scopedName;
  // A command reads as an action ("JSKitty ran /greet with Concordia"), not as a
  // wall of raw arguments. The content still carries them for the bot.
  const invocation = useMemo(
    () => commandLine(event.content, event.tags, knownCommands),
    [event.content, event.tags, knownCommands],
  );
  // An inline reply renders a "replying to …" line above the body. The page
  // resolves it per-protocol (NIP-29 NIP-10 `e`, Concord NIP-C7 `q`) and passes
  // it as `replyContext`; its presence is the authoritative "this is a reply".
  const hasReplyContext = Boolean(replyContext);
  const isPending = sendStatus === "pending";
  const isFailed = sendStatus === "failed";
  const isOwn = user?.pubkey === event.pubkey;
  // Highlight messages that mention you, reply to you, or carry an authorized
  // Concord @everyone. Not your own messages.
  // Suppressed where a `p` tag is addressing, not mentioning (DMs).
  const mentionsMe = Boolean(
    mentionHighlight &&
      user && !isOwn && (
        everyoneMention
        || event.tags.some(([name, value]) => name === "p" && value === user.pubkey)
      ),
  );
  // Only plain group/NIP-17 chat messages are editable (polls, files and other
  // structured rows carry semantics an inline text field cannot preserve).
  const canEdit =
    isOwn &&
    (event.kind === KIND_GROUP_CHAT || event.kind === KIND_DM_CHAT) &&
    !isPending &&
    !isFailed &&
    Boolean(onEdit);
  // The author can delete their own confirmed message; moderators can delete
  // anyone's. The transport decides how (NIP-09 vs NIP-29 vs Concord delete).
  const canDelete = Boolean(onDelete) && ((isOwn && !isPending && !isFailed) || canModerate);
  // Moderators can pin any confirmed message.
  const canPin = Boolean(onTogglePin) && canModerate && !isPending && !isFailed;
  const wasEdited = event.tags.some(([name]) => name === "edited");
  const [editText, setEditText] = useState(event.content);
  const editRef = useAutosizeTextarea(editText);
  // Autosize returns a callback ref; compose it with a caret-to-end placement so
  // that opening an edit lands the cursor after the existing text (browsers
  // default `autoFocus` to the start, which reads as a single-line box with the
  // caret in the wrong place on a multi-line message). The flag resets on
  // unmount so re-editing re-places the caret.
  const caretPlacedRef = useRef(false);
  const setEditRef = useCallback(
    (el: HTMLTextAreaElement | null) => {
      editRef(el);
      if (!el) {
        caretPlacedRef.current = false;
        return;
      }
      if (caretPlacedRef.current) return;
      caretPlacedRef.current = true;
      el.focus();
      const end = el.value.length;
      el.setSelectionRange(end, end);
    },
    [editRef],
  );
  // Deleting is irreversible and now sits one tap away in the action sheet, so
  // it confirms. (It used to be a two-step "arm the trash icon" gesture, which
  // only worked because it WAS a bare icon on the hover strip.)
  const [confirmDelete, setConfirmDelete] = useState(false);
  // The touch long-press menu.
  const [sheetOpen, setSheetOpen] = useState(false);
  // Image actions contributed by the image under a long-press / right-click,
  // prepended to this row's own actions in whichever surface opens. Null for a
  // press on text or away from any image. Cleared as each surface closes.
  const [imageActions, setImageActions] = useState<MessageActionItem[] | null>(null);

  // Raw-event JSON viewer (rumor context menu).
  const [jsonOpen, setJsonOpen] = useState(false);

  // Reporting. Where a report goes is a property of the surrounding room, not
  // of this row, so it comes from the ambient chat scope: a Concord community
  // routes to its moderators, a NIP-29 server to its host relay, and anywhere
  // without a room (DMs) to the public network. `undefined` means the room has
  // moderators in principle but no way to reach them privately (a legacy
  // Concord epoch), and offers no report at all.
  const [reportOpen, setReportOpen] = useState(false);
  // The menu's collision padding forces a layout flush; compute it only while open.
  const [menuOpen, setMenuOpen] = useState(false);
  const chatScope = useChatScope();
  const reportTo = reportDestination(chatScope);
  // A mesh/proxied identity isn't a Nostr pubkey a report could name, and a
  // message you sent isn't one you report.
  const canReport = Boolean(reportTo && user && !isOwn && !identityOverride);

  // Muting, unlike reporting, needs no destination — it is a private list on
  // the user's own account — so it is offered in every room, including the ones
  // with nobody to report to. Same identity caveat: a mesh/proxied row isn't a
  // Nostr pubkey the mute list can name.
  const mute = useMuteToggle(identityOverride ? undefined : event.pubkey);

  // Hiding is viewer-local removal — instant, unpublished, undoable from its
  // toast — so like blocking it needs no destination and is offered in every
  // room.
  const hiddenMessages = useHiddenMessages();

  // Zap dialog. The button shows on others' messages when the surface supports
  // zaps; it disables (with a hint) once the author's profile has loaded
  // without a lightning address. While the profile is still loading the button
  // stays enabled — the dialog re-checks and explains.
  const [zapOpen, setZapOpen] = useState(false);
  const authorMetadata = author.data?.metadata;
  const canZap = Boolean(zapEnabled && user && !isOwn && !identityOverride);
  const zapDisabled = Boolean(author.data && !authorMetadata?.lud16 && !authorMetadata?.lud06);
  // Raw event source for the "View event JSON" menu item: the unsigned rumor
  // when present (Concord sealed chat), otherwise the signed event (NIP-29).
  const isRumor = rumor !== undefined;
  // What a report names. A rumor id resolves only for someone who holds the
  // room it was sealed in, so a PUBLIC report (a DM) names the person alone —
  // an id nobody can fetch would attest to a private conversation while proving
  // nothing about it. Everywhere else the id is worth naming: a NIP-29 message
  // is a relay-addressable event, and a Concord rumor id resolves for exactly
  // the moderators the report is encrypted to.
  const reportTarget: ReportTarget =
    isRumor && reportTo?.kind === "network"
      ? { pubkey: event.pubkey }
      : { pubkey: event.pubkey, eventId: event.id };
  // Reset the draft whenever an edit (re)starts.
  useEffect(() => {
    if (isEditing) setEditText(event.content);
  }, [isEditing, event.content]);

  // The long-press sheet also marks the row active, so the message you pressed
  // stays visibly picked out behind the sheet. (The opening gesture's spurious
  // dismiss is refused inside MessageActionSheet, so onOpenChange only ever
  // carries a real close here.)
  const openSheet = useCallback(() => {
    // A long-press on the row's text carries no image actions.
    setImageActions(null);
    setSheetOpen(true);
    if (!active) onToggleActive?.(event.id);
  }, [active, onToggleActive, event.id]);

  const handleSheetOpenChange = useCallback((open: boolean) => {
    setSheetOpen(open);
    if (!open) setImageActions(null);
    if (!open && active) onToggleActive?.(event.id);
  }, [active, onToggleActive, event.id]);

  // The image-menu bridge: an image hands its own actions up to whichever
  // surface this row opens. Touch long-press opens the sheet with them
  // prepended; a desktop right-click stages them for the context menu that the
  // same click opens (see the ContextMenuTrigger below).
  const openImageSheet = useCallback((acts: MessageActionItem[]) => {
    setImageActions(acts);
    setSheetOpen(true);
    if (!active) onToggleActive?.(event.id);
  }, [active, onToggleActive, event.id]);

  const imageMenu = useMemo<ChatImageMenu>(
    () => ({ isTouch, openSheet: openImageSheet, stage: setImageActions }),
    [isTouch, openImageSheet],
  );

  const copyMessageId = useCallback(() => {
    try {
      writeClipboardText(
        `nostr:${nip19.neventEncode({ id: event.id, author: event.pubkey })}`,
      ).catch(() => undefined);
    } catch {
      writeClipboardText(event.id).catch(() => undefined);
    }
  }, [event.id, event.pubkey]);

  // Every action the message offers, in menu order. One list drives the touch
  // sheet, the desktop `⋯` overflow and the right-click menu, so they can't
  // drift apart.
  const menuActions: MessageActionItem[] = [];
  if (canWrite && !isEditing && onReply) {
    menuActions.push({ id: "reply", label: "Reply", icon: Reply, onSelect: () => onReply(event) });
  }
  if (canWrite && !isEditing && onOpenThread) {
    menuActions.push({
      id: "thread",
      label: "Reply in thread",
      icon: MessagesSquare,
      onSelect: () => onOpenThread(event),
    });
  }
  // Not gated on `canWrite`: the forward is composed in the DESTINATION
  // conversation, so being read-only here is irrelevant. Suppressed for polls
  // and other structured rows, whose text alone (the question, without its
  // options or tally) would forward as something misleading.
  if (onForward && !isEditing && !poll && event.content.trim().length > 0) {
    menuActions.push({
      id: "forward",
      label: "Forward message",
      icon: Forward,
      onSelect: () => onForward(event),
    });
  }
  if (canZap && !isEditing && !zapDisabled) {
    menuActions.push({ id: "zap", label: "Zap message", icon: Zap, onSelect: () => setZapOpen(true) });
  }
  if (canEdit && !isEditing) {
    menuActions.push({
      id: "edit",
      label: "Edit message",
      icon: Pencil,
      onSelect: () => onEdit?.(event),
    });
  }
  if (canPin && !isEditing) {
    menuActions.push({
      id: "pin",
      label: isPinned ? "Unpin message" : "Pin message",
      icon: isPinned ? PinOff : Pin,
      onSelect: () => onTogglePin?.(event),
    });
  }
  menuActions.push({
    id: "copy-text",
    label: "Copy text",
    icon: Copy,
    groupStart: true,
    onSelect: () => writeClipboardText(event.content).catch(() => undefined),
  });
  if (!identityOverride && !rumor) {
    menuActions.push({
      id: "copy-id",
      label: "Copy message ID",
      icon: Link2,
      onSelect: copyMessageId,
    });
  }
  // Not while unconfirmed: an optimistic row's id can still change when the
  // signed event adopts its final id, and a copied link must not go stale.
  if (permalink && !isPending && !isFailed) {
    menuActions.push({
      id: "copy-link",
      label: "Copy message link",
      icon: Link,
      onSelect: () =>
        writeClipboardText(chatUrl({ ...permalink, messageId: event.id })).catch(() => undefined),
    });
  }
  menuActions.push({
    id: "json",
    label: "View event JSON",
    icon: Braces,
    onSelect: () => setJsonOpen(true),
  });
  // Hide, block, report and delete share the trailing moderation group, so only
  // the first of them opens it — two adjacent separators would read as three
  // groups. Hide leads: it is the mildest tool (this one message, this device,
  // undoable from its toast), and the escalation reads top-down from there.
  const showHide = hiddenMessages.canHide && !isEditing && !isOwn;
  const showMute = mute.canMute && !isEditing;
  const showReport = canReport && !isEditing;
  if (showHide) {
    menuActions.push({
      id: "hide",
      label: "Hide message",
      icon: EyeOff,
      groupStart: true,
      onSelect: () => hiddenMessages.hide(event.id),
    });
  }
  if (showMute) {
    menuActions.push({
      id: "mute",
      label: mute.muted ? "Unblock person" : "Block person",
      icon: mute.muted ? UserCheck : UserX,
      // Unblocking restores someone rather than removing them; styling it
      // destructive would read as the dangerous direction of the same switch.
      destructive: !mute.muted,
      groupStart: !showHide,
      onSelect: () => void mute.toggle(),
    });
  }
  if (showReport) {
    menuActions.push({
      id: "report",
      label: "Report message",
      icon: Flag,
      destructive: true,
      groupStart: !showHide && !showMute,
      onSelect: () => setReportOpen(true),
    });
  }
  if (canDelete && !isEditing) {
    menuActions.push({
      id: "delete",
      label: "Delete message",
      icon: Trash2,
      destructive: true,
      groupStart: !showHide && !showMute && !showReport,
      onSelect: () => setConfirmDelete(true),
    });
  }
  // Person-level moderation on the author (Concord). Gated per-author by the
  // page: `canKick`/`canBan` already exclude the viewer's own messages and the
  // owner. Each opens a confirmation dialog rather than acting on select. They
  // trail the destructive group, opening it only if nothing above them did.
  const showKick = Boolean(onKick) && Boolean(canKick) && !isEditing && !isOwn;
  const showBan = Boolean(onBan) && Boolean(canBan) && !isEditing && !isOwn;
  if (showKick) {
    menuActions.push({
      id: "kick",
      label: "Kick from community",
      icon: UserMinus,
      destructive: true,
      groupStart: !showMute && !showReport && !canDelete,
      onSelect: () => onKick?.(event.pubkey),
    });
  }
  if (showBan) {
    menuActions.push({
      id: "ban",
      label: "Ban from community",
      icon: Ban,
      destructive: true,
      groupStart: !showMute && !showReport && !canDelete && !showKick,
      onSelect: () => onBan?.(event.pubkey),
    });
  }

  // What the desktop hover strip doesn't show as its own button.
  const overflowActions = menuActions.filter(
    (a) => !["reply", "thread", "zap"].includes(a.id),
  );

  const toolbar = (
    <MessageActionToolbar
      reactions={canWrite && !isEditing ? reactions : undefined}
      zap={canZap && !isEditing ? { disabled: zapDisabled, onOpen: () => setZapOpen(true) } : undefined}
      overflowActions={overflowActions}
    >
      {canWrite && !isEditing && onOpenThread && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Thread"
              className="size-9 md:size-7 touch:size-11 touch:md:size-11 text-muted-foreground hover:text-primary"
              onClick={() => onOpenThread(event)}
            >
              <MessagesSquare className="size-[18px] md:size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Thread</TooltipContent>
        </Tooltip>
      )}
      {canWrite && !isEditing && onReply && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Reply"
              className="size-9 md:size-7 touch:size-11 touch:md:size-11 text-muted-foreground hover:text-primary"
              onClick={() => onReply(event)}
            >
              <Reply className="size-[18px] md:size-3.5" />
            </Button>
          </TooltipTrigger>
            <TooltipContent>Reply</TooltipContent>
          </Tooltip>
      )}
    </MessageActionToolbar>
  );

  const body = (
    <>
      {heading}
      {isEditing ? (
        <div className="mt-0.5">
          <textarea
            ref={setEditRef}
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onEditSubmit?.(event, editText);
              } else if (e.key === "Escape") {
                e.preventDefault();
                onEditCancel?.();
              }
            }}
            rows={1}
            className="block w-full resize-none rounded-md bg-background border border-input px-2 py-1.5 text-[15px] max-h-40 overflow-y-auto focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          <div className="flex items-center gap-2 touch:gap-4 mt-1 text-[11px] text-muted-foreground">
            <button
              type="button"
              className="font-semibold text-primary hover:underline touch:py-2"
              onClick={() => onEditSubmit?.(event, editText)}
            >
              Save
            </button>
            <button type="button" className="hover:text-foreground touch:py-2" onClick={() => onEditCancel?.()}>
              Cancel
            </button>
            <span className="opacity-70">escape to cancel · enter to save</span>
          </div>
        </div>
      ) : event.kind === KIND_POLL ? (
        <>
          <ChatContent event={event} className="text-[15px]" highlight={highlight} everyoneMention={everyoneMention} />
          {pollContext ? (
            <PollCard
              event={event}
              relayUrl={pollContext.relayUrl}
              groupId={pollContext.groupId}
              canVote={canWrite}
            />
          ) : poll ? (
            <PollView event={event} tally={poll.tally} canVote={canWrite} onVote={poll.vote} />
          ) : null}
        </>
      ) : event.kind === KIND_CALENDAR_TIME || event.kind === KIND_CALENDAR_DATE ? (
        calendar ? (
          <CalendarEventMessageCard
            event={calendar.event}
            tally={calendar.tally}
            canRsvp={calendar.canRsvp}
            isSettingRsvp={calendar.isSettingRsvp}
            onSetRsvp={calendar.setRsvp}
          />
        ) : null
      ) : invocation ? (
        // The same third-person action line `/me` uses. The arguments are left
        // out on purpose: they were addressed to the bot, not to the room, and
        // the bot's reply is what actually says how it went.
        <div className="text-[15px] italic text-muted-foreground">
          <span className="font-semibold not-italic text-primary">
            <DisplayName pubkey={identityOverride ? undefined : event.pubkey} name={displayName} />
          </span>{" "}
          ran{" "}
          <button
            type="button"
            // Re-arms the command in the composer, already filtered — the fast
            // path for "do that again", without retyping the arguments blind.
            onClick={(e) => {
              e.stopPropagation();
              requestCommand(invocation.name);
            }}
            className="font-mono not-italic text-primary hover:underline cursor-pointer"
          >
            /{invocation.name}
          </button>
          {invocation.bot && (
            <>
              {" "}with <InvokedBotName pubkey={invocation.bot} />
            </>
          )}
        </div>
      ) : isMeAction(event) ? (
        <div className="text-[15px] italic text-muted-foreground">
          <span className="font-semibold not-italic text-primary">
            <DisplayName pubkey={identityOverride ? undefined : event.pubkey} name={displayName} />
          </span>{" "}
          <ChatContent
            event={event}
            contentOverride={meActionText(event)}
            className="inline italic"
            highlight={highlight}
            noMentionAtPrefix
            everyoneMention={everyoneMention}
          />
        </div>
      ) : (
        <ChatContent event={event} className="text-[15px]" highlight={highlight} everyoneMention={everyoneMention} />
      )}
    </>
  );

  // The ⚡ total chip sits inline with the reaction pills (one row), as an
  // extra pill — not its own line.
  const zapPill =
    !isEditing && zaps && zaps.tally.count > 0 ? (
      <ZapPill tally={zaps.tally} canZap={canZap && !zapDisabled} onZap={() => setZapOpen(true)} />
    ) : null;

  const afterBody = (
    <>
      {!isEditing && reactions ? (
        <ReactionBar
          tallies={reactions.tallies}
          canReact={canWrite}
          onReact={reactions.react}
          leading={zapPill}
        />
      ) : (
        zapPill && <div className="flex flex-wrap items-center gap-1.5 mt-1.5">{zapPill}</div>
      )}
      {!isEditing && replyCount > 0 && onOpenThread && (
        <ThreadBadge
          count={replyCount}
          participants={threadParticipants ?? []}
          lastReplyAt={lastReplyAt}
          onClick={() => onOpenThread(event)}
        />
      )}
      {isFailed && (
        <div className="flex items-center gap-2 touch:gap-4 mt-1 text-[11px] text-destructive">
          <AlertCircle className="size-3.5 shrink-0" />
          <span>Failed to send.</span>
          {onRetry && (
            <button type="button" className="font-semibold underline hover:no-underline touch:py-2" onClick={onRetry}>
              Retry
            </button>
          )}
          {onDiscard && (
            <button type="button" className="text-muted-foreground hover:text-foreground touch:py-2" onClick={onDiscard}>
              Discard
            </button>
          )}
        </div>
      )}
    </>
  );

  const row = (
        <MessageRow
          pubkey={event.pubkey}
          identityOverride={identityOverride}
          createdAt={event.created_at}
          pending={isPending}
          edited={wasEdited && !isEditing}
          // Read straight off the message: a NIP-40 `expiration` is the only
          // thing that entitles a row to the disappearing-message clock, and
          // it's carried by the message itself on every surface that has one.
          expiresAt={expirationOf(event.tags)}
          // NIP-48: marks a message that was bridged in from another network.
          proxy={parseProxyTag(event.tags)}
          nameBadge={nameBadge}
          // Touch gets the long-press sheet instead: a horizontal strip of
          // icon buttons floated over the row can't hold this many actions on
          // a phone without wrapping across the message.
          actions={isTouch ? undefined : toolbar}
          beforeBody={hasReplyContext ? replyContext : undefined}
          afterBody={afterBody}
          continuation={
            // Collapse into the previous message only for plain consecutive chats;
            // a reply line, edit field, pin or mention needs the full header.
            continuation && !hasReplyContext && !heading && !isEditing && !isPinned && !mentionsMe
          }
          className={cn(
            // The picked-out highlight tracks the sheet alone: the row's
            // `active` state is set and cleared together with it, so keying the
            // background off `active` too only risks it lingering without a menu.
            sheetOpen && "bg-secondary/40",
            isPinned && "bg-amber-500/5",
            mentionsMe && "bg-primary/10 hover:bg-primary/15 border-l-2 border-primary pl-2",
            isFailed && "bg-destructive/5",
          )}
          containerProps={{
            "data-active": sheetOpen || undefined,
            "data-event-id": event.id,
          } as React.HTMLAttributes<HTMLDivElement>}
          onSwipeReply={isTouch && onReply ? () => onReply(event) : undefined}
          onLongPress={isTouch && !isEditing && menuActions.length > 0 ? openSheet : undefined}
        >
          {body}
        </MessageRow>
  );

  return (
    <ChatImageMenuContext.Provider value={imageMenu}>
    {/* On touch the long-press gesture belongs to the action sheet, so the
        Discord-style right-click ContextMenu isn't mounted at all — one fewer
        Radix root per row on the platform whose per-row render budget is
        tightest. Desktop keeps the right-click menu, built from the same
        action list as the touch sheet and the `⋯` overflow. */}
    {isTouch ? (
      row
    ) : (
      // Clearing image actions on close, and again in the trigger's capture
      // phase (which runs before an image's own contextmenu handler restages
      // them), keeps a right-click on text from inheriting the last image's.
      <ContextMenu onOpenChange={(open) => { setMenuOpen(open); if (!open) setImageActions(null); }}>
        <ContextMenuTrigger className="block" onContextMenuCapture={() => setImageActions(null)}>{row}</ContextMenuTrigger>
        <ContextMenuContent className="w-52" collisionPadding={menuOpen ? getComposerCollisionPadding(composerBoundsRef) : undefined}>
          {withImageActions(imageActions, menuActions).map((action) => (
            <div key={action.id}>
              {action.groupStart && <ContextMenuSeparator />}
              <ContextMenuItem
                className={action.destructive ? "text-destructive focus:text-destructive" : undefined}
                onSelect={action.onSelect}
              >
                <action.icon className="mr-2 size-4" />
                {action.label}
              </ContextMenuItem>
            </div>
          ))}
        </ContextMenuContent>
      </ContextMenu>
    )}
    {isTouch && (
      <MessageActionSheet
        open={sheetOpen}
        onOpenChange={handleSheetOpenChange}
        actions={withImageActions(imageActions, menuActions)}
        reactions={canWrite && !isEditing && reactions ? reactions : undefined}
      />
    )}
    {/* Mounted only while open, like the zap dialog below: a Radix dialog root
        per message row is pure weight on a long timeline, and neither of these
        is reachable without first opening a menu. */}
    {confirmDelete && (
    <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete message?</AlertDialogTitle>
          <AlertDialogDescription>
            This can't be undone. Relays and clients that already have it may keep their copy.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={() => onDelete?.(event)}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    )}
    {zapOpen && (
      <ZapDialog open={zapOpen} onOpenChange={setZapOpen} target={event} sendZap={onSendZap} sendOnchainZap={onSendOnchainZap} />
    )}
    {reportOpen && reportTo && (
      <ReportDialog
        open={reportOpen}
        onOpenChange={setReportOpen}
        destination={reportTo}
        target={reportTarget}
      />
    )}
    {jsonOpen && (
      <EventJsonDialog
        open={jsonOpen}
        onOpenChange={setJsonOpen}
        source={rumor ?? event}
        description={
          isRumor
            ? "The raw, unsigned rumor for this message."
            : "The raw signed event for this message."
        }
      />
    )}
    </ChatImageMenuContext.Provider>
  );
});
