import { AtSign, CheckCheck, ChevronLeft, Inbox } from "lucide-react";
import { useMemo, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";

import { ChannelSidebar } from "@/components/layout/ChannelSidebar";
import { ServerRail } from "@/components/layout/ServerRail";
import { SwipeReveal } from "@/components/layout/SwipeReveal";
import { ServerScopeProvider } from "@/components/ServerScopeProvider";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { useAuthor } from "@/hooks/useAuthor";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { channelReadKey, useReadState } from "@/hooks/useReadState";
import { useRelayGroups } from "@/hooks/useRelayGroups";
import { useRelayInbox, type InboxItem } from "@/hooks/useRelayInbox";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { shortTimeAgo } from "@/lib/formatTime";
import { KIND_COMMENT } from "@/lib/nip29";
import { relayToRouteParam, routeParamToRelay } from "@/lib/platform";
import { cn } from "@/lib/utils";

/** One inbox row: who mentioned you, where, and a preview — click to open it. */
function InboxRow({
  item,
  channelName,
  onOpen,
}: {
  item: InboxItem;
  channelName: string;
  onOpen: (item: InboxItem) => void;
}) {
  const { event, unread } = item;
  const author = useAuthor(event.pubkey);
  const metadata = author.data?.metadata;
  const displayName = useScopedDisplayName(event.pubkey, metadata);
  // Strip URLs to a paperclip so a link-only mention still reads as something.
  const preview = event.content.replace(/https?:\/\/\S+/g, "📎").trim() || "📎";

  return (
    <button
      type="button"
      onClick={() => onOpen(item)}
      className={cn(
        "group/inbox flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors clip-corner-lg",
        "hover:bg-foreground/5",
        unread && "bg-primary/[0.06]",
      )}
    >
      <Avatar className="size-9 shrink-0">
        <AvatarImage src={metadata?.picture} alt={displayName} />
        <AvatarFallback className="bg-primary/20 text-primary text-xs">
          {displayName[0]?.toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className={cn("truncate text-sm", unread ? "font-semibold" : "font-medium")}>
            {displayName}
          </span>
          <span className="flex items-center gap-1 truncate text-xs text-muted-foreground">
            <AtSign className="size-3 shrink-0" />
            {channelName}
          </span>
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">
            {shortTimeAgo(event.created_at)}
          </span>
        </div>
        <p
          className={cn(
            "mt-0.5 line-clamp-2 break-words text-sm",
            unread ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {preview}
        </p>
      </div>
      {unread && <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" aria-label="Unread" />}
    </button>
  );
}

/**
 * A server's Inbox: every message across its channels that @-mentions you,
 * newest first (mail-client style). Mirrors the Projects drill-down — the rail +
 * channel list sit underneath and the inbox pane slides over them on mobile.
 * Works on any NIP-29 server, not just Buzz.
 */
export function InboxPage() {
  const { server } = useParams<{ server: string }>();
  const relayUrl = server ? routeParamToRelay(server) : undefined;
  const navigate = useNavigate();
  const { user } = useCurrentUser();
  const { markRead } = useReadState();
  const [channelsOpen, setChannelsOpen] = useState(false);

  const { data: groups } = useRelayGroups(relayUrl);
  const groupIds = useMemo(() => (groups ?? []).map((g) => g.id), [groups]);
  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of groups ?? []) m.set(g.id, g.name);
    return m;
  }, [groups]);

  const { items, unreadCount } = useRelayInbox(relayUrl, groupIds);

  if (!relayUrl) {
    return <Navigate to="/" replace />;
  }

  const openItem = (item: InboxItem) => {
    if (relayUrl) {
      // Clear the badge immediately; the channel's own on-view read also fires.
      markRead(channelReadKey(relayUrl, item.groupId), item.event.created_at);
    }
    // A threaded (NIP-22) reply carries its root in the uppercase `E` tag — open
    // the thread panel on it; a plain message just opens the channel.
    const root =
      item.event.kind === KIND_COMMENT
        ? item.event.tags.find(([n]) => n === "E")?.[1]
        : undefined;
    const path = `/s/${relayToRouteParam(relayUrl)}/${encodeURIComponent(item.groupId)}`;
    navigate(root ? `${path}?thread=${encodeURIComponent(root)}` : path);
  };

  const markAllRead = () => {
    if (!relayUrl) return;
    // Advance each channel's read marker to its newest unread mention.
    const latestByGroup = new Map<string, number>();
    for (const item of items) {
      if (!item.unread) continue;
      latestByGroup.set(
        item.groupId,
        Math.max(latestByGroup.get(item.groupId) ?? 0, item.event.created_at),
      );
    }
    for (const [groupId, ts] of latestByGroup) {
      markRead(channelReadKey(relayUrl, groupId), ts);
    }
  };

  return (
    <ServerScopeProvider relayUrl={relayUrl}>
      <SwipeReveal
        open={channelsOpen}
        onReveal={() => setChannelsOpen(true)}
        onClose={() => setChannelsOpen(false)}
        underlay={
          <>
            <ServerRail />
            <ChannelSidebar
              relayUrl={relayUrl}
              onNavigate={() => setChannelsOpen(false)}
              className="flex-1 sidebar:flex-none"
            />
          </>
        }
      >
        <main className="flex-1 min-w-0 flex flex-col safe-area-top h-full">
          {/* Header — matches GroupPage / ProjectsPage's floating command bar. */}
          <header className="relative h-12 touch:h-14 mx-2 mt-3 px-2 sidebar:px-3 flex items-center gap-1.5 shrink-0 clip-corner-lg bg-chrome">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Back to channels"
              className="size-9 touch:size-11 shrink-0 sidebar:hidden"
              onClick={() => setChannelsOpen(true)}
            >
              <ChevronLeft className="size-5" />
            </Button>
            <Inbox className="size-5 text-muted-foreground shrink-0" />
            <div className="min-w-0 flex-1">
              <h1 className="font-semibold truncate leading-tight">Inbox</h1>
            </div>
            {unreadCount > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 touch:h-10 gap-1.5 text-xs text-muted-foreground"
                onClick={markAllRead}
              >
                <CheckCheck className="size-4" />
                Mark all read
              </Button>
            )}
          </header>

          <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2">
            {!user ? (
              <div className="px-3 py-16 text-center text-sm text-muted-foreground">
                Sign in to see messages that mention you.
              </div>
            ) : items.length === 0 ? (
              <div className="flex flex-col items-center gap-3 px-3 py-16 text-center text-muted-foreground">
                <Inbox className="size-10 opacity-40" />
                <p className="text-sm">
                  No mentions yet. When someone @-mentions you in a channel here,
                  it&rsquo;ll show up in your inbox.
                </p>
              </div>
            ) : (
              <div className="mx-auto max-w-2xl space-y-0.5">
                {items.map((item) => (
                  <InboxRow
                    key={item.event.id}
                    item={item}
                    channelName={nameById.get(item.groupId) ?? item.groupId}
                    onOpen={openItem}
                  />
                ))}
              </div>
            )}
          </div>
        </main>
      </SwipeReveal>
    </ServerScopeProvider>
  );
}

export default InboxPage;
