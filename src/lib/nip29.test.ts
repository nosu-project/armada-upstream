import { describe, expect, it } from "vitest";
import { nip19 } from "nostr-tools";

import {
  buildGroupNaddr,
  buildGroupPinsTags,
  KIND_GROUP_METADATA,
  KIND_GROUP_PINS,
  KIND_RELAY_MEMBERS,
  KIND_UPDATE_PIN_LIST,
  parseAddrPinRef,
  parseGroupMetadata,
  parseGroupNaddr,
  parseGroupPins,
  parseRelayMemberRoles,
  reconcileRelayGroups,
} from "@/lib/nip29";

import type { NostrEvent } from "@nostrify/nostrify";

const PK_A = "a".repeat(64);
const PK_B = "b".repeat(64);
const PK_C = "c".repeat(64);

/** Build a minimal kind-13534 snapshot from tags for parser testing. */
function snapshot(tags: string[][], kind = KIND_RELAY_MEMBERS): NostrEvent {
  return {
    id: "0".repeat(64),
    pubkey: "f".repeat(64),
    created_at: 1,
    kind,
    tags,
    content: "",
    sig: "0".repeat(128),
  };
}

describe("parseRelayMemberRoles", () => {
  it("reads the role from a NIP-43 `member` tag (index 2)", () => {
    expect(parseRelayMemberRoles(snapshot([["member", PK_A, "admin"]]))).toEqual({
      [PK_A]: "admin",
    });
  });

  it("reads the role from a NIP-29-shaped `p` tag (index 3, empty relay_url)", () => {
    expect(parseRelayMemberRoles(snapshot([["p", PK_A, "", "owner"]]))).toEqual({
      [PK_A]: "owner",
    });
  });

  it("reads the role past a populated relay_url on a `p` tag", () => {
    expect(
      parseRelayMemberRoles(snapshot([["p", PK_A, "wss://relay.example", "admin"]])),
    ).toEqual({ [PK_A]: "admin" });
  });

  it("defaults a missing or unknown role to `member`", () => {
    expect(
      parseRelayMemberRoles(
        snapshot([
          ["member", PK_A],
          ["member", PK_B, "moderator"],
        ]),
      ),
    ).toEqual({ [PK_A]: "member", [PK_B]: "member" });
  });

  it("normalizes role and pubkey case", () => {
    expect(
      parseRelayMemberRoles(snapshot([["member", PK_A.toUpperCase(), "ADMIN"]])),
    ).toEqual({ [PK_A]: "admin" });
  });

  it("ignores non-hex pubkeys and keeps the first tag per pubkey", () => {
    expect(
      parseRelayMemberRoles(
        snapshot([
          ["member", "not-a-pubkey", "admin"],
          ["member", PK_C, "owner"],
          ["member", PK_C, "member"],
        ]),
      ),
    ).toEqual({ [PK_C]: "owner" });
  });

  it("returns an empty map for the wrong kind", () => {
    expect(parseRelayMemberRoles(snapshot([["member", PK_A, "admin"]], 39002))).toEqual({});
  });
});

describe("parseGroupMetadata", () => {
  const meta = (tags: string[][]) =>
    parseGroupMetadata(snapshot([["d", "general"], ...tags], KIND_GROUP_METADATA), "wss://relay.example");

  it("parses name, picture, banner and about display tags", () => {
    expect(
      meta([
        ["name", "Pizza Lovers"],
        ["picture", "https://pizza.com/pizza.png"],
        ["banner", "https://pizza.com/banner.png"],
        ["about", "a group for people who love pizza"],
      ]),
    ).toMatchObject({
      id: "general",
      relay: "wss://relay.example",
      name: "Pizza Lovers",
      picture: "https://pizza.com/pizza.png",
      banner: "https://pizza.com/banner.png",
      about: "a group for people who love pizza",
    });
  });

  it("leaves banner undefined when the tag is absent", () => {
    expect(meta([["name", "no banner"]])?.banner).toBeUndefined();
  });
});

describe("group naddr identifiers", () => {
  const params = { relaySelf: PK_A, groupId: "general", relay: "wss://relay.example" };

  it("round-trips a bare group naddr", () => {
    const naddr = buildGroupNaddr(params);
    expect(naddr).toMatch(/^naddr1/);
    expect(parseGroupNaddr(naddr!)).toEqual({
      groupId: "general",
      relay: "wss://relay.example",
      inviteCode: undefined,
    });
  });

  it("round-trips an naddr with the ?invite= suffix", () => {
    const naddr = buildGroupNaddr({ ...params, inviteCode: "abc123" });
    expect(naddr).toContain("?invite=abc123");
    expect(parseGroupNaddr(naddr!)).toEqual({
      groupId: "general",
      relay: "wss://relay.example",
      inviteCode: "abc123",
    });
  });

  it("accepts a nostr: prefix and decodes percent-encoded invite codes", () => {
    const naddr = buildGroupNaddr({ ...params, inviteCode: "a b+c" });
    expect(parseGroupNaddr(`nostr:${naddr}`)).toEqual({
      groupId: "general",
      relay: "wss://relay.example",
      inviteCode: "a b+c",
    });
  });

  it("ignores an unrecognized suffix (the bare naddr stays valid)", () => {
    const naddr = buildGroupNaddr(params)!;
    expect(parseGroupNaddr(`${naddr}?foo=bar`)).toEqual({
      groupId: "general",
      relay: "wss://relay.example",
      inviteCode: undefined,
    });
  });

  it("rejects naddrs for other kinds, non-naddr bech32, and garbage", () => {
    const other = buildGroupNaddr({ ...params, groupId: "x" })!;
    // Re-encode the same coordinate at a different (non-39000) kind.
    const decoded = nip19.decode(other);
    if (decoded.type !== "naddr") throw new Error("expected naddr");
    const wrongKind = nip19.naddrEncode({ ...decoded.data, kind: 39001 });
    expect(parseGroupNaddr(wrongKind)).toBeUndefined();
    expect(parseGroupNaddr(nip19.npubEncode(PK_A))).toBeUndefined();
    expect(parseGroupNaddr("not an naddr")).toBeUndefined();
    expect(parseGroupNaddr("")).toBeUndefined();
  });
});

const ID_1 = "1".repeat(64);
const ID_2 = "2".repeat(64);
const ADDR = `30023:${PK_B}:my-article`;

describe("parseAddrPinRef", () => {
  it("parses an address coordinate, keeping colons in the identifier", () => {
    expect(parseAddrPinRef(ADDR)).toEqual({ kind: 30023, pubkey: PK_B, identifier: "my-article" });
    expect(parseAddrPinRef(`30818:${PK_B}:wiki:page`)).toEqual({
      kind: 30818,
      pubkey: PK_B,
      identifier: "wiki:page",
    });
  });

  it("returns undefined for event ids and garbage", () => {
    expect(parseAddrPinRef(ID_1)).toBeUndefined();
    expect(parseAddrPinRef("not-a-coordinate")).toBeUndefined();
    expect(parseAddrPinRef(`30023:not-hex:d`)).toBeUndefined();
  });
});

describe("parseGroupPins", () => {
  it("reads e and a tags in tag order, de-duplicated (kind 39005)", () => {
    const pins = snapshot(
      [
        ["d", "general"],
        ["e", ID_1],
        ["a", ADDR],
        ["e", ID_2],
        ["e", ID_1], // duplicate
        ["e", "not-hex"], // invalid
      ],
      KIND_GROUP_PINS,
    );
    expect(parseGroupPins(pins)).toEqual([ID_1, ADDR, ID_2]);
  });

  it("accepts kind 9010 (optimistic updates), rejects other kinds", () => {
    const tags = [["e", ID_1]];
    expect(parseGroupPins(snapshot(tags, KIND_UPDATE_PIN_LIST))).toEqual([ID_1]);
    expect(parseGroupPins(snapshot(tags, KIND_GROUP_METADATA))).toEqual([]);
  });
});

describe("buildGroupPinsTags", () => {
  it("emits h scope plus e/a tags in order, de-duplicated", () => {
    expect(buildGroupPinsTags("general", [ID_1, ADDR, ID_2, ID_1, "junk"])).toEqual([
      ["h", "general"],
      ["e", ID_1],
      ["a", ADDR],
      ["e", ID_2],
    ]);
  });

  it("builds a clear-the-list event from an empty ref list", () => {
    expect(buildGroupPinsTags("general", [])).toEqual([["h", "general"]]);
  });
});

describe("reconcileRelayGroups", () => {
  const RELAY = "wss://relay.example";
  const meta = (id: string, created_at = 1): NostrEvent => ({
    ...snapshot([["d", id], ["name", id]], KIND_GROUP_METADATA),
    id: id.padEnd(64, "0"),
    created_at,
  });
  const ids = (events: NostrEvent[]) => reconcileRelayGroups([], events, RELAY).groups.map((g) => g.id);

  it("keeps the cache as the floor when the relay answered nothing", () => {
    const { groups, stale } = reconcileRelayGroups([meta("a"), meta("b")], [], RELAY);
    expect(groups.map((g) => g.id)).toEqual(["a", "b"]);
    expect(stale).toEqual([]);
  });

  it("drops cached channels an answered read no longer lists, and reports them stale", () => {
    // "left" was cached from an earlier read; the relay stopped listing it.
    const { groups, stale } = reconcileRelayGroups([meta("a"), meta("left")], [meta("a"), meta("new")], RELAY);
    expect(groups.map((g) => g.id)).toEqual(["a", "new"]);
    expect(stale).toEqual(["left"]);
  });

  it("lets a newer cached copy of a listed channel supersede the relay's older one", () => {
    const cachedNewer = { ...meta("a", 5), tags: [["d", "a"], ["name", "renamed"]] };
    const { groups, stale } = reconcileRelayGroups([cachedNewer], [meta("a", 1)], RELAY);
    expect(groups.map((g) => g.name)).toEqual(["renamed"]);
    expect(stale).toEqual([]);
  });

  it("is a plain collapse with no cache", () => {
    expect(ids([meta("b"), meta("a")])).toEqual(["a", "b"]);
  });
});
