import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InCallView } from "./VoiceBar";
import { TooltipProvider } from "@/components/ui/tooltip";

import type { CallContextType } from "@/contexts/CallContext";

const platform = vi.hoisted(() => ({ name: "web" }));
const deviceSelect = vi.hoisted(() => vi.fn());

vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => platform.name, isNativePlatform: () => platform.name !== "web" },
}));

vi.mock("@/hooks/useCall", () => ({
  useCall: () => ({ stageVisible: false, toggleStage: vi.fn() }) as unknown as CallContextType,
}));

vi.mock("@livekit/components-react", () => ({
  useConnectionState: () => "connected",
  useParticipants: () => [],
  useLocalParticipant: () => ({
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
  useMediaDeviceSelect: (opts: { kind: MediaDeviceKind; requestPermissions: boolean }) => {
    deviceSelect(opts);
    return {
      devices: [{ deviceId: `${opts.kind}-1`, label: "", kind: opts.kind } as MediaDeviceInfo],
      activeDeviceId: "",
      setActiveMediaDevice: vi.fn(),
    };
  },
  useRoomContext: () => ({ canPlaybackAudio: true, startAudio: vi.fn() }),
  DisconnectButton: () => null,
}));

vi.mock("@/lib/voiceProcessor", () => ({ rnnoiseSupported: () => false, syncRnnoise: vi.fn() }));
vi.mock("@/lib/callSounds", () => ({
  playJoinSound: vi.fn(),
  playLeaveSound: vi.fn(),
  playMuteSound: vi.fn(),
  playUnmuteSound: vi.fn(),
}));

function stubDevices(list: Array<Pick<MediaDeviceInfo, "deviceId" | "kind" | "label">>) {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { enumerateDevices: () => Promise.resolve(list) },
  });
}

function openMenu() {
  render(
    <TooltipProvider>
      <InCallView label="#general" compact />
    </TooltipProvider>,
  );
  fireEvent.keyDown(screen.getByRole("button", { name: "Audio settings" }), { key: "Enter" });
}

/** The permission each picker asked for, by kind, as of its latest render. */
function requested(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [opts] of deviceSelect.mock.calls) out[opts.kind] = opts.requestPermissions;
  return out;
}

beforeEach(() => {
  platform.name = "web";
  stubDevices([
    { deviceId: "default", kind: "audioinput", label: "" },
    { deviceId: "mic-1", kind: "audioinput", label: "USB Mic" },
    { deviceId: "", kind: "videoinput", label: "" },
  ]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("call device menu", () => {
  it("opens no capture when device names are already readable, and never asks for the camera", async () => {
    openMenu();
    expect(await screen.findByText("Microphone")).toBeTruthy();
    await waitFor(() => expect(deviceSelect).toHaveBeenCalled());
    expect(requested()).toMatchObject({ audioinput: false, videoinput: false });
  });

  it("asks for the mic only while its devices are unnamed", async () => {
    stubDevices([{ deviceId: "mic-1", kind: "audioinput", label: "" }]);
    openMenu();
    await waitFor(() => expect(requested().audioinput).toBe(true));
    expect(requested().videoinput).toBe(false);
  });

  it("offers no mic or speaker routes on Android", async () => {
    platform.name = "android";
    openMenu();
    expect(await screen.findByText("Camera")).toBeTruthy();
    expect(screen.queryByText("Microphone")).toBeNull();
    expect(screen.queryByText("Speaker")).toBeNull();
    expect(deviceSelect.mock.calls.map(([o]) => o.kind)).not.toContain("audioinput");
  });

  it("names unlabeled cameras by position", async () => {
    openMenu();
    expect(await screen.findByText("Camera 1")).toBeTruthy();
  });
});
