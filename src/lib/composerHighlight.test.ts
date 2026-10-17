import { describe, expect, it } from "vitest";

import { HL, highlightRuns } from "@/lib/composerHighlight";

function flagsAt(text: string, needle: string) {
  const at = text.indexOf(needle);
  let pos = 0;
  for (const run of highlightRuns(text)) {
    if (at >= pos && at < pos + run.text.length) return run.flags;
    pos += run.text.length;
  }
  throw new Error(`not found: ${needle}`);
}

describe("highlightRuns", () => {
  it("reproduces the source text exactly", () => {
    const text = "> **b** _i_ `c` https://x.y/a_b_c ||s||\n```\ncode **no**\n```\n# h\n-# sub\n- item";
    expect(highlightRuns(text).map((r) => r.text).join("")).toBe(text);
  });

  it("styles content and dims markers", () => {
    const text = "a **bold** and ~~gone~~";
    expect(flagsAt(text, "bold")).toBe(HL.BOLD);
    expect(flagsAt(text, "**")).toBe(HL.BOLD | HL.MARKER);
    expect(flagsAt(text, "gone")).toBe(HL.STRIKE);
  });

  it("nests italic inside bold", () => {
    expect(flagsAt("**a *b* c**", "b")).toBe(HL.BOLD | HL.ITALIC);
  });

  it("leaves code, links and fenced blocks unformatted inside", () => {
    expect(flagsAt("`**x**`", "x")).toBe(HL.CODE);
    expect(flagsAt("https://e.com/a_b_c", "b")).toBe(HL.LINK);
    expect(flagsAt("```\n**x**\n```", "x")).toBe(HL.CODE_BLOCK);
  });

  it("marks mentions as atoms", () => {
    const runs = highlightRuns("hi @Al_ice_ x", [{ pubkey: "p", cStart: 3, cEnd: 9, dStart: 3, dEnd: 11 }]);
    expect(runs.find((r) => r.text === "@Al_ice_")?.flags).toBe(HL.MENTION);
  });
});
