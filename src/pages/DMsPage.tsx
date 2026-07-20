import { AtSign, Bell, BellOff, ChevronLeft, Headphones, Loader2, Lock, MessageSquare, MoreVertical, PenSquare, Phone, Plus, Search, ShieldCheck, Sparkles, UserCheck, UserX, X } from "lucide-react";
import { nip19 } from "nostr-tools";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type UIEvent } from "react";
import { useNavigate, useParams, Navigate } from "react-router-dom";

import { CallStageSlot } from "@/components/chat/CallStageSlot";
import { DittoIcon } from "@/components/brand/DittoIcon";
import { ChatComposer } from "@/components/chat/ChatComposer";
import { ChatMessage, ReplyContextLine, ReplyPreview, ReplyThumbnail } from "@/components/chat/ChatMessage";
import { firstImageRef, getQuoteReplyToId } from "@/components/chat/messageHelpers";
import { MessageRow } from "@/components/chat/MessageRow";
import { MessageTimeline, type MessageTimelineHandle } from "@/components/chat/MessageTimeline";
import { LoginArea } from "@/components/auth/LoginArea";
import { ServerRail } from "@/components/layout/ServerRail";
import { SwipeReveal } from "@/components/layout/SwipeReveal";
import { VoicePresence } from "@/components/VoicePresence";
import { BotPill } from "@/components/BotPill";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { useActiveRoom } from "@/hooks/useActiveRoom";
import {
  useDMConversations,
  useDMSupport,
} from "@/hooks/useDirectMessages";
import { useBotManifests } from "@/hooks/useBotManifests";
import { useDm17Conversations, useDm17Support, useEnsureDmInbox } from "@/hooks/useDm17";
import { useDmMessageSearch } from "@/hooks/useDmMessageSearch";
import { useDmProtocolPref } from "@/hooks/useDmProtocolPref";
import { LegacyFallbackRequired, useDmTransport } from "@/hooks/useDmTransport";
import { useDmVoiceRelay, useLivekitParticipants } from "@/hooks/useLivekit";
import { useSearchProfiles, type SearchProfile } from "@/hooks/useSearchProfiles";
import { dmReadKey, useReadState } from "@/hooks/useReadState";
import { useNotifLevels, dmScopeKey, type NotifLevel } from "@/hooks/useNotifLevels";
import { useToast } from "@/hooks/useToast";
import { effectiveDmRelays } from "@/contexts/AppContext";
import { ComposerBoundsProvider } from "@/contexts/ComposerBoundsContext";
import { getAvatarShape } from "@/lib/avatarShape";
import { deriveDmRoomId } from "@/lib/dmVoice";
import { dittoProfileUrl } from "@/lib/dittoUrl";
import { getDisplayName } from "@/lib/getDisplayName";
import { KIND_DM_CHAT, KIND_DM_FILE } from "@/lib/nip17/protocol";
import { DM_VOICE_RELAYS, PLATFORM_RELAYS } from "@/lib/platform";
import { sanitizeUrl } from "@/lib/sanitizeUrl";
import { cn } from "@/lib/utils";
import { preferredDmVoiceRelay } from "@/lib/voiceDevices";

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

/** Highlight every case-insensitive occurrence of `query` within `text`. */
function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  if (!q) return <>{text}</>;
  // Split on the query (case-insensitive), keeping the delimiters so the
  // matched runs can be wrapped. Escape regex metacharacters in the query.
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "gi"));
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === q.toLowerCase() ? (
          <mark key={i} className="rounded-[2px] bg-primary/30 text-inherit">
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
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
  messageMatch,
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
  messageMatch: string | undefined;
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

  // When searching, hide rows that match neither the contact name / handle nor
  // any locally-decrypted message. A message hit (`messageMatch`, resolved by
  // the parent across BOTH DM planes' decrypted history) keeps the row and
  // replaces the preview line with the matching snippet, highlighted.
  const q = query.trim().toLowerCase();
  const nameMatches = q.length > 0 && `${name} ${metadata?.nip05 ?? ""}`.toLowerCase().includes(q);
  if (q && !nameMatches && messageMatch === undefined) return null;

  // Which text to show on the second line: the matching message when the hit
  // came from history, otherwise the usual last-message preview.
  const secondLine = messageMatch ?? previewText;
  const secondLineHighlight = q && secondLine ? secondLine.toLowerCase().includes(q) : false;

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
        <div className="flex items-center gap-1.5 min-w-0">
          <div className={cn("text-sm truncate", unread ? "font-semibold text-foreground" : "font-medium")}>
            <Highlight text={name} query={query} />
          </div>
          <BotPill metadata={metadata} />
        </div>
        {(preview || secondLine) && (
          <div className={cn("text-xs truncate", unread ? "text-foreground/80" : "text-muted-foreground")}>
            {secondLine ? (
              <Highlight text={secondLine} query={secondLineHighlight ? query : ""} />
            ) : (
              "Encrypted message"
            )}
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
 *
 * When the user has DECLINED bulk decryption, the shimmer is replaced by an
 * explicit "Decrypt" button (and the scroll observer is not registered, so
 * scrolling never pokes the signer) — the message decrypts only on tap.
 */
function DmPlaceholderRow({
  id,
  pubkey,
  createdAt,
  continuation,
  observePlaceholder,
  declined,
  onDecrypt,
}: {
  id: string;
  pubkey: string;
  createdAt: number;
  continuation?: boolean;
  observePlaceholder: (el: HTMLElement, id: string) => () => void;
  declined?: boolean;
  onDecrypt?: (id: string) => void;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (declined) return; // manual-only: don't auto-decrypt on scroll
    const el = rowRef.current;
    if (!el) return;
    return observePlaceholder(el, id);
  }, [id, observePlaceholder, declined]);

  return (
    <div ref={rowRef} data-event-id={id}>
      <MessageRow pubkey={pubkey} createdAt={createdAt} continuation={continuation}>
        {declined ? (
          <button
            type="button"
            onClick={() => onDecrypt?.(id)}
            className="inline-flex items-center gap-1.5 rounded-md border border-border/70 bg-muted/40 px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <Lock className="size-3" />
            Encrypted message. Tap to decrypt.
          </button>
        ) : (
          <Skeleton className="h-3 w-40 max-w-full" />
        )}
      </MessageRow>
    </div>
  );
}

/**
 * A subtle per-message marker for DMs that arrived over legacy NIP-04 (kind
 * 4). Rendered next to the author name so mixed-protocol threads make the
 * encryption downgrade visible at a glance; NIP-17 rumors carry no badge.
 *
 * The whole pill is a click/tap-to-open Popover (not a hover-only tooltip), so
 * the plain-language explanation is reachable on touch, matching the app's
 * other info affordances (e.g. the invite-link "About" popover).
 */
function DmLegacyBadge() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-0.5 rounded-full bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted-foreground/80 hover:text-foreground shrink-0 select-none"
          aria-label="Older, less private encryption. Tap for details."
        >
          <Lock className="size-2.5" aria-hidden />
          NIP-04
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" className="w-64 p-3 text-xs font-normal text-muted-foreground">
        Sent with older DM encryption. It hides the message text, but not the
        fact that you two are talking or when. Newer messages use stronger,
        fully private encryption.
      </PopoverContent>
    </Popover>
  );
}

/**
 * A small "best-effort delivery" pill for a private (NIP-17) DM to a peer who
 * hasn't published a kind-10050 inbox. The message is still fully encrypted;
 * we deliver it to shared app relays, so it reaches the peer once they read
 * them. Click/tap-to-open Popover, mirroring {@link DmLegacyBadge}.
 */
function DmBestEffortBadge({ name, className }: { name: string; className?: string }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex items-center justify-center rounded-full bg-chrome p-0.5 text-muted-foreground/90 shadow-sm ring-1 ring-border/60 hover:text-foreground select-none",
            className,
          )}
          aria-label="Private, best-effort delivery. Tap for details."
        >
          <Lock className="size-2.5" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent side="bottom" className="w-64 p-3 text-xs font-normal text-muted-foreground">
        {name} hasn't set up private messaging yet. Your messages are still
        fully private (encrypted). They're delivered to shared relays and reach
        them once they open Armada.
      </PopoverContent>
    </Popover>
  );
}

/**
 * Shown in place of the composer when the peer can't receive private (NIP-17)
 * DMs. Sending would fall back to legacy NIP-04 (kind 4), which leaks metadata
 * (who's talking, and when), so we make the downgrade an explicit, informed
 * choice rather than a silent default.
 */
function DmLegacyFallbackNotice({ name, onEnable }: { name: string; onEnable: () => void }) {
  return (
    <div className="mx-2 mb-3 rounded-lg border border-border/60 bg-muted/40 px-4 py-3 text-sm">
      <div className="flex items-start gap-2.5">
        <Lock className="size-4 mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 space-y-2">
          <p className="text-muted-foreground">
            <span className="font-medium text-foreground">{name}</span> hasn't set
            up private messaging yet, so we can't send them a fully-private DM.
            You can still message them with older encryption. It hides what you
            say, but not that you're talking or when.
          </p>
          <Button size="sm" className="clip-corner-lg" onClick={onEnable}>
            Message with legacy encryption
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * DM inline-reply context: resolve the quoted message from the loaded thread
 * (NIP-17 rumors aren't relay-fetchable) and render the shared "replying
 * to …" chrome. Clicking jumps the timeline to the parent.
 */
function DmReplyContext({ parent, onJump }: { parent: NostrEvent | undefined; onJump: (id: string) => void }) {
  const author = useAuthor(parent?.pubkey);
  const name = parent ? getDisplayName(author.data?.metadata, parent.pubkey) : "";
  if (!parent) return null;
  const image = firstImageRef(parent);
  return (
    <ReplyContextLine
      name={name}
      preview={<ReplyPreview content={parent.content} hideMediaPlaceholder={!!image} />}
      thumbnail={image ? <ReplyThumbnail image={image} /> : undefined}
      onClick={() => onJump(parent.id)}
    />
  );
}

/**
 * The message a DM replies to, if any. Our own sends carry a NIP-C7 `q`
 * (rich quote, shared with Concord's renderer); foreign NIP-17 clients use a
 * plain `e` parent tag per the spec — accept either. Kind-4 rows carry no
 * tags, so they never resolve.
 */
function dmReplyToId(msg: NostrEvent): string | undefined {
  if (msg.kind !== KIND_DM_CHAT && msg.kind !== KIND_DM_FILE) return undefined;
  return getQuoteReplyToId(msg) ?? msg.tags.find(([name, value]) => name === "e" && value)?.[1];
}

function Conversation({ peer, onBack }: { peer: string; onBack: () => void }) {
  const author = useAuthor(peer);
  const name = getDisplayName(author.data?.metadata, peer);
  const dittoProfileHref = dittoProfileUrl(peer);
  const composerBoundsRef = useRef<HTMLElement | null>(null);
  const { transport, encryptedIds, dm17Ids, dm17Enabled, dm17DeliveryGuaranteed, legacyPinned, decryptVisible, decryptOne, decryptAll, decryptDeclined, hasEncrypted, send } =
    useDmTransport(peer);
  const { messages } = transport;

  // When the counterparty is a bot, its declared command set lets the timeline
  // render an untagged `/cmd args` invocation as an action line — a DM sends
  // invocations untagged (the recipient IS the bot), so there's no tag to key
  // off. Non-bot peers yield an empty set and nothing is ever promoted.
  const botRoster = useMemo(() => [peer], [peer]);
  const { entries: botCommandEntries } = useBotManifests(botRoster);
  const knownCommands = useMemo(
    () => new Set(botCommandEntries.map((e) => e.command.name)),
    [botCommandEntries],
  );
  const { markRead } = useReadState();
  const { dmLevel, setLevel: setNotifLevel } = useNotifLevels();
  const { toast } = useToast();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const { activeCall, joinDmCall, voiceRoomPubkeys } = useCall();
  const muteUser = useMuteUser();
  const { pref: dmProtocol, setPref: setDmProtocol } = useDmProtocolPref(peer);

  // Inline quote-reply state (NIP-17 sends only — a kind-4 send has no
  // in-band convention, so the control is hidden on legacy threads).
  const [replyTo, setReplyTo] = useState<NostrEvent | undefined>(undefined);
  useEffect(() => setReplyTo(undefined), [peer]);

  // Mobile tap-to-reveal for the per-message action toolbar (react/quote/etc.).
  // On touch devices the toolbar is inert until the row is tapped active; a
  // second tap on a control fires it. Mirrors Concord chats' behavior so DMs
  // can be reacted to / quoted on mobile.
  const [activeId, setActiveId] = useState<string | undefined>(undefined);
  const toggleActive = useCallback(
    (id: string) => setActiveId((cur) => (cur === id ? undefined : id)),
    [],
  );
  useEffect(() => setActiveId(undefined), [peer]);

  // Legacy-encryption opt-in. When the peer can't receive private (NIP-17)
  // DMs, we DON'T silently downgrade to kind-4 (which leaks who's talking and
  // when). The composer is replaced by a notice until the user explicitly
  // chooses to send with legacy encryption; the choice is per-conversation and
  // resets when switching peers.
  const [legacyAllowed, setLegacyAllowed] = useState(false);
  useEffect(() => setLegacyAllowed(false), [peer]);
  // Block sending only once we KNOW the peer has no NIP-17 inbox. While the
  // thread (and the peer's kind-10050 lookup) is still loading, assume the
  // private path so we don't flash a legacy notice for a reachable peer.
  // A conversation pinned to legacy NIP-04 sends kind-4 directly, so it's
  // never "blocked" — the composer is shown as-is.
  const legacyBlocked = !legacyPinned && !dm17Enabled && !transport.isLoading && !legacyAllowed;

  // Jump-to-quoted-message support (the reply context line is clickable).
  const timelineRef = useRef<MessageTimelineHandle | null>(null);
  const jumpToMessage = useCallback((id: string) => {
    timelineRef.current?.scrollToMessage(id);
  }, []);

  // The loaded thread by id, for resolving quoted parents locally (NIP-17
  // rumors aren't relay-fetchable).
  const messagesById = useMemo(() => {
    const map = new Map<string, NostrEvent>();
    for (const m of messages) map.set(m.id, m);
    return map;
  }, [messages]);

  // Inline message search: toggled from the header, filters the loaded thread
  // client-side (no extra relay queries). The mute confirm dialog is opened
  // from the header's mute button.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [muteConfirmOpen, setMuteConfirmOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Reset the inline search whenever we switch conversations.
  useEffect(() => {
    setSearchOpen(false);
    setSearchQuery("");
  }, [peer]);

  // Focus the search field when it expands. `preventScroll` is essential: the
  // input starts off-screen (translate-x-full) and slides in, so a default
  // focus() would make the browser scroll the page to reveal it — a visible jolt.
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus({ preventScroll: true });
  }, [searchOpen]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery("");
  }, []);

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
      // The user's Settings -> Voice server (when set) wins, then the pinned/DM
      // relays, then the platform's default LiveKit-capable relay so 1:1 voice
      // works even when none of the user's own relays host the NIP-29 LiveKit
      // extension. Deduped.
      const preferred = preferredDmVoiceRelay();
      const ordered = [...(preferred ? [preferred] : []), ...PLATFORM_RELAYS, ...dmRelays, ...DM_VOICE_RELAYS];
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
  // While WE are in this call, the connected room's live LiveKit roster is
  // authoritative — kind-39004 presence rides webhooks + relay memory and
  // desyncs too easily. It remains the only source for calls we're not in.
  const roster = (inThisCall ? voiceRoomPubkeys : null) ?? participants;
  const inCallCount = roster?.length ?? 0;
  // Others (exclude us) currently in this DM's voice room — for the presence
  // avatar stack in the header.
  const dmOthersInVoice = useMemo(
    () => (roster ?? []).filter((pk) => pk !== user?.pubkey),
    [roster, user?.pubkey],
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
    async (text: string, tags: string[][]) => {
      try {
        // Resolves as soon as the message is signed + optimistically rendered;
        // relay delivery happens in the background and is reflected by the
        // message's status (sending / failed + retry), so the composer clears
        // immediately and the send button never blocks on the relay.
        // Routed by the transport: NIP-17 gift wraps when the peer publishes a
        // kind-10050 inbox (composer content tags ride inside the sealed
        // rumor), legacy kind-4 otherwise.
        //
        // A quote-reply carries the composer's NIP-C7 `q` tag (rich context in
        // Armada) PLUS a plain `e` parent tag — NIP-17's own reply convention —
        // so foreign clients render the reply relationship too.
        const finalTags = replyTo ? [...tags, ["e", replyTo.id]] : tags;
        await send(text, finalTags, { allowLegacy: legacyAllowed });
        setReplyTo(undefined);
      } catch (e) {
        // The peer can't receive private DMs and legacy hasn't been enabled —
        // reveal the opt-in notice instead of a scary error (the composer is
        // hidden while this is true, so this is belt-and-suspenders for a race
        // where reachability flips between render and submit).
        if (e instanceof LegacyFallbackRequired) {
          setLegacyAllowed(false);
          throw e;
        }
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
    [send, toast, replyTo, legacyAllowed],
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
    <ComposerBoundsProvider value={composerBoundsRef}>
    <div className="flex flex-col flex-1 min-h-0">
      <header className="relative h-12 touch:h-14 mx-2 mt-3 px-2 sidebar:px-3 flex items-center gap-2 shrink-0 clip-corner-lg bg-chrome">
        {/* Mobile back → returns to the rail + conversation list (the shared
            DM-list view), the same panes that are persistently rendered. */}
        <Button
          variant="ghost"
          size="icon"
          aria-label="Back to conversations"
          className="size-9 touch:size-11 shrink-0 sidebar:hidden"
          onClick={onBack}
        >
          <ChevronLeft className="size-5" />
        </Button>
        <div className="relative shrink-0">
          <Avatar shape={getAvatarShape(author.data?.metadata)} className="size-7">
            <AvatarImage src={author.data?.metadata?.picture} alt={name} />
            <AvatarFallback className="bg-primary/20 text-primary text-[10px]">
              {name[0]?.toUpperCase()}
            </AvatarFallback>
          </Avatar>
          {dm17Enabled && !dm17DeliveryGuaranteed && (
            <DmBestEffortBadge name={name} className="absolute -bottom-1 -right-1" />
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          <h1 className="font-semibold truncate min-w-0">{name}</h1>
          <BotPill metadata={author.data?.metadata} />
        </div>
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
                className="relative size-8 touch:size-11 shrink-0 text-muted-foreground hover:text-success"
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
        {/* Secondary actions overflow into a … menu to keep the bar uncluttered:
            search, notification level, View on Ditto, and Mute. Only Call stays
            inline as the primary conversation action. */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="More options"
              className="size-8 touch:size-11 shrink-0 text-muted-foreground hover:text-foreground"
            >
              <MoreVertical className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52 p-1.5">
            <DropdownMenuItem className="px-3 py-2" onClick={() => setSearchOpen(true)}>
              <Search className="size-4" />
              Search messages
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="px-3 py-2">
                {(() => {
                  const lvl = dmLevel(peer);
                  const Icon = lvl === "nothing" ? BellOff : lvl === "mentions" ? AtSign : Bell;
                  return <Icon className="mr-2 size-4" />;
                })()}
                Notifications
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-48">
                <DropdownMenuRadioGroup
                  value={dmLevel(peer)}
                  onValueChange={(v) => setNotifLevel(dmScopeKey(peer), v as NotifLevel)}
                >
                  <DropdownMenuRadioItem value="all">
                    <Bell className="mr-2 size-4" /> All messages
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="mentions">
                    <AtSign className="mr-2 size-4" /> Only @mentions
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="nothing">
                    <BellOff className="mr-2 size-4" /> Nothing
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="px-3 py-2">
                {dmProtocol === "nip04" ? (
                  <Lock className="mr-2 size-4" />
                ) : (
                  <ShieldCheck className="mr-2 size-4" />
                )}
                Encryption
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-64">
                <DropdownMenuRadioGroup
                  value={dmProtocol}
                  onValueChange={(v) => setDmProtocol(v as "auto" | "nip17" | "nip04")}
                >
                  <DropdownMenuRadioItem value="auto" className="items-start">
                    <Sparkles className="mr-2 mt-0.5 size-4 shrink-0" />
                    <div className="min-w-0">
                      <div>Automatic</div>
                      <p className="text-xs text-muted-foreground">
                        Private when possible, legacy only if you allow it.
                      </p>
                    </div>
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="nip17" className="items-start">
                    <ShieldCheck className="mr-2 mt-0.5 size-4 shrink-0" />
                    <div className="min-w-0">
                      <div>Private (NIP-17)</div>
                      <p className="text-xs text-muted-foreground">
                        Always fully private; hides that you're talking.
                      </p>
                    </div>
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="nip04" className="items-start">
                    <Lock className="mr-2 mt-0.5 size-4 shrink-0" />
                    <div className="min-w-0">
                      <div>Legacy (NIP-04)</div>
                      <p className="text-xs text-muted-foreground">
                        Older encryption; leaks who's talking and when.
                      </p>
                    </div>
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            {dittoProfileHref && (
              <DropdownMenuItem className="px-3 py-2" asChild>
                <a href={dittoProfileHref} target="_blank" rel="noopener noreferrer">
                  <DittoIcon className="size-4" />
                  View on Ditto
                </a>
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="px-3 py-2 text-destructive focus:text-destructive"
              onClick={() => setMuteConfirmOpen(true)}
            >
              <UserX className="size-4" />
              Mute person
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Inline search bar: smoothly expands across the header (covering the
            title and actions) when open. On mobile it leaves the back button
            visible; on desktop it covers the full bar. An X dismisses it.
            Slides via GPU-composited transform (not `left`) so it animates on
            the compositor and never forces a per-frame reflow / jitter. */}
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
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") closeSearch();
            }}
            placeholder="Search messages…"
            aria-label="Search messages"
            className="h-8 touch:h-10 flex-1 border-0 bg-transparent px-1 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
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
      </header>

      {/* Top-of-chat call stage portal target (active when this DM is in call). */}
      <CallStageSlot active={inThisCall} />

      {/* Manual-decrypt banner: shown when the user declined the one-time
          decrypt prompt and this thread still has locked messages. "Decrypt
          all" opens them AND grants consent so future threads decrypt on load. */}
      {decryptDeclined && hasEncrypted && (
        <div className="flex items-center justify-between gap-3 border-b border-border/60 bg-muted/30 px-4 py-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground min-w-0">
            <Lock className="size-3.5 shrink-0" />
            <span className="truncate">Messages are locked. Decrypt with your signer to read them.</span>
          </div>
          <Button size="sm" variant="secondary" className="shrink-0" onClick={decryptAll}>
            Decrypt all
          </Button>
        </div>
      )}

      {normalizedSearch ? (
        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-clip overscroll-contain scrollbar-stable px-3 py-4">
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
                  mentionHighlight={false}
                  nameBadge={!dm17Ids.has(msg.id) ? <DmLegacyBadge /> : undefined}
                  continuation={false}
                />
              ))}
            </>
          )}
        </div>
      ) : (
        <MessageTimeline
          transport={transport}
          handleRef={timelineRef}
          className="flex-1 min-h-0"
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
                declined={decryptDeclined}
                onDecrypt={decryptOne}
              />
            ) : (
              <ChatMessage
                key={msg.id}
                event={msg}
                canWrite={transport.canWrite}
                canModerate={transport.canModerate}
                sendStatus={transport.sendStatusFor?.(msg.id)}
                onRetry={transport.retry ? () => transport.retry!(msg) : undefined}
                onDiscard={
                  dm17Ids.has(msg.id) && transport.discard
                    ? () => transport.discard!(msg.id)
                    : undefined
                }
                // In a DM every message p-tags you — that's addressing, not a
                // mention. Don't paint the whole thread as highlights.
                mentionHighlight={false}
                // Mark messages that arrived over legacy NIP-04 encryption.
                nameBadge={!dm17Ids.has(msg.id) ? <DmLegacyBadge /> : undefined}
                // Quote-replies (NIP-17 sends only): the toolbar/context-menu
                // "Quote" primes the composer; the quoted parent renders above
                // the body and clicking it jumps the timeline.
                onReply={dm17Enabled ? setReplyTo : undefined}
                replyContext={(() => {
                  const replyId = dmReplyToId(msg);
                  return replyId ? (
                    <DmReplyContext parent={messagesById.get(replyId)} onJump={jumpToMessage} />
                  ) : undefined;
                })()}
                // Reactions ride the NIP-17 plane (kind-7 rumors sealed into
                // the conversation); available whenever the transport is.
                reactions={transport.reactionsFor?.(msg.id)}
                // Deleting is a wrapped kind-5 into the conversation — own
                // NIP-17 messages only (kind-4 has no in-band delete).
                onDelete={
                  dm17Ids.has(msg.id) && msg.pubkey === user?.pubkey && transport.deleteMessage
                    ? transport.deleteMessage
                    : undefined
                }
                // NIP-17 rumors are unsigned — the context menu offers "View
                // event JSON" instead of relay-addressable off-ramps.
                rumor={dm17Ids.has(msg.id) ? msg : undefined}
                // Render this peer-bot's untagged invocations as action lines.
                knownCommands={knownCommands}
                continuation={continuation}
                active={activeId === msg.id}
                onToggleActive={toggleActive}
              />
            )
          }
        />
      )}

      {legacyBlocked ? (
        <DmLegacyFallbackNotice name={name} onEnable={() => setLegacyAllowed(true)} />
      ) : (
        <ChatComposer
          relayUrl="dm"
          groupId={peer}
          messages={[]}
          // If this peer is a bot, offer its `/` commands. A DM's recipient IS
          // the bot, so the invocation sends untagged (no routing leak, and it
          // rides inside NIP-17's sealed rumor like any other DM content).
          botDmPeer={peer}
          placeholder={`Message ${name}…`}
          // Quote-replies use the NIP-C7 `q` marker (rich context, shared with
          // Concord's renderer); handleSubmit adds the NIP-17 `e` parent tag.
          replyTo={replyTo}
          replyMarker="nipc7"
          onCancelReply={() => setReplyTo(undefined)}
          // Encrypt file attachments client-side (AES-256-GCM) before Blossom
          // upload, à la Concord/Vector — but only on the private NIP-17 plane.
          // Legacy kind-4 has no imeta channel to carry the decryption key, so
          // an encrypted upload there would be an undecryptable blob.
          encryptAttachments={dm17Enabled}
          sendOverride={handleSubmit}
        />
      )}

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
    </ComposerBoundsProvider>
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
          className="size-9 touch:size-11 shrink-0 sidebar:hidden"
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

      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-safe space-y-0.5">
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
  events,
  activePeer,
  dmSupported,
  isLoading,
  onCompose,
  openPeer,
  loadMore,
  hasMore,
  isLoadingMore,
  className,
}: {
  rows: { peer: string; latest: NostrEvent; plaintext?: string }[];
  previews: Record<string, string>;
  events: NostrEvent[];
  activePeer: string | undefined;
  dmSupported: boolean;
  isLoading: boolean;
  onCompose: () => void;
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
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Search across locally-decrypted message history (both DM planes), grouped
  // per peer. Purely local — never prompts the signer.
  const messageMatches = useDmMessageSearch(search, events, user?.pubkey);

  // Focus the search field when it expands. `preventScroll` avoids the browser
  // scrolling to reveal the input as it slides in from off-screen.
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus({ preventScroll: true });
  }, [searchOpen]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearch("");
  }, []);

  // The shared DM voice relay (same derivation as the open conversation): a
  // LiveKit-capable relay from the platform list, then the user's DM relays.
  // Computed once here so each row can query its peer's voice presence without
  // re-resolving the relay per row.
  const dmRelays = useMemo(() => effectiveDmRelays(config), [config]);
  const voiceCandidates = useMemo(
    () => {
      // The user's Settings -> Voice server (when set) wins, then the pinned/DM
      // relays, then the platform's default LiveKit-capable relay so 1:1 voice
      // works even when none of the user's own relays host the NIP-29 LiveKit
      // extension. Deduped.
      const preferred = preferredDmVoiceRelay();
      const ordered = [...(preferred ? [preferred] : []), ...PLATFORM_RELAYS, ...dmRelays, ...DM_VOICE_RELAYS];
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
        // No `safe-area-top` here: the status-bar inset lives in the header's
        // top padding (mirroring a community's ChannelSidebarView), so the
        // title/divider line up with a community sidebar. Adding it here too
        // would double the inset on mobile.
        "relative flex flex-col min-w-0 shrink-0 bg-chrome",
        className,
      )}
    >
      {/* "Messages" section label + search / new-message actions, formatted
          like the "Channels" sub-header on a community sidebar
          (ChannelSidebarView): the uppercase label with actions on the right.
          Search expands inline over this row behind the search icon. */}
      <div className="px-1 pt-[calc(0.75rem+var(--safe-area-inset-top,env(safe-area-inset-top,0px)))] shrink-0">
        <div className="relative overflow-hidden">
          <div className="flex items-center justify-between pl-4 pr-2 py-1 min-h-6">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Messages
            </span>
            <div className="flex items-center gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 touch:size-11 shrink-0 text-muted-foreground hover:text-foreground"
                    aria-label="Search conversations"
                    aria-pressed={searchOpen}
                    onClick={() => setSearchOpen(true)}
                  >
                    <Search className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Search conversations</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 touch:size-11 shrink-0 text-muted-foreground hover:text-foreground"
                    aria-label="New message"
                    onClick={onCompose}
                  >
                    <Plus className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>New message</TooltipContent>
              </Tooltip>
            </div>
          </div>

          {/* Expanding conversation search — slides across the "Messages" row,
              aligned to the same left inset as the label and vertically centred
              on the row (not the header's top padding). */}
          <div
            className={cn(
              "absolute inset-y-0 inset-x-0 z-10 flex items-center gap-1.5 pl-4 pr-2",
              "bg-chrome",
              "transition-transform duration-300 ease-in-out",
              searchOpen
                ? "translate-x-0 pointer-events-auto"
                : "translate-x-full pointer-events-none",
            )}
          >
            <Search className="size-4 text-muted-foreground shrink-0" />
            <Input
              ref={searchInputRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") closeSearch();
              }}
            placeholder="Search messages…"
            aria-label="Search conversations"
              className="h-8 flex-1 border-0 bg-transparent px-1 text-sm shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
            />
            <Button
              variant="ghost"
              size="icon"
              aria-label="Close search"
              className="size-8 shrink-0 text-muted-foreground hover:text-foreground"
              onClick={closeSearch}
            >
              <X className="size-4" />
            </Button>
          </div>
        </div>
      </div>

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
            No conversations with people you follow yet. Start one with the + button.
          </p>
        ) : (
          <>
            {rows.map((c) => (
              <ConversationRow
                key={c.peer}
                peer={c.peer}
                preview={c.latest}
                previewText={c.plaintext ?? previews[c.peer]}
                query={search}
                messageMatch={messageMatches.get(c.peer)?.text}
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
        <div className="pb-2">
          <LoginArea className="w-full flex" />
        </div>
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
  // Either plane makes DMs usable: kind-4 needs nip04, NIP-17 needs nip44.
  const dmSupported = useDMSupport();
  const dm17Supported = useDm17Support();
  const { conversations, previews, events, isLoading, loadMore, hasMore, isLoadingMore } =
    useDMConversations({ decryptPreviews: true });
  // NIP-17 conversations (decrypted rumors from the local store). Interactive:
  // opening the DMs page is where the one-time decrypt-consent prompt may
  // legitimately appear (same moment the kind-4 previews could open it).
  const { conversations: dm17Conversations } = useDm17Conversations({ interactive: true });
  // Make the viewer reachable over NIP-17: publish their kind-10050 inbox
  // list (once, if absent) so other clients know where — and that — they can
  // deliver gift-wrapped DMs.
  useEnsureDmInbox();
  const { data: followData } = useFollowList();
  const [composing, setComposing] = useState(false);
  // The conversation list is always narrowed to people the user follows (kind
  // 3) — DMs from strangers are never shown. Muted people are also excluded
  // upstream in useDMConversations.
  const followedPubkeys = useMemo(
    () => new Set(followData?.pubkeys ?? []),
    [followData?.pubkeys],
  );

  const activePeer = rawPeer ? resolvePubkey(rawPeer) : undefined;

  // Tell the native notification service this DM thread is on screen, so it
  // suppresses redundant tray entries (the live timeline already paints each
  // message). Cleared on unmount/background. The roomKey shape must match the
  // service's `enqueueRoomMessage` key: `dm:<peerPubkey>`.
  useActiveRoom(activePeer ? `dm:${activePeer}` : undefined);

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

  // Conversations plus the active peer if it's a brand-new thread. Kind-4 and
  // NIP-17 conversations merge per peer (newest message wins; a NIP-17 rumor
  // is already plaintext, so it carries its own preview text). The list is
  // always narrowed to followed peers — but always keep the peer whose thread
  // is currently open so the row you're reading never vanishes.
  const rows = useMemo(() => {
    const byPeer = new Map<string, { peer: string; latest: NostrEvent; plaintext?: string }>();
    for (const c of conversations) byPeer.set(c.peer, { peer: c.peer, latest: c.latest });
    for (const c of dm17Conversations) {
      const existing = byPeer.get(c.peer);
      if (existing && existing.latest.created_at >= c.latest.createdAt) continue;
      byPeer.set(c.peer, {
        peer: c.peer,
        latest: {
          id: c.latest.rumorId,
          pubkey: c.latest.author,
          created_at: c.latest.createdAt,
          kind: c.latest.kind,
          content: c.latest.content,
          tags: c.latest.tags,
          sig: "",
        },
        plaintext: c.latest.content,
      });
    }
    let list = [...byPeer.values()].sort((a, b) => b.latest.created_at - a.latest.created_at);
    list = list.filter((c) => followedPubkeys.has(c.peer) || c.peer === activePeer);
    if (activePeer && !list.some((c) => c.peer === activePeer)) {
      list.unshift({ peer: activePeer, latest: undefined as unknown as NostrEvent });
    }
    return list;
  }, [conversations, dm17Conversations, activePeer, followedPubkeys]);

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
            events={events}
            activePeer={activePeer}
            dmSupported={dmSupported || dm17Supported}
            isLoading={isLoading}
            onCompose={startComposing}
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
              <Button className="mt-1 clip-corner-lg" onClick={startComposing}>
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
