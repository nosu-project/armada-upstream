import { beforeEach, describe, expect, it } from "vitest";

import {
  readDmListSnapshot,
  writeDmListSnapshot,
  type DmListSnapshotRow,
} from "@/lib/dmListSnapshot";

const SELF = "self-pubkey";

function rows(n: number): DmListSnapshotRow[] {
  return Array.from({ length: n }, (_, i) => ({
    peer: `peer-${i}`,
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
