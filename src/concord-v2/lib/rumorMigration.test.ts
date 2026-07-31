/**
 * The Concord V2 rumor drain — the migration from the single
 * `armada-concord-rumors` database to one ArmadaDB tenant per community.
 *
 * What makes this worth testing is that attribution is DERIVED, not stored: no
 * row says which community it belongs to, so the drain reconstructs each
 * community from the locally cached list and fold and claims the rows matching
 * its own derived addresses. Two ways that can go wrong destroy data or leak
 * it: claiming too little (a channel or plane whose addresses weren't
 * enumerated, whose history is then deleted with the old database), or claiming
 * too much (one community's rows filed into another's tenant, which is exactly
 * the cross-community boundary the tenant split exists to enforce).
 */
import { NIndexedDB } from "@nostrify/indexeddb";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { channelsView } from "@/concord-v2/lib/community";
import { addToList, EMPTY_COMMUNITY_LIST, toJoinMaterial } from "@/concord-v2/lib/communityList";
import {
  bytesToHex,
  communityIdOf,
  controlGroupKey,
  guestbookGroupKey,
  hex32,
} from "@/concord-v2/lib/derive";
import { KIND_MESSAGE } from "@/concord-v2/lib/kinds";

import type { FoldedChannel, FoldedControl } from "@/concord-v2/lib/control";
import type { CommunityList } from "@/concord-v2/lib/communityList";
import type { CommunityV2 } from "@/concord-v2/lib/types";
import type { NostrEvent } from "@nostrify/nostrify";

const SELF = "5e1f".padEnd(64, "0");
const LEGACY = "armada-concord-rumors";

/**
 * A community whose id is the real `sha256(owner || salt)` commitment — the
 * drain rehydrates from the cached list, and `rehydrateCommunity` refuses an
 * entry whose id doesn't verify.
 */
function communityOf(fill: number): CommunityV2 {
  const root = new Uint8Array(32).fill(fill);
  const ownerSalt = new Uint8Array(32).fill(fill + 1);
  const owner = bytesToHex(new Uint8Array(32).fill(fill + 2));
  const id = communityIdOf(hex32(owner), ownerSalt);
  return {
    id,
    idHex: bytesToHex(id),
    owner,
    ownerSalt,
    root,
    rootEpoch: 0n,
    heldRoots: [{ epoch: 0n, key: root }],
    privateChannels: [],
    relays: ["wss://relay.test"],
    name: `community-${fill}`,
  } as CommunityV2;
}

/** A fold with one public channel, which is what `channelsView` reads. */
function foldWith(channelIdHex: string): FoldedControl {
  const channel: FoldedChannel = {
    channelIdHex,
    name: "general",
    isPrivate: false,
    deleted: false,
    metadata: {} as FoldedChannel["metadata"],
  };
  return {
    roster: { positions: [] },
    ownerHex: "0".repeat(64),
    channels: new Map([[channelIdHex, channel]]),
    banned: new Set(),
    liveInviteLinks: new Set(),
    registriesByCreator: new Map(),
    heads: new Map(),
    headEditions: new Map(),
  } as unknown as FoldedControl;
}

/** A legacy row, shaped exactly as the old store wrote it. */
function legacyRow(id: string, tags: string[][], kind = KIND_MESSAGE): NostrEvent {
  return {
    id: id.padEnd(64, "0"),
    kind,
    content: id,
    created_at: 1000,
    pubkey: "a".repeat(64),
    tags: [...tags, ["seal", JSON.stringify({ id: "s".repeat(64), sig: "x".repeat(128) })]],
    sig: "",
  };
}

/**
 * Seed the caches the drain reads (both live in `armada-concord-cache`) and the
 * legacy store, then run the drain against a fresh module graph so its
 * per-viewer memo doesn't leak between tests.
 */
async function drain(
  communities: CommunityV2[],
  folds: Map<string, FoldedControl>,
  rows: NostrEvent[],
): Promise<typeof import("@/concord-v2/lib/rumorMigration")> {
  vi.resetModules();
  const { writeFolded } = await import("@/lib/foldedCache");
  const { communityListFoldKey } = await import("@/concord-v2/lib/communityList");
  const { controlFoldKey } = await import("@/concord-v2/lib/control");

  let list: CommunityList = EMPTY_COMMUNITY_LIST;
  for (const community of communities) {
    const current = toJoinMaterial(community, { relays: community.relays });
    list = addToList(list, {
      community_id: community.idHex,
      seed: current,
      current,
      added_at: 1,
    });
  }
  await writeFolded(communityListFoldKey(SELF), { event: null, list });
  for (const [idHex, fold] of folds) await writeFolded(controlFoldKey(idHex), fold);

  const mod = await import("@/concord-v2/lib/rumorMigration");

  // Seeded through the LEGACY index policy, not the default single-letter one:
  // `NIndexedDB` indexes on write, so rows written under a narrower policy
  // would be invisible to the drain's `#channel` / `#stream` filters.
  const legacy = new NIndexedDB(LEGACY, { indexTags: mod.legacyIndexTags });
  for (const row of rows) await legacy.event(row);
  await legacy.close();

  await mod.migrateLegacyRumors(SELF);
  return mod;
}

describe("migrateLegacyRumors", () => {
  beforeEach(() => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  });

  it("claims a community's chat and plane rows into its own tenant", async () => {
    const community = communityOf(20);
    const channelIdHex = "c1".repeat(32);
    const fold = foldWith(channelIdHex);
    const [channel] = channelsView(community, fold);
    const control = controlGroupKey(community.root, community.id, 0);
    const guestbook = guestbookGroupKey(community.root, community.id, 0);

    await drain(
      [community],
      new Map([[community.idHex, fold]]),
      [
        // Chat: carries the channel binding AND its stream address.
        legacyRow("chat", [
          ["channel", channelIdHex],
          ["stream", channel.current.group.pk],
        ]),
        // Control and guestbook planes: stream address only.
        legacyRow("ctl", [["stream", control.pk]], 3308),
        legacyRow("guest", [["stream", guestbook.pk]], 3310),
      ],
    );

    const { queryByStreams, queryChannelRumors } = await import("@/concord-v2/lib/rumorStore");

    const chat = await queryChannelRumors(community.idHex, channelIdHex, { limit: 10 });
    expect(chat.map((r) => r.content)).toEqual(["chat"]);

    // Every non-chat plane address is enumerated too — a plane the drain forgot
    // would have its history deleted with the legacy database.
    const planes = await queryByStreams(community.idHex, [control.pk, guestbook.pk]);
    expect(planes.map((r) => r.content).sort()).toEqual(["ctl", "guest"]);
  });

  it("keeps two communities' rows in their own tenants", async () => {
    const alpha = communityOf(30);
    const beta = communityOf(40);
    const alphaChannel = "aa".repeat(32);
    const betaChannel = "bb".repeat(32);
    const folds = new Map([
      [alpha.idHex, foldWith(alphaChannel)],
      [beta.idHex, foldWith(betaChannel)],
    ]);

    await drain(
      [alpha, beta],
      folds,
      [
        legacyRow("alpha-msg", [["channel", alphaChannel]]),
        legacyRow("beta-msg", [["channel", betaChannel]]),
      ],
    );

    const { queryChannelRumors } = await import("@/concord-v2/lib/rumorStore");

    expect(
      (await queryChannelRumors(alpha.idHex, alphaChannel, { limit: 10 })).map((r) => r.content),
    ).toEqual(["alpha-msg"]);
    expect(
      (await queryChannelRumors(beta.idHex, betaChannel, { limit: 10 })).map((r) => r.content),
    ).toEqual(["beta-msg"]);

    // The point of the split: beta's channel id is not servable from alpha's
    // tenant even though both rows sat in one database a moment ago.
    expect(
      (await queryChannelRumors(alpha.idHex, betaChannel, { limit: 10 })).length,
    ).toBe(0);
  });

  it("leaves rows behind that no joined community claims", async () => {
    const community = communityOf(50);
    const channelIdHex = "c5".repeat(32);
    const strangerChannel = "ff".repeat(32);

    await drain(
      [community],
      new Map([[community.idHex, foldWith(channelIdHex)]]),
      [
        legacyRow("mine", [["channel", channelIdHex]]),
        // A community this account has left: its secrets are gone from the
        // list, so the row is undecryptable and has no tenant to go to.
        legacyRow("stranger", [["channel", strangerChannel]]),
      ],
    );

    const { queryChannelRumors } = await import("@/concord-v2/lib/rumorStore");
    expect(
      (await queryChannelRumors(community.idHex, channelIdHex, { limit: 10 })).map((r) => r.content),
    ).toEqual(["mine"]);
    expect(
      (await queryChannelRumors(community.idHex, strangerChannel, { limit: 10 })).length,
    ).toBe(0);
  });

  it("does not mark itself done when no community list is cached yet", async () => {
    // A cold profile whose list has never been read must get another pass —
    // treating "no list" as "nothing to migrate" would strand every community.
    vi.resetModules();
    const { legacyIndexTags, migrateLegacyRumors } = await import(
      "@/concord-v2/lib/rumorMigration"
    );
    const legacy = new NIndexedDB(LEGACY, { indexTags: legacyIndexTags });
    await legacy.event(legacyRow("orphan", [["channel", "c9".repeat(32)]]));
    await legacy.close();

    await migrateLegacyRumors(SELF);

    const { getArmadaDB } = await import("@/lib/db/armadaDB");
    expect(await getArmadaDB().kv.get(`c2rumors:migrated:${SELF}`)).toBeUndefined();
  });

  it("is idempotent — a second run neither duplicates nor drops", async () => {
    const community = communityOf(60);
    const channelIdHex = "c6".repeat(32);

    const mod = await drain(
      [community],
      new Map([[community.idHex, foldWith(channelIdHex)]]),
      [legacyRow("once", [["channel", channelIdHex]])],
    );
    await mod.migrateLegacyRumors(SELF);

    const { queryChannelRumors } = await import("@/concord-v2/lib/rumorStore");
    expect(
      (await queryChannelRumors(community.idHex, channelIdHex, { limit: 10 })).map((r) => r.content),
    ).toEqual(["once"]);
  });
});
