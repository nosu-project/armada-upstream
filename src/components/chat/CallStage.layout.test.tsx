import { fireEvent, render, screen, within } from "@testing-library/react";
import { Track } from "livekit-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CallStage } from "./CallStage";

const runtime = vi.hoisted(() => ({
  participants: [] as Array<Record<string, unknown>>,
  tracks: [] as Array<Record<string, unknown>>,
  call: {
    stageFloating: false,
    floatingVariant: null as "desktop" | "mobile" | null,
    stageDocked: true,
    exiting: false,
    activeCall: null as Record<string, unknown> | null,
  },
}));

const setStageOpen = vi.hoisted(() => vi.fn());

vi.mock("@livekit/components-react", () => ({
  useConnectionState: () => "connected",
  useParticipants: () => runtime.participants,
  useSpeakingParticipants: () => [],
  useTracks: () => runtime.tracks,
  useRoomContext: () => ({ localParticipant: { joinedAt: new Date(0) } }),
  VideoTrack: () => <div data-testid="video-track" />,
}));

vi.mock("@/components/chat/CallControls", () => ({
  MicButton: () => <button type="button" aria-label="Mute microphone" />,
  CameraButton: () => <button type="button" aria-label="Turn on camera" />,
  ScreenShareButton: () => <button type="button" aria-label="Share screen" />,
  RaiseHandButton: () => null,
  ReactionsMenu: () => null,
  LeaveButton: () => <button type="button" aria-label="Leave call" />,
}));
vi.mock("@/components/chat/VoiceBar", () => ({
  DeviceMenu: () => <button type="button" aria-label="Audio settings" />,
}));
vi.mock("@/components/VoiceUserContextMenu", () => ({
  VoiceUserContextMenu: ({ children }: { children: React.ReactNode }) => children,
  VolumeSliderRow: () => null,
}));
vi.mock("@/components/DisplayName", () => ({
  DisplayName: ({ name }: { name?: string }) => <>{name}</>,
}));
vi.mock("@/hooks/useAuthor", () => ({ useAuthor: () => ({ data: { metadata: {} } }) }));
vi.mock("@/hooks/useScopedDisplayName", () => ({
  useScopedDisplayName: (pubkey: string) => (pubkey === "a".repeat(64) ? "Me" : "Friend"),
}));
vi.mock("@/contexts/VoiceIdentityContext", () => ({
  useVoiceIdentity: () => (identity: string) => ({
    pubkey: identity === "local" ? "a".repeat(64) : "b".repeat(64),
    verified: true,
  }),
}));
vi.mock("@/contexts/CallSignalsContext", () => ({
  useCallSignals: () => ({ enabled: false, reactions: [], hevcScreenShare: undefined }),
}));
vi.mock("@/hooks/useCall", () => ({
  useCall: () => ({ ...runtime.call, setStageOpen }),
}));
vi.mock("@/hooks/useVoiceActivity", () => ({
  useVoiceActivity: () => ({ raisedHands: new Set() }),
}));
vi.mock("@/hooks/useUserVolume", () => ({
  useUserVolume: () => [1, vi.fn()],
  useScreenShareVolume: () => [1, vi.fn()],
}));
vi.mock("@/lib/callSounds", () => ({ playScreenShareSound: vi.fn() }));
vi.mock("@/lib/hevcScreenShare", () => ({ isHevcScreenShareParticipant: () => false }));

function participant(identity: string, isLocal: boolean) {
  return {
    identity,
    isLocal,
    isMicrophoneEnabled: true,
    joinedAt: new Date(0),
    setVolume: vi.fn(),
  };
}

const local = participant("local", true);
const remote = participant("remote", false);

function camera(of: Record<string, unknown>) {
  return {
    participant: of,
    source: Track.Source.Camera,
    publication: { track: {}, isMuted: false, trackSid: `${of.identity}-cam` },
  };
}

// The setup's matchMedia matches nothing: a phone, as far as useIsDesktop knows.
const phoneMedia = vi.mocked(window.matchMedia).getMockImplementation()!;

afterEach(() => {
  vi.mocked(window.matchMedia).mockImplementation(phoneMedia);
  runtime.participants = [];
  runtime.tracks = [];
  runtime.call.stageDocked = true;
  runtime.call.exiting = false;
  runtime.call.activeCall = null;
  vi.clearAllMocks();
});

describe("docked call layout", () => {
  it("shows a voice-only call as a strip with its controls, not a stage", () => {
    runtime.participants = [local, remote];
    render(<CallStage open callLabel="Friend" />);
    const strip = screen.getByRole("region", { name: "Call" });
    expect(within(strip).getByTitle("Me (you)")).toBeInTheDocument();
    expect(within(strip).getByTitle("Friend")).toBeInTheDocument();
    expect(within(strip).getByRole("button", { name: "Leave call" })).toBeInTheDocument();
    expect(within(strip).getByRole("button", { name: "Audio settings" })).toBeInTheDocument();
    expect(screen.queryByRole("separator", { name: "Resize call pane" })).not.toBeInTheDocument();
  });

  it("reads Calling… in a DM until the peer is in the room, then runs the clock", () => {
    runtime.call.activeCall = { dm: { peer: "b".repeat(64) } };
    runtime.participants = [local];
    const { rerender } = render(<CallStage open callLabel="Friend" />);
    expect(screen.getByText("Calling…")).toBeInTheDocument();

    runtime.participants = [local, remote];
    rerender(<CallStage open callLabel="Friend" />);
    expect(screen.queryByText("Calling…")).not.toBeInTheDocument();
    expect(screen.getByText("0:00")).toBeInTheDocument();
  });

  it("shows a voice-only DM as both people side by side, not a strip", () => {
    runtime.call.activeCall = { dm: { peer: "b".repeat(64) } };
    runtime.participants = [local, remote];
    render(<CallStage open callLabel="Friend call" />);
    const hero = screen.getByRole("region", { name: "Call" });
    expect(within(hero).getByText("You")).toBeInTheDocument();
    expect(within(hero).getByText("Friend")).toBeInTheDocument();
    expect(within(hero).getByRole("button", { name: "Leave call" })).toBeInTheDocument();
    expect(within(hero).queryByTitle("Me (you)")).not.toBeInTheDocument();
  });

  it("names the ringing peer in the DM hero before they join", () => {
    runtime.call.activeCall = { dm: { peer: "b".repeat(64) } };
    runtime.participants = [local];
    render(<CallStage open callLabel="Friend call" />);
    const hero = screen.getByRole("region", { name: "Call" });
    expect(within(hero).getByText("Friend")).toBeInTheDocument();
    expect(within(hero).getByText("Calling…")).toBeInTheDocument();
  });

  it("expands the DM hero to full screen and back", () => {
    runtime.call.activeCall = { dm: { peer: "b".repeat(64) } };
    runtime.participants = [local, remote];
    render(<CallStage open callLabel="Friend call" />);
    fireEvent.click(screen.getByRole("button", { name: "Full screen" }));
    const dialog = screen.getByRole("dialog", { name: "Call" });
    expect(within(dialog).getByText("You")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Exit full screen" }));
    expect(screen.queryByRole("dialog", { name: "Call" })).not.toBeInTheDocument();
  });

  it("promotes to the stage when video starts and collapses back on Hide video", () => {
    vi.mocked(window.matchMedia).mockImplementation(
      (query: string) => ({ matches: true, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList,
    );
    runtime.participants = [local, remote];
    runtime.tracks = [camera(remote)];
    render(<CallStage open callLabel="Friend" />);
    expect(screen.getByRole("separator", { name: "Resize call pane" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Leave call" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Hide video" }));
    expect(setStageOpen).toHaveBeenCalledWith(false);
  });

  it("keeps a collapsed stage as the strip, offering to show the video", () => {
    runtime.participants = [local, remote];
    runtime.tracks = [camera(remote)];
    render(<CallStage open={false} callLabel="Friend" />);
    expect(screen.queryByRole("separator", { name: "Resize call pane" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show video" }));
    expect(setStageOpen).toHaveBeenCalledWith(true);
  });

  it("gives a 1:1 call's stage to the peer and hides our own camera-off tile", () => {
    runtime.participants = [local, remote];
    runtime.tracks = [camera(remote)];
    render(<CallStage open callLabel="Friend" />);
    expect(screen.getAllByTestId("video-track")).toHaveLength(1);
    expect(screen.queryByText(/\(you\)/)).not.toBeInTheDocument();
  });

  it("insets our camera in a 1:1 video call", () => {
    runtime.participants = [local, remote];
    runtime.tracks = [camera(remote), camera(local)];
    render(<CallStage open callLabel="Friend" />);
    const self = screen.getByText(/\(you\)/).closest(".aspect-video");
    expect(self).toHaveClass("absolute");
  });

  it("opens theater on a phone when video starts in the docked call", () => {
    runtime.participants = [local, remote];
    const { rerender } = render(<CallStage open callLabel="Friend" />);
    expect(screen.queryByRole("dialog", { name: "Call" })).not.toBeInTheDocument();

    runtime.tracks = [camera(remote)];
    rerender(<CallStage open callLabel="Friend" />);
    expect(screen.getByRole("dialog", { name: "Call" })).toBeInTheDocument();
  });

  it("leaves theater alone when the stage is not docked", () => {
    runtime.call.stageDocked = false;
    runtime.participants = [local, remote];
    const { rerender } = render(<CallStage open callLabel="Friend" />);
    runtime.tracks = [camera(remote)];
    rerender(<CallStage open callLabel="Friend" />);
    expect(screen.queryByRole("dialog", { name: "Call" })).not.toBeInTheDocument();
  });
});
