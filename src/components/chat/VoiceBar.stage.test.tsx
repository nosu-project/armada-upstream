import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InCallView } from "./VoiceBar";
import { TooltipProvider } from "@/components/ui/tooltip";

import type { CallContextType } from "@/contexts/CallContext";

let stageVisible = false;

vi.mock("@/hooks/useCall", () => ({
  useCall: () => ({ stageVisible, toggleStage: vi.fn() }) as unknown as CallContextType,
}));

vi.mock("@livekit/components-react", () => ({
  useConnectionState: () => "connected",
  useParticipants: () => [{ identity: "one" }, { identity: "two" }],
  useLocalParticipant: () => ({
    // ScreenShareButton (rendered by InCallView) reads the screen-share
    // publication at render and subscribes to LocalSenderCreated in an effect
    // (installScreenShareCodecPreferences), so the participant needs
    // getTrackPublication plus on/off — even though supportsScreenShare is
    // false in jsdom and the button itself renders nothing.
    localParticipant: {
      setMicrophoneEnabled: vi.fn(),
      setCameraEnabled: vi.fn(),
      getTrackPublication: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    },
    isMicrophoneEnabled: true,
    isCameraEnabled: false,
    isScreenShareEnabled: false,
  }),
  useMediaDeviceSelect: () => ({ devices: [], activeDeviceId: "", setActiveMediaDevice: vi.fn() }),
  useRoomContext: () => ({ canPlaybackAudio: true, startAudio: vi.fn() }),
  DisconnectButton: () => null,
}));

// Pulls in an AudioWorkletNode at module load, which jsdom has no notion of.
vi.mock("@/lib/voiceProcessor", () => ({
  rnnoiseSupported: () => false,
  syncRnnoise: vi.fn(),
}));

vi.mock("@/lib/callSounds", () => ({
  playJoinSound: vi.fn(),
  playLeaveSound: vi.fn(),
  playMuteSound: vi.fn(),
  playUnmuteSound: vi.fn(),
}));

afterEach(() => {
  stageVisible = false;
  vi.clearAllMocks();
});

const renderBar = () =>
  render(
    <TooltipProvider>
      <InCallView label="#general" compact />
    </TooltipProvider>,
  );

/**
 * The call bar's show/hide control follows the user across routes, so it must
 * describe whichever stage is actually on screen — the docked box on the call's
 * channel, the floating window away from it. Reading `stageOpen` (which drives
 * only the docked box) made it report the docked state while a floating window
 * was up, and offer "Show" for a stage it could not produce.
 */
describe("InCallView show/hide control", () => {
  it("offers to show a stage while none is visible", () => {
    renderBar();
    const button = screen.getByRole("button", { name: "Show call stage" });
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.textContent).toContain("Show");
  });

  it("offers to hide a stage while one is visible", () => {
    stageVisible = true;
    renderBar();
    const button = screen.getByRole("button", { name: "Hide call stage" });
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.textContent).toContain("Hide");
  });
});
