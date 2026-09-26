import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { SettingsOverlayContext, type SettingsOverlay } from "@/lib/settingsOverlay";

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

let setOpen!: (open: boolean) => void;

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
            <Route path="/chat" element={<textarea aria-label="composer" />} />
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
