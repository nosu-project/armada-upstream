import { replaceEqualDeep } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { shareById } from "@/lib/shareRows";

const row = (id: string, content = id) => ({ id, content, tags: [["p", id]] });

describe("shareById", () => {
  it("keeps every row's identity when older rows are prepended", () => {
    const old = [row("c"), row("d"), row("e"), row("f")];
    const next = [row("a"), row("b"), ...old];
    // The index-paired default rebuilds the rows it misaligned.
    expect((replaceEqualDeep(old, next) as typeof old)[2]).not.toBe(old[0]);
    const shared = shareById(old, next) as typeof old;
    for (let i = 0; i < old.length; i++) expect(shared[i + 2]).toBe(old[i]);
  });

  it("reuses an old row for an equal fresh copy, and takes a changed one", () => {
    const old = [row("a"), row("b")];
    const shared = shareById(old, [row("a"), row("b", "edited")]) as typeof old;
    expect(shared[0]).toBe(old[0]);
    expect(shared[1]).not.toBe(old[1]);
    expect(shared[1].content).toBe("edited");
    expect(shared[1].tags).toBe(old[1].tags);
  });

  it("returns the old array when nothing changed", () => {
    const old = [row("a"), row("b")];
    expect(shareById(old, [row("a"), row("b")])).toBe(old);
  });

  it("falls back to the default for non-arrays", () => {
    expect(shareById(undefined, [row("a")])).toEqual([row("a")]);
  });
});
