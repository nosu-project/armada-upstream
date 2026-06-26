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
import type { NostrEvent } from "@nostrify/nostrify";

export type { ReactInput, ReactionTally, SendStatus };

/**
 * A chat message in the shared `NostrEvent` shape. NIP-29 messages already are
 * `NostrEvent`s (kind 9 / 1068); Concord messages are adapted from a decrypted
 * `OpenedMessage` into this shape (`openedToEvent`). Rendering never re-verifies
 * the signature, so a synthetic `sig: ""` is acceptable for adapted messages.
 */
export type ChatMsg = NostrEvent;

/**
 * Per-message reaction state + toggle, resolved by the transport for one
 * message. Mirrors the return shape of {@link useReactions} so the shared
 * `ReactionBar`/`ReactionPicker` consume it unchanged.
 */
export interface MessageReactions {
  tallies: ReactionTally[];
  react: (input: ReactInput) => void;
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

  // ── Optional capabilities (control hidden when undefined) ────────────────

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
  /** Open the threaded-replies panel for a message. */
  openThread?: (event: ChatMsg, focusReply?: boolean) => void;
}
