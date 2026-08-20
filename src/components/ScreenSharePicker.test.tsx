import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ScreenSharePicker } from "./ScreenSharePicker";

afterEach(() => {
  delete window.armadaDesktop;
  Reflect.deleteProperty(document, "fullscreenElement");
});

describe("ScreenSharePicker", () => {
  it("keeps the Electron picker inside the active fullscreen element", async () => {
    const fullscreenHost = document.createElement("div");
    document.body.append(fullscreenHost);
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      value: fullscreenHost,
    });

    let pickSource: (() => Promise<string | null>) | undefined;
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
        supported: false,
        reason: null,
        sources: [],
      })),
      getMicAccessStatus: vi.fn(async () => "granted" as const),
      openMicPrivacySettings: vi.fn(async () => false),
    };

    render(<ScreenSharePicker />);
    let result: Promise<string | null> | undefined;
    await act(async () => {
      result = pickSource?.();
      await Promise.resolve();
    });

    const dialog = await screen.findByRole("dialog");
    expect(fullscreenHost).toContainElement(dialog);

    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      value: null,
    });
    fireEvent(document, new Event("fullscreenchange"));
    expect(fullscreenHost).not.toContainElement(screen.getByRole("dialog"));

    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    await expect(result).resolves.toBeNull();
    fullscreenHost.remove();
  });

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

  it("guides a denied macOS user to Screen Recording settings", async () => {
    let pickSource: (() => Promise<string | null>) | undefined;
    const openScreenCapturePrivacySettings = vi.fn(async () => true);
    window.armadaDesktop = {
      isDesktop: true,
      setBadge: vi.fn(),
      getInfo: vi.fn(async () => ({ platform: "darwin", version: "1.0.0" })),
      getScreenSources: vi.fn(async () => {
        throw new Error("screen capture denied");
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
      getScreenCaptureAccessStatus: vi.fn(async () => "denied" as const),
      openScreenCapturePrivacySettings,
    };

    render(<ScreenSharePicker />);
    await act(async () => {
      void pickSource?.();
      await Promise.resolve();
    });

    expect(await screen.findByText(/needs Screen Recording permission/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /open Screen Recording settings/i }));
    expect(openScreenCapturePrivacySettings).toHaveBeenCalledOnce();
  });
});
