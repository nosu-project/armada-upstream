import { describe, expect, it, vi } from "vitest";

vi.mock("@sapphi-red/web-noise-suppressor", () => ({
  loadRnnoise: vi.fn(async () => new ArrayBuffer(8)),
  RnnoiseWorkletNode: class {
    static last: unknown;
    constructor() {
      (this.constructor as unknown as { last: unknown }).last = this;
    }
    connect() {}
    disconnect() {}
    destroy() {}
  },
}));
vi.mock("@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url", () => ({ default: "w.js" }));
vi.mock("@sapphi-red/web-noise-suppressor/rnnoise.wasm?url", () => ({ default: "r.wasm" }));
vi.mock("@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url", () => ({ default: "s.wasm" }));

class FakeMediaStream {
  constructor(public tracks: unknown[] = []) {}
  getAudioTracks() {
    return this.tracks;
  }
}
vi.stubGlobal("MediaStream", FakeMediaStream);

const { createRnnoiseProcessor } = await import("./voiceProcessor");
const { RnnoiseWorkletNode } = await import("@sapphi-red/web-noise-suppressor");

function fakeContext() {
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });
  return {
    audioWorklet: { addModule: vi.fn(async () => {}) },
    createMediaStreamSource: vi.fn(node),
    createMediaStreamDestination: vi.fn(() => ({
      ...node(),
      stream: new FakeMediaStream([{ id: "processed" }]),
    })),
  } as unknown as AudioContext;
}

describe("RNNoise track processor", () => {
  // LiveKit's LocalTrack.restart calls processor.restart({ track, kind, element,
  // localTrack }) with no audioContext — unmute after a device change, a track
  // that ended, and a full-reconnect republish all go through it.
  it("restarts on the context it was initialized with when LiveKit omits it", async () => {
    const ctx = fakeContext();
    const processor = createRnnoiseProcessor();
    const track = { id: "mic-1" } as unknown as MediaStreamTrack;
    await processor.init({ kind: "audio", track, audioContext: ctx });

    const restarted = { id: "mic-2" } as unknown as MediaStreamTrack;
    await expect(
      processor.restart({ kind: "audio", track: restarted } as unknown as Parameters<
        typeof processor.restart
      >[0]),
    ).resolves.toBeUndefined();
    expect(processor.processedTrack).toBeDefined();
    expect(ctx.createMediaStreamSource).toHaveBeenCalledTimes(2);
  });

  it("still survives a second restart", async () => {
    const ctx = fakeContext();
    const processor = createRnnoiseProcessor();
    await processor.init({ kind: "audio", track: {} as MediaStreamTrack, audioContext: ctx });
    const opts = { kind: "audio", track: {} } as unknown as Parameters<typeof processor.restart>[0];
    await processor.restart(opts);
    await processor.restart(opts);
    expect(ctx.createMediaStreamSource).toHaveBeenCalledTimes(3);
  });

  it("runs the graph in mono so a stereo capture isn't denoised to one side", async () => {
    const ctx = fakeContext();
    await createRnnoiseProcessor().init({ kind: "audio", track: {} as MediaStreamTrack, audioContext: ctx });
    const node = (RnnoiseWorkletNode as unknown as { last: AudioNode }).last;
    expect(node).toMatchObject({ channelCount: 1, channelCountMode: "explicit", channelInterpretation: "speakers" });
    const destination = vi.mocked(ctx.createMediaStreamDestination).mock.results[0].value;
    expect(destination.channelCount).toBe(1);
  });
});
