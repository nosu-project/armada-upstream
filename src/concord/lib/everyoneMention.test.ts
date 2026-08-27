import { describe, expect, it } from "vitest";

import {
  canMentionEveryone,
  everyoneMentionAuthors,
  hasEveryoneMention,
  isEveryoneMention,
} from "@/concord/lib/everyoneMention";
import { Permissions, type CommunityRoles } from "@/concord/lib/roles";

const OWNER = "a".repeat(64);
const MOD = "b".repeat(64);
const MEMBER = "c".repeat(64);
const CHANNEL = "d".repeat(64);
const OTHER_CHANNEL = "e".repeat(64);

const roles: CommunityRoles = {
  roles: [
    {
      roleId: "mods",
      name: "Mods",
      position: 1,
      permissions: Permissions.MENTION_EVERYONE,
      scope: { kind: "channel", channelId: CHANNEL },
      color: 0,
    },
  ],
  grants: [
    { member: MOD, roleIds: ["mods"] },
    { member: MEMBER, roleIds: [] },
  ],
};

describe("Concord @everyone", () => {
  it("recognizes the interoperable literal without matching emails or longer handles", () => {
    expect(hasEveryoneMention("@everyone deploy now")).toBe(true);
    expect(hasEveryoneMention("Heads up, @everyone!")).toBe(true);
    expect(hasEveryoneMention("mail@everyone.example")).toBe(false);
    expect(hasEveryoneMention("@everyone_else")).toBe(false);
    expect(hasEveryoneMention("@everyone你")).toBe(false);
    expect(hasEveryoneMention("@Everyone")).toBe(false);
  });

  it("honors the owner and channel-scoped MENTION_EVERYONE grants", () => {
    expect(canMentionEveryone(roles, OWNER, OWNER, OTHER_CHANNEL)).toBe(true);
    expect(canMentionEveryone(roles, OWNER, MOD, CHANNEL)).toBe(true);
    expect(canMentionEveryone(roles, OWNER, MOD, OTHER_CHANNEL)).toBe(false);
    expect(canMentionEveryone(roles, OWNER, MEMBER, CHANNEL)).toBe(false);
    expect(isEveryoneMention("hi @everyone", roles, OWNER, MOD, CHANNEL)).toBe(true);
    expect(isEveryoneMention("hi @everyone", roles, OWNER, MOD, OTHER_CHANNEL)).toBe(false);
  });

  it("lists only authors authorized in at least one requested channel", () => {
    expect(everyoneMentionAuthors(roles, OWNER, [CHANNEL])).toEqual([OWNER, MOD]);
    expect(everyoneMentionAuthors(roles, OWNER, [OTHER_CHANNEL])).toEqual([OWNER]);
  });
});
