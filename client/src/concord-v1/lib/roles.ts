/**
 * Concord role graph — ported from Vector's `community/roles.rs`.
 *
 * Roles are data (not a hardcoded is_admin flag), enforcement is capability-based
 * (effective-permission bits + position). Access (read/post) is NOT a permission
 * — that's key possession (the two-mechanism split). Bit positions are FROZEN
 * wire format: append a reserved bit, never renumber or reuse.
 */

export const Permissions = {
  MANAGE_ROLES: 1n << 0n,
  MANAGE_CHANNELS: 1n << 1n,
  MANAGE_METADATA: 1n << 2n,
  KICK: 1n << 3n,
  BAN: 1n << 4n,
  MANAGE_MESSAGES: 1n << 5n,
  CREATE_INVITE: 1n << 6n,
  // 1<<7 RETIRED (was MANAGE_INVITES).
  VIEW_AUDIT_LOG: 1n << 8n,
  MENTION_EVERYONE: 1n << 9n,
  // Reserved: MANAGE_EMOJI=1<<10, PIN_MESSAGES=1<<11, MANAGE_EVENTS=1<<12.
} as const;

/** Every management bit currently defined — what the MVP "Admin" role holds. */
export const ADMIN_ALL =
  Permissions.MANAGE_ROLES |
  Permissions.MANAGE_CHANNELS |
  Permissions.MANAGE_METADATA |
  Permissions.KICK |
  Permissions.BAN |
  Permissions.MANAGE_MESSAGES |
  Permissions.CREATE_INVITE |
  Permissions.VIEW_AUDIT_LOG |
  Permissions.MENTION_EVERYONE;

/** Control-plane bits (every management bit except purely-social MENTION_EVERYONE). */
export const MANAGEMENT_MASK =
  Permissions.MANAGE_ROLES |
  Permissions.MANAGE_CHANNELS |
  Permissions.MANAGE_METADATA |
  Permissions.KICK |
  Permissions.BAN |
  Permissions.MANAGE_MESSAGES |
  Permissions.CREATE_INVITE |
  Permissions.VIEW_AUDIT_LOG;

export function permsContain(perms: bigint, bits: bigint): boolean {
  return (perms & bits) === bits;
}

/** Human-facing labels for the assignable permission bits, in display order. */
export const PERMISSION_LABELS: Array<{ bit: bigint; label: string; hint: string }> = [
  { bit: Permissions.MANAGE_ROLES, label: "Manage roles", hint: "Create roles and assign them to members." },
  { bit: Permissions.MANAGE_CHANNELS, label: "Manage channels", hint: "Create and rename channels." },
  { bit: Permissions.MANAGE_METADATA, label: "Manage community", hint: "Edit name, description, logo, banner." },
  { bit: Permissions.KICK, label: "Kick members", hint: "Remove members (they can rejoin via invite)." },
  { bit: Permissions.BAN, label: "Ban members", hint: "Ban members and rotate keys to lock them out." },
  { bit: Permissions.MANAGE_MESSAGES, label: "Manage messages", hint: "Hide other members' messages." },
  { bit: Permissions.CREATE_INVITE, label: "Create invites", hint: "Mint invite links and invite people." },
  { bit: Permissions.MENTION_EVERYONE, label: "Mention everyone", hint: "Use @everyone." },
];

export function isManagement(perms: bigint): boolean {
  return (perms & MANAGEMENT_MASK) !== 0n;
}

export type RoleScope = { kind: "server" } | { kind: "channel"; channelId: string };

export interface Role {
  roleId: string;
  name: string;
  /** Lower = higher authority. Owner is the implicit top (position 0, never a Role). */
  position: number;
  permissions: bigint;
  scope: RoleScope;
  color: number;
}

/** The MVP's auto-created server-scope Admin role: all management bits, position 1. */
export function adminRole(roleId: string): Role {
  return { roleId, name: "Admin", position: 1, permissions: ADMIN_ALL, scope: { kind: "server" }, color: 0 };
}

/**
 * The on-wire JSON shape of a Role — byte-compatible with Vector's serde
 * (`community/roles.rs`), so a role authored by either client deserializes on
 * the other. Field names are snake_case; `permissions` is a u64 bitfield
 * serialized as a BARE JSON NUMBER (Vector's `Permissions(u64)` is
 * `#[serde(transparent)]`). Permission bitfields stay well under 2^53, so a JS
 * number is lossless here; `scope` matches Vector's internally-tagged enum
 * (`{"kind":"server"}` / `{"kind":"channel","channel_id":"<hex>"}`).
 */
interface RoleWire {
  role_id: string;
  name: string;
  position: number;
  permissions: number;
  scope: { kind: "server" } | { kind: "channel"; channel_id: string };
  color: number;
}

/** Serialize a Role to its Vector-compatible wire JSON. */
export function roleToJSON(role: Role): string {
  const scope: RoleWire["scope"] =
    role.scope.kind === "channel" ? { kind: "channel", channel_id: role.scope.channelId } : { kind: "server" };
  const wire: RoleWire = {
    role_id: role.roleId,
    name: role.name,
    position: role.position,
    permissions: Number(role.permissions),
    scope,
    color: role.color,
  };
  return JSON.stringify(wire);
}

/** Parse a Role from Vector-compatible wire JSON, or undefined if malformed. */
export function roleFromJSON(json: string): Role | undefined {
  try {
    const w = JSON.parse(json) as RoleWire;
    if (typeof w.role_id !== "string") return undefined;
    // permissions: accept a bare number (Vector) or a decimal string (forward-compat).
    let permissions: bigint;
    if (typeof w.permissions === "number" && Number.isFinite(w.permissions)) permissions = BigInt(Math.trunc(w.permissions));
    else if (typeof w.permissions === "string" && /^\d+$/.test(w.permissions)) permissions = BigInt(w.permissions);
    else return undefined;
    const scope: RoleScope =
      w.scope?.kind === "channel" && typeof w.scope.channel_id === "string"
        ? { kind: "channel", channelId: w.scope.channel_id }
        : { kind: "server" };
    return {
      roleId: w.role_id,
      name: typeof w.name === "string" ? w.name : "",
      position: typeof w.position === "number" ? w.position : Number.MAX_SAFE_INTEGER,
      permissions,
      scope,
      color: typeof w.color === "number" ? w.color : 0,
    };
  } catch {
    return undefined;
  }
}

export interface MemberGrant {
  /** Grantee pubkey, lowercase hex. */
  member: string;
  roleIds: string[];
}

/**
 * Wire JSON for a MemberGrant — Vector-compatible serde (`member`, `role_ids`).
 * An empty `role_ids` is a revoke (folds to no roster entry).
 */
interface MemberGrantWire {
  member: string;
  role_ids: string[];
}

/** Serialize a MemberGrant to its Vector-compatible wire JSON. */
export function grantToJSON(grant: MemberGrant): string {
  const wire: MemberGrantWire = { member: grant.member, role_ids: grant.roleIds };
  return JSON.stringify(wire);
}

/** Parse a MemberGrant from Vector-compatible wire JSON, or undefined if malformed. */
export function grantFromJSON(json: string): MemberGrant | undefined {
  try {
    const w = JSON.parse(json) as MemberGrantWire;
    if (typeof w.member !== "string") return undefined;
    const roleIds = Array.isArray(w.role_ids) ? w.role_ids.filter((r): r is string => typeof r === "string") : [];
    return { member: w.member, roleIds };
  } catch {
    return undefined;
  }
}

/** The role graph a client aggregates from fetched per-entity RoleMetadata + Grant editions. */
export interface CommunityRoles {
  roles: Role[];
  grants: MemberGrant[];
}

export function emptyRoles(): CommunityRoles {
  return { roles: [], grants: [] };
}

export function role(roles: CommunityRoles, roleId: string): Role | undefined {
  return roles.roles.find((r) => r.roleId === roleId);
}

export function rolesOf(roles: CommunityRoles, memberHex: string): Role[] {
  const out: Role[] = [];
  for (const g of roles.grants) {
    if (g.member !== memberHex) continue;
    for (const rid of g.roleIds) {
      const r = role(roles, rid);
      if (r) out.push(r);
    }
  }
  return out;
}

export function effectivePermissions(roles: CommunityRoles, memberHex: string): bigint {
  return rolesOf(roles, memberHex).reduce((acc, r) => acc | r.permissions, 0n);
}

export function hasPermission(roles: CommunityRoles, memberHex: string, bits: bigint): boolean {
  return permsContain(effectivePermissions(roles, memberHex), bits);
}

/** Highest authority (lowest position) among the member's roles; undefined if none. */
export function highestPosition(roles: CommunityRoles, memberHex: string): number | undefined {
  const positions = rolesOf(roles, memberHex).map((r) => r.position);
  return positions.length ? Math.min(...positions) : undefined;
}

export function isAdmin(roles: CommunityRoles, memberHex: string): boolean {
  return rolesOf(roles, memberHex).some((r) => isManagement(r.permissions));
}

/** Owner is supreme; otherwise the actor must hold `permission`. */
export function isAuthorized(
  roles: CommunityRoles,
  actorHex: string,
  ownerHex: string | undefined,
  permission: bigint,
): boolean {
  if (ownerHex === actorHex) return true;
  return hasPermission(roles, actorHex, permission);
}

/** Does the actor STRICTLY outrank `targetPosition`? Owner outranks everything. */
export function outranks(
  roles: CommunityRoles,
  actorHex: string,
  ownerHex: string | undefined,
  targetPosition: number,
): boolean {
  if (ownerHex === actorHex) return true;
  const p = highestPosition(roles, actorHex);
  return p !== undefined && p < targetPosition;
}

/** May `actorHex` perform an action requiring `permission` against a target at `targetPosition`? */
export function canActOnPosition(
  roles: CommunityRoles,
  actorHex: string,
  ownerHex: string | undefined,
  targetPosition: number,
  permission: bigint,
): boolean {
  if (ownerHex === actorHex) return true;
  return hasPermission(roles, actorHex, permission) && outranks(roles, actorHex, ownerHex, targetPosition);
}

/** Generalized member-targeting authority test (ban/kick/hide/role-change). Owner is never a valid target. */
export function canActOnMember(
  roles: CommunityRoles,
  actorHex: string,
  ownerHex: string | undefined,
  targetHex: string,
  permission: bigint,
): boolean {
  if (ownerHex === targetHex) return false;
  const targetPosition = highestPosition(roles, targetHex) ?? Number.MAX_SAFE_INTEGER;
  return canActOnPosition(roles, actorHex, ownerHex, targetPosition, permission);
}
