import { Ban, Flag, Link as LinkIcon, ScrollText, Shield, Users } from "lucide-react";

import type { PillTab } from "@/components/ui/pill-tabs";

/**
 * The panes the moderation panel holds, in tab order. Each is still its own
 * route (`/c/<id>/members`, `/c/<id>/roles`, …) — the panel is a tab strip over
 * six locations, not one location with local state — so a moderator can link
 * someone straight to the banlist, and the back button steps between tabs the
 * way it does between channels.
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
 * Which tabs this viewer may open. Every entry is a UI convenience: the fold
 * re-checks each permission when it judges an edition (CORD-04), so a tab
 * shown to someone who shouldn't have it costs a refused publish, not access.
 */
export type ModerationAccess = Readonly<Record<ModerationPane, boolean>>;

/**
 * Each pane's icon + name — the one spelling, so the tab strip and the page
 * header can't call the same place two different things.
 */
export const MODERATION_TABS: Readonly<Record<ModerationPane, PillTab<ModerationPane>>> = {
  members: { id: "members", label: "Members", icon: Users },
  roles: { id: "roles", label: "Roles", icon: Shield },
  invites: { id: "invites", label: "Invite links", icon: LinkIcon },
  banned: { id: "banned", label: "Banned", icon: Ban },
  reports: { id: "reports", label: "Reports", icon: Flag },
  audit: { id: "audit", label: "Audit log", icon: ScrollText },
};

/**
 * Where "Moderation" in the community menu lands: the first tab this viewer
 * may open. Never undefined in practice — the audit log and invite links are
 * open to every member — but ordered so a moderator arrives at the member list
 * rather than at the log.
 */
export function firstModerationPane(access: ModerationAccess): ModerationPane | undefined {
  return MODERATION_PANES.find((pane) => access[pane]);
}
