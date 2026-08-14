import { describe, expect, it } from "vitest";

import { focusMessageRoute } from "@/lib/switcher";

describe("focusMessageRoute", () => {
  it("focuses a Concord timeline message", () => {
    expect(focusMessageRoute("/c/community/channel", "older-message"))
      .toBe("/c/community/channel/m/older-message");
  });

  it("focuses a Concord reply inside its thread", () => {
    expect(focusMessageRoute("/c/community/channel", "reply", "thread-root"))
      .toBe("/c/community/channel/t/thread-root/m/reply");
  });

  it("focuses NIP-29 and DM message results", () => {
    expect(focusMessageRoute("/s/relay.example/group", "event-id"))
      .toBe("/s/relay.example/group/m/event-id");
    expect(focusMessageRoute("/dm/npub1peer", "rumor-id"))
      .toBe("/dm/npub1peer/m/rumor-id");
  });
});
