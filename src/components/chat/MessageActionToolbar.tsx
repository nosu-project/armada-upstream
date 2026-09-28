import { MessageOverflowMenu } from "@/components/chat/MessageOverflowMenu";
import { ReactionActions } from "@/components/chat/ReactionBar";
import { ZapButton } from "@/components/chat/ZapButton";

import type { MessageActionItem } from "@/components/chat/messageActions";
import type { MessageReactions } from "@/components/chat/transport";
import type { ReactNode } from "react";

/**
 * Desktop hover action strip shared by {@link ChatMessage} and `ThreadMessage`
 * so they can't drift apart. Positioning stays with each caller.
 */
export function MessageActionToolbar({
  reactions,
  reactionQuickSlots,
  zap,
  overflowActions,
  children,
}: {
  /** Omit to hide (no membership, or editing). */
  reactions?: MessageReactions;
  /** Pass 0 in cramped surfaces. */
  reactionQuickSlots?: number;
  /** Omit to hide (own message, or no zaps). */
  zap?: { onOpen: () => void };
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
