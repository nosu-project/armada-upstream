import { AtSign, Bell, BellOff, CheckCheck, ChevronLeft, ChevronRight, Flag, Headphones, Inbox, Loader2, Lock, MessageSquare, MoreVertical, PanelLeft, PanelLeftDashed, PenSquare, Phone, Pin, PinOff, Plus, Search, ShieldCheck, Sparkles, Timer, UserCheck, Users, UserX, X } from "lucide-react";
import { nip19 } from "nostr-tools";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type UIEvent } from "react";
import { useLocation, useNavigate, useParams, Navigate } from "react-router-dom";

import { CallStageSlot } from "@/components/chat/CallStageSlot";
import { DittoIcon } from "@/components/brand/DittoIcon";
import { ChatComposer } from "@/components/chat/ChatComposer";
import { ChatMessage } from "@/components/chat/ChatMessage";
import type { ChatMsg } from "@/components/chat/transport";
import { getQuoteReplyToId } from "@/components/chat/messageHelpers";
import { ReplyContext } from "@/components/chat/ReplyContext";
import { MessageRow } from "@/components/chat/MessageRow";
import { MessageTimeline } from "@/components/chat/MessageTimeline";
import { useTimelineFocus } from "@/hooks/useTimelineFocus";
import { TypingIndicator } from "@/components/chat/TypingIndicator";
import { LoginArea } from "@/components/auth/LoginArea";
import { ServerRail } from "@/components/layout/ServerRail";
import { SwipeReveal } from "@/components/layout/SwipeReveal";
import { VoicePresence } from "@/components/VoicePresence";
import { BotPill } from "@/components/BotPill";
import { DeferredRow } from "@/components/DeferredRow";
import { DisplayName } from "@/components/DisplayName";
import { DmAvatar } from "@/components/DmAvatar";
import { NoteToSelfAvatar, NoteToSelfIcon, NOTE_TO_SELF_NAME } from "@/components/NoteToSelfAvatar";
import { ReportDialog } from "@/components/ReportDialog";
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
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
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
import { useMuteToggle, useMuteUser } from "@/hooks/useMuteList";
import { useActiveRoom } from "@/hooks/useActiveRoom";
import {
  useDMConversations,
  useDMSupport,
  useHasUnreadDMs,
} from "@/hooks/useDirectMessages";
import { useBotManifests } from "@/hooks/useBotManifests";
import { useAdoptDmInbox, useDm17Backfill, useDm17Conversations, useDm17Support } from "@/hooks/useDm17";
import { useDmConversationName } from "@/hooks/useDmConversationName";
import { useDmMessageSearch } from "@/hooks/useDmMessageSearch";
import { useDmProtocolPref } from "@/hooks/useDmProtocolPref";
import { LegacyFallbackRequired, useDmTransport } from "@/hooks/useDmTransport";
import { useDmTyping } from "@/hooks/useDmTyping";
import { useIsTouch } from "@/hooks/useIsMobile";
import { useDmVoiceRelay, useLivekitParticipants } from "@/hooks/useLivekit";
import { useSearchProfiles, type SearchProfile } from "@/hooks/useSearchProfiles";
import { dmReadKey, useReadState } from "@/hooks/useReadState";
import { useNotifLevels, dmScopeKey, type NotifLevel } from "@/hooks/useNotifLevels";
import { usePinnedDms } from "@/hooks/usePinnedDms";
import { useRailDms } from "@/hooks/useRailDms";
import { useAcceptedDms } from "@/hooks/useAcceptedDms";
import { useClosedDms } from "@/hooks/useClosedDms";
import { useKnownDmPeers } from "@/hooks/useKnownDmPeers";
import { useStartedDms } from "@/hooks/useStartedDms";
import { useSharedCommunities } from "@/hooks/useSharedCommunities";
import { useToast } from "@/hooks/useToast";
import { effectiveDmRelays } from "@/contexts/AppContext";
import { ComposerBoundsProvider } from "@/contexts/ComposerBoundsContext";
import { dmRouteParam, parseDmRouteParam } from "@/lib/dmConversation";
import { getAvatarShape } from "@/lib/avatarShape";
import { deriveDmRoomId } from "@/lib/dmVoice";
import { forwardableTags } from "@/lib/forwardMessage";
import { chatRoute, parseChatRoute } from "@/lib/routes";
import { stashShare } from "@/lib/shareTarget";
import { dittoProfileUrl } from "@/lib/dittoUrl";
import { getDisplayName } from "@/lib/getDisplayName";
import { DISAPPEARING_PRESETS, disappearingNotice, formatDisappearingDuration } from "@/lib/nip17/disappearing";
import { dmConvKey, dmConvPeers, expirationOf, KIND_DM_CHAT, KIND_DM_FILE } from "@/lib/nip17/protocol";
import { pickEmojiTags, readDmListSnapshot, writeDmListSnapshot } from "@/lib/dmListSnapshot";
import { resolvePubkey } from "@/lib/resolvePubkey";
import { buildEmojiMap } from "@/lib/customEmoji";
import { emojify } from "@/components/chat/emojify";
import { DM_VOICE_RELAYS } from "@/lib/platform";
import { sanitizeUrl } from "@/lib/sanitizeUrl";
import { cn } from "@/lib/utils";
import { effectiveDmVoiceRelays } from "@/lib/voiceDevices";

import type { NostrRumor } from "@/lib/nostrRumor";

/**
 * Highlight every case-insensitive occurrence of `query` within `text`, with
 * NIP-30 custom emoji rendered as inline images.
 *
 * `emojiTags` are the source message's own `emoji` tags, so resolution is
 * self-contained — no emoji-pack lookup, no network. A shortcode with no
 * matching tag is left as literal text (see `emojify`), which is what kind-4
 * previews get: that plane carries no emoji tags.
 */
function Highlight({
  text,
  query,
  emojiTags,
}: {
  text: string;
  query: string;
  emojiTags?: string[][];
}) {
  const emojiMap = buildEmojiMap(emojiTags ?? []);
  const render = (s: string) => (emojiMap.size > 0 ? emojify(s, emojiMap) : s);
  const q = query.trim();
  if (!q) return <>{render(text)}</>;
  // Split on the query (case-insensitive), keeping the delimiters so the
  // matched runs can be wrapped. Escape regex metacharacters in the query.
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "gi"));
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === q.toLowerCase() ? (
          <mark key={i} className="rounded-[2px] bg-primary/30 text-inherit">
            {render(part)}
          </mark>
        ) : (
          <Fragment key={i}>{render(part)}</Fragment>
        ),
      )}
    </>
  );
}

function ConversationRow({
  peers,
  preview,
  previewText,
  unread,
  inCall,
  selfPubkey,
  voiceRelay,
  query,
  messageMatch,
  active,
  pinned,
  onRail,
  request,
  sharedCommunity,
  onClick,
  onTogglePin,
  onToggleRail,
  onClose,
  onBlock,
}: {
  /** The conversation's participants: one for a 1:1, several for a group. */
  peers: string[];
  preview: NostrRumor | undefined;
  previewText: string | undefined;
  unread: boolean;
  inCall: boolean;
  selfPubkey: string | undefined;
  voiceRelay: string | undefined;
  query: string;
  messageMatch: string | undefined;
  active: boolean;
  pinned: boolean;
  /** This conversation has an icon on the community rail. */
  onRail: boolean;
  /**
   * This row is in the request tier. It renders without the peer's profile
   * picture (loading it would hand an unknown sender our IP on sight) and
   * swaps the pin menu for accept/block.
   */
  request?: boolean;
  /** A community both parties are in, when one is known — see useSharedCommunities. */
  sharedCommunity?: string;
  onClick: () => void;
  onTogglePin: () => void;
  onToggleRail: () => void;
  onClose?: () => void;
  onBlock?: () => void;
}) {
  const group = peers.length > 1;
  // A group's title is composed from every participant, so it needs their
  // profiles rather than one. `useDmConversationName` resolves them all.
  const { name, metadata, emojiTags } = useDmConversationName(peers, selfPubkey);
  // The conversation with yourself is Note to Self: Signal's name and mark in
  // place of your own profile, because a row showing your own face and handle
  // reads as a message FROM you rather than as the place your notes live.
  const noteToSelf = !group && peers[0] === selfPubkey;

  // Live voice presence for this DM (kind 39004), so we can show when the peer
  // is waiting in a call even if we haven't joined — mirroring the channel
  // list. Gated on a resolved LiveKit-capable relay (same relay-level
  // capability the call button uses).
  //
  // 1:1 only: the room id is derived from the two pubkeys pairwise
  // (`deriveDmRoomId`), and there is no defined derivation for a set — see the
  // conversation header, which hides the call button for the same reason.
  const roomId = selfPubkey && !group ? deriveDmRoomId(selfPubkey, peers[0]) : undefined;
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
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          className={cn(
            // Scaled up relative to a channel row: this is a contact list, so
            // the avatar carries recognition and the preview line has to be
            // readable at a glance rather than merely present.
            "flex items-center gap-3 w-full px-2.5 py-2.5 rounded-lg text-left transition-colors",
            active ? "bg-secondary" : "hover:bg-secondary/60",
          )}
        >
          {/* A request's avatar is never fetched: the URL comes from the
              sender's own profile, so rendering it would confirm to an unknown
              party that their message reached a live reader. */}
          <DmAvatar
            peers={peers}
            selfPubkey={selfPubkey}
            sizePx={48}
            className="size-12"
            anonymous={request}
          />
          <div className="min-w-0 flex-1 space-y-0.5">
            <div className="flex items-center gap-1.5 min-w-0">
              <div className={cn("text-[15px] truncate", unread ? "font-semibold text-foreground" : "font-medium")}>
                {q ? (
                  <Highlight text={name} query={query} emojiTags={emojiTags} />
                ) : noteToSelf || group ? (
                  // A group's title is several names, so it is plain text: the
                  // verified-handle chrome DisplayName adds belongs to one
                  // person and would be ambiguous across a list of them.
                  name
                ) : (
                  <DisplayName pubkey={peers[0]} name={name} />
                )}
              </div>
              {!noteToSelf && !group && <BotPill metadata={metadata} />}
            </div>
            {(preview || secondLine) && (
              <div className={cn("text-sm truncate", unread ? "text-foreground/80" : "text-muted-foreground")}>
                {secondLine ? (
                  <Highlight
                    text={secondLine}
                    query={secondLineHighlight ? query : ""}
                    emojiTags={preview?.tags}
                  />
                ) : (
                  "Encrypted message"
                )}
              </div>
            )}
            {/* Positive assertion only. No label means we have no membership
                data for this peer (many NIP-29 relays publish no member
                list) — never that they share nothing with you. */}
            {request && sharedCommunity && (
              <div className="flex items-center gap-1 text-[11px] text-muted-foreground/80">
                <Users className="size-3 shrink-0" aria-hidden />
                <span className="truncate">Also in {sharedCommunity}</span>
              </div>
            )}
          </div>
          {inCall ? (
            <span
              className="shrink-0 flex size-6 items-center justify-center rounded-full bg-success text-success-foreground"
              aria-label="Voice call in progress"
            >
              <Headphones className="size-3.5" />
            </span>
          ) : othersInVoice ? (
            <VoicePresence participants={others} className="text-success/90" />
          ) : unread ? (
            <span className="shrink-0 size-2.5 rounded-full bg-primary" aria-label="Unread messages" />
          ) : null}
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-44">
        {request ? (
          // No accept: opening the conversation and replying is the way in,
          // and the notice above the composer says so.
          <ContextMenuItem
            className="text-destructive focus:text-destructive"
            onSelect={() => onBlock?.()}
          >
            <UserX className="mr-2 size-4" /> Block
          </ContextMenuItem>
        ) : (
          <>
            <ContextMenuItem onSelect={onTogglePin}>
              {pinned ? (
                <>
                  <PinOff className="mr-2 size-4" /> Unpin
                </>
              ) : (
                <>
                  <Pin className="mr-2 size-4" /> Pin
                </>
              )}
            </ContextMenuItem>
            {/* Puts an icon for this person on the community rail, where it
                behaves like any community: drag it, fold it, reorder it.
                Clicking it opens this thread — not the DM list — so the
                shortcut lands where it points on mobile too.

                1:1 only: a rail icon is one avatar, and the rail's stored
                arrangement holds bare pubkeys (`dmRailKey`), so a group has
                nothing to put there without changing what that layout means. */}
            {!group && (
            <ContextMenuItem onSelect={onToggleRail}>
              {onRail ? (
                <>
                  <PanelLeftDashed className="mr-2 size-4" /> Remove from rail
                </>
              ) : (
                <>
                  <PanelLeft className="mr-2 size-4" /> Add to rail
                </>
              )}
            </ContextMenuItem>
            )}
            {/* Note to Self is a fixture of the list, not a conversation the
                user is in — there is nobody to stop hearing from, so it has no
                close (the row would be back on the next render anyway). */}
            {onClose && (
              <ContextMenuItem onSelect={onClose}>
                <X className="mr-2 size-4" /> Close DM
              </ContextMenuItem>
            )}
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * A stable, varied body width for an undecrypted row. A screenful of
 * placeholders all cut to the same length reads as a loading bar rather than as
 * messages, so each row derives its width from its event id — deterministic, so
 * a row keeps the same width across re-renders and scroll passes, and so the
 * width never hints at the real message length.
 */
function placeholderBodyWidth(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return `${25 + (hash % 60)}%`;
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
          <Skeleton
            className="h-3.5 max-w-full"
            style={{ width: placeholderBodyWidth(id) }}
          />
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
 * Shown in place of the composer when the peer can't receive private (NIP-17)
 * DMs. Sending would fall back to legacy NIP-04 (kind 4), which leaks metadata
 * (who's talking, and when), so we make the downgrade an explicit, informed
 * choice rather than a silent default.
 */
function DmLegacyFallbackNotice({
  peer,
  name,
  onEnable,
}: {
  peer: string;
  name: string;
  onEnable: () => void;
}) {
  return (
    <div className="mx-2 mb-3 rounded-lg border border-border/60 bg-muted/40 px-4 py-3 text-sm">
      <div className="flex items-start gap-2.5">
        <Lock className="size-4 mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 space-y-2">
          <p className="text-muted-foreground">
            <span className="font-medium text-foreground">
              <DisplayName pubkey={peer} name={name} />
            </span> hasn't set
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
/**
 * A disappearing-messages timer change, rendered in the feed as a centered
 * notice (Signal's "You set the disappearing message timer to 1 day" row).
 * It's conversation state, not a message: no avatar, no actions, no reactions.
 */
function DmTimerNotice({ author, seconds, self, name }: { author: string; seconds: number; self: string | undefined; name: string }) {
  return (
    <div className="flex items-center justify-center gap-1.5 px-4 py-1.5 select-none" role="status">
      <Timer className="size-3.5 shrink-0 text-muted-foreground/70" aria-hidden />
      <span className="text-[11px] text-muted-foreground/80 text-center">
        {disappearingNotice(seconds, author === self, name)}
      </span>
    </div>
  );
}

/**
 * The message a DM replies to, if any. Our own sends carry a NIP-C7 `q`
 * (rich quote, shared with Concord's renderer); foreign NIP-17 clients use a
 * plain `e` parent tag per the spec — accept either. Kind-4 rows carry no
 * tags, so they never resolve.
 */
function dmReplyToId(msg: NostrRumor): string | undefined {
  if (msg.kind !== KIND_DM_CHAT && msg.kind !== KIND_DM_FILE) return undefined;
  return getQuoteReplyToId(msg) ?? msg.tags.find(([name, value]) => name === "e" && value)?.[1];
}

/**
 * Shown above the composer while reading a request.
 *
 * There is no accept button: replying IS accepting, and a separate control for
 * it was a third way to say the same thing whose effect the user couldn't see
 * (it moves a row in a list they're not looking at). So the notice states the
 * rule instead, and the only action offered is the one with no other path —
 * blocking, which is the ordinary NIP-51 mute and removes the peer from both
 * DM planes.
 */
function DmRequestNotice({
  peer,
  name,
  sharedCommunity,
  onBlock,
  blocking,
}: {
  /** The one sender, for a 1:1 request. Absent for a group. */
  peer?: string;
  name: string;
  sharedCommunity?: string;
  /** Absent for a group: blocking has to name a person, and a group has several. */
  onBlock?: () => void;
  blocking: boolean;
}) {
  return (
    // Two lines with the action beside them, not under them: this notice ADDS
    // to the composer's height rather than replacing it (unlike
    // DmLegacyFallbackNotice, whose card shape this deliberately no longer
    // copies), so every stacked row is height taken from the conversation.
    <div className="mx-2 mb-3 rounded-lg border border-border/60 bg-muted/40 px-4 py-2.5 text-sm">
      <div className="flex items-center gap-3">
        <Inbox className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          {/* Wraps rather than truncates: on a narrow phone the button leaves
              this column ~25 characters, so truncating would eat the community
              hint (and sometimes the peer's name) entirely. A taller card is
              the right trade against hiding what the notice is for. */}
          <p className="text-muted-foreground break-words">
            <span className="font-medium text-foreground">
              {peer ? <DisplayName pubkey={peer} name={name} /> : name}
            </span>{" "}
            {peer ? "isn't someone you follow" : "includes people you don't follow"}
            {sharedCommunity && ` · also in ${sharedCommunity}`}
          </p>
          <p className="text-xs text-muted-foreground/80">
            Reply to accept. {peer ? "They aren't" : "Nobody here is"} notified.
          </p>
        </div>
        {onBlock && (
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0 touch:h-11 text-destructive hover:text-destructive"
            onClick={onBlock}
            disabled={blocking}
          >
            <UserX className="size-4" />
            {blocking ? "Blocking…" : "Block"}
          </Button>
        )}
      </div>
    </div>
  );
}

function Conversation({
  conversation,
  peers,
  isRequest,
  onAccept,
  onBack,
}: {
  /** The conversation key — see `dmConvKey`. */
  conversation: string;
  /** Its participants: one for a 1:1, several for a group. */
  peers: string[];
  isRequest: boolean;
  onAccept: () => void;
  onBack: () => void;
}) {
  const { user } = useCurrentUser();
  const location = useLocation();
  const navigate = useNavigate();
  const group = peers.length > 1;
  // A group has no single counterparty, so anything derived from ONE profile
  // is 1:1-only below. `peer` is that counterparty where it exists, and is the
  // first participant otherwise purely so per-person controls have something to
  // name; every such control is hidden for a group.
  const peer = peers[0] ?? "";
  // See ConversationRow: a thread with yourself is Note to Self throughout —
  // header, composer and empty state — not a thread with your own profile.
  const noteToSelf = !group && peer === user?.pubkey;
  // One profile lookup per participant, shared by the header, the avatar and
  // the bot affordances below.
  const { name, metadata: peerMetadata } = useDmConversationName(peers, user?.pubkey);
  const dittoProfileHref = group ? undefined : dittoProfileUrl(peer);
  const composerBoundsRef = useRef<HTMLElement | null>(null);
  const focusedRumorId = useMemo(() => {
    const route = parseChatRoute(location.pathname);
    return route?.kind === "dm" && parseDmRouteParam(route.peer) === conversation
      ? route.messageId
      : undefined;
  }, [location.pathname, conversation]);
  const { transport, entries, syncing, disappearingTimer, setDisappearingTimer, encryptedIds, dm17Ids, dm17Enabled, legacyPinned, decryptVisible, decryptOne, decryptAll, decryptDeclined, hasEncrypted, send } =
    useDmTransport(conversation, peers, focusedRumorId);
  const { messages } = transport;

  // When the counterparty is a bot, its declared command set lets the timeline
  // render an untagged `/cmd args` invocation as an action line — a DM sends
  // invocations untagged (the recipient IS the bot), so there's no tag to key
  // off. Non-bot peers yield an empty set and nothing is ever promoted.
  // A normal DM already resolved this peer's profile for the header. Only fan
  // out to the public bot-manifest indexers when that profile explicitly marks
  // the peer as a bot; otherwise opening every DM needlessly connects to all
  // discovery relays (and surfaces their transient WebSocket failures).
  const botRoster = useMemo(
    () => (peerMetadata?.bot === true ? [peer] : []),
    [peerMetadata?.bot, peer],
  );
  const { entries: botCommandEntries } = useBotManifests(botRoster);
  const knownCommands = useMemo(
    () => new Set(botCommandEntries.map((e) => e.command.name)),
    [botCommandEntries],
  );
  const { markRead } = useReadState();
  const { dmLevel, setLevel: setNotifLevel } = useNotifLevels();
  const { toast } = useToast();
  const { config } = useAppContext();
  const { activeCall, joinDmCall, voiceRoomPubkeys } = useCall();
  const muteUser = useMuteUser();
  const mute = useMuteToggle(peer);
  // Legacy NIP-04 has no group form at all, so the encryption choice — and the
  // whole kind-4 fallback it selects — is 1:1 only. A group is NIP-17 or
  // nothing.
  const { pref: dmProtocol, setPref: setDmProtocol } = useDmProtocolPref(peer);
  const isTouch = useIsTouch();
  // Typing indicators ride the ephemeral NIP-17 plane, so they're only
  // available where that plane is: a legacy kind-4 thread has no envelope to
  // carry them. Subject to the user's `dmTypingIndicators` — see useDmTyping.
  // Never on an unaccepted request: reading a stranger's message must not send
  // that stranger a live signal that someone is on the other end.
  const { typers, publishTyping } = useDmTyping(conversation, dm17Enabled && !isRequest);
  // The tier-2 hint, for the accept banner. One local read, and only while a
  // request is actually open.
  const requestPeers = useMemo(
    () => (isRequest && !group ? [peer] : []),
    [isRequest, group, peer],
  );
  const sharedCommunity = useSharedCommunities(requestPeers, isRequest && !group).get(peer);

  // The shared row owns the inline field and keyboard behavior; this page only
  // tracks which NIP-17 row is active and hands the edit to the DM transport.
  // Reach the latest transport through a ref so unchanged rows keep stable
  // callback identities, matching Concord's channel implementation.
  const transportRef = useRef(transport);
  transportRef.current = transport;
  const [editingId, setEditingId] = useState<string | undefined>(undefined);
  const startEditing = useCallback((event: ChatMsg) => setEditingId(event.id), []);
  const cancelEditing = useCallback(() => setEditingId(undefined), []);
  useEffect(() => setEditingId(undefined), [conversation]);
  const handleEditSubmit = useCallback(async (original: ChatMsg, content: string) => {
    const trimmed = content.trim();
    if (!trimmed || trimmed === original.content.trim()) {
      setEditingId(undefined);
      return;
    }
    setEditingId(undefined);
    try {
      await transportRef.current.editMessage?.(original, trimmed);
    } catch {
      toast({
        title: "Edit failed",
        description: "Could not publish the edit.",
        variant: "destructive",
      });
    }
  }, [toast]);

  // Inline quote-reply state (NIP-17 sends only — a kind-4 send has no
  // in-band convention, so the control is hidden on legacy threads).
  const [replyTo, setReplyTo] = useState<NostrRumor | undefined>(undefined);
  useEffect(() => setReplyTo(undefined), [conversation]);

  // Forward: hand the message's CONTENT (never its author, reply context or
  // this thread's disappearing timer — see forwardableTags) to the share
  // destination picker. From there it takes the path an OS share already
  // takes: stashed against the chosen conversation, picked up by the composer
  // mounted there, and sent as an ordinary new message by this user. Landing
  // in the composer rather than sending on pick is deliberate — it's the one
  // chance to add a word or drop something before it goes.
  const handleForward = useCallback((event: ChatMsg) => {
    stashShare({ text: event.content, files: [], tags: forwardableTags(event) }, null);
    navigate("/share", {
      state: { forwardFrom: chatRoute({ kind: "dm", peer: dmRouteParam(conversation) }) },
    });
  }, [navigate, conversation]);

  // Legacy-encryption opt-in. When the peer can't receive private (NIP-17)
  // DMs, we DON'T silently downgrade to kind-4 (which leaks who's talking and
  // when). The composer is replaced by a notice until the user explicitly
  // chooses to send with legacy encryption; the choice is per-conversation and
  // resets when switching peers.
  const [legacyAllowed, setLegacyAllowed] = useState(false);
  useEffect(() => setLegacyAllowed(false), [conversation]);
  // Block sending only once we KNOW the peer has no NIP-17 inbox. While the
  // thread (and the peer's kind-10050 lookup) is still loading, assume the
  // private path so we don't flash a legacy notice for a reachable peer.
  // A conversation pinned to legacy NIP-04 sends kind-4 directly, so it's
  // never "blocked" — the composer is shown as-is.
  const legacyBlocked = !legacyPinned && !dm17Enabled && !transport.isLoading && !legacyAllowed;

  // Jump-to-quoted-message support (the reply context line is clickable),
  // message permalinks, and the mobile tap-to-reveal row. On touch devices the
  // per-message action toolbar is inert until the row is tapped active; a
  // second tap on a control fires it.
  const {
    timelineRef,
    jumpToMessage,
    pinToPresent,
    activeId,
    toggleActive,
  } = useTimelineFocus({
    messages,
    isLoading: transport.isLoading,
    hasMore: transport.hasMore,
    loadOlder: transport.loadOlder,
    resetKey: conversation,
  });

  // The loaded thread by id, for resolving quoted parents locally (NIP-17
  // rumors aren't relay-fetchable).
  const messagesById = useMemo(() => {
    const map = new Map<string, NostrRumor>();
    for (const m of messages) map.set(m.id, m);
    return map;
  }, [messages]);

  // Inline message search: toggled from the header, filters the loaded thread
  // client-side (no extra relay queries). The mute confirm dialog is opened
  // from the header's mute button.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [muteConfirmOpen, setMuteConfirmOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Reset the inline search whenever we switch conversations.
  useEffect(() => {
    setSearchOpen(false);
    setSearchQuery("");
  }, [conversation]);

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
  // run LiveKit); the explicit/fallback voice relays are tried before the
  // general DM set so unsupported cross-origin endpoints aren't probed first.
  // 1:1 only. `deriveDmRoomId` is a pairwise derivation with no defined
  // extension to a set, so a group thread simply has no call button rather than
  // a button that would put two members in different rooms.
  const roomId = user && !group ? deriveDmRoomId(user.pubkey, peer) : undefined;
  const dmRelays = useMemo(() => effectiveDmRelays(config), [config]);
  const voiceCandidates = useMemo(
    () => {
      // A custom Settings -> Voice server replaces the built-in voice relay;
      // general DM relays remain a last capability-probed fallback.
      const configured = effectiveDmVoiceRelays(DM_VOICE_RELAYS);
      const ordered = [...configured, ...dmRelays];
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
      if (document.visibilityState === "visible") markRead(dmReadKey(conversation), latest);
    };
    stamp();
    document.addEventListener("visibilitychange", stamp);
    return () => document.removeEventListener("visibilitychange", stamp);
  }, [messages, conversation, markRead]);

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
        // Replying is accepting. The cross-plane `mine` flag would eventually
        // say the same thing, but it lags the conversation queries — recording
        // it here moves the row out of the request pile in this same frame.
        if (isRequest) onAccept();
        // Sending is an explicit "I'm at the present", so follow the new
        // message even from a reader who had scrolled up — the timeline's own
        // stick-to-bottom deliberately won't, and group and Buzz chat both pin
        // here too — and the location must stop claiming they're parked at an
        // older one.
        pinToPresent();
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
    [send, toast, replyTo, legacyAllowed, isRequest, onAccept, pinToPresent],
  );

  const handleMute = useCallback(async () => {
    setMuteConfirmOpen(false);
    // Start the optimistic mute before leaving so the sidebar drops this peer
    // in the same interaction, then close the thread without waiting on relay
    // or signer round-trips.
    const pendingMute = muteUser.mutateAsync(peer);
    onBack();
    try {
      await pendingMute;
      toast({ title: "Muted", description: `You won't see messages from ${name}.` });
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
        <div className="shrink-0">
          <DmAvatar peers={peers} selfPubkey={user?.pubkey} sizePx={28} className="size-7" />
        </div>
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          <h1 className="font-semibold truncate min-w-0">
            {noteToSelf || group ? name : <DisplayName pubkey={peer} name={name} />}
          </h1>
          {!noteToSelf && !group && <BotPill metadata={peerMetadata} />}
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
          <DropdownMenuContent align="end" className="w-64 p-1.5">
            <DropdownMenuItem className="px-3 py-2" onClick={() => setSearchOpen(true)}>
              <Search className="size-4" />
              Search messages
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="px-3 py-2">
                {(() => {
                  const lvl = dmLevel(conversation);
                  const Icon = lvl === "nothing" ? BellOff : lvl === "mentions" ? AtSign : Bell;
                  return <Icon className="mr-2 size-4" />;
                })()}
                Notifications
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-48">
                <DropdownMenuRadioGroup
                  value={dmLevel(conversation)}
                  onValueChange={(v) => setNotifLevel(dmScopeKey(conversation), v as NotifLevel)}
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
            {/* Legacy NIP-04 is a pairwise cipher with no group form, so a
                group has no choice to offer: it is NIP-17 or it does not
                exist. */}
            {!group && (
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
            )}
            {/* Disappearing messages ride the NIP-17 plane's sealed rumors
                (the timer change is one, and the expiration tags go on the
                gift wraps); legacy kind-4 has no in-band channel for either,
                so the control is hidden on a legacy-pinned thread. */}
            {dm17Enabled && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className="px-3 py-2">
                  <Timer className="mr-2 size-4 shrink-0" />
                  {/* The current duration goes under the label rather than
                      beside it: the label alone nearly fills the menu width,
                      and a trailing value competes with the chevron's ml-auto
                      and wraps "Disappearing messages" into a squashed column. */}
                  <div className="min-w-0">
                    <div>Disappearing messages</div>
                    {disappearingTimer > 0 && (
                      <p className="text-xs text-muted-foreground">
                        {formatDisappearingDuration(disappearingTimer)}
                      </p>
                    )}
                  </div>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-56">
                  <p className="px-2 py-1.5 text-xs text-muted-foreground">
                    New messages in this chat disappear for everyone in it after
                    the time you pick. Anyone here can change it.
                  </p>
                  <DropdownMenuRadioGroup
                    value={String(disappearingTimer)}
                    onValueChange={(v) => setDisappearingTimer(Number(v))}
                  >
                    {DISAPPEARING_PRESETS.map((preset) => (
                      <DropdownMenuRadioItem key={preset.seconds} value={String(preset.seconds)}>
                        {preset.label}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
            {dittoProfileHref && (
              <DropdownMenuItem className="px-3 py-2" asChild>
                <a href={dittoProfileHref} target="_blank" rel="noopener noreferrer">
                  <DittoIcon className="size-4" />
                  View on Ditto
                </a>
              </DropdownMenuItem>
            )}
            {/* Not offered on Note to Self. Mute writes the peer to the NIP-51
                mute list, and the peer here is the viewer — muting yourself
                would hide your own messages everywhere in the app.

                Not offered on a group either: both actions name ONE person,
                and there is no non-arbitrary one to name. Muting any member
                hides the whole conversation (see useDm17Conversations), so
                offering it here without saying which member would be a
                destructive guess. */}
            {!noteToSelf && !group && (
              <>
                <DropdownMenuSeparator />
                {/* Muting closes the thread, so it confirms first. Unmuting is
                    reversible and costs nothing to undo — it just goes. */}
                {mute.muted ? (
                  <DropdownMenuItem
                    className="px-3 py-2"
                    disabled={mute.pending}
                    onClick={() => void mute.toggle()}
                  >
                    <UserCheck className="size-4" />
                    Unmute person
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem
                    className="px-3 py-2 text-destructive focus:text-destructive"
                    onClick={() => setMuteConfirmOpen(true)}
                  >
                    <UserX className="size-4" />
                    Mute person
                  </DropdownMenuItem>
                )}
                {/* A DM has no moderator: there is no room, no operator, and
                    nobody but the two of you. So the only place a report can go
                    is the public network — which the dialog says plainly, since
                    the reporter's words go out in the clear. The message itself
                    is never named: a NIP-17 rumor id resolves for no one. */}
                <DropdownMenuItem
                  className="px-3 py-2 text-destructive focus:text-destructive"
                  onClick={() => setReportOpen(true)}
                >
                  <Flag className="size-4" />
                  Report person
                </DropdownMenuItem>
              </>
            )}
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
          // Chat rows interleaved with the disappearing-messages timer
          // notices, so a change reads as history the way Signal's does.
          entries={entries}
          // An empty thread whose catch-up is still running hasn't been judged
          // yet: say "Catching up…" rather than "No messages yet". The wait
          // itself is NOT in the skeleton gate — see shouldShowDmTimelineLoading.
          syncing={syncing}
          renderEntry={(entry) =>
            entry.type === "dm-timer" ? (
              <DmTimerNotice
                key={entry.id}
                author={entry.author}
                seconds={entry.seconds}
                self={user?.pubkey}
                name={name}
              />
            ) : null
          }
          emptyState={
            noteToSelf ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <NoteToSelfIcon sizePx={40} className="size-10 text-muted-foreground/40 mb-3" />
                <p className="text-sm text-muted-foreground">No notes yet</p>
                <p className="text-xs text-muted-foreground/60 mt-1">
                  Anything you send here is just for you, and syncs to your other
                  devices.
                </p>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <MessageSquare className="size-10 text-muted-foreground/40 mb-3" />
                <p className="text-sm text-muted-foreground">No messages yet</p>
                <p className="text-xs text-muted-foreground/60 mt-1">
                  {group ? `Say hello to ${name}!` : <>Say hello to <DisplayName pubkey={peer} name={name} />!</>}
                </p>
              </div>
            )
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
                permalink={{ kind: "dm", peer: dmRouteParam(conversation) }}
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
                onForward={handleForward}
                isEditing={editingId === msg.id}
                onEdit={
                  dm17Ids.has(msg.id) && msg.pubkey === user?.pubkey && transport.editMessage
                    ? startEditing
                    : undefined
                }
                onEditSubmit={handleEditSubmit}
                onEditCancel={cancelEditing}
                replyContext={(() => {
                  const replyId = dmReplyToId(msg);
                  return replyId ? (
                    <ReplyContext parent={messagesById.get(replyId)} onJump={jumpToMessage} />
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

      {/* Sits directly above the composer, and only on the live thread — the
          search view is a filtered snapshot, not the conversation. */}
      {!normalizedSearch && <TypingIndicator pubkeys={typers} />}

      {isRequest && (
        <DmRequestNotice
          peer={group ? undefined : peer}
          name={name}
          sharedCommunity={sharedCommunity}
          onBlock={group ? undefined : () => setMuteConfirmOpen(true)}
          blocking={muteUser.isPending}
        />
      )}

      {legacyBlocked && !group ? (
        <DmLegacyFallbackNotice peer={peer} name={name} onEnable={() => setLegacyAllowed(true)} />
      ) : (
        <ChatComposer
          relayUrl="dm"
          groupId={conversation}
          messages={[]}
          // If this peer is a bot, offer its `/` commands. A DM's recipient IS
          // the bot, so the invocation sends untagged (no routing leak, and it
          // rides inside NIP-17's sealed rumor like any other DM content).
          botDmPeer={group ? undefined : peer}
          placeholder={noteToSelf ? "Add a note…" : `Message ${name}…`}
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
          // Land the caret in the composer on opening a conversation (this
          // component is keyed on `peer`, so it re-fires per conversation).
          // Not on touch: there the soft keyboard would spring up over the
          // thread mid slide-in, before the reader has seen any of it.
          autoFocus={!isTouch}
          // Throttled inside the hook (one signal per 4s), and a no-op unless
          // the user turned typing indicators on.
          onTyping={publishTyping}
          sendOverride={handleSubmit}
        />
      )}

      <AlertDialog open={muteConfirmOpen} onOpenChange={setMuteConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            {/* Blocking a request and muting a contact are the same NIP-51
                action; only the word the user clicked differs. */}
            <AlertDialogTitle>
              {isRequest ? "Block" : "Mute"} <DisplayName pubkey={peer} name={name} />?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This conversation will be hidden and you won't see new messages from{" "}
              <DisplayName pubkey={peer} name={name} />.
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
              {muteUser.isPending
                ? isRequest
                  ? "Blocking…"
                  : "Muting…"
                : isRequest
                  ? "Block"
                  : "Mute"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {reportOpen && (
        <ReportDialog
          open={reportOpen}
          onOpenChange={setReportOpen}
          destination={{ kind: "network" }}
          target={{ pubkey: peer }}
        />
      )}
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
  const { user } = useCurrentUser();
  // Picking yourself opens Note to Self, so name it that here too — otherwise
  // the one row that leads there is the only place still labelled with your own
  // handle, and it reads as messaging a stranger who happens to be you.
  const noteToSelf = pubkey === user?.pubkey;
  const name = noteToSelf ? NOTE_TO_SELF_NAME : getDisplayName(metadata, pubkey);
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
      {noteToSelf ? (
        <NoteToSelfAvatar sizePx={36} className="size-9" />
      ) : (
        <Avatar shape={getAvatarShape(metadata)} className="size-9 shrink-0">
          <AvatarImage src={picture} alt={name} />
          <AvatarFallback className="bg-primary/20 text-primary text-xs">
            {name[0]?.toUpperCase()}
          </AvatarFallback>
        </Avatar>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">
            {noteToSelf ? name : <DisplayName pubkey={pubkey} name={name} />}
          </span>
          {followed && !noteToSelf && (
            <UserCheck className="size-3.5 shrink-0 text-primary" aria-label="You follow this person" />
          )}
        </div>
        <span className="block truncate text-xs text-muted-foreground">
          {noteToSelf ? "Notes only you can read" : handle}
        </span>
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

/** A chosen recipient in the group composer's "To:" field. */
function RecipientChip({ pubkey, onRemove }: { pubkey: string; onRemove: () => void }) {
  const author = useAuthor(pubkey);
  const name = getDisplayName(author.data?.metadata, pubkey);
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-full bg-secondary py-0.5 pl-0.5 pr-1.5 text-sm">
      <Avatar shape={getAvatarShape(author.data?.metadata)} className="size-5 shrink-0">
        <AvatarImage src={sanitizeUrl(author.data?.metadata?.picture)} alt={name} />
        <AvatarFallback className="bg-primary/20 text-primary text-[9px]">
          {name[0]?.toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <span className="truncate">{name}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${name}`}
        className="shrink-0 rounded-full text-muted-foreground hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </span>
  );
}

/**
 * The "start a new chat" pane. Renders in the thread column in place of the
 * empty-state prompt (no modal). A "To:" field drives debounced profile
 * autocomplete — followed contacts first, then NIP-50 relay hits, plus a pasted
 * npub/nprofile/hex as a direct match — and the suggestions render inline below
 * the field with full keyboard nav (↑/↓ to move, Enter to open, Esc to cancel).
 *
 * Two modes, because a single one cannot serve both well. In DIRECT mode a tap
 * opens that person's thread immediately, which is what starting a DM has
 * always cost and what the overwhelming majority of uses want. GROUP mode is
 * entered deliberately from the row at the top and turns the same list into a
 * multi-select: taps accumulate chips and an explicit button starts the
 * conversation. Making every 1:1 pay a confirmation step to enable groups would
 * be the wrong trade.
 */
function NewDMPane({
  onSelectRecipients,
  onCancel,
}: {
  onSelectRecipients: (pubkeys: string[]) => void;
  onCancel: () => void;
}) {
  const { user } = useCurrentUser();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [group, setGroup] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const { data: profiles, isFetching, followedPubkeys } = useSearchProfiles(query);
  const trimmed = query.trim();

  // A pasted npub/nprofile/hex resolves to a pubkey we can DM directly, even if
  // it isn't in the search results. Surface it first, de-duped against results.
  const direct = resolvePubkey(query);
  const chosenSet = useMemo(() => new Set(chosen), [chosen]);
  const recipients = useMemo(() => {
    const fromSearch = (profiles ?? []).filter((p) => p.pubkey !== direct);
    const list: { pubkey: string; metadata?: SearchProfile["metadata"]; resolved?: boolean }[] = [];
    if (direct) list.push({ pubkey: direct, resolved: true });
    for (const p of fromSearch) list.push({ pubkey: p.pubkey, metadata: p.metadata });
    // Already-chosen people drop out of the suggestions rather than sitting
    // there inert: their chip above is where they are now.
    return group ? list.filter((r) => !chosenSet.has(r.pubkey)) : list;
  }, [profiles, direct, group, chosenSet]);

  // Reset the highlighted row whenever the candidate set changes.
  useEffect(() => {
    setActiveIndex(0);
  }, [recipients.length]);

  const pick = (pubkey: string) => {
    if (!group) {
      onSelectRecipients([pubkey]);
      return;
    }
    setChosen((prev) => (prev.includes(pubkey) ? prev : [...prev, pubkey]));
    setQuery("");
  };

  // Note to Self is the conversation with yourself alone, so a group that
  // includes you is just that group — your own copy is minted regardless.
  const groupPeers = useMemo(
    () => chosen.filter((pubkey) => pubkey !== user?.pubkey),
    [chosen, user?.pubkey],
  );
  const canStart = groupPeers.length > 0;

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
      return;
    }
    // Backspace on an empty field takes the last chip back — the standard
    // token-field gesture, and the only way to undo a pick without the mouse.
    if (e.key === "Backspace" && group && query === "" && chosen.length > 0) {
      e.preventDefault();
      setChosen((prev) => prev.slice(0, -1));
      return;
    }
    if (e.key === "Enter" && group && recipients.length === 0 && canStart) {
      e.preventDefault();
      onSelectRecipients(groupPeers);
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
      const candidate = recipients[activeIndex];
      if (candidate) pick(candidate.pubkey);
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
        {group ? (
          <Users className="size-4 text-muted-foreground shrink-0" />
        ) : (
          <PenSquare className="size-4 text-muted-foreground shrink-0" />
        )}
        <h1 className="font-semibold truncate flex-1 min-w-0">
          {group ? "New group" : "New message"}
        </h1>
        {group && (
          <Button
            size="sm"
            className="shrink-0 clip-corner-lg"
            disabled={!canStart}
            onClick={() => onSelectRecipients(groupPeers)}
          >
            Start
          </Button>
        )}
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
        {group && chosen.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {chosen.map((pubkey) => (
              <RecipientChip
                key={pubkey}
                pubkey={pubkey}
                onRemove={() => setChosen((prev) => prev.filter((p) => p !== pubkey))}
              />
            ))}
          </div>
        )}
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
        {/* The one way into group mode. It sits with the suggestions rather than
            in the header so it reads as another thing you can start, and it
            leaves once you are in that mode. */}
        {!group && (
          <button
            type="button"
            onClick={() => setGroup(true)}
            className="flex w-full items-center gap-3 rounded-lg p-2.5 text-left transition-colors hover:bg-secondary/60"
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/20 text-primary">
              <Users className="size-4" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">New group</span>
              <span className="block truncate text-xs text-muted-foreground">
                Message several people at once
              </span>
            </span>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          </button>
        )}
        {recipients.length > 0 ? (
          recipients.map((r, index) =>
            r.resolved ? (
              <ResolvedRecipientSuggestion
                key={r.pubkey}
                pubkey={r.pubkey}
                active={index === activeIndex}
                followed={followedPubkeys.has(r.pubkey)}
                onSelect={() => pick(r.pubkey)}
              />
            ) : (
              <RecipientSuggestion
                key={r.pubkey}
                pubkey={r.pubkey}
                metadata={r.metadata}
                active={index === activeIndex}
                followed={followedPubkeys.has(r.pubkey)}
                onSelect={() => pick(r.pubkey)}
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
                : group
                  ? canStart
                    ? "Add anyone else, or press Start."
                    : "Search for the people to include."
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
/**
 * Placeholder rows shown only when there is no snapshot to restore — a genuine
 * cold start for this account on this device. Mirrors ConversationRow's
 * geometry (gap-3, px-2.5 py-2.5, size-12 avatar, name line, preview line) so
 * the real list doesn't shift when it replaces these. Widths are fixed rather
 * than random so the placeholders don't reflow on re-render, and there are
 * enough of them to fill a tall viewport rather than trailing off into blank
 * space.
 */
const SKELETON_WIDTHS = [
  "70%", "45%", "58%", "38%", "64%", "50%", "72%", "42%",
  "55%", "66%", "34%", "61%", "47%", "75%", "40%", "53%",
] as const;

function ConversationRowSkeletons() {
  return (
    <div aria-hidden>
      {SKELETON_WIDTHS.map((width, i) => (
        <div key={i} className="flex items-center gap-3 w-full px-2.5 py-2.5">
          <Skeleton className="size-12 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-4 w-28 max-w-full" />
            <Skeleton className="h-3.5 max-w-full" style={{ width }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * A section label inside the conversation list ("Pinned" / "Recent"),
 * formatted like the pane's own "Messages" header one size down.
 */
function ConversationSectionHeader({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "px-2.5 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Approx height of one conversation row (avatar size-12 + py-2.5), for the gate placeholder. */
const ROW_MIN_H = 68;
/**
 * How many rows render eagerly before gating starts — a tall viewport's worth
 * at ROW_MIN_H, so everything the reader can see on the first frame is real
 * content rather than a placeholder that swaps in a frame later.
 *
 * Gating is by POSITION rather than by list length (MemberList's
 * VIRTUALIZE_THRESHOLD): a conversation row is dearer than a member row — it
 * fetches a remote avatar image on top of a profile query and a LiveKit
 * presence query — so the 40th row of a 41-row inbox is worth deferring too. A
 * length threshold also interacts badly with a list that GROWS into it: rows
 * first rendered while the list was short latch mounted (DeferredRow never
 * un-shows), so they'd stay eager no matter how long the list later got.
 */
const EAGER_ROWS = 12;

/** Which tier the conversation list is showing: the inbox or the request pile. */
type DmListView = "inbox" | "requests";

/**
 * One conversation-list row. `latest` is absent (as `undefined`, widened by the
 * builders) for a thread with no messages yet — a freshly-opened peer, a
 * started chat link, or Note to Self before its first note.
 */
interface DmListRow {
  /** The conversation key — see `dmConvKey`. */
  conversation: string;
  /** Its participants: one for a 1:1, several for a group. */
  peers: string[];
  latest: NostrRumor;
  plaintext?: string;
  mine: boolean;
}

/**
 * The single row at the top of the conversation list that holds the request
 * tier, shown only when there's something in it.
 *
 * Deliberately low-salience: a muted count, no primary-colored dot, and no
 * corresponding badge on the server rail (see `useHasUnreadDMs`). Requests are
 * found by opening DMs, never by the app demanding attention — otherwise
 * flooding a stranger's inbox becomes a way to light up their UI, and the
 * feature makes the app worse than hiding the messages did.
 */
function RequestsEntryRow({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-3 w-full px-2.5 py-2.5 rounded-lg text-left transition-colors hover:bg-secondary/60"
    >
      <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Inbox className="size-5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="text-[15px] font-medium truncate">Message requests</div>
        <div className="text-sm text-muted-foreground truncate">
          {count} {count === 1 ? "person you don't follow" : "people you don't follow"}
        </div>
      </div>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
    </button>
  );
}

/** Exported for DMsPage.list.test.tsx, which renders it directly. */
export function ConversationList({
  rows,
  requestRows,
  view,
  onViewChange,
  previews,
  events,
  activePeer,
  dmSupported,
  isLoading,
  hasUnread,
  onMarkAllRead,
  onCompose,
  openPeer,
  closePeer,
  loadMore,
  hasMore,
  isLoadingMore,
  className,
}: {
  rows: DmListRow[];
  /** Conversations in the request tier — see useKnownDmPeers. */
  requestRows: DmListRow[];
  view: DmListView;
  onViewChange: (view: DmListView) => void;
  previews: Record<string, string>;
  events: NostrRumor[];
  /** The open conversation's key, if any. */
  activePeer: string | undefined;
  dmSupported: boolean;
  isLoading: boolean;
  hasUnread: boolean;
  onMarkAllRead: () => void;
  onCompose: () => void;
  openPeer: (conversation: string) => void;
  closePeer: (conversation: string, latest: NostrRumor | undefined) => void;
  loadMore: () => Promise<number>;
  hasMore: boolean;
  isLoadingMore: boolean;
  className?: string;
}) {
  const { user } = useCurrentUser();
  const { getLastRead } = useReadState();
  const { registerCallBarSlot, activeCall } = useCall();
  const { config } = useAppContext();
  const muteUser = useMuteUser();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const requesting = view === "requests";

  // The tier-2 trust hint, resolved only while the request list is on screen —
  // it's one local IndexedDB read, so there's no reason to run it for an inbox
  // the user is just scrolling past.
  // The hint names ONE community two people share, so it only applies to a 1:1
  // request. A group request has several senders and no single shared-with.
  const requestPeers = useMemo(
    () => requestRows.filter((c) => c.peers.length === 1).map((c) => c.peers[0]),
    [requestRows],
  );
  const sharedCommunities = useSharedCommunities(requestPeers, requesting);

  // Older-history recovery for the request tier, and the outcome of the last
  // press (so a page that found nothing says so instead of looking inert).
  const backfill = useDm17Backfill();
  const [recovered, setRecovered] = useState<string[] | undefined>(undefined);
  const loadOlderRequests = useCallback(async () => {
    setRecovered(undefined);
    setRecovered(await backfill.loadOlder());
  }, [backfill]);
  // A page recovers history for EVERY correspondent, so most of what it finds
  // lands in the inbox (or is muted). Report only what this view gained, or the
  // number claimed won't match the rows under it.
  const olderFound = useMemo(
    () =>
      recovered === undefined
        ? undefined
        : recovered.filter((key) => requestRows.some((c) => c.conversation === key)).length,
    [recovered, requestRows],
  );

  const blockPeer = useCallback(
    async (peer: string) => {
      try {
        await muteUser.mutateAsync(peer);
      } catch (e) {
        toast({
          title: "Couldn't block",
          description: e instanceof Error ? e.message : "Please try again.",
          variant: "destructive",
        });
      }
    },
    [muteUser, toast],
  );

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
  // LiveKit-capable voice relay, then the user's DM relays.
  // Computed once here so each row can query its peer's voice presence without
  // re-resolving the relay per row.
  const dmRelays = useMemo(() => effectiveDmRelays(config), [config]);
  const voiceCandidates = useMemo(
    () => {
      // Match the conversation header's replacement semantics and fallback.
      const configured = effectiveDmVoiceRelays(DM_VOICE_RELAYS);
      const ordered = [...configured, ...dmRelays];
      return ordered.filter((r, i) => ordered.indexOf(r) === i);
    },
    [dmRelays],
  );
  const { data: voiceRelay } = useDmVoiceRelay(voiceCandidates);

  // Pinned conversations are lifted into their own section above the rest.
  // Both sections stay in `rows` order — newest message first — so a pinned
  // conversation that just received a message rises to the top of its section.
  const { pinned: pinnedPeers, isPinned, togglePin } = usePinnedDms();
  const { isOnRail, toggleRail } = useRailDms();
  const [pinnedRows, otherRows] = useMemo(() => {
    const pinnedSet = new Set(pinnedPeers);
    return [
      rows.filter((c) => pinnedSet.has(c.conversation)),
      rows.filter((c) => !pinnedSet.has(c.conversation)),
    ];
  }, [rows, pinnedPeers]);

  // While searching the list is a flat result set: a row hides itself when it
  // matches neither the contact nor any decrypted message (the parent can't
  // know which rows survive), so a section header here could end up labelling
  // nothing.
  const sectioned = search.trim().length === 0 && pinnedRows.length > 0;

  // Gating is off entirely while searching: a row hides itself when it matches
  // neither the contact nor any decrypted message (ConversationRow returns
  // null), so a placeholder would reserve height for rows that render nothing
  // and the results would sit in a field of gaps.
  const gateRows = search.trim().length === 0;

  // Nothing but Note to Self — i.e. what used to be an empty list.
  const onlyNoteToSelf = rows.length === 1 && rows[0]?.conversation === user?.pubkey;

  const renderRow = (c: DmListRow, index: number, request = false) => (
    <DeferredRow key={c.conversation} active={gateRows && index >= EAGER_ROWS} minHeight={ROW_MIN_H}>
    <ConversationRow
      peers={c.peers}
      preview={c.latest}
      previewText={c.plaintext ?? previews[c.conversation]}
      query={search}
      messageMatch={messageMatches.get(c.conversation)?.text}
      unread={
        Boolean(c.latest) &&
        c.latest.pubkey !== user?.pubkey &&
        c.latest.created_at > getLastRead(dmReadKey(c.conversation)) &&
        c.conversation !== activePeer
      }
      active={c.conversation === activePeer}
      pinned={isPinned(c.conversation)}
      onRail={isOnRail(c.conversation)}
      request={request}
      sharedCommunity={request ? sharedCommunities.get(c.conversation) : undefined}
      inCall={Boolean(activeCall?.dmPeer) && activeCall?.dmPeer === c.conversation}
      selfPubkey={user?.pubkey}
      voiceRelay={voiceRelay ?? undefined}
      onClick={() => openPeer(c.conversation)}
      onTogglePin={() => togglePin(c.conversation)}
      onToggleRail={() => toggleRail(c.conversation)}
      // Note to Self is always in the list (see withNoteToSelf), so there is
      // nothing a close could achieve — the row is re-added on the next render.
      onClose={c.conversation === user?.pubkey ? undefined : () => closePeer(c.conversation, c.latest)}
      // Blocking a group request would have to name one of several senders, so
      // it is offered on 1:1 requests only (ConversationRow hides the item).
      onBlock={c.peers.length === 1 ? () => void blockPeer(c.peers[0]) : undefined}
    />
    </DeferredRow>
  );

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
          <div
            className={cn(
              "flex items-center justify-between pr-2 py-1 min-h-6",
              requesting ? "pl-1" : "pl-4",
            )}
          >
            {requesting ? (
              <button
                type="button"
                onClick={() => onViewChange("inbox")}
                className="flex items-center gap-1 pr-2 py-1 rounded text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
              >
                <ChevronLeft className="size-4" aria-hidden />
                Requests
              </button>
            ) : (
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Messages
              </span>
            )}
            <div className={cn("flex items-center gap-2", requesting && "hidden")}>
              {hasUnread && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 touch:size-11 shrink-0 text-muted-foreground hover:text-foreground"
                      aria-label="Mark all as read"
                      onClick={onMarkAllRead}
                    >
                      <CheckCheck className="size-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Mark all as read</TooltipContent>
                </Tooltip>
              )}
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
        ) : requesting ? (
          <>
            <p className="px-2.5 pt-1 pb-2 text-xs text-muted-foreground">
              Messages from people you don't follow. Reply to one and it moves
              to your inbox. Nobody here is told you've seen theirs.
            </p>
            {requestRows.map((c, i) => renderRow(c, i, true))}
            {/* The automatic sync only moves forward, so a sender whose
                messages all predate this device's first sync never appears on
                its own. Explicit, one page at a time — see useDm17Backfill. */}
            <div className="flex flex-col items-center gap-1 py-3">
              {backfill.hasMore ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                  disabled={backfill.isLoading}
                  onClick={() => void loadOlderRequests()}
                >
                  {backfill.isLoading ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      Looking…
                    </>
                  ) : (
                    "Look for older requests"
                  )}
                </Button>
              ) : (
                <p className="text-xs text-muted-foreground">
                  That's everything your relays still have.
                </p>
              )}
              {olderFound !== undefined && (
                <p className="text-xs text-muted-foreground">
                  {olderFound === 0
                    ? "No older requests found."
                    : `Found ${olderFound} older ${olderFound === 1 ? "request" : "requests"}.`}
                </p>
              )}
            </div>
          </>
        ) : isLoading ? (
          <ConversationRowSkeletons />
        ) : (
          <>
            {/* Above the pinned section: the request tier is a property of the
                whole list, not of any one section within it. Hidden while
                searching — search is a flat result set over the inbox. */}
            {config.showDmRequests && requestRows.length > 0 && search.trim().length === 0 && (
              <RequestsEntryRow
                count={requestRows.length}
                onClick={() => onViewChange("requests")}
              />
            )}
            {sectioned ? (
              <>
                <ConversationSectionHeader className="pt-1">Pinned</ConversationSectionHeader>
                {pinnedRows.map((c, i) => renderRow(c, i))}
                {otherRows.length > 0 && (
                  <ConversationSectionHeader>Recent</ConversationSectionHeader>
                )}
                {/* Numbering continues across the two sections: what matters is
                    how far down the scroll container a row sits, not which
                    section it's in. */}
                {otherRows.map((c, i) => renderRow(c, pinnedRows.length + i))}
              </>
            ) : (
              [...pinnedRows, ...otherRows].map((c, i) => renderRow(c, i))
            )}
            {/* The "start one" hint used to stand in for an empty list. Note to
                Self is always a row, so the list is never empty — the hint goes
                UNDER the only row there is instead of replacing it. */}
            {onlyNoteToSelf && requestRows.length === 0 && search.trim().length === 0 && (
              <p className="text-sm text-muted-foreground p-3">
                No conversations yet. Start one with the + button.
              </p>
            )}
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
 * thread on the right. DMs ride either plane — legacy NIP-04 kind-4 events or
 * NIP-17 sealed rumors — over the user's own configured relays.
 */
export function DMsPage() {
  const navigate = useNavigate();
  const { peer: rawPeer } = useParams<{ peer: string }>();
  const { user } = useCurrentUser();
  const self = user?.pubkey;
  // Either plane makes DMs usable: kind-4 needs nip04, NIP-17 needs nip44.
  const dmSupported = useDMSupport();
  const dm17Supported = useDm17Support();
  const {
    conversations,
    previews,
    events,
    isLoading: kind4Loading,
    loadMore,
    hasMore,
    isLoadingMore,
  } = useDMConversations({ decryptPreviews: true });
  // NIP-17 conversations (decrypted rumors from the local store). Interactive:
  // opening the DMs page is where the one-time decrypt-consent prompt may
  // legitimately appear (same moment the kind-4 previews could open it).
  const { conversations: dm17Conversations, isLoading: dm17Loading } = useDm17Conversations({
    interactive: true,
  });
  // Adopt the viewer's published kind-10050 inbox as the local DM relay set
  // (local config only — NEVER publishes; a 10050 list is only ever written by
  // an explicit save in Settings).
  useAdoptDmInbox();
  const { isKnown, isLoading: followsLoading } = useKnownDmPeers();
  const { accept } = useAcceptedDms();
  const { started: startedPeers } = useStartedDms();
  const { close: closeDm, reopen: reopenDm, reopenForNewMessages, isClosed: isDmClosed } = useClosedDms();
  const [composing, setComposing] = useState(false);
  const [listView, setListView] = useState<DmListView>("inbox");

  // True until EVERY input to `rows` has settled. Each one changes the list's
  // contents or its order — NIP-17 rumors supply the newest message for many
  // peers, and an unresolved follow set hides every row the viewer didn't send
  // the last message in — so a partially-loaded `rows` is a deterministically
  // wrong list that re-sorts a beat later. While this holds we show the
  // restored snapshot (or skeletons) instead of that partial view.
  // (`kind4Loading` also covers the mute set, which gates upstream.)
  const isLoading = kind4Loading || dm17Loading || followsLoading;

  // The route param is one npub for a 1:1 and several for a group; either way
  // it parses to a canonical conversation key (re-sorted, so a hand-ordered
  // link can't mint a second conversation for the same people).
  const activePeer = parseDmRouteParam(rawPeer);

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
    // No active peer: keep the last thread mounted for the slide-out, then
    // drop it — at IDLE, not on a bare timer. Unmounting a full message
    // timeline (unvirtualized rows, media embeds, composer) is one synchronous
    // commit; on a fixed 250ms timer it landed right at the 200ms settle
    // transition's tail and read as an end-of-gesture stutter. The timeout
    // bound still tears it down if the main thread never goes idle.
    let idleId: number | undefined;
    const timer = setTimeout(() => {
      if (typeof requestIdleCallback === "function") {
        idleId = requestIdleCallback(() => setRenderedPeer(undefined), { timeout: 1000 });
      } else {
        setRenderedPeer(undefined);
      }
    }, 300);
    return () => {
      clearTimeout(timer);
      if (idleId !== undefined) cancelIdleCallback(idleId);
    };
  }, [activePeer]);

  // Composing takes over the thread column immediately — drop any lingering
  // slide-out thread so the recipient picker shows without a thread flashing.
  useEffect(() => {
    if (composing) setRenderedPeer(undefined);
  }, [composing]);

  // Conversations plus the active peer if it's a brand-new thread. Kind-4 and
  // NIP-17 conversations merge per peer (newest message wins; a NIP-17 rumor
  // is already plaintext, so it carries its own preview text), then split into
  // the inbox and the request tier by the shared `isKnown` predicate.
  //
  // The split is the ONLY thing separating the two lists, so neither can gain
  // or lose a row the other doesn't correspondingly lose or gain.
  const [rows, requestRows] = useMemo(() => {
    // Keyed by CONVERSATION, which for every kind-4 row is just the peer — the
    // legacy plane is pairwise, so its rows merge with the NIP-17 1:1 of the
    // same person and never with a group.
    const byConversation = new Map<string, DmListRow>();
    for (const c of conversations) {
      byConversation.set(c.peer, {
        conversation: c.peer,
        peers: [c.peer],
        latest: c.latest,
        mine: c.mine,
      });
    }
    for (const c of dm17Conversations) {
      const existing = byConversation.get(c.key);
      // Participation is sticky across planes: either plane having a
      // viewer-authored message keeps the row visible below.
      const mine = (existing?.mine ?? false) || c.mine;
      if (existing && existing.latest.created_at >= c.latest.createdAt) {
        existing.mine = mine;
        continue;
      }
      byConversation.set(c.key, {
        conversation: c.key,
        peers: c.peers,
        latest: {
          id: c.latest.rumorId,
          pubkey: c.latest.author,
          created_at: c.latest.createdAt,
          kind: c.latest.kind,
          content: c.latest.content,
          tags: c.latest.tags,
        },
        plaintext: c.latest.content,
        mine,
      });
    }
    const sorted = [...byConversation.values()].sort(
      (a, b) => b.latest.created_at - a.latest.created_at,
    );
    const known: DmListRow[] = [];
    const requests: DmListRow[] = [];
    // A group is in the inbox only when EVERY participant is known — one
    // stranger in the room makes it a request, exactly as a message from that
    // stranger alone would.
    for (const c of sorted) {
      (c.peers.every((peer) => isKnown(peer, c.mine)) ? known : requests).push(c);
    }
    // Threads seeded by following someone's chat link (`/<npub>`): message-less
    // like the active peer below, but kept after we navigate away — the whole
    // point of the link was to put this person in the list. Oldest-started
    // first, so the newest lands nearest the top.
    for (const peer of startedPeers) {
      if (peer === activePeer) continue; // the rule below already places it
      if (peer === self) continue; // Note to Self places itself — see withNoteToSelf
      if (sorted.some((c) => c.conversation === peer)) continue; // it has real messages
      known.unshift({
        conversation: peer,
        peers: [peer],
        latest: undefined as unknown as NostrRumor,
        mine: false,
      });
    }
    // A peer with no messages at all that we've navigated to is a thread the
    // user deliberately started: it belongs in the inbox, not the request pile.
    // (An EXISTING stranger conversation opened by deep link stays a request —
    // the list switches to the request view to show it instead.)
    // Note to Self is excluded: it is in the list whether or not it is open, so
    // hoisting it on open would move the row under the user as they clicked it.
    if (activePeer && activePeer !== self && !sorted.some((c) => c.conversation === activePeer)) {
      known.unshift({
        conversation: activePeer,
        peers: dmConvPeers(activePeer),
        latest: undefined as unknown as NostrRumor,
        mine: false,
      });
    }
    return [known, requests];
  }, [conversations, dm17Conversations, activePeer, isKnown, startedPeers, self]);

  // A closed row is only a dismissal of the current latest message. As soon as
  // either participant sends another message, it becomes visible immediately;
  // then remove the obsolete marker from synced settings.
  useEffect(() => {
    reopenForNewMessages(rows.map((r) => ({ peer: r.conversation, latest: r.latest })));
  }, [rows, reopenForNewMessages]);

  // Note to Self is exempt: it is shown at all times, so a close marker could
  // only ever strip the row of its preview (withNoteToSelf would re-add it
  // message-less) rather than hide it. Markers from before it became a fixture
  // of the list are the case this actually covers.
  const isHidden = useCallback(
    (row: DmListRow) => row.conversation !== self && isDmClosed(row.conversation, row.latest),
    [self, isDmClosed],
  );

  const visibleRows = useMemo(() => rows.filter((row) => !isHidden(row)), [rows, isHidden]);

  // Open a request's thread and the list follows it into the request view —
  // covers both clicking through and landing on `/dm/<stranger>` cold. It only
  // ever switches INTO requests: a peer that graduates to the inbox mid-thread
  // (you replied, so `mine` flipped) shouldn't yank the list out from under the
  // conversation being read. The empty-list effect below handles that instead.
  useEffect(() => {
    if (activePeer && requestRows.some((c) => c.conversation === activePeer)) setListView("requests");
  }, [activePeer, requestRows]);
  useEffect(() => {
    if (requestRows.length === 0) setListView("inbox");
  }, [requestRows.length]);

  // The list as it was last rendered, restored synchronously. Because what was
  // stored is the merged/filtered/sorted OUTCOME — not any one source's partial
  // view — this paints in the final order, so when the live rows replace it
  // nothing moves except conversations that genuinely got new messages.
  const restoredRows = useMemo(() => {
    const snapshot = readDmListSnapshot(user?.pubkey);
    return (snapshot ?? []).map((r) => ({
      conversation: r.peer,
      // The snapshot predates group conversations and stores a bare key; every
      // key IS its participant list, so decoding it covers both shapes without
      // a stored-format change (see `dmConvKey`).
      peers: dmConvPeers(r.peer),
      latest: {
        id: r.eventId ?? "",
        pubkey: r.author,
        created_at: r.createdAt,
        kind: 4,
        content: "",
        // Emoji tags only — enough for the preview line to render custom emoji
        // on the first frame, so a restored row doesn't swap a raw shortcode
        // for an image when the live rows land.
        tags: r.emojiTags ?? [],
      } satisfies NostrRumor,
      plaintext: r.preview,
      mine: r.mine,
    }));
  }, [user?.pubkey]);

  const visibleRestoredRows = useMemo(
    () => restoredRows.filter((row) => !isHidden(row)),
    [restoredRows, isHidden],
  );

  /**
   * Guarantee the Note to Self row, wherever the list came from.
   *
   * It is a place to put something rather than a conversation that has to be
   * started, so it is present before the first note exists — but it is not
   * PINNED there: once it has notes it is an ordinary row that arrived through
   * the merge above and sorts by its newest one like any other. Only the
   * message-less case is appended, and it goes last, which is where a
   * conversation whose newest message is "none" belongs.
   *
   * Applied here rather than inside `rows` so it covers the restored snapshot
   * too — a cold start must not show the list without it for the window before
   * the live rows land — and so the snapshot writer keeps seeing real rows only.
   */
  const withNoteToSelf = useCallback(
    (list: DmListRow[]): DmListRow[] => {
      if (!self || list.some((r) => r.conversation === self)) return list;
      return [
        ...list,
        {
          conversation: self,
          peers: [self],
          latest: undefined as unknown as NostrRumor,
          mine: true,
        },
      ];
    },
    [self],
  );

  // Skeletons are for a genuine cold start only: with a snapshot we show the
  // restored list instead, which is real content in the right order.
  const showSkeletons = isLoading && visibleRestoredRows.length === 0;
  const displayRows = useMemo(() => {
    if (!isLoading || visibleRestoredRows.length === 0) return withNoteToSelf(visibleRows);
    // Keep the open thread's row present even if it predates the snapshot.
    if (!activePeer || visibleRestoredRows.some((r) => r.conversation === activePeer)) {
      return withNoteToSelf(visibleRestoredRows);
    }
    return withNoteToSelf([
      {
        conversation: activePeer,
        peers: dmConvPeers(activePeer),
        latest: undefined as unknown as NostrRumor,
        mine: false,
      },
      ...visibleRestoredRows,
    ]);
  }, [isLoading, visibleRestoredRows, visibleRows, activePeer, withNoteToSelf]);

  // Persist the settled list for the next launch, debounced so a burst of live
  // messages coalesces. Gated on `!isLoading`, so a partial view is never
  // stored, and taken from the INBOX rows only — snapshotting the unsplit list
  // would paint requests into the inbox on the next cold start, for the whole
  // window before the live rows land. An empty settled list clears the snapshot
  // rather than leaving stale rows to be restored.
  useEffect(() => {
    const self = user?.pubkey;
    if (isLoading || !self) return;
    const timer = setTimeout(() => {
      writeDmListSnapshot(
        self,
        visibleRows
          .filter((c) => c.latest)
          .map((c) => ({
            peer: c.conversation,
            eventId: c.latest.id,
            createdAt: c.latest.created_at,
            author: c.latest.pubkey,
            preview: c.plaintext ?? previews[c.conversation],
            emojiTags: pickEmojiTags(c.latest.tags),
            // Carried so a restored preview of a disappearing message is
            // dropped once its deadline passes (see readDmListSnapshot).
            expiresAt: expirationOf(c.latest.tags),
            mine: c.mine,
          })),
      );
    }, 800);
    return () => clearTimeout(timer);
  }, [isLoading, visibleRows, previews, user?.pubkey]);

  const openPeer = useCallback(
    (conversation: string) => {
      setComposing(false);
      // Mount the thread synchronously in the same render that closes the
      // compose pane, so we never fall through to the empty state for a frame
      // between `composing` going false and the route-driven effect setting
      // `renderedPeer`. (Without this the "Select a conversation" screen flashes
      // when switching from a new-message draft to an existing conversation.)
      setRenderedPeer(conversation);
      navigate(chatRoute({ kind: "dm", peer: dmRouteParam(conversation) }));
    },
    [navigate],
  );

  // Accepting a conversation accepts every participant. `acceptedDms` is a set
  // of PEOPLE, and the inbox/request split asks whether ALL of them are known —
  // so accepting only one member would leave the row in the request pile.
  const acceptConversation = useCallback(
    (conversation: string) => {
      for (const peer of dmConvPeers(conversation)) accept(peer);
    },
    [accept],
  );

  // Picking recipients in the new-message pane is an explicit "I want to talk
  // to these people", so it accepts them outright. Without this, composing to
  // someone you don't follow would drop the thread into your own request pile
  // until the first message lands and `mine` flips.
  const openNewRecipients = useCallback(
    (pubkeys: string[]) => {
      const conversation = dmConvKey([...new Set(pubkeys)].sort());
      reopenDm(conversation);
      acceptConversation(conversation);
      openPeer(conversation);
    },
    [reopenDm, acceptConversation, openPeer],
  );

  const closePeer = useCallback(
    (conversation: string, latest: NostrRumor | undefined) => {
      closeDm(conversation, latest);
      if (activePeer === conversation) {
        setRenderedPeer(undefined);
        navigate("/dm");
      }
    },
    [closeDm, activePeer, navigate],
  );

  // "Mark all as read": stamp every conversation whose latest message is from
  // the peer (monotonic stamps, so already-read conversations no-op). Covers
  // both DM planes — the same set the rail's unread dot checks.
  const { markRead } = useReadState();
  const hasUnreadDms = useHasUnreadDMs();
  // Requests are skipped: the action lives in the inbox header and clearing an
  // unread marker there must not quietly triage a pile the user hasn't looked at.
  const markAllDmsRead = useCallback(() => {
    if (!user) return;
    for (const c of conversations) {
      if (c.latest.pubkey !== user.pubkey && isKnown(c.peer, c.mine)) {
        markRead(dmReadKey(c.peer), c.latest.created_at);
      }
    }
    for (const c of dm17Conversations) {
      if (c.latest.author !== user.pubkey && c.peers.every((peer) => isKnown(peer, c.mine))) {
        markRead(dmReadKey(c.key), c.latest.createdAt);
      }
    }
  }, [user, conversations, dm17Conversations, isKnown, markRead]);

  if (!user) {
    return <Navigate to="/" replace />;
  }

  // Reveal the conversation list (slide the thread/compose pane away) by
  // clearing the active peer and cancelling compose; return to the still-mounted
  // thread by re-selecting it.
  const revealList = () => {
    setComposing(false);
    navigate("/dm");
  };
  const returnToThread = () => {
    if (renderedPeer) navigate(chatRoute({ kind: "dm", peer: dmRouteParam(renderedPeer) }));
  };
  const startComposing = () => {
    navigate("/dm");
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
            rows={displayRows}
            requestRows={requestRows}
            view={listView}
            onViewChange={setListView}
            previews={previews}
            events={events}
            activePeer={activePeer}
            dmSupported={dmSupported || dm17Supported}
            isLoading={showSkeletons}
            hasUnread={hasUnreadDms}
            onMarkAllRead={markAllDmsRead}
            onCompose={startComposing}
            openPeer={openPeer}
            closePeer={closePeer}
            loadMore={loadMore}
            hasMore={hasMore}
            isLoadingMore={isLoadingMore}
            // Wider than a community's ChannelSidebarView (w-60): a channel row
            // is one short "# name", but a conversation row carries an avatar,
            // a display name and a message preview that truncates hard at 240px.
            // Steps up again once the viewport can spare it.
            className="flex-1 sidebar:flex-none sidebar:w-72 xl:w-80"
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
            conversation={renderedPeer}
            peers={dmConvPeers(renderedPeer)}
            isRequest={requestRows.some((c) => c.conversation === renderedPeer)}
            onAccept={() => acceptConversation(renderedPeer)}
            onBack={revealList}
          />
        ) : composing ? (
          <NewDMPane onSelectRecipients={openNewRecipients} onCancel={revealList} />
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
