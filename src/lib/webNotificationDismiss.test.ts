import { describe, expect, it, vi } from "vitest";

import { closeReadNotifications, readKeyForRoom } from "./webNotificationDismiss";

function shown(data: unknown) {
  return { data, close: vi.fn() };
}

describe("readKeyForRoom", () => {
  it("maps notification rooms to read-state keys", () => {
    expect(readKeyForRoom("dm:abc")).toBe("dm:abc");
    expect(readKeyForRoom("c2:def")).toBe("c2:def");
    expect(readKeyForRoom("h:wss://relay.example|group")).toBe("wss://relay.example::group");
    expect(readKeyForRoom("h:nogroup")).toBeUndefined();
    expect(readKeyForRoom(undefined)).toBeUndefined();
  });
});

describe("closeReadNotifications", () => {
  it("closes a room read up to its newest message", () => {
    const n = shown({ roomKey: "c2:room", newestMs: 1_000_000 });
    closeReadNotifications([n], { "c2:room": 1000 });
    expect(n.close).toHaveBeenCalledOnce();
  });

  it("keeps a room with a newer unread message", () => {
    const n = shown({ roomKey: "dm:peer", newestMs: 1_001_000 });
    closeReadNotifications([n], { "dm:peer": 1000 });
    expect(n.close).not.toHaveBeenCalled();
  });

  it("keeps unattributable and unread rooms", () => {
    const unattributed = shown({ newestMs: 1 });
    const unread = shown({ roomKey: "h:wss://r|g", newestMs: 1 });
    const legacy = shown({ url: "/" });
    closeReadNotifications([unattributed, unread, legacy], { "c2:other": 1000 });
    expect(unattributed.close).not.toHaveBeenCalled();
    expect(unread.close).not.toHaveBeenCalled();
    expect(legacy.close).not.toHaveBeenCalled();
  });
});
