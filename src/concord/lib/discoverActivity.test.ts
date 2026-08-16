import { describe, expect, it } from "vitest";

import {
  activityByLinkSigner,
  discoverActivityBatches,
  discoverActivityFilters,
  discoverStreamAuthors,
} from "@/concord/lib/discoverActivity";
import {
  bytesToHex,
  channelGroupKey,
  communityIdOf,
  controlGroupKey,
  guestbookGroupKey,
  hex32,
  random32,
} from "@/concord/lib/derive";
import type { InviteBundle } from "@/concord/lib/invite";
import { KIND_WRAP } from "@/concord/lib/kinds";

function makeBundle(over: Partial<InviteBundle> = {}): InviteBundle {
  const owner = random32();
  const salt = random32();
  const root = random32();
  const id = communityIdOf(owner, salt);
  return {
    community_id: bytesToHex(id),
    owner: bytesToHex(owner),
    owner_salt: bytesToHex(salt),
    community_root: bytesToHex(root),
    root_epoch: 0,
    channels: [],
    relays: ["wss://relay.example/"],
    name: "Test",
    ...over,
  };
}

describe("discoverStreamAuthors", () => {
  it("includes guestbook + legacy control when control_pk is absent", () => {
    const bundle = makeBundle();
    const root = hex32(bundle.community_root);
    const id = hex32(bundle.community_id);
    const authors = discoverStreamAuthors(bundle);
    expect(authors).toContain(guestbookGroupKey(root, id, 0).pk);
    expect(authors).toContain(controlGroupKey(root, id, 0).pk);
  });

  it("prefers control_pk over the legacy control address", () => {
    const controlPk = bytesToHex(random32());
    const bundle = makeBundle({ control_pk: controlPk });
    const authors = discoverStreamAuthors(bundle);
    expect(authors).toContain(controlPk);
    const root = hex32(bundle.community_root);
    const id = hex32(bundle.community_id);
    expect(authors).not.toContain(controlGroupKey(root, id, 0).pk);
  });

  it("includes private channel stream authors from the bundle", () => {
    const chId = random32();
    const chKey = random32();
    const bundle = makeBundle({
      channels: [{ id: bytesToHex(chId), key: bytesToHex(chKey), epoch: 2, name: "secret" }],
    });
    expect(discoverStreamAuthors(bundle)).toContain(channelGroupKey(chKey, chId, 2).pk);
  });

  it("includes public channel streams when ids are supplied", () => {
    const chId = random32();
    const bundle = makeBundle();
    const authors = discoverStreamAuthors(bundle, { publicChannelIdHexes: [bytesToHex(chId)] });
    expect(authors).toContain(channelGroupKey(hex32(bundle.community_root), chId, 0).pk);
  });
});

describe("discoverActivityFilters", () => {
  it("emits one limit-1 wrap filter per target with authors", () => {
    const filters = discoverActivityFilters(
      [
        { linkSigner: "a", authors: ["11".repeat(32)], relays: ["wss://r/"] },
        { linkSigner: "b", authors: [], relays: ["wss://r/"] },
      ],
      1_700_000_000,
    );
    expect(filters).toEqual([
      { kinds: [KIND_WRAP], authors: ["11".repeat(32)], until: 1_700_000_000, limit: 1 },
    ]);
  });

  it("bounds the REQ at now — a link-holder can sign the guestbook stream", () => {
    // The guestbook group key derives from the bundle's own community_root, so
    // anyone who can read the listing can publish a wrap dated whenever they
    // like. Without `until` the relay would serve that as the newest wrap.
    const [filter] = discoverActivityFilters(
      [{ linkSigner: "a", authors: ["11".repeat(32)], relays: ["wss://r/"] }],
      1_700_000_000,
    );
    expect(filter.until).toBe(1_700_000_000);
  });
});

describe("discoverActivityBatches", () => {
  const authors = (n: string) => [n.repeat(32)];

  it("groups targets by relay set rather than querying the union", () => {
    const batches = discoverActivityBatches(
      [
        { linkSigner: "a", authors: authors("11"), relays: ["wss://one/"] },
        { linkSigner: "b", authors: authors("22"), relays: ["wss://two/"] },
        { linkSigner: "c", authors: authors("33"), relays: ["wss://one/"] },
      ],
      1_700_000_000,
    );
    expect(batches).toHaveLength(2);
    const one = batches.find((b) => b.relays.join() === "wss://one");
    const two = batches.find((b) => b.relays.join() === "wss://two");
    expect(one?.filters).toHaveLength(2);
    expect(two?.filters).toHaveLength(1);
    // wss://two/ is never asked about the communities it hosts nothing for.
    expect(two?.filters[0].authors).toEqual(authors("22"));
  });

  it("normalizes and sorts a relay set so spelling variants share one REQ", () => {
    const batches = discoverActivityBatches(
      [
        { linkSigner: "a", authors: authors("11"), relays: ["wss://one", "wss://two/"] },
        { linkSigner: "b", authors: authors("22"), relays: ["wss://two/", "wss://one/"] },
      ],
      1_700_000_000,
    );
    expect(batches).toHaveLength(1);
    expect(batches[0].filters).toHaveLength(2);
  });

  it("chunks so one REQ never carries more filters than relays accept", () => {
    const many = Array.from({ length: 45 }, (_, i) => ({
      linkSigner: `link${i}`,
      authors: [i.toString(16).padStart(2, "0").repeat(32)],
      relays: ["wss://one/"],
    }));
    const batches = discoverActivityBatches(many, 1_700_000_000);
    expect(batches.map((b) => b.filters.length)).toEqual([20, 20, 5]);
  });

  it("drops targets with no authors or no resolvable relay", () => {
    expect(
      discoverActivityBatches(
        [
          { linkSigner: "a", authors: [], relays: ["wss://one/"] },
          { linkSigner: "b", authors: authors("22"), relays: [] },
          { linkSigner: "c", authors: authors("33"), relays: ["not a relay"] },
        ],
        1_700_000_000,
      ),
    ).toEqual([]);
  });
});

describe("activityByLinkSigner", () => {
  it("keeps the newest wrap per link-signer", () => {
    const pk = "aa".repeat(32);
    const targets = [{ linkSigner: "link1", authors: [pk], relays: [] }];
    const out = activityByLinkSigner(
      targets,
      [
        { pubkey: pk, created_at: 100 },
        { pubkey: pk, created_at: 200 },
        { pubkey: "bb".repeat(32), created_at: 999 },
      ],
      1_000,
    );
    expect(out).toEqual({ link1: 200 });
  });

  it("ignores a future-dated wrap rather than pinning the card at 'Active now'", () => {
    const pk = "aa".repeat(32);
    const targets = [{ linkSigner: "link1", authors: [pk], relays: [] }];
    const out = activityByLinkSigner(
      targets,
      [
        { pubkey: pk, created_at: 500 },
        { pubkey: pk, created_at: 9_999_999_999 },
      ],
      1_000,
    );
    expect(out).toEqual({ link1: 500 });
  });

  it("reports nothing when every wrap is forged into the future", () => {
    const pk = "aa".repeat(32);
    expect(
      activityByLinkSigner([{ linkSigner: "link1", authors: [pk], relays: [] }], [
        { pubkey: pk, created_at: 9_999_999_999 },
      ], 1_000),
    ).toEqual({});
  });
});
