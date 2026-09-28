import { Ban, Flag, Link as LinkIcon, ScrollText, Shield, Users } from "lucide-react";

import type { PillTab } from "@/components/ui/pill-tabs";

/**
 * Moderation panel panes, in tab order. Each is its own route (`/c/<id>/members`,
 * …) so panes are linkable and back steps between tabs.
 */
export const MODERATION_PANES = [
  "members",
  "roles",
  "invites",
  "banned",
  "reports",
  "audit",
] as const;

export type ModerationPane = (typeof MODERATION_PANES)[number];

export function isModerationPane(value: string): value is ModerationPane {
  return (MODERATION_PANES as readonly string[]).includes(value);
}

/**
 * Which tabs this viewer may open — UI only; the fold re-checks each permission
 * (CORD-04), so a wrongly shown tab just costs a refused publish.
 */
export type ModerationAccess = Readonly<Record<ModerationPane, boolean>>;

/** Each pane's icon + name, shared by the tab strip and page header. */
export const MODERATION_TABS: Readonly<Record<ModerationPane, PillTab<ModerationPane>>> = {
  members: { id: "members", label: "Members", icon: Users },
  roles: { id: "roles", label: "Roles", icon: Shield },
  invites: { id: "invites", label: "Invite links", icon: LinkIcon },
  banned: { id: "banned", label: "Banned", icon: Ban },
  reports: { id: "reports", label: "Reports", icon: Flag },
  audit: { id: "audit", label: "Audit log", icon: ScrollText },
};

/**
 * Where "Moderation" lands: the first tab this viewer may open (ordered so
 * moderators land on members, not the log).
 */
export function firstModerationPane(access: ModerationAccess): ModerationPane | undefined {
  return MODERATION_PANES.find((pane) => access[pane]);
}
