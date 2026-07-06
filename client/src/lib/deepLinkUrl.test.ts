import { describe, expect, it } from "vitest";

import { pathFromDeepLinkUrl } from "./deepLinkUrl";

describe("pathFromDeepLinkUrl", () => {
  it("returns null for empty input", () => {
    expect(pathFromDeepLinkUrl(null)).toBeNull();
    expect(pathFromDeepLinkUrl(undefined)).toBeNull();
    expect(pathFromDeepLinkUrl("")).toBeNull();
  });

  it("parses notification armada://open URLs", () => {
    expect(pathFromDeepLinkUrl("armada://open/s/chat.example.com/abc123")).toBe(
      "/s/chat.example.com/abc123",
    );
    expect(pathFromDeepLinkUrl("armada://open/dms/npub1xyz")).toBe("/dms/npub1xyz");
  });

  it("rejects armada://open URLs without a rooted path", () => {
    expect(pathFromDeepLinkUrl("armada://open")).toBeNull();
    expect(pathFromDeepLinkUrl("armada://opensesame")).toBeNull();
  });

  it("parses https App Link URLs to router paths", () => {
    expect(pathFromDeepLinkUrl("https://armada.buzz/s/chat.example.com/abc123")).toBe(
      "/s/chat.example.com/abc123",
    );
  });

  it("preserves query strings (group invite codes)", () => {
    expect(
      pathFromDeepLinkUrl("https://armada.buzz/s/chat.example.com/abc?code=SECRET"),
    ).toBe("/s/chat.example.com/abc?code=SECRET");
  });

  it("preserves fragments (Concord invite secrets)", () => {
    expect(pathFromDeepLinkUrl("https://armada.buzz/invite#dG9rZW4")).toBe(
      "/invite#dG9rZW4",
    );
    expect(pathFromDeepLinkUrl("https://armada.buzz/invite/naddr1qq#frag")).toBe(
      "/invite/naddr1qq#frag",
    );
  });

  it("treats a bare domain open as no deep link", () => {
    expect(pathFromDeepLinkUrl("https://armada.buzz")).toBeNull();
    expect(pathFromDeepLinkUrl("https://armada.buzz/")).toBeNull();
  });

  it("returns null for other schemes and garbage", () => {
    expect(pathFromDeepLinkUrl("http://armada.buzz/invite")).toBeNull();
    expect(pathFromDeepLinkUrl("bitcoin:bc1qxyz")).toBeNull();
    expect(pathFromDeepLinkUrl("not a url")).toBeNull();
  });
});
