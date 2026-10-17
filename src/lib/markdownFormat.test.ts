import { describe, expect, it } from "vitest";

import { activeFormats, toggleFormat, type FormatKind } from "@/lib/markdownFormat";

/** `[` and `]` mark the selection in and out. */
function run(marked: string, kind: FormatKind): string {
  const start = marked.indexOf("[");
  const end = marked.indexOf("]") - 1;
  const text = marked.replace("[", "").replace("]", "");
  const r = toggleFormat(text, start, end, kind);
  return `${r.text.slice(0, r.start)}[${r.text.slice(r.start, r.end)}]${r.text.slice(r.end)}`;
}

describe("toggleFormat", () => {
  it("wraps and unwraps inline formats", () => {
    expect(run("say [hi] now", "bold")).toBe("say **[hi]** now");
    expect(run("say **[hi]** now", "bold")).toBe("say [hi] now");
    expect(run("say [**hi**] now", "bold")).toBe("say [hi] now");
    expect(run("[x]", "strike")).toBe("~~[x]~~");
    expect(run("[x]", "spoiler")).toBe("||[x]||");
    expect(run("[x]", "underline")).toBe("__[x]__");
    expect(run("[x]", "code")).toBe("`[x]`");
  });

  it("tells italic from bold in a run of stars", () => {
    expect(run("**[x]**", "italic")).toBe("***[x]***");
    expect(run("***[x]***", "italic")).toBe("**[x]**");
    expect(run("***[x]***", "bold")).toBe("*[x]*");
    expect(run("*[x]*", "bold")).toBe("***[x]***");
  });

  it("keeps edge whitespace outside the markers", () => {
    expect(run("a[ b ]c", "bold")).toBe("a **[b]** c");
  });

  it("inserts an empty pair at a collapsed caret", () => {
    expect(run("a []b", "bold")).toBe("a **[]**b");
  });

  it("wraps each line of a multi-line selection", () => {
    const r = toggleFormat("one\ntwo", 0, 7, "bold");
    expect(r.text).toBe("**one**\n**two**");
    expect(toggleFormat(r.text, 0, r.text.length, "bold").text).toBe("one\ntwo");
  });

  it("fences a multi-line code selection", () => {
    const r = toggleFormat("a\nb", 0, 3, "code");
    expect(r.text).toBe("```\na\nb\n```");
    expect(toggleFormat(r.text, r.start, r.end, "code").text).toBe("a\nb");
  });

  it("toggles quote prefixes on every selected line", () => {
    const r = toggleFormat("x\none\ntwo", 3, 7, "quote");
    expect(r.text).toBe("x\n> one\n> two");
    expect(toggleFormat(r.text, 4, 10, "quote").text).toBe("x\none\ntwo");
  });
});

describe("activeFormats", () => {
  it("reports the formats around a selection", () => {
    const text = "***~~hi~~***";
    expect([...activeFormats(text, 5, 7)].sort()).toEqual(["bold", "italic", "strike"]);
    expect(activeFormats("hi", 0, 2).size).toBe(0);
    expect(toggleFormat(text, 5, 7, "bold").text).toBe("*~~hi~~*");
  });
});
