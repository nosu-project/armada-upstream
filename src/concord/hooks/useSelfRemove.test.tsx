/**
 * The kickee's compliant self-removal must not wait on the vault write.
 *
 * `useSelfRemove` decides the verdict (a kick against my own npub, surviving a
 * confirming refetch), then tears the local view down: `removeQueries`, a
 * toast, and `onRemoved` (the route-away). The DURABLE half — writing the
 * private Community List vault so the user's OTHER devices don't resurrect the
 * entry — is a full read-modify-write over the network (a fragment read that
 * waits on a possibly NIP-42-gated account-state relay, then a publish).
 *
 * That vault write used to gate the visible teardown: `onRemoved` fired only in
 * the mutation's `.then()`. So a kickee whose member list had already flipped to
 * `kick` sat in the room for as long as the vault RMW took — the residual
 * several-seconds delay on the kickee's side. This pins that the route-away
 * fires WITHOUT the vault write resolving.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ReactNode } from "react";

import { bytesToHex } from "@/concord/lib/derive";
import { addToList, isLive, EMPTY_COMMUNITY_LIST, type JoinMaterial } from "@/concord/lib/communityList";
import type { FoldedControl } from "@/concord/lib/control";
import type { CoalescedMember } from "@/concord/lib/guestbook";
import type { ListData } from "@/concord/hooks/useCommunityList";
import type { Community } from "@/concord/lib/types";

// ── Module mocks ─────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  user: undefined as { pubkey: string } | undefined,
  folded: undefined as FoldedControl | undefined,
  coalesced: new Map<string, CoalescedMember>(),
  entry: undefined as { community_id: string; added_at: number } | undefined,
  guestbookRefetch: vi.fn(async () => {}),
  controlRefetch: vi.fn(async () => {}),
  updateList: vi.fn(),
  toasts: [] as unknown[],
}));

vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: h.user }) }));
vi.mock("@/concord/hooks/useControlPlane", () => ({
  useControlFold: () => ({ data: h.folded, isLoading: false, isFetching: false, refetch: h.controlRefetch }),
}));
vi.mock("@/concord/hooks/useGuestbook", () => ({
  useGuestbook: () => ({
    coalesced: h.coalesced,
    isLoading: false,
    isFetching: false,
    refetch: h.guestbookRefetch,
  }),
}));
vi.mock("@/concord/hooks/useCommunityList", () => ({
  useCommunityEntry: () => h.entry,
  useUpdateCommunityList: () => ({ mutateAsync: h.updateList }),
  listQueryKey: (pubkey: string | undefined) => ["concord", "list", pubkey],
}));
vi.mock("@/hooks/useToast", () => ({ toast: (t: unknown) => h.toasts.push(t) }));

import { useSelfRemove } from "./useSelfRemove";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const owner = getPublicKey(generateSecretKey());
const self = getPublicKey(generateSecretKey());
const communityId = new Uint8Array(32).fill(211);

function community(): Community {
  return {
    id: communityId,
    idHex: bytesToHex(communityId),
    owner,
    ownerSalt: new Uint8Array(32),
    root: new Uint8Array(32).fill(9),
    rootEpoch: 0n,
    heldRoots: [{ epoch: 0n, key: new Uint8Array(32).fill(9) }],
    privateChannels: [],
    relays: ["wss://relay.test"],
    name: "test",
  } as unknown as Community;
}

function foldedFor(): FoldedControl {
  return {
    roster: { roles: [], grants: [] },
    ownerHex: owner,
    banned: new Set<string>(),
    headEditions: new Map(),
  } as unknown as FoldedControl;
}

function jm(): JoinMaterial {
  return {
    community_id: bytesToHex(communityId),
    owner,
    owner_salt: bytesToHex(new Uint8Array(32)),
    community_root: bytesToHex(new Uint8Array(32).fill(9)),
    root_epoch: 0,
    channels: [],
    relays: ["wss://relay.test"],
    name: "test",
  } as unknown as JoinMaterial;
}

/** A fresh client seeded with a LIVE list entry for the community, exposed so a
 *  test can read the cache the hook's optimistic tombstone writes to. */
function makeClient(): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const material = jm();
  const list = addToList(EMPTY_COMMUNITY_LIST, {
    community_id: bytesToHex(communityId),
    seed: material,
    current: material,
    added_at: 1_000,
  });
  client.setQueryData<ListData>(["concord", "list", self], { event: null, list });
  return client;
}

function wrapperFor(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  h.user = { pubkey: self };
  h.folded = foldedFor();
  h.entry = { community_id: bytesToHex(communityId), added_at: 1_000 };
  // My coalesced state is `kick`, postdating my membership → verdict "kick".
  h.coalesced = new Map<string, CoalescedMember>([
    [self, { pubkey: self, state: "kick", ms: 2_000, rumorId: "a".repeat(64), fromSnapshot: false }],
  ]);
  h.guestbookRefetch = vi.fn(async () => {});
  h.controlRefetch = vi.fn(async () => {});
  h.toasts = [];
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── Test ─────────────────────────────────────────────────────────────────────

describe("useSelfRemove", () => {
  it("routes away, toasts, and tombstones the rail entry WITHOUT waiting on the vault write", async () => {
    // The vault write is HELD — a slow / unconfirmed relay RMW. Nothing about
    // the local teardown may depend on it settling.
    let releaseWrite: (() => void) | undefined;
    h.updateList.mockReturnValue(new Promise<void>((resolve) => {
      releaseWrite = resolve;
    }));

    const client = makeClient();
    // The rail entry is LIVE going in.
    expect(isLive(client.getQueryData<ListData>(["concord", "list", self])!.list, bytesToHex(communityId))).toBe(true);

    const onRemoved = vi.fn();
    const { rerender } = renderHook(() => useSelfRemove(community(), onRemoved), {
      wrapper: wrapperFor(client),
    });

    // First pass: the verdict forces one confirming guestbook refetch and returns.
    await waitFor(() => expect(h.guestbookRefetch).toHaveBeenCalledTimes(1));
    expect(onRemoved).not.toHaveBeenCalled();

    // Second pass (the confirming fetch has settled): fresh refetch identity so
    // the effect re-runs, and the verdict now survives.
    h.guestbookRefetch = vi.fn(async () => {});
    rerender();

    // Teardown is immediate — route-away, toast AND the rail-entry tombstone all
    // land while the vault write is still in flight (never released).
    await waitFor(() => expect(onRemoved).toHaveBeenCalledTimes(1));
    expect(h.toasts).toHaveLength(1);
    expect(h.updateList).toHaveBeenCalledWith({ type: "remove", communityId: bytesToHex(communityId) });
    // The rail icon drops NOW, optimistically — not on the vault RMW.
    expect(isLive(client.getQueryData<ListData>(["concord", "list", self])!.list, bytesToHex(communityId))).toBe(false);

    releaseWrite?.();
  });
});
