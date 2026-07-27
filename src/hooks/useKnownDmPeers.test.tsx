/**
 * The known-vs-request predicate is the single line between the DM inbox and
 * the request tier, and it's consumed by four surfaces (the list, the request
 * list, the rail's unread dot, the thread's accept banner). If any of them
 * disagreed about a peer, a conversation would show in both lists or in
 * neither — and the rail could light for a row the list won't show.
 *
 * These pin the four ways in, and the fail-closed default.
 */

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useKnownDmPeers } from "@/hooks/useKnownDmPeers";

const FOLLOWED = "a".repeat(64);
const ACCEPTED = "b".repeat(64);
const PINNED = "c".repeat(64);
const STRANGER = "d".repeat(64);

const h = vi.hoisted(() => ({
  follows: [] as string[],
  followsLoading: false,
  accepted: [] as string[],
  pinned: [] as string[],
}));

vi.mock("@/hooks/useFollowList", () => ({
  useFollowList: () => ({
    data: { pubkeys: h.follows },
    isLoading: h.followsLoading,
  }),
}));
vi.mock("@/hooks/useAcceptedDms", () => ({
  useAcceptedDms: () => ({
    accepted: h.accepted,
    isAccepted: (p: string) => h.accepted.includes(p),
    accept: vi.fn(),
  }),
}));
vi.mock("@/hooks/usePinnedDms", () => ({
  usePinnedDms: () => ({
    pinned: h.pinned,
    isPinned: (p: string) => h.pinned.includes(p),
    pin: vi.fn(),
    unpin: vi.fn(),
    togglePin: vi.fn(),
  }),
}));

describe("useKnownDmPeers", () => {
  beforeEach(() => {
    h.follows = [FOLLOWED];
    h.followsLoading = false;
    h.accepted = [ACCEPTED];
    h.pinned = [PINNED];
  });

  it("admits followed, accepted and pinned peers", () => {
    const { result } = renderHook(() => useKnownDmPeers());
    expect(result.current.isKnown(FOLLOWED, false)).toBe(true);
    expect(result.current.isKnown(ACCEPTED, false)).toBe(true);
    expect(result.current.isKnown(PINNED, false)).toBe(true);
  });

  it("admits anyone the viewer has written to, whoever they are", () => {
    const { result } = renderHook(() => useKnownDmPeers());
    expect(result.current.isKnown(STRANGER, true)).toBe(true);
  });

  it("classifies an unsolicited stranger as a request", () => {
    const { result } = renderHook(() => useKnownDmPeers());
    expect(result.current.isKnown(STRANGER, false)).toBe(false);
  });

  it("fails closed while the follow list is still loading", () => {
    // An unresolved follow list must not promote strangers into the inbox;
    // callers gate on `isLoading` and paint the snapshot instead.
    h.follows = [];
    h.followsLoading = true;
    const { result } = renderHook(() => useKnownDmPeers());
    expect(result.current.isLoading).toBe(true);
    expect(result.current.isKnown(FOLLOWED, false)).toBe(false);
  });

  it("keeps a replied-to peer known after they are unfollowed", () => {
    // The accepted set is sticky by design — it must outlive a change in the
    // follow graph, exactly like a pin.
    h.follows = [];
    const { result } = renderHook(() => useKnownDmPeers());
    expect(result.current.isKnown(ACCEPTED, false)).toBe(true);
  });
});
