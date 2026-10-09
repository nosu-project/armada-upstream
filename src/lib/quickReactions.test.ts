import { describe, expect, it } from "vitest";

import { nextQuickReactionTags, parseQuickReactions, quickReactionTags } from "@/lib/quickReactions";

const SET = `30030:${"b".repeat(64)}:cats`;

describe("parseQuickReactions", () => {
  it("reads reaction tags in order, with a custom emoji's url and set", () => {
    expect(parseQuickReactions({
      tags: [
        ["reaction", "🔥"],
        ["client", "x"],
        ["reaction", ":cat:", "https://e.example/cat.png", SET],
        ["reaction", "+"],
      ],
    })).toEqual([
      { key: "🔥" },
      { key: ":cat:", url: "https://e.example/cat.png", set: SET },
      { key: "+" },
    ]);
  });

  it("keeps the first of a repeated key and skips empty ones", () => {
    expect(parseQuickReactions({ tags: [["reaction", "🔥"], ["reaction", ""], ["reaction", "🔥", "https://x.example/a.png"]] }))
      .toEqual([{ key: "🔥" }]);
  });

  it("drops an image url that isn't a safe remote one", () => {
    expect(parseQuickReactions({ tags: [["reaction", ":cat:", "javascript:alert(1)"]] })).toEqual([{ key: ":cat:" }]);
  });
});

describe("quickReactionTags", () => {
  it("round-trips through the parser", () => {
    const reactions = [{ key: "🙏" }, { key: ":cat:", url: "https://e.example/cat.png", set: SET }];
    expect(parseQuickReactions({ tags: quickReactionTags(reactions) })).toEqual(reactions);
  });
});

describe("nextQuickReactionTags", () => {
  it("replaces the reactions, keeps other tags, and leaves the client tag to the publisher", () => {
    const prev = { tags: [["reaction", "🔥"], ["x-other", "kept"], ["client", "Other"]] };
    expect(nextQuickReactionTags(prev, [{ key: "🙏" }])).toEqual([["x-other", "kept"], ["reaction", "🙏"]]);
  });
});
