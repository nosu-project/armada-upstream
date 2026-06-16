import { ArrowLeft, Headphones, Loader2, MessageSquare, Phone, Plus, Search, X } from "lucide-react";
import { nip19 } from "nostr-tools";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, Navigate } from "react-router-dom";

import { ChatComposer } from "@/components/chat/ChatComposer";
import { ChatContent } from "@/components/chat/ChatContent";
import { MessageRow } from "@/components/chat/MessageRow";
import { LoginArea } from "@/components/auth/LoginArea";
import { ServerRail } from "@/components/layout/ServerRail";
import { VoicePresence } from "@/components/VoicePresence";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAppContext } from "@/hooks/useAppContext";
import { useAuthor } from "@/hooks/useAuthor";
import { useCall } from "@/hooks/useCall";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import {
  useDMConversations,
  useDirectMessages,
  useDMSupport,
  type DecryptedDM,
} from "@/hooks/useDirectMessages";
import { useDmVoiceRelay, useLivekitParticipants } from "@/hooks/useLivekit";
import { useSearchProfiles } from "@/hooks/useSearchProfiles";
import { dmReadKey, useReadState } from "@/hooks/useReadState";
import { useToast } from "@/hooks/useToast";
import { effectiveDmRelays } from "@/contexts/AppContext";
import { getAvatarShape } from "@/lib/avatarShape";
import { deriveDmRoomId } from "@/lib/dmVoice";
import { getDisplayName } from "@/lib/getDisplayName";
import { PLATFORM_RELAYS } from "@/lib/platform";
import { cn } from "@/lib/utils";

import type { NostrEvent } from "@nostrify/nostrify";

/** Resolve a typed npub/nprofile/hex string to a hex pubkey, or undefined. */
function resolvePubkey(input: string): string | undefined {
  const value = input.trim();
  if (/^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase();
  try {
    const decoded = nip19.decode(value);
    if (decoded.type === "npub") return decoded.data;
    if (decoded.type === "nprofile") return decoded.data.pubkey;
  } catch {
    // not bech32
  }
  return undefined;
}

function ConversationRow({
  peer,
  preview,
  previewText,
  unread,
  inCall,
  selfPubkey,
  voiceRelay,
  query,
  active,
  onClick,
}: {
  peer: string;
  preview: NostrEvent | undefined;
  previewText: string | undefined;
  unread: boolean;
  inCall: boolean;
  selfPubkey: string | undefined;
  voiceRelay: string | undefined;
  query: string;
  active: boolean;
  onClick: () => void;
}) {
  const author = useAuthor(peer);
  const metadata = author.data?.metadata;
  const name = getDisplayName(metadata, peer);

  // Live voice presence for this DM (kind 39004), so we can show when the peer
  // is waiting in a call even if we haven't joined — mirroring the channel
  // list. Gated on a resolved LiveKit-capable relay (same relay-level
  // capability the call button uses).
  const roomId = selfPubkey ? deriveDmRoomId(selfPubkey, peer) : undefined;
  const { data: participants } = useLivekitParticipants(
    voiceRelay && roomId ? voiceRelay : undefined,
    voiceRelay && roomId ? roomId : undefined,
  );
  // Others in the DM room (exclude ourselves; our own presence is shown by
  // `inCall`). For a 1:1 DM this is just the peer.
  const others = (participants ?? []).filter((pk) => pk !== selfPubkey);
  const othersInVoice = !inCall && others.length > 0;

  // When searching, hide rows that match neither the contact name nor the
  // (decrypted) last-message preview. DMs are NIP-04 encrypted, so deeper
  // full-text search isn't possible relay-side.
  const q = query.trim().toLowerCase();
  if (q) {
    const haystack = `${name} ${metadata?.nip05 ?? ""} ${previewText ?? ""}`.toLowerCase();
    if (!haystack.includes(q)) return null;
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-2.5 w-full px-2 py-2 rounded-lg text-left transition-colors",
        active ? "bg-secondary" : "hover:bg-secondary/60",
      )}
    >
      <Avatar shape={getAvatarShape(metadata)} className="size-9 shrink-0">
        <AvatarImage src={metadata?.picture} alt={name} />
        <AvatarFallback className="bg-primary/20 text-primary text-xs">
          {name[0]?.toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className={cn("text-sm truncate", unread ? "font-semibold text-foreground" : "font-medium")}>
          {name}
        </div>
        {preview && (
          <div className={cn("text-xs truncate", unread ? "text-foreground/80" : "text-muted-foreground")}>
            {previewText ?? "Encrypted message"}
          </div>
        )}
      </div>
      {inCall ? (
        <span
          className="shrink-0 flex size-5 items-center justify-center rounded-full bg-success text-success-foreground"
          aria-label="Voice call in progress"
        >
          <Headphones className="size-3" />
        </span>
      ) : othersInVoice ? (
        <VoicePresence participants={others} className="text-success/90" />
      ) : unread ? (
        <span className="shrink-0 size-2 rounded-full bg-primary" aria-label="Unread messages" />
      ) : null}
    </button>
  );
}

/**
 * Max gap between two same-author DMs for the later one to render as a compact
 * continuation (no repeated avatar/name/timestamp). 5 minutes.
 */
const DM_CONTINUATION_WINDOW_SECONDS = 5 * 60;

/**
 * A single direct message, rendered with the same flat row layout as group
 * chat messages (shared `MessageRow` + rich `ChatContent` body). DMs carry no
 * tags, so we adapt the decrypted message into a minimal event for rendering.
 */
function DMMessage({ message, continuation }: { message: DecryptedDM; continuation?: boolean }) {
  const event = useMemo<NostrEvent>(
    () => ({
      id: message.id,
      pubkey: message.pubkey,
      created_at: message.created_at,
      kind: 4,
      content: message.content,
      tags: [],
      sig: "",
    }),
    [message],
  );

  return (
    <MessageRow pubkey={message.pubkey} createdAt={message.created_at} continuation={continuation}>
      <ChatContent event={event} className="text-[15px]" />
    </MessageRow>
  );
}

function Conversation({ peer, onBack }: { peer: string; onBack: () => void }) {
  const author = useAuthor(peer);
  const name = getDisplayName(author.data?.metadata, peer);
  const { messages, isLoading, send, loadOlder, hasMore, isLoadingOlder } = useDirectMessages(peer);
  const { markRead } = useReadState();
  const { toast } = useToast();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const { activeCall, joinDmCall } = useCall();
  const scrollRef = useRef<HTMLDivElement>(null);
  // Pre-prepend scroll metrics, used to hold the reading position when older
  // messages are backfilled above the viewport.
  const restoreScrollRef = useRef<{ height: number; top: number } | null>(null);

  // Voice: derive the shared DM room id and find a LiveKit-capable relay to
  // host the call. DMs are stored on general app relays (which usually don't
  // run LiveKit); the Armada platform relays do, and both peers share that
  // pinned list — so prefer them, falling back to the DM relays.
  const roomId = user ? deriveDmRoomId(user.pubkey, peer) : undefined;
  const dmRelays = useMemo(() => effectiveDmRelays(config), [config]);
  const voiceCandidates = useMemo(
    () => [...PLATFORM_RELAYS, ...dmRelays.filter((r) => !PLATFORM_RELAYS.includes(r))],
    [dmRelays],
  );
  const { data: voiceRelay } = useDmVoiceRelay(voiceCandidates);
  const hasVoice = Boolean(roomId && voiceRelay);
  const inThisCall = Boolean(roomId && activeCall?.groupId === roomId);

  // Live presence in the DM room (kind 39004), so both peers see who's in.
  const { data: participants } = useLivekitParticipants(
    hasVoice ? voiceRelay! : undefined,
    hasVoice ? roomId : undefined,
  );
  const inCallCount = participants?.length ?? 0;
  // Others (exclude us) currently in this DM's voice room — for the presence
  // avatar stack in the header.
  const dmOthersInVoice = useMemo(
    () => (participants ?? []).filter((pk) => pk !== user?.pubkey),
    [participants, user?.pubkey],
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const restore = restoreScrollRef.current;
    if (restore) {
      restoreScrollRef.current = null;
      el.scrollTop = restore.top + (el.scrollHeight - restore.height);
      return;
    }
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Backfill older history when the user scrolls near the top.
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (hasMore && !isLoadingOlder && el.scrollTop < 200) {
      restoreScrollRef.current = { height: el.scrollHeight, top: el.scrollTop };
      void loadOlder().then((added) => {
        if (added === 0) restoreScrollRef.current = null;
      });
    }
  }, [hasMore, isLoadingOlder, loadOlder]);

  // Mark the thread read up to the newest message while it's visible.
  useEffect(() => {
    if (messages.length === 0) return;
    const latest = messages[messages.length - 1]?.created_at ?? 0;
    if (latest <= 0) return;
    const stamp = () => {
      if (document.visibilityState === "visible") markRead(dmReadKey(peer), latest);
    };
    stamp();
    document.addEventListener("visibilitychange", stamp);
    return () => document.removeEventListener("visibilitychange", stamp);
  }, [messages, peer, markRead]);

  const handleSubmit = useCallback(
    async (text: string) => {
      try {
        await send(text);
      } catch (e) {
        toast({
          title: "Message not sent",
          description: e instanceof Error ? e.message : "The relay rejected the message.",
          variant: "destructive",
        });
        throw e; // keep the composer's content so the user can retry
      }
    },
    [send, toast],
  );

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <header className="h-12 mx-2 mt-3 px-2 sidebar:px-3 flex items-center gap-2 shrink-0 clip-corner-lg bg-chrome">
        {/* Mobile back → returns to the rail + conversation list (the shared
            DM-list view), the same panes that are persistently rendered. */}
        <Button
          variant="ghost"
          size="icon"
          aria-label="Back to conversations"
          className="size-9 shrink-0 sidebar:hidden"
          onClick={onBack}
        >
          <ArrowLeft className="size-5" />
        </Button>
        <Avatar shape={getAvatarShape(author.data?.metadata)} className="size-7">
          <AvatarImage src={author.data?.metadata?.picture} alt={name} />
          <AvatarFallback className="bg-primary/20 text-primary text-[10px]">
            {name[0]?.toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <h1 className="font-semibold truncate flex-1 min-w-0">{name}</h1>
        {/* Who's in this DM's voice room (others, not us) — shown whether or
            not we've joined, so the peer waiting in a call is visible. */}
        {dmOthersInVoice.length > 0 && (
          <VoicePresence participants={dmOthersInVoice} className="text-success/90" />
        )}
        {hasVoice && !inThisCall && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Start voice call"
                className="relative size-8 shrink-0 text-muted-foreground hover:text-success"
                onClick={() => joinDmCall(voiceRelay!, roomId!, peer)}
              >
                <Phone className="size-4" />
                {inCallCount > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-success" aria-hidden />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {inCallCount > 0 ? "Join voice call (active)" : "Start voice call"}
            </TooltipContent>
          </Tooltip>
        )}
      </header>

      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain scrollbar-stable px-3 py-4">
        {isLoading ? (
          <div className="space-y-3 p-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="flex items-start gap-3">
                <Skeleton className="size-10 rounded-full shrink-0" />
                <div className="space-y-1 flex-1">
                  <Skeleton className="h-3 w-24" />
                  <Skeleton className="h-3 w-2/3" />
                </div>
              </div>
            ))}
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <MessageSquare className="size-10 text-muted-foreground/40 mb-3" />
            <p className="text-sm text-muted-foreground">No messages yet</p>
            <p className="text-xs text-muted-foreground/60 mt-1">Say hello to {name}!</p>
          </div>
        ) : (
          <>
            {isLoadingOlder && (
              <div className="flex justify-center py-3">
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              </div>
            )}
            {messages.map((m, i) => {
              const prev = messages[i - 1];
              const continuation =
                !!prev &&
                prev.pubkey === m.pubkey &&
                m.created_at - prev.created_at < DM_CONTINUATION_WINDOW_SECONDS;
              return <DMMessage key={m.id} message={m} continuation={continuation} />;
            })}
          </>
        )}
      </div>

      <ChatComposer
        relayUrl="dm"
        groupId={peer}
        messages={[]}
        placeholder={`Message ${name}…`}
        sendOverride={handleSubmit}
      />
    </div>
  );
}

function NewDMDialog({ onPick, onClose }: { onPick: (pubkey: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const { data: profiles } = useSearchProfiles(query);
  const direct = resolvePubkey(query);

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-background">
      <div className="flex items-center gap-2 p-3 border-b">
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search name or paste npub…"
          className="h-9"
        />
        <Button variant="ghost" size="icon" aria-label="Close" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
        {direct && (
          <ProfilePick pubkey={direct} onPick={onPick} />
        )}
        {(profiles ?? [])
          .filter((p) => p.pubkey !== direct)
          .map((p) => (
            <ProfilePick key={p.pubkey} pubkey={p.pubkey} onPick={onPick} />
          ))}
      </div>
    </div>
  );
}

function ProfilePick({ pubkey, onPick }: { pubkey: string; onPick: (pubkey: string) => void }) {
  const author = useAuthor(pubkey);
  const metadata = author.data?.metadata;
  const name = getDisplayName(metadata, pubkey);
  return (
    <button
      type="button"
      onClick={() => onPick(pubkey)}
      className="flex items-center gap-2.5 w-full px-2 py-2 rounded-lg text-left hover:bg-secondary/60 transition-colors"
    >
      <Avatar shape={getAvatarShape(metadata)} className="size-8 shrink-0">
        <AvatarImage src={metadata?.picture} alt={name} />
        <AvatarFallback className="bg-primary/20 text-primary text-xs">
          {name[0]?.toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <span className="text-sm font-medium truncate">{name}</span>
    </button>
  );
}

/**
 * The DM conversation-list pane: header, conversation rows, and the
 * new-message dialog. Reused by both the desktop aside and the mobile drawer.
 */
function ConversationList({
  rows,
  previews,
  activePeer,
  dmSupported,
  isLoading,
  composing,
  setComposing,
  openPeer,
  className,
}: {
  rows: { peer: string; latest: NostrEvent }[];
  previews: Record<string, string>;
  activePeer: string | undefined;
  dmSupported: boolean;
  isLoading: boolean;
  composing: boolean;
  setComposing: (value: boolean) => void;
  openPeer: (pubkey: string) => void;
  className?: string;
}) {
  const { user } = useCurrentUser();
  const { getLastRead } = useReadState();
  const { registerCallBarSlot, activeCall } = useCall();
  const { config } = useAppContext();
  const [search, setSearch] = useState("");

  // The shared DM voice relay (same derivation as the open conversation): a
  // LiveKit-capable relay from the platform list, then the user's DM relays.
  // Computed once here so each row can query its peer's voice presence without
  // re-resolving the relay per row.
  const dmRelays = useMemo(() => effectiveDmRelays(config), [config]);
  const voiceCandidates = useMemo(
    () => [...PLATFORM_RELAYS, ...dmRelays.filter((r) => !PLATFORM_RELAYS.includes(r))],
    [dmRelays],
  );
  const { data: voiceRelay } = useDmVoiceRelay(voiceCandidates);

  // Register this pane's slot so the persistent call bar portals above the
  // account pill on desktop (mirrors ChannelSidebar). The mobile fixed bottom
  // bar is handled separately by CallProvider.
  const callBarRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = callBarRef.current;
    if (!el) return;
    return registerCallBarSlot(el);
  }, [registerCallBarSlot]);

  return (
    <aside
      className={cn(
        "relative flex flex-col min-w-0 shrink-0 bg-chrome safe-area-top",
        className,
      )}
    >
      <header className="relative pl-5 pr-3 pt-5 pb-3 flex flex-col justify-center shrink-0">
        <h1 className="font-semibold truncate leading-tight tracking-wide text-sm pr-8">Direct Messages</h1>
        <span className="text-[11px] text-muted-foreground truncate leading-tight">
          Message your friends.
        </span>
        <Button
          variant="ghost"
          size="icon"
          aria-label="New message"
          className="absolute right-3 bottom-3 size-8"
          onClick={() => setComposing(true)}
        >
          <Plus className="size-5" />
        </Button>
      </header>

      {/* Search conversations by contact name or last message. */}
      <div className="px-3 pb-2 shrink-0">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search conversations…"
            className="h-8 pl-8 text-sm"
          />
        </div>
      </div>

      {/* Divider between the header and the conversation list. */}
      <div className="mx-3 h-0.5 shrink-0 bg-chrome-divider" />

      <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
        {!dmSupported ? (
          <p className="text-sm text-muted-foreground p-3">
            Your signer doesn't support encryption, so direct messages are unavailable.
          </p>
        ) : isLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground p-3">
            No conversations yet. Start one with the + button.
          </p>
        ) : (
          rows.map((c) => (
            <ConversationRow
              key={c.peer}
              peer={c.peer}
              preview={c.latest}
              previewText={previews[c.peer]}
              query={search}
              unread={
                Boolean(c.latest) &&
                c.latest.pubkey !== user?.pubkey &&
                c.latest.created_at > getLastRead(dmReadKey(c.peer)) &&
                c.peer !== activePeer
              }
              active={c.peer === activePeer}
              inCall={Boolean(activeCall?.dmPeer) && activeCall?.dmPeer === c.peer}
              selfPubkey={user?.pubkey}
              voiceRelay={voiceRelay ?? undefined}
              onClick={() => openPeer(c.peer)}
            />
          ))
        )}
      </div>

      {composing && (
        <NewDMDialog onPick={openPeer} onClose={() => setComposing(false)} />
      )}

      {/* Voice call bar slot — the persistent call UI portals here on desktop. */}
      <div ref={callBarRef} className="empty:hidden shrink-0" />

      {/* Account switcher pinned to the bottom, matching the server channel
          sidebar (DMs require an account, so the user is always present). */}
      <div className="px-3 pb-safe shrink-0">
        <LoginArea className="w-full flex" />
      </div>
    </aside>
  );
}

/**
 * Top-level Direct Messages surface (Discord-style: DMs live at the account
 * layer, not inside any server). A conversation list on the left, the active
 * thread on the right. DMs are NIP-04 kind-4 events on the Armada relay.
 */
export function DMsPage() {
  const navigate = useNavigate();
  const { peer: rawPeer } = useParams<{ peer: string }>();
  const { user } = useCurrentUser();
  const dmSupported = useDMSupport();
  const { conversations, previews, isLoading } = useDMConversations();
  const [composing, setComposing] = useState(false);

  const activePeer = rawPeer ? resolvePubkey(rawPeer) : undefined;

  // The peer whose thread is mounted. It lags behind `activePeer` so the thread
  // stays rendered while it slides out on mobile (back navigation), then it's
  // cleared once the slide-out finishes. Opening a peer updates it immediately.
  const [renderedPeer, setRenderedPeer] = useState(activePeer);
  useEffect(() => {
    if (activePeer) {
      setRenderedPeer(activePeer);
      return;
    }
    // No active peer: keep the last thread mounted for the slide-out, then drop.
    const timer = setTimeout(() => setRenderedPeer(undefined), 250);
    return () => clearTimeout(timer);
  }, [activePeer]);

  // Conversations plus the active peer if it's a brand-new thread.
  const rows = useMemo(() => {
    const list = conversations.map((c) => ({ peer: c.peer, latest: c.latest }));
    if (activePeer && !list.some((c) => c.peer === activePeer)) {
      list.unshift({ peer: activePeer, latest: undefined as unknown as NostrEvent });
    }
    return list;
  }, [conversations, activePeer]);

  const openPeer = useCallback(
    (pubkey: string) => {
      setComposing(false);
      navigate(`/dms/${nip19.npubEncode(pubkey)}`);
    },
    [navigate],
  );

  if (!user) {
    return <Navigate to="/" replace />;
  }

  return (
    <>
      {/* Leftmost rail + conversation list — the persistent DM-list view. On
          mobile they stay in place underneath while the thread slides over
          them, so going back is a smooth slide-out (not a hard cut). */}
      <ServerRail className={cn(activePeer && "hidden sidebar:flex")} />

      <ConversationList
        rows={rows}
        previews={previews}
        activePeer={activePeer}
        dmSupported={dmSupported}
        isLoading={isLoading}
        composing={composing}
        setComposing={setComposing}
        openPeer={openPeer}
        className={cn(
          "flex-1 sidebar:flex-none sidebar:w-60",
          activePeer && "hidden sidebar:flex",
        )}
      />

      {/* Thread pane. On mobile it's an overlay that slides in from the right
          when a peer is active and slides out on back; on desktop it's a static
          side-by-side pane. */}
      <main
        className={cn(
          "flex flex-col safe-area-top bg-background",
          // Mobile: full-screen overlay that slides horizontally.
          "absolute inset-0 z-10 transition-transform duration-200 ease-out",
          activePeer ? "translate-x-0" : "translate-x-full",
          // Desktop: static pane, no transform/overlay.
          "sidebar:static sidebar:z-auto sidebar:flex-1 sidebar:min-w-0 sidebar:translate-x-0 sidebar:transition-none",
        )}
      >
        {renderedPeer ? (
          <Conversation
            key={renderedPeer}
            peer={renderedPeer}
            onBack={() => navigate("/dms")}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center text-muted-foreground">
            <div className="flex flex-col items-center gap-3">
              <MessageSquare className="size-12 opacity-30" />
              <p className="text-sm">Select a conversation</p>
            </div>
          </div>
        )}
      </main>
    </>
  );
}
