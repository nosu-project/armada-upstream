import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ScreenSharePicker } from "./ScreenSharePicker";

afterEach(() => {
  delete window.armadaDesktop;
});

describe("ScreenSharePicker", () => {
  it("surfaces a desktop capture failure instead of silently cancelling", async () => {
    let pickSource: (() => Promise<string | null>) | undefined;
    window.armadaDesktop = {
      isDesktop: true,
      setBadge: vi.fn(),
      getInfo: vi.fn(async () => ({ platform: "linux", version: "1.0.0" })),
      getScreenSources: vi.fn(async () => {
        throw new Error("portal unavailable");
      }),
      onPickScreenSource: vi.fn((handler) => {
        pickSource = handler;
      }),
      getLinuxShareAudioSources: vi.fn(async () => ({
        supported: false,
        reason: null,
        sources: [],
      })),
      getMicAccessStatus: vi.fn(async () => "granted" as const),
      openMicPrivacySettings: vi.fn(async () => false),
    };

    render(<ScreenSharePicker />);
    expect(pickSource).toBeDefined();

    let result: Promise<string | null> | undefined;
    await act(async () => {
      result = pickSource?.();
      await Promise.resolve();
    });

    expect(
      await screen.findByText(/couldn't open the system screen picker/i),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    await expect(result).resolves.toBeNull();
  });

  it("does not tear down current audio when a replacement picker is cancelled", async () => {
    let pickSource: (() => Promise<string | null>) | undefined;
    const stopLinuxShareAudio = vi.fn(async () => {});
    window.armadaDesktop = {
      isDesktop: true,
      setBadge: vi.fn(),
      getInfo: vi.fn(async () => ({ platform: "linux", version: "1.0.0" })),
      getScreenSources: vi.fn(async () => [{
        id: "screen:1",
        name: "Screen 1",
        thumbnail: "",
        appIcon: "",
        isScreen: true,
      }]),
      onPickScreenSource: vi.fn((handler) => {
        pickSource = handler;
      }),
      getLinuxShareAudioSources: vi.fn(async () => ({
        supported: true,
        reason: null,
        sources: [],
      })),
      startLinuxShareAudio: vi.fn(async () => true),
      unmuteLinuxShareAudio: vi.fn(async () => true),
      stopLinuxShareAudio,
      getMicAccessStatus: vi.fn(async () => "granted" as const),
      openMicPrivacySettings: vi.fn(async () => false),
    };

    render(<ScreenSharePicker />);
    let result: Promise<string | null> | undefined;
    await act(async () => {
      result = pickSource?.();
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    await expect(result).resolves.toBeNull();
    expect(stopLinuxShareAudio).not.toHaveBeenCalled();
  });
});
