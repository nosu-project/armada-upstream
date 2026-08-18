import { afterEach, describe, expect, it, vi } from "vitest";

import { coveredByReadState, dismissReadNotifications } from "@/lib/webPushDismiss";

describe("coveredByReadState", () => {
  const ts = 1_000; // seconds
  const tsMs = ts * 1000;

  it("maps a DM tag to its dm: read key", () => {
    expect(coveredByReadState("dm-abc", tsMs, { "dm:abc": ts })).toBe(true);
    expect(coveredByReadState("dm-abc", tsMs, { "dm:abc": ts - 1 })).toBe(false);
    expect(coveredByReadState("dm-abc", tsMs, {})).toBe(false);
  });

  it("uses a Concord tag verbatim (tag === read key)", () => {
    expect(coveredByReadState("c2:chan", tsMs, { "c2:chan": ts })).toBe(true);
    expect(coveredByReadState("c2:chan", tsMs, { "c2:other": ts })).toBe(false);
  });

  it("matches a NIP-29 h: tag against any relay's read of that group id", () => {
    expect(
      coveredByReadState("h:group1", tsMs, { "wss://relay.example::group1": ts }),
    ).toBe(true);
    // A different group id at the same relay does not cover it.
    expect(
      coveredByReadState("h:group1", tsMs, { "wss://relay.example::group2": ts }),
    ).toBe(false);
  });

  it("does not mistake an IPv6 relay host's :: for the key separator", () => {
    // `wss://[::1]::group1` — the separator is the LAST `::`.
    expect(
      coveredByReadState("h:group1", tsMs, { "wss://[::1]::group1": ts }),
    ).toBe(true);
  });

  it("read must reach the notification's newest message, not merely exist", () => {
    expect(coveredByReadState("dm-abc", tsMs, { "dm:abc": ts + 1 })).toBe(true);
    expect(coveredByReadState("dm-abc", tsMs, { "dm:abc": ts - 1 })).toBe(false);
  });

  it("never read-dismisses request pings or the quiet keep-alive", () => {
    expect(coveredByReadState("armada-dm-requests", 0, { "dm:x": 9e9 })).toBe(false);
    expect(coveredByReadState("armada-quiet-sync", 0, {})).toBe(false);
  });
});

describe("dismissReadNotifications", () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, "serviceWorker");
  });

  function installWorker(notifications: Array<{ tag: string; timestamp: number; close: () => void }>) {
    const reg = {
      getNotifications: vi.fn(async () => notifications),
    };
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { getRegistration: vi.fn(async () => reg) },
    });
    return reg;
  }

  it("closes only the notifications the read-state now covers", async () => {
    const read = { tag: "dm-alice", timestamp: 5_000, close: vi.fn() };
    const unread = { tag: "dm-bob", timestamp: 5_000, close: vi.fn() };
    const other = { tag: "c2:room", timestamp: 5_000, close: vi.fn() };
    installWorker([read, unread, other]);

    await dismissReadNotifications({ "dm:alice": 10, "dm:bob": 4 });

    expect(read.close).toHaveBeenCalledTimes(1);
    expect(unread.close).not.toHaveBeenCalled();
    expect(other.close).not.toHaveBeenCalled();
  });

  it("is a no-op when there is no service worker", async () => {
    await expect(dismissReadNotifications({ "dm:alice": 10 })).resolves.toBeUndefined();
  });
});
