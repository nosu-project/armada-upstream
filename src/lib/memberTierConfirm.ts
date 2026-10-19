import { Crown, Shield, ShieldOff, UserMinus } from "lucide-react";

import { t } from "@/i18n";
import type { MemberActionConfirm } from "@/contexts/MemberActionsContext";

export type TierChange = "admin" | "moderator" | "demote" | "remove";

/**
 * What a staff-tier change does, for the confirm `useUserModeration` shows.
 * Concord's lines follow the stock roles (CORD-04 `adminRole`/`moderatorRole`)
 * and strict outrank; a NIP-29 relay decides its own role powers, so its lines
 * stay general.
 */
export function tierChangeConfirm(backend: "concord" | "nip29", change: TierChange): MemberActionConfirm {
  if (backend === "concord") {
    switch (change) {
      case "admin":
        return {
          title: t({ id: "memberTierConfirm.concord.admin.title", defaultMessage: "make admin?" }),
          icon: Crown,
          confirmLabel: t({ id: "memberTierConfirm.concord.admin.confirmLabel", defaultMessage: "Make admin" }),
          consequences: [
            t({ id: "memberTierConfirm.concord.admin.theyGetEveryManagementPermission", defaultMessage: "They get every management permission: roles, channels, community settings, invites, pins, and kicking or banning members." }),
            t({ id: "memberTierConfirm.concord.admin.theyCanPromoteDemoteKick", defaultMessage: "They can promote, demote, kick and ban anyone ranked below them, including moderators." }),
            t({ id: "memberTierConfirm.concord.admin.onlyTheOwnerCanRemove", defaultMessage: "Only the owner can remove an admin." }),
          ],
        };
      case "moderator":
        return {
          title: t({ id: "memberTierConfirm.concord.moderator.title", defaultMessage: "make moderator?" }),
          icon: Shield,
          confirmLabel: t({ id: "memberTierConfirm.concord.moderator.confirmLabel", defaultMessage: "Make moderator" }),
          consequences: [
            t({ id: "memberTierConfirm.concord.moderator.theyCanKickAndBan", defaultMessage: "They can kick and ban members, hide other members' messages, and use @everyone." }),
            t({ id: "memberTierConfirm.concord.moderator.theyCantChangeRolesChannels", defaultMessage: "They can't change roles, channels or community settings." }),
            t({ id: "memberTierConfirm.concord.moderator.adminsAndTheOwnerCan", defaultMessage: "Admins and the owner can remove the role later." }),
          ],
        };
      case "demote":
        return {
          title: t({ id: "memberTierConfirm.concord.demote.title", defaultMessage: "demote to moderator?" }),
          icon: Shield,
          confirmLabel: t({ id: "memberTierConfirm.concord.demote.confirmLabel", defaultMessage: "Demote" }),
          consequences: [
            t({ id: "memberTierConfirm.concord.demote.theyLoseRolesChannelsCommunity", defaultMessage: "They lose roles, channels, community settings and invites." }),
            t({ id: "memberTierConfirm.concord.demote.theyKeepKickingBanningHiding", defaultMessage: "They keep kicking, banning, hiding messages and @everyone." }),
            t({ id: "memberTierConfirm.concord.demote.onlyTheOwnerCanMake", defaultMessage: "Only the owner can make them an admin again." }),
          ],
        };
      case "remove":
        return {
          title: t({ id: "memberTierConfirm.concord.remove.title", defaultMessage: "remove staff role?" }),
          icon: ShieldOff,
          confirmLabel: t({ id: "memberTierConfirm.concord.remove.confirmLabel", defaultMessage: "Remove role" }),
          consequences: [
            t({ id: "memberTierConfirm.concord.remove.theyLoseEveryPermissionThis", defaultMessage: "They lose every permission this role gave them and become a regular member." }),
            t({ id: "memberTierConfirm.concord.remove.theirMembershipMessagesAndAny", defaultMessage: "Their membership, messages and any custom roles are unaffected." }),
          ],
        };
    }
  }
  switch (change) {
    case "admin":
      return {
        title: t({ id: "memberTierConfirm.nip29.admin.title", defaultMessage: "make admin?" }),
        icon: Crown,
        confirmLabel: t({ id: "memberTierConfirm.nip29.admin.confirmLabel", defaultMessage: "Make admin" }),
        consequences: [
          t({ id: "memberTierConfirm.nip29.admin.adminsCanAddAndRemove", defaultMessage: "Admins can add and remove members, change roles and edit this channel." }),
          t({ id: "memberTierConfirm.nip29.admin.otherAdminsCanUndoThis", defaultMessage: "Other admins can undo this. The relay decides exactly what admins may do." }),
        ],
      };
    case "moderator":
      return {
        title: t({ id: "memberTierConfirm.nip29.moderator.title", defaultMessage: "make moderator?" }),
        icon: Shield,
        confirmLabel: t({ id: "memberTierConfirm.nip29.moderator.confirmLabel", defaultMessage: "Make moderator" }),
        consequences: [
          t({ id: "memberTierConfirm.nip29.moderator.moderatorsHelpManageThisChannel", defaultMessage: "Moderators help manage this channel. The relay decides exactly what they may do." }),
          t({ id: "memberTierConfirm.nip29.moderator.adminsCanRemoveTheRole", defaultMessage: "Admins can remove the role later." }),
        ],
      };
    case "demote":
      return {
        title: t({ id: "memberTierConfirm.nip29.demote.title", defaultMessage: "demote to moderator?" }),
        icon: Shield,
        confirmLabel: t({ id: "memberTierConfirm.nip29.demote.confirmLabel", defaultMessage: "Demote" }),
        consequences: [
          t({ id: "memberTierConfirm.nip29.demote.theyLoseAdminPowersIn", defaultMessage: "They lose admin powers in this channel and keep moderator ones." }),
          t({ id: "memberTierConfirm.nip29.demote.anyAdminCanMakeThem", defaultMessage: "Any admin can make them an admin again." }),
        ],
      };
    case "remove":
      return {
        title: t({ id: "memberTierConfirm.nip29.remove.title", defaultMessage: "remove staff role?" }),
        icon: ShieldOff,
        confirmLabel: t({ id: "memberTierConfirm.nip29.remove.confirmLabel", defaultMessage: "Remove role" }),
        consequences: [
          t({ id: "memberTierConfirm.nip29.remove.theyLoseTheirAdminOr", defaultMessage: "They lose their admin or moderator powers and become a regular member." }),
          t({ id: "memberTierConfirm.nip29.remove.theirMembershipAndMessagesAre", defaultMessage: "Their membership and messages are unaffected." }),
        ],
      };
  }
}

/** NIP-29 removal: a relay write, not a cooperative kick. Getters, so the text follows the language. */
export const NIP29_REMOVE_CONFIRM: MemberActionConfirm = {
  get title() {
    return t({ id: "memberTierConfirm.nip29.kick.title", defaultMessage: "remove from channel?" });
  },
  icon: UserMinus,
  get confirmLabel() {
    return t({ id: "memberTierConfirm.nip29.kick.confirmLabel", defaultMessage: "Remove" });
  },
  get consequences() {
    return [
      t({ id: "memberTierConfirm.nip29.kick.theyLeaveTheMemberList", defaultMessage: "They leave the member list and can no longer post here." }),
      t({ id: "memberTierConfirm.nip29.kick.theyCanAskToJoin", defaultMessage: "They can ask to join again unless the channel is closed." }),
    ];
  },
};
