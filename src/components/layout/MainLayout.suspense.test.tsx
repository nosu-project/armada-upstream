import { act, render, screen } from "@testing-library/react";
import { lazy, Suspense, type ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const railLifecycle = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }));

vi.mock("@/components/layout/ServerRail", async () => {
  const { useEffect } = await import("react");

  return {
    ServerRail: function MockServerRail() {
      useEffect(() => {
        railLifecycle.mounts += 1;
        return () => {
          railLifecycle.unmounts += 1;
        };
      }, []);
      return <nav aria-label="Server rail" />;
    },
  };
});

vi.mock("@/components/CallProvider", () => ({
  CallProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/DmCallProvider", () => ({
  DmCallProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/AppsProvider", () => ({
  AppsProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/concord/components/DirectInviteNotifier", () => ({
  DirectInviteNotifier: () => null,
}));
vi.mock("@/components/QuickSwitcher", () => ({ QuickSwitcher: () => null }));
vi.mock("@/concord/hooks/useStreamAuth", () => ({ useRegisterAllStreamKeys: () => undefined }));
vi.mock("@/hooks/useShareShortcuts", () => ({ useShareShortcuts: () => undefined }));

import { MainLayout } from "@/components/layout/MainLayout";

beforeEach(() => {
  railLifecycle.mounts = 0;
  railLifecycle.unmounts = 0;
});

describe("MainLayout route Suspense", () => {
  it("keeps the shell mounted while a first-visited page chunk loads", async () => {
    let finishLoading!: () => void;
    const DelayedPage = lazy(
      () =>
        new Promise<{ default: () => ReactNode }>((resolve) => {
          finishLoading = () => resolve({ default: () => <main>Delayed page</main> });
        }),
    );

    render(
      <MemoryRouter initialEntries={["/delayed"]}>
        {/* This is the app-level route fallback that used to catch the page
            suspension and replace MainLayout wholesale. */}
        <Suspense fallback={<div>Boot splash</div>}>
          <Routes>
            <Route element={<MainLayout />}>
              <Route path="/delayed" element={<DelayedPage />} />
            </Route>
          </Routes>
        </Suspense>
      </MemoryRouter>,
    );

    expect(screen.getByRole("navigation", { name: "Server rail" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Loading page" })).toBeInTheDocument();
    expect(screen.queryByText("Boot splash")).not.toBeInTheDocument();
    expect(railLifecycle).toEqual({ mounts: 1, unmounts: 0 });

    await act(async () => finishLoading());

    expect(await screen.findByText("Delayed page")).toBeInTheDocument();
    expect(railLifecycle).toEqual({ mounts: 1, unmounts: 0 });
  });

  it("preserves the blank full-screen wait for the welcome chunk", () => {
    const DelayedWelcome = lazy(() => new Promise<{ default: () => ReactNode }>(() => undefined));

    render(
      <MemoryRouter initialEntries={["/welcome"]}>
        <Suspense fallback={<div>Outer fallback</div>}>
          <Routes>
            <Route element={<MainLayout />}>
              <Route path="/welcome" element={<DelayedWelcome />} />
            </Route>
          </Routes>
        </Suspense>
      </MemoryRouter>,
    );

    expect(screen.getByRole("status", { name: "Loading" })).toHaveClass("fixed", "inset-0");
    expect(screen.queryByRole("status", { name: "Loading page" })).not.toBeInTheDocument();
    expect(screen.queryByText("Outer fallback")).not.toBeInTheDocument();
  });
});
