import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PropsWithChildren } from "react";
import type { NostrEvent } from "@nostrify/nostrify";

const SELF = "f".repeat(64);

const h = vi.hoisted(() => ({
  queue: vi.fn(async (..._args: unknown[]) => undefined),
  fanout: vi.fn(),
  store: vi.fn(),
  markOwn: vi.fn(),
}));

vi.mock("@nostrify/react", () => ({
  useNostr: () => ({
    nostr: {
      relay: vi.fn(),
      event: vi.fn(),
    },
  }),
}));

vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({
    user: {
      pubkey: SELF,
      method: "nsec",
      signer: {
        signEvent: async (template: Omit<NostrEvent, "id" | "pubkey" | "sig">) => ({
          ...template,
          id: "e".repeat(64),
          pubkey: SELF,
          sig: "1".repeat(128),
        }),
      },
    },
  }),
}));

vi.mock("@/hooks/useEventStore", () => ({
  useEventStore: () => Promise.resolve({ event: h.store }),
}));

vi.mock("@/lib/webPushState", () => ({
  markOwnWebPushEvent: (...args: unknown[]) => h.markOwn(...args),
}));

vi.mock("@/lib/nip65", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/nip65")>()),
  publishSignedEventToRelays: (...args: unknown[]) => h.fanout(...args),
}));

vi.mock("@/lib/publishOutbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/publishOutbox")>()),
  queueSignedEvent: (...args: unknown[]) => h.queue(...args),
}));

import { useNostrPublish } from "@/hooks/useNostrPublish";
import { PublishOutboxConflictError } from "@/lib/publishOutbox";

function Wrapper({ children }: PropsWithChildren) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  h.queue.mockReset().mockResolvedValue(undefined);
  h.fanout.mockReset().mockResolvedValue({ accepted: [], rejected: [] });
  h.store.mockReset().mockResolvedValue(undefined);
  h.markOwn.mockReset().mockResolvedValue(undefined);
});

describe("useNostrPublish outbox conflict boundary", () => {
  it("aborts before onSigned or network when a cohort-safe rewrite needs a reread", async () => {
    h.queue.mockRejectedValue(new PublishOutboxConflictError());
    const onSigned = vi.fn();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { result } = renderHook(() => useNostrPublish(), { wrapper: Wrapper });

    await act(async () => {
      await expect(result.current.mutateAsync({
        kind: 30078,
        content: "encrypted",
        tags: [["d", "armada/test"]],
        relays: ["wss://answered.example"],
        inheritPendingTargets: false,
        onSigned,
      })).rejects.toBeInstanceOf(PublishOutboxConflictError);
    });

    expect(onSigned).not.toHaveBeenCalled();
    expect(h.fanout).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
  });
});
