import { afterEach, describe, expect, it, vi } from "vitest";

import { signalDesktopWebReady } from "@/lib/desktop";

afterEach(() => {
  delete window.armadaDesktop;
});

function bridge(overrides = {}) {
  return {
    isDesktop: true as const,
    setBadge: vi.fn(),
    getInfo: vi.fn(async () => ({ platform: "linux", version: "1.0.0" })),
    getScreenSources: vi.fn(async () => []),
    onPickScreenSource: vi.fn(),
    getMicAccessStatus: vi.fn(async () => "granted" as const),
    openMicPrivacySettings: vi.fn(async () => false),
    ...overrides,
  };
}

describe("desktop bundle boot signal", () => {
  it("tells the shell the bundle painted", () => {
    const signalWebReady = vi.fn();
    window.armadaDesktop = bridge({ signalWebReady });

    signalDesktopWebReady();

    expect(signalWebReady).toHaveBeenCalledOnce();
  });

  it("is a no-op on the web and on a shell that predates the bundle store", () => {
    // A newer web bundle has to run inside an older shell — that is the whole
    // point of shipping them separately — so an absent method is expected, not
    // an error.
    expect(() => signalDesktopWebReady()).not.toThrow();

    window.armadaDesktop = bridge();
    expect(() => signalDesktopWebReady()).not.toThrow();
  });

  it("does not let a failing bridge take down the first paint", () => {
    window.armadaDesktop = bridge({
      signalWebReady: vi.fn(() => {
        throw new Error("bridge is gone");
      }),
    });

    expect(() => signalDesktopWebReady()).not.toThrow();
  });
});
