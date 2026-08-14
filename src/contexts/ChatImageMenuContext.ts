import { createContext, useContext } from "react";

import type { MessageActionItem } from "@/components/chat/messageActions";

/**
 * How a message image reaches the row's action surfaces.
 *
 * The image knows its OWN actions (open / save / share) because the resolved,
 * possibly-decrypted source only exists inside the image component — but the
 * reply/react/report actions belong to the surrounding message. Rather than
 * plumb that whole list (with its closures) down through the token renderer,
 * the image hands its own actions UP to the single sheet/context-menu the row
 * already renders, which prepends them to the message's. So a long-press or
 * right-click on an image opens one combined menu, and neither surface can
 * offer a capability the other forgets — the same invariant `messageActions`
 * documents for the message's own actions.
 */
export interface ChatImageMenu {
  isTouch: boolean;
  /**
   * Touch long-press: open the message action sheet with `imageActions`
   * prepended to the message's own.
   */
  openSheet: (imageActions: MessageActionItem[]) => void;
  /**
   * Desktop right-click: stage `imageActions` so the row's context menu —
   * which the same right-click also opens — shows them above the message's.
   */
  stage: (imageActions: MessageActionItem[]) => void;
}

export const ChatImageMenuContext = createContext<ChatImageMenu | null>(null);

/** The ambient image menu, or null outside a message row. */
export function useChatImageMenu(): ChatImageMenu | null {
  return useContext(ChatImageMenuContext);
}

/**
 * Combine an image's own actions with the message's, drawing a separator
 * between the two groups. Returns the message actions unchanged when there are
 * no image actions (a long-press on text, or a right-click away from any
 * image), so a plain message menu is untouched.
 */
export function withImageActions(
  imageActions: MessageActionItem[] | null,
  messageActions: MessageActionItem[],
): MessageActionItem[] {
  if (!imageActions || imageActions.length === 0) return messageActions;
  // The first message action starts a new group so the sheet/menu draws a rule
  // between the image block and the message block.
  const rest = messageActions.map((a, i) => (i === 0 ? { ...a, groupStart: true } : a));
  return [...imageActions, ...rest];
}
