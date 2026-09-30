import { CI_EVENT_KINDS } from "@/lib/ci";
import { KvPrefixCache } from "@/lib/db/kvCache";
import { GIT_STATUS_KINDS, NIP22_COMMENT_KIND } from "@/lib/gitActivity";

import type { NostrFilter } from "@nostrify/nostrify";

/**
 * Resume marks for the wire's explicit-`since` filters (git ticket children,
 * CI runs), per relay: mark (unix seconds) → the unit keys a round covered up to
 * that mark. A filter's units are its root ids or repository addresses, so a new
 * ticket bootstraps alone and the rest resume from their own mark rather than
 * replaying their whole history every launch. Not the relay cursor: that one
 * advances on other filters while these are absent from the spec.
 */
export type BootLedger = Record<string, string[]>;

/** The persisted ledgers, keyed by normalized relay URL. */
export const bootLedgers = new KvPrefixCache<BootLedger>({ prefix: "wire-boot:" });

/** Units untouched this long are forgotten; one that returns bootstraps again. */
const LEDGER_TTL_SECONDS = 7 * 24 * 3600;
/** A mark this much newer than the recorded one is worth a KV write. */
const LEDGER_WRITE_MIN_ADVANCE_SECONDS = 15 * 60;

type UnitTag = "#E" | "#e" | "#a";

function sameKinds(f: NostrFilter, kinds: readonly number[]): boolean {
  return f.kinds?.length === kinds.length && f.kinds.every((k) => kinds.includes(k));
}

/** The tag a filter's units live in, with a key prefix per filter class. */
function unitShape(f: NostrFilter): { tag: UnitTag; prefix: string } | undefined {
  if (f.since === undefined) return undefined;
  if (sameKinds(f, [NIP22_COMMENT_KIND]) && f["#E"]?.length) return { tag: "#E", prefix: "c:" };
  if (sameKinds(f, GIT_STATUS_KINDS) && f["#e"]?.length) return { tag: "#e", prefix: "s:" };
  if (sameKinds(f, CI_EVENT_KINDS) && f["#a"]?.length) return { tag: "#a", prefix: "a:" };
  return undefined;
}

/** Event ids are shortened: the ledger is rewritten whole, and collisions only cost a deeper replay. */
function unitKey(prefix: string, value: string): string {
  return prefix + (prefix === "a:" ? value : value.slice(0, 16));
}

function markIndex(ledger: BootLedger | undefined): Map<string, number> {
  const out = new Map<string, number>();
  for (const [mark, keys] of Object.entries(ledger ?? {})) {
    const at = Number(mark);
    if (!Number.isFinite(at)) continue;
    for (const key of keys) out.set(key, Math.max(out.get(key) ?? 0, at));
  }
  return out;
}

/** Whether a ticket's comments and statuses were both covered by some past round. */
export function ticketChildrenCovered(ledger: BootLedger | undefined, rootId: string): boolean {
  const marks = markIndex(ledger);
  return marks.has(unitKey("c:", rootId)) && marks.has(unitKey("s:", rootId));
}

/** Whether a filter is one the ledger tracks (and so resumes from its own marks). */
export function isLedgerFilter(f: NostrFilter): boolean {
  return unitShape(f) !== undefined;
}

/**
 * Split each tracked filter into the units never covered (keeping the filter's
 * deep `since`) and the covered ones (resuming from their oldest mark minus
 * `overlap`). Untracked filters pass through unchanged.
 */
export function partitionByLedger(filters: NostrFilter[], ledger: BootLedger | undefined, overlap: number): NostrFilter[] {
  const marks = markIndex(ledger);
  const out: NostrFilter[] = [];
  for (const f of filters) {
    const shape = unitShape(f);
    if (!shape) {
      out.push(f);
      continue;
    }
    const fresh: string[] = [];
    const covered: string[] = [];
    let oldest = Infinity;
    for (const value of f[shape.tag] ?? []) {
      const at = marks.get(unitKey(shape.prefix, value));
      if (at === undefined) fresh.push(value);
      else {
        covered.push(value);
        oldest = Math.min(oldest, at);
      }
    }
    if (fresh.length > 0) out.push({ ...f, [shape.tag]: fresh });
    if (covered.length > 0) out.push({ ...f, [shape.tag]: covered, since: Math.max(f.since!, oldest - overlap) });
  }
  return out;
}

/**
 * The ledger after a round over `filters` reached EOSE for a REQ stamped at
 * `mark`, or `undefined` when no unit is new or advanced by `minAdvance`.
 */
export function recordLedger(
  ledger: BootLedger | undefined,
  filters: NostrFilter[],
  mark: number,
  now: number,
  minAdvance = LEDGER_WRITE_MIN_ADVANCE_SECONDS,
): BootLedger | undefined {
  const covered = new Set<string>();
  for (const f of filters) {
    const shape = unitShape(f);
    if (!shape) continue;
    for (const value of f[shape.tag] ?? []) covered.add(unitKey(shape.prefix, value));
  }
  return recordUnits(ledger, covered, mark, now, minAdvance);
}

/** A repository's ticket-root discovery read, as a ledger unit. */
export function rootsUnit(address: string): string {
  return `r:${address}`;
}

/** The mark `unit` was last covered at on this ledger, if any. */
export function unitMark(ledger: BootLedger | undefined, unit: string): number | undefined {
  return markIndex(ledger).get(unit);
}

/** {@link recordLedger} for units named directly. */
export function recordUnits(
  ledger: BootLedger | undefined,
  covered: ReadonlySet<string>,
  mark: number,
  now: number,
  minAdvance = LEDGER_WRITE_MIN_ADVANCE_SECONDS,
): BootLedger | undefined {
  if (covered.size === 0) return undefined;
  const marks = markIndex(ledger);
  let changed = false;
  for (const key of covered) {
    const at = marks.get(key);
    if (at === undefined || mark - at >= Math.max(minAdvance, 1)) changed = true;
  }
  const next: BootLedger = {};
  for (const [key, at] of marks) {
    if (covered.has(key)) continue;
    if (now - at > LEDGER_TTL_SECONDS) {
      changed = true;
      continue;
    }
    (next[String(at)] ??= []).push(key);
  }
  if (!changed) return undefined;
  for (const key of covered) {
    const at = String(Math.max(marks.get(key) ?? 0, mark));
    (next[at] ??= []).push(key);
  }
  return next;
}
