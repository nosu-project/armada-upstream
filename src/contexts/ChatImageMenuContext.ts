import { createContext, useContext } from "react";

import type { MessageActionItem } from "@/components/chat/messageActions";

/**
 * How a message image reaches the row's action surfaces: the image hands its own
 * actions (open/save/share, with its decrypted source) UP to the row's single
 * sheet/context menu, which prepends them to the message's — one combined menu.
 */
export interface ChatImageMenu {
  isTouch: boolean;
  /** Touch long-press: open the action sheet with `imageActions` prepended. */
  openSheet: (imageActions: MessageActionItem[]) => void;
  /** Right-click: stage `imageActions` for the row's context menu. */
  stage: (imageActions: MessageActionItem[]) => void;
}

export const ChatImageMenuContext = createContext<ChatImageMenu | null>(null);

/** The ambient image menu, or null outside a message row. */
export function useChatImageMenu(): ChatImageMenu | null {
  return useContext(ChatImageMenuContext);
}

/** Combine image and message actions with a separator; unchanged when there are no image actions. */
export function withImageActions(
  imageActions: MessageActionItem[] | null,
  messageActions: MessageActionItem[],
): MessageActionItem[] {
  if (!imageActions || imageActions.length === 0) return messageActions;
  // Start a new group so a rule separates the two blocks.
  const rest = messageActions.map((a, i) => (i === 0 ? { ...a, groupStart: true } : a));
  return [...imageActions, ...rest];
}
