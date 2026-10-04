// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useDetectedSpeakers } from "./useSpeakers";

const levels = new Map<string, number>();

function fakeContext(state: AudioContextState = "running") {
  return {
    state,
    createMediaStreamSource: (stream: { id: string }) => ({
      connect: vi.fn(),
      disconnect: vi.fn(),
      id: stream.id,
    }),
    createAnalyser() {
      let identity = "";
      return {
        fftSize: 0,
        smoothingTimeConstant: 0,
        bind(id: string) {
          identity = id;
        },
        getFloatTimeDomainData(buffer: Float32Array) {
          buffer.fill(levels.get(identity) ?? 0);
        },
      };
    },
  };
}

const runtime = vi.hoisted(() => ({
  room: { on: vi.fn(), off: vi.fn(), audioContext: undefined as unknown },
  mics: [] as Array<Record<string, unknown>>,
}));
runtime.room.on.mockReturnValue(runtime.room);
runtime.room.off.mockReturnValue(runtime.room);

vi.mock("@livekit/components-react", () => ({
  useRoomContext: () => runtime.room,
  useTracks: () => runtime.mics,
  useSpeakingParticipants: () => [],
}));

function mic(identity: string, muted = false) {
  return {
    participant: { identity },
    publication: { trackSid: `${identity}-mic`, isMuted: muted, track: { mediaStreamTrack: { id: identity } } },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  // Route each analyser to its track's level through the MediaStream it was built from.
  globalThis.MediaStream = class {
    id: string;
    constructor(tracks: Array<{ id: string }>) {
      this.id = tracks[0].id;
    }
  } as unknown as typeof MediaStream;
  const ctx = fakeContext();
  const create = ctx.createMediaStreamSource;
  let pending = "";
  ctx.createMediaStreamSource = (stream) => {
    pending = stream.id;
    return create(stream);
  };
  const makeAnalyser = ctx.createAnalyser;
  ctx.createAnalyser = () => {
    const analyser = makeAnalyser();
    analyser.bind(pending);
    return analyser;
  };
  runtime.room.audioContext = ctx;
});

afterEach(() => {
  vi.useRealTimers();
  levels.clear();
  runtime.mics = [];
});

describe("useDetectedSpeakers", () => {
  it("lights a speaker within a tick and holds briefly across a pause", () => {
    runtime.mics = [mic("ana"), mic("ben")];
    const { result } = renderHook(() => useDetectedSpeakers());
    expect(result.current).toEqual([]);

    levels.set("ana", 0.1);
    act(() => void vi.advanceTimersByTime(50));
    expect(result.current).toEqual(["ana"]);

    levels.set("ana", 0);
    act(() => void vi.advanceTimersByTime(200));
    expect(result.current).toEqual(["ana"]);
    act(() => void vi.advanceTimersByTime(200));
    expect(result.current).toEqual([]);
  });

  it("ignores a muted mic", () => {
    runtime.mics = [mic("ana", true)];
    levels.set("ana", 0.1);
    const { result } = renderHook(() => useDetectedSpeakers());
    act(() => void vi.advanceTimersByTime(100));
    expect(result.current).toEqual([]);
  });

  it("defers to the server while the call's audio is suspended", () => {
    (runtime.room.audioContext as { state: string }).state = "suspended";
    runtime.mics = [mic("ana")];
    levels.set("ana", 0.1);
    const { result } = renderHook(() => useDetectedSpeakers());
    act(() => void vi.advanceTimersByTime(100));
    expect(result.current).toBeNull();
  });
});
