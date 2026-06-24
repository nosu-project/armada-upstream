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
 * The on-wire JSON shape of a Role. `permissions` is a u64 bitfield carried as a
 * DECIMAL STRING (JSON has no bigint, and a JS number loses precision past
 * 2^53), matching the rest of the protocol's bigint-as-string convention.
 */
interface RoleWire {
  roleId: string;
  name: string;
  position: number;
  permissions: string;
  scope: RoleScope;
  color: number;
}

/** Serialize a Role to its wire JSON (permissions → decimal string). */
export function roleToJSON(role: Role): string {
  const wire: RoleWire = { ...role, permissions: role.permissions.toString() };
  return JSON.stringify(wire);
}

/** Parse a Role from wire JSON, or undefined if malformed. */
export function roleFromJSON(json: string): Role | undefined {
  try {
    const w = JSON.parse(json) as RoleWire;
    if (typeof w.roleId !== "string" || typeof w.permissions !== "string") return undefined;
    return {
      roleId: w.roleId,
      name: typeof w.name === "string" ? w.name : "",
      position: typeof w.position === "number" ? w.position : Number.MAX_SAFE_INTEGER,
      permissions: BigInt(w.permissions),
      scope: w.scope?.kind === "channel" ? w.scope : { kind: "server" },
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
