/**
 * Control-plane audit classification, and the suspicious-activity detector
 * built on it.
 *
 * The fold accepts one HEAD edition per entity. An edition is `superseded`
 * only if it is a genuine ANCESTOR of that head on the verified hash chain
 * (prevHash → selfHash) — it really was the honored state before a later,
 * chained edition replaced it. Anything else at the entity (a forgery at any
 * version, an unauthorized edition, a same-version fork loser, an unchained
 * plant) was NEVER honored, whatever version it claims.
 *
 * Shared by the Audit Log view (which renders every row) and the watchdog
 * (which reads the same verdicts and looks for one specific shape).
 */

import { bytesToHex, grantLocator, hex32 } from "@/concord-v2/lib/derive";
import type { FoldedControl } from "@/concord-v2/lib/control";
import type { ParsedEdition } from "@/concord-v2/lib/edition";
import type { OpenedEvent } from "@/concord-v2/lib/stream";
import {
  VSK_BANLIST,
  VSK_CHANNEL,
  VSK_GRANT,
  VSK_INVITE_REGISTRY,
  VSK_METADATA,
  VSK_ROLE,
} from "@/concord-v2/lib/kinds";
import { Permissions, isAuthorized } from "@/concord-v2/lib/roles";

export type AuditValidity = "current" | "superseded" | "dropped" | "unknown";

/**
 * Verdict per edition, keyed by rumor id hex. Without a fold every edition is
 * `unknown` — absence of a decision, never a claim that it was dropped.
 */
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
};

/**
 * Human label per edition kind, for the summary ("7 bans, 18 channel changes").
 * Plain words only — this is read by members, not by people who know what a
 * control plane or a vsk is.
 */
export const ACTION_LABELS: Record<string, { one: string; many: string }> = {
  [VSK_METADATA]: { one: "community setting change", many: "community setting changes" },
  [VSK_ROLE]: { one: "role change", many: "role changes" },
  [VSK_CHANNEL]: { one: "channel change", many: "channel changes" },
  [VSK_GRANT]: { one: "permission change", many: "permission changes" },
  [VSK_BANLIST]: { one: "ban", many: "bans" },
  [VSK_INVITE_REGISTRY]: { one: "invite link change", many: "invite link changes" },
  unrecognised: { one: "unrecognised event", many: "unrecognised events" },
};

export interface SuspiciousActor {
  /** The signer, proven by the seal's Schnorr signature. */
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
 * author on their own.
 *
 * A rumor we can't parse is not proof of malice: CORD is meant to extend, so a
 * newer client publishing a control-plane kind this build predates looks
 * exactly the same. What separates the two is rate. Nobody's honest upgrade
 * emits twenty unparseable events inside five minutes.
 */
export const UNRECOGNISED_BURST = 20;
export const UNRECOGNISED_WINDOW = 5 * 60;

/**
 * Unauthorized invite-registry editions tolerated before they alone flag an
 * author. Registries are the least sensitive entity on the plane: clients
 * sometimes mint one wrongly (a bundle refresh racing a revoked grant), the
 * fold refuses it, and nothing in the community changes. What separates a
 * buggy client from a flooder is volume — nobody's honest refresh loop
 * publishes twenty refused registry editions. They still join the tally of an
 * actor already flagged for something real: there they corroborate, not accuse.
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
 * Members writing control editions the fold refuses for lack of authority.
 *
 * Deliberately NARROWER than "dropped": that verdict also covers a forgery and
 * a same-version fork loser, and a legitimate admin loses a fork race often
 * enough that alerting on it would cry wolf. This asks the sharper question —
 * did someone with no standing to act try to act anyway.
 *
 * `since` exists because the fold judges by CURRENT authority: the moment an
 * admin is demoted, their entire back catalogue becomes unauthorized and would
 * otherwise light up the alarm. Pass the watermark of the last inspection.
 *
 * Only call once a sweep has run its course. Cut one off early and we may not
 * have fetched the grant that authorises someone, so they would look roleless
 * purely because their promotion hasn't been read yet.
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
   * When this member's standing last changed, as far as the fold can tell.
   *
   * Authority is judged as it stands TODAY, so everything a demoted, kicked or
   * banned member ever published reads as unauthorized the instant they lose
   * it. Anchoring on the change means we only denounce what they published
   * while they already had no standing — which losing it cannot manufacture,
   * and a genuine outsider trips from their very first edition.
   *
   * Standing moves through THREE entities, not one: their own grant row, their
   * ban, and any role they hold — editing a role's permission mask strips
   * everyone holding it without touching a single grant. Missing that last one
   * denounces an honest moderator the moment an owner narrows their role.
   *
   * CAVEAT: every timestamp here is the publisher's own `created_at`, which an
   * attacker sets freely. Backdating below the watermark hides an edition from
   * this alert (never from the fold, which orders by version, not time).
   */
  const standingChangedAt = (author: string): number => {
    let at = folded.bannedAt?.get(author) ?? -Infinity;
    let grant: { member: string; roleIds: string[] } | undefined;
    try {
      const head = folded.headEditions.get(bytesToHex(grantLocator(communityId, hex32(author))));
      if (head) at = Math.max(at, head.createdAt);
      grant = folded.roster.grants.find((g) => g.member === author);
    } catch {
      // A malformed author hex can't index a grant; treat it as no grant.
    }
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
    // The owner is never suspicious: their rank comes from the community_id
    // commitment, not from any edition. Checked FIRST because a moderator can
    // put the owner on the banlist, and the checks below would otherwise
    // denounce them to every other admin.
    if (author === folded.ownerHex) continue;
    // Standing they hold right now settles it: an authorized author's dropped
    // edition is a fork race, which admins lose often enough that alerting on
    // it would cry wolf.
    if (isAuthorized(folded.roster, author, folded.ownerHex, required)) continue;
    // No standing now. Did they have it then? Only a grant or a ban moves the
    // line, so an edition published BEFORE the most recent of those may well
    // have been legitimate when it landed. Anything after it was published in
    // full knowledge of having none.
    if (e.createdAt <= standingChangedAt(author)) continue;

    // Registry editions ride a side tally: alone they only count past
    // INVITE_ALERT_THRESHOLD, merged below once the rest of the verdict is in.
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

  // Events that opened (so the seal names their signer) but are not editions we
  // understand. Folded in at LOWER weight: they join a tally already opened by
  // unauthorized editions, but on their own they only count against someone who
  // produced a burst of them — otherwise a client newer than this one would
  // read as an attacker.
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

  // Invite registries, last: below the threshold they only corroborate an
  // actor someone else's evidence already flagged; at it, they accuse alone.
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
    // Busiest first, except unrecognised events, which trail regardless of
    // volume: they carry the least certainty, so they read as a footnote to the
    // named actions rather than leading them.
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
