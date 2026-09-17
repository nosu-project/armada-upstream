import { MessageOverflowMenu } from "@/components/chat/MessageOverflowMenu";
import { ReactionActions } from "@/components/chat/ReactionBar";
import { ZapButton } from "@/components/chat/ZapButton";

import type { MessageActionItem } from "@/components/chat/messageActions";
import type { MessageReactions } from "@/components/chat/transport";
import type { ReactNode } from "react";

/**
 * The desktop hover/tap action strip shared by every message row (the main
 * timeline's {@link ChatMessage} and the thread panel's `ThreadMessage`): the
 * reaction controls, the zap button, any surface-specific dedicated buttons
 * (thread/reply), then the `⋯` overflow for everything else.
 *
 * One component so the two surfaces can't drift apart — reactions living on one
 * strip but not the other is exactly the bug this consolidates away. The
 * positioning wrapper stays with each caller (the timeline floats it via
 * MessageRow; the narrow thread row anchors it), since only the contents are
 * common.
 */
export function MessageActionToolbar({
  reactions,
  reactionQuickSlots,
  zap,
  overflowActions,
  children,
}: {
  /** Reaction controls — omit to hide (no membership, or editing). */
  reactions?: MessageReactions;
  /** Quick-slot count for the reaction row; pass 0 in cramped surfaces. */
  reactionQuickSlots?: number;
  /** Zap button — omit to hide (own message, or surface has no zaps). */
  zap?: { onOpen: () => void };
  /** Everything not worth a dedicated button, shown under `⋯`. */
  overflowActions: MessageActionItem[];
  /** Dedicated buttons between zap and overflow (e.g. thread, reply). */
  children?: ReactNode;
}) {
  return (
    <>
      {reactions && (
        <ReactionActions
          onReact={reactions.react}
          tallies={reactions.tallies}
          quickSlots={reactionQuickSlots}
        />
      )}
      {zap && <ZapButton onOpen={zap.onOpen} />}
      {children}
      <MessageOverflowMenu actions={overflowActions} />
    </>
  );
}
