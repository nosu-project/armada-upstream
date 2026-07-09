import { describe, expect, it } from "vitest";

import {
  MESH_SELF_COLOR,
  meshAnonName,
  meshColor,
  meshIdentity,
  meshMentionToken,
  meshMentionsMe,
  meshSuffix,
} from "@/lib/meshIdentity";

const PEER = "3f9a1b2c4d5e6f70";

describe("meshAnonName", () => {
  it("derives anon<first4hex>, lowercased", () => {
    expect(meshAnonName(PEER)).toBe("anon3f9a");
    expect(meshAnonName("ABCDEF0123456789")).toBe("anonabcd");
  });
});

describe("meshSuffix", () => {
  it("is the lowercased last 4 hex of the peer id", () => {
    expect(meshSuffix(PEER)).toBe("6f70");
    expect(meshSuffix("ABCDEF0123456789")).toBe("6789");
  });
});

describe("meshColor", () => {
  it("is deterministic per peer id", () => {
    expect(meshColor(PEER)).toBe(meshColor(PEER));
  });

  it("is case-insensitive on the peer id", () => {
    expect(meshColor(PEER)).toBe(meshColor(PEER.toUpperCase()));
  });

  // Locked against the bitchat djb2→HSV reference (seed "noise:<id>", dark
  // variant s=0.5 v=0.85) so Armada and bitchat color the same peer alike.
  it("matches the bitchat reference for known seeds", () => {
    expect(meshColor("3f9a1b2c4d5e6f70")).toBe("#72d96c");
    expect(meshColor("abcdef0123456789")).toBe("#6ed96c");
    expect(meshColor("0000000000000000")).toBe("#6c9dd9");
  });
});

describe("meshIdentity", () => {
  it("uses the announced nickname when present", () => {
    const id = meshIdentity(PEER, "Alice");
    expect(id.name).toBe("Alice");
    expect(id.suffix).toBe("6f70");
    expect(id.color).toBe(meshColor(PEER));
  });

  it("falls back to the anon name when no nickname is announced", () => {
    expect(meshIdentity(PEER, undefined).name).toBe("anon3f9a");
    expect(meshIdentity(PEER, "   ").name).toBe("anon3f9a");
  });

  it("uses the reserved self color for the local user", () => {
    expect(meshIdentity(PEER, "Me", true).color).toBe(MESH_SELF_COLOR);
  });
});

describe("meshMentionToken", () => {
  it("formats as @name#suffix", () => {
    expect(meshMentionToken(meshIdentity(PEER, "Alice"))).toBe("@Alice#6f70");
    expect(meshMentionToken(meshIdentity(PEER, undefined))).toBe("@anon3f9a#6f70");
  });
});

describe("meshMentionsMe", () => {
  const me = "aaaa1111bbbb2222"; // suffix 2222

  it("matches a mention whose suffix is our peer-id tail", () => {
    expect(meshMentionsMe("hey @anon3f9a#2222 look", me)).toBe(true);
    expect(meshMentionsMe("hey @Someone#2222!", me)).toBe(true);
  });

  it("ignores mentions of other peers", () => {
    expect(meshMentionsMe("hey @anon3f9a#6f70", me)).toBe(false);
  });

  it("is case-insensitive on the suffix", () => {
    expect(meshMentionsMe("@x#AAAA done", "0000000000000000".slice(0, 12) + "aaaa")).toBe(true);
  });

  it("returns false when our peer id is unknown", () => {
    expect(meshMentionsMe("@x#2222", null)).toBe(false);
  });
});
