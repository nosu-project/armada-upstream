/**
 * syncCommunityList — the §8 fragment sync's write half: the reconcile.
 *
 * Seeding only covers an account whose fragment read is CONFIRMED empty. The
 * migration population this guards is the other half: an account whose Vector
 * client already seeded kind-33302 from ITS holds, while this device's
 * memberships were recorded under the retired single-event list and exist only
 * in the folded cache. The wire is non-empty, so the seed never fires — and
 * with no membership edit left to make, nothing else would ever publish them
 * (CORD-02 §8's stranding trap). The reconcile publishes the union whenever a
 * COMPLETE read yields different bytes than the wire, and stays silent once
 * converged.
 */

import { Buffer } from "node:buffer";

import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CommunityList, CommunityListEntry, JoinMaterial } from "@/concord/lib/communityList";
import { isLive } from "@/concord/lib/communityList";
import { fragment, parseFragList, serializeFragList, type FragList } from "@/concord/lib/listFrag";
import { KIND_COMMUNITY_LIST_FRAG } from "@/concord/lib/kinds";

import type { NostrRumor } from "@/lib/nostrRumor";
import type { NUser } from "@nostrify/react/login";

const h = vi.hoisted(() => ({
  readFolded: vi.fn(),
  writeFolded: vi.fn(),
}));
vi.mock("@/lib/foldedCache", () => ({
  readFolded: (...args: unknown[]) => h.readFolded(...args),
  writeFolded: (...args: unknown[]) => h.writeFolded(...args),
}));

const SELF = "ab".repeat(32);
const b64of = (hex: string) => Buffer.from(hex, "hex").toString("base64url");

/** Reversible fake NIP-44: ciphertext is `enc:` + plaintext. */
const nip44 = {
  encrypt: async (_pk: string, plaintext: string) => `enc:${plaintext}`,
  decrypt: async (_pk: string, ciphertext: string) => {
    if (!ciphertext.startsWith("enc:")) throw new Error("bad ciphertext");
    return ciphertext.slice(4);
  },
};

let idCounter = 0;
/** Globally unique ids — the fragment decrypt memo is module-level. */
const nextId = () => `${(++idCounter).toString(16).padStart(8, "0")}`.padEnd(64, "e");

const user = {
  pubkey: SELF,
  signer: {
    nip44,
    signEvent: async (t: { kind: number; content: string; tags: string[][]; created_at: number }) => ({
      ...t,
      id: nextId(),
      pubkey: SELF,
      sig: "f".repeat(128),
    }),
  },
} as unknown as NUser;

function jm(cidByte: string, name: string): JoinMaterial {
  return {
    community_id: cidByte.repeat(32),
    owner: "11".repeat(32),
    owner_salt: "22".repeat(32),
    community_root: "33".repeat(32),
    root_epoch: 0,
    channels: [],
    relays: ["wss://relay.example.com"],
    name,
  };
}

function entry(cidByte: string, name: string): CommunityListEntry {
  const m = jm(cidByte, name);
  return { community_id: m.community_id, seed: structuredClone(m), current: m, added_at: 1_719_800_000_000 };
}

function fragEvent(frag: FragList, index: number, createdAt = 1_722_000_000): NostrRumor {
  return {
    id: nextId(),
    pubkey: SELF,
    kind: KIND_COMMUNITY_LIST_FRAG,
    content: `enc:${serializeFragList(frag)}`,
    tags: [["d", String(index)]],
    created_at: createdAt,
  } as NostrRumor;
}

function fakeNostr(wire: NostrRumor[]) {
  const published: NostrRumor[] = [];
  return {
    published,
    nostr: {
      query: async () => wire,
      group: () => ({ query: async () => [] as NostrRumor[] }),
      relay: () => ({
        query: async () => [] as NostrRumor[],
        event: async () => undefined,
      }),
      event: async (e: NostrRumor) => {
        published.push(e);
      },
    },
  };
}

async function runSync(wire: NostrRumor[], localList: CommunityList | undefined) {
  const { syncCommunityList } = await import("./useCommunityList");
  h.readFolded.mockImplementation(async (key: string) =>
    key.startsWith("concord2-list:") && localList ? { event: null, list: localList } : undefined,
  );
  const { published, nostr } = fakeNostr(wire);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const data = await syncCommunityList(nostr, user, queryClient, undefined, ["wss://self.example.com"]);
  return { data, published };
}

beforeEach(() => {
  h.readFolded.mockReset();
  h.writeFolded.mockReset().mockResolvedValue(undefined);
});

describe("syncCommunityList — reconcile", () => {
  it("publishes the union when the folded cache holds memberships the wire lacks", async () => {
    // Vector seeded §8 from ITS holds (community B only); this device recorded
    // A under the retired single-event list. The union must reach the wire
    // without waiting for a membership edit that may never come.
    const wire = fragment({ entries: [entry("bb", "From Vector")], tombstones: [] }).map((f, i) => fragEvent(f, i));
    const local: CommunityList = { entries: [entry("aa", "From Old Armada"), entry("bb", "From Vector")], tombstones: [] };

    const { data, published } = await runSync(wire, local);

    expect(isLive(data.list, "aa".repeat(32))).toBe(true);
    expect(isLive(data.list, "bb".repeat(32))).toBe(true);
    expect(published.length).toBeGreaterThan(0);
    const republished = parseFragList(published[0].content.slice(4));
    const cids = republished.entries.map((e) => e.community_id);
    expect(cids).toContain(b64of("aa".repeat(32)));
    expect(cids).toContain(b64of("bb".repeat(32)));
    // Nothing re-stamped: the local entry keeps its own added_at.
    expect(republished.entries.every((e) => e.added_at === 1_719_800_000_000)).toBe(true);
  });

  it("unifies a DISJOINT split — each client's communities survive, neither clobbers", async () => {
    // The partial-migration split: Vector knows only B, this Armada knows only
    // A. The outcome must be the union on both sides — A published for Vector
    // to adopt, B adopted here and republished byte-unchanged, nothing lost.
    const wire = fragment({ entries: [entry("bb", "Vector Only")], tombstones: [] }).map((f, i) => fragEvent(f, i));
    const local: CommunityList = { entries: [entry("aa", "Armada Only")], tombstones: [] };

    const { data, published } = await runSync(wire, local);

    expect(isLive(data.list, "aa".repeat(32))).toBe(true); // mine kept
    expect(isLive(data.list, "bb".repeat(32))).toBe(true); // theirs adopted
    expect(published.length).toBeGreaterThan(0);
    const republished = parseFragList(published[0].content.slice(4));
    const cids = republished.entries.map((e) => e.community_id);
    expect(cids).toContain(b64of("aa".repeat(32)));
    expect(cids).toContain(b64of("bb".repeat(32)));
    // The adopted entry rides byte-identically: same snapshot, same added_at —
    // adoption is never re-authored, so Vector's copy can't lose a tiebreak to
    // a mangled echo of itself.
    const theirs = republished.entries.find((e) => e.community_id === b64of("bb".repeat(32)));
    const original = fragment({ entries: [entry("bb", "Vector Only")], tombstones: [] })[0].entries[0];
    expect(JSON.stringify(theirs)).toBe(JSON.stringify(original));
  });

  it("stays silent once converged — identical bytes publish nothing", async () => {
    const list: CommunityList = { entries: [entry("aa", "Same"), entry("bb", "Same2")], tombstones: [] };
    const wire = fragment(list).map((f, i) => fragEvent(f, i));

    const { data, published } = await runSync(wire, structuredClone(list));

    expect(isLive(data.list, "aa".repeat(32))).toBe(true);
    expect(published).toHaveLength(0);
  });

  it("a tombstone on the wire is honored, not resurrected by the old local copy", async () => {
    // The other client LEFT community A after this device's stale local copy
    // was written. The union keeps the tombstone; the reconcile must not
    // resurrect the membership (added_at is never re-stamped).
    const wireList: CommunityList = {
      entries: [entry("bb", "Kept")],
      tombstones: [{ community_id: "aa".repeat(32), removed_at: 1_722_000_000_000 }],
    };
    const wire = fragment(wireList).map((f, i) => fragEvent(f, i));
    const local: CommunityList = { entries: [entry("aa", "Left Elsewhere"), entry("bb", "Kept")], tombstones: [] };

    const { data, published } = await runSync(wire, local);

    expect(isLive(data.list, "aa".repeat(32))).toBe(false);
    for (const e of published) {
      const frag = parseFragList(e.content.slice(4));
      // The retired entry's snapshots stay off the wire; its tombstone rides.
      expect(frag.entries.map((x) => x.community_id)).not.toContain(b64of("aa".repeat(32)));
    }
  });

  it("a fragment declaring an insane frags count cannot wedge or crash the sync", async () => {
    // `frags` is wire-declared and only integer-checked: a corrupt fragment
    // declaring 2^40 must not allocate its way to a tab crash on every sync —
    // it reads as junk (incomplete → read-only), and the sync still returns.
    const [frag0] = fragment({ entries: [entry("bb", "Corrupt Count")], tombstones: [] });
    frag0.frags = 2 ** 40;
    const local: CommunityList = { entries: [entry("aa", "Local")], tombstones: [] };

    const { data, published } = await runSync([fragEvent(frag0, 0)], local);

    expect(isLive(data.list, "bb".repeat(32))).toBe(true); // still readable
    expect(published).toHaveLength(0); // never writable
  });

  it("a same-second collision resolves to the LOWEST event id, like the relay will", async () => {
    const [winnerFrag] = fragment({ entries: [entry("bb", "Winner")], tombstones: [] });
    const [loserFrag] = fragment({ entries: [entry("bb", "Loser")], tombstones: [] });
    const winner = { ...fragEvent(winnerFrag, 0, 1_722_000_000), id: "0".repeat(64) };
    const loser = { ...fragEvent(loserFrag, 0, 1_722_000_000), id: "f".repeat(64) };

    // Order of arrival must not matter.
    const a = await runSync([loser, winner], undefined);
    expect(a.data.list.entries[0]?.current.name).toBe("Winner");
    const b = await runSync([winner, loser], undefined);
    expect(b.data.list.entries[0]?.current.name).toBe("Winner");
  });

  it("a frags disagreement at equal age resolves to the LARGER count", async () => {
    // Index 0 (declaring 1) and index 2 (declaring 3) share a created_at. The
    // larger count governs — index 1 is missing, so the read is INCOMPLETE and
    // refuses to write. Resolving to the smaller count would instead call this
    // read complete and rewrite over the fragment we can't see.
    const [frag0] = fragment({ entries: [entry("bb", "B")], tombstones: [] });
    frag0.frags = 1;
    const [frag2] = fragment({ entries: [entry("cc", "C")], tombstones: [] });
    frag2.frags = 3;
    const wire = [fragEvent(frag0, 0, 1_722_000_000), fragEvent(frag2, 2, 1_722_000_000)];
    const local: CommunityList = { entries: [entry("aa", "Local")], tombstones: [] };

    const { published } = await runSync(wire, local);

    expect(published).toHaveLength(0);
  });

  it("a stale fossil index above the declared count is emptied in ONE pass", async () => {
    // Relays evicted the middle of an old lattice; a non-empty index 9
    // survives above declared=1. Left alone it is dormant, not inert — any
    // later growth past index 9 re-reads its stale memberships. The reconcile
    // must empty the ACTUAL read index now, not one count-step per sync.
    const [frag0] = fragment({ entries: [entry("bb", "Current")], tombstones: [] });
    const [fossil] = fragment({ entries: [entry("cc", "Fossil")], tombstones: [] });
    fossil.frags = 10;
    const wire = [fragEvent(frag0, 0, 1_722_000_100), fragEvent(fossil, 9, 1_722_000_000)];
    const local: CommunityList = { entries: [entry("aa", "Local")], tombstones: [] };

    const { published } = await runSync(wire, local);

    const nine = published.find((e) => e.tags.find((t) => t[0] === "d")?.[1] === "9");
    expect(nine).toBeDefined();
    expect(parseFragList(nine!.content.slice(4))).toEqual({ frags: 1, entries: [], tombstones: [], extra: {} });
  });

  it("publishes the TOP index first, so an interrupted grow never wedges completeness", async () => {
    // Ascending order is a deadlock: fragment 0 (declaring the new total)
    // lands, the network dies before the brand-new top index exists, and every
    // later read is incomplete forever — while the incomplete-read refusal
    // blocks the only write that could repair it.
    const entries: CommunityListEntry[] = [];
    for (let i = 0; i < 200; i++) {
      const cid = i.toString(16).padStart(2, "0").padStart(64, "0").slice(0, 64);
      const m = { ...jm("00", `community ${i}`), community_id: cid };
      entries.push({ community_id: cid, seed: structuredClone(m), current: m, added_at: 1_719_800_000_000 });
    }
    const local: CommunityList = { entries, tombstones: [] };
    const wire = fragment({ entries: [entries[0]], tombstones: [] }).map((f, i) => fragEvent(f, i));

    const { published } = await runSync(wire, local);

    const dTags = published.map((e) => Number(e.tags.find((t) => t[0] === "d")?.[1]));
    expect(dTags.length).toBeGreaterThan(1); // 200 memberships must span fragments
    const sorted = [...dTags].sort((a, b) => b - a);
    expect(dTags).toEqual(sorted); // descending — top index lands first
  });

  it("refuses to write over a SHORT read — the missing fragment may hold anything", async () => {
    // Fragment 0 declares a two-fragment List but index 1 never arrived; the
    // union knows more than what was read, and publishing would rewrite a set
    // we haven't fully seen (CORD-02 §8's one write refusal).
    const [frag0] = fragment({ entries: [entry("bb", "From Vector")], tombstones: [] });
    frag0.frags = 2;
    const wire = [fragEvent(frag0, 0)];
    const local: CommunityList = { entries: [entry("aa", "Local Only")], tombstones: [] };

    const { published } = await runSync(wire, local);

    expect(published).toHaveLength(0);
  });
});
