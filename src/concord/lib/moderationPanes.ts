import { Ban, Flag, Link as LinkIcon, ScrollText, Shield, Users } from "lucide-react";

import type { PillTab } from "@/components/ui/pill-tabs";
import { t } from "@/i18n/intl";

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

/** Each pane's icon + name (formatted on read), shared by the tab strip and page header. */
export const MODERATION_TABS: Readonly<Record<ModerationPane, PillTab<ModerationPane>>> = {
  members: {
    id: "members",
    icon: Users,
    get label() {
      return t({ id: "moderationPanes.members", defaultMessage: "Members" });
    },
  },
  roles: {
    id: "roles",
    icon: Shield,
    get label() {
      return t({ id: "moderationPanes.roles", defaultMessage: "Roles" });
    },
  },
  invites: {
    id: "invites",
    icon: LinkIcon,
    get label() {
      return t({ id: "moderationPanes.invites", defaultMessage: "Invite links" });
    },
  },
  banned: {
    id: "banned",
    icon: Ban,
    get label() {
      return t({ id: "moderationPanes.banned", defaultMessage: "Banned" });
    },
  },
  reports: {
    id: "reports",
    icon: Flag,
    get label() {
      return t({ id: "moderationPanes.reports", defaultMessage: "Reports" });
    },
  },
  audit: {
    id: "audit",
    icon: ScrollText,
    get label() {
      return t({ id: "moderationPanes.audit", defaultMessage: "Audit log" });
    },
  },
};

/**
 * Where "Moderation" lands: the first tab this viewer may open (ordered so
 * moderators land on members, not the log).
 */
export function firstModerationPane(access: ModerationAccess): ModerationPane | undefined {
  return MODERATION_PANES.find((pane) => access[pane]);
}
