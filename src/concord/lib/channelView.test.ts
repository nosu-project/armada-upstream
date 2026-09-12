import { describe, expect, it } from "vitest";

import { channelView, withChannelView } from "@/concord/lib/channelView";
import { withChannelCategory } from "@/concord/lib/channelCategory";
import { ARMADA_GIT_CHANNEL_METADATA_KEY } from "@/concord/lib/types";

import type { ChannelMetadata } from "@/concord/lib/types";

const base: ChannelMetadata = { name: "general", private: false };

describe("channelView", () => {
  it("reads an absent field as chat, the spec default", () => {
    expect(channelView(base)).toBe("chat");
  });

  it("reads forum", () => {
    expect(channelView({ ...base, view: "forum" })).toBe("forum");
  });

  it("treats an unknown or malformed value as chat, never refusing it", () => {
    // CORD-03 §2: unknown values are treated as "chat" so the set can grow
    // additively. A client that predates a future value keeps rendering.
    expect(channelView({ ...base, view: "kanban" })).toBe("chat");
    expect(channelView({ ...base, view: 7 })).toBe("chat");
    expect(channelView({ ...base, view: { kind: "forum" } })).toBe("chat");
    expect(channelView({ ...base, view: "" })).toBe("chat");
  });

  it("writes forum and round-trips it", () => {
    const forum = withChannelView(base, "forum");
    expect(forum.view).toBe("forum");
    expect(channelView(forum)).toBe("forum");
  });

  it("writes chat as an absent field so identical state serializes identically", () => {
    const back = withChannelView(withChannelView(base, "forum"), "chat");
    expect("view" in back).toBe(false);
    expect(JSON.stringify(back)).toBe(JSON.stringify(base));
  });

  it("keeps the private flag and every sibling field", () => {
    // A view edit is a metadata edition like any other: dropping `private`
    // would publish a Private Channel as public, and dropping an unknown
    // top-level field would destroy another client's data (CORD-02 §6).
    const metadata: ChannelMetadata = {
      name: "staff",
      private: true,
      future: { keep: true },
      custom: { [ARMADA_GIT_CHANNEL_METADATA_KEY]: { repositories: [] } },
    };
    const forum = withChannelView(metadata, "forum");
    expect(forum.private).toBe(true);
    expect(forum.future).toEqual({ keep: true });
    expect(forum.custom).toEqual({ [ARMADA_GIT_CHANNEL_METADATA_KEY]: { repositories: [] } });
  });

  it("survives the other metadata editors, which must round-trip it", () => {
    // The spec's load-bearing case: a rename or a filing from a client that
    // knows nothing about forums must not flatten one. Filing goes through
    // `withChannelCategory`, which spreads the metadata it was handed.
    const filed = withChannelCategory(withChannelView(base, "forum"), "Discussion");
    expect(channelView(filed)).toBe("forum");
  });

  it("does not mutate the metadata it was given", () => {
    const metadata: ChannelMetadata = { ...base };
    withChannelView(metadata, "forum");
    expect("view" in metadata).toBe(false);
  });
});
