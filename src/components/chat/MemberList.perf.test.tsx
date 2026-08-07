import { cleanup, render } from "@testing-library/react";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ReactNode } from "react";

/**
 * Characterization / perf evidence for the MemberList "resource heavy" claim.
 *
 * These tests pin two concrete, architectural facts (and double as regression
 * guards if the component is later virtualized — the row-count assertions would
 * flip):
 *
 *  1. The roster is NOT virtualized/windowed: N members → N mounted MemberRow
 *     subtrees in the DOM at once, regardless of scroll position
 *     (MemberList.tsx:754/795/841 map the whole roster).
 *  2. Each row mounts four query-backed hooks — useAuthor (1×,
 *     useAuthor.ts:76), useScopedIdentity→useServerProfile (1×), and
 *     useUserStatus (2×: general + music, useUserStatus.ts:160-161). So an
 *     N-member channel stands up ~4N react-query observers plus 2N DOM menu
 *     roots.
 *
 * IMPORTANT / honest scoping: the cost proven here is React observers + DOM,
 * NOT N network subscriptions. The relay REQs behind these hooks are batched —
 * `NostrBatcher` merges the per-author status REQs (useUserStatus.ts:76-88) and
 * `profileSync` coalesces author demand (useAuthor.ts:68-74). So virtualizing
 * the list attacks the render/observer/DOM cost, which is what these numbers
 * measure; it would not change network traffic (already batched).
 *
 * The four leaf hooks and the heavy per-row children are stubbed to counting
 * spies so the measurement isolates MemberList's own structure (row fan-out),
 * not the profile/query stack. Each stubbed hook stands in 1:1 for a real
 * `useQuery` in production (see line refs above).
 */

const spies = vi.hoisted(() => ({
  useAuthor: vi.fn(),
  useUserStatus: vi.fn(),
  useScopedIdentity: vi.fn(),
  useMemberSearch: vi.fn(),
}));

vi.mock("@/hooks/useAuthor", () => ({
  useAuthor: (pubkey?: string) => {
    spies.useAuthor(pubkey);
    return { data: undefined };
  },
}));

vi.mock("@/hooks/useUserStatus", () => ({
  useUserStatus: (pubkey?: string, type = "general") => {
    spies.useUserStatus(pubkey, type);
    return { data: undefined };
  },
  isStatusExpired: () => false,
}));

vi.mock("@/hooks/useScopedDisplayName", () => ({
  useScopedIdentity: (pubkey: string) => {
    spies.useScopedIdentity(pubkey);
    return { displayName: pubkey.slice(0, 8) };
  },
}));

vi.mock("@/hooks/useMemberSearch", () => ({
  // null = "no search active, show everyone" (useMemberSearch.ts:85).
  useMemberSearch: (roster: string[], query: string) => {
    spies.useMemberSearch(roster, query);
    return null;
  },
}));

// Heavy per-row children replaced with trivial stubs: the point is to measure
// MemberList's own row structure, not these subtrees.
vi.mock("@/components/chat/ProfilePreviewCard", () => ({
  ProfilePreviewCard: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/dialogs/StatusDialog", () => ({ StatusDialog: () => null }));
vi.mock("@/components/BotPill", () => ({ BotPill: () => null }));
vi.mock("@/components/DisplayName", () => ({
  DisplayName: ({ name }: { name?: string }) => <span>{name}</span>,
}));
vi.mock("@/components/chat/CustomEmoji", () => ({
  EmojifiedText: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

import { MemberList } from "@/components/chat/MemberList";

/** N distinct hex pubkeys — exactly the shape MemberList.members consumes. */
function pubkeys(n: number): string[] {
  return Array.from({ length: n }, () => getPublicKey(generateSecretKey()));
}

/** Every rendered row carries the `gutter-tick` class (MemberList.tsx:339). */
function rowCount(container: HTMLElement): number {
  return container.querySelectorAll(".gutter-tick").length;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("MemberList resource profile", () => {
  it("renders every member — no windowing/virtualization", () => {
    const members = pubkeys(500);
    const { container } = render(
      <MemberList admins={[]} members={members} canModerate={false} />,
    );

    // All 500 rows are in the DOM simultaneously: a virtualizer would mount
    // only the ~visible slice. This assertion FLIPS if the list is windowed.
    expect(rowCount(container)).toBe(500);
    expect(spies.useAuthor).toHaveBeenCalledTimes(500);
  });

  it("mounts four query-backed hooks per member row", () => {
    const members = pubkeys(120);
    render(<MemberList admins={[]} members={members} canModerate={false} />);

    // 1 useAuthor + 1 useScopedIdentity + 2 useUserStatus = 4 useQuery
    // observers per row → 480 for a 120-member channel.
    expect(spies.useAuthor).toHaveBeenCalledTimes(120);
    expect(spies.useScopedIdentity).toHaveBeenCalledTimes(120);
    expect(spies.useUserStatus).toHaveBeenCalledTimes(240);

    // The 2× is general + music status, per row (MemberList.tsx:160-161).
    const musicCalls = spies.useUserStatus.mock.calls.filter((c) => c[1] === "music");
    const generalCalls = spies.useUserStatus.mock.calls.filter((c) => c[1] === "general");
    expect(musicCalls).toHaveLength(120);
    expect(generalCalls).toHaveLength(120);
  });

  it(
    "[perf] render cost grows with roster size (all rows eager)",
    () => {
      const small = pubkeys(50);
      const big = pubkeys(800);

      const t0 = performance.now();
      const r1 = render(<MemberList admins={[]} members={small} canModerate={false} />);
      const tSmall = performance.now() - t0;
      expect(rowCount(r1.container)).toBe(50);
      cleanup();

      const t1 = performance.now();
      const r2 = render(<MemberList admins={[]} members={big} canModerate={false} />);
      const tBig = performance.now() - t1;
      expect(rowCount(r2.container)).toBe(800);

      // Evidence, not a tight bound — jsdom timings are noisy and machine
      // dependent. The regression guard is only that a large roster renders at
      // all within a generous ceiling; the printed numbers are the signal.
      console.log(
        `[perf] MemberList eager render: 50 members ${tSmall.toFixed(1)}ms, ` +
          `800 members ${tBig.toFixed(1)}ms ` +
          `(${(tBig / Math.max(tSmall, 0.01)).toFixed(1)}× for 16× the rows)`,
      );
      expect(tBig).toBeLessThan(15_000);
    },
    30_000,
  );
});
