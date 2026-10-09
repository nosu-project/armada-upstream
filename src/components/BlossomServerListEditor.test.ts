import { describe, expect, it } from "vitest";

import { serverFavicons } from "@/components/BlossomServerListEditor";

describe("serverFavicons", () => {
  it("tries the server's own host, then its root domain", () => {
    expect(serverFavicons("https://cdn.hzrd149.com/")).toEqual([
      "https://cdn.hzrd149.com/favicon.ico",
      "https://hzrd149.com/favicon.ico",
    ]);
  });

  it("has no second candidate for a root domain or an address", () => {
    expect(serverFavicons("https://nostr.download/")).toEqual(["https://nostr.download/favicon.ico"]);
    expect(serverFavicons("http://10.0.0.2:3000/")).toEqual(["http://10.0.0.2:3000/favicon.ico"]);
  });

  it("returns nothing for an unparseable URL", () => {
    expect(serverFavicons("not a url")).toEqual([]);
  });
});
