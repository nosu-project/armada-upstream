/**
 * Transport-agnostic chat contracts.
 *
 * The chat UI (timeline, message rows, composer) is 100% presentational and
 * derives entirely from these types. A "transport" supplies the data and the
 * mutation callbacks; the shared components never touch a relay, a NIP-29 hook
 * or Concord's sealed envelopes directly. NIP-29 group chat and Concord
 * (end-to-end-encrypted communities) each implement a transport that satisfies
 * this contract, so they render through exactly the same components.
 *
 * Capabilities are optional: a feature's control renders only when the
 * transport provides the matching callback. A transport that can't pin (or
 * thread, or edit) simply omits that method and the UI hides the control —
 * there are no dead/disabled buttons.
 */

import type { ReactInput, ReactionTally } from "@/hooks/useReactions";
import type { SendStatus } from "@/hooks/useGroupMessages";
import type { CalendarEvent, RsvpStatus, RsvpTally } from "@/lib/calendar";
import type { PollOption, PollTally, PollType } from "@/lib/polls";
import type { ZapTally } from "@/lib/zaps";
import type { NostrRumor } from "@/lib/nostrRumor";

export type { ReactInput, ReactionTally, SendStatus };

/**
 * A chat message in the shared event shape. NIP-29 messages are relay events
 * (kind 9 / 1068); Concord messages are adapted from a decrypted
 * `OpenedMessage` (`openedToEvent`); and either can be read back from the local
 * store, which drops signatures.
 *
 * So the shape is a RUMOR, not a `NostrEvent`. Rendering never verifies a
 * signature and does not need one — but a chat message is not a thing you can
 * hand to a relay, and this is where that stopped being a comment. Use
 * `isSigned` (or the publish outbox) where a real signature is required.
 */
export type ChatMsg = NostrRumor & {
  /**
   * Stable React key, when the message's `id` is not stable for its lifetime.
   *
   * An optimistically-rendered message is shown before it can be signed, so it
   * starts with a placeholder id and adopts the real event id once signing
   * completes. Keying rows on `id` alone made that swap unmount and remount the
   * row — the send read as "message appears, disappears, reappears", and the
   * timeline's scroll-anchor bookkeeping (which tracks rows by key) lost its
   * anchor. Transports that swap ids set this once and keep it across the swap.
   */
  renderKey?: string;
};

/**
 * Participants ordered by how recently they last spoke, most recent first,
 * deduped. Feeds a bot command's `user`-argument picker so the people active in
 * this conversation surface ahead of the rest of the roster.
 */
export function authorsByRecency(messages: ChatMsg[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of [...messages].sort((a, b) => b.created_at - a.created_at)) {
    if (!seen.has(m.pubkey)) {
      seen.add(m.pubkey);
      out.push(m.pubkey);
    }
  }
  return out;
}

/**
 * Adapt a non-`NostrEvent` message (a decrypted Concord `OpenedMessage`, a
 * decrypted DM) into the shared `ChatMsg` shape so it renders through the same
 * `MessageRow`/`ChatContent`/`ChatMessage` path. Rendering never re-verifies the
 * signature, so a synthetic `sig: ""` is filled in when the source has none.
 */
export function toChatMsg(m: {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  content: string;
  tags?: string[][];
  renderKey?: string;
}): ChatMsg {
  return {
    id: m.id,
    pubkey: m.pubkey,
    created_at: m.created_at,
    kind: m.kind,
    content: m.content,
    tags: m.tags ?? [],
    ...(m.renderKey ? { renderKey: m.renderKey } : {}),
  };
}

/**
 * Per-message reaction state + toggle, resolved by the transport for one
 * message. Mirrors the return shape of {@link useReactions} so the shared
 * `ReactionBar`/`ReactionPicker` consume it unchanged.
 */
export interface MessageReactions {
  tallies: ReactionTally[];
  react: (input: ReactInput) => void;
}

/** Per-message zap state, resolved by the transport for one message. */
export interface MessageZaps {
  tally: ZapTally;
}

/** Per-poll tally + vote callback, resolved by the transport for a poll message. */
export interface MessagePoll {
  tally: PollTally;
  vote: (optionIds: string[]) => void;
}

/**
 * Per-calendar-event RSVP state + setter, resolved by the transport for a
 * calendar (kind 31922/31923) message. Its presence lets the row render its
 * inline event card with live RSVP tallies. Both NIP-29 (relay query) and
 * Concord (sealed fold) supply it; the card itself is transport-agnostic.
 */
export interface MessageCalendar {
  /** The parsed, addressably-deduped event (newest per author/`d`). */
  event: CalendarEvent;
  /** The resolved RSVP tally (going / maybe / can't-go + the user's own). */
  tally: RsvpTally;
  /** Whether the current user may RSVP (membership / write access). */
  canRsvp: boolean;
  /** Whether an RSVP publish is in flight (drives the button disabled state). */
  isSettingRsvp: boolean;
  /** Set the current user's RSVP for this event. */
  setRsvp: (status: RsvpStatus) => void;
}

/** A poll to publish, handed by the composer to a transport's {@link ChatTransport.sendPoll}. */
export interface PollDraft {
  question: string;
  options: PollOption[];
  pollType: PollType;
  /** Days until the poll closes; 0 = no end. */
  durationDays: number;
}

/**
 * Wrap a tally lookup in a per-id object cache so unchanged rows keep a
 * stable {@link MessageZaps} prop (preserves React.memo). Shared by both
 * transports' `zapsFor`.
 */
export function stableZapsFor(
  get: (id: string) => ZapTally | undefined,
): (id: string) => MessageZaps | undefined {
  const cache = new Map<string, { tally: ZapTally; value: MessageZaps }>();
  return (id) => {
    const tally = get(id);
    if (!tally) return undefined;
    const hit = cache.get(id);
    if (hit && hit.tally === tally) return hit.value;
    const value: MessageZaps = { tally };
    cache.set(id, { tally, value });
    return value;
  };
}

/**
 * A settled lightning payment, handed by the shared zap dialog to a transport
 * whose zap announcement is its own event (Concord's sealed CORD.md rumor).
 * NIP-29 has no publish step — the LNURL provider's public receipt is the
 * announcement — so its transport omits {@link ChatTransport.sendZap}.
 */
export interface ZapPayment {
  amountMsats: number;
  bolt11: string;
  /** Payment proof; present when the payer's wallet returned it (NWC/WebLN). */
  preimage?: string;
  comment: string;
}

/**
 * A settled on-chain Bitcoin zap, handed by the zap dialog to a transport
 * whose on-chain zap announcement is a sealed chat-plane event (Concord).
 * NIP-29 has no publish step — the public kind 8333 event is the
 * announcement — so its transport omits {@link ChatTransport.sendOnchainZap}.
 */
export interface OnchainZapAnnouncement {
  /** The broadcast Bitcoin transaction id. */
  txid: string;
  /** Amount sent in satoshis. */
  amountSats: number;
  /** Optional comment from the payer. */
  comment: string;
}

/**
 * The capability surface a chat timeline/message/composer consumes. Required
 * members are the irreducible minimum (list + identity + send); everything else
 * is an optional capability gated by presence.
 */
export interface ChatTransport {
  /** Ascending (oldest-first) message list. */
  messages: ChatMsg[];
  /** Whether the initial message load is in flight (drives the skeleton). */
  isLoading: boolean;
  /** Whether the current user may write (drives composer + per-message actions). */
  canWrite: boolean;
  /** Whether the current user may moderate (delete others' messages, pin, …). */
  canModerate: boolean;

  /**
   * Whether this transport's messages are unsigned rumors (Concord's sealed
   * chat events) rather than relay-addressable signed events. Drives the
   * per-message context menu: rumors offer "View event JSON" instead of the
   * "Copy message ID" / "View on Ditto" off-ramps (which reference a
   * relay-addressable event id that doesn't exist for a rumor).
   */
  isRumor?: boolean;

  // ── Optional capabilities (control hidden when undefined) ────────────────

  /**
   * Ids of messages that open a NEW key epoch (Concord): the timeline renders
   * a "key rotated" divider directly above each, marking everything earlier as
   * sealed under a previous key. Undefined for transports without rotations.
   */
  rotationDividerIds?: ReadonlySet<string>;

  /**
   * Ids of messages belonging to a visual flood (Concord, `floodCluster.ts`):
   * the timeline folds each consecutive run of them into one expandable row.
   *
   * A DISPLAY hint and nothing more. These messages are present, ordered and
   * readable — one click away — because the heuristic that produced them is
   * allowed to be wrong. Never filter on this, and never let it inform a
   * moderation decision: the Banlist is the only author-identity drop an honest
   * client performs. Undefined for transports without flood detection.
   */
  quarantinedIds?: ReadonlySet<string>;

  /**
   * The subset of {@link quarantinedIds} collapsed because the community is
   * PAUSED (CORD-04 §8), not because they looked like a flood. Purely so the
   * collapsed row can state the real reason — a paused room's ordinary traffic
   * is not "near-identical messages from many accounts", and saying so about it
   * is an accusation the client has no basis for.
   */
  pausedIds?: ReadonlySet<string>;

  /** Backfill older history; resolves to the number of messages prepended. */
  loadOlder?: () => Promise<number>;
  /** Whether more history remains to backfill. */
  hasMore?: boolean;
  /** Whether an older-history page is currently loading. */
  isLoadingOlder?: boolean;

  /** Optimistic send status for a message id (pending/failed), if tracked. */
  sendStatusFor?: (id: string) => SendStatus | undefined;
  /** Re-publish a failed optimistic message (retry). */
  retry?: (event: ChatMsg) => void;
  /** Drop a failed optimistic message (discard). */
  discard?: (id: string) => void;

  /** Delete a message (own always; others' require moderation). */
  deleteMessage?: (event: ChatMsg) => void;
  /** Submit an inline edit, returning when applied. */
  editMessage?: (original: ChatMsg, content: string) => Promise<void>;

  /** Whether a message id is pinned. */
  isPinned?: (id: string) => boolean;
  /** Pin/unpin a message (moderation). */
  togglePin?: (event: ChatMsg) => void;

  /** Threaded-reply count for a message id (drives the "N replies" badge). */
  replyCountFor?: (id: string) => number;
  /** Resolved reaction tallies + toggle for a message id (batched per room). */
  reactionsFor?: (id: string) => MessageReactions;
  /**
   * Aggregated zaps for a message id. Presence enables the zap button; the
   * payment itself runs in the shared dialog (it needs only the author's
   * lightning address), while this feeds the ⚡ total chip.
   */
  zapsFor?: (id: string) => MessageZaps | undefined;
  /**
   * Announce a settled zap payment for this message, for transports whose
   * announcement is a chat-plane event (Concord / CORD.md). When present,
   * the dialog REQUIRES a proof-returning payment method (NWC/WebLN — no
   * manual QR, which never reveals the preimage).
   */
  sendZap?: (target: ChatMsg, payment: ZapPayment) => Promise<void>;
  /**
   * Announce a settled on-chain Bitcoin zap for this message, for transports
   * whose announcement is a sealed chat-plane event (Concord). When
   * present, the on-chain zap hook seals the kind 8333 attribution rumor into
   * the channel instead of publishing a public Nostr event (which would leak
   * community/channel context). Absent = publish publicly via relays (NIP-29).
   */
  sendOnchainZap?: (target: ChatMsg, announcement: OnchainZapAnnouncement) => Promise<void>;

  /**
   * Resolved poll tally + vote callback for a poll (kind 1068) message id. Its
   * presence lets a poll render its live results and accept votes. NIP-29
   * carries polls through the relay-querying {@link import("./PollCard").PollCard}
   * instead, so it omits this; Concord supplies it from the sealed chat fold.
   */
  pollFor?: (id: string) => MessagePoll | undefined;
  /**
   * Resolved calendar event + RSVP state for a calendar (kind 31922/31923)
   * message id, so the row renders an inline event card. Both transports also
   * surface these events in the events bar; this is the timeline copy. NIP-29
   * resolves it from a relay query, Concord from the sealed chat fold.
   */
  calendarFor?: (id: string) => MessageCalendar | undefined;
  /**
   * Publish a new poll as a chat-plane event (Concord sealed rumor). Its
   * presence enables the composer's poll mode on the delegated send path. NIP-29
   * publishes polls directly to its host relay, so it omits this.
   */
  sendPoll?: (draft: PollDraft) => Promise<void>;

  /** Open the threaded-replies panel for a message. */
  openThread?: (event: ChatMsg, focusReply?: boolean) => void;

  /**
   * Pre-flight refusal for a send, checked before the composer clears itself:
   * a reason to block, or null to allow. Concord returns its per-community
   * rate-limit message here; transports without a send policy omit it.
   *
   * Call it exactly ONCE per send the user actually asked for: a refusal counts
   * against the sender (Concord escalates its lockout on repeat flooding), so
   * this is not a predicate to poll from render or to disable a button with.
   */
  canSend?: () => string | null;

  // ── Threading (Slack-style; shared ThreadPanel reads these) ──────────────
  //
  // A reply is NOT a top-level timeline message: it's nested under its root and
  // only shown in the thread panel. Every protocol implements these three the
  // same way — NIP-29 via kind-1111 comments, Concord via a parent-tagged
  // sealed chat message — so the shared {@link ThreadPanel} is transport-driven.

  /** Ascending (oldest-first) replies to a root message id. */
  threadRepliesFor?: (rootId: string) => ChatMsg[];
  /** Whether a root's replies are still loading (drives the panel spinner). */
  threadLoading?: (rootId: string) => boolean;
  /** Post a reply into a root's thread (content is the composer's final text). */
  sendThreadReply?: (root: ChatMsg, content: string, tags: string[][]) => Promise<void>;
}

/**
 * Derive the thread badge's summary from a root's replies: the distinct
 * repliers (newest-first, so the freshest voices lead the avatar stack) and the
 * most recent reply time. Shared by every per-message binding so the badge
 * reads identically across protocols.
 */
export function threadSummary(replies: ChatMsg[]): {
  participants: string[];
  lastReplyAt: number | undefined;
} {
  const seen = new Set<string>();
  const participants: string[] = [];
  let lastReplyAt: number | undefined;
  // Replies arrive oldest-first; walk newest-first for the stack order.
  for (let i = replies.length - 1; i >= 0; i--) {
    const r = replies[i];
    if (lastReplyAt === undefined) lastReplyAt = r.created_at;
    if (!seen.has(r.pubkey)) {
      seen.add(r.pubkey);
      participants.push(r.pubkey);
    }
  }
  return { participants, lastReplyAt };
}
