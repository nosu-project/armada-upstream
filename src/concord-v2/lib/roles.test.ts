import { describe, expect, it } from "vitest";

import {
  byDisplayOrder,
  effectivePermissions,
  effectivePermissionsIn,
  isAuthorizedIn,
  Permissions,
  roleFromJSON,
  roleToJSON,
  type CommunityRoles,
  type Role,
} from "./roles";

const OWNER = "f".repeat(64);
const MOD = "a".repeat(64);
const CHANNEL = "1".repeat(64);
const OTHER_CHANNEL = "2".repeat(64);

const serverRole: Role = {
  roleId: "b".repeat(64),
  name: "Greeter",
  position: 5,
  permissions: Permissions.CREATE_INVITE,
  scope: { kind: "server" },
  color: 0,
};

const channelRole: Role = {
  roleId: "c".repeat(64),
  name: "Channel Mod",
  position: 4,
  permissions: Permissions.MANAGE_MESSAGES,
  scope: { kind: "channel", channelId: CHANNEL },
  color: 0,
};

const roster: CommunityRoles = {
  roles: [serverRole, channelRole],
  grants: [{ member: MOD, roleIds: [serverRole.roleId, channelRole.roleId] }],
};

describe("channel-scoped effective permissions (CORD-04 §2 scope)", () => {
  it("a channel-scoped role's bits count only inside its channel", () => {
    expect(effectivePermissionsIn(roster, MOD, CHANNEL)).toBe(
      Permissions.CREATE_INVITE | Permissions.MANAGE_MESSAGES,
    );
    expect(effectivePermissionsIn(roster, MOD, OTHER_CHANNEL)).toBe(Permissions.CREATE_INVITE);
  });

  it("server-scope roles count in every channel", () => {
    expect(effectivePermissionsIn(roster, MOD, OTHER_CHANNEL) & Permissions.CREATE_INVITE).toBe(
      Permissions.CREATE_INVITE,
    );
  });

  it("the scope-agnostic union is unchanged (the fold's view)", () => {
    expect(effectivePermissions(roster, MOD)).toBe(
      Permissions.CREATE_INVITE | Permissions.MANAGE_MESSAGES,
    );
  });

  it("isAuthorizedIn gates per channel; the owner is supreme everywhere", () => {
    expect(isAuthorizedIn(roster, MOD, OWNER, CHANNEL, Permissions.MANAGE_MESSAGES)).toBe(true);
    expect(isAuthorizedIn(roster, MOD, OWNER, OTHER_CHANNEL, Permissions.MANAGE_MESSAGES)).toBe(false);
    expect(isAuthorizedIn(roster, OWNER, OWNER, OTHER_CHANNEL, Permissions.MANAGE_MESSAGES)).toBe(true);
  });

  it("a roleless member holds nothing anywhere", () => {
    expect(effectivePermissionsIn(roster, "d".repeat(64), CHANNEL)).toBe(0n);
  });
});

describe("hoist flag wire format (Armada display extension)", () => {
  it("writes display only when true and round-trips it", () => {
    const plain = JSON.parse(roleToJSON(serverRole)) as Record<string, unknown>;
    expect("display" in plain).toBe(false);
    const hoisted = roleFromJSON(roleToJSON({ ...serverRole, display: true }));
    expect(hoisted?.display).toBe(true);
    // A non-boolean from a foreign writer reads as un-hoisted, never a throw.
    expect(roleFromJSON(JSON.stringify({ ...plain, display: "yes" }))?.display).toBeUndefined();
  });
});

describe("byDisplayOrder (CORD-04 §3 display rule)", () => {
  const role = (roleId: string, position: number): Role => ({
    roleId,
    name: roleId.slice(0, 4),
    position,
    permissions: 0n,
    scope: { kind: "server" },
    color: 0,
  });

  it("orders by position, lower first (lower position = higher authority)", () => {
    const sorted = [role("cc".repeat(32), 5), role("aa".repeat(32), 1)].sort(byDisplayOrder);
    expect(sorted.map((r) => r.position)).toEqual([1, 5]);
  });

  it("breaks a tie by the LOWER role_id, so every client renders one order", () => {
    // CORD-04 §3: "Two Roles MAY share a position — they are peers ... and a
    // display list breaks the tie by the lower role_id". Without it the order
    // is fold-insertion order, which differs per client and makes an
    // index-based reorder act on an arbitrary pair.
    const bb = role("bb".repeat(32), 2);
    const aa = role("aa".repeat(32), 2);
    expect([bb, aa].sort(byDisplayOrder).map((r) => r.roleId)).toEqual([aa.roleId, bb.roleId]);
    expect([aa, bb].sort(byDisplayOrder).map((r) => r.roleId)).toEqual([aa.roleId, bb.roleId]);
  });

  it("is a total order: sorting is stable whatever the input order", () => {
    const roles = [role("dd".repeat(32), 2), role("aa".repeat(32), 2), role("cc".repeat(32), 1)];
    const forward = [...roles].sort(byDisplayOrder).map((r) => r.roleId);
    const backward = [...roles].reverse().sort(byDisplayOrder).map((r) => r.roleId);
    expect(forward).toEqual(backward);
  });
});
