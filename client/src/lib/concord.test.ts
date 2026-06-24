import { describe, expect, it } from "vitest";

import {
  addToConcordList,
  canonicalJson,
  classifyAddInput,
  EMPTY_CONCORD_LIST,
  isConcordInvite,
  mergeConcordLists,
  parseConcordInvite,
  refreshConcordCurrent,
  removeFromConcordList,
  type ConcordKeyBundle,
  type ConcordList,
} from "@/lib/concord";

// ── invite link parsing ──────────────────────────────────────────────────────

describe("parseConcordInvite", () => {
  it("extracts the token from the URL fragment", () => {
    expect(parseConcordInvite("https://armada.example.com/invite#abc123token")).toEqual({
      token: "abc123token",
      relays: [],
    });
  });

  it("reads bootstrap relays from the query", () => {
    const invite = parseConcordInvite("https://x.io/invite?relays=wss://a.relay,wss://b.relay#tok");
    expect(invite?.token).toBe("tok");
    expect(invite?.relays).toEqual(["wss://a.relay", "wss://b.relay"]);
  });

  it("accepts a bare, domain-agnostic invite token", () => {
    const token = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
    expect(parseConcordInvite(token)).toEqual({ token, relays: [] });
    // A leading `#` (as copied from a URL fragment) is tolerated.
    expect(parseConcordInvite(`#${token}`)).toEqual({ token, relays: [] });
  });

  it("rejects non-invite paths, missing fragments, relay URLs, and free text", () => {
    expect(parseConcordInvite("https://x.io/somewhere#tok")).toBeUndefined();
    expect(parseConcordInvite("https://x.io/invite")).toBeUndefined();
    expect(parseConcordInvite("wss://relay.internal")).toBeUndefined();
    expect(parseConcordInvite("just some text")).toBeUndefined();
    expect(parseConcordInvite("relay.example.com")).toBeUndefined();
    expect(parseConcordInvite("short")).toBeUndefined();
    expect(parseConcordInvite("")).toBeUndefined();
  });

  it("isConcordInvite reflects parseConcordInvite", () => {
    expect(isConcordInvite("https://x.io/invite#tok")).toBe(true);
    expect(isConcordInvite("wss://relay.internal")).toBe(false);
  });
});

// ── unified add-input classification ─────────────────────────────────────────

describe("classifyAddInput", () => {
  it("classifies a Concord invite link", () => {
    const out = classifyAddInput("https://x.io/invite#abc123token");
    expect(out.kind).toBe("concord");
    if (out.kind === "concord") expect(out.invite.token).toBe("abc123token");
  });

  it("classifies a bare, domain-agnostic Concord token", () => {
    const token = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
    const out = classifyAddInput(token);
    expect(out.kind).toBe("concord");
    if (out.kind === "concord") expect(out.invite.token).toBe(token);
  });

  it("classifies a relay URL as nip29", () => {
    expect(classifyAddInput("wss://relay.internal")).toEqual({
      kind: "nip29",
      relay: "wss://relay.internal",
    });
  });

  it("classifies a bare relay hostname as nip29", () => {
    const out = classifyAddInput("relay.example.com");
    expect(out.kind).toBe("nip29");
    if (out.kind === "nip29") expect(out.relay).toBe("wss://relay.example.com");
  });

  it("returns unknown for empty input", () => {
    expect(classifyAddInput("")).toEqual({ kind: "unknown" });
    expect(classifyAddInput("   ")).toEqual({ kind: "unknown" });
  });
});

// ── membership-list merge ────────────────────────────────────────────────────

function bundle(communityId: string, epoch: number, name = communityId): ConcordKeyBundle {
  return { communityId, epoch, name, relays: ["wss://app.relay"], keys: { k: `${epoch}` } };
}

describe("mergeConcordLists", () => {
  it("keeps the freshest current and earliest seed per community", () => {
    const a: ConcordList = {
      entries: [{ communityId: "c1", seed: bundle("c1", 1), current: bundle("c1", 3), addedAt: 100 }],
      tombstones: [],
    };
    const b: ConcordList = {
      entries: [{ communityId: "c1", seed: bundle("c1", 0), current: bundle("c1", 5), addedAt: 200 }],
      tombstones: [],
    };
    const merged = mergeConcordLists(a, b);
    expect(merged.entries).toHaveLength(1);
    expect(merged.entries[0].current.epoch).toBe(5); // freshest
    expect(merged.entries[0].seed.epoch).toBe(0); // earliest
    expect(merged.entries[0].addedAt).toBe(100); // earliest add
  });

  it("is commutative — order does not change the bytes", () => {
    const a = addToConcordList(EMPTY_CONCORD_LIST, bundle("c2", 2), 100);
    const b = addToConcordList(EMPTY_CONCORD_LIST, bundle("c1", 1), 50);
    expect(canonicalJson(mergeConcordLists(a, b))).toBe(canonicalJson(mergeConcordLists(b, a)));
  });

  it("is idempotent", () => {
    const a = addToConcordList(EMPTY_CONCORD_LIST, bundle("c1", 1), 100);
    expect(canonicalJson(mergeConcordLists(a, a))).toBe(canonicalJson(a));
  });

  it("sorts entries and tombstones by community id", () => {
    let list = addToConcordList(EMPTY_CONCORD_LIST, bundle("zzz", 1), 1);
    list = addToConcordList(list, bundle("aaa", 1), 1);
    expect(list.entries.map((e) => e.communityId)).toEqual(["aaa", "zzz"]);
  });
});

describe("add / remove / resurrect (latest-action-wins)", () => {
  it("a removal after the add buries the entry", () => {
    let list = addToConcordList(EMPTY_CONCORD_LIST, bundle("c1", 1), 100);
    list = removeFromConcordList(list, "c1", 200);
    expect(list.entries).toHaveLength(0);
    expect(list.tombstones).toHaveLength(1);
  });

  it("an add newer than the removal resurrects (re-join), dropping the tombstone", () => {
    let list = removeFromConcordList(EMPTY_CONCORD_LIST, "c1", 100);
    list = addToConcordList(list, bundle("c1", 2), 200);
    expect(list.entries.map((e) => e.communityId)).toEqual(["c1"]);
    expect(list.tombstones).toHaveLength(0);
  });

  it("keeps the newest removal when two devices remove", () => {
    const a = removeFromConcordList(EMPTY_CONCORD_LIST, "c1", 100);
    const b = removeFromConcordList(EMPTY_CONCORD_LIST, "c1", 300);
    const merged = mergeConcordLists(a, b);
    expect(merged.tombstones[0].removedAt).toBe(300);
  });
});

describe("refreshConcordCurrent", () => {
  it("advances the current snapshot but leaves the seed", () => {
    let list = addToConcordList(EMPTY_CONCORD_LIST, bundle("c1", 1), 100);
    list = refreshConcordCurrent(list, bundle("c1", 4, "Renamed"));
    expect(list.entries[0].current.epoch).toBe(4);
    expect(list.entries[0].current.name).toBe("Renamed");
    expect(list.entries[0].seed.epoch).toBe(1);
  });

  it("does nothing for a community not in the list", () => {
    const list = refreshConcordCurrent(EMPTY_CONCORD_LIST, bundle("ghost", 9));
    expect(list.entries).toHaveLength(0);
  });
});
