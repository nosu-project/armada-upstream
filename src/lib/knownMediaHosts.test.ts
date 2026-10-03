import { describe, expect, it } from "vitest";

import { holdsMediaUrl } from "@/concord/lib/mediaTrust";
import { isKnownMediaHost, knownHostSet, normalizeMediaHostInput } from "@/lib/knownMediaHosts";

const known = knownHostSet(["https://media.example.org/"]);

describe("isKnownMediaHost", () => {
  it("accepts the built-in hosts and their subdomains, and the viewer's servers", () => {
    expect(isKnownMediaHost("https://i.nostr.build/a.jpg", known)).toBe(true);
    expect(isKnownMediaHost("https://nostr.build/a.jpg", known)).toBe(true);
    expect(isKnownMediaHost("https://media.example.org/" + "a".repeat(64), known)).toBe(true);
    expect(isKnownMediaHost("https://gifverse.net/media/abc/original.gif", known)).toBe(true);
    expect(isKnownMediaHost("https://i.imgur.com/a.jpg", known)).toBe(true);
    expect(isKnownMediaHost("https://cdn.discordapp.com/attachments/1/2/a.png", known)).toBe(true);
    expect(isKnownMediaHost("https://media.discordapp.net/attachments/1/2/a.png", known)).toBe(true);
  });

  it("refuses look-alikes, other hosts and non-https", () => {
    expect(isKnownMediaHost("https://evilnostr.build/a.jpg", known)).toBe(false);
    expect(isKnownMediaHost("https://nostr.build.evil.example/a.jpg", known)).toBe(false);
    expect(isKnownMediaHost("https://spam.example/a.jpg", known)).toBe(false);
    expect(isKnownMediaHost("http://nostr.build/a.jpg", known)).toBe(false);
    expect(isKnownMediaHost("not a url", known)).toBe(false);
  });
});

describe("knownHostSet", () => {
  it("adds the reader's trusted sites, however they were typed", () => {
    const set = knownHostSet([], ["Pics.example.com", "https://cdn.example.net/x.png", "nonsense"]);
    expect(isKnownMediaHost("https://i.pics.example.com/a.jpg", set)).toBe(true);
    expect(isKnownMediaHost("https://cdn.example.net/b.jpg", set)).toBe(true);
    expect(set.has("nonsense")).toBe(false);
  });
});

describe("normalizeMediaHostInput", () => {
  it("reads a bare host or a URL", () => {
    expect(normalizeMediaHostInput(" Example.COM ")).toBe("example.com");
    expect(normalizeMediaHostInput("https://i.example.com/a.png")).toBe("i.example.com");
    expect(normalizeMediaHostInput("localhost")).toBeUndefined();
    expect(normalizeMediaHostInput("")).toBeUndefined();
  });
});

describe("holdsMediaUrl", () => {
  const me = "a".repeat(64);
  const other = "b".repeat(64);
  const unknown = "https://spam.example/a.jpg";

  it("holds an unknown host whoever sent it, except the reader", () => {
    expect(holdsMediaUrl(other, unknown, { self: me, proxied: false }, known)).toBe(true);
    expect(holdsMediaUrl(me, unknown, { self: me, proxied: false }, known)).toBe(false);
    expect(holdsMediaUrl(other, "https://i.nostr.build/a.jpg", { self: me, proxied: false }, known)).toBe(false);
  });

  it("lets a media proxy satisfy it", () => {
    expect(holdsMediaUrl(other, unknown, { self: me, proxied: true }, known)).toBe(false);
  });
});
