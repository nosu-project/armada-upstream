import { describe, expect, it } from "vitest";

import { parseInline, splitInlineCode, splitMarkdownBlocks } from "./markdown";

describe("splitMarkdownBlocks", () => {
  it("passes plain text through as one block", () => {
    expect(splitMarkdownBlocks("hello world")).toEqual([
      { type: "text", text: "hello world" },
    ]);
  });

  it("extracts fenced code blocks with language", () => {
    const blocks = splitMarkdownBlocks("before\n```js\nconst x = 1;\n```\nafter");
    expect(blocks).toEqual([
      { type: "text", text: "before\n" },
      { type: "code", lang: "js", code: "const x = 1;" },
      { type: "text", text: "\nafter" },
    ]);
  });

  it("extracts fenced code blocks without language", () => {
    const blocks = splitMarkdownBlocks("```\nplain code\n```");
    expect(blocks).toEqual([{ type: "code", lang: undefined, code: "plain code" }]);
  });

  it("does not link-parse an unclosed fence (stays literal text)", () => {
    const blocks = splitMarkdownBlocks("```\nunclosed");
    expect(blocks).toEqual([{ type: "text", text: "```\nunclosed" }]);
  });

  it("keeps an empty fence literal", () => {
    expect(splitMarkdownBlocks("``````")).toEqual([{ type: "text", text: "``````" }]);
  });

  it("merges consecutive quote lines into one quote block", () => {
    const blocks = splitMarkdownBlocks("> first\n> second\nreply");
    expect(blocks).toEqual([
      { type: "quote", text: "first\nsecond" },
      { type: "text", text: "reply" },
    ]);
  });

  it("keeps quote markers inside code blocks literal", () => {
    const blocks = splitMarkdownBlocks("```\n> not a quote\n```");
    expect(blocks).toEqual([{ type: "code", lang: undefined, code: "> not a quote" }]);
  });
});

describe("splitInlineCode", () => {
  it("extracts inline code spans", () => {
    expect(splitInlineCode("use `npm i` to install")).toEqual([
      { code: false, value: "use " },
      { code: true, value: "npm i" },
      { code: false, value: " to install" },
    ]);
  });

  it("leaves unmatched backticks alone", () => {
    expect(splitInlineCode("a ` b")).toEqual([{ code: false, value: "a ` b" }]);
  });
});

describe("parseInline", () => {
  it("parses bold", () => {
    expect(parseInline("a **b** c")).toEqual([
      { type: "text", value: "a " },
      { type: "strong", children: [{ type: "text", value: "b" }] },
      { type: "text", value: " c" },
    ]);
  });

  it("parses italic with * and _", () => {
    expect(parseInline("*a*")).toEqual([
      { type: "em", children: [{ type: "text", value: "a" }] },
    ]);
    expect(parseInline("_a_")).toEqual([
      { type: "em", children: [{ type: "text", value: "a" }] },
    ]);
  });

  it("keeps snake_case literal", () => {
    expect(parseInline("snake_case_name")).toEqual([
      { type: "text", value: "snake_case_name" },
    ]);
  });

  it("parses underline, strikethrough and spoilers", () => {
    expect(parseInline("__u__ ~~s~~ ||sp||")).toEqual([
      { type: "u", children: [{ type: "text", value: "u" }] },
      { type: "text", value: " " },
      { type: "s", children: [{ type: "text", value: "s" }] },
      { type: "text", value: " " },
      { type: "spoiler", children: [{ type: "text", value: "sp" }] },
    ]);
  });

  it("nests bold and italic", () => {
    expect(parseInline("**bold *and italic***")).toEqual([
      {
        type: "strong",
        children: [
          { type: "text", value: "bold " },
          { type: "em", children: [{ type: "text", value: "and italic" }] },
        ],
      },
    ]);
  });

  it("leaves whitespace-only delimiters literal", () => {
    expect(parseInline("** **")).toEqual([{ type: "text", value: "** **" }]);
  });

  it("leaves stray asterisks literal", () => {
    expect(parseInline("2 * 3 = 6")).toEqual([{ type: "text", value: "2 * 3 = 6" }]);
  });
});
