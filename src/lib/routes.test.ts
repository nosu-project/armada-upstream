import { describe, expect, it } from "vitest";

import {
  type ChatRoute,
  chatRoute,
  chatRouteTemplate,
  parseChatRoute,
  roomPath,
  withoutMessage,
} from "./routes";

/** Every legal shape, as the pair the builder and parser must agree on. */
const ROUNDTRIPS: Array<[ChatRoute, string, string]> = [
  // NIP-29 / Buzz.
  [{ kind: "nip29", relayUrl: "wss://relay.example" }, "/s/relay.example", "/s/:server"],
  [
    { kind: "nip29", relayUrl: "wss://relay.example", pane: "inbox" },
    "/s/relay.example/inbox",
    "/s/:server/inbox",
  ],
  [
    { kind: "nip29", relayUrl: "wss://relay.example", groupId: "abc" },
    "/s/relay.example/abc",
    "/s/:server/:groupId",
  ],
  [
    { kind: "nip29", relayUrl: "wss://relay.example", groupId: "abc", messageId: "m1" },
    "/s/relay.example/abc/m/m1",
    "/s/:server/:groupId/m/:messageId",
  ],
  [
    { kind: "nip29", relayUrl: "wss://relay.example", groupId: "abc", threadRoot: "r1" },
    "/s/relay.example/abc/t/r1",
    "/s/:server/:groupId/t/:threadRoot",
  ],
  [
    {
      kind: "nip29",
      relayUrl: "wss://relay.example",
      groupId: "abc",
      threadRoot: "r1",
      messageId: "m1",
    },
    "/s/relay.example/abc/t/r1/m/m1",
    "/s/:server/:groupId/t/:threadRoot/m/:messageId",
  ],
  // Concord.
  [{ kind: "concord", communityId: "c" }, "/c/c", "/c/:communityId"],
  [
    { kind: "concord", communityId: "c", pane: "mentions" },
    "/c/c/mentions",
    "/c/:communityId/mentions",
  ],
  [
    { kind: "concord", communityId: "c", channelId: "ch" },
    "/c/c/ch",
    "/c/:communityId/:channelId",
  ],
  [
    { kind: "concord", communityId: "c", channelId: "ch", messageId: "m1" },
    "/c/c/ch/m/m1",
    "/c/:communityId/:channelId/m/:messageId",
  ],
  [
    { kind: "concord", communityId: "c", channelId: "ch", threadRoot: "r1" },
    "/c/c/ch/t/r1",
    "/c/:communityId/:channelId/t/:threadRoot",
  ],
  [
    { kind: "concord", communityId: "c", channelId: "ch", threadRoot: "r1", messageId: "m1" },
    "/c/c/ch/t/r1/m/m1",
    "/c/:communityId/:channelId/t/:threadRoot/m/:messageId",
  ],
  // DMs.
  [{ kind: "dm" }, "/dm", "/dm"],
  [{ kind: "dm", peer: "npub1abc" }, "/dm/npub1abc", "/dm/:peer"],
  [
    { kind: "dm", peer: "npub1abc", messageId: "m1" },
    "/dm/npub1abc/m/m1",
    "/dm/:peer/m/:messageId",
  ],
];

describe("chatRoute / parseChatRoute", () => {
  it.each(ROUNDTRIPS)("builds and parses %o", (route, path) => {
    expect(chatRoute(route)).toBe(path);
    expect(parseChatRoute(path)).toEqual(route);
  });

  it.each(ROUNDTRIPS)("templates %o", (route, _path, template) => {
    expect(chatRouteTemplate(route)).toBe(template);
  });

  it("round-trips a relay URL through the server param", () => {
    for (const relayUrl of ["wss://relay.example", "ws://localhost:4036"]) {
      const path = chatRoute({ kind: "nip29", relayUrl, groupId: "g" });
      expect(parseChatRoute(path)).toEqual({ kind: "nip29", relayUrl, groupId: "g" });
    }
  });

  it("percent-encodes ids that would otherwise break out of their segment", () => {
    const path = chatRoute({ kind: "nip29", relayUrl: "wss://relay.example", groupId: "a/b" });
    expect(path).toBe("/s/relay.example/a%2Fb");
    expect(parseChatRoute(path)).toEqual({
      kind: "nip29",
      relayUrl: "wss://relay.example",
      groupId: "a/b",
    });
  });

  it("resolves a pane word ahead of a room id, as the router does", () => {
    // A NIP-29 group may legitimately be named `inbox`; the static route wins,
    // so the parser must agree with what actually renders rather than with
    // what was intended.
    expect(parseChatRoute("/s/relay.example/inbox")).toEqual({
      kind: "nip29",
      relayUrl: "wss://relay.example",
      pane: "inbox",
    });
    // Concord channel ids are hex, so no such collision exists there.
    expect(parseChatRoute("/c/c/members")).toEqual({
      kind: "concord",
      communityId: "c",
      pane: "members",
    });
  });

  it("parses the pre-rename /dms path so a stale link still reports as a DM", () => {
    expect(parseChatRoute("/dms/npub1abc")).toEqual({ kind: "dm", peer: "npub1abc" });
  });

  it("rejects shapes that name no location", () => {
    for (const path of [
      "/",
      "/settings",
      "/invite/naddr1xyz",
      "/s",
      "/c",
      "/c1",
      // A marker that isn't `t` or `m`.
      "/c/c/ch/x/1",
      // `/m` before `/t`: a message is focused *within* a thread, not before it.
      "/c/c/ch/m/m1/t/r1",
      // Odd trailing segment.
      "/c/c/ch/t",
      // DMs have no thread panel.
      "/dm/npub1abc/t/r1",
    ]) {
      expect(parseChatRoute(path), path).toBeNull();
    }
  });
});

describe("roomPath", () => {
  it("drops thread and message focus, keeping the room", () => {
    expect(
      roomPath({
        kind: "concord",
        communityId: "c",
        channelId: "ch",
        threadRoot: "r1",
        messageId: "m1",
      }),
    ).toBe("/c/c/ch");
    expect(
      roomPath({ kind: "nip29", relayUrl: "wss://relay.example", groupId: "g", messageId: "m1" }),
    ).toBe("/s/relay.example/g");
    expect(roomPath({ kind: "dm", peer: "npub1abc", messageId: "m1" })).toBe("/dm/npub1abc");
  });
});

describe("withoutMessage", () => {
  it("drops the message focus but keeps an open thread", () => {
    // Giving up on an unresolvable reply must not close the panel the reader
    // is looking at.
    expect(
      chatRoute(
        withoutMessage({
          kind: "concord",
          communityId: "c",
          channelId: "ch",
          threadRoot: "r1",
          messageId: "m1",
        }),
      ),
    ).toBe("/c/c/ch/t/r1");
    expect(
      chatRoute(
        withoutMessage({
          kind: "nip29",
          relayUrl: "wss://relay.example",
          groupId: "g",
          messageId: "m1",
        }),
      ),
    ).toBe("/s/relay.example/g");
    expect(chatRoute(withoutMessage({ kind: "dm", peer: "npub1abc", messageId: "m1" }))).toBe(
      "/dm/npub1abc",
    );
  });

  it("leaves a location with no message focus alone", () => {
    const route: ChatRoute = { kind: "concord", communityId: "c", channelId: "ch" };
    expect(chatRoute(withoutMessage(route))).toBe(chatRoute(route));
  });
});
