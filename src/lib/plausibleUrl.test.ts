import { describe, expect, it } from "vitest";

import { sanitizePlausibleUrl } from "./plausibleUrl";

describe("sanitizePlausibleUrl", () => {
  it("passes static routes through unchanged", () => {
    expect(sanitizePlausibleUrl("https://armada.buzz/")).toBe("https://armada.buzz/");
    expect(sanitizePlausibleUrl("https://armada.buzz/about")).toBe("https://armada.buzz/about");
    expect(sanitizePlausibleUrl("https://armada.buzz/settings")).toBe("https://armada.buzz/settings");
  });

  it("collapses the DM peer pubkey", () => {
    expect(sanitizePlausibleUrl("https://armada.buzz/dm/npub1abc123")).toBe(
      "https://armada.buzz/dm/:peer",
    );
  });

  it("collapses the peer pubkey on the pre-rename /dms path too", () => {
    expect(sanitizePlausibleUrl("https://armada.buzz/dms/npub1abc123")).toBe(
      "https://armada.buzz/dm/:peer",
    );
  });

  it("collapses server, group, and static sub-routes", () => {
    expect(sanitizePlausibleUrl("https://armada.buzz/s/wss%3A%2F%2Frelay.example")).toBe(
      "https://armada.buzz/s/:server",
    );
    expect(sanitizePlausibleUrl("https://armada.buzz/s/relay/group123")).toBe(
      "https://armada.buzz/s/:server/:groupId",
    );
    expect(sanitizePlausibleUrl("https://armada.buzz/s/relay/projects")).toBe(
      "https://armada.buzz/s/:server/projects",
    );
    expect(sanitizePlausibleUrl("https://armada.buzz/s/relay/inbox")).toBe(
      "https://armada.buzz/s/:server/inbox",
    );
  });

  it("collapses Concord community and channel ids", () => {
    expect(sanitizePlausibleUrl("https://armada.buzz/c1/comm")).toBe("https://armada.buzz/c1/:communityId");
    expect(sanitizePlausibleUrl("https://armada.buzz/c1/comm/chan")).toBe(
      "https://armada.buzz/c1/:communityId/:channelId",
    );
    expect(sanitizePlausibleUrl("https://armada.buzz/c/comm")).toBe("https://armada.buzz/c/:communityId");
    expect(sanitizePlausibleUrl("https://armada.buzz/c/comm/chan")).toBe(
      "https://armada.buzz/c/:communityId/:channelId",
    );
  });

  it("collapses invite naddr", () => {
    expect(sanitizePlausibleUrl("https://armada.buzz/invite/naddr1xyz")).toBe(
      "https://armada.buzz/invite/:naddr",
    );
  });

  it("strips query string and hash (may carry secrets/tokens)", () => {
    expect(sanitizePlausibleUrl("https://armada.buzz/invite/naddr1xyz?s=secret#frag")).toBe(
      "https://armada.buzz/invite/:naddr",
    );
    expect(sanitizePlausibleUrl("https://armada.buzz/about?ref=twitter")).toBe(
      "https://armada.buzz/about",
    );
    expect(sanitizePlausibleUrl("https://armada.buzz/remoteloginsuccess#token=abc")).toBe(
      "https://armada.buzz/remoteloginsuccess",
    );
  });

  it("strips query/hash from unknown paths as a safe default", () => {
    expect(sanitizePlausibleUrl("https://armada.buzz/whatever?x=1#y")).toBe(
      "https://armada.buzz/whatever",
    );
  });

  it("returns the input unchanged when it is not a parseable URL", () => {
    expect(sanitizePlausibleUrl("not a url")).toBe("not a url");
  });
});
