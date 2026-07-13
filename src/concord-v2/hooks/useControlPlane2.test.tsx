/**
 * Regression test for issue #19 (companion to useChannel2.test.tsx) — the
 * control-plane `since`-cursor skip.
 *
 * `useControlEvents2` persists a per-community cursor and refetches with
 * `since: cursor.newest`. The cursor advances to the newest edition seen in
 * ANY round — so an edition with an OLDER `created_at` that only becomes
 * visible later (a relay that was down/slow during the first fetch) is never
 * matched by any subsequent filter and is skipped forever. A missed channel or
 * rekey edition leaves the chat plane without the key/epoch it needs, so a
 * notified message can be permanently undecryptable in the UI.
 *
 * The test asserts the DESIRED behavior (a late-arriving older edition is
 * eventually fetched), so it fails until the bug is fixed.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { EventTemplate, NostrEvent } from "nostr-tools/pure";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { ReactNode } from "react";

import { foldTimeline, type OpenedChat } from "@/concord-v2/lib/chat";
import {
  buildBanlistEdition,
  buildMetadataEdition,
  foldControlState,
  openControlEditions,
  openControlWraps,
  sealEdition,
} from "@/concord-v2/lib/control";
import { bytesToHex, controlGroupKey } from "@/concord-v2/lib/derive";
import { KIND_MESSAGE, KIND_SEAL_ENCRYPTED, KIND_SEAL_PLAINTEXT } from "@/concord-v2/lib/kinds";
import { buildRumor, sealRumor, wrapSeal, type Rumor } from "@/concord-v2/lib/stream";
import type { CommunityV2 } from "@/concord-v2/lib/types";

import { useControlEvents2 } from "./useControlPlane2";

import { _configureAuthWaitForTests } from "@/concord-v2/lib/planeSync";

// These tests exercise the cursor discipline, not planeSync's NIP-42 auth
// gate (planeSync.test.ts owns that) — let the sweeps' REQs fly immediately.
beforeAll(() => {
  _configureAuthWaitForTests({ maxWaitMs: 0 });
});

// ── Module mocks ─────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({ pool: undefined as unknown }));

vi.mock("@nostrify/react", () => ({
  useNostr: () => ({ nostr: h.pool }),
}));
vi.mock("@/concord-v2/hooks/useDeferredFold2", () => ({
  useDeferredFold: () => undefined,
}));

// ── Fake relay ───────────────────────────────────────────────────────────────

interface Filter {
  kinds?: number[];
  authors?: string[];
  since?: number;
  until?: number;
  limit?: number;
}

class FakeRelay {
  events: NostrEvent[] = [];
  queries: Filter[] = [];
  online = true;

  async query(filters: Filter[]): Promise<NostrEvent[]> {
    this.queries.push(...filters);
    if (!this.online) throw new Error("relay offline");
    const out = new Map<string, NostrEvent>();
    for (const f of filters) {
      for (const ev of this.events) {
        const ok =
          (!f.kinds || f.kinds.includes(ev.kind)) &&
          (!f.authors || f.authors.includes(ev.pubkey)) &&
          (f.since === undefined || ev.created_at >= f.since) &&
          (f.until === undefined || ev.created_at <= f.until);
        if (ok) out.set(ev.id, ev);
      }
    }
    return [...out.values()].sort((a, b) => b.created_at - a.created_at).slice(0, filters[0]?.limit);
  }

  /** Live subscription: emits nothing, parks until aborted. */
  // eslint-disable-next-line require-yield
  async *req(_filters: Filter[], opts?: { signal?: AbortSignal }): AsyncGenerator<unknown> {
    await new Promise<void>((resolve) => {
      if (opts?.signal?.aborted) return resolve();
      opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  }

  async event(): Promise<void> {}
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const RELAY_A = "wss://relay-a.test";
const RELAY_B = "wss://relay-b.test";

function signer(sk = generateSecretKey()) {
  return { sk, pubkey: getPublicKey(sk), signEvent: async (t: EventTemplate) => finalizeEvent(t, sk) };
}

/** A control-plane edition wrap with a controlled outer `created_at`. */
async function editionWrapAt(
  control: ReturnType<typeof controlGroupKey>,
  s: ReturnType<typeof signer>,
  eid: string,
  createdAt: number,
): Promise<{ wrap: NostrEvent; rumor: Rumor }> {
  const rumor = buildRumor({
    kind: 3308,
    content: "{}",
    tags: [["vsk", "0"], ["eid", eid], ["ev", "1"]],
    pubkey: s.pubkey,
    ms: null,
    createdAtSecs: createdAt,
  });
  const seal = await sealRumor(rumor, KIND_SEAL_PLAINTEXT, control, s);
  const w = wrapSeal(seal, control);
  const wrap = finalizeEvent(
    { kind: w.kind, content: w.content, tags: w.tags, created_at: createdAt },
    control.sk,
  );
  return { wrap, rumor };
}

function makeWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
}

// ── Test ─────────────────────────────────────────────────────────────────────

describe("useControlEvents2 — issue #19 (since-cursor skips a late-arriving older edition)", () => {
  it("fetches an older edition that only becomes visible after the cursor has advanced", { timeout: 30_000 }, async () => {
    const root = new Uint8Array(32).fill(21);
    const id = new Uint8Array(32).fill(22);
    const control = controlGroupKey(root, id, 0);
    const owner = signer();
    const community = {
      id,
      idHex: bytesToHex(id),
      owner: owner.pubkey,
      ownerSalt: new Uint8Array(32),
      root,
      rootEpoch: 0n,
      heldRoots: [{ epoch: 0n, key: root }],
      privateChannels: [],
      relays: [RELAY_A, RELAY_B],
      name: "test",
    } as CommunityV2;

    const now = Math.floor(Date.now() / 1000);
    // E1 is OLDER and lives only on relay B (down during the first fetch).
    const e1 = await editionWrapAt(control, owner, "ab".repeat(32), now - 5000);
    // E2 is newer and lives on relay A.
    const e2 = await editionWrapAt(control, owner, "cd".repeat(32), now - 1000);

    const relayA = new FakeRelay();
    relayA.events = [e2.wrap];
    const relayB = new FakeRelay();
    relayB.online = false; // down for the first round
    relayB.events = [e1.wrap];
    h.pool = { relay: (url: string) => (url === RELAY_A ? relayA : relayB) };

    const { queryClient, wrapper } = makeWrapper();
    const { result } = renderHook(() => useControlEvents2(community), { wrapper });

    // First round: E2 lands, and the persisted cursor advances to E2's time.
    await waitFor(
      () => {
        expect((result.current.data ?? []).map((e) => e.rumorId)).toContain(e2.rumor.id);
      },
      { timeout: 10_000 },
    );

    // Relay B comes back, carrying the older edition E1.
    relayB.online = true;

    // A later refetch must pick E1 up — an edition chain is append-only and a
    // member who misses one (e.g. a rekey or channel definition) can't decrypt
    // what depends on it. (Bug: the refetch filters `since: cursor.newest`,
    // which is E2's created_at; E1 is older, matches nothing, and is skipped
    // forever.)
    await queryClient.invalidateQueries({ queryKey: ["concord2", "control", community.idHex] });
    await waitFor(
      () => {
        expect((result.current.data ?? []).map((e) => e.rumorId)).toContain(e1.rumor.id);
      },
      { timeout: 8_000 },
    );
  });

  it(
    "an unban edition arriving late from a lagging relay still unbans — the author's messages must render",
    { timeout: 30_000 },
    async () => {
      // End-to-end for the "top-level messages never render" symptom:
      //   1. bob is banned (banlist v1), then unbanned (banlist v2).
      //   2. v2 lives only on a lagging relay; meanwhile a NEWER unrelated
      //      edition (metadata) advances the since-cursor past v2's timestamp.
      //   3. The lagging relay comes back — but every poll now filters
      //      `since > v2.created_at`, so v2 is never fetched.
      //   4. The local fold keeps bob banned forever; foldTimeline silently
      //      drops every one of bob's messages at render (chat.ts banned
      //      check) — decoded, in memory, invisible. Other clients with the
      //      complete chain render them fine.
      const root = new Uint8Array(32).fill(31);
      const id = new Uint8Array(32).fill(32);
      const control = controlGroupKey(root, id, 0);
      const owner = signer();
      const bob = signer();
      const community = {
        id,
        idHex: bytesToHex(id),
        owner: owner.pubkey,
        ownerSalt: new Uint8Array(32),
        root,
        rootEpoch: 0n,
        heldRoots: [{ epoch: 0n, key: root }],
        privateChannels: [],
        relays: [RELAY_A, RELAY_B],
        name: "test",
      } as CommunityV2;

      const now = Math.floor(Date.now() / 1000);

      /** Seal + wrap an edition rumor, re-stamping the wrap at the rumor's time. */
      const wrapEdition = async (rumor: Rumor): Promise<NostrEvent> => {
        const w = await sealEdition(rumor, control, owner);
        return finalizeEvent(
          { kind: w.kind, content: w.content, tags: w.tags, created_at: rumor.created_at },
          control.sk,
        );
      };

      // v1: ban bob (on both relays).
      const banRumor = buildBanlistEdition(id, [bob.pubkey], {
        actorPubkey: owner.pubkey,
        version: 1n,
        createdAtSecs: now - 8000,
      });
      const banWrap = await wrapEdition(banRumor);
      const [banParsed] = openControlWraps([banWrap], [control]);

      // v2: UNban bob (chained on v1) — only on the lagging relay B.
      const unbanRumor = buildBanlistEdition(id, [], {
        actorPubkey: owner.pubkey,
        version: 2n,
        prevHash: banParsed.selfHash,
        createdAtSecs: now - 5000,
      });
      const unbanWrap = await wrapEdition(unbanRumor);

      // A newer, unrelated edition (metadata) that advances the cursor past v2.
      const metaRumor = buildMetadataEdition(
        id,
        { name: "fleet", relays: [] },
        { actorPubkey: owner.pubkey, version: 1n, createdAtSecs: now - 1000 },
      );
      const metaWrap = await wrapEdition(metaRumor);

      const relayA = new FakeRelay();
      relayA.events = [banWrap, metaWrap];
      const relayB = new FakeRelay();
      relayB.online = false; // lagging during the first round
      relayB.events = [banWrap, unbanWrap, metaWrap];
      h.pool = { relay: (url: string) => (url === RELAY_A ? relayA : relayB) };

      const { queryClient, wrapper } = makeWrapper();
      const { result } = renderHook(() => useControlEvents2(community), { wrapper });

      // First round: ban + metadata land from relay A; the cursor advances to
      // the metadata edition's created_at.
      await waitFor(
        () => {
          expect((result.current.data ?? []).map((e) => e.rumorId)).toContain(metaRumor.id);
        },
        { timeout: 10_000 },
      );

      // The lagging relay comes back with the unban.
      relayB.online = true;
      await queryClient.invalidateQueries({ queryKey: ["concord2", "control", community.idHex] });

      // One of bob's ordinary top-level chat messages (decoded fine, in memory).
      const bobMsg: OpenedChat = {
        rumorId: "9".repeat(64),
        author: bob.pubkey,
        kind: KIND_MESSAGE,
        content: "hello from bob",
        tags: [],
        ms: (now - 100) * 1000,
        createdAt: now - 100,
        wrapId: "8".repeat(64),
        streamPk: "7".repeat(64),
        sealKind: KIND_SEAL_ENCRYPTED,
        seal: {} as NostrEvent,
        channelIdHex: "6".repeat(64),
        epoch: 0n,
      };

      // Desired: the fold picks up the unban and bob's message renders. (Bug:
      // v2 is never fetched — `since` sits past it — so bob stays banned and
      // foldTimeline drops the message on every device with this fold.)
      await waitFor(
        () => {
          const fold = foldControlState(openControlEditions(result.current.data ?? []), id, owner.pubkey);
          const timeline = foldTimeline([bobMsg], { banned: fold.banned, canDelete: () => false });
          expect(
            timeline.messages.map((m) => m.content),
            "bob was unbanned, but the stale local fold still drops his messages",
          ).toContain("hello from bob");
        },
        { timeout: 8_000 },
      );
    },
  );
});
