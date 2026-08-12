import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setPushToTalkRuntime } from "@/lib/pushToTalk";

import { MicButton } from "./CallControls";

const setMicrophoneEnabled = vi.fn(async () => {});
let micEnabled = true;

const startAudio = vi.fn(async () => {});
let canPlaybackAudio = true;
vi.mock("@livekit/components-react", () => ({
  DisconnectButton: () => null,
  useLocalParticipant: () => ({
    localParticipant: { setMicrophoneEnabled },
    isMicrophoneEnabled: micEnabled,
  }),
  useRoomContext: () => ({
    get canPlaybackAudio() {
      return canPlaybackAudio;
    },
    startAudio,
  }),
}));

vi.mock("@/lib/callSounds", () => ({
  playLeaveSound: vi.fn(),
  playMuteSound: vi.fn(),
  playUnmuteSound: vi.fn(),
}));

const overridden = vi.fn();
vi.mock("@/hooks/useCall", () => ({ useCall: () => ({}) }));
vi.mock("@/contexts/CallSignalsContext", () => ({ useCallSignals: () => ({}) }));

afterEach(() => {
  setPushToTalkRuntime({ ready: false, pressed: false, bindingLabel: null });
  micEnabled = true;
  canPlaybackAudio = true;
  vi.clearAllMocks();
});

describe("MicButton with push to talk active", () => {
  it("stays operable so a stuck-open microphone can be closed", async () => {
    const { onPushToTalkOverride } = await import("@/lib/pushToTalk");
    const unsubscribe = onPushToTalkOverride(overridden);
    setPushToTalkRuntime({ ready: true, pressed: true, bindingLabel: "Caps Lock" });

    render(<MicButton />);
    const button = screen.getByRole("button");

    // A disabled button leaves no way back from a key-up that never arrived,
    // and drops the live "Talking" label out of the accessibility tree.
    expect(button).not.toBeDisabled();

    fireEvent.click(button);
    expect(overridden).toHaveBeenCalledTimes(1);
    expect(setMicrophoneEnabled).toHaveBeenCalledWith(false);

    unsubscribe();
  });

  it("leaves the ordinary mute path alone when push to talk is off", () => {
    render(<MicButton />);
    fireEvent.click(screen.getByRole("button"));

    expect(overridden).not.toHaveBeenCalled();
    expect(setMicrophoneEnabled).toHaveBeenCalledWith(false);
  });
});
