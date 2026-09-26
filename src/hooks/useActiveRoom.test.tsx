import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useActiveRoom } from "@/hooks/useActiveRoom";
import { isRoomActive } from "@/lib/activeRooms";
import { SettingsOverlayContext, type SettingsOverlay } from "@/lib/settingsOverlay";

vi.mock("@/lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform")>()),
  hasNativeNotificationService: () => false,
}));

const overlay = (open: boolean): SettingsOverlay => ({ open, section: "", show: () => {}, close: () => {} });

afterEach(() => vi.restoreAllMocks());

describe("useActiveRoom", () => {
  it("reports the room while it is on screen, and not while Settings covers it", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    let open = false;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <SettingsOverlayContext.Provider value={overlay(open)}>{children}</SettingsOverlayContext.Provider>
    );
    const { rerender, unmount } = renderHook(() => useActiveRoom("c2:abc"), { wrapper });
    expect(isRoomActive("c2:abc")).toBe(true);

    open = true;
    rerender();
    expect(isRoomActive("c2:abc")).toBe(false);

    open = false;
    rerender();
    expect(isRoomActive("c2:abc")).toBe(true);
    unmount();
  });
});
