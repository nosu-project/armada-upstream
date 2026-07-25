/**
 * The fold snapshot cache's write notification.
 *
 * The wire builds its subscription spec from PERSISTED folds, not a live one,
 * and its query key moves only on a new community, a rotated epoch, or a
 * channel-count change. A control edition that alters none of those — attaching
 * a repository, renaming a channel — would otherwise leave the spec stale until
 * its own two-minute poll, so the write itself has to be observable.
 */

import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";

import { onFoldedWrite, readFolded, writeFolded } from "./foldedCache";

beforeEach(() => {
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
});

describe("onFoldedWrite", () => {
  it("notifies subscribers with the written key, and stops after unsubscribe", async () => {
    const seen: string[] = [];
    const unsubscribe = onFoldedWrite((key) => seen.push(key));

    await writeFolded("concord2-fold:abc", { channels: [] });
    expect(seen).toEqual(["concord2-fold:abc"]);
    // The value is still readable — notification is not a substitute for the write.
    await expect(readFolded("concord2-fold:abc")).resolves.toEqual({ channels: [] });

    unsubscribe();
    await writeFolded("concord2-fold:def", { channels: [] });
    expect(seen).toEqual(["concord2-fold:abc"]);
  });

  it("a throwing subscriber never breaks the write or its siblings", async () => {
    const seen: string[] = [];
    const unsubThrower = onFoldedWrite(() => {
      throw new Error("subscriber blew up");
    });
    const unsubGood = onFoldedWrite((key) => seen.push(key));

    await expect(writeFolded("concord2-fold:xyz", { ok: true })).resolves.toBeUndefined();
    await expect(readFolded("concord2-fold:xyz")).resolves.toEqual({ ok: true });
    expect(seen).toEqual(["concord2-fold:xyz"]);

    unsubThrower();
    unsubGood();
  });
});
