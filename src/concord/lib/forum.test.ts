import { describe, expect, it } from "vitest";

import {
  SUBJECT_MAX_BYTES,
  forumPosts,
  isTitledPost,
  subjectBytes,
  subjectOf,
  subjectTags,
  truncateUtf8,
} from "@/concord/lib/forum";

import type { ChatMsg } from "@/components/chat/transport";

function msg(over: Partial<ChatMsg> & { id: string }): ChatMsg {
  return {
    pubkey: "a".repeat(64),
    created_at: 1_000,
    kind: 9,
    tags: [],
    content: "",
    ...over,
  };
}

const post = (id: string, title: string, created_at: number, pubkey = "a".repeat(64)) =>
  msg({ id, created_at, pubkey, tags: [["subject", title]], content: `body of ${id}` });

const reply = (id: string, root: string, created_at: number, pubkey: string) =>
  msg({ id, kind: 1111, created_at, pubkey, tags: [["E", root], ["e", root]] });

describe("subjectOf", () => {
  it("reads the subject tag of a kind-9 message", () => {
    expect(subjectOf(msg({ id: "x", tags: [["subject", "Release plan"]] }))).toBe("Release plan");
  });

  it("is kind 9 only: a comment is never a post, whatever it carries", () => {
    expect(subjectOf(msg({ id: "x", kind: 1111, tags: [["subject", "Not a post"]] }))).toBeUndefined();
    expect(subjectOf(msg({ id: "x", kind: 1068, tags: [["subject", "Not a post"]] }))).toBeUndefined();
  });

  it("reads blank, missing and malformed subjects as no title", () => {
    expect(subjectOf(msg({ id: "x" }))).toBeUndefined();
    expect(subjectOf(msg({ id: "x", tags: [["subject", "   "]] }))).toBeUndefined();
    expect(subjectOf(msg({ id: "x", tags: [["subject"]] }))).toBeUndefined();
  });

  it("folds whitespace and trims", () => {
    expect(subjectOf(msg({ id: "x", tags: [["subject", "  two \n words  "]] }))).toBe("two words");
  });

  it("truncates an over-long title for display rather than dropping the message", () => {
    const long = "é".repeat(SUBJECT_MAX_BYTES); // 2 bytes each
    const title = subjectOf(msg({ id: "x", tags: [["subject", long]] }));
    expect(title).toBeDefined();
    expect(new TextEncoder().encode(title!).length).toBeLessThanOrEqual(SUBJECT_MAX_BYTES);
    // Cut on a code-point boundary: never a replacement character.
    expect(title).not.toContain("\uFFFD");
    expect(isTitledPost(msg({ id: "x", tags: [["subject", long]] }))).toBe(true);
  });
});

describe("truncateUtf8", () => {
  it("never splits a multi-byte sequence", () => {
    expect(truncateUtf8("aé", 2)).toBe("a");
    expect(truncateUtf8("aé", 3)).toBe("aé");
    expect(truncateUtf8("😀😀", 5)).toBe("😀");
  });
});

describe("subjectTags", () => {
  it("emits one subject tag with the folded title", () => {
    expect(subjectTags("  Hello   world ")).toEqual([["subject", "Hello world"]]);
  });

  it("refuses a blank title", () => {
    expect(() => subjectTags("   ")).toThrow(/title/);
  });

  it("refuses a title over the byte cap rather than clipping it silently", () => {
    expect(() => subjectTags("x".repeat(SUBJECT_MAX_BYTES + 1))).toThrow(/limited/);
    expect(subjectTags("x".repeat(SUBJECT_MAX_BYTES))).toHaveLength(1);
  });

  it("counts bytes, not characters", () => {
    expect(subjectBytes("é")).toBe(2);
    expect(() => subjectTags("é".repeat(SUBJECT_MAX_BYTES / 2 + 1))).toThrow();
  });
});

describe("forumPosts", () => {
  const ana = "1".repeat(64);
  const ben = "2".repeat(64);
  const p1 = post("p1", "Old but busy", 100);
  const p2 = post("p2", "Newest, quiet", 300);
  const p3 = post("p3", "Middle", 200);
  const chatter = msg({ id: "c1", created_at: 400, content: "just chat" });
  const replies = new Map<string, ChatMsg[]>([
    ["p1", [reply("r1", "p1", 150, ana), reply("r2", "p1", 500, ben), reply("r3", "p1", 450, ana)]],
  ]);
  const repliesFor = (id: string) => replies.get(id) ?? [];

  it("lists only titled posts; timeline chatter stays out of the feed", () => {
    const feed = forumPosts([p1, p2, p3, chatter], repliesFor, { sort: "newest" });
    expect(feed.map((p) => p.root.id)).toEqual(["p2", "p3", "p1"]);
  });

  it("active sort bumps a post on its newest comment", () => {
    const feed = forumPosts([p1, p2, p3], repliesFor, { sort: "active" });
    expect(feed.map((p) => p.root.id)).toEqual(["p1", "p2", "p3"]);
    expect(feed[0].lastActivityAt).toBe(500);
    expect(feed[0].lastActivityBy).toBe(ben);
    expect(feed[0].replyCount).toBe(3);
  });

  it("a post with no comments is its own newest activity", () => {
    const [p] = forumPosts([p2], repliesFor, { sort: "active" });
    expect(p.lastActivityAt).toBe(300);
    expect(p.lastActivityBy).toBe(p2.pubkey);
    expect(p.replyCount).toBe(0);
    expect(p.participants).toEqual([]);
  });

  it("lists distinct commenters newest-first", () => {
    // replies arrive oldest-first from the transport; the summary walks them
    // newest-first so the freshest voice leads the avatar stack.
    const sorted = [...replies.get("p1")!].sort((a, b) => a.created_at - b.created_at);
    const [p] = forumPosts([p1], () => sorted, { sort: "active" });
    expect(p.participants).toEqual([ben, ana]);
  });

  it("pins lead regardless of sort", () => {
    const feed = forumPosts([p1, p2, p3], repliesFor, { sort: "active", isPinned: (id) => id === "p3" });
    expect(feed.map((p) => p.root.id)).toEqual(["p3", "p1", "p2"]);
    expect(feed[0].pinned).toBe(true);
  });

  it("breaks ties on the lower id so every client lists one order", () => {
    const a = post("b-id", "A", 100);
    const b = post("a-id", "B", 100);
    expect(forumPosts([a, b], () => [], { sort: "newest" }).map((p) => p.root.id)).toEqual(["a-id", "b-id"]);
  });
});
