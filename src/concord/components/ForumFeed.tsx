import { ChevronDown, Clock, Flame, Loader2, MessageSquareText, MessagesSquare, Pin, Plus } from "lucide-react";
import { memo, useEffect, useRef } from "react";

import { DisplayName } from "@/components/DisplayName";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { PillTabs, type PillTab } from "@/components/ui/pill-tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuthor } from "@/hooks/useAuthor";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { type ForumPost, type ForumSort } from "@/concord/lib/forum";
import { getAvatarShape } from "@/lib/avatarShape";
import { fullDateTime, shortTimeAgo } from "@/lib/formatTime";
import { cn } from "@/lib/utils";

import type { ReactNode } from "react";

const SORT_TABS: readonly PillTab<ForumSort>[] = [
  { id: "active", label: "Active", icon: Flame },
  { id: "newest", label: "Newest", icon: Clock },
];

/** A small round author avatar, resolved from the profile cache. */
function AuthorAvatar({ pubkey, className }: { pubkey: string; className?: string }) {
  const author = useAuthor(pubkey);
  const metadata = author.data?.metadata;
  const name = useScopedDisplayName(pubkey, metadata);
  return (
    <Avatar shape={getAvatarShape(metadata)} className={cn("size-8", className)}>
      <AvatarImage src={metadata?.picture} alt={name} />
      <AvatarFallback className="bg-primary/20 text-primary text-xs">{name[0]?.toUpperCase()}</AvatarFallback>
    </Avatar>
  );
}

/** Up to three commenter avatars, overlapping, newest first. */
function ParticipantStack({ pubkeys }: { pubkeys: readonly string[] }) {
  const shown = pubkeys.slice(0, 3);
  if (shown.length === 0) return null;
  return (
    <span className="hidden sm:flex -space-x-1.5" aria-hidden>
      {shown.map((pk) => (
        <AuthorAvatar key={pk} pubkey={pk} className="size-5 ring-2 ring-card" />
      ))}
    </span>
  );
}

/**
 * One post as a row on the shared surface — the work-item row's shape
 * (`ProjectsView`): the author's face, the title as the line, one line of
 * meta under it, the comment count on the right. Unseen activity is the
 * app's new-dot plus a bolder title and a faint primary wash, never a border.
 */
const ForumPostRow = memo(function ForumPostRow({
  post,
  isNew,
  onOpen,
}: {
  post: ForumPost;
  isNew: boolean;
  onOpen: (post: ForumPost) => void;
}) {
  const hasComments = post.replyCount > 0;
  return (
    <button
      type="button"
      onClick={() => onOpen(post)}
      data-event-id={post.root.id}
      className={cn(
        "flex w-full items-center gap-3 p-3 text-left transition-colors hover:bg-foreground/5 focus:outline-none focus-visible:bg-foreground/5",
        isNew && "bg-primary/5",
      )}
    >
      <AuthorAvatar pubkey={post.root.pubkey} className="shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          {isNew && <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-label="New activity" />}
          <span className={cn("truncate text-sm leading-5 text-foreground", isNew ? "font-bold" : "font-semibold")}>
            {post.title}
          </span>
        </span>
        <span className="block truncate text-xs leading-4 text-muted-foreground">
          <DisplayName pubkey={post.root.pubkey} />
          <span title={fullDateTime(post.root.created_at)}> · {shortTimeAgo(post.root.created_at)}</span>
          {hasComments && (
            <span title={fullDateTime(post.lastActivityAt)}> · active {shortTimeAgo(post.lastActivityAt)}</span>
          )}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {hasComments && <ParticipantStack pubkeys={post.participants} />}
        <span
          className={cn(
            "flex items-center gap-1 text-xs tabular-nums",
            isNew ? "font-medium text-primary" : "text-muted-foreground",
          )}
        >
          <MessagesSquare className="size-3.5" />
          {post.replyCount}
        </span>
      </span>
    </button>
  );
});

/** A titled group of rows: the eyebrow, then one surface holding them. */
function PostGroup({
  eyebrow,
  icon: Icon,
  children,
}: {
  eyebrow?: string;
  icon?: typeof Pin;
  children: ReactNode;
}) {
  return (
    <div>
      {eyebrow && (
        <div className="flex items-center gap-1 px-1 pb-1 text-xs font-medium text-muted-foreground">
          {Icon && <Icon className="size-3 shrink-0" />}
          {eyebrow}
        </div>
      )}
      <div className="clip-corner-lg bg-card divide-y divide-border/60">{children}</div>
    </div>
  );
}

/**
 * A forum channel (CORD-03 §2 `view: "forum"`): every titled post in the
 * loaded window as a row, pinned ones grouped first, the rest by activity or
 * by age. A row opens the post as a page in this same pane; "New post" opens
 * the composer there too.
 *
 * Purely presentational over `forumPosts()`: the same folded timeline a chat
 * channel shows, arranged differently. Paging older history is the
 * transport's `loadOlder`, reached from a sentinel at the end of the list.
 */
export function ForumFeed({
  posts,
  sort,
  onSortChange,
  isLoading,
  syncing = false,
  hasMore = false,
  isLoadingOlder = false,
  onLoadOlder,
  onOpen,
  isNew,
  onNewPost,
  banner,
  className,
}: {
  /** Already sorted (`forumPosts`), pinned first. */
  posts: readonly ForumPost[];
  sort: ForumSort;
  onSortChange: (sort: ForumSort) => void;
  /** The initial store read is still in flight (drives the skeleton). */
  isLoading: boolean;
  /** A background catch-up is running: an empty feed is not yet a verdict. */
  syncing?: boolean;
  hasMore?: boolean;
  isLoadingOlder?: boolean;
  onLoadOlder?: () => Promise<number>;
  onOpen: (post: ForumPost) => void;
  /** Whether a post has activity the reader hasn't seen. */
  isNew: (post: ForumPost) => boolean;
  /** Opens the new-post composer; undefined when the reader may not write. */
  onNewPost?: () => void;
  /** Rendered above the list (a pause banner, an access notice). */
  banner?: ReactNode;
  className?: string;
}) {
  // Page older history as the reader nears the end, the way the timeline
  // pages as they scroll up. A button stays for keyboards and for when the
  // observer can't fire (a first page that doesn't overflow).
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadOlderRef = useRef(onLoadOlder);
  loadOlderRef.current = onLoadOlder;
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore || isLoadingOlder || !onLoadOlder) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void loadOlderRef.current?.();
    }, { rootMargin: "200px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, isLoadingOlder, onLoadOlder, posts.length]);

  const empty = !isLoading && posts.length === 0;
  const pinned = posts.filter((p) => p.pinned);
  const rest = posts.filter((p) => !p.pinned);

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      {banner}

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain scrollbar-stable">
        <div className="mx-auto w-full max-w-2xl px-3 py-4 sm:px-4">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <PillTabs tabs={SORT_TABS} value={sort} onChange={onSortChange} className="w-auto" />
            {onNewPost && (
              <Button size="sm" className="ml-auto clip-corner-lg h-9 gap-1.5 touch:h-11" onClick={onNewPost}>
                <Plus className="size-4" />
                New post
              </Button>
            )}
          </div>

          {isLoading ? (
            <div className="clip-corner-lg bg-card divide-y divide-border/60">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="flex items-center gap-3 p-3">
                  <Skeleton className="size-8 rounded-full" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-3.5 w-2/3" />
                    <Skeleton className="h-3 w-1/3" />
                  </div>
                  <Skeleton className="h-3 w-6" />
                </div>
              ))}
            </div>
          ) : empty ? (
            <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
              <div className="flex size-14 items-center justify-center clip-corner-lg bg-primary/10 text-primary">
                {syncing ? <Loader2 className="size-6 animate-spin" /> : <MessageSquareText className="size-6" />}
              </div>
              <p className="font-medium">{syncing ? "Catching up" : "No posts yet"}</p>
              {onNewPost && !syncing && (
                <Button className="clip-corner-lg gap-1.5" onClick={onNewPost}>
                  <Plus className="size-4" />
                  Write the first post
                </Button>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              {pinned.length > 0 && (
                <PostGroup eyebrow="Pinned" icon={Pin}>
                  {pinned.map((post) => (
                    <ForumPostRow key={post.root.id} post={post} isNew={isNew(post)} onOpen={onOpen} />
                  ))}
                </PostGroup>
              )}
              {rest.length > 0 && (
                <PostGroup eyebrow={pinned.length > 0 ? "Posts" : undefined}>
                  {rest.map((post) => (
                    <ForumPostRow key={post.root.id} post={post} isNew={isNew(post)} onOpen={onOpen} />
                  ))}
                </PostGroup>
              )}
              {hasMore && onLoadOlder && (
                <div ref={sentinelRef} className="flex justify-center py-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="gap-1.5 text-muted-foreground"
                    disabled={isLoadingOlder}
                    onClick={() => void onLoadOlder()}
                  >
                    {isLoadingOlder ? <Loader2 className="size-4 animate-spin" /> : <ChevronDown className="size-4" />}
                    {isLoadingOlder ? "Loading older posts" : "Load older posts"}
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
