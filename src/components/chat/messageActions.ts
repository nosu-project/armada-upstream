import type { LucideIcon } from "lucide-react";

/**
 * One entry in a message's action list.
 *
 * The same array feeds all three surfaces that expose message actions — the
 * desktop overflow (`⋯`) dropdown, the right-click context menu, and the touch
 * long-press sheet — so a capability can't be offered in one and forgotten in
 * another (which is how the old hover toolbar and context menu drifted apart:
 * reactions were in one, not the other).
 */
export interface MessageActionItem {
  id: string;
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
  /** Rendered in the destructive style and, by convention, listed last. */
  destructive?: boolean;
  /** Starts a new visual group (a separator is drawn before it). */
  groupStart?: boolean;
}
