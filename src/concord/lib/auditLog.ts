/**
 * Control-plane audit classification and the suspicious-activity detector.
 *
 * An edition is `superseded` only if it is a genuine ANCESTOR of the fold's head
 * on the verified hash chain (prevHash → selfHash). Anything else at the entity
 * (forgery, unauthorized, fork loser, unchained plant) was NEVER honored.
 */

import { bytesToHex, grantLocator, hex32 } from "@/concord/lib/derive";
import type { FoldedControl } from "@/concord/lib/control";
import type { ParsedEdition } from "@/concord/lib/edition";
import type { OpenedEvent } from "@/concord/lib/stream";
import {
  VSK_BANLIST,
  VSK_CHANNEL,
  VSK_GRANT,
  VSK_INVITE_REGISTRY,
  VSK_PINS,
  VSK_METADATA,
  VSK_ROLE,
} from "@/concord/lib/kinds";
import { Permissions, isAuthorized } from "@/concord/lib/roles";

export type AuditValidity = "current" | "superseded" | "dropped" | "unknown";

/** Verdict per edition, keyed by rumor id hex. Without a fold every edition is `unknown`. */
export function classifyEditions(
  editions: readonly ParsedEdition[],
  folded: FoldedControl | undefined,
): Map<string, AuditValidity> {
  const out = new Map<string, AuditValidity>();
  if (!folded) {
    for (const e of editions) out.set(bytesToHex(e.rumorId), "unknown");
    return out;
  }

  // Index by (eid, selfHash) so a head's chain can be walked backwards.
  const byEidHash = new Map<string, ParsedEdition>();
  for (const e of editions) {
    byEidHash.set(`${bytesToHex(e.entityId)}:${bytesToHex(e.selfHash)}`, e);
  }
  const current = new Set<string>();
  const superseded = new Set<string>();
  for (const [eid, head] of folded.headEditions) {
    const headHex = bytesToHex(head.rumorId);
    current.add(headHex);
    let cursor: ParsedEdition | undefined = editions.find(
      (e) => bytesToHex(e.entityId) === eid && bytesToHex(e.rumorId) === headHex,
    );
    const guard = new Set<string>(); // cycle guard on selfHash
    while (cursor?.prevHash) {
      const prevKey = `${eid}:${bytesToHex(cursor.prevHash)}`;
      if (guard.has(prevKey)) break;
      guard.add(prevKey);
      const prev: ParsedEdition | undefined = byEidHash.get(prevKey);
      if (!prev) break; // dangling (compacted away) — nothing more to mark
      superseded.add(bytesToHex(prev.rumorId));
      cursor = prev;
    }
  }

  for (const e of editions) {
    const hex = bytesToHex(e.rumorId);
    out.set(hex, current.has(hex) ? "current" : superseded.has(hex) ? "superseded" : "dropped");
  }
  return out;
}

/** The permission an edition of this kind requires of its signer (CORD-04 §5). */
const REQUIRED_PERMISSION: Record<string, bigint> = {
  [VSK_METADATA]: Permissions.MANAGE_METADATA,
  [VSK_ROLE]: Permissions.MANAGE_ROLES,
  [VSK_CHANNEL]: Permissions.MANAGE_CHANNELS,
  [VSK_GRANT]: Permissions.MANAGE_ROLES,
  [VSK_BANLIST]: Permissions.BAN,
  [VSK_INVITE_REGISTRY]: Permissions.CREATE_INVITE,
  [VSK_PINS]: Permissions.PIN_MESSAGES,
};

/** Plain-language label per edition kind, for the member-facing summary. */
export const ACTION_LABELS: Record<string, { one: string; many: string }> = {
  [VSK_METADATA]: { one: "community setting change", many: "community setting changes" },
  [VSK_ROLE]: { one: "role change", many: "role changes" },
  [VSK_CHANNEL]: { one: "channel change", many: "channel changes" },
  [VSK_GRANT]: { one: "permission change", many: "permission changes" },
  [VSK_BANLIST]: { one: "ban", many: "bans" },
  [VSK_INVITE_REGISTRY]: { one: "invite link change", many: "invite link changes" },
  [VSK_PINS]: { one: "pin change", many: "pin changes" },
  unrecognised: { one: "unrecognised event", many: "unrecognised events" },
};

export interface SuspiciousActor {
  /** Proven by the seal's Schnorr signature. */
  author: string;
  /** vsk → how many editions of that kind they attempted. */
  attempts: Map<string, number>;
  total: number;
  firstAt: number;
  lastAt: number;
  /** Already on the banlist, so the remedy is a rotation rather than a ban. */
  banned: boolean;
}

/** Synthetic kind for events that opened but are not editions we understand. */
export const UNRECOGNISED = "unrecognised";

/**
 * Unrecognised events needed WITHIN {@link UNRECOGNISED_WINDOW} to flag an
 * author alone. A newer client's unknown kinds look the same; rate separates them.
 */
export const UNRECOGNISED_BURST = 20;
export const UNRECOGNISED_WINDOW = 5 * 60;

/**
 * Unauthorized invite-registry editions tolerated before they alone flag an
 * author (buggy clients mint these; volume separates a flooder). Below it they
 * only corroborate an actor already flagged.
 */
export const INVITE_ALERT_THRESHOLD = 20;

/** Whether any {@link UNRECOGNISED_WINDOW} contains {@link UNRECOGNISED_BURST} of `times`. */
function hasBurst(times: number[]): boolean {
  if (times.length < UNRECOGNISED_BURST) return false;
  const sorted = [...times].sort((a, b) => a - b);
  for (let i = UNRECOGNISED_BURST - 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - (UNRECOGNISED_BURST - 1)] <= UNRECOGNISED_WINDOW) return true;
  }
  return false;
}

/**
 * Members writing control editions the fold refuses for lack of authority —
 * narrower than "dropped", since admins lose fork races often.
 *
 * `since` is the last inspection's watermark (authority is judged as of now, so
 * a demotion would otherwise flag the whole back catalogue). Only call after a
 * sweep completes, or an unread grant makes someone look roleless.
 */
export function suspiciousActivity(
  editions: readonly ParsedEdition[],
  folded: FoldedControl,
  communityId: Uint8Array,
  opts: { since?: number; opened?: readonly OpenedEvent[] } = {},
): SuspiciousActor[] {
  const since = opts.since ?? 0;
  const opened = opts.opened ?? [];
  const validity = classifyEditions(editions, folded);
  const byAuthor = new Map<string, SuspiciousActor>();
  const inviteBy = new Map<string, number[]>();

  /**
   * When this member's standing last changed, per the fold, so only editions
   * published while already without standing are denounced. Standing moves via
   * their grant, their ban, AND any role they hold (a role mask edit strips holders).
   *
   * CAVEAT: timestamps are attacker-set `created_at`; backdating hides an edition
   * from this alert (never from the fold, which orders by version).
   */
  const standingChangedAt = (author: string): number => {
    let at = folded.bannedAt?.get(author) ?? -Infinity;
    let grant: { member: string; roleIds: string[] } | undefined;
    try {
      const head = folded.headEditions.get(bytesToHex(grantLocator(communityId, hex32(author))));
      if (head) at = Math.max(at, head.createdAt);
      grant = folded.roster.grants.find((g) => g.member === author);
    } catch { /* ignore */ }
    for (const roleId of grant?.roleIds ?? []) {
      const roleHead = folded.headEditions.get(roleId.toLowerCase());
      if (roleHead) at = Math.max(at, roleHead.createdAt);
    }
    return at;
  };

  for (const e of editions) {
    if (e.createdAt <= since) continue;
    if (validity.get(bytesToHex(e.rumorId)) !== "dropped") continue;
    const required = REQUIRED_PERMISSION[e.vsk];
    if (required === undefined) continue; // a kind with no authority gate
    const author = e.author;
    // The owner is never suspicious (rank comes from the community_id commitment).
    // Checked FIRST: a moderator could banlist the owner.
    if (author === folded.ownerHex) continue;
    // Authorized now ⇒ a dropped edition is a fork race, not an attack.
    if (isAuthorized(folded.roster, author, folded.ownerHex, required)) continue;
    // Only editions published after they lost standing count.
    if (e.createdAt <= standingChangedAt(author)) continue;

    // Registry editions ride a side tally (see INVITE_ALERT_THRESHOLD).
    if (e.vsk === VSK_INVITE_REGISTRY) {
      const times = inviteBy.get(author);
      if (times) times.push(e.createdAt);
      else inviteBy.set(author, [e.createdAt]);
      continue;
    }

    const banned = folded.banned.has(author);
    const actor = byAuthor.get(author) ?? {
      author,
      attempts: new Map<string, number>(),
      total: 0,
      firstAt: e.createdAt,
      lastAt: e.createdAt,
      banned,
    };
    actor.attempts.set(e.vsk, (actor.attempts.get(e.vsk) ?? 0) + 1);
    actor.total += 1;
    actor.firstAt = Math.min(actor.firstAt, e.createdAt);
    actor.lastAt = Math.max(actor.lastAt, e.createdAt);
    actor.banned = banned;
    byAuthor.set(author, actor);
  }

  // Opened but unparsed events: lower weight — they join an existing tally, and
  // alone count only as a burst (a newer client would otherwise look hostile).
  const parsed = new Set(editions.map((e) => bytesToHex(e.rumorId)));
  const unrecognisedBy = new Map<string, number[]>();
  for (const ev of opened) {
    if (ev.createdAt <= since || parsed.has(ev.rumorId)) continue;
    if (ev.author === folded.ownerHex) continue; // the owner's rank is structural
    if (ev.createdAt <= standingChangedAt(ev.author)) continue;
    const times = unrecognisedBy.get(ev.author);
    if (times) times.push(ev.createdAt);
    else unrecognisedBy.set(ev.author, [ev.createdAt]);
  }

  for (const [author, times] of unrecognisedBy) {
    const existing = byAuthor.get(author);
    if (!existing && !hasBurst(times)) continue;
    const actor = existing ?? {
      author,
      attempts: new Map<string, number>(),
      total: 0,
      firstAt: Math.min(...times),
      lastAt: Math.max(...times),
      banned: folded.banned.has(author),
    };
    actor.attempts.set(UNRECOGNISED, (actor.attempts.get(UNRECOGNISED) ?? 0) + times.length);
    actor.total += times.length;
    actor.firstAt = Math.min(actor.firstAt, ...times);
    actor.lastAt = Math.max(actor.lastAt, ...times);
    byAuthor.set(author, actor);
  }

  // Below the threshold registries only corroborate; at it, they accuse alone.
  for (const [author, times] of inviteBy) {
    const existing = byAuthor.get(author);
    if (!existing && times.length < INVITE_ALERT_THRESHOLD) continue;
    const actor = existing ?? {
      author,
      attempts: new Map<string, number>(),
      total: 0,
      firstAt: Math.min(...times),
      lastAt: Math.max(...times),
      banned: folded.banned.has(author),
    };
    actor.attempts.set(VSK_INVITE_REGISTRY, (actor.attempts.get(VSK_INVITE_REGISTRY) ?? 0) + times.length);
    actor.total += times.length;
    actor.firstAt = Math.min(actor.firstAt, ...times);
    actor.lastAt = Math.max(actor.lastAt, ...times);
    byAuthor.set(author, actor);
  }

  return [...byAuthor.values()].sort((a, b) => b.total - a.total || b.lastAt - a.lastAt);
}

/** "7 bans, 18 channel updates" — the summary line for one actor. */
export function describeAttempts(attempts: ReadonlyMap<string, number>): string {
  return [...attempts.entries()]
    // Busiest first, but unrecognised events trail (least certain).
    .sort((a, b) => {
      const aLast = a[0] === UNRECOGNISED;
      const bLast = b[0] === UNRECOGNISED;
      if (aLast !== bLast) return aLast ? 1 : -1;
      return b[1] - a[1] || a[0].localeCompare(b[0]);
    })
    .map(([vsk, n]) => {
      const label = ACTION_LABELS[vsk];
      return `${n} ${label ? (n === 1 ? label.one : label.many) : n === 1 ? "action" : "actions"}`;
    })
    .join(", ");
}
