import { createContext, useContext } from "react";

/**
 * Tracks the chat composer element so floating UI (menus, popovers) flips above
 * it instead of overlapping. Each chat pane provides its own instance via
 * {@link ComposerBoundsProvider} (thread panel and main chat have separate composers).
 */
export type ComposerBoundsRef = React.RefObject<HTMLElement | null>;

const ComposerBoundsContext = createContext<ComposerBoundsRef>({ current: null });

export const ComposerBoundsProvider = ComposerBoundsContext.Provider;

export function useComposerBoundsRef(): ComposerBoundsRef {
  return useContext(ComposerBoundsContext);
}

/**
 * `collisionPadding` for Radix floating content: the composer's distance from the
 * viewport bottom, making its top edge the boundary. `undefined` when no composer.
 */
export function getComposerCollisionPadding(
  ref: ComposerBoundsRef,
): number | Partial<Record<"top" | "right" | "bottom" | "left", number>> | undefined {
  const el = ref.current;
  if (!el) return undefined;
  const rect = el.getBoundingClientRect();
  return { bottom: Math.max(0, window.innerHeight - rect.top) };
}
