import { ArrowLeft, CornerDownRight, Loader2, MessagesSquare, Pin } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { ChatComposer } from "@/components/chat/ChatComposer";
import { flashRow } from "@/components/chat/rowFlash";
import { ThreadMessage } from "@/components/chat/ThreadPanel";
import { useChatEditing } from "@/components/chat/useChatEditing";
import { DisplayName } from "@/components/DisplayName";
import { Button } from "@/components/ui/button";
import { ComposerBoundsProvider } from "@/contexts/ComposerBoundsContext";
import { isTombstoneRoot } from "@/concord/hooks/useConcordThreads";
import { buildCommentTree, flattenCommentTree, type CommentNode } from "@/concord/lib/commentTree";
import { useAndroidBack } from "@/hooks/useAndroidBack";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useHiddenMessages } from "@/hooks/useHiddenMessages";
import { useMessagePermalink } from "@/hooks/useMessagePermalink";
import { useMutedPubkeys } from "@/hooks/useMuteList";
import { cn } from "@/lib/utils";

import type { ChatMsg, ChatTransport } from "@/components/chat/transport";
import type { ReactNode } from "react";

/**
 * How deep the indentation goes. Past this a reply still nests in the data
 * but renders at the cap's depth with a "replying to" line, since a sixth
 * indent on a phone leaves no room for words.
 */
const MAX_INDENT_DEPTH = 4;
/** One level of indentation, and where its rail sits inside that level. */
const INDENT_REM = 1.5;
const RAIL_OFFSET_REM = 0.75;
/** The comment box's open/close transition, matching its Tailwind duration. */
const EXPAND_MS = 200;

/**
 * A forum post as a page in the channel pane (CORD-03 §3): the title as the
 * heading, the byline and body at reading width, then its comments as a
 * tree — a reply to a comment nests under it (its lowercase `e` names the
 * parent; `commentTree.ts`) — with the post's own comment box at the head of
 * the discussion, one line until opened. A document that opens at the TOP,
 * the way every forum opens a thread, not a
 * chat drawer that opens at its newest line.
 *
 * Every comment carries a visible Reply, and answering one opens the editor
 * IN PLACE under it rather than at the bottom of the page, so the reader is
 * never composing a reply out of sight of what it answers. One editor is open
 * at a time; the page's own comment box answers the post.
 *
 * Reuses the thread panel's row ({@link ThreadMessage}) so a comment has every
 * action a thread reply has — react, zap, edit, delete, hide, block, report —
 * from one place; only the presentation differs. The replies, the send and
 * the reactions all come from the room's {@link ChatTransport}, as in the
 * drawer, so nothing about a post is a second decode path.
 */
export function ForumPostPage({
  root,
  title,
  pinned = false,
  transport,
  groupId,
  canWrite,
  mentionPubkeys,
  conversationRelays,
  autoFocus = false,
  onBack,
  className,
}: {
  /** The post (a kind-9 root carrying a subject). */
  root: ChatMsg;
  /** Its subject, already normalized (`subjectOf`). */
  title: string;
  pinned?: boolean;
  transport: ChatTransport;
  /** The channel id, scoping the composer's draft and mention lookups. */
  groupId: string;
  canWrite: boolean;
  mentionPubkeys?: string[];
  conversationRelays?: string[];
  /** Focus the comment box on open (launched from a "comment" affordance). */
  autoFocus?: boolean;
  /** Back to the feed. */
  onBack: () => void;
  className?: string;
}) {
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const isLoading = transport.threadLoading?.(root.id) ?? false;
  const threadRepliesFor = transport.threadRepliesFor;

  // Comments live outside the timeline, so the timeline's mute/hide filter
  // never sees them; drop them here, and count what is actually shown.
  const { mutedPubkeys, ready: mutesReady } = useMutedPubkeys();
  const { hiddenIds } = useHiddenMessages();
  const comments = useMemo(() => {
    const all = threadRepliesFor?.(root.id) ?? [];
    const dropMuted = mutesReady && mutedPubkeys.size > 0;
    if (!dropMuted && hiddenIds.size === 0) return all;
    return all.filter(
      (reply) => !hiddenIds.has(reply.id) && (!dropMuted || !mutedPubkeys.has(reply.pubkey)),
    );
  }, [threadRepliesFor, root.id, mutedPubkeys, mutesReady, hiddenIds]);
  const tree = useMemo(() => buildCommentTree(root.id, comments), [root.id, comments]);
  // The tree's reading order, which is what "edit last" and permalinks walk.
  const ordered = useMemo(() => [root, ...flattenCommentTree(tree)], [root, tree]);
  const rootMuted = mutesReady && mutedPubkeys.has(root.pubkey);
  const rootGone = isTombstoneRoot(root) || rootMuted;

  const reactionsFor = transport.reactionsFor;
  const zapsFor = transport.zapsFor;
  const zapEnabled = config.zapsEnabled && Boolean(transport.zapsFor);
  const isRumor = transport.isRumor ?? false;
  const editMessage = transport.editMessage;
  const composerBoundsRef = useRef<HTMLElement | null>(null);

  const { editingId, startEditing, cancelEditing, handleEditSubmit, editLast } = useChatEditing({
    edit: (original, content) => editMessage?.(original, content),
    messages: ordered,
    isPending: (id) => transport.sendStatusFor?.(id) !== undefined,
    self: user?.pubkey,
  });

  // The comment being answered in place, if any. Switching posts drops it.
  const [replyingTo, setReplyingTo] = useState<ChatMsg | undefined>(undefined);
  useEffect(() => setReplyingTo(undefined), [root.id]);
  // The post's own comment box sits at the top of the discussion, collapsed
  // to one line until the reader means to write (Reddit's shape): a full
  // editor parked above every comment would push the discussion down for
  // everyone who came to read. Opened with intent — the box, the post's
  // Comment action, or a link that asked for the composer — it takes focus.
  const [commentOpen, setCommentOpen] = useState(autoFocus);
  useEffect(() => setCommentOpen(autoFocus), [root.id, autoFocus]);
  // The editor grows out of the one-line box rather than appearing. It stays
  // MOUNTED while closed (inert, clipped to nothing) so that opening animates
  // a box that is already laid out — mounting on click meant the transition
  // started before the composer had sized its textarea, and the height then
  // jumped to wherever that landed. Overflow is clipped except while fully
  // open, so the editor's own overlays (mention autocomplete) are free then.
  const [commentSettled, setCommentSettled] = useState(autoFocus);
  const topComposerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!commentOpen) {
      setCommentSettled(false);
      return;
    }
    // Focus at once, without scrolling — the box is still growing — and
    // let the settled state lift the clip once it has.
    topComposerRef.current?.querySelector("textarea")?.focus({ preventScroll: true });
    const settle = setTimeout(() => {
      setCommentSettled(true);
      topComposerRef.current?.scrollIntoView({ block: "nearest" });
    }, EXPAND_MS);
    return () => clearTimeout(settle);
  }, [commentOpen]);
  const openCommentBox = useCallback(() => {
    setReplyingTo(undefined);
    setCommentOpen(true);
  }, []);

  // Android back returns to the feed. Registered here rather than left to
  // history so it wins over the channel list's swipe-reveal handler.
  useAndroidBack(() => {
    onBack();
    return true;
  });

  // A page opens at its top. The scroller is reused across posts (the pane
  // does not remount on `/t/<root>` changes), so reset it per post.
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [root.id]);

  // `/t/<root>/m/<comment>`: a permalink to a comment, which exists only here.
  const scrollToComment = useCallback((id: string) => {
    const row = contentRef.current?.querySelector<HTMLElement>(`[data-event-id="${id}"]`);
    if (!row) return false;
    flashRow(row, true);
    return true;
  }, []);
  const clearCommentFocus = useMessagePermalink({
    messages: ordered,
    isLoading,
    scrollTo: scrollToComment,
    scope: "thread",
  });

  const commentCount = comments.length;
  const commentsLabel = isLoading
    ? "Comments"
    : commentCount === 0
      ? "No comments yet"
      : `${commentCount} ${commentCount === 1 ? "comment" : "comments"}`;

  const rowProps = (event: ChatMsg) => ({
    event,
    reactions: reactionsFor?.(event.id),
    zaps: zapsFor?.(event.id),
    zapEnabled,
    onSendZap: transport.sendZap,
    onSendOnchainZap: transport.sendOnchainZap,
    canReact: canWrite,
    canModerate: transport.canModerate,
    isRumor,
    everyoneMention: transport.mentionsEveryone?.(event),
    onDelete: transport.deleteMessage,
    isEditing: editingId === event.id,
    onEdit: startEditing,
    onEditSubmit: handleEditSubmit,
    onEditCancel: cancelEditing,
  });

  const composer = (parent: ChatMsg, opts: { inline: boolean }) => (
    <ChatComposer
      relayUrl="dm"
      groupId={groupId}
      messages={[]}
      layout="document"
      submitLabel={opts.inline ? "Reply" : "Comment"}
      onCancel={opts.inline ? () => setReplyingTo(undefined) : () => setCommentOpen(false)}
      mentionPubkeys={mentionPubkeys}
      canMentionEveryone={transport.canMentionEveryone}
      conversationRelays={conversationRelays}
      placeholder={opts.inline ? "Write a reply" : "Add a comment"}
      // A reply drafted under one comment is that comment's draft, not the
      // page's: putting the editor away and reopening it there finds it.
      draftScope={opts.inline ? `thread:${root.id}:${parent.id}` : `thread:${root.id}`}
      // The inline editor mounts only once asked for; the post's box is
      // always mounted and focused by the open effect instead.
      autoFocus={opts.inline}
      pollsEnabled={false}
      // A comment's attachment is sealed like the post's (the channel
      // composer and `NewPostPane` set the same): Blossom holds ciphertext,
      // the key rides in the rumor's imeta.
      encryptAttachments
      canSend={transport.canSend}
      sendOverride={async (text, tags) => {
        // The transport threads the reply off whatever it is handed: the
        // post for a top-level comment, the comment for a nested reply
        // (`buildConcordCommentTags` inherits the root pointer from it).
        await transport.sendThreadReply?.(parent, text, tags);
        if (opts.inline) setReplyingTo(undefined);
        else setCommentOpen(false);
        // Commenting is an explicit "I'm at the present": the location must
        // stop claiming an older comment is focused.
        clearCommentFocus();
      }}
      onEditLast={editMessage ? editLast : undefined}
    />
  );

  // The tree is rendered FLAT — one row per comment, indented by its depth,
  // with the connector rails drawn per row at each ancestor's column — rather
  // than as nested containers. Nesting containers would give the rails for
  // free, but everything inside them shrinks with depth, and the in-place
  // reply editor is the thing that must not: a box that loses a column per
  // level is unusable three replies in on a phone. As a flat row the editor
  // takes the full column whatever it answers, and says what that is.
  const rows: ReactNode[] = [];
  const pushRows = (nodes: readonly CommentNode[], parent: ChatMsg | undefined) => {
    for (const { comment, depth, children } of nodes) {
      // Past the indent cap the nesting is said rather than drawn.
      const capped = depth >= MAX_INDENT_DEPTH;
      const shown = Math.min(depth, MAX_INDENT_DEPTH);
      rows.push(
        <div
          key={comment.id}
          data-event-id={comment.id}
          className="relative"
          style={{ paddingLeft: `${shown * INDENT_REM}rem` }}
        >
          {Array.from({ length: shown }, (_, level) => (
            <span
              key={level}
              aria-hidden
              className="absolute inset-y-0 w-px bg-border/40"
              style={{ left: `${level * INDENT_REM + RAIL_OFFSET_REM}rem` }}
            />
          ))}
          {capped && parent && (
            <div className="flex items-center gap-1 px-3 pt-2 text-xs text-muted-foreground">
              <CornerDownRight className="size-3 shrink-0" />
              <span className="truncate">
                replying to <DisplayName pubkey={parent.pubkey} />
              </span>
            </div>
          )}
          <ThreadMessage presentation="comment" onReply={canWrite ? setReplyingTo : undefined} {...rowProps(comment)} />
        </div>,
      );
      if (replyingTo?.id === comment.id) {
        rows.push(
          <div key={`reply:${comment.id}`} className="px-3 pb-3 pt-1">
            <div className="mb-1 flex items-center gap-1 px-1 text-xs text-muted-foreground">
              <CornerDownRight className="size-3 shrink-0" />
              <span className="truncate">
                Replying to <DisplayName pubkey={comment.pubkey} />
              </span>
            </div>
            {composer(comment, { inline: true })}
          </div>,
        );
      }
      pushRows(children, comment);
    }
  };
  pushRows(tree, undefined);

  return (
    <ComposerBoundsProvider value={composerBoundsRef}>
      <div className={cn("flex min-h-0 flex-col", className)}>
        <div
          ref={scrollRef}
          className="min-h-0 flex-1 overflow-y-auto overflow-x-clip overscroll-contain scrollbar-stable"
        >
          <div ref={contentRef} className="mx-auto w-full max-w-2xl px-3 pb-6 pt-3 sm:px-4">
            <Button
              variant="ghost"
              size="sm"
              className="-ml-2 mb-2 gap-1.5 text-muted-foreground hover:text-foreground touch:h-11"
              onClick={onBack}
            >
              <ArrowLeft className="size-4" />
              All posts
            </Button>

            <article data-event-id={root.id}>
              {pinned && (
                <div className="mb-1 flex items-center gap-1 text-xs font-medium text-muted-foreground">
                  <Pin className="size-3" />
                  Pinned
                </div>
              )}
              <h1 className="mb-4 text-2xl font-semibold leading-tight break-words">{title}</h1>
              {rootGone ? (
                <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground/70">
                  <MessagesSquare className="size-4 shrink-0" />
                  <span className="italic">
                    {rootMuted
                      ? "You blocked the person who wrote this post."
                      : "The post itself isn't loaded — it may be older than the channel window."}
                  </span>
                </div>
              ) : (
                <ThreadMessage presentation="post" {...rowProps(root)} />
              )}
            </article>

            {canWrite ? (
              <div className="mt-4">
                {!commentOpen && (
                  <button
                    type="button"
                    onClick={openCommentBox}
                    className="flex w-full items-center clip-corner-lg bg-secondary/60 px-3 py-2.5 text-left text-sm text-muted-foreground transition-colors hover:bg-secondary/80 hover:text-foreground touch:py-3"
                  >
                    Add a comment
                  </button>
                )}
                <div
                  ref={topComposerRef}
                  inert={!commentOpen}
                  aria-hidden={!commentOpen}
                  className={cn(
                    "grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none",
                    commentOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
                  )}
                >
                  <div className={cn("min-h-0", !(commentOpen && commentSettled) && "overflow-hidden")}>
                    {composer(root, { inline: false })}
                  </div>
                </div>
              </div>
            ) : (
              <p className="mt-4 py-2 text-center text-xs text-muted-foreground">Join this channel to comment.</p>
            )}

            <section className="mt-6" aria-label="Comments">
              <h2 className="flex items-center gap-2 px-3 pb-1 text-sm font-semibold">
                <span>{commentsLabel}</span>
                {isLoading && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
              </h2>
              {!isLoading && rows.length > 0 && <div>{rows}</div>}
            </section>
          </div>
        </div>
      </div>
    </ComposerBoundsProvider>
  );
}
