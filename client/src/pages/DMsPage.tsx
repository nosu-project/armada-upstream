import { BellOff, ChevronLeft, Headphones, Loader2, MessageSquare, PenSquare, Phone, Plus, Search, UserCheck, Users, X } from "lucide-react";
import { nip19 } from "nostr-tools";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type UIEvent } from "react";
import { useNavigate, useParams, Navigate } from "react-router-dom";

import { CallStageSlot } from "@/components/chat/CallStageSlot";
import { DittoIcon } from "@/components/brand/DittoIcon";
import { ChatComposer } from "@/components/chat/ChatComposer";
import { ChatMessage } from "@/components/chat/ChatMessage";
import { MessageRow } from "@/components/chat/MessageRow";
import { MessageTimeline } from "@/components/chat/MessageTimeline";
import { LoginArea } from "@/components/auth/LoginArea";
import { ServerRail } from "@/components/layout/ServerRail";
import { SwipeReveal } from "@/components/layout/SwipeReveal";
import { VoicePresence } from "@/components/VoicePresence";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
import { useAppContext } from "@/hooks/useAppContext";
import { useAuthor } from "@/hooks/useAuthor";
import { useCall } from "@/hooks/useCall";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useFollowList } from "@/hooks/useFollowList";
import { useMuteUser } from "@/hooks/useMuteList";
import {
  useDMConversations,
  useDMSupport,
} from "@/hooks/useDirectMessages";
import { useDmTransport } from "@/hooks/useDmTransport";
import { useDmVoiceRelay, useLivekitParticipants } from "@/hooks/useLivekit";
import { useSearchProfiles, type SearchProfile } from "@/hooks/useSearchProfiles";
import { dmReadKey, useReadState } from "@/hooks/useReadState";
import { useToast } from "@/hooks/useToast";
import { effectiveDmRelays } from "@/contexts/AppContext";
import { getAvatarShape } from "@/lib/avatarShape";
import { deriveDmRoomId } from "@/lib/dmVoice";
import { dittoProfileUrl } from "@/lib/dittoUrl";
import { getDisplayName } from "@/lib/getDisplayName";
import { DM_VOICE_RELAYS, PLATFORM_RELAYS } from "@/lib/platform";
import { sanitizeUrl } from "@/lib/sanitizeUrl";
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
 * A not-yet-decrypted DM placeholder. It reserves the row (so scroll
 * length/position stay correct in the timeline) and shows a muted shimmer until
 * it scrolls into view, at which point `observePlaceholder` triggers its
 * decrypt. Decrypted messages render through the shared `ChatMessage` instead.
 */
function DmPlaceholderRow({
  id,
  pubkey,
  createdAt,
  continuation,
  observePlaceholder,
}: {
  id: string;
  pubkey: string;
  createdAt: number;
  continuation?: boolean;
  observePlaceholder: (el: HTMLElement, id: string) => () => void;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    return observePlaceholder(el, id);
  }, [id, observePlaceholder]);

  return (
    <div ref={rowRef} data-event-id={id}>
      <MessageRow pubkey={pubkey} createdAt={createdAt} continuation={continuation}>
        <Skeleton className="h-3 w-40 max-w-full" />
      </MessageRow>
    </div>
  );
}

function Conversation({ peer, onBack }: { peer: string; onBack: () => void }) {
  const author = useAuthor(peer);
  const name = getDisplayName(author.data?.metadata, peer);
  const dittoProfileHref = dittoProfileUrl(peer);
  const { transport, encryptedIds, decryptVisible, send } = useDmTransport(peer);
  const { messages } = transport;
  const { markRead } = useReadState();
  const { toast } = useToast();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const { activeCall, joinDmCall } = useCall();
  const muteUser = useMuteUser();

  // Inline message search: toggled from the header, filters the loaded thread
  // client-side (no extra relay queries). The mute confirm dialog is opened
  // from the header's mute button.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [muteConfirmOpen, setMuteConfirmOpen] = useState(false);

  // Reset the inline search whenever we switch conversations.
  useEffect(() => {
    setSearchOpen(false);
    setSearchQuery("");
  }, [peer]);

  // Messages shown after applying the inline search filter (case-insensitive
  // substring match on the decrypted text). Encrypted placeholders have no
  // searchable text yet, so they're excluded while a query is active.
  const normalizedSearch = searchQuery.trim().toLocaleLowerCase();
  const searchResults = useMemo(
    () =>
      normalizedSearch
        ? messages.filter(
            (m) => !encryptedIds.has(m.id) && m.content.toLocaleLowerCase().includes(normalizedSearch),
          )
        : [],
    [messages, encryptedIds, normalizedSearch],
  );

  // Voice: derive the shared DM room id and find a LiveKit-capable relay to
  // host the call. DMs are stored on general app relays (which usually don't
  // run LiveKit); the Armada platform relays do, and both peers share that
  // pinned list — so prefer them, falling back to the DM relays.
  const roomId = user ? deriveDmRoomId(user.pubkey, peer) : undefined;
  const dmRelays = useMemo(() => effectiveDmRelays(config), [config]);
  const voiceCandidates = useMemo(
    () => {
      // Prefer the user's pinned/DM relays, then fall back to the platform's
      // default LiveKit-capable relay so 1:1 voice works even when none of the
      // user's own relays host the NIP-29 LiveKit extension. Deduped.
      const ordered = [...PLATFORM_RELAYS, ...dmRelays, ...DM_VOICE_RELAYS];
      return ordered.filter((r, i) => ordered.indexOf(r) === i);
    },
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

  // Lazy decryption: a single IntersectionObserver decrypts placeholder rows as
  // they scroll into view, so opening a long thread only pays for the visible
  // screenful up front. The element→id map lets the observer callback look up
  // which message a row belongs to; `observePlaceholder` (passed to each
  // DmPlaceholderRow) registers it. The observer keys off element visibility,
  // independent of the MessageTimeline's scroll container.
  const elementIds = useRef(new WeakMap<Element, string>());
  // Always call the latest decryptVisible without re-creating the observer.
  const decryptVisibleRef = useRef(decryptVisible);
  decryptVisibleRef.current = decryptVisible;
  const observerRef = useRef<IntersectionObserver | null>(null);
  if (!observerRef.current && typeof IntersectionObserver !== "undefined") {
    observerRef.current = new IntersectionObserver(
      (entries) => {
        // Decrypt bottom-up: a thread is anchored to the newest message at the
        // bottom, so the visible rows should fill in from the bottom of the
        // screen upward, not top-down. Sort the intersecting rows by vertical
        // position (lowest on screen first) before kicking off their decrypts.
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.boundingClientRect.top - a.boundingClientRect.top);
        for (const entry of visible) {
          const id = elementIds.current.get(entry.target);
          if (id) decryptVisibleRef.current(id);
        }
      },
      { rootMargin: "200px 0px" },
    );
  }
  useEffect(() => () => observerRef.current?.disconnect(), []);

  const observePlaceholder = useCallback((el: HTMLElement, id: string) => {
    const observer = observerRef.current;
    if (!observer) {
      // No IntersectionObserver (very old env / tests): decrypt immediately.
      decryptVisibleRef.current(id);
      return () => {};
    }
    elementIds.current.set(el, id);
    observer.observe(el);
    return () => {
      observer.unobserve(el);
      elementIds.current.delete(el);
    };
  }, []);

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
        // Resolves as soon as the message is signed + optimistically rendered;
        // relay delivery happens in the background and is reflected by the
        // message's status (sending / failed + retry), so the composer clears
        // immediately and the send button never blocks on the relay.
        await send(text);
      } catch (e) {
        // Only signing/encryption errors reach here (publish failures are
        // surfaced inline on the message). Keep the composer content to retry.
        toast({
          title: "Message not sent",
          description: e instanceof Error ? e.message : "Could not sign the message.",
          variant: "destructive",
        });
        throw e;
      }
    },
    [send, toast],
  );

  const handleMute = useCallback(async () => {
    setMuteConfirmOpen(false);
    try {
      await muteUser.mutateAsync(peer);
      toast({ title: "Muted", description: `You won't see messages from ${name}.` });
      // Leave the (now-hidden) thread — the conversation list filters out
      // muted peers, so returning to it drops this conversation.
      onBack();
    } catch (e) {
      toast({
        title: "Couldn't mute",
        description: e instanceof Error ? e.message : "Failed to update your mute list.",
        variant: "destructive",
      });
    }
  }, [muteUser, peer, name, toast, onBack]);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <header className="h-12 touch:h-14 mx-2 mt-3 px-2 sidebar:px-3 flex items-center gap-2 shrink-0 clip-corner-lg bg-chrome">
        {/* Mobile back → returns to the rail + conversation list (the shared
            DM-list view), the same panes that are persistently rendered. */}
        <Button
          variant="ghost"
          size="icon"
          aria-label="Back to conversations"
          className="size-9 shrink-0 sidebar:hidden"
          onClick={onBack}
        >
          <ChevronLeft className="size-5" />
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
                className="relative size-8 touch:size-10 shrink-0 text-muted-foreground hover:text-success"
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
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={searchOpen ? "Close search" : "Search messages"}
              aria-pressed={searchOpen}
              className="size-8 touch:size-10 shrink-0 text-muted-foreground hover:text-foreground"
              onClick={() => setSearchOpen((open) => !open)}
            >
              {searchOpen ? <X className="size-4" /> : <Search className="size-4" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{searchOpen ? "Close search" : "Search messages"}</TooltipContent>
        </Tooltip>
        {dittoProfileHref && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`View ${name} on Ditto`}
                className="size-8 touch:size-10 shrink-0 text-muted-foreground hover:text-foreground"
                asChild
              >
                <a href={dittoProfileHref} target="_blank" rel="noopener noreferrer">
                  <DittoIcon className="size-4" />
                </a>
              </Button>
            </TooltipTrigger>
            <TooltipContent>View on Ditto</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Mute ${name}`}
              className="size-8 touch:size-10 shrink-0 text-muted-foreground hover:text-destructive"
              onClick={() => setMuteConfirmOpen(true)}
            >
              <BellOff className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Mute conversation</TooltipContent>
        </Tooltip>
      </header>

      {/* Inline message search — filters the loaded thread client-side. */}
      {searchOpen && (
        <div className="mx-2 mt-2 px-1 shrink-0">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setSearchOpen(false);
                  setSearchQuery("");
                }
              }}
              placeholder="Search messages…"
              aria-label="Search messages"
              className="pl-8 pr-8"
            />
            {searchQuery && (
              <button
                type="button"
                aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => setSearchQuery("")}
              >
                <X className="size-4" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Top-of-chat call stage portal target (active when this DM is in call). */}
      <CallStageSlot active={inThisCall} />

      {normalizedSearch ? (
        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain scrollbar-stable px-3 py-4">
          {searchResults.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <Search className="size-10 text-muted-foreground/40 mb-3" />
              <p className="text-sm text-muted-foreground">No matching messages</p>
              <p className="text-xs text-muted-foreground/60 mt-1">
                Only loaded messages are searched — scroll up to load more.
              </p>
            </div>
          ) : (
            <>
              <p className="px-2 pb-1 text-[11px] uppercase tracking-wide text-muted-foreground/80">
                {searchResults.length} result{searchResults.length === 1 ? "" : "s"}
              </p>
              {searchResults.map((msg) => (
                <ChatMessage
                  key={msg.id}
                  event={msg}
                  canWrite={transport.canWrite}
                  canModerate={transport.canModerate}
                  highlight={searchQuery}
                  sendStatus={transport.sendStatusFor?.(msg.id)}
                  continuation={false}
                />
              ))}
            </>
          )}
        </div>
      ) : (
        <MessageTimeline
          transport={transport}
          className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain scrollbar-stable px-3 py-4"
          emptyState={
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <MessageSquare className="size-10 text-muted-foreground/40 mb-3" />
              <p className="text-sm text-muted-foreground">No messages yet</p>
              <p className="text-xs text-muted-foreground/60 mt-1">Say hello to {name}!</p>
            </div>
          }
          renderMessage={(msg, continuation) =>
            encryptedIds.has(msg.id) ? (
              <DmPlaceholderRow
                key={msg.id}
                id={msg.id}
                pubkey={msg.pubkey}
                createdAt={msg.created_at}
                continuation={continuation}
                observePlaceholder={observePlaceholder}
              />
            ) : (
              <ChatMessage
                key={msg.id}
                event={msg}
                canWrite={transport.canWrite}
                canModerate={transport.canModerate}
                sendStatus={transport.sendStatusFor?.(msg.id)}
                onRetry={transport.retry ? () => transport.retry!(msg) : undefined}
                continuation={continuation}
              />
            )
          }
        />
      )}

      <ChatComposer
        relayUrl="dm"
        groupId={peer}
        messages={[]}
        placeholder={`Message ${name}…`}
        sendOverride={handleSubmit}
      />

      <AlertDialog open={muteConfirmOpen} onOpenChange={setMuteConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Mute {name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This conversation will be hidden and you won't see new messages from {name}.
              You can unmute them later from your mute list.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleMute();
              }}
              disabled={muteUser.isPending}
            >
              {muteUser.isPending ? "Muting…" : "Mute"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** A single recipient suggestion row inside the new-DM pane. */
function RecipientSuggestion({
  pubkey,
  metadata,
  active,
  followed,
  onSelect,
}: {
  pubkey: string;
  metadata: SearchProfile["metadata"] | undefined;
  active: boolean;
  followed: boolean;
  onSelect: () => void;
}) {
  const name = getDisplayName(metadata, pubkey);
  const picture = sanitizeUrl(metadata?.picture);
  // Prefer a human-readable NIP-05 handle; fall back to the (truncated) npub.
  const npub = nip19.npubEncode(pubkey);
  const handle = metadata?.nip05 ?? `${npub.slice(0, 12)}…${npub.slice(-6)}`;

  return (
    <button
      type="button"
      onClick={onSelect}
      data-active={active}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg p-2.5 text-left transition-colors",
        active ? "bg-secondary" : "hover:bg-secondary/60",
      )}
    >
      <Avatar shape={getAvatarShape(metadata)} className="size-9 shrink-0">
        <AvatarImage src={picture} alt={name} />
        <AvatarFallback className="bg-primary/20 text-primary text-xs">
          {name[0]?.toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{name}</span>
          {followed && (
            <UserCheck className="size-3.5 shrink-0 text-primary" aria-label="You follow this person" />
          )}
        </div>
        <span className="block truncate text-xs text-muted-foreground">{handle}</span>
      </div>
    </button>
  );
}

/**
 * A recipient row whose metadata isn't in the search results yet — e.g. a
 * pasted npub/nprofile that resolved to a raw pubkey. Resolves the author
 * profile on its own so it shows an avatar/name instead of a bare key.
 */
function ResolvedRecipientSuggestion({
  pubkey,
  active,
  followed,
  onSelect,
}: {
  pubkey: string;
  active: boolean;
  followed: boolean;
  onSelect: () => void;
}) {
  const author = useAuthor(pubkey);
  return (
    <RecipientSuggestion
      pubkey={pubkey}
      metadata={author.data?.metadata}
      active={active}
      followed={followed}
      onSelect={onSelect}
    />
  );
}

/**
 * The "start a new chat" pane. Renders in the thread column in place of the
 * empty-state prompt (no modal). A "To:" field drives debounced profile
 * autocomplete — followed contacts first, then NIP-50 relay hits, plus a pasted
 * npub/nprofile/hex as a direct match — and the suggestions render inline below
 * the field with full keyboard nav (↑/↓ to move, Enter to open, Esc to cancel).
 */
function NewDMPane({
  onSelectRecipient,
  onCancel,
}: {
  onSelectRecipient: (pubkey: string) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const { data: profiles, isFetching, followedPubkeys } = useSearchProfiles(query);
  const trimmed = query.trim();

  // A pasted npub/nprofile/hex resolves to a pubkey we can DM directly, even if
  // it isn't in the search results. Surface it first, de-duped against results.
  const direct = resolvePubkey(query);
  const recipients = useMemo(() => {
    const fromSearch = (profiles ?? []).filter((p) => p.pubkey !== direct);
    const list: { pubkey: string; metadata?: SearchProfile["metadata"]; resolved?: boolean }[] = [];
    if (direct) list.push({ pubkey: direct, resolved: true });
    for (const p of fromSearch) list.push({ pubkey: p.pubkey, metadata: p.metadata });
    return list;
  }, [profiles, direct]);

  // Reset the highlighted row whenever the candidate set changes.
  useEffect(() => {
    setActiveIndex(0);
  }, [recipients.length]);

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
      return;
    }
    if (recipients.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % recipients.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + recipients.length) % recipients.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const chosen = recipients[activeIndex];
      if (chosen) onSelectRecipient(chosen.pubkey);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col safe-area-top">
      <header className="h-12 touch:h-14 mx-2 mt-3 px-2 sidebar:px-3 flex items-center gap-2 shrink-0 clip-corner-lg bg-chrome">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Back to conversations"
          className="size-9 shrink-0 sidebar:hidden"
          onClick={onCancel}
        >
          <ChevronLeft className="size-5" />
        </Button>
        <PenSquare className="size-4 text-muted-foreground shrink-0" />
        <h1 className="font-semibold truncate flex-1 min-w-0">New message</h1>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Cancel"
          className="size-8 shrink-0 text-muted-foreground hidden sidebar:inline-flex"
          onClick={onCancel}
        >
          <X className="size-4" />
        </Button>
      </header>

      <div className="px-3 pt-3 pb-2 shrink-0">
        <label htmlFor="dm-recipient" className="mb-1.5 block text-xs font-medium text-muted-foreground">
          To:
        </label>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="dm-recipient"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search a name or paste an npub…"
            autoComplete="off"
            className="h-10 pl-8 pr-8 text-sm"
          />
          {isFetching && (
            <Loader2 className="absolute right-2.5 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-3 space-y-0.5">
        {recipients.length > 0 ? (
          recipients.map((r, index) =>
            r.resolved ? (
              <ResolvedRecipientSuggestion
                key={r.pubkey}
                pubkey={r.pubkey}
                active={index === activeIndex}
                followed={followedPubkeys.has(r.pubkey)}
                onSelect={() => onSelectRecipient(r.pubkey)}
              />
            ) : (
              <RecipientSuggestion
                key={r.pubkey}
                pubkey={r.pubkey}
                metadata={r.metadata}
                active={index === activeIndex}
                followed={followedPubkeys.has(r.pubkey)}
                onSelect={() => onSelectRecipient(r.pubkey)}
              />
            ),
          )
        ) : (
          <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
            <PenSquare className="size-8 text-primary/70" />
            <p className="mx-auto max-w-xs text-sm text-muted-foreground">
              {trimmed
                ? isFetching
                  ? "Searching…"
                  : "No one found. Try a different name, or paste an npub."
                : "Search for someone by name, or paste their npub to start a conversation."}
            </p>
          </div>
        )}
      </div>
    </div>
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
  onCompose,
  friendsOnly,
  setFriendsOnly,
  openPeer,
  loadMore,
  hasMore,
  isLoadingMore,
  className,
}: {
  rows: { peer: string; latest: NostrEvent }[];
  previews: Record<string, string>;
  activePeer: string | undefined;
  dmSupported: boolean;
  isLoading: boolean;
  onCompose: () => void;
  friendsOnly: boolean;
  setFriendsOnly: (updater: (v: boolean) => boolean) => void;
  openPeer: (pubkey: string) => void;
  loadMore: () => Promise<number>;
  hasMore: boolean;
  isLoadingMore: boolean;
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
    () => {
      // Prefer the user's pinned/DM relays, then fall back to the platform's
      // default LiveKit-capable relay so 1:1 voice works even when none of the
      // user's own relays host the NIP-29 LiveKit extension. Deduped.
      const ordered = [...PLATFORM_RELAYS, ...dmRelays, ...DM_VOICE_RELAYS];
      return ordered.filter((r, i) => ordered.indexOf(r) === i);
    },
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

  // Page in older conversations when the list is scrolled near the bottom.
  // Mirrors the per-relay cursor backfill in useDMConversations: each scroll to
  // the end advances every non-exhausted relay one page.
  const handleListScroll = useCallback(
    (e: UIEvent<HTMLDivElement>) => {
      if (!hasMore || isLoadingMore) return;
      const el = e.currentTarget;
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 300) {
        void loadMore();
      }
    },
    [hasMore, isLoadingMore, loadMore],
  );

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
        <div className="absolute right-3 bottom-3 flex items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={friendsOnly ? "Showing people you follow" : "Show only people you follow"}
                aria-pressed={friendsOnly}
                className={cn("size-8 touch:size-10 text-muted-foreground", friendsOnly && "text-primary")}
                onClick={() => setFriendsOnly((v) => !v)}
              >
                <Users className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {friendsOnly ? "Showing friends only" : "Friends only"}
            </TooltipContent>
          </Tooltip>
          <Button
            variant="ghost"
            size="icon"
            aria-label="New message"
            className="size-8 touch:size-10"
            onClick={onCompose}
          >
            <Plus className="size-5" />
          </Button>
        </div>
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

      <div className="flex-1 overflow-y-auto p-2 space-y-0.5" onScroll={handleListScroll}>
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
            {friendsOnly
              ? "No conversations with people you follow. Turn off the friends filter to see everyone."
              : "No conversations yet. Start one with the + button."}
          </p>
        ) : (
          <>
            {rows.map((c) => (
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
            ))}
            {isLoadingMore && (
              <div className="flex justify-center py-3">
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              </div>
            )}
          </>
        )}
      </div>

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
  const { conversations, previews, isLoading, loadMore, hasMore, isLoadingMore } = useDMConversations();
  const { data: followData } = useFollowList();
  const [composing, setComposing] = useState(false);
  // "Friends only" toggle: when on, the conversation list is narrowed to people
  // the user follows (kind 3). Muted people are already excluded upstream in
  // useDMConversations regardless of this toggle.
  const [friendsOnly, setFriendsOnly] = useState(false);
  const followedPubkeys = useMemo(
    () => new Set(followData?.pubkeys ?? []),
    [followData?.pubkeys],
  );

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

  // Composing takes over the thread column immediately — drop any lingering
  // slide-out thread so the recipient picker shows without a thread flashing.
  useEffect(() => {
    if (composing) setRenderedPeer(undefined);
  }, [composing]);

  // Conversations plus the active peer if it's a brand-new thread. When the
  // friends filter is on, narrow to followed peers — but always keep the peer
  // whose thread is currently open so the row you're reading never vanishes.
  const rows = useMemo(() => {
    let list = conversations.map((c) => ({ peer: c.peer, latest: c.latest }));
    if (friendsOnly) {
      list = list.filter((c) => followedPubkeys.has(c.peer) || c.peer === activePeer);
    }
    if (activePeer && !list.some((c) => c.peer === activePeer)) {
      list.unshift({ peer: activePeer, latest: undefined as unknown as NostrEvent });
    }
    return list;
  }, [conversations, activePeer, friendsOnly, followedPubkeys]);

  const openPeer = useCallback(
    (pubkey: string) => {
      setComposing(false);
      // Mount the thread synchronously in the same render that closes the
      // compose pane, so we never fall through to the empty state for a frame
      // between `composing` going false and the route-driven effect setting
      // `renderedPeer`. (Without this the "Select a conversation" screen flashes
      // when switching from a new-message draft to an existing conversation.)
      setRenderedPeer(pubkey);
      navigate(`/dms/${nip19.npubEncode(pubkey)}`);
    },
    [navigate],
  );

  if (!user) {
    return <Navigate to="/" replace />;
  }

  // Reveal the conversation list (slide the thread/compose pane away) by
  // clearing the active peer and cancelling compose; return to the still-mounted
  // thread by re-selecting it.
  const revealList = () => {
    setComposing(false);
    navigate("/dms");
  };
  const returnToThread = () => {
    if (renderedPeer) navigate(`/dms/${nip19.npubEncode(renderedPeer)}`);
  };
  const startComposing = () => {
    navigate("/dms");
    setComposing(true);
  };

  // On mobile the list is revealed when there's no thread AND we're not
  // composing — starting a new message slides the compose pane over the list,
  // exactly like opening a conversation does.
  const listRevealed = !activePeer && !composing;

  return (
    <SwipeReveal
      open={listRevealed}
      onReveal={revealList}
      onClose={returnToThread}
      underlay={
        <>
          {/* Leftmost rail + conversation list — the persistent DM-list view,
              revealed underneath as the thread slides away. */}
          <ServerRail />
          <ConversationList
            rows={rows}
            previews={previews}
            activePeer={activePeer}
            dmSupported={dmSupported}
            isLoading={isLoading}
            onCompose={startComposing}
            friendsOnly={friendsOnly}
            setFriendsOnly={setFriendsOnly}
            openPeer={openPeer}
            loadMore={loadMore}
            hasMore={hasMore}
            isLoadingMore={isLoadingMore}
            className="flex-1 sidebar:flex-none sidebar:w-60"
          />
        </>
      }
    >
      {/* Thread / compose pane. On mobile it's the swipeable overlay; on desktop
          a static side-by-side pane (SwipeReveal renders it inline). A new-DM
          recipient picker takes this column in place of the empty state. */}
      <main className="flex flex-col flex-1 min-w-0 safe-area-top bg-background h-full">
        {renderedPeer ? (
          <Conversation
            key={renderedPeer}
            peer={renderedPeer}
            onBack={revealList}
          />
        ) : composing ? (
          <NewDMPane onSelectRecipient={openPeer} onCancel={revealList} />
        ) : (
          <div className="flex flex-1 items-center justify-center text-muted-foreground p-8 text-center">
            <div className="flex flex-col items-center gap-3 max-w-sm">
              <MessageSquare className="size-12 opacity-30" />
              <p className="text-sm">Select a conversation</p>
              <Button variant="outline" className="mt-1" onClick={startComposing}>
                <PenSquare className="size-4" />
                New message
              </Button>
            </div>
          </div>
        )}
      </main>
    </SwipeReveal>
  );
}
