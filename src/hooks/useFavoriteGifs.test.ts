import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  useFavoriteGifs,
  claimLegacyFavoriteGifs,
  completeLegacyFavoriteGifMigration,
  favoriteGifsDeviceId,
  getFavoriteGifRecords,
  hydrateFavoriteGifShards,
  LEGACY_FAVORITE_GIFS_KEY,
  loadOwnFavoriteGifShard,
  parseFavoriteGifShard,
  resetFavoriteGifsCache,
  subscribeFavoriteGifChanges,
  toggleFavoriteGif,
  type FavoriteGifRecord,
  type FavoriteGifShard,
} from "@/hooks/useFavoriteGifs";
import type { GifResult } from "@/hooks/useGifSearch";

vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ user: { pubkey: "a".repeat(64) } }),
}));

const SELF = "a".repeat(64);

function gif(id: string): GifResult {
  return {
    id,
    title: `GIF ${id}`,
    url: `https://media.example/${id}.gif`,
    width: 320,
    height: 180,
  };
}

function record(id: string, favorite: boolean, updatedAt: number, operationId = id): FavoriteGifRecord {
  return { gif: gif(id), favorite, updatedAt, operationId };
}

function shard(deviceId: string, records: FavoriteGifRecord[]): FavoriteGifShard {
  return { version: 1, deviceId, records };
}

beforeEach(async () => {
  localStorage.clear();
  // The shards live in ArmadaDB's KV now, which `localStorage.clear()` doesn't
  // touch — the reset is what isolates one case from the next.
  await resetFavoriteGifsCache();
  vi.restoreAllMocks();
});

describe("favorite GIF cross-device merge", () => {
  it("unions favorites contributed by different device shards", () => {
    hydrateFavoriteGifShards(SELF, [
      shard("phone", [record("phone-only", true, 10)]),
      shard("desktop", [record("desktop-only", true, 20)]),
    ]);

    expect(getFavoriteGifRecords(SELF).filter((entry) => entry.favorite).map((entry) => entry.gif.id))
      .toEqual(["desktop-only", "phone-only"]);
  });

  it("uses the newest per-GIF operation so unfavorites propagate", () => {
    hydrateFavoriteGifShards(SELF, [
      shard("phone", [record("same", true, 10, "add")]),
      shard("desktop", [record("same", false, 20, "remove")]),
    ]);

    expect(getFavoriteGifRecords(SELF)).toEqual([record("same", false, 20, "remove")]);
  });

  it("restores this installation's relay shard before its next rewrite", () => {
    const deviceId = favoriteGifsDeviceId(SELF);
    hydrateFavoriteGifShards(SELF, [shard(deviceId, [record("restored", true, 30)])]);

    expect(loadOwnFavoriteGifShard(SELF).records).toEqual([record("restored", true, 30)]);
    toggleFavoriteGif(SELF, gif("new"));
    expect(loadOwnFavoriteGifShard(SELF).records.map((entry) => entry.gif.id).sort())
      .toEqual(["new", "restored"]);
  });

  it("breaks same-clock conflicts deterministically on every device", async () => {
    const add = record("same", true, 10, "aaa");
    const remove = record("same", false, 10, "zzz");
    hydrateFavoriteGifShards(SELF, [shard("a", [add]), shard("b", [remove])]);
    expect(getFavoriteGifRecords(SELF)[0].favorite).toBe(false);

    await resetFavoriteGifsCache();
    localStorage.clear();
    hydrateFavoriteGifShards(SELF, [shard("b", [remove]), shard("a", [add])]);
    expect(getFavoriteGifRecords(SELF)[0].favorite).toBe(false);
  });
});

describe("legacy favorite GIF migration", () => {
  it("merges this device's old list with favorites already synced by another device", () => {
    localStorage.setItem(LEGACY_FAVORITE_GIFS_KEY, JSON.stringify([gif("old-local")]));
    hydrateFavoriteGifShards(SELF, [shard("other", [record("remote", true, 10)])]);

    expect(claimLegacyFavoriteGifs(SELF)).toEqual({ hadLegacy: true, changed: true });
    expect(getFavoriteGifRecords(SELF).filter((entry) => entry.favorite).map((entry) => entry.gif.id))
      .toEqual(["remote", "old-local"]);
    expect(loadOwnFavoriteGifShard(SELF).records.map((entry) => entry.gif.id)).toEqual(["old-local"]);

    // Keep the source until the encrypted shard is signed and placed in the
    // durable publish outbox; a signer cancellation must remain retryable.
    expect(localStorage.getItem(LEGACY_FAVORITE_GIFS_KEY)).not.toBeNull();
    completeLegacyFavoriteGifMigration();
    expect(localStorage.getItem(LEGACY_FAVORITE_GIFS_KEY)).toBeNull();
  });

  it("does not resurrect a GIF that already has a synced tombstone", () => {
    localStorage.setItem(LEGACY_FAVORITE_GIFS_KEY, JSON.stringify([gif("removed")]));
    hydrateFavoriteGifShards(SELF, [shard("other", [record("removed", false, 50)])]);

    expect(claimLegacyFavoriteGifs(SELF)).toEqual({ hadLegacy: true, changed: false });
    expect(getFavoriteGifRecords(SELF)[0].favorite).toBe(false);
    expect(loadOwnFavoriteGifShard(SELF).records).toEqual([]);
  });

  it("lets a post-sync unfavorite beat a late migration that missed it on first pull", () => {
    localStorage.setItem(LEGACY_FAVORITE_GIFS_KEY, JSON.stringify([gif("removed")]));
    claimLegacyFavoriteGifs(SELF);
    expect(getFavoriteGifRecords(SELF)[0].favorite).toBe(true);

    hydrateFavoriteGifShards(SELF, [shard("other", [record("removed", false, 50)])]);
    expect(getFavoriteGifRecords(SELF)[0].favorite).toBe(false);
  });
});

describe("local favorite GIF operations", () => {
  it("stores a tombstone and reports explicit changes to the sync owner", () => {
    const changed: string[] = [];
    const unsubscribe = subscribeFavoriteGifChanges((pubkey) => changed.push(pubkey));

    toggleFavoriteGif(SELF, gif("party"));
    toggleFavoriteGif(SELF, gif("party"));

    expect(getFavoriteGifRecords(SELF)[0]).toMatchObject({
      gif: { id: "party" },
      favorite: false,
    });
    expect(changed).toEqual([SELF, SELF]);
    unsubscribe();
  });

  it("can unfavorite a legacy entry before its first relay pull finishes", () => {
    localStorage.setItem(LEGACY_FAVORITE_GIFS_KEY, JSON.stringify([gif("legacy")]));
    toggleFavoriteGif(SELF, gif("legacy"));

    expect(getFavoriteGifRecords(SELF)[0]).toMatchObject({
      gif: { id: "legacy" },
      favorite: false,
    });
    expect(claimLegacyFavoriteGifs(SELF)).toEqual({ hadLegacy: true, changed: false });
  });

  it("validates decrypted shards before hydration", () => {
    const valid = shard(favoriteGifsDeviceId(SELF), [record("ok", true, 1)]);
    expect(parseFavoriteGifShard(valid)).toEqual(valid);
    expect(parseFavoriteGifShard({ ...valid, version: 2 })).toBeNull();
    expect(parseFavoriteGifShard({ ...valid, records: [{ nope: true }] })?.records).toEqual([]);
  });

  it("settles after the KV stores warm rather than re-rendering forever", async () => {
    let renders = 0;
    const { unmount } = renderHook(() => {
      renders++;
      return useFavoriteGifs();
    });

    // Let the warm land and any notify cascade play out.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    const settled = renders;

    // A mounted picker doing nothing must not keep re-rendering: the warm's
    // memo drop may fire once, but a miss after it must not re-arm it.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    expect(renders).toBe(settled);
    unmount();
  });
});
