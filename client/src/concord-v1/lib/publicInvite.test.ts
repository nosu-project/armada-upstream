import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";

import { encodeInviteUrl, parseInviteUrl, TRUSTED_RELAYS } from "@/concord-v1/lib/publicInvite";

// The cross-compat contract with Vector's `community/public_invite.rs`. The URL
// `#fragment` format is SHARED, not forked — these vectors lock it so a Vector
// link parses in Armada and vice versa. Do not loosen without matching Vector.

const TOKEN_32 = new Uint8Array(32).map((_, i) => i + 1);

describe("parseInviteUrl — Vector v2 fragment cross-compat", () => {
  it("parses a real Vector default-relay-set link", () => {
    // A genuine vectorapp.io invite: `[ver=2][flags=1][token:32]`, no relay bytes.
    const url = "https://vectorapp.io/invite#AgF41m7OjohqpcKdL0Ll2oyFNhBNV0W0pZLmJySyOyVhEQ";
    const { relays, token } = parseInviteUrl(url);
    // flags bit 0 set => relays resolve to the stock trusted set (where the bundle lives).
    expect(relays).toEqual([...TRUSTED_RELAYS]);
    expect(bytesToHex(token)).toBe(
      "78d66ece8e886aa5c29d2f42e5da8c8536104d5745b4a592e62724b23b256111",
    );
  });

  it("accepts the bare fragment (no URL around it)", () => {
    const { token } = parseInviteUrl("AgF41m7OjohqpcKdL0Ll2oyFNhBNV0W0pZLmJySyOyVhEQ");
    expect(bytesToHex(token)).toBe(
      "78d66ece8e886aa5c29d2f42e5da8c8536104d5745b4a592e62724b23b256111",
    );
  });

  it("decodes well-known relays from the v2 dictionary (1 byte each)", () => {
    // [ver=2][flags=0][count=2][id=4 (relay.damus.io)][id=1 (jskitty)][token:32]
    const raw = new Uint8Array([2, 0, 2, 4, 1, ...TOKEN_32]);
    const frag = base64url(raw);
    const { relays, token } = parseInviteUrl(`https://x.io/invite#${frag}`);
    expect(relays).toEqual(["wss://relay.damus.io", "wss://jskitty.com/nostr"]);
    expect(bytesToHex(token)).toBe(bytesToHex(TOKEN_32));
  });

  it("decodes wss-implied (id 0) and verbatim (id 255) relay literals", () => {
    const host = "relay.example.com";
    const verbatim = "ws://localhost:7777";
    const bytes = [
      2, 0, 2,
      0, host.length, ...[...host].map((c) => c.charCodeAt(0)),
      255, verbatim.length, ...[...verbatim].map((c) => c.charCodeAt(0)),
      ...TOKEN_32,
    ];
    const { relays } = parseInviteUrl(`#${base64url(new Uint8Array(bytes))}`);
    expect(relays).toEqual([`wss://${host}`, verbatim]);
  });

  it("skips unknown dictionary ids (forward-compat) but keeps resolvable ones", () => {
    // id 200 is not in our dictionary (a newer build appended it) — skip it.
    const raw = new Uint8Array([2, 0, 2, 200, 1, ...TOKEN_32]);
    const { relays } = parseInviteUrl(`#${base64url(raw)}`);
    expect(relays).toEqual(["wss://jskitty.com/nostr"]);
  });

  it("rejects malformed fragments", () => {
    expect(() => parseInviteUrl("https://x.io/invite#")).toThrow();
    expect(() => parseInviteUrl("#not_base64_@@@")).toThrow();
    // v2 with a non-32-byte token.
    expect(() => parseInviteUrl(`#${base64url(new Uint8Array([2, 1, 1, 2, 3]))}`)).toThrow();
    // all dictionary ids unknown => no resolvable relays.
    expect(() => parseInviteUrl(`#${base64url(new Uint8Array([2, 0, 1, 250, ...TOKEN_32]))}`)).toThrow();
  });
});

describe("parseInviteUrl — legacy v1 JSON fragment", () => {
  it("parses a v1 fragment (base64url JSON, first byte '{')", () => {
    const tokenHex = bytesToHex(TOKEN_32);
    const json = JSON.stringify({ v: 1, relays: ["wss://r1.example", "wss://r2.example"], t: tokenHex });
    const frag = base64url(new TextEncoder().encode(json));
    const { relays, token } = parseInviteUrl(`https://vectorapp.io/invite#${frag}`);
    expect(relays).toEqual(["wss://r1.example", "wss://r2.example"]);
    expect(bytesToHex(token)).toBe(tokenHex);
  });

  it("rejects a v1 fragment with a bad token", () => {
    const frag = base64url(new TextEncoder().encode(JSON.stringify({ v: 1, relays: [], t: "nothex" })));
    expect(() => parseInviteUrl(`#${frag}`)).toThrow();
  });
});

describe("encodeInviteUrl — round-trips + Vector-compatible output", () => {
  it("encodes the stock trusted set with the default-relay flag (zero relay bytes)", () => {
    const url = encodeInviteUrl([...TRUSTED_RELAYS], TOKEN_32);
    const frag = url.slice(url.lastIndexOf("#") + 1);
    const raw = base64urlDecode(frag);
    expect(raw[0]).toBe(2); // version
    expect(raw[1]).toBe(0b0000_0001); // V2_FLAG_DEFAULT_RELAYS
    expect(raw.length).toBe(34); // [ver][flags][token:32], no relay bytes
    const { relays, token } = parseInviteUrl(url);
    expect(relays).toEqual([...TRUSTED_RELAYS]);
    expect(bytesToHex(token)).toBe(bytesToHex(TOKEN_32));
  });

  it("prefers dictionary ids over literals for known relays", () => {
    const url = encodeInviteUrl(["wss://relay.damus.io"], TOKEN_32);
    const raw = base64urlDecode(url.slice(url.lastIndexOf("#") + 1));
    // [ver][flags=0][count=1][id=4][token:32] => 1 relay byte, not a literal.
    expect(raw[1]).toBe(0);
    expect(raw[2]).toBe(1);
    expect(raw[3]).toBe(4); // relay.damus.io is dictionary id 4
    expect(raw.length).toBe(4 + 32);
  });

  it("round-trips a custom relay set", () => {
    const relays = ["wss://relay.example.com", "ws://localhost:7777"];
    const { relays: out, token } = parseInviteUrl(encodeInviteUrl(relays, TOKEN_32));
    expect(out).toEqual(relays);
    expect(bytesToHex(token)).toBe(bytesToHex(TOKEN_32));
  });
});

// ── local base64url helpers (mirror the module's, kept independent for the test) ──

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(str: string): Uint8Array {
  const bin = atob(str.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
