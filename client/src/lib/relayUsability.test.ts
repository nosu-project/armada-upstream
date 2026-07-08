import { describe, expect, it } from "vitest";

import { preferPortableRelays, relayUsableHere, unusableRelaysHere, unusableRelaysReason } from "./relayUsability";

describe("relayUsableHere", () => {
  it("always accepts wss:// regardless of origin", () => {
    expect(relayUsableHere("wss://relay.example.com", "https:")).toBe(true);
    expect(relayUsableHere("wss://relay.example.com", "http:")).toBe(true);
  });

  it("rejects non-websocket schemes", () => {
    expect(relayUsableHere("https://relay.example.com", "http:")).toBe(false);
    expect(relayUsableHere("relay.example.com", "http:")).toBe(false);
  });

  it("accepts ws:// from an insecure page (localhost/LAN quickstart)", () => {
    expect(relayUsableHere("ws://192.168.1.5:5577", "http:")).toBe(true);
    expect(relayUsableHere("ws://localhost:5577", "http:")).toBe(true);
  });

  it("blocks non-loopback ws:// on a secure origin (the APK WebView case, #47)", () => {
    expect(relayUsableHere("ws://192.168.1.5:5577", "https:")).toBe(false);
    expect(relayUsableHere("ws://relay.example.com", "https:")).toBe(false);
  });

  it("exempts loopback ws:// on secure origins (mixed-content trustworthy hosts)", () => {
    expect(relayUsableHere("ws://localhost:5577", "https:")).toBe(true);
    expect(relayUsableHere("ws://127.0.0.1:5577", "https:")).toBe(true);
  });
});

describe("unusableRelaysReason", () => {
  it("is null when at least one relay is usable", () => {
    expect(unusableRelaysReason(["ws://192.168.1.5:5577", "wss://relay.example.com"], "https:")).toBeNull();
  });

  it("explains an all-ws:// community on a secure platform", () => {
    const reason = unusableRelaysReason(["ws://192.168.1.5:5577"], "https:");
    expect(reason).toMatch(/ws:\/\/192\.168\.1\.5:5577/);
    expect(reason).toMatch(/wss:\/\//);
  });

  it("flags an empty relay list", () => {
    expect(unusableRelaysReason([], "https:")).toMatch(/no relays/);
  });
});

describe("unusableRelaysHere", () => {
  it("returns only the relays this platform can't reach", () => {
    expect(
      unusableRelaysHere(["wss://ok.example.com", "ws://192.168.1.5:5577"], "https:"),
    ).toEqual(["ws://192.168.1.5:5577"]);
  });
});

describe("preferPortableRelays", () => {
  it("drops ws:// relays when a wss:// alternative exists", () => {
    expect(preferPortableRelays(["ws://localhost:5577", "wss://relay.ditto.pub"])).toEqual([
      "wss://relay.ditto.pub",
    ]);
  });

  it("keeps an all-ws:// list intact (deliberate all-local deployment)", () => {
    expect(preferPortableRelays(["ws://localhost:5577"])).toEqual(["ws://localhost:5577"]);
  });
});
