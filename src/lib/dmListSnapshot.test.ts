import { beforeEach, describe, expect, it } from "vitest";

import {
  pickEmojiTags,
  readDmListSnapshot,
  writeDmListSnapshot,
  type DmListSnapshotRow,
} from "@/lib/dmListSnapshot";

const SELF = "self-pubkey";

function rows(n: number): DmListSnapshotRow[] {
  return Array.from({ length: n }, (_, i) => ({
    peer: `peer-${i}`,
    eventId: `event-${i}`,
    createdAt: 1_000 - i, // newest first, matching render order
    author: i % 2 === 0 ? SELF : `peer-${i}`,
    preview: `message ${i}`,
    mine: i % 2 === 0,
  }));
}

describe("dmListSnapshot", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("round-trips the list in render order", () => {
    const list = rows(5);
    writeDmListSnapshot(SELF, list);
    expect(readDmListSnapshot(SELF)).toEqual(list);
  });

  it("keeps a row with no preview (undecrypted at write time)", () => {
    const list: DmListSnapshotRow[] = [
      { peer: "p1", createdAt: 10, author: "p1", mine: false },
    ];
    writeDmListSnapshot(SELF, list);
    expect(readDmListSnapshot(SELF)).toEqual(list);
  });

  it("is scoped per account", () => {
    writeDmListSnapshot(SELF, rows(2));
    expect(readDmListSnapshot("other-pubkey")).toBeUndefined();
  });

  it("returns undefined on miss / no pubkey", () => {
    expect(readDmListSnapshot(SELF)).toBeUndefined();
    expect(readDmListSnapshot(undefined)).toBeUndefined();
    writeDmListSnapshot(undefined, rows(3)); // no-op, no throw
  });

  it("caps stored rows, keeping the newest (head slice — the list is newest-first)", () => {
    writeDmListSnapshot(SELF, rows(150));
    const read = readDmListSnapshot(SELF);
    expect(read).toHaveLength(100);
    expect(read?.[0].peer).toBe("peer-0");
    expect(read?.at(-1)?.peer).toBe("peer-99");
  });

  it("an empty settled list clears the snapshot rather than restoring stale rows", () => {
    writeDmListSnapshot(SELF, rows(3));
    writeDmListSnapshot(SELF, []);
    expect(readDmListSnapshot(SELF)).toBeUndefined();
  });

  it("round-trips emoji tags so a restored preview renders custom emoji", () => {
    const list: DmListSnapshotRow[] = [
      {
        peer: "p1",
        createdAt: 10,
        author: "p1",
        preview: "nice :blobwave:",
        emojiTags: [["emoji", "blobwave", "https://example.com/blobwave.png"]],
        mine: false,
      },
    ];
    writeDmListSnapshot(SELF, list);
    expect(readDmListSnapshot(SELF)).toEqual(list);
  });

  it("rejects a row whose emoji tags are malformed", () => {
    localStorage.setItem(
      `armada:dmlist:v1:${SELF}`,
      JSON.stringify([{ peer: "p1", createdAt: 1, author: "p1", mine: false, emojiTags: "nope" }]),
    );
    expect(readDmListSnapshot(SELF)).toBeUndefined();
  });

  describe("pickEmojiTags", () => {
    it("keeps only complete emoji tags", () => {
      expect(
        pickEmojiTags([
          ["p", "somepubkey"],
          ["emoji", "blobwave", "https://example.com/a.png"],
          ["emoji", "incomplete"],
          ["e", "someid"],
        ]),
      ).toEqual([["emoji", "blobwave", "https://example.com/a.png"]]);
    });

    it("is undefined when there are none, so the field is omitted", () => {
      expect(pickEmojiTags([["p", "somepubkey"]])).toBeUndefined();
      expect(pickEmojiTags([])).toBeUndefined();
      expect(pickEmojiTags(undefined)).toBeUndefined();
    });
  });

  it("rejects corrupt storage instead of throwing on the render path", () => {
    localStorage.setItem(`armada:dmlist:v1:${SELF}`, "not json");
    expect(readDmListSnapshot(SELF)).toBeUndefined();

    localStorage.setItem(`armada:dmlist:v1:${SELF}`, JSON.stringify({ not: "an array" }));
    expect(readDmListSnapshot(SELF)).toBeUndefined();
  });

  it("drops malformed rows but keeps well-formed ones", () => {
    localStorage.setItem(
      `armada:dmlist:v1:${SELF}`,
      JSON.stringify([
        { peer: "good", createdAt: 5, author: "good", mine: false },
        { peer: "no-timestamp", author: "x", mine: false },
        { createdAt: 1, author: "x", mine: false },
        null,
      ]),
    );
    expect(readDmListSnapshot(SELF)).toEqual([
      { peer: "good", createdAt: 5, author: "good", mine: false },
    ]);
  });
});
