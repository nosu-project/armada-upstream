import { describe, expect, it } from "vitest";

import {
  activityByLinkSigner,
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
    const filters = discoverActivityFilters([
      { linkSigner: "a", authors: ["11".repeat(32)], relays: ["wss://r/"] },
      { linkSigner: "b", authors: [], relays: ["wss://r/"] },
    ]);
    expect(filters).toEqual([{ kinds: [KIND_WRAP], authors: ["11".repeat(32)], limit: 1 }]);
  });
});

describe("activityByLinkSigner", () => {
  it("keeps the newest wrap per link-signer", () => {
    const pk = "aa".repeat(32);
    const targets = [{ linkSigner: "link1", authors: [pk], relays: [] }];
    const out = activityByLinkSigner(targets, [
      { pubkey: pk, created_at: 100 },
      { pubkey: pk, created_at: 200 },
      { pubkey: "bb".repeat(32), created_at: 999 },
    ]);
    expect(out).toEqual({ link1: 200 });
  });
});
