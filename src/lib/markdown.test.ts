import { describe, expect, it } from "vitest";

import { parseInline, splitInlineCode, splitMarkdownBlocks, splitMarkdownLinks } from "./markdown";

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

describe("splitMarkdownBlocks (document mode)", () => {
  it("keeps chat mode free of document blocks", () => {
    expect(splitMarkdownBlocks("## Heading\n- item")).toEqual([
      { type: "text", text: "## Heading\n- item" },
    ]);
  });

  it("extracts ATX headings with their level", () => {
    expect(splitMarkdownBlocks("## Feature Request\nbody text", true)).toEqual([
      { type: "heading", level: 2, text: "Feature Request" },
      { type: "text", text: "body text" },
    ]);
  });

  it("leaves hashtags and unspaced hashes literal", () => {
    expect(splitMarkdownBlocks("#nostr is neat", true)).toEqual([
      { type: "text", text: "#nostr is neat" },
    ]);
  });

  it("groups consecutive list items, split by ordering", () => {
    expect(splitMarkdownBlocks("- one\n- two\n3. three\n4. four", true)).toEqual([
      { type: "list", ordered: false, start: 1, items: ["one", "two"] },
      { type: "list", ordered: true, start: 3, items: ["three", "four"] },
    ]);
  });

  it("keeps italics literal (a list marker requires a space)", () => {
    expect(splitMarkdownBlocks("*emphasis* stays inline", true)).toEqual([
      { type: "text", text: "*emphasis* stays inline" },
    ]);
  });

  it("folds one boundary newline into the neighbor block", () => {
    expect(splitMarkdownBlocks("## H\n\npara one\n\npara two\n\n- li", true)).toEqual([
      { type: "heading", level: 2, text: "H" },
      { type: "text", text: "para one\n\npara two" },
      { type: "list", ordered: false, start: 1, items: ["li"] },
    ]);
  });

  it("still extracts fences and quotes alongside document blocks", () => {
    expect(splitMarkdownBlocks("# Title\n> quoted\n```\ncode\n```", true)).toEqual([
      { type: "heading", level: 1, text: "Title" },
      { type: "quote", text: "quoted" },
      { type: "code", lang: undefined, code: "code" },
    ]);
  });
});

describe("splitMarkdownLinks", () => {
  it("splits [text](url) links out of a run", () => {
    expect(splitMarkdownLinks("see [F-Droid](https://f-droid.org) today")).toEqual([
      { type: "text", value: "see " },
      { type: "link", text: "F-Droid", url: "https://f-droid.org" },
      { type: "text", value: " today" },
    ]);
  });

  it("reduces image syntax to its bare URL for the media tokenizer", () => {
    expect(splitMarkdownLinks("![shot](https://blossom.example/a.png)")).toEqual([
      { type: "text", value: "https://blossom.example/a.png" },
    ]);
  });

  it("leaves non-http schemes literal", () => {
    expect(splitMarkdownLinks("[x](javascript:alert(1))")).toEqual([
      { type: "text", value: "[x](javascript:alert(1))" },
    ]);
  });
});
