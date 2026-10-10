import { describe, expect, it } from "vitest";

import {
  decodeSettingsRoot,
  encodeSettingsRoot,
  newestSettingsRoot,
  ROOT_PLAINTEXT_BYTES,
  settingsRootTags,
} from "@/lib/settingsRoot";

const ROOT = "ab".repeat(32);
const bytes = (s: string) => new TextEncoder().encode(s).byteLength;

describe("settingsRoot", () => {
  it("always encodes to the fixed length", () => {
    expect(bytes(encodeSettingsRoot({ v: 1, root: ROOT }))).toBe(ROOT_PLAINTEXT_BYTES);
    expect(bytes(encodeSettingsRoot({ v: 1, root: ROOT, later: { a: [1, 2, 3], b: "ünïcode" } })))
      .toBe(ROOT_PLAINTEXT_BYTES);
  });

  it("round-trips and keeps unknown fields", () => {
    const decoded = decodeSettingsRoot(encodeSettingsRoot({ v: 1, root: ROOT, later: 7 }));
    expect(decoded).toEqual({ v: 1, root: ROOT, later: 7 });
  });

  it("refuses a payload that would overflow", () => {
    expect(() => encodeSettingsRoot({ v: 1, root: ROOT, big: "x".repeat(ROOT_PLAINTEXT_BYTES) }))
      .toThrow(/fixed size/);
  });

  it("rejects anything that is not a v1 root", () => {
    expect(decodeSettingsRoot("{}")).toBeNull();
    expect(decodeSettingsRoot(JSON.stringify({ v: 2, root: ROOT }))).toBeNull();
    expect(decodeSettingsRoot(JSON.stringify({ v: 1, root: "nope" }))).toBeNull();
    expect(decodeSettingsRoot("not json")).toBeNull();
  });

  it("carries only the d tag", () => {
    expect(settingsRootTags()).toEqual([["d", "armada"]]);
  });

  it("picks the NIP-01 winner among the user's roots", () => {
    const base = { kind: 30078, pubkey: "p", content: "", tags: [["d", "armada"]] };
    const a = { ...base, id: "b", created_at: 10 };
    const b = { ...base, id: "a", created_at: 10 };
    const forged = { ...base, id: "0", created_at: 99, pubkey: "q" };
    expect(newestSettingsRoot([a, b, forged], "p")).toBe(b);
  });
});
