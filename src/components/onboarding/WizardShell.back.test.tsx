/**
 * Android back over a full-screen wizard steps it back or closes it, and never
 * reaches the screen beneath — which, from a revealed list, leaves the app.
 */
import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const backListeners: Array<() => void> = [];

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
    minimizeApp: () => Promise.resolve(),
  },
}));
vi.mock("@/components/landing/AsciiSea", () => ({ AsciiSea: () => null }));
vi.mock("@/components/brand/ArmadaCrest", () => ({ ArmadaCrestKeyframes: () => null }));

import { ChatSearchBar } from "@/components/chat/ChatSearchBar";
import { WizardShell } from "@/components/onboarding/WizardShell";
import { PaneCoveredContext } from "@/contexts/PaneCoveredContext";
import { useAndroidBack } from "@/hooks/useAndroidBack";

function pressBack() {
  act(() => {
    for (const fn of backListeners) fn();
  });
}

const screenBack = vi.fn();

/** Stands in for the page's own back handler (SwipeReveal). */
function Screen({ children }: { children: React.ReactNode }) {
  useAndroidBack(() => {
    screenBack();
    return true;
  });
  return <>{children}</>;
}

beforeEach(() => screenBack.mockClear());

describe("WizardShell Android back", () => {
  it("steps back when the step has a back", () => {
    const onBack = vi.fn();
    const onClose = vi.fn();
    render(
      <Screen>
        <WizardShell index={1} total={3} stepKey="b" onBack={onBack} onClose={onClose}>step</WizardShell>
      </Screen>,
    );
    pressBack();
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(screenBack).not.toHaveBeenCalled();
  });

  it("closes on the first step", () => {
    const onClose = vi.fn();
    render(
      <Screen>
        <WizardShell index={0} total={3} stepKey="a" onClose={onClose}>step</WizardShell>
      </Screen>,
    );
    pressBack();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screenBack).not.toHaveBeenCalled();
  });

  it("holds a step with neither back nor close", () => {
    render(
      <Screen>
        <WizardShell index={2} total={3} stepKey="busy">step</WizardShell>
      </Screen>,
    );
    pressBack();
    expect(screenBack).not.toHaveBeenCalled();
  });
});

describe("ChatSearchBar Android back", () => {
  function Bar({ open, covered, onClose }: { open: boolean; covered: boolean; onClose: () => void }) {
    return (
      <Screen>
        <PaneCoveredContext.Provider value={covered}>
          <ChatSearchBar open={open} value="" onChange={() => {}} onClose={onClose} placeholder="Search" />
        </PaneCoveredContext.Provider>
      </Screen>
    );
  }

  it("closes the open search before the screen", () => {
    const onClose = vi.fn();
    render(<Bar open covered={false} onClose={onClose} />);
    pressBack();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screenBack).not.toHaveBeenCalled();
  });

  it("leaves back to the list while the pane is swiped aside", () => {
    const onClose = vi.fn();
    render(<Bar open covered onClose={onClose} />);
    pressBack();
    expect(onClose).not.toHaveBeenCalled();
    expect(screenBack).toHaveBeenCalledTimes(1);
  });
});
