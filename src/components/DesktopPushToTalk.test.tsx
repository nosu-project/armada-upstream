import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  requestPushToTalkOverride,
  setPushToTalkPreferences,
} from "@/lib/pushToTalk";

import { DesktopPushToTalk } from "./DesktopPushToTalk";

const setMicrophoneEnabled = vi.fn();

vi.mock("@livekit/components-react", () => ({
  useLocalParticipant: () => ({ localParticipant: { setMicrophoneEnabled } }),
}));

/**
 * Stand-in for the LiveKit track. `enabled` only moves when the call actually
 * succeeds, so a test that asserts on it is asserting the state of the
 * microphone rather than the component's belief about it — which is the entire
 * distinction the retry logic exists to maintain.
 */
function microphone({ failMute = 0, failUnmute = 0 } = {}) {
  const state = { enabled: false, mutesRejected: 0, unmutesRejected: 0 };
  setMicrophoneEnabled.mockImplementation(async (next: boolean) => {
    // Only reject a mute that would actually close a live track. start() issues
    // a fail-closed mute before any key event, and letting that one absorb the
    // failure would make this test pass without ever exercising a key-up.
    if (!next && state.enabled && state.mutesRejected < failMute) {
      state.mutesRejected += 1;
      throw new Error("republish in flight");
    }
    if (next && state.unmutesRejected < failUnmute) {
      state.unmutesRejected += 1;
      throw new Error("device busy");
    }
    state.enabled = next;
  });
  return state;
}

let emitPressed: ((pressed: boolean) => void) | undefined;
const setPushToTalkActive = vi.fn(async () => true);

beforeEach(() => {
  vi.clearAllMocks();
  emitPressed = undefined;
  window.armadaDesktop = {
    isDesktop: true,
    setBadge: vi.fn(),
    getInfo: vi.fn(async () => ({ platform: "linux", version: "1.0.0" })),
    getScreenSources: vi.fn(async () => []),
    onPickScreenSource: vi.fn(),
    getMicAccessStatus: vi.fn(async () => "granted" as const),
    openMicPrivacySettings: vi.fn(async () => false),
    configurePushToTalk: vi.fn(async () => ({
      supported: true,
      backend: "native" as const,
      bindingLabel: "Caps Lock",
      reason: null,
    })),
    setPushToTalkActive,
    onPushToTalkState: vi.fn((listener: (pressed: boolean) => void) => {
      emitPressed = listener;
      return () => {
        emitPressed = undefined;
      };
    }),
  };
  setPushToTalkPreferences({
    enabled: true,
    binding: {
      code: "CapsLock",
      label: "Caps Lock",
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
    },
  });
});

afterEach(() => {
  delete window.armadaDesktop;
  window.localStorage.clear();
});

async function mount() {
  const view = render(<DesktopPushToTalk />);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return view;
}

async function press(pressed: boolean) {
  await act(async () => {
    emitPressed?.(pressed);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("DesktopPushToTalk", () => {
  it("retries the mute when LiveKit rejects the key-up", async () => {
    const mic = microphone({ failMute: 1 });
    await mount();

    await press(true);
    expect(mic.enabled).toBe(true);

    await press(false);

    // A rejected mute is not an applied mute. Recording it as one leaves the
    // track live while the UI reports the shortcut released.
    expect(mic.mutesRejected).toBe(1);
    expect(mic.enabled).toBe(false);
  });

  it("stops rather than spinning when the unmute keeps failing", async () => {
    const mic = microphone({ failUnmute: 99 });
    await mount();

    await press(true);

    expect(mic.enabled).toBe(false);
    // The held key must not turn a failing unmute into a retry loop.
    expect(setMicrophoneEnabled.mock.calls.filter(([next]) => next === true).length)
      .toBeLessThan(5);
  });

  it("force-mutes and stands down when the call UI overrides it", async () => {
    const mic = microphone();
    await mount();

    await press(true);
    expect(mic.enabled).toBe(true);

    await act(async () => {
      requestPushToTalkOverride();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mic.enabled).toBe(false);
    expect(setPushToTalkActive).toHaveBeenLastCalledWith(false);

    // A shortcut that is still physically held must not re-open the mic.
    await press(true);
    expect(mic.enabled).toBe(false);
  });
});
