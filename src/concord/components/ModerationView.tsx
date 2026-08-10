import { PillTabs } from "@/components/ui/pill-tabs";
import { AuditLogView } from "@/concord/components/AuditLogView";
import { BannedView } from "@/concord/components/BannedView";
import { InvitesView } from "@/concord/components/InvitesView";
import { MembersView } from "@/concord/components/MembersView";
import { ReportsView } from "@/concord/components/ReportsView";
import { RolesView } from "@/concord/components/RolesView";
import {
  MODERATION_PANES,
  MODERATION_TABS,
  type ModerationAccess,
  type ModerationPane,
} from "@/concord/lib/moderationPanes";
import type { Community } from "@/concord/lib/types";

/**
 * The moderation panel: members, roles, invite links, the banlist, reports and
 * the audit log, folded into one surface with a tab strip rather than six
 * entries in the community menu.
 *
 * A pane the viewer may not open is stated rather than silently swapped for
 * another — the URL names a place, and answering with a different one would
 * make the address bar lie.
 */
export function ModerationView({
  community,
  pane,
  access,
  memberPubkeys,
  canModerateMembers,
  onSelect,
}: {
  community: Community;
  pane: ModerationPane;
  access: ModerationAccess;
  memberPubkeys: string[];
  /** Kick/ban affordances inside the member list. */
  canModerateMembers: boolean;
  onSelect: (pane: ModerationPane) => void;
}) {
  const tabs = MODERATION_PANES.filter((p) => access[p]).map((p) => MODERATION_TABS[p]);

  return (
    <div className="flex flex-col">
      <div className="mx-auto flex w-full max-w-2xl px-4 pt-4">
        <PillTabs tabs={tabs} value={pane} onChange={onSelect} />
      </div>
      {!access[pane] ? (
        <p className="mx-auto w-full max-w-2xl p-4 text-sm text-muted-foreground">
          You don't have permission to see this.
        </p>
      ) : pane === "members" ? (
        <MembersView
          community={community}
          memberPubkeys={memberPubkeys}
          canModerate={canModerateMembers}
        />
      ) : pane === "roles" ? (
        <RolesView community={community} />
      ) : pane === "invites" ? (
        <InvitesView community={community} />
      ) : pane === "banned" ? (
        <BannedView community={community} />
      ) : pane === "reports" ? (
        <ReportsView community={community} />
      ) : (
        <AuditLogView community={community} />
      )}
    </div>
  );
}
