import { Crown, Shield, ShieldOff, UserMinus } from "lucide-react";

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
          title: "make admin?",
          icon: Crown,
          confirmLabel: "Make admin",
          consequences: [
            "They get every management permission: roles, channels, community settings, invites, pins, and kicking or banning members.",
            "They can promote, demote, kick and ban anyone ranked below them, including moderators.",
            "Only the owner can remove an admin.",
          ],
        };
      case "moderator":
        return {
          title: "make moderator?",
          icon: Shield,
          confirmLabel: "Make moderator",
          consequences: [
            "They can kick and ban members, hide other members' messages, and use @everyone.",
            "They can't change roles, channels or community settings.",
            "Admins and the owner can remove the role later.",
          ],
        };
      case "demote":
        return {
          title: "demote to moderator?",
          icon: Shield,
          confirmLabel: "Demote",
          consequences: [
            "They lose roles, channels, community settings and invites.",
            "They keep kicking, banning, hiding messages and @everyone.",
            "Only the owner can make them an admin again.",
          ],
        };
      case "remove":
        return {
          title: "remove staff role?",
          icon: ShieldOff,
          confirmLabel: "Remove role",
          consequences: [
            "They lose every permission this role gave them and become a regular member.",
            "Their membership, messages and any custom roles are unaffected.",
          ],
        };
    }
  }
  switch (change) {
    case "admin":
      return {
        title: "make admin?",
        icon: Crown,
        confirmLabel: "Make admin",
        consequences: [
          "Admins can add and remove members, change roles and edit this channel.",
          "Other admins can undo this. The relay decides exactly what admins may do.",
        ],
      };
    case "moderator":
      return {
        title: "make moderator?",
        icon: Shield,
        confirmLabel: "Make moderator",
        consequences: [
          "Moderators help manage this channel. The relay decides exactly what they may do.",
          "Admins can remove the role later.",
        ],
      };
    case "demote":
      return {
        title: "demote to moderator?",
        icon: Shield,
        confirmLabel: "Demote",
        consequences: [
          "They lose admin powers in this channel and keep moderator ones.",
          "Any admin can make them an admin again.",
        ],
      };
    case "remove":
      return {
        title: "remove staff role?",
        icon: ShieldOff,
        confirmLabel: "Remove role",
        consequences: [
          "They lose their admin or moderator powers and become a regular member.",
          "Their membership and messages are unaffected.",
        ],
      };
  }
}

/** NIP-29 removal: a relay write, not a cooperative kick. */
export const NIP29_REMOVE_CONFIRM: MemberActionConfirm = {
  title: "remove from channel?",
  icon: UserMinus,
  confirmLabel: "Remove",
  consequences: [
    "They leave the member list and can no longer post here.",
    "They can ask to join again unless the channel is closed.",
  ],
};
