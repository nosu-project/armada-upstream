import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NostrFilter } from "@nostrify/nostrify";
import type { ReactNode } from "react";

import { parseGitRepositoryAddress, type GitRepositoryAttachment } from "@/lib/gitActivity";
import { emitWireScopes } from "@/wire/bus";

/**
 * What a repository pull costs the rest of the app.
 *
 * The wire rings its scope bus once per BATCH, and this hook's queryFn is
 * several thousand-row reads on the `main` tenant — the same tenant and the
 * same storage queue the chat timeline's own read is sitting in. Re-reading
 * per batch measured 67 `db.query main` calls for one channel switch and drove
 * the `c2:*` read behind the message skeleton to twelve seconds, so the
 * batches have to fold into one refresh. The intermediate results were never
 * worth having anyway: events are still landing while the re-read runs.
 */

const OWNER = "a".repeat(64);
const COORD = `30617:${OWNER}:armada`;

const h = vi.hoisted(() => ({
  /** Every filter set handed to the store, in order — one entry per query(). */
  queries: [] as NostrFilter[][],
  /** Live query() calls, and the high-water mark — how wide a wave got. */
  inFlight: 0,
  maxInFlight: 0,
}));

vi.mock("@nostrify/react", () => ({
  useNostr: () => ({ nostr: { relay: () => ({ query: async () => [] }), group: () => ({ event: async () => undefined }) } }),
}));

vi.mock("@/hooks/useEventStore", () => ({
  useEventStore: () => Promise.resolve({
    query: async (filters: NostrFilter[]) => {
      h.queries.push(filters);
      h.inFlight += 1;
      h.maxInFlight = Math.max(h.maxInFlight, h.inFlight);
      // An async body runs synchronously to its first await, so concurrent
      // callers all register before any of them unwinds: the high-water mark
      // separates one wave from the same calls made serially.
      await Promise.resolve();
      h.inFlight -= 1;
      return [];
    },
  }),
}));

const { useChannelGitActivity } = await import("./useChannelGitActivity");

const attachment: GitRepositoryAttachment = {
  address: parseGitRepositoryAddress(COORD)!,
  relayHints: [],
  attachedAt: 1_000,
};

/**
 * One client for the whole test, built in `beforeEach` — not inside `wrapper`,
 * which React re-invokes on every render and would hand each pass a fresh
 * empty cache.
 */
let client: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** One `git:` batch off the wire, as a repository pull delivers them. */
function wireBatch() {
  act(() => {
    emitWireScopes([`git:${COORD}`]);
  });
}

beforeEach(() => {
  h.queries = [];
  h.inFlight = 0;
  h.maxInFlight = 0;
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useChannelGitActivity", () => {
  async function mounted() {
    const view = renderHook(() => useChannelGitActivity("channel", [attachment]), { wrapper });
    await waitFor(() => expect(h.queries.length).toBeGreaterThan(0));
    await waitFor(() => expect(view.result.current.isLoading).toBe(false));
    return view;
  }

  it("reads the independent shapes in one wave rather than serially", async () => {
    await mounted();
    // Roots, CI and the repository announcements do not depend on each other,
    // so they are in flight together rather than three serial round trips.
    // (`children`/`deletions` do depend on roots, and with none to hang off
    // they are skipped entirely.)
    expect(h.queries).toHaveLength(3);
    expect(h.maxInFlight).toBe(3);
    const kinds = h.queries.flatMap((filters) => filters.flatMap((filter) => filter.kinds ?? []));
    expect(kinds).toContain(1621); // issue root
    expect(kinds).toContain(30617); // repository announcement
  });

  it("folds a pull's batches into far fewer re-reads than batches", async () => {
    await mounted();
    const afterMount = h.queries.length;

    // A repository pull's batches are SPREAD over seconds, not simultaneous.
    // That distinction is the whole bug: react-query already collapses
    // invalidations that overlap an in-flight fetch, so a burst inside one
    // tick was never the expensive case. Twenty batches at 100ms is twenty
    // full re-reads without a coalescing window.
    for (let i = 0; i < 20; i++) {
      wireBatch();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    // Each refresh is one wave of 3 reads. The 400ms window turns 20 batches
    // spanning ~2s into at most a handful.
    const refreshes = (h.queries.length - afterMount) / 3;
    expect(refreshes).toBeLessThanOrEqual(7);
    expect(refreshes).toBeGreaterThan(0);
  });

  it("does not re-read the chain when the channel is reopened", async () => {
    const view = await mounted();
    const afterMount = h.queries.length;
    view.unmount();

    // Leave the channel and come back. The wire pushes repository activity in
    // (the scope watcher above), so a remount re-reading on staleness only
    // walks the same thousands of rows again — on the `main` tenant, in the
    // storage queue the chat timeline's own read is waiting in.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    renderHook(() => useChannelGitActivity("channel", [attachment]), { wrapper });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(h.queries.length).toBe(afterMount);
  });

  it("still refreshes when a later batch arrives after the window closes", async () => {
    await mounted();
    const afterMount = h.queries.length;

    wireBatch();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await waitFor(() => expect(h.queries.length).toBe(afterMount + 3));

    // The coalescing window is a gate, not a latch: a batch arriving later is
    // its own refresh, or a live repository would go quiet after the first.
    wireBatch();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await waitFor(() => expect(h.queries.length).toBe(afterMount + 6));
  });
});
