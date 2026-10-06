import { createContext, useContext } from "react";
import { Link } from "lucide-react";

import type { MessageActionItem } from "@/components/chat/messageActions";
import { writeClipboardText } from "@/lib/clipboard";

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

const COPYABLE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/**
 * "Copy link" for the anchor a right-click landed in, or null. Relative and
 * app-origin hrefs are skipped unless the anchor names its sent URL in
 * `data-copy-url` (in-app links route to a path).
 */
export function linkActionsAt(target: EventTarget | null): MessageActionItem[] | null {
  if (!(target instanceof Element)) return null;
  const anchor = target.closest<HTMLElement>("a[href], [data-copy-url]");
  if (!anchor) return null;
  const raw = anchor.dataset.copyUrl ?? anchor.getAttribute("href") ?? "";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!COPYABLE_PROTOCOLS.has(url.protocol)) return null;
  const text = url.protocol === "mailto:" ? raw.slice("mailto:".length) : raw;
  return [{
    id: "copy-link-target",
    label: url.protocol === "mailto:" ? "Copy email address" : "Copy link",
    icon: Link,
    onSelect: () => writeClipboardText(text).catch(() => undefined),
  }];
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
