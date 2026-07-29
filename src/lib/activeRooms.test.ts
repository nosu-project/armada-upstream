import { afterEach, describe, expect, it, vi } from "vitest";

import { isRoomActive, setActiveRooms } from "@/lib/activeRooms";

afterEach(() => {
  setActiveRooms([]);
  vi.restoreAllMocks();
});

describe("isRoomActive", () => {
  it("suppresses a notification only in a visible, focused Armada window", () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    setActiveRooms(["dm:peer"]);

    expect(isRoomActive("dm:peer")).toBe(true);
    expect(isRoomActive("dm:someone-else")).toBe(false);
  });

  it("suppresses only the focused community channel", () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    setActiveRooms(["h:wss://relay.example|general", "c2:focused-channel"]);

    expect(isRoomActive("h:wss://relay.example|general")).toBe(true);
    expect(isRoomActive("h:wss://relay.example|random")).toBe(false);
    expect(isRoomActive("c2:focused-channel")).toBe(true);
    expect(isRoomActive("c2:other-channel")).toBe(false);
  });

  it("does not treat the open room as active after the window loses focus", () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    setActiveRooms(["dm:peer"]);

    expect(isRoomActive("dm:peer")).toBe(false);
  });

  it("does not treat the open room as active in a hidden tab", () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    setActiveRooms(["dm:peer"]);

    expect(isRoomActive("dm:peer")).toBe(false);
  });
});
