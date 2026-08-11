import { describe, expect, it } from "vitest";

import {
  APP_BLOSSOM_SERVERS,
  blossomFallbackUrls,
  getEffectiveBlossomServers,
  normalizeBlossomServerUrl,
  parseBlossomServerList,
} from "./blossom";

import type { NostrEvent } from "@nostrify/nostrify";

function listEvent(servers: string[]): NostrEvent {
  return {
    id: "0".repeat(64),
    pubkey: "0".repeat(64),
    created_at: 1700000000,
    kind: 10063,
    content: "",
    tags: servers.map((url) => ["server", url]),
    sig: "0".repeat(128),
  };
}

describe("parseBlossomServerList", () => {
  it("extracts server tags", () => {
    const event = listEvent(["https://a.example/", "https://b.example/"]);
    expect(parseBlossomServerList(event)).toEqual([
      "https://a.example/",
      "https://b.example/",
    ]);
  });

  it("drops invalid URLs and unrelated tags", () => {
    const event = listEvent(["not a url", "https://ok.example/"]);
    event.tags.push(["relay", "wss://r.example"]);
    expect(parseBlossomServerList(event)).toEqual(["https://ok.example/"]);
  });
});

describe("getEffectiveBlossomServers", () => {
  it("returns app servers when the user has none", () => {
    expect(getEffectiveBlossomServers({ servers: [], updatedAt: 0 }, true))
      .toEqual(APP_BLOSSOM_SERVERS);
  });

  it("merges app servers first, then user servers, deduped", () => {
    const userMeta = {
      servers: ["https://mine.example/", "https://blossom.primal.net"],
      updatedAt: 0,
    };
    expect(getEffectiveBlossomServers(userMeta, true)).toEqual([
      ...APP_BLOSSOM_SERVERS,
      "https://mine.example/",
    ]);
  });

  it("dedupes case- and trailing-slash-insensitively", () => {
    const userMeta = {
      servers: ["HTTPS://BLOSSOM.PRIMAL.NET///", "https://mine.example/"],
      updatedAt: 0,
    };
    const effective = getEffectiveBlossomServers(userMeta, true);
    expect(effective).toEqual([...APP_BLOSSOM_SERVERS, "https://mine.example/"]);
  });

  it("returns only user servers when app servers are disabled", () => {
    const userMeta = { servers: ["https://mine.example/"], updatedAt: 0 };
    expect(getEffectiveBlossomServers(userMeta, false)).toEqual([
      "https://mine.example/",
    ]);
  });

  it("falls back to app servers when disabled but the user list is empty", () => {
    expect(getEffectiveBlossomServers({ servers: [], updatedAt: 0 }, false))
      .toEqual(APP_BLOSSOM_SERVERS);
  });
});

describe("blossomFallbackUrls", () => {
  const SHA = "a".repeat(64);
  const servers = [
    "https://a.example/",
    "https://b.example/",
    "https://c.example/",
  ];

  it("returns the same blob on every other server for a content-addressed URL", () => {
    expect(blossomFallbackUrls(`https://a.example/${SHA}`, servers)).toEqual([
      `https://b.example/${SHA}`,
      `https://c.example/${SHA}`,
    ]);
  });

  it("keeps the extension and query, and excludes the source origin", () => {
    expect(
      blossomFallbackUrls(`https://b.example/${SHA}.png?x=1`, servers),
    ).toEqual([
      `https://a.example/${SHA}.png?x=1`,
      `https://c.example/${SHA}.png?x=1`,
    ]);
  });

  it("dedupes servers by origin (trailing slash / case insensitive)", () => {
    expect(
      blossomFallbackUrls(`https://a.example/${SHA}`, [
        "https://B.EXAMPLE///",
        "https://b.example/",
      ]),
    ).toEqual([`https://b.example/${SHA}`]);
  });

  it("returns [] for a non-content-addressed URL", () => {
    expect(
      blossomFallbackUrls("https://a.example/photo.png", servers),
    ).toEqual([]);
  });

  it("returns [] for an unparseable URL", () => {
    expect(blossomFallbackUrls("not a url", servers)).toEqual([]);
  });
});

describe("normalizeBlossomServerUrl", () => {
  it("adds https and a trailing slash to bare hostnames", () => {
    expect(normalizeBlossomServerUrl("blossom.example.com")).toBe(
      "https://blossom.example.com/",
    );
  });

  it("keeps explicit https URLs, ensuring the trailing slash", () => {
    expect(normalizeBlossomServerUrl("https://blossom.example.com"))
      .toBe("https://blossom.example.com/");
    expect(normalizeBlossomServerUrl("https://blossom.example.com/"))
      .toBe("https://blossom.example.com/");
  });

  it("strips query and hash", () => {
    expect(normalizeBlossomServerUrl("https://b.example/?a=1#frag")).toBe(
      "https://b.example/",
    );
  });

  it("rejects non-http(s) schemes and garbage", () => {
    expect(normalizeBlossomServerUrl("wss://relay.example")).toBeNull();
    expect(normalizeBlossomServerUrl("")).toBeNull();
    expect(normalizeBlossomServerUrl("   ")).toBeNull();
    expect(normalizeBlossomServerUrl("http://")).toBeNull();
  });
});
