import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { beforeEach, describe, expect, it } from "vitest";

import { signCurrentFavoriteGifEvents } from "@/hooks/useFavoriteGifsSync";
import {
  FAVORITE_GIFS_EVENT_KIND,
  FAVORITE_GIFS_EVENT_TAG,
  FAVORITE_GIFS_D_PREFIX,
  resetFavoriteGifsCache,
  type FavoriteGifDoc,
  type FavoriteGifRecord,
  type FavoriteGifShard,
} from "@/hooks/useFavoriteGifs";
import { settingsKeyring } from "@/lib/settingsKeys";

import type { NostrEvent, NostrSigner } from "@nostrify/nostrify";

const SECRET = new Uint8Array(32).fill(8);
const SELF = getPublicKey(SECRET);
const KEYRING = settingsKeyring("03".repeat(32));
const KEYS = { keyring: KEYRING, previous: [] };

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

/** The account signer, with an identity "encryption" for the legacy shards. */
const signer = {
  getPublicKey: async () => SELF,
  signEvent: async () => {
    throw new Error("the account key must not sign a derived document");
  },
  nip44: {
    decrypt: async (_pubkey: string, content: string) => content,
    encrypt: async (_pubkey: string, content: string) => content,
  },
} as unknown as NostrSigner;

async function decrypt(event: NostrEvent): Promise<FavoriteGifDoc> {
  const doc = KEYRING.gifFavorites;
  return JSON.parse(await doc.signer.nip44!.decrypt(doc.pubkey, event.content));
}

beforeEach(async () => {
  await resetFavoriteGifsCache();
});

describe("explicit favorite GIF consolidation", () => {
  it("folds every legacy shard edition into the one shared derived document", async () => {
    const older: FavoriteGifShard = { version: 1, deviceId: "departed-device", records: [record("first", 1)] };
    const newer = { ...older, records: [record("second", 2)] };
    const phone: FavoriteGifShard = { version: 1, deviceId: "phone", records: [record("third", 3)] };

    const signed = await signCurrentFavoriteGifEvents([
      signedShard(newer, 200),
      signedShard(older, 100),
      signedShard(phone, 150),
    ], { signer, pubkey: SELF, keys: KEYS });

    expect(signed).toHaveLength(1);
    expect(signed[0]!.pubkey).toBe(KEYRING.gifFavorites.pubkey);
    expect(signed[0]!.tags).toEqual([["d", KEYRING.gifFavorites.d]]);
    const doc = await decrypt(signed[0]!);
    expect(doc.version).toBe(2);
    expect(doc.records.map((entry) => entry.gif.id).sort()).toEqual(["first", "second", "third"]);
  });

  it("signs nothing when the shared document already holds everything", async () => {
    const first = await signCurrentFavoriteGifEvents(
      [signedShard({ version: 1, deviceId: "phone", records: [record("only", 1)] }, 100)],
      { signer, pubkey: SELF, keys: KEYS },
    );
    expect(await signCurrentFavoriteGifEvents(first, { signer, pubkey: SELF, keys: KEYS })).toEqual([]);
  });
});
