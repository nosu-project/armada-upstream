/**
 * The Concord rumor drain — the migration from the single
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

import { channelsView } from "@/concord/lib/community";
import { addToList, EMPTY_COMMUNITY_LIST, toJoinMaterial } from "@/concord/lib/communityList";
import {
  bytesToHex,
  communityIdOf,
  controlGroupKey,
  guestbookGroupKey,
  hex32,
} from "@/concord/lib/derive";
import {
  KIND_CONTROL,
  KIND_JOIN_LEAVE,
  KIND_MESSAGE,
  KIND_SEAL_ENCRYPTED,
  KIND_SEAL_PLAINTEXT,
} from "@/concord/lib/kinds";

import type { FoldedChannel, FoldedControl } from "@/concord/lib/control";
import type { CommunityList } from "@/concord/lib/communityList";
import type { Community } from "@/concord/lib/types";
import type { NostrEvent } from "@nostrify/nostrify";

const SELF = "5e1f".padEnd(64, "0");
const LEGACY = "armada-concord-rumors";

/**
 * A community whose id is the real `sha256(owner || salt)` commitment — the
 * drain rehydrates from the cached list, and `rehydrateCommunity` refuses an
 * entry whose id doesn't verify.
 */
function communityOf(fill: number): Community {
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
  } as Community;
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
    pinLists: new Map(),
    signals: new Map(),
    incomplete: [],
  } as unknown as FoldedControl;
}

/** The seal a legacy row carries, as the old store serialized it. */
const SEAL = { id: "s".repeat(64), sig: "x".repeat(128) };

/**
 * A legacy row, shaped exactly as the old store wrote it: the author's own tags
 * plus the four wrap-derived ones it injected.
 */
function legacyRow(
  id: string,
  tags: string[][],
  kind = KIND_MESSAGE,
  sealKind = KIND_SEAL_ENCRYPTED,
): NostrEvent {
  return {
    id: id.padEnd(64, "0"),
    kind,
    content: id,
    created_at: 1000,
    pubkey: "a".repeat(64),
    tags: [
      ...tags,
      ["wrap", "f".repeat(64)],
      ["sealkind", String(sealKind)],
      ["seal", JSON.stringify(SEAL)],
    ],
    sig: "",
  };
}

/**
 * Seed the caches the drain reads (both live in the fold cache) and the
 * legacy store, then run the drain against a fresh module graph so its
 * per-viewer memo doesn't leak between tests.
 */
async function drain(
  communities: Community[],
  folds: Map<string, FoldedControl>,
  rows: NostrEvent[],
): Promise<typeof import("@/concord/lib/rumorMigration")> {
  vi.resetModules();
  const { writeFolded } = await import("@/lib/foldedCache");
  const { communityListFoldKey } = await import("@/concord/lib/communityList");
  const { controlFoldKey } = await import("@/concord/lib/control");

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

  const mod = await import("@/concord/lib/rumorMigration");

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
        // Control and guestbook planes: stream address only, each under the
        // seal form CORD-02 §5 fixes for it.
        legacyRow("ctl", [["stream", control.pk]], KIND_CONTROL, KIND_SEAL_PLAINTEXT),
        legacyRow("guest", [["stream", guestbook.pk]], KIND_JOIN_LEAVE, KIND_SEAL_ENCRYPTED),
      ],
    );

    const { queryChannelRumors, queryPlane } = await import("@/concord/lib/rumorStore");

    const chat = await queryChannelRumors(community.idHex, channelIdHex, { limit: 10 });
    expect(chat.map((r) => r.content)).toEqual(["chat"]);

    // Every non-chat plane address is enumerated too — a plane the drain forgot
    // would have its history deleted with the legacy database. They read back
    // BY KIND now, which is why the drain has to get the plane boundary right.
    expect((await queryPlane(community.idHex, "control")).map((r) => r.content)).toEqual(["ctl"]);
    expect((await queryPlane(community.idHex, "guestbook")).map((r) => r.content)).toEqual([
      "guest",
    ]);
  });

  it("stores the bare rumor, moving the seal to KV and the stream to the snapshot", async () => {
    // The old store folded four wrap-derived values into the row's tags. The
    // tenant holds the rumor its author signed, so what is copied must be the
    // row minus those four — otherwise the stored bytes are not the ones the
    // `id` commits to.
    const community = communityOf(70);
    const control = controlGroupKey(community.root, community.id, 0);

    await drain(
      [community],
      new Map([[community.idHex, foldWith("c7".repeat(32))]]),
      [
        legacyRow(
          "edition",
          [
            ["stream", control.pk],
            ["vsk", "0"],
          ],
          KIND_CONTROL,
          KIND_SEAL_PLAINTEXT,
        ),
      ],
    );

    const { queryPlane, readControlSnapshot, readStoredSeal } = await import(
      "@/concord/lib/rumorStore"
    );

    const [edition] = await queryPlane(community.idHex, "control");
    expect(edition.tags).toEqual([["vsk", "0"]]);

    // The seal is evidence ABOUT the rumor, kept where a compaction re-wrap
    // looks for it rather than in the bytes the rumor id covers.
    expect(await readStoredSeal(community.idHex, "edition".padEnd(64, "0"))).toEqual(SEAL);

    // Which control stream an edition arrived on is the one envelope fact not
    // recoverable from the rumor, so it is carried across as its own record.
    const snapshot = await readControlSnapshot(community.idHex, control.pk);
    expect(snapshot?.has("edition".padEnd(64, "0"))).toBe(true);
  });

  it("refuses a row whose kind does not belong to the stream it arrived on", async () => {
    // The old store told the planes apart by the `stream` tag, so it happily
    // held a control-kind rumor published to the guestbook address by anyone
    // holding that stream's key. Planes read back by KIND now, so copying one
    // across would mint a control edition out of a guestbook keyholder's rumor.
    const community = communityOf(80);
    const guestbook = guestbookGroupKey(community.root, community.id, 0);
    const control = controlGroupKey(community.root, community.id, 0);

    await drain(
      [community],
      new Map([[community.idHex, foldWith("c8".repeat(32))]]),
      [
        legacyRow("forged", [["stream", guestbook.pk]], KIND_CONTROL, KIND_SEAL_PLAINTEXT),
        // Right kind, right address, but the seal form a compaction re-wrap
        // could never survive — the second of `writeOpened`'s three refusals.
        legacyRow("sealed-wrong", [["stream", control.pk]], KIND_CONTROL, KIND_SEAL_ENCRYPTED),
        legacyRow("real", [["stream", control.pk]], KIND_CONTROL, KIND_SEAL_PLAINTEXT),
      ],
    );

    const { queryPlane } = await import("@/concord/lib/rumorStore");
    expect((await queryPlane(community.idHex, "control")).map((r) => r.content)).toEqual(["real"]);
    expect(await queryPlane(community.idHex, "guestbook")).toEqual([]);
  });

  it("refuses a plane-kind rumor riding a channel binding", async () => {
    // The chat pass claims rows by their `channel` tag. A control-kind rumor
    // carrying one would be filed into the tenant and then served by the kind
    // read as an edition — which is why `writeOpened` refuses a channel tag on
    // every non-chat plane.
    const community = communityOf(90);
    const channelIdHex = "c9".repeat(32);

    await drain(
      [community],
      new Map([[community.idHex, foldWith(channelIdHex)]]),
      [
        legacyRow("msg", [["channel", channelIdHex]]),
        legacyRow("smuggled", [["channel", channelIdHex]], KIND_CONTROL, KIND_SEAL_PLAINTEXT),
      ],
    );

    const { queryChannelRumors, queryPlane } = await import("@/concord/lib/rumorStore");
    expect(
      (await queryChannelRumors(community.idHex, channelIdHex, { limit: 10 })).map((r) => r.content),
    ).toEqual(["msg"]);
    expect(await queryPlane(community.idHex, "control")).toEqual([]);
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

    const { queryChannelRumors } = await import("@/concord/lib/rumorStore");

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

    const { queryChannelRumors } = await import("@/concord/lib/rumorStore");
    expect(
      (await queryChannelRumors(community.idHex, channelIdHex, { limit: 10 })).map((r) => r.content),
    ).toEqual(["mine"]);
    expect(
      (await queryChannelRumors(community.idHex, strangerChannel, { limit: 10 })).length,
    ).toBe(0);
  });

  it("refuses to finish when no community list is cached yet", async () => {
    // A cold profile whose list has never been read must get another pass —
    // treating "no list" as "nothing to migrate" would strand every community.
    //
    // Leaving the flag unset is not enough on its own: the startup catalogue
    // reads a RESOLVED drain as "the source is safe to delete", and deletes
    // the legacy database for all accounts at once. So this has to reject.
    vi.resetModules();
    const { legacyIndexTags, migrateLegacyRumors } = await import(
      "@/concord/lib/rumorMigration"
    );
    const legacy = new NIndexedDB(LEGACY, { indexTags: legacyIndexTags });
    await legacy.event(legacyRow("orphan", [["channel", "c9".repeat(32)]]));
    await legacy.close();

    await expect(migrateLegacyRumors(SELF)).rejects.toThrow(/deferred/i);

    const { getArmadaDB } = await import("@/lib/db/armadaDB");
    expect(await getArmadaDB().kv.get(`c2rumors:migrated:${SELF}`)).toBeUndefined();
  });

  it("finishes when the cached list is empty — nothing is attributable", async () => {
    // A cached but EMPTY list IS an answer, unlike no cached list at all: any
    // row left in the store belongs to a community this account has left, whose
    // secrets are gone, so it is undecryptable and safe to leave behind.
    vi.resetModules();
    const { legacyIndexTags, migrateLegacyRumors } = await import(
      "@/concord/lib/rumorMigration"
    );
    const { writeFolded } = await import("@/lib/foldedCache");
    const { communityListFoldKey } = await import("@/concord/lib/communityList");
    await writeFolded(communityListFoldKey(SELF), { event: null, list: { entries: [] } });

    const legacy = new NIndexedDB(LEGACY, { indexTags: legacyIndexTags });
    await legacy.event(legacyRow("orphan", [["channel", "c9".repeat(32)]]));
    await legacy.close();

    await migrateLegacyRumors(SELF);

    const { getArmadaDB } = await import("@/lib/db/armadaDB");
    expect(await getArmadaDB().kv.get(`c2rumors:migrated:${SELF}`)).toBe(true);
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

    const { queryChannelRumors } = await import("@/concord/lib/rumorStore");
    expect(
      (await queryChannelRumors(community.idHex, channelIdHex, { limit: 10 })).map((r) => r.content),
    ).toEqual(["once"]);
  });
});
