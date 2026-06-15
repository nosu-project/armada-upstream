import { Loader2, MessageSquare, Plus, X } from "lucide-react";
import { nip19 } from "nostr-tools";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, Navigate } from "react-router-dom";

import { ChatComposer } from "@/components/chat/ChatComposer";
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
  active,
  onClick,
}: {
  peer: string;
  preview: NostrEvent | undefined;
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
            {/* Content is encrypted on the wire; the list only knows there is
                activity, not the plaintext (decryption happens in the thread). */}
            Encrypted message
          </div>
        )}
      </div>
    </button>
  );
}

function MessageBubble({ mine, content }: { mine: boolean; content: string }) {
  return (
    <div className={cn("flex", mine ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[75%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap break-words",
          mine ? "bg-primary text-primary-foreground" : "bg-secondary",
        )}
      >
        {content}
      </div>
    </div>
  );
}

function Conversation({ peer }: { peer: string }) {
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
      <header className="h-12 mx-2 mt-3 px-3 flex items-center gap-2 shrink-0 clip-corner-lg bg-chrome">
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
            <MessageBubble key={m.id} mine={m.pubkey === user?.pubkey} content={m.content} />
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
 * Top-level Direct Messages surface (Discord-style: DMs live at the account
 * layer, not inside any server). A conversation list on the left, the active
 * thread on the right. DMs are NIP-04 kind-4 events on the Armada relay.
 */
export function DMsPage() {
  const navigate = useNavigate();
  const { peer: rawPeer } = useParams<{ peer: string }>();
  const { user } = useCurrentUser();
  const dmSupported = useDMSupport();
  const { conversations, isLoading } = useDMConversations();
  const [composing, setComposing] = useState(false);

  const activePeer = rawPeer ? resolvePubkey(rawPeer) : undefined;

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
      <ServerRail className="hidden sidebar:flex" />

      {/* Conversation list pane — full screen on mobile when no peer selected. */}
      <aside
        className={cn(
          "relative flex flex-col w-full sidebar:w-60 shrink-0 bg-chrome safe-area-top",
          activePeer && "hidden sidebar:flex",
        )}
      >
        <header className="h-12 mx-2 mt-3 px-3 flex items-center gap-2 shrink-0 clip-corner-lg bg-chrome">
          <MessageSquare className="size-5 text-muted-foreground" />
          <h1 className="font-semibold flex-1">Direct Messages</h1>
          <Button
            variant="ghost"
            size="icon"
            aria-label="New message"
            className="size-8"
            onClick={() => setComposing(true)}
          >
            <Plus className="size-5" />
          </Button>
        </header>

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
                active={c.peer === activePeer}
                onClick={() => openPeer(c.peer)}
              />
            ))
          )}
        </div>

        {composing && (
          <NewDMDialog onPick={openPeer} onClose={() => setComposing(false)} />
        )}
      </aside>

      {/* Thread pane */}
      <main
        className={cn(
          "flex-1 min-w-0 flex flex-col safe-area-top",
          !activePeer && "hidden sidebar:flex",
        )}
      >
        {activePeer ? (
          <Conversation key={activePeer} peer={activePeer} />
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
