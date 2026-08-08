import { KIND_DM_CHAT, KIND_DM_FILE, type OpenedDm } from "@/lib/nip17/protocol";
import { chatRoute } from "@/lib/routes";

/**
 * Foreground-notification feed.
 *
 * The wire's ingest ({@link ingestWireEvents}) is the single choke point every
 * live event flows through — once, on every transport (web socket, APK drain,
 * APK live feed). Rather than have the page's foreground notifier re-read the
 * stores and re-derive "what's new" (racing the very writes ingest just made),
 * ingest hands the notifier the events it just decoded, in-memory and fully
 * decrypted, and the notifier decides what (if anything) to surface.
 *
 * A single sink is registered by `useForegroundNotifications` (web/desktop
 * only). Native has its own background service and does not register. When no
 * sink is registered these are cheap no-ops, so ingest never branches on it.
 */

/** A candidate the notifier may surface, normalized across planes. */
export interface NotifyCandidate {
  /** Which plane the message arrived on. */
  plane: "nip29" | "dm" | "c2";
  /** Author pubkey (hex). */
  author: string;
  /** Unix seconds the message was created. */
  createdAt: number;
  /**
   * Whether this event `p`-tags the current user (a mention). DMs are always
   * treated as directed at the user, so this is irrelevant there.
   */
  mention: boolean;
  /**
   * Whether this is a reaction (kind 7) to one of the current user's own
   * messages. Only ever set for a reaction that `p`-tags the user; a reaction
   * to someone else's message is never a candidate. Shapes the notification as
   * "reacted to your message" and gates on the `reactions` pref / level.
   */
  reaction?: boolean;
  /**
   * The reaction emoji / shortcode (normalized: `+`→👍, `-`→👎), for the
   * "Reacted X to your message" body. Set only when `reaction` is true.
   */
  reactionEmoji?: string;
  /** The real event kind (NIP-29 kind, 4 for DM, decrypted rumor kind for c2). */
  kind: number;
  /**
   * Plaintext body when safely available (NIP-29 chat, decrypted c2 rumor).
   * Undefined for encrypted DMs.
   */
  body?: string;
  /**
   * The active-room key for the conversation this belongs to (matches the
   * shapes in activeRooms.ts), so the notifier can suppress an on-screen room.
   * Some planes leave this for the notifier hook to fill in once it resolves
   * the relay/community the event belongs to:
   *   - NIP-29 group: `h:<relayUrl>|<groupId>`
   *   - Concord:   `c2:<channelIdHex>`
   *   - DM:           `dm:<peerPubkey>`
   */
  roomKey: string;
  /** The read-state key (matches useReadState key shapes) for unread gating. */
  readKey: string;
  /** In-app router path a tap should navigate to (may be filled by the hook). */
  path: string;
  /** NIP-29 relay URL (for mute gating); set only for `plane === "nip29"`. */
  relayUrl?: string;
  /** NIP-29 group id (for mute gating); set only for `plane === "nip29"`. */
  groupId?: string;
  /** Concord channel id hex; set only for `plane === "c2"`. */
  channelIdHex?: string;
  /** DM peer pubkey; set only for `plane === "dm"`. */
  peer?: string;
  /** Git activity details, when this is a repository event routed into a C2 channel. */
  git?: { action: string; repository: string; ticketId?: string; ticketTitle?: string };
  /** Stable source event id, used to dedupe distinct same-second Git activity. */
  eventId?: string;
}

export type NotifySink = (candidates: NotifyCandidate[]) => void;

/**
 * Convert freshly decrypted NIP-17 messages into the same foreground feed as
 * legacy DMs. Self-copies and non-message rumors stay silent.
 */
export function dm17NotifyCandidates(opened: OpenedDm[], self: string): NotifyCandidate[] {
  return opened.flatMap((dm) => {
    if (dm.author === self || (dm.kind !== KIND_DM_CHAT && dm.kind !== KIND_DM_FILE)) return [];
    return [{
      plane: "dm" as const,
      author: dm.author,
      createdAt: dm.createdAt,
      mention: true,
      kind: dm.kind,
      body: dm.kind === KIND_DM_FILE ? "Sent a file" : dm.content,
      roomKey: `dm:${dm.peer}`,
      readKey: `dm:${dm.peer}`,
      path: chatRoute({ kind: "dm", peer: dm.peer, messageId: dm.rumorId }),
      peer: dm.peer,
      eventId: dm.rumorId,
    }];
  });
}

let sink: NotifySink | undefined;

/** Register the foreground notifier's sink. Returns an unregister. */
export function registerNotifySink(next: NotifySink): () => void {
  sink = next;
  return () => {
    if (sink === next) sink = undefined;
  };
}

/** Feed candidates to the registered sink (no-op when none). */
export function feedNotifyCandidates(candidates: NotifyCandidate[]): void {
  if (!sink || candidates.length === 0) return;
  try {
    sink(candidates);
  } catch {
    // The notifier must never break ingest.
  }
}
