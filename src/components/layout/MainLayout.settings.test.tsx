import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { SettingsOverlayContext, type SettingsOverlay } from "@/lib/settingsOverlay";

// The back listener is installed once per module, so this is never cleared.
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
vi.mock("@/components/layout/ServerRail", () => ({ ServerRail: () => <nav aria-label="Server rail" /> }));
vi.mock("@/components/CallProvider", () => ({
  CallProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/DmCallProvider", () => ({
  DmCallProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/AppsProvider", () => ({
  AppsProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/concord/components/DirectInviteNotifier", () => ({ DirectInviteNotifier: () => null }));
vi.mock("@/components/QuickSwitcher", () => ({ QuickSwitcher: () => null }));
vi.mock("@/concord/hooks/useStreamAuth", () => ({ useRegisterAllStreamKeys: () => undefined }));
vi.mock("@/hooks/useShareShortcuts", () => ({ useShareShortcuts: () => undefined }));
vi.mock("@/pages/SettingsPage", () => ({
  SettingsPage: ({ onClose }: { onClose?: () => void }) => (
    <main>
      <button type="button" onClick={onClose}>
        Back
      </button>
    </main>
  ),
}));

import { MainLayout } from "@/components/layout/MainLayout";
import { leaveApp, useAndroidBack } from "@/hooks/useAndroidBack";

let setOpen!: (open: boolean) => void;

/** A root screen that leaves the app on back, as a revealed SwipeReveal list does. */
function RootScreen() {
  useAndroidBack(() => {
    leaveApp();
    return true;
  });
  return <textarea aria-label="composer" />;
}

function Harness() {
  const [open, setOpenState] = useState(false);
  setOpen = setOpenState;
  const overlay: SettingsOverlay = {
    open,
    section: "",
    show: () => setOpenState(true),
    close: () => setOpenState(false),
  };
  return (
    <SettingsOverlayContext.Provider value={overlay}>
      <MemoryRouter initialEntries={["/chat"]}>
        <Routes>
          <Route element={<MainLayout />}>
            <Route path="/chat" element={<RootScreen />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </SettingsOverlayContext.Provider>
  );
}

describe("MainLayout settings overlay", () => {
  it("makes the page underneath inert, takes focus, and gives it back on close", async () => {
    render(<Harness />);
    const composer = screen.getByRole("textbox", { name: "composer" });
    composer.focus();

    await act(async () => setOpen(true));
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    expect(composer.closest("[inert]")).not.toBeNull();
    expect(dialog.contains(document.activeElement)).toBe(true);

    await act(async () => setOpen(false));
    expect(composer.closest("[inert]")).toBeNull();
    expect(document.activeElement).toBe(composer);
  });

  it("closes on Escape", async () => {
    render(<Harness />);
    await act(async () => setOpen(true));
    await screen.findByRole("dialog", { name: "Settings" });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument();
  });

  it("closes on Android back instead of leaving the app from the page beneath", async () => {
    minimizeApp.mockClear();
    render(<Harness />);
    await act(async () => setOpen(true));
    await screen.findByRole("dialog", { name: "Settings" });

    act(() => {
      for (const fn of backListeners) fn();
    });
    expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument();
    expect(minimizeApp).not.toHaveBeenCalled();

    act(() => {
      for (const fn of backListeners) fn();
    });
    expect(minimizeApp).toHaveBeenCalledTimes(1);
  });

  it("leaves Escape to a dialog stacked on it, and to a handler that took it", async () => {
    render(<Harness />);
    await act(async () => setOpen(true));
    await screen.findByRole("dialog", { name: "Settings" });

    const nested = document.createElement("div");
    nested.setAttribute("role", "alertdialog");
    document.body.append(nested);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
    nested.remove();

    const taken = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    taken.preventDefault();
    act(() => {
      window.dispatchEvent(taken);
    });
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
  });
});
