import { describe, expect, it } from "vitest";

import { compileMutedWords, normalizeMutedWord } from "./mutedWords";

describe("normalizeMutedWord", () => {
  it("trims and collapses whitespace", () => {
    expect(normalizeMutedWord("  bad   word \n")).toBe("bad word");
    expect(normalizeMutedWord("   ")).toBe("");
  });
});

describe("compileMutedWords", () => {
  it("is null for an empty list", () => {
    expect(compileMutedWords([])).toBeNull();
    expect(compileMutedWords(["", "  "])).toBeNull();
  });

  it("matches whole words, case-insensitively", () => {
    const matches = compileMutedWords(["ass"])!;
    expect(matches("what an ASS.")).toBe(true);
    expect(matches("ass")).toBe(true);
    expect(matches("first class")).toBe(false);
    expect(matches("assessment")).toBe(false);
  });

  it("matches phrases across any whitespace", () => {
    const matches = compileMutedWords(["buy now"])!;
    expect(matches("Buy\n now!")).toBe(true);
    expect(matches("buy nowhere")).toBe(false);
  });

  it("matches non-letter edges as written", () => {
    const matches = compileMutedWords(["#crypto", "🍆"])!;
    expect(matches("big news #crypto")).toBe(true);
    expect(matches("#cryptocurrency")).toBe(false);
    expect(matches("look🍆here")).toBe(true);
  });

  it("treats regex syntax literally", () => {
    const matches = compileMutedWords(["a.b"])!;
    expect(matches("a.b")).toBe(true);
    expect(matches("axb")).toBe(false);
  });

  it("compares under NFKC", () => {
    expect(compileMutedWords(["ｓｐａｍ"])!("spam")).toBe(true);
    expect(compileMutedWords(["spam"])!("ｓｐａｍ")).toBe(true);
  });

  it("matches non-Latin words", () => {
    const matches = compileMutedWords(["спам"])!;
    expect(matches("это спам")).toBe(true);
    expect(matches("спамер")).toBe(false);
  });
});
