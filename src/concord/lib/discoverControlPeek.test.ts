import { describe, expect, it } from "vitest";

import {
  controlViewFromBundle,
  summarizeDiscoverChannels,
  readCachedControlPeek,
} from "@/concord/lib/discoverControlPeek";
import { getArmadaDB } from "@/lib/db/armadaDB";
import {
  bytesToHex,
  communityIdOf,
  controlGroupKey,
  hex32,
  random32,
} from "@/concord/lib/derive";
import type { InviteBundle } from "@/concord/lib/invite";

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

describe("controlViewFromBundle", () => {
  it("uses control_pk as a restricted read address when present", () => {
    const controlPk = bytesToHex(random32());
    const view = controlViewFromBundle(makeBundle({ control_pk: controlPk }));
    expect(view?.pk).toBe(controlPk);
    expect(view?.restricted).toBe(true);
  });

  it("falls back to the legacy control group key address", () => {
    const bundle = makeBundle();
    const view = controlViewFromBundle(bundle);
    expect(view?.pk).toBe(
      controlGroupKey(hex32(bundle.community_root), hex32(bundle.community_id), 0).pk,
    );
    expect(view?.restricted).toBeFalsy();
  });
});

describe("summarizeDiscoverChannels", () => {
  it("counts live channels and lists public ids only", () => {
    const out = summarizeDiscoverChannels([
      { channelIdHex: "aa".repeat(32), isPrivate: false, deleted: false },
      { channelIdHex: "bb".repeat(32), isPrivate: true, deleted: false },
      { channelIdHex: "cc".repeat(32), isPrivate: false, deleted: true },
    ]);
    expect(out.channelCount).toBe(2);
    expect(out.publicChannelIdHexes).toEqual(["aa".repeat(32)]);
  });
});

describe("control peek KV cache", () => {
  it("reads a well-shaped row and rejects malformed ones", async () => {
    const id = "dd".repeat(32);
    const peek = { channelCount: 3, publicChannelIdHexes: ["ee".repeat(32)] };
    await getArmadaDB().kv.set(`discover:control-peek:${id}`, peek);
    await expect(readCachedControlPeek(id)).resolves.toEqual(peek);

    await getArmadaDB().kv.set(`discover:control-peek:${id}`, { channelCount: "nope" });
    await expect(readCachedControlPeek(id)).resolves.toBeUndefined();
  });
});
