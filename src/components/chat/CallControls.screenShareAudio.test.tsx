import { render, screen } from "@testing-library/react";
import { act } from "react";
import type { ReactElement } from "react";
import { Track } from "livekit-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SCREEN_SHARE_QUALITY_KEY,
  getScreenShareQuality,
  type ScreenShareQuality,
} from "@/lib/screenShareQuality";

import { ScreenShareButton } from "./CallControls";

// `supportsScreenShare` in CallControls is evaluated at import time from
// `navigator.mediaDevices.getDisplayMedia`; jsdom has neither, so the button
// would render null. Define it (hoisted, before the import) — it is never
// called, the LiveKit boundary below is mocked.
vi.hoisted(() => {
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    value: { getDisplayMedia: () => Promise.resolve(undefined) },
  });
});

// Reproduces the reported field bug: after ONE screen-share whose audio source
// could not be opened (Chromium's `NotReadableError: "Could not start audio
// source"` — a single window with no loopback endpoint), the sharer taps the
// "Share without audio" recovery to keep sharing. From then on EVERY later
// share — a different window, or the entire screen — is silently audio-less,
// and it survives an app restart. On Windows that means no loopback grant
// (displayMediaPolicy.js only attaches `audio: "loopback"` when the request
// carries audio), so no stream sound reaches anyone.
//
// The mechanism: the recovery re-runs the share with `captureAudio: false`,
// applyQuality persists that on success (rememberScreenShareQuality), and the
// persisted flag is global — it is not scoped to the surface that failed. This
// test drives the REAL applyQuality closure and the REAL screenShareQuality
// persistence (localStorage), mocking only the LiveKit boundary and the picker
// dialog, so it asserts what the capture is actually asked for.

// Capture the dialog's onConfirm (= the component's applyQuality) so the test
// can start a share without rendering the heavyweight quality dialog.
const dialog = vi.hoisted(() => ({
  onConfirm: null as null | ((quality: ScreenShareQuality) => void),
}));
vi.mock("@/components/chat/ScreenShareQualityDialog", () => ({
  ScreenShareQualityDialog: (props: {
    onConfirm: (quality: ScreenShareQuality) => void;
  }) => {
    dialog.onConfirm = props.onConfirm;
    return null;
  },
}));
vi.mock("@/components/chat/ScreenShareDiagnosticsDialog", () => ({
  ScreenShareDiagnosticsDialog: () => null,
}));

// Record every capture request and script the outcomes: only the first share
// (the one that asks for audio) fails, exactly as a window with no openable
// loopback endpoint does.
const captures: Array<{ enabled: boolean; audio: unknown }> = [];
let firstShareFails = true;
const setScreenShareEnabled = vi.fn(
  async (enabled: boolean, options?: { audio?: unknown }) => {
    captures.push({ enabled, audio: options?.audio });
    if (enabled && firstShareFails) {
      firstShareFails = false;
      const error = new Error("Could not start audio source");
      error.name = "NotReadableError";
      throw error;
    }
  },
);
// Controllable active-share state for the indicator tests.
let screenShareEnabled = false;
let screenShareAudioPublished = false;
const localParticipant = {
  setScreenShareEnabled,
  getTrackPublication: (source: unknown) =>
    source === Track.Source.ScreenShareAudio && screenShareAudioPublished
      ? { trackSid: "audio" }
      : undefined,
  on: () => localParticipant,
  off: () => localParticipant,
};

vi.mock("@livekit/components-react", () => ({
  DisconnectButton: () => null,
  useLocalParticipant: () => ({
    localParticipant,
    isScreenShareEnabled: screenShareEnabled,
  }),
  useRoomContext: () => ({}),
}));
vi.mock("@/contexts/CallSignalsContext", () => ({
  useCallSignals: () => ({ enabled: false, hevcScreenShare: undefined }),
}));
vi.mock("@/hooks/useCall", () => ({ useCall: () => ({}) }));
vi.mock("@/lib/desktop", () => ({
  desktopScreenCaptureAccessStatus: async () => "granted",
  openDesktopScreenCaptureSettings: async () => {},
}));

const toast = vi.fn();
vi.mock("@/hooks/useToast", () => ({ toast: (args: unknown) => toast(args) }));

// Flush applyQuality's async chain (it is fire-and-forget: an async IIFE with
// .then/.catch/.finally), wrapping the resulting state updates in act.
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function startShare(): Promise<void> {
  const confirm = dialog.onConfirm!;
  await act(async () => {
    confirm(getScreenShareQuality());
  });
  await flush();
}

beforeEach(() => {
  localStorage.clear();
  captures.length = 0;
  firstShareFails = true;
  screenShareEnabled = false;
  screenShareAudioPublished = false;
  toast.mockClear();
  setScreenShareEnabled.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("screen share audio after an audio-source failure", () => {
  it("still requests audio for a later share once a failed one was recovered", async () => {
    render(<ScreenShareButton />);

    // 1. First share of a surface with no openable loopback endpoint. Default
    //    quality captures audio, so the request asks for it — and fails.
    await startShare();
    expect(captures[0]?.audio).toBe(true);

    // 2. The recovery toast offers "Share without audio". Tap it.
    const recovery = toast.mock.calls
      .map(([args]) => args as { title?: string; action?: ReactElement })
      .find((args) => args.title === "Couldn't share screen audio");
    expect(recovery, "expected the audio-source-failure recovery toast").toBeTruthy();
    const onClick = (recovery!.action!.props as { onClick: () => void }).onClick;
    await act(async () => {
      onClick();
    });
    await flush();
    // The recovery share succeeds without audio (video only).
    expect(captures[1]?.audio).toBe(false);

    // 3. Later, the user shares again — a different window, or the whole screen.
    //    This is a fresh, unrelated capture, and every real surface here (the
    //    entire screen especially) has audio to capture. It must still ask for
    //    it. Today the recovery's audio-off leaked into persisted state, so it
    //    does not: the share is silently muted, exactly as reported.
    await startShare();
    expect(captures[2]?.audio).toBe(true);
    // And the persisted preference must not have been clobbered by the
    // one-shot recovery: whatever is stored keeps audio on.
    expect(getScreenShareQuality().captureAudio).toBe(true);
    const stored = localStorage.getItem(SCREEN_SHARE_QUALITY_KEY);
    if (stored) expect(JSON.parse(stored).captureAudio).toBe(true);
  });
});

describe("silent screen share indicator", () => {
  it("marks the share button when the active share publishes no audio track", () => {
    screenShareEnabled = true;
    screenShareAudioPublished = false;
    render(<ScreenShareButton />);

    // The invisibility was the whole bug — a muted share looked identical to a
    // sharing one. The options button now says so, in the accessible name.
    expect(
      screen.getByRole("button", {
        name: "Screen share options — audio is not being captured",
      }),
    ).toBeInTheDocument();
  });

  it("shows no warning when the active share has an audio track", () => {
    screenShareEnabled = true;
    screenShareAudioPublished = true;
    render(<ScreenShareButton />);

    expect(
      screen.getByRole("button", { name: "Screen share options" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: "Screen share options — audio is not being captured",
      }),
    ).not.toBeInTheDocument();
  });
});
