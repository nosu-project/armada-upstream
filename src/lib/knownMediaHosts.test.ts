import { describe, expect, it } from "vitest";

import { holdsMediaUrl } from "@/concord/lib/mediaTrust";
import { isKnownMediaHost, knownHostSet } from "@/lib/knownMediaHosts";

const known = knownHostSet(["https://media.example.org/"]);

describe("isKnownMediaHost", () => {
  it("accepts the built-in hosts and their subdomains, and the viewer's servers", () => {
    expect(isKnownMediaHost("https://i.nostr.build/a.jpg", known)).toBe(true);
    expect(isKnownMediaHost("https://nostr.build/a.jpg", known)).toBe(true);
    expect(isKnownMediaHost("https://media.example.org/" + "a".repeat(64), known)).toBe(true);
  });

  it("refuses look-alikes, other hosts and non-https", () => {
    expect(isKnownMediaHost("https://evilnostr.build/a.jpg", known)).toBe(false);
    expect(isKnownMediaHost("https://nostr.build.evil.example/a.jpg", known)).toBe(false);
    expect(isKnownMediaHost("https://spam.example/a.jpg", known)).toBe(false);
    expect(isKnownMediaHost("http://nostr.build/a.jpg", known)).toBe(false);
    expect(isKnownMediaHost("not a url", known)).toBe(false);
  });
});

describe("holdsMediaUrl", () => {
  const me = "a".repeat(64);
  const other = "b".repeat(64);
  const unknown = "https://spam.example/a.jpg";

  it("holds an unknown host in trusted mode, whoever sent it, except the reader", () => {
    expect(holdsMediaUrl(other, unknown, { mode: "trusted", self: me }, known)).toBe(true);
    expect(holdsMediaUrl(me, unknown, { mode: "trusted", self: me }, known)).toBe(false);
    expect(holdsMediaUrl(other, "https://i.nostr.build/a.jpg", { mode: "trusted", self: me }, known)).toBe(false);
  });

  it("leaves the always and never modes to their own rule", () => {
    expect(holdsMediaUrl(other, unknown, { mode: "always", self: me }, known)).toBe(false);
    expect(holdsMediaUrl(other, unknown, { mode: "never", self: me }, known)).toBe(false);
  });
});
