import { ArrowLeft, Loader2, MessageSquare, Plus, X } from "lucide-react";
import { nip19 } from "nostr-tools";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, Navigate } from "react-router-dom";

import { ChatComposer } from "@/components/chat/ChatComposer";
import { LoginArea } from "@/components/auth/LoginArea";
import { ServerRail } from "@/components/layout/ServerRail";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuthor } from "@/hooks/useAuthor";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import {
  useDMConversations,
  useDirectMessages,
  useDMSupport,
} from "@/hooks/useDirectMessages";
import { useSearchProfiles } from "@/hooks/useSearchProfiles";
import { useToast } from "@/hooks/useToast";
import { getAvatarShape } from "@/lib/avatarShape";
import { getDisplayName } from "@/lib/getDisplayName";
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
  active,
  onClick,
}: {
  peer: string;
  preview: NostrEvent | undefined;
  previewText: string | undefined;
  active: boolean;
  onClick: () => void;
}) {
  const author = useAuthor(peer);
  const metadata = author.data?.metadata;
  const name = getDisplayName(metadata, peer);

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
        <div className="text-sm font-medium truncate">{name}</div>
        {preview && (
          <div className="text-xs text-muted-foreground truncate">
            {previewText ?? "Encrypted message"}
          </div>
        )}
      </div>
    </button>
  );
}

function formatDmTime(seconds: number): string {
  const date = new Date(seconds * 1000);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (sameDay) return time;
  const dayMs = 86_400_000;
  const yesterday = new Date(now.getTime() - dayMs).toDateString() === date.toDateString();
  if (yesterday) return `Yesterday ${time}`;
  const date_ = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${date_} ${time}`;
}

function MessageBubble({
  mine,
  content,
  createdAt,
}: {
  mine: boolean;
  content: string;
  createdAt: number;
}) {
  return (
    <div className={cn("flex flex-col", mine ? "items-end" : "items-start")}>
      <div
        className={cn(
          "max-w-[75%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap break-words",
          mine ? "bg-primary text-primary-foreground" : "bg-secondary",
        )}
      >
        {content}
      </div>
      <span className="text-[10px] text-muted-foreground mt-0.5 px-1 select-none">
        {formatDmTime(createdAt)}
      </span>
    </div>
  );
}

function Conversation({ peer, onBack }: { peer: string; onBack: () => void }) {
  const { user } = useCurrentUser();
  const author = useAuthor(peer);
  const name = getDisplayName(author.data?.metadata, peer);
  const { messages, isLoading, send } = useDirectMessages(peer);
  const { toast } = useToast();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

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
        <h1 className="font-semibold truncate">{name}</h1>
      </header>

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-3 py-4 space-y-2">
        {isLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground">
            <MessageSquare className="size-10 opacity-40 mb-3" />
            <p className="text-sm">No messages yet. Say hello.</p>
          </div>
        ) : (
          messages.map((m) => (
            <MessageBubble
              key={m.id}
              mine={m.pubkey === user?.pubkey}
              content={m.content}
              createdAt={m.created_at}
            />
          ))
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
              active={c.peer === activePeer}
              onClick={() => openPeer(c.peer)}
            />
          ))
        )}
      </div>

      {composing && (
        <NewDMDialog onPick={openPeer} onClose={() => setComposing(false)} />
      )}

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
