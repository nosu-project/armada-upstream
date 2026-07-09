import { describe, expect, it } from "vitest";

import {
  grantFromJSON,
  grantToJSON,
  Permissions,
  roleFromJSON,
  roleToJSON,
  type MemberGrant,
  type Role,
} from "./roles";

/**
 * Cross-wire parity with Vector's serde (`community/roles.rs`): a role/grant
 * authored by either client must deserialize on the other. The decrypted
 * control-plane content is the interop surface — snake_case field names,
 * integer permission bitfields, and the internally-tagged role scope.
 */
describe("role wire format (Vector serde parity)", () => {
  const role: Role = {
    roleId: "a".repeat(64),
    name: "Admin",
    position: 1,
    permissions: Permissions.KICK | Permissions.BAN | Permissions.MANAGE_ROLES,
    scope: { kind: "server" },
    color: 0,
  };

  it("serializes snake_case keys, a bare-integer permissions, and tagged scope", () => {
    const wire = JSON.parse(roleToJSON(role));
    expect(wire).toEqual({
      role_id: "a".repeat(64),
      name: "Admin",
      position: 1,
      permissions: 25, // KICK(8) | BAN(16) | MANAGE_ROLES(1)
      scope: { kind: "server" },
      color: 0,
    });
    // permissions MUST be a JSON number, not a string (Vector is #[serde(transparent)] u64).
    expect(typeof wire.permissions).toBe("number");
    expect(wire).not.toHaveProperty("roleId");
  });

  it("serializes a channel-scoped role as {kind, channel_id}", () => {
    const ch: Role = { ...role, scope: { kind: "channel", channelId: "f".repeat(64) } };
    const wire = JSON.parse(roleToJSON(ch));
    expect(wire.scope).toEqual({ kind: "channel", channel_id: "f".repeat(64) });
  });

  it("round-trips a role through to/from JSON", () => {
    expect(roleFromJSON(roleToJSON(role))).toEqual(role);
    const ch: Role = { ...role, scope: { kind: "channel", channelId: "f".repeat(64) } };
    expect(roleFromJSON(roleToJSON(ch))).toEqual(ch);
  });

  it("parses a Vector-authored role (snake_case, integer permissions)", () => {
    const vectorJson = JSON.stringify({
      role_id: "b".repeat(64),
      name: "Mod",
      position: 2,
      permissions: 32, // MANAGE_MESSAGES
      scope: { kind: "server" },
      color: 0,
    });
    const parsed = roleFromJSON(vectorJson);
    expect(parsed).toBeDefined();
    expect(parsed!.roleId).toBe("b".repeat(64));
    expect(parsed!.permissions).toBe(Permissions.MANAGE_MESSAGES);
    expect(parsed!.scope).toEqual({ kind: "server" });
  });

  it("rejects malformed role JSON", () => {
    expect(roleFromJSON("{}")).toBeUndefined();
    expect(roleFromJSON("not json")).toBeUndefined();
    // permissions absent → reject (can't infer authority)
    expect(roleFromJSON(JSON.stringify({ role_id: "c".repeat(64), name: "x" }))).toBeUndefined();
  });
});

describe("grant wire format (Vector serde parity)", () => {
  const grant: MemberGrant = { member: "d".repeat(64), roleIds: ["a".repeat(64), "b".repeat(64)] };

  it("serializes member + role_ids (snake_case)", () => {
    const wire = JSON.parse(grantToJSON(grant));
    expect(wire).toEqual({ member: "d".repeat(64), role_ids: ["a".repeat(64), "b".repeat(64)] });
    expect(wire).not.toHaveProperty("roleIds");
  });

  it("round-trips a grant", () => {
    expect(grantFromJSON(grantToJSON(grant))).toEqual(grant);
  });

  it("parses a Vector-authored grant and treats empty role_ids as a revoke", () => {
    expect(grantFromJSON(JSON.stringify({ member: "e".repeat(64), role_ids: ["a".repeat(64)] }))).toEqual({
      member: "e".repeat(64),
      roleIds: ["a".repeat(64)],
    });
    expect(grantFromJSON(JSON.stringify({ member: "e".repeat(64), role_ids: [] }))).toEqual({
      member: "e".repeat(64),
      roleIds: [],
    });
  });

  it("rejects malformed grant JSON", () => {
    expect(grantFromJSON("{}")).toBeUndefined();
    expect(grantFromJSON("nope")).toBeUndefined();
  });
});
