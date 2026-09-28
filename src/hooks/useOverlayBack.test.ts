// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { useOverlayBack } from "./useAndroidBack";

const guardOf = () =>
  (window.history.state as Record<string, unknown> | null)?.armadaBackGuard;

/** Let the deferred settle run. */
const tick = () => act(() => new Promise((r) => setTimeout(r, 10)));

/** Press back and wait for the traversal (and any skip it triggers) to land. */
async function back() {
  await act(async () => {
    window.history.back();
    await new Promise((r) => setTimeout(r, 50));
  });
}

function mountOverlay(onBack: () => boolean = () => true) {
  const handler = vi.fn(onBack);
  const hook = renderHook(({ open }) => useOverlayBack(handler, open), {
    initialProps: { open: true },
  });
  return { handler, ...hook };
}

describe("useOverlayBack (browser)", () => {
  it("holds a history entry while open, and back closes the overlay instead of leaving", async () => {
    window.history.replaceState({ idx: 3 }, "", "/chat");
    const closed = vi.fn();
    const { result, unmount } = renderHook(() => {
      const [open, setOpen] = useState(true);
      useOverlayBack(() => {
        closed();
        setOpen(false);
        return true;
      }, open);
      return open;
    });
    await tick();
    expect(guardOf()).toEqual(expect.any(String));
    // The router's state rides along, so the entry reads as the same page.
    expect((window.history.state as { idx: number }).idx).toBe(3);

    await back();
    await tick();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(result.current).toBe(false);
    expect(window.location.pathname).toBe("/chat");
    expect(guardOf()).toBeUndefined();
    unmount();
  });

  it("re-arms the guard when the handler unwinds a layer without closing", async () => {
    window.history.replaceState(null, "", "/chat");
    const { handler, unmount } = mountOverlay();
    await tick();

    await back();
    await tick();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(guardOf()).toEqual(expect.any(String));

    unmount();
    await back();
    expect(guardOf()).toBeUndefined();
  });

  it("pops its own entry when closed some other way", async () => {
    window.history.replaceState(null, "", "/chat");
    const { handler, rerender } = mountOverlay();
    await tick();

    rerender({ open: false });
    await waitFor(() => expect(guardOf()).toBeUndefined());
    await tick();
    expect(handler).not.toHaveBeenCalled();
    expect(guardOf()).toBeUndefined();
    expect(window.location.pathname).toBe("/chat");
  });

  it("leaves a navigation made on close in place, and skips the buried entry on back", async () => {
    window.history.replaceState(null, "", "/chat");
    const { handler, rerender } = mountOverlay();
    await tick();

    // An action that closes the sheet and navigates in the same click.
    act(() => {
      rerender({ open: false });
      window.history.pushState(null, "", "/profile");
    });
    await tick();
    expect(window.location.pathname).toBe("/profile");

    await back();
    expect(handler).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/chat");
    expect(guardOf()).toBeUndefined();
  });
});
