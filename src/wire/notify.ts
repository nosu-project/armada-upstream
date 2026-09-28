import { firstImetaMime, isThreadReply } from "@/lib/notificationPreview";
import { dmConvKey, KIND_DM_CHAT, KIND_DM_FILE, type OpenedDm } from "@/lib/nip17/protocol";
import { chatRoute } from "@/lib/routes";

/**
 * Foreground-notification feed: ingest hands its freshly decoded events to
 * the notifier sink instead of the notifier re-reading stores (and racing
 * ingest's writes). One sink, registered by `useForegroundNotifications`
 * (web/desktop); no-op otherwise.
 */

/** A candidate the notifier may surface, normalized across planes. */
export interface NotifyCandidate {
  plane: "nip29" | "dm" | "c2";
  author: string;
  createdAt: number;
  /** Event `p`-tags the user (always implied for DMs). */
  mention: boolean;
  /** A kind-7 reaction `p`-tagging the user's own message. */
  reaction?: boolean;
  /** Normalized reaction emoji (`+`→👍, `-`→👎); only when `reaction`. */
  reactionEmoji?: string;
  /** The real event kind (NIP-29 kind, 4 for DM, decrypted rumor kind for c2). */
  kind: number;
  /** Plaintext when safely available; undefined for encrypted DMs. */
  body?: string;
  /** RAW content (untruncated); `body` has been through {@link preview}. Present wherever `body` is. */
  content?: string;
  /** The first `imeta` MIME, so a media-only message can name what it carries. */
  imetaMime?: string;
  /** Whether this is a reply inside a thread rather than to the room. */
  threadReply?: boolean;
  /**
   * Active-room key (activeRooms.ts shapes), possibly filled by the hook:
   * `h:<relayUrl>|<groupId>`, `c2:<channelIdHex>`, `dm:<conversationKey>`.
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
  /** DM conversation key (`plane === "dm"`); see `dmConvKey`. */
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
    // Keyed by CONVERSATION, so group messages suppress/mark read as the group.
    const conversation = dmConvKey(dm.peers);
    return [{
      plane: "dm" as const,
      author: dm.author,
      createdAt: dm.createdAt,
      mention: true,
      kind: dm.kind,
      body: dm.kind === KIND_DM_FILE ? "Sent a file" : dm.content,
      content: dm.content,
      imetaMime: firstImetaMime(dm.tags),
      threadReply: isThreadReply(dm.kind, dm.tags),
      roomKey: `dm:${conversation}`,
      readKey: `dm:${conversation}`,
      path: chatRoute({ kind: "dm", peer: conversation, messageId: dm.rumorId }),
      peer: conversation,
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
    // the notifier must never break ingest
  }
}
