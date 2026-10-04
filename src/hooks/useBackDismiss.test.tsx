/**
 * Android back over an open overlay primitive closes the overlay, not the
 * screen beneath it — exercised through the real Popover and Dialog roots.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const backListeners: Array<() => void> = [];
const minimizeApp = vi.fn(() => Promise.resolve());

vi.mock("@capacitor/core", async (orig) => {
  const actual = await orig<typeof import("@capacitor/core")>();
  return {
    ...actual,
    Capacitor: { ...actual.Capacitor, isNativePlatform: () => true, getPlatform: () => "android" },
  };
});
vi.mock("@capacitor/app", () => ({
  App: {
    addListener: (event: string, fn: () => void) => {
      if (event === "backButton") backListeners.push(fn);
      return Promise.resolve({ remove: () => undefined });
    },
    minimizeApp: () => minimizeApp(),
  },
}));

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useAndroidBack } from "@/hooks/useAndroidBack";

function pressBack() {
  act(() => {
    for (const fn of backListeners) fn();
  });
}

/** Stands in for the chat screen's own back handler (SwipeReveal, ThreadPanel). */
function Screen({ onScreenBack, children }: { onScreenBack: () => void; children: React.ReactNode }) {
  useAndroidBack(() => {
    onScreenBack();
    return true;
  });
  return <>{children}</>;
}

describe("useBackDismiss", () => {
  beforeEach(() => minimizeApp.mockClear());

  it("closes an uncontrolled popover and leaves the screen alone", () => {
    const screenBack = vi.fn();
    render(
      <Screen onScreenBack={screenBack}>
        <Popover>
          <PopoverTrigger>profile</PopoverTrigger>
          <PopoverContent>card</PopoverContent>
        </Popover>
      </Screen>,
    );
    fireEvent.click(screen.getByText("profile"));
    expect(screen.getByText("card")).toBeInTheDocument();

    pressBack();
    expect(screen.queryByText("card")).not.toBeInTheDocument();
    expect(screenBack).not.toHaveBeenCalled();

    pressBack();
    expect(screenBack).toHaveBeenCalledTimes(1);
  });

  it("reports the close to a controlled dialog's owner", () => {
    const screenBack = vi.fn();
    function Controlled() {
      const [open, setOpen] = useState(true);
      return (
        <Screen onScreenBack={screenBack}>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent>
              <DialogTitle>dialog</DialogTitle>
            </DialogContent>
          </Dialog>
        </Screen>
      );
    }
    render(<Controlled />);
    expect(screen.getByText("dialog")).toBeInTheDocument();

    pressBack();
    expect(screen.queryByText("dialog")).not.toBeInTheDocument();
    expect(screenBack).not.toHaveBeenCalled();
  });
});
