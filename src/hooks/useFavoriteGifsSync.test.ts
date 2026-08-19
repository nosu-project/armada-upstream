import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { describe, expect, it, vi } from "vitest";

import { signCurrentFavoriteGifEvents } from "@/hooks/useFavoriteGifsSync";
import {
  FAVORITE_GIFS_EVENT_KIND,
  FAVORITE_GIFS_EVENT_TAG,
  FAVORITE_GIFS_D_PREFIX,
  type FavoriteGifRecord,
  type FavoriteGifShard,
} from "@/hooks/useFavoriteGifs";

import type { NostrEvent, NostrSigner } from "@nostrify/nostrify";

const SECRET = new Uint8Array(32).fill(8);
const SELF = getPublicKey(SECRET);

function record(id: string, updatedAt: number): FavoriteGifRecord {
  return {
    gif: {
      id,
      title: id,
      url: `https://example.com/${id}.gif`,
      width: 10,
      height: 10,
    },
    favorite: true,
    updatedAt,
    operationId: `${updatedAt}:${id}`,
  };
}

function signedShard(shard: FavoriteGifShard, createdAt: number): NostrEvent {
  return finalizeEvent({
    kind: FAVORITE_GIFS_EVENT_KIND,
    content: JSON.stringify(shard),
    tags: [
      ["d", `${FAVORITE_GIFS_D_PREFIX}${shard.deviceId}`],
      ["t", FAVORITE_GIFS_EVENT_TAG],
    ],
    created_at: createdAt,
  }, SECRET);
}

describe("explicit favorite GIF consolidation", () => {
  it("repairs a departed device's newer partial head with an older richer edition", async () => {
    const first = record("first", 1);
    const second = record("second", 2);
    const older: FavoriteGifShard = {
      version: 1,
      deviceId: "departed-device",
      records: [first],
    };
    const newer = { ...older, records: [second] };
    const signEvent = vi.fn(async (template: Omit<NostrEvent, "id" | "pubkey" | "sig">) => ({
      ...template,
      id: "e".repeat(64),
      pubkey: SELF,
      sig: "1".repeat(128),
    }));
    const signer = {
      getPublicKey: async () => SELF,
      signEvent,
      nip44: {
        decrypt: async (_pubkey: string, content: string) => content,
        encrypt: async (_pubkey: string, content: string) => `encrypted:${content}`,
      },
    } as unknown as NostrSigner;

    const signed = await signCurrentFavoriteGifEvents([
      signedShard(newer, 200),
      signedShard(older, 100),
    ], signer, SELF);

    expect(signed).toHaveLength(1);
    const shard = JSON.parse(signed[0]!.content.replace(/^encrypted:/, "")) as FavoriteGifShard;
    expect(shard.deviceId).toBe("departed-device");
    expect(shard.records.map((entry) => entry.gif.id).sort()).toEqual(["first", "second"]);
    expect(signed[0]!.created_at).toBeGreaterThan(200);
  });
});
