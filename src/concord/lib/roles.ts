/**
 * Concord roles & permissions — CORD-04.
 *
 * READ access is key possession; WRITE authority is rank in the owner-rooted
 * Roster. Bit positions are FROZEN wire format. `permissions` is written as a
 * DECIMAL STRING (JSON numbers lose precision past 2^53); either form is read.
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
  PIN_MESSAGES: 1n << 11n,
  // Reserved: MANAGE_EMOJI=1<<10, MANAGE_EVENTS=1<<12.
} as const;

/**
 * Every currently-defined management bit (an "Admin" role). No all-powerful bit:
 * new permissions aren't inherited (CORD-04 §3).
 */
export const ADMIN_ALL =
  Permissions.MANAGE_ROLES |
  Permissions.MANAGE_CHANNELS |
  Permissions.MANAGE_METADATA |
  Permissions.KICK |
  Permissions.BAN |
  Permissions.MANAGE_MESSAGES |
  Permissions.CREATE_INVITE |
  Permissions.VIEW_AUDIT_LOG |
  Permissions.MENTION_EVERYONE |
  Permissions.PIN_MESSAGES;

/** Management bits (everything but the purely-social MENTION_EVERYONE). */
export const MANAGEMENT_MASK = ADMIN_ALL & ~Permissions.MENTION_EVERYONE;

/**
 * STAFF bits (CORD-04 §3): permissions whose actions are Control Plane editions.
 * Holders (and the owner) get the `control_root` write key (CORD-02 §2).
 */
export const STAFF_MASK =
  Permissions.MANAGE_ROLES |
  Permissions.MANAGE_CHANNELS |
  Permissions.MANAGE_METADATA |
  Permissions.BAN |
  Permissions.CREATE_INVITE |
  Permissions.PIN_MESSAGES;

/** Protocol-wide name cap: 64 bytes of UTF-8 (roles, channels, community name). */
export const NAME_MAX_BYTES = 64;
/** A member holds at most 64 Roles; a Community carries at most 100 (CORD-04 §2). */
export const MAX_ROLES_PER_MEMBER = 64;
export const MAX_ROLES_PER_COMMUNITY = 100;

export function permsContain(perms: bigint, bits: bigint): boolean {
  return (perms & bits) === bits;
}

export function isManagement(perms: bigint): boolean {
  return (perms & MANAGEMENT_MASK) !== 0n;
}

/** Human-facing labels for the assignable permission bits, in display order. */
export const PERMISSION_LABELS: Array<{ bit: bigint; label: string; hint: string }> = [
  { bit: Permissions.MANAGE_ROLES, label: "Manage roles", hint: "Create roles and assign them to members." },
  { bit: Permissions.MANAGE_CHANNELS, label: "Manage channels", hint: "Create, rename, and delete channels." },
  { bit: Permissions.MANAGE_METADATA, label: "Manage community", hint: "Edit name, description, logo, banner." },
  { bit: Permissions.KICK, label: "Kick members", hint: "Remove members (they can rejoin via invite)." },
  { bit: Permissions.BAN, label: "Ban members", hint: "Ban members and rotate keys to lock them out." },
  { bit: Permissions.MANAGE_MESSAGES, label: "Manage messages", hint: "Hide other members' messages." },
  { bit: Permissions.PIN_MESSAGES, label: "Pin messages", hint: "Pin messages so everyone sees them, including members who join later." },
  { bit: Permissions.CREATE_INVITE, label: "Create invites", hint: "Mint public invite links." },
  { bit: Permissions.MENTION_EVERYONE, label: "Mention everyone", hint: "Use @everyone." },
];

export type RoleScope = { kind: "server" } | { kind: "channel"; channelId: string };

export interface Role {
  roleId: string;
  name: string;
  /** Lower = higher authority. The owner is the implicit position 0, never a Role. */
  position: number;
  permissions: bigint;
  scope: RoleScope;
  /** Cosmetic badge tint; 0 = theme default. */
  color: number;
  /**
   * Hoist into its own member-list section. Armada extension, written only when
   * true; absent on the CORD-04 baseline.
   */
  display?: boolean;
}

/**
 * CORD-04 §3 display order: `position` ascending, ties by lower `role_id`. The
 * tiebreak matters: peers would otherwise order by fold insertion, differing
 * between clients and breaking index-based reorders.
 */
export function byDisplayOrder(a: Role, b: Role): number {
  return a.position - b.position || a.roleId.localeCompare(b.roleId);
}

/** A stock server-scope Admin role: all current management bits, position 1. */
export function adminRole(roleId: string): Role {
  return { roleId, name: "Admin", position: 1, permissions: ADMIN_ALL, scope: { kind: "server" }, color: 0 };
}

/** The moderation bits a stock Moderator holds (people + message management). */
export const MODERATOR_ALL =
  Permissions.KICK | Permissions.BAN | Permissions.MANAGE_MESSAGES | Permissions.MENTION_EVERYONE;

/**
 * A stock Moderator role at position 2, below Admin (1) so Admins may grant it
 * (CORD-04 §3).
 */
export function moderatorRole(roleId: string): Role {
  return { roleId, name: "Moderator", position: 2, permissions: MODERATOR_ALL, scope: { kind: "server" }, color: 0 };
}

// Wire JSON (CORD-04 §2)
interface RoleWire {
  role_id: string;
  name: string;
  position: number;
  /** Decimal string on write; a bare number from an older edition is accepted. */
  permissions: string | number;
  scope: { kind: "server" } | { kind: "channel"; channel_id: string };
  color: number;
  /** Armada hoist extension — present only when true (see {@link Role.display}). */
  display?: boolean;
}

/**
 * Coerce wire `color` to u32 (CORD-04 §2): out-of-range becomes theme default,
 * in-range floats truncate. Stops malformed values round-tripping.
 */
function clampColor(color: unknown): number {
  if (typeof color !== "number" || !Number.isFinite(color)) return 0;
  if (color < 0 || color > 0xffffffff) return 0;
  return Math.trunc(color);
}

export function roleToJSON(role: Role): string {
  const scope: RoleWire["scope"] =
    role.scope.kind === "channel" ? { kind: "channel", channel_id: role.scope.channelId } : { kind: "server" };
  const wire: RoleWire = {
    role_id: role.roleId,
    name: role.name,
    position: role.position,
    permissions: role.permissions.toString(), // always the string form
    scope,
    color: clampColor(role.color),
    ...(role.display === true ? { display: true } : {}),
  };
  return JSON.stringify(wire);
}

export function roleFromJSON(json: string): Role | undefined {
  try {
    const w = JSON.parse(json) as RoleWire;
    if (typeof w.role_id !== "string" || !/^[0-9a-f]{64}$/i.test(w.role_id)) return undefined;
    let permissions: bigint;
    if (typeof w.permissions === "string" && /^\d+$/.test(w.permissions)) permissions = BigInt(w.permissions);
    else if (typeof w.permissions === "number" && Number.isFinite(w.permissions)) permissions = BigInt(Math.trunc(w.permissions));
    else return undefined;
    if (typeof w.position !== "number" || !Number.isInteger(w.position) || w.position < 1) {
      // Position 0 is the owner's alone (CORD-04 §3); others are malformed.
      return undefined;
    }
    const name = typeof w.name === "string" ? w.name : "";
    if (new TextEncoder().encode(name).length > NAME_MAX_BYTES) return undefined;
    const scope: RoleScope =
      w.scope?.kind === "channel" && typeof w.scope.channel_id === "string"
        ? { kind: "channel", channelId: w.scope.channel_id }
        : { kind: "server" };
    return {
      roleId: w.role_id.toLowerCase(),
      name,
      position: w.position,
      permissions,
      scope,
      color: clampColor(w.color),
      ...(w.display === true ? { display: true } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * Wire `color` is packed 0xRRGGBB in a u32; 0 = theme default (so pure black is
 * untintable). Returns undefined for 0. Only 24-bit RGB here, so editing a
 * foreign role's colour drops its high byte (roleFromJSON/roleToJSON keep it).
 */
export function colorToHex(color: number): string | undefined {
  if (!Number.isFinite(color)) return undefined;
  const rgb = Math.trunc(color) & 0xffffff;
  if (rgb === 0) return undefined;
  return `#${rgb.toString(16).padStart(6, "0")}`;
}

/** `#RRGGBB` → the packed u32 the wire wants. Unparseable input is theme default (0). */
export function hexToColor(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  return m ? parseInt(m[1], 16) : 0;
}

/**
 * Where a reorder would land: reuses the existing `position` multiset in the
 * requested order (renumbering 1..N would claim position 1, which only the owner
 * may write). Peers can't be separated this way, so compare `rendered` against
 * the request BEFORE publishing. `current` sorted by {@link byDisplayOrder}.
 */
export function projectReorder(current: Role[], next: Role[]): { landing: Role[]; rendered: Role[] } {
  const positions = current.map((r) => r.position);
  const landing = next.map((role, i) => ({ ...role, position: positions[i] }));
  return { landing, rendered: [...landing].sort(byDisplayOrder) };
}

/**
 * Give every Role its own `position` in the requested order — the escape when
 * peers make a roster unreorderable via {@link projectReorder} (e.g. after a
 * partial reorder). Position-on-role is the spec's own mechanism (CORD-04 §3).
 *
 * `floor` = lowest position the actor may claim (rank + 1, or 1 for the owner).
 * Roles above it stay put and must lead `next`, else null. Numbering starts at
 * the movable roles' lowest position so repeated normalizing doesn't inflate.
 */
export function normalizeOrder(next: Role[], floor: number): Role[] | null {
  const fixed = next.filter((r) => r.position < floor);
  // Untouchable roles must already occupy the leading slots.
  const lead = next.slice(0, fixed.length);
  if (lead.some((r) => r.position >= floor)) return null;
  if ([...lead].sort(byDisplayOrder).some((r, i) => r.roleId !== lead[i].roleId)) return null;

  const movable = next.slice(fixed.length);
  if (movable.length === 0) return null; // nothing this actor may rewrite
  const base = Math.min(...movable.map((r) => r.position));
  return [...lead, ...movable.map((role, i) => ({ ...role, position: base + i }))];
}

export interface MemberGrant {
  /** Grantee pubkey, lowercase hex. */
  member: string;
  roleIds: string[];
  /**
   * Staff write key riding the Grant (CORD-04 §3): `epoch_be[8] ‖ control_root[32]`
   * NIP-44 under the granter↔member pairwise key, base64. Delivery, never
   * authority; adopted only if it derives to the held `control_pk`.
   */
  controlWrap?: string;
}

interface MemberGrantWire {
  member: string;
  role_ids: string[];
  control_wrap?: string;
}

/** Sanity bound on a carried `control_wrap` (a NIP-44 wrap of 40 bytes is ~130 chars). */
const MAX_CONTROL_WRAP_CHARS = 1024;

export function grantToJSON(grant: MemberGrant): string {
  const wire: MemberGrantWire = {
    member: grant.member,
    role_ids: grant.roleIds,
    ...(grant.controlWrap !== undefined ? { control_wrap: grant.controlWrap } : {}),
  };
  return JSON.stringify(wire);
}

export function grantFromJSON(json: string): MemberGrant | undefined {
  try {
    const w = JSON.parse(json) as MemberGrantWire;
    if (typeof w.member !== "string" || !/^[0-9a-f]{64}$/i.test(w.member)) return undefined;
    const roleIds = Array.isArray(w.role_ids)
      ? w.role_ids.filter((r): r is string => typeof r === "string").slice(0, MAX_ROLES_PER_MEMBER)
      : [];
    const controlWrap =
      typeof w.control_wrap === "string" && w.control_wrap.length > 0 && w.control_wrap.length <= MAX_CONTROL_WRAP_CHARS
        ? w.control_wrap
        : undefined;
    return {
      member: w.member.toLowerCase(),
      roleIds,
      ...(controlWrap !== undefined ? { controlWrap } : {}),
    };
  } catch {
    return undefined;
  }
}

export interface CommunityRoles {
  roles: Role[];
  grants: MemberGrant[];
}

export function emptyRoles(): CommunityRoles {
  return { roles: [], grants: [] };
}

export function roleById(roles: CommunityRoles, roleId: string): Role | undefined {
  return roles.roles.find((r) => r.roleId === roleId);
}

export function rolesOf(roles: CommunityRoles, memberHex: string): Role[] {
  const out: Role[] = [];
  for (const g of roles.grants) {
    if (g.member !== memberHex) continue;
    for (const rid of g.roleIds) {
      const r = roleById(roles, rid);
      if (r) out.push(r);
    }
  }
  return out;
}

export function effectivePermissions(roles: CommunityRoles, memberHex: string): bigint {
  return rolesOf(roles, memberHex).reduce((acc, r) => acc | r.permissions, 0n);
}

/**
 * Effective permissions for an action in one channel: server roles plus that
 * channel's roles. Narrows only what THIS client offers, never what it honors
 * (the fold is scope-agnostic, CORD-04 §3).
 */
export function effectivePermissionsIn(roles: CommunityRoles, memberHex: string, channelIdHex: string): bigint {
  return rolesOf(roles, memberHex).reduce(
    (acc, r) => (r.scope.kind === "server" || r.scope.channelId === channelIdHex ? acc | r.permissions : acc),
    0n,
  );
}

/** {@link isAuthorized}, judged against one channel per {@link effectivePermissionsIn}. */
export function isAuthorizedIn(
  roles: CommunityRoles,
  actorHex: string,
  ownerHex: string | undefined,
  channelIdHex: string,
  permission: bigint,
): boolean {
  if (ownerHex === actorHex) return true;
  return permsContain(effectivePermissionsIn(roles, actorHex, channelIdHex), permission);
}

export function hasPermission(roles: CommunityRoles, memberHex: string, bits: bigint): boolean {
  return permsContain(effectivePermissions(roles, memberHex), bits);
}

/**
 * Whether a member is STAFF (CORD-04 §3): the owner, or any holder of a
 * Control-writing bit ({@link STAFF_MASK}) — the set entitled to the
 * `control_root` (CORD-02 §2).
 */
export function isStaff(roles: CommunityRoles, memberHex: string, ownerHex: string | undefined): boolean {
  if (memberHex === ownerHex) return true;
  return (effectivePermissions(roles, memberHex) & STAFF_MASK) !== 0n;
}

/** Whether a grant's roles make its member staff — triggers delivering `control_root` in the Grant. */
export function rolesMakeStaff(roles: CommunityRoles, roleIds: string[]): boolean {
  return roleIds.some((rid) => {
    const r = roleById(roles, rid);
    return r !== undefined && (r.permissions & STAFF_MASK) !== 0n;
  });
}

/** A member's rank: the lowest position among their Roles; undefined if roleless. */
export function highestPosition(roles: CommunityRoles, memberHex: string): number | undefined {
  const positions = rolesOf(roles, memberHex).map((r) => r.position);
  return positions.length ? Math.min(...positions) : undefined;
}

export function isAdmin(roles: CommunityRoles, memberHex: string): boolean {
  return rolesOf(roles, memberHex).some((r) => isManagement(r.permissions));
}

/**
 * The member's display tier for the shared member list: "admin" if they can
 * shape the roster itself (MANAGE_ROLES), "moderator" for any other management
 * bits (kick/ban/messages/channels/…), undefined for a roleless member.
 */
export function badgeOf(roles: CommunityRoles, memberHex: string): "admin" | "moderator" | undefined {
  const perms = effectivePermissions(roles, memberHex);
  if (permsContain(perms, Permissions.MANAGE_ROLES)) return "admin";
  if (isManagement(perms)) return "moderator";
  return undefined;
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

/**
 * The position a new Role signed by `actorHex` may claim, or `undefined` if none
 * (CORD-04 §3: never at or above the signer). Owner mints at 1. Roleless or
 * unfolded roster → `undefined`, never rank 0: that would mint an edition every
 * verifier silently drops.
 */
export function mintablePosition(
  roles: CommunityRoles | undefined,
  actorHex: string,
  ownerHex: string | undefined,
): number | undefined {
  // Owner supremacy comes from the community_id, so it holds before the roster loads.
  if (ownerHex === actorHex) return 1;
  if (!roles) return undefined;
  const rank = highestPosition(roles, actorHex);
  return rank === undefined ? undefined : rank + 1;
}

/**
 * Position for a Role conferring READ ACCESS only: one below the lowest Role
 * (or the signer's floor, if deeper). Minting it at the signer's ceiling like
 * {@link mintablePosition} would promote grantees to the signer's rank, locking
 * out Admins. Bottom peers are fine. `undefined` if the signer may mint none.
 */
export function accessRolePosition(
  roles: CommunityRoles | undefined,
  actorHex: string,
  ownerHex: string | undefined,
): number | undefined {
  const ceiling = mintablePosition(roles, actorHex, ownerHex);
  if (ceiling === undefined) return undefined;
  const lowest = (roles?.roles ?? []).reduce((acc, r) => Math.max(acc, r.position), 0);
  return Math.max(ceiling, lowest + 1);
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

/**
 * Why verifiers would drop this Grant, or `undefined` if publishable (CORD-04
 * §2/§3): the signer must strictly outrank the member and every Role granted;
 * owner grants always pass. Check BEFORE publishing — failures are silent.
 */
export function grantRefusal(
  roles: CommunityRoles,
  actorHex: string,
  ownerHex: string | undefined,
  memberHex: string,
  roleIds: string[],
): string | undefined {
  if (actorHex === ownerHex) return undefined;
  if (!canActOnMember(roles, actorHex, ownerHex, memberHex, Permissions.MANAGE_ROLES)) {
    return "You don't outrank this member.";
  }
  for (const id of roleIds) {
    const r = roleById(roles, id);
    if (!r) return "That role isn't in the synced roster yet.";
    if (!canActOnPosition(roles, actorHex, ownerHex, r.position, Permissions.MANAGE_ROLES)) {
      return `You don't outrank the "${r.name}" role.`;
    }
  }
  return undefined;
}

/**
 * Does `actorHex` strictly outrank member `memberHex`? Owner outranks all; a
 * roleless member is last. The target-side half only (e.g. CORD-06 rekey
 * authority, where the bit is checked separately).
 */
export function outranksMember(
  roles: CommunityRoles,
  actorHex: string,
  ownerHex: string | undefined,
  memberHex: string,
): boolean {
  if (actorHex === ownerHex) return true;
  if (memberHex === ownerHex) return false;
  const target = highestPosition(roles, memberHex) ?? Number.MAX_SAFE_INTEGER;
  return outranks(roles, actorHex, ownerHex, target);
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

/**
 * Generalized member-targeting authority (ban/kick/hide/grant): the actor must
 * hold the bit AND strictly outrank the target (equal cannot act on equal).
 * The owner is never a valid target.
 */
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

export type StockTier = "admin" | "moderator";

/** The member's STOCK tier, by the stock role names (never permission-bit inference, unlike {@link badgeOf}). */
export function stockTierOf(roles: CommunityRoles, memberHex: string): StockTier | undefined {
  const held = new Set(roles.grants.find((g) => g.member === memberHex)?.roleIds ?? []);
  const has = (name: string) => roles.roles.some((r) => r.name === name && r.scope.kind === "server" && held.has(r.roleId));
  return has("Admin") ? "admin" : has("Moderator") ? "moderator" : undefined;
}

/**
 * The stock-tier changes `actorHex` may make to a member, in menu order; `null`
 * is "remove". Mirrors `setTier`'s pre-checks so no offered move is refused.
 */
export function tierMoves(
  roles: CommunityRoles,
  actorHex: string,
  ownerHex: string | undefined,
  memberHex: string,
): Array<StockTier | null> {
  if (!canActOnMember(roles, actorHex, ownerHex, memberHex, Permissions.MANAGE_ROLES)) return [];
  const current = stockTierOf(roles, memberHex);
  const may = (position: number) => canActOnPosition(roles, actorHex, ownerHex, position, Permissions.MANAGE_ROLES);
  const out: Array<StockTier | null> = [];
  if (current !== "admin" && may(adminRole("").position)) out.push("admin");
  if (current !== "moderator" && may(moderatorRole("").position)) out.push("moderator");
  if (current) out.push(null);
  return out;
}
