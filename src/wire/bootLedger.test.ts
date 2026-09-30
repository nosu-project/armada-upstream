import { describe, expect, it } from "vitest";

import { CI_EVENT_KINDS } from "@/lib/ci";
import { GIT_STATUS_KINDS, NIP22_COMMENT_KIND } from "@/lib/gitActivity";
import {
  isLedgerFilter,
  partitionByLedger,
  recordLedger,
  recordUnits,
  rootsUnit,
  ticketChildrenCovered,
  unitMark,
} from "@/wire/bootLedger";

import type { NostrFilter } from "@nostrify/nostrify";

const A = "a".repeat(64);
const B = "b".repeat(64);
const REPO = `30617:${"c".repeat(64)}:armada`;
const DAY = 24 * 3600;

const comments = (ids: string[], since = 1_000): NostrFilter => ({ kinds: [NIP22_COMMENT_KIND], "#E": ids, since, limit: 4_000 });
const statuses = (ids: string[], since = 1_000): NostrFilter => ({ kinds: [...GIT_STATUS_KINDS], "#e": ids, since, limit: 4_000 });
const ci = (since = 1_000): NostrFilter => ({ kinds: [...CI_EVENT_KINDS], "#a": [REPO], since });

describe("bootLedger", () => {
  it("tracks only the git child and CI bootstrap filters", () => {
    expect(isLedgerFilter(comments([A]))).toBe(true);
    expect(isLedgerFilter(statuses([A]))).toBe(true);
    expect(isLedgerFilter(ci())).toBe(true);
    expect(isLedgerFilter({ kinds: [1621], "#a": [REPO] }), "no explicit since").toBe(false);
    expect(isLedgerFilter({ kinds: [1111], "#e": [A], since: 5 }), "a comment filter on #e is not a ticket child").toBe(false);
  });

  it("a new unit bootstraps from the filter's own since; a covered one resumes from its mark", () => {
    const ledger = recordLedger(undefined, [comments([A])], 50_000, 50_000);
    const out = partitionByLedger([comments([A, B])], ledger, 60);
    expect(out).toEqual([
      comments([B]),
      { ...comments([A]), since: 50_000 - 60 },
    ]);
  });

  it("never asks for less history than the spec did", () => {
    const ledger = recordLedger(undefined, [ci(10)], 500, 500);
    expect(partitionByLedger([ci(2_000)], ledger, 60)).toEqual([ci(2_000)]);
  });

  it("passes untracked filters through untouched", () => {
    const f: NostrFilter = { kinds: [9], "#h": ["g"] };
    expect(partitionByLedger([f], undefined, 60)).toEqual([f]);
  });

  it("writes only when a unit is new or its mark moved far enough", () => {
    const first = recordLedger(undefined, [comments([A])], 10_000, 10_000);
    expect(first).toBeDefined();
    expect(recordLedger(first, [comments([A])], 10_060, 10_060), "a rotation later").toBeUndefined();
    expect(recordLedger(first, [comments([A])], 10_060, 10_060, 0), "session copy advances every EOSE").toBeDefined();
    expect(recordLedger(first, [comments([A, B])], 10_060, 10_060), "a new root").toBeDefined();
    expect(recordLedger(first, [comments([A])], 11_000, 11_000)).toBeDefined();
  });

  it("keeps units a round didn't cover, until they go stale", () => {
    const ledger = recordLedger(undefined, [statuses([A])], 1_000, 1_000);
    const next = recordLedger(ledger, [ci()], 2_000, 2_000)!;
    expect(unitMark(next, `s:${A.slice(0, 16)}`)).toBe(1_000);
    const later = recordLedger(next, [ci()], 1_000 + 8 * DAY, 1_000 + 8 * DAY)!;
    expect(unitMark(later, `s:${A.slice(0, 16)}`)).toBeUndefined();
  });

  it("never moves a unit's mark backwards", () => {
    const ledger = recordLedger(undefined, [comments([A])], 5_000, 5_000);
    const next = recordLedger(ledger, [comments([A, B])], 4_000, 5_000)!;
    expect(unitMark(next, `c:${A.slice(0, 16)}`)).toBe(5_000);
    expect(unitMark(next, `c:${B.slice(0, 16)}`)).toBe(4_000);
  });

  it("a ticket's children are covered only once both comments and statuses are", () => {
    const partial = recordLedger(undefined, [comments([A])], 1_000, 1_000);
    expect(ticketChildrenCovered(partial, A)).toBe(false);
    const both = recordLedger(partial, [statuses([A])], 1_000, 1_000);
    expect(ticketChildrenCovered(both, A)).toBe(true);
  });

  it("records directly named units beside the filter-derived ones", () => {
    const ledger = recordLedger(undefined, [ci()], 1_000, 1_000);
    const next = recordUnits(ledger, new Set([rootsUnit(REPO)]), 3_000, 3_000)!;
    expect(unitMark(next, rootsUnit(REPO))).toBe(3_000);
    expect(unitMark(next, `a:${REPO}`)).toBe(1_000);
  });
});
