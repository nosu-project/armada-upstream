import { describe, expect, it } from "vitest";

import { buildCommentTree, commentParentOf, flattenCommentTree } from "@/concord/lib/commentTree";

import type { ChatMsg } from "@/components/chat/transport";

const ROOT = "r".repeat(64);

function comment(id: string, parent: string, createdAt: number): ChatMsg {
  return {
    id,
    pubkey: "a".repeat(64),
    created_at: createdAt,
    kind: 1111,
    content: id,
    tags: [["K", "9"], ["E", ROOT, "", "p"], ["k", parent === ROOT ? "9" : "1111"], ["e", parent, "", "p"]],
    sig: "",
  } as unknown as ChatMsg;
}

const ids = (nodes: ReturnType<typeof buildCommentTree>) => nodes.map((n) => n.comment.id);

describe("commentParentOf", () => {
  it("reads the lowercase e tag, not the uppercase root", () => {
    expect(commentParentOf(comment("c1", "c0", 1))).toBe("c0");
    expect(commentParentOf({ tags: [["E", ROOT]] })).toBeUndefined();
  });
});

describe("buildCommentTree", () => {
  it("nests a reply under the comment it answers, keeping oldest-first at every level", () => {
    const tree = buildCommentTree(ROOT, [
      comment("a", ROOT, 1),
      comment("b", ROOT, 2),
      comment("a1", "a", 3),
      comment("a2", "a", 4),
      comment("a1x", "a1", 5),
    ]);
    expect(ids(tree)).toEqual(["a", "b"]);
    expect(ids(tree[0].children)).toEqual(["a1", "a2"]);
    expect(ids(tree[0].children[0].children)).toEqual(["a1x"]);
    expect(tree[0].children[0].children[0].depth).toBe(2);
    expect(tree[1].depth).toBe(0);
  });

  it("puts a comment whose parent is missing at the top level rather than dropping it", () => {
    const tree = buildCommentTree(ROOT, [comment("a", ROOT, 1), comment("orphan", "gone", 2)]);
    expect(ids(tree)).toEqual(["a", "orphan"]);
    expect(tree[1].depth).toBe(0);
  });

  it("keeps a cycle's comments reachable", () => {
    const tree = buildCommentTree(ROOT, [comment("x", "y", 1), comment("y", "x", 2), comment("z", ROOT, 3)]);
    expect(flattenCommentTree(tree).map((c) => c.id).sort()).toEqual(["x", "y", "z"]);
  });

  it("flattens depth-first, a node before its subtree", () => {
    const tree = buildCommentTree(ROOT, [comment("a", ROOT, 1), comment("b", ROOT, 2), comment("a1", "a", 3)]);
    expect(flattenCommentTree(tree).map((c) => c.id)).toEqual(["a", "a1", "b"]);
  });
});
