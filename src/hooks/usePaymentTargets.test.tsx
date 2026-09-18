/**
 * Tests for the NIP-A3 payment-targets write path (kind 10133).
 *
 * `useUpdatePaymentTargets` is the authoring half of the "Accept Donations"
 * feature: it read-modify-writes the user's replaceable kind-10133 event,
 * serializing a validated target set to `payto` tags. These tests pin the wire
 * shape (payto + alt tags), the read-modify-write of prior `content`, the
 * logged-out guard, and the optimistic cache update / rollback.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useUpdatePaymentTargets } from "@/hooks/usePaymentTargets";
import { PAYMENT_TARGETS_KIND, type PaymentTarget } from "@/lib/paymentTargets";

import type { NostrRumor } from "@/lib/nostrRumor";
import type { ReactNode } from "react";

const SELF = "a".repeat(64);

const h = vi.hoisted(() => ({
  publish: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  fetchFresh: vi.fn<(...args: unknown[]) => Promise<NostrRumor | null>>(),
  user: undefined as unknown,
}));

vi.mock("@nostrify/react", () => ({
  useNostr: () => ({ nostr: {} }),
}));
vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ user: h.user }),
}));
vi.mock("@/hooks/useNostrPublish", () => ({
  useNostrPublish: () => ({ mutateAsync: h.publish }),
}));
vi.mock("@/lib/fetchFreshEvent", () => ({
  fetchFreshEvent: (...args: unknown[]) => h.fetchFresh(...args),
}));

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function rumor(partial: Partial<NostrRumor>): NostrRumor {
  return {
    id: "e".repeat(64),
    pubkey: SELF,
    created_at: 1,
    kind: PAYMENT_TARGETS_KIND,
    tags: [],
    content: "",
    ...partial,
  };
}

beforeEach(() => {
  h.publish.mockReset().mockResolvedValue(undefined);
  h.fetchFresh.mockReset().mockResolvedValue(null);
  h.user = { pubkey: SELF };
});

describe("useUpdatePaymentTargets", () => {
  it("serializes targets to payto tags and appends an alt tag", async () => {
    const client = new QueryClient();
    const { result } = renderHook(() => useUpdatePaymentTargets(), {
      wrapper: wrapper(client),
    });

    const targets: PaymentTarget[] = [
      { type: "monero", authority: "4".repeat(95) },
      { type: "lightning", authority: "you@example.com" },
    ];

    await result.current.mutateAsync(targets);

    expect(h.publish).toHaveBeenCalledTimes(1);
    const published = h.publish.mock.calls[0][0] as {
      kind: number;
      tags: string[][];
      content: string;
    };
    expect(published.kind).toBe(PAYMENT_TARGETS_KIND);
    // Registry order (lightning before monero) + trailing alt tag.
    expect(published.tags).toEqual([
      ["payto", "lightning", "you@example.com"],
      ["payto", "monero", "4".repeat(95)],
      ["alt", "Payment targets"],
    ]);
  });

  it("preserves prior event content and passes prev for read-modify-write", async () => {
    const prev = rumor({ content: "keep-me", created_at: 42 });
    h.fetchFresh.mockResolvedValue(prev);

    const client = new QueryClient();
    const { result } = renderHook(() => useUpdatePaymentTargets(), {
      wrapper: wrapper(client),
    });

    await result.current.mutateAsync([{ type: "ethereum", authority: "0x" + "a".repeat(40) }]);

    const published = h.publish.mock.calls[0][0] as { content: string; prev: NostrRumor };
    expect(published.content).toBe("keep-me");
    expect(published.prev).toBe(prev);
  });

  it("drops invalid targets before publishing", async () => {
    const client = new QueryClient();
    const { result } = renderHook(() => useUpdatePaymentTargets(), {
      wrapper: wrapper(client),
    });

    await result.current.mutateAsync([
      { type: "monero", authority: "not-a-monero-address" },
      { type: "lightning", authority: "you@example.com" },
    ]);

    const published = h.publish.mock.calls[0][0] as { tags: string[][] };
    expect(published.tags).toEqual([
      ["payto", "lightning", "you@example.com"],
      ["alt", "Payment targets"],
    ]);
  });

  it("rejects and does not publish when logged out", async () => {
    h.user = undefined;
    const client = new QueryClient();
    const { result } = renderHook(() => useUpdatePaymentTargets(), {
      wrapper: wrapper(client),
    });

    await expect(
      result.current.mutateAsync([{ type: "monero", authority: "4".repeat(95) }]),
    ).rejects.toThrow(/logged in/i);
    expect(h.publish).not.toHaveBeenCalled();
  });

  it("optimistically updates the read cache and invalidates on success", async () => {
    const client = new QueryClient();
    const key = ["payment-targets", SELF];
    client.setQueryData(key, [] as PaymentTarget[]);

    const { result } = renderHook(() => useUpdatePaymentTargets(), {
      wrapper: wrapper(client),
    });

    const targets: PaymentTarget[] = [{ type: "monero", authority: "4".repeat(95) }];
    await result.current.mutateAsync(targets);

    await waitFor(() => {
      expect(client.getQueryData<PaymentTarget[]>(key)).toEqual(targets);
    });
  });

  it("rolls the cache back to its snapshot when the publish fails", async () => {
    const existing: PaymentTarget[] = [{ type: "lightning", authority: "old@example.com" }];
    h.publish.mockRejectedValue(new Error("relay down"));

    const client = new QueryClient();
    const key = ["payment-targets", SELF];
    client.setQueryData(key, existing);

    const { result } = renderHook(() => useUpdatePaymentTargets(), {
      wrapper: wrapper(client),
    });

    await expect(
      result.current.mutateAsync([{ type: "monero", authority: "4".repeat(95) }]),
    ).rejects.toThrow("relay down");

    expect(client.getQueryData<PaymentTarget[]>(key)).toEqual(existing);
  });
});
