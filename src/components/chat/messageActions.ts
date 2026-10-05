import type { LucideIcon } from "lucide-react";

/**
 * One message action. The same array feeds the `⋯` dropdown, right-click menu
 * and touch sheet so they can't drift apart.
 */
export interface MessageActionItem {
  id: string;
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
  /** Destructive style; listed last by convention. */
  destructive?: boolean;
  disabled?: boolean;
  /** Draws a separator before it. */
  groupStart?: boolean;
  /** Hide/block/report/delete/kick/ban: listed behind the moderation section. */
  moderation?: boolean;
}
