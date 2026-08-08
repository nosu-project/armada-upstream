import { Braces, ChevronDown, Copy, Flag, Link2, Link as LinkIcon, Loader2, Maximize2, MessagesSquare, Minimize2, Pencil, Trash2, UserCheck, UserX, X, Zap } from "lucide-react";
import { nip19 } from "nostr-tools";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { ChatComposer } from "@/components/chat/ChatComposer";
import { ChatContent } from "@/components/chat/ChatContent";
import { MessageActionSheet } from "@/components/chat/MessageActionSheet";
import { MessageActionToolbar } from "@/components/chat/MessageActionToolbar";
import { ProfilePreviewCard } from "@/components/chat/ProfilePreviewCard";
import { ReactionBar } from "@/components/chat/ReactionBar";
import { flashRow } from "@/components/chat/rowFlash";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAndroidBack } from "@/hooks/useAndroidBack";
import { useAppContext } from "@/hooks/useAppContext";
import { useAutosizeTextarea } from "@/hooks/useAutosizeTextarea";
import { useAuthor } from "@/hooks/useAuthor";
import { useChatScope } from "@/hooks/useChatScope";
import { useMutedPubkeys, useMuteToggle } from "@/hooks/useMuteList";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useIsTouch } from "@/hooks/useIsMobile";
import { useLongPress } from "@/hooks/useLongPress";
import { useMessagePermalink } from "@/hooks/useMessagePermalink";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { isTombstoneRoot } from "@/concord/hooks/useConcordThreads";
import { ComposerBoundsProvider, getComposerCollisionPadding, useComposerBoundsRef } from "@/contexts/ComposerBoundsContext";
import { getAvatarShape } from "@/lib/avatarShape";
import { shortClockTime } from "@/lib/formatTime";
import { writeClipboardText } from "@/lib/clipboard";
import { reportDestination, type ReportTarget } from "@/lib/report";
import { chatUrl, type ChatRoute } from "@/lib/routes";
import { cn } from "@/lib/utils";

import type { MessageActionItem } from "@/components/chat/messageActions";
import type { ChatMsg, ChatTransport, MessageReactions, MessageZaps, OnchainZapAnnouncement, ZapPayment } from "@/components/chat/transport";

/**
 * Consecutive replies from the same author within this window collapse into a
 * compact continuation (no repeated avatar/name). Matches the main timeline's
 * `CONTINUATION_WINDOW_SECONDS` in MessageTimeline.
 */
const CONTINUATION_WINDOW_SECONDS = 5 * 60;

/** Stable no-op for a zap-only pill row (no reactions resolved), so the
 * ReactionBar keeps a constant prop instead of a fresh closure per render. */
const NOOP_REACT = () => {};

/** Distance from the bottom (px) still counted as "reading the newest". */
const AT_BOTTOM_PX = 60;

/** A single message row inside the thread panel (root or reply). */
function ThreadMessage({
  event,
  reactions,
  zaps,
  zapEnabled = false,
  onSendZap,
  onSendOnchainZap,
  canReact,
  canModerate = false,
  isRumor = false,
  continuation = false,
  permalink,
  onDelete,
  isEditing = false,
  onEdit,
  onEditSubmit,
  onEditCancel,
}: {
  event: ChatMsg;
  /** This thread's route; rows append their own `/m/<id>` to it. */
  permalink?: ChatRoute;
  reactions?: MessageReactions;
  /** Aggregated zaps for this message (feeds the ⚡ total chip). */
  zaps?: MessageZaps;
  /** Whether this surface supports zaps (shows the ⚡ button on others' messages). */
  zapEnabled?: boolean;
  /** CORD.md announcement publisher (Concord); absent = NIP-57 public surface. */
  onSendZap?: (target: ChatMsg, payment: ZapPayment) => Promise<void>;
  onSendOnchainZap?: (target: ChatMsg, announcement: OnchainZapAnnouncement) => Promise<void>;
  canReact: boolean;
  /** Whether the current user may delete others' messages (moderation). */
  canModerate?: boolean;
  /**
   * Whether this message is an unsigned rumor (Concord sealed chat event).
   * Drives the "View event JSON" dialog wording and suppresses "Copy message
   * ID" (a rumor has no relay-addressable event id).
   */
  isRumor?: boolean;
  /**
   * Render as a compact continuation of the previous same-author reply: hides
   * the avatar/name/timestamp header (a hover-revealed clock time replaces the
   * avatar), mirroring the main timeline's continuation collapsing.
   */
  continuation?: boolean;
  /** Delete this message (own always; others' require moderation). Hidden when absent. */
  onDelete?: (event: ChatMsg) => void;
  /** Whether this message is currently in edit mode. */
  isEditing?: boolean;
  /** Begin editing this message (own messages only). */
  onEdit?: (event: ChatMsg) => void;
  /** Submit an inline edit. */
  onEditSubmit?: (event: ChatMsg, content: string) => void;
  /** Cancel editing. */
  onEditCancel?: () => void;
}) {
  const { user } = useCurrentUser();
  const isTouch = useIsTouch();
  const composerBoundsRef = useComposerBoundsRef();
  const author = useAuthor(event.pubkey);
  const metadata = author.data?.metadata;
  const displayName = useScopedDisplayName(event.pubkey, metadata);
  const when = new Date(event.created_at * 1000);

  const [jsonOpen, setJsonOpen] = useState(false);
  const [zapOpen, setZapOpen] = useState(false);
  // The touch long-press sheet, and delete confirmation (delete now sits one
  // tap away in the sheet/menu, so it confirms instead of firing immediately).
  const [sheetOpen, setSheetOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // A rumor has no signature; strip the synthetic empty `sig` the transport
  // adds for rendering so the JSON view reflects the true rumor shape.
  // Raw event source for the "View event JSON" menu item: a rumor has no
  // signature, so strip the synthetic empty `sig` the transport adds for
  // rendering; a signed event (NIP-29) is shown as-is.
  // Serialized only while the dialog is open: this runs per rendered row, and
  // stringifying every message's event on mount is pure cost on a channel switch.
  const sourceJson = !jsonOpen
    ? ""
    : JSON.stringify(event, null, 2);

  // The author can delete their own message; moderators can delete anyone's
  // (mirrors ChatMessage's gating). The transport decides how.
  const isOwn = user?.pubkey === event.pubkey;
  const canDelete = Boolean(onDelete) && (isOwn || canModerate);
  // Own messages are editable when the transport supports it. The transport
  // only provides editMessage for kinds it can edit, so no kind check needed.
  const canEdit = isOwn && Boolean(onEdit);
  const [editText, setEditText] = useState(event.content);
  const editRef = useAutosizeTextarea(editText);
  // Sync edit text when entering edit mode (content may have changed).
  useEffect(() => {
    if (isEditing) setEditText(event.content);
  }, [isEditing, event.content]);
  // Zap gating mirrors ChatMessage: shown on others' messages when the surface
  // supports zaps; disabled once the author's profile loads with no lightning
  // address.
  const canZap = Boolean(zapEnabled && user && !isOwn);
  const zapDisabled = Boolean(author.data && !metadata?.lud16 && !metadata?.lud06);
  // Reporting, gated exactly as in ChatMessage: the ambient chat scope decides
  // where a report goes, and an absent destination (a legacy Concord epoch,
  // which has no staff-only address) offers none.
  const [reportOpen, setReportOpen] = useState(false);
  const chatScope = useChatScope();
  const reportTo = reportDestination(chatScope);
  const canReport = Boolean(reportTo && user && !isOwn);
  // Mute needs no destination, so it is offered wherever a reply is rendered.
  const mute = useMuteToggle(event.pubkey);
  const reportTarget: ReportTarget =
    isRumor && reportTo?.kind === "network"
      ? { pubkey: event.pubkey }
      : { pubkey: event.pubkey, eventId: event.id };

  const copyMessageId = useCallback(() => {
    try {
      writeClipboardText(
        `nostr:${nip19.neventEncode({ id: event.id, author: event.pubkey })}`,
      ).catch(() => undefined);
    } catch {
      writeClipboardText(event.id).catch(() => undefined);
    }
  }, [event.id, event.pubkey]);

  const openSheet = useCallback(() => setSheetOpen(true), []);
  const longPress = useLongPress(isTouch ? openSheet : undefined);

  // One action list drives the touch long-press sheet, the desktop `⋯`
  // overflow and the right-click menu, so they can't drift apart — matching
  // ChatMessage's action model instead of the panel's older bespoke menu.
  const menuActions: MessageActionItem[] = [];
  if (canZap && !zapDisabled && !isEditing) {
    menuActions.push({ id: "zap", label: "Zap message", icon: Zap, onSelect: () => setZapOpen(true) });
  }
  if (canEdit && !isEditing) {
    menuActions.push({ id: "edit", label: "Edit message", icon: Pencil, onSelect: () => onEdit?.(event) });
  }
  menuActions.push({
    id: "copy-text",
    label: "Copy text",
    icon: Copy,
    groupStart: true,
    onSelect: () => writeClipboardText(event.content).catch(() => undefined),
  });
  if (!isRumor) {
    menuActions.push({ id: "copy-id", label: "Copy message ID", icon: Link2, onSelect: copyMessageId });
  }
  if (permalink) {
    menuActions.push({
      id: "copy-link",
      label: "Copy message link",
      icon: LinkIcon,
      onSelect: () =>
        writeClipboardText(chatUrl({ ...permalink, messageId: event.id })).catch(() => undefined),
    });
  }
  menuActions.push({ id: "json", label: "View event JSON", icon: Braces, onSelect: () => setJsonOpen(true) });
  // Mute, report and delete share the trailing destructive group; only the
  // first of them opens it.
  const showMute = mute.canMute && !isEditing;
  const showReport = canReport && !isEditing;
  if (showMute) {
    menuActions.push({
      id: "mute",
      label: mute.muted ? "Unmute person" : "Mute person",
      icon: mute.muted ? UserCheck : UserX,
      destructive: !mute.muted,
      groupStart: true,
      onSelect: () => void mute.toggle(),
    });
  }
  if (showReport) {
    menuActions.push({
      id: "report",
      label: "Report message",
      icon: Flag,
      destructive: true,
      groupStart: !showMute,
      onSelect: () => setReportOpen(true),
    });
  }
  if (canDelete && !isEditing) {
    menuActions.push({
      id: "delete",
      label: "Delete message",
      icon: Trash2,
      destructive: true,
      groupStart: !showMute && !showReport,
      onSelect: () => setConfirmDelete(true),
    });
  }
  // The desktop hover strip carries zap as its own button; the rest live in `⋯`.
  const overflowActions = menuActions.filter((a) => a.id !== "zap");

  return (
    <>
    <ContextMenu>
      {/* On touch the long-press gesture belongs to the action sheet; Radix's
          own long-press would otherwise open this menu at the same time. */}
      <ContextMenuTrigger asChild disabled={isTouch}>
        <div
          {...longPress}
          className={cn(
            "group/threadmsg relative flex items-start gap-3 px-2.5 rounded hover:bg-secondary/40 transition-colors hover:z-10 focus-within:z-10",
            continuation ? "py-0.5" : "py-1.5",
            sheetOpen && "bg-secondary/40",
          )}
        >
          {continuation ? (
            <span className="shrink-0 w-9 self-stretch flex items-start justify-end pr-0.5 pt-0.5 text-[10px] leading-none text-muted-foreground/60 opacity-0 group-hover/threadmsg:opacity-100 transition-opacity tabular-nums select-none">
              {shortClockTime(event.created_at)}
            </span>
          ) : (
            <ProfilePreviewCard pubkey={event.pubkey}>
              <button type="button" className="shrink-0 mt-0.5 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <Avatar shape={getAvatarShape(metadata)} className="size-9 cursor-pointer transition-opacity hover:opacity-90">
                  <AvatarImage src={metadata?.picture} alt={displayName} />
                  <AvatarFallback className="bg-primary/20 text-primary text-sm">
                    {displayName[0]?.toUpperCase()}
                  </AvatarFallback>
                </Avatar>
              </button>
            </ProfilePreviewCard>
          )}
          <div className="flex-1 min-w-0">
            {!continuation && (
              <div className="flex items-baseline gap-2">
                <ProfilePreviewCard pubkey={event.pubkey}>
                  <button type="button" className="text-[15px] font-semibold text-primary truncate hover:underline focus:outline-none">
                    <DisplayName pubkey={event.pubkey} name={displayName} />
                  </button>
                </ProfilePreviewCard>
                <span className="text-[11px] text-muted-foreground/70 shrink-0" title={when.toLocaleString()}>
                  {when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                </span>
              </div>
            )}
            {isEditing ? (
              <div className="mt-0.5">
                <textarea
                  ref={editRef}
                  autoFocus
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  onKeyDown={(e) => {
                    // Enter saves; Shift+Enter is a newline. Ignore the Enter
                    // that only confirms an in-progress IME composition.
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
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
            ) : (
              <ChatContent event={event} className="text-[15px]" />
            )}
            {((zaps && zaps.tally.count > 0) || (reactions && reactions.tallies.length > 0)) && (
              <ReactionBar
                tallies={reactions?.tallies ?? []}
                canReact={canReact}
                onReact={reactions?.react ?? NOOP_REACT}
                leading={
                  zaps && zaps.tally.count > 0 ? (
                    <ZapPill
                      tally={zaps.tally}
                      canZap={canZap && !zapDisabled}
                      onZap={() => setZapOpen(true)}
                    />
                  ) : undefined
                }
              />
            )}
          </div>
          {/* Desktop hover strip — the same shared toolbar the timeline uses,
              including its frequent-emoji quick-reaction row (it floats over
              the row's right edge, so the narrow panel width doesn't bound it).
              On touch the long-press sheet replaces it. */}
          {!isTouch && !isEditing ? (
            // Floated panel above the row's top-right edge — solid background,
            // border and lift so it stays legible over whatever it overlaps,
            // matching the timeline's toolbar (MessageRow).
            <div className={cn(
              "absolute right-2.5 z-20 flex flex-wrap justify-end items-center max-w-[calc(100%-1.25rem)] gap-0.5 rounded-md border bg-background/95 px-1 py-0.5 shadow-sm opacity-0 group-hover/threadmsg:opacity-100 focus-within:opacity-100 transition-opacity",
              continuation ? "-top-3" : "-top-2.5",
            )}>
              <MessageActionToolbar
                reactions={canReact ? reactions : undefined}
                zap={canZap ? { disabled: zapDisabled, onOpen: () => setZapOpen(true) } : undefined}
                overflowActions={overflowActions}
              />
            </div>
          ) : null}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52" collisionPadding={getComposerCollisionPadding(composerBoundsRef)}>
        {menuActions.map((action) => (
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
    {isTouch && (
      <MessageActionSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        actions={menuActions}
        reactions={canReact && !isEditing && reactions ? reactions : undefined}
      />
    )}
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
    <Dialog open={jsonOpen} onOpenChange={setJsonOpen}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Event JSON</DialogTitle>
          <DialogDescription>
            {isRumor
              ? "The raw, unsigned rumor for this message."
              : "The raw signed event for this message."}
          </DialogDescription>
        </DialogHeader>
        <pre className="max-h-[60vh] overflow-auto rounded-md bg-muted p-3 text-xs leading-relaxed">
          {sourceJson}
        </pre>
        <div className="flex justify-end">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => writeClipboardText(sourceJson).catch(() => undefined)}
          >
            <Copy className="mr-2 size-4" /> Copy JSON
          </Button>
        </div>
      </DialogContent>
    </Dialog>
    </>
  );
}

interface ThreadPanelProps {
  /** The root chat message this thread hangs off. */
  root: ChatMsg;
  /** The room's transport — supplies the replies, reply-send, and reactions. */
  transport: ChatTransport;
  /**
   * NIP-29 composer context: the group's host relay + `h`-tag id. Concord
   * transports send replies via {@link ChatTransport.sendThreadReply} and don't
   * use these (they pass placeholder values).
   */
  relayUrl: string;
  /** Whether this conversation may offer bot commands (see ChatComposer). */
  botCommands?: boolean;
  /** Relays this conversation uses, for bot-manifest discovery (see ChatComposer). */
  conversationRelays?: string[];
  groupId: string;
  /** Whether the current user can post replies. */
  canWrite: boolean;
  /**
   * Explicit @-mention roster for the reply composer. Required for Concord
   * transports (`relayUrl="dm"` has no NIP-29 group to derive members from);
   * NIP-29 callers can omit it and the composer derives the roster itself.
   */
  mentionPubkeys?: string[];
  /** Focus the reply input on open (e.g. when launched via /thread). */
  autoFocus?: boolean;
  /**
   * This thread's own route (`.../t/<root>`), which makes every row in here
   * linkable as what it is: a reply *inside* a thread. Without it the panel
   * offered no "Copy message link" at all, because a reply is not in the
   * timeline and the room-only link a caller could have passed would have sent
   * the reader hunting for it there.
   */
  permalink?: ChatRoute;
  /**
   * Whether the panel is actually on screen. Callers keep it mounted through
   * its slide-out animation, and during that window it must stop claiming the
   * Android back gesture — otherwise back is swallowed by a panel the reader
   * has already closed. Defaults to true for callers that unmount it outright.
   */
  open?: boolean;
  onClose: () => void;
  /** Called when the expand/collapse state changes. Parent uses this to resize the container. */
  onExpandChange?: (expanded: boolean) => void;
}

/**
 * Side panel showing a message thread: the root message, its replies, and a
 * composer for posting a new reply. Sits beside the channel timeline
 * (Slack/Discord style). It is transport-driven — NIP-29 and Concord
 * both render through it, each supplying its own replies + reply-send
 * via the {@link ChatTransport} (`threadRepliesFor`/`sendThreadReply`), so
 * replies never appear in the main timeline (they're nested here instead).
 */
export function ThreadPanel({ root, transport, relayUrl, groupId, canWrite, mentionPubkeys, botCommands, conversationRelays, autoFocus = false, open = true, permalink, onClose, onExpandChange }: ThreadPanelProps) {
  const threadRepliesFor = transport.threadRepliesFor;
  const isLoading = transport.threadLoading?.(root.id) ?? false;
  // Replies live outside the main timeline, so `MessageTimeline`'s filter never
  // sees them — the thread has to drop muted authors itself. The reply COUNT
  // below is derived from the filtered list on purpose: a count that includes
  // replies the reader can't see is a permanent "1 reply" on an empty thread.
  const { mutedPubkeys, ready: mutesReady } = useMutedPubkeys();
  const replies = useMemo(() => {
    const all = threadRepliesFor?.(root.id) ?? [];
    if (!mutesReady || mutedPubkeys.size === 0) return all;
    return all.filter((reply) => !mutedPubkeys.has(reply.pubkey));
  }, [threadRepliesFor, root.id, mutedPubkeys, mutesReady]);
  // A muted root is reachable only by permalink now that the timeline filters,
  // but "reachable only by permalink" isn't "never" — treat it like a root that
  // couldn't be loaded rather than rendering the person the reader muted.
  const rootMuted = mutesReady && mutedPubkeys.has(root.pubkey);
  const { config } = useAppContext();
  const reactionsFor = transport.reactionsFor;
  const zapsFor = transport.zapsFor;
  const zapEnabled = config.zapsEnabled && Boolean(transport.zapsFor);
  const onSendZap = transport.sendZap;
  const onSendOnchainZap = transport.sendOnchainZap;
  const isRumor = transport.isRumor ?? false;
  const canModerate = transport.canModerate;
  const onDelete = transport.deleteMessage;
  const editMessage = transport.editMessage;
  const composerBoundsRef = useRef<HTMLElement | null>(null);

  const [editingId, setEditingId] = useState<string | undefined>(undefined);
  const [isExpanded, setIsExpanded] = useState(false);

  // Notify parent when expand state changes so it can resize the container.
  useEffect(() => {
    onExpandChange?.(isExpanded);
  }, [isExpanded, onExpandChange]);

  // Android back closes the thread.
  //
  // This has to be handled here rather than left to the history fall-through
  // in `useAndroidBack`: the channel list's SwipeReveal registers a handler
  // that CONSUMES back to reveal the list, so without an entry of our own the
  // reveal would win and slide the list in with the thread still open behind
  // it. Handlers run most-recently-mounted first, and the panel mounts when it
  // opens, so it takes precedence for exactly as long as it is on screen.
  useAndroidBack(() => {
    onClose();
    return true;
  }, open);

  const handleEditSubmit = (original: ChatMsg, content: string) => {
    const trimmed = content.trim();
    if (!trimmed || trimmed === original.content.trim()) {
      setEditingId(undefined);
      return;
    }
    setEditingId(undefined);
    void editMessage?.(original, trimmed);
  };

  // --- Auto-scroll + jump-to-latest ---
  // A plain scroller, like the main timeline: replies are real DOM in normal
  // flow, so the browser anchors the reading position itself when a reply grows
  // (image, embed, reaction) instead of a virtualizer re-measuring and guessing.
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const distanceRef = useRef(0);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
    distanceRef.current = 0;
    setShowJumpToLatest(false);
  }, []);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    distanceRef.current = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowJumpToLatest(distanceRef.current > 120);
  }, []);

  // Open each thread at its newest reply.
  useLayoutEffect(() => {
    scrollToBottom("auto");
  }, [root.id, scrollToBottom]);

  // `/t/<root>/m/<reply>` — a permalink to a reply, which exists only in here
  // (thread replies are never in the main timeline). The panel's replies are
  // real DOM in normal flow, so the target is simply looked up by id; there is
  // no window to extend and nothing older to pull, so an id that isn't among
  // the loaded replies is dropped on the first pass.
  const scrollToReply = useCallback((id: string) => {
    const row = contentRef.current?.querySelector<HTMLElement>(`[data-event-id="${id}"]`);
    if (!row) return false;
    flashRow(row, true);
    // Record the new distance from the newest reply the way a real scroll
    // would: the ResizeObserver re-pins to the bottom while that reads as
    // zero, which would undo the jump the moment a reply's image resolves.
    const el = scrollRef.current;
    if (el) distanceRef.current = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowJumpToLatest(distanceRef.current > 120);
    return true;
  }, []);
  const clearReplyFocus = useMessagePermalink({
    // The root is addressable in here too: it has a timeline identity
    // (`/m/<root>`) and a thread identity (`/t/<root>/m/<root>`), and "Copy
    // message link" on the root row inside the panel produces the latter.
    messages: [root, ...replies],
    isLoading,
    scrollTo: scrollToReply,
    scope: "thread",
    // The panel stays mounted through its slide-out, and a closed panel must
    // not consume (or discard) the location's focus.
    enabled: open,
  });

  // Snap to a newly-arrived reply — the panel's long-standing behavior, unlike
  // the main timeline, which only follows for a reader already at the bottom.
  useLayoutEffect(() => {
    if (isLoading) return;
    scrollToBottom(distanceRef.current > AT_BOTTOM_PX ? "smooth" : "auto");
  }, [replies.length, isLoading, scrollToBottom]);

  // Replies growing after mount (images, link previews, reactions) and the panel
  // itself resizing (expand/collapse, the composer growing) both land here; hold
  // the reader's distance from the newest reply across either.
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const ro = new ResizeObserver(() => {
      if (distanceRef.current > AT_BOTTOM_PX) return;
      el.scrollTop = el.scrollHeight - el.clientHeight - distanceRef.current;
    });
    ro.observe(content);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Scrolls with the content above the replies: the root message (or its
  // tombstone), the reply-count divider, and the loading spinner.
  const listHeader = (
    <>
      {isTombstoneRoot(root) || rootMuted ? (
        <div className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground/70">
          <MessagesSquare className="size-4 shrink-0" />
          <span className="italic">
            {rootMuted
              ? "You muted the person who started this thread."
              : "Original message not loaded — it may be older than the channel window."}
          </span>
        </div>
      ) : (
        <div data-event-id={root.id}>
        <ThreadMessage event={root} permalink={permalink} reactions={reactionsFor?.(root.id)} zaps={zapsFor?.(root.id)} zapEnabled={zapEnabled} onSendZap={onSendZap} onSendOnchainZap={onSendOnchainZap} canReact={canWrite} canModerate={canModerate} isRumor={isRumor} onDelete={onDelete} isEditing={editingId === root.id} onEdit={(e) => setEditingId(e.id)} onEditSubmit={handleEditSubmit} onEditCancel={() => setEditingId(undefined)} />
        </div>
      )}
      <div className="flex items-center gap-2 px-3 py-1 mt-1">
        <div className="h-px flex-1 bg-border/60" />
        {!isLoading && (
          <span className="text-[11px] text-muted-foreground/60 shrink-0">
            {replies.length === 0
              ? "No replies yet"
              : `${replies.length} ${replies.length === 1 ? "reply" : "replies"}`}
          </span>
        )}
        <div className="h-px flex-1 bg-border/60" />
      </div>
      {isLoading && (
        <div className="flex justify-center py-6">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      )}
    </>
  );

  return (
    <ComposerBoundsProvider value={composerBoundsRef}>
    <aside className={cn(
      // `thread:ml-0` (not `sidebar:`) drops the left gap only at ≥1200px,
      // where the panel is an in-flow sibling flush against the timeline's
      // right edge. In the 900–1200 band it overlays the chat (see GroupChat),
      // so it keeps the `m-2` left gutter and reads as a floating card.
      "flex flex-col min-h-0 flex-1 min-w-0 m-2 sidebar:my-3 sidebar:mr-2 thread:ml-0 p-1.5 clip-corner-lg bg-chrome",
    )}>
      <div className="flex items-center justify-between px-2 py-1 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <MessagesSquare className="size-4 text-muted-foreground shrink-0" />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground truncate">
            Thread{replies.length > 0 ? ` · ${replies.length}` : ""}
          </h3>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" aria-label={isExpanded ? "Collapse thread" : "Expand thread"} className="size-6 touch:size-10 hidden md:inline-flex" onClick={() => setIsExpanded(v => !v)}>
            {isExpanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
          </Button>
          <Button variant="ghost" size="icon" aria-label="Close thread" className="size-6 touch:size-10" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
      </div>

      <div className="flex-1 min-h-0 relative">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="h-full overflow-y-auto overflow-x-clip overscroll-contain scrollbar-stable"
        >
          {/* Top padding leaves room for the root message's floated hover
              toolbar, which sits above its row's top edge and would otherwise
              be clipped by the scroll viewport's top. */}
          <div ref={contentRef} className="pt-3">
            {listHeader}
            {!isLoading && replies.map((reply, index) => {
              // Collapse consecutive same-author replies within a short window
              // into a compact continuation, mirroring the main timeline. The
              // root never continues into the first reply (the divider splits
              // them).
              const prev = replies[index - 1];
              const continuation =
                !!prev &&
                prev.pubkey === reply.pubkey &&
                reply.created_at - prev.created_at < CONTINUATION_WINDOW_SECONDS;
              return (
                <div key={reply.id} data-event-id={reply.id} className="pt-1">
                  <ThreadMessage event={reply} permalink={permalink} reactions={reactionsFor?.(reply.id)} zaps={zapsFor?.(reply.id)} zapEnabled={zapEnabled} onSendZap={onSendZap} onSendOnchainZap={onSendOnchainZap} canReact={canWrite} canModerate={canModerate} isRumor={isRumor} continuation={continuation} onDelete={onDelete} isEditing={editingId === reply.id} onEdit={(e) => setEditingId(e.id)} onEditSubmit={handleEditSubmit} onEditCancel={() => setEditingId(undefined)} />
                </div>
              );
            })}
          </div>
        </div>
        {showJumpToLatest && (
          <div className="absolute bottom-3 inset-x-0 z-10 flex justify-center pointer-events-none">
            <button
              type="button"
              onClick={() => scrollToBottom()}
              className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-secondary/90 backdrop-blur px-4 py-2 text-xs font-medium text-foreground shadow-lg hover:bg-secondary transition-colors"
              aria-label="Jump to latest replies"
            >
              <ChevronDown className="size-4" />
              Jump to latest
            </button>
          </div>
        )}
      </div>

      {canWrite ? (
        <ChatComposer
          relayUrl={relayUrl}
          botCommands={botCommands}
          conversationRelays={conversationRelays}
          groupId={groupId}
          messages={[]}
          mentionPubkeys={mentionPubkeys}
          placeholder="Reply in thread…"
          draftScope={`thread:${root.id}`}
          autoFocus={autoFocus}
          canSend={transport.canSend}
          sendOverride={async (text, tags) => {
            await transport.sendThreadReply?.(root, text, tags);
            // Replying is an explicit "I'm at the present", so the panel
            // snaps to the new reply — the location must stop claiming the
            // reader is parked at some older one.
            clearReplyFocus();
          }}
        />
      ) : (
        <div className="p-3 shrink-0 pb-safe">
          <p className="text-xs text-muted-foreground text-center py-1">
            Join this channel to reply.
          </p>
        </div>
      )}
    </aside>
    </ComposerBoundsProvider>
  );
}
