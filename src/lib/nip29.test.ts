import { describe, expect, it } from "vitest";

import { KIND_RELAY_MEMBERS, parseRelayMemberRoles } from "@/lib/nip29";

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
