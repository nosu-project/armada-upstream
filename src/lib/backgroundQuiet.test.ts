// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let appState: ((isActive: boolean) => void) | undefined;
vi.mock("@/lib/appStateEvents", () => ({
  onAppStateChange: (cb: (isActive: boolean) => void) => {
    appState = cb;
    return () => undefined;
  },
}));

import {
  _resetBackgroundQuietForTests,
  holdBackgroundActivity,
  isBackgroundQuiet,
  onBackgroundQuiet,
  setNativeServiceWatching,
} from "./backgroundQuiet";

beforeEach(() => {
  vi.useFakeTimers();
  _resetBackgroundQuietForTests();
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("backgroundQuiet", () => {
  it("goes quiet after the grace only when the native service is watching, and wakes on resume", () => {
    const flips = vi.fn();
    onBackgroundQuiet(flips);
    appState!(false);
    vi.advanceTimersByTime(60_000);
    expect(isBackgroundQuiet()).toBe(false);

    setNativeServiceWatching(true);
    appState!(false);
    vi.advanceTimersByTime(5_000);
    expect(isBackgroundQuiet()).toBe(false);
    vi.advanceTimersByTime(20_000);
    expect(isBackgroundQuiet()).toBe(true);

    appState!(true);
    expect(isBackgroundQuiet()).toBe(false);
    expect(flips).toHaveBeenCalledTimes(2);
  });

  it("a quick return inside the grace never goes quiet", () => {
    setNativeServiceWatching(true);
    onBackgroundQuiet(() => undefined);
    appState!(false);
    vi.advanceTimersByTime(5_000);
    appState!(true);
    vi.advanceTimersByTime(60_000);
    expect(isBackgroundQuiet()).toBe(false);
  });

  it("stays awake during a call or while media plays", () => {
    setNativeServiceWatching(true);
    onBackgroundQuiet(() => undefined);
    const release = holdBackgroundActivity("call");
    appState!(false);
    vi.advanceTimersByTime(60_000);
    expect(isBackgroundQuiet()).toBe(false);
    release();

    const audio = document.createElement("audio");
    Object.defineProperty(audio, "paused", { value: false });
    document.body.append(audio);
    appState!(true);
    appState!(false);
    vi.advanceTimersByTime(60_000);
    expect(isBackgroundQuiet()).toBe(false);
  });

  it("wakes when the service stops watching or a call starts", () => {
    setNativeServiceWatching(true);
    onBackgroundQuiet(() => undefined);
    appState!(false);
    vi.advanceTimersByTime(60_000);
    expect(isBackgroundQuiet()).toBe(true);
    holdBackgroundActivity("call");
    expect(isBackgroundQuiet()).toBe(false);
  });
});
