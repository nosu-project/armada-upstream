/**
 * RNNoise (BSD, WASM in an AudioWorklet) noise cancellation as a LiveKit audio
 * `TrackProcessor` — a self-hostable alternative to Krisp, whose LiveKit filter
 * is proprietary. Always runs at 48 kHz (see `contextFor`). If the worklet or
 * WASM fails to load, `init` rejects and the raw track is published.
 */

import { RnnoiseWorkletNode, loadRnnoise } from "@sapphi-red/web-noise-suppressor";
import rnnoiseWorkletUrl from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import rnnoiseWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseSimdWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";
import { LocalAudioTrack } from "livekit-client";

/** Structural copies of LiveKit's processor types (not exposed by its `exports` map). */
interface AudioProcessorOptions {
  kind: "audio";
  track: MediaStreamTrack;
  audioContext: AudioContext;
}

interface AudioTrackProcessor {
  name: string;
  init: (opts: AudioProcessorOptions) => Promise<void>;
  restart: (opts: AudioProcessorOptions) => Promise<void>;
  destroy: () => Promise<void>;
  processedTrack?: MediaStreamTrack;
}

/** RNNoise WASM, fetched once (SIMD build when supported). */
let wasmBinary: Promise<ArrayBuffer> | undefined;

function getWasmBinary(): Promise<ArrayBuffer> {
  if (!wasmBinary) {
    wasmBinary = loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl });
  }
  return wasmBinary;
}

import { rnnoiseSupported } from "@/lib/rnnoiseSupport";

const RNNOISE_SAMPLE_RATE = 48_000;

class RnnoiseTrackProcessor implements AudioTrackProcessor {
  name = "rnnoise-noise-suppression";
  processedTrack?: MediaStreamTrack;

  private audioContext?: AudioContext;
  private source?: MediaStreamAudioSourceNode;
  private rnnoise?: RnnoiseWorkletNode;
  private destination?: MediaStreamAudioDestinationNode;
  /** Our own 48 kHz context, when the call's runs at the output device's rate. */
  private ownContext?: AudioContext;
  private static moduleByContext = new WeakMap<BaseAudioContext, Promise<void>>();

  async init(opts: AudioProcessorOptions): Promise<void> {
    await this.setup(opts);
  }

  /**
   * Rebuild the graph for a replacement track, tearing the old one down first.
   * LiveKit's `LocalTrack.restart` (unmute after a device change, track-ended
   * recovery, full-reconnect republish) passes no `audioContext`, so keep ours.
   */
  async restart(opts: AudioProcessorOptions): Promise<void> {
    const audioContext = opts.audioContext ?? this.audioContext;
    await this.teardown();
    await this.setup({ ...opts, audioContext: audioContext! });
  }

  async destroy(): Promise<void> {
    await this.teardown();
    void this.ownContext?.close().catch(() => {});
    this.ownContext = undefined;
  }

  /**
   * RNNoise's model is fixed at 48 kHz, 480-sample frames, and the worklet does
   * not resample. LiveKit's context runs at the output device's rate (often
   * 44.1 kHz on Windows), so there the graph gets its own 48 kHz context; Chrome
   * resamples the capture into it, and Opus encodes at 48 kHz anyway.
   */
  private contextFor(callContext: AudioContext): AudioContext {
    if (callContext.sampleRate === RNNOISE_SAMPLE_RATE) return callContext;
    if (!this.ownContext || this.ownContext.state === "closed") {
      const ctx = new AudioContext({ sampleRate: RNNOISE_SAMPLE_RATE, latencyHint: "interactive" });
      // Nothing else watches this context; a suspended one publishes silence.
      const keepRunning = () => {
        const state: string = ctx.state;
        if (state === "suspended" || state === "interrupted") void ctx.resume().catch(() => {});
      };
      ctx.addEventListener("statechange", keepRunning);
      keepRunning();
      this.ownContext = ctx;
    }
    return this.ownContext;
  }

  private async setup(opts: AudioProcessorOptions): Promise<void> {
    const audioContext = opts.audioContext;
    if (!audioContext) throw new Error("rnnoise: missing AudioContext");
    this.audioContext = audioContext;
    const ctx = this.contextFor(audioContext);

    let modulePromise = RnnoiseTrackProcessor.moduleByContext.get(ctx);
    if (!modulePromise) {
      modulePromise = ctx.audioWorklet.addModule(rnnoiseWorkletUrl);
      RnnoiseTrackProcessor.moduleByContext.set(ctx, modulePromise);
    }
    await modulePromise;

    const binary = await getWasmBinary();

    const source = ctx.createMediaStreamSource(new MediaStream([opts.track]));
    const rnnoise = new RnnoiseWorkletNode(ctx, {
      maxChannels: 1,
      wasmBinary: binary,
    });
    // Mono end to end. Chromium's source node is two-channel even for a mono
    // mic, and the worklet fills only `maxChannels` and leaves the rest silent,
    // so a default graph publishes the voice in the left channel only.
    rnnoise.channelCount = 1;
    rnnoise.channelCountMode = "explicit";
    rnnoise.channelInterpretation = "speakers";
    const destination = ctx.createMediaStreamDestination();
    destination.channelCount = 1;

    source.connect(rnnoise);
    rnnoise.connect(destination);

    this.source = source;
    this.rnnoise = rnnoise;
    this.destination = destination;
    this.processedTrack = destination.stream.getAudioTracks()[0];
  }

  private async teardown(): Promise<void> {
    try {
      this.source?.disconnect();
      this.rnnoise?.disconnect();
      this.destination?.disconnect();
      this.rnnoise?.destroy();
    } catch {
      // best-effort cleanup
    }
    this.source = undefined;
    this.rnnoise = undefined;
    this.destination = undefined;
    this.processedTrack = undefined;
    this.audioContext = undefined;
  }
}

/** Create a fresh RNNoise processor instance for a single mic track. */
export function createRnnoiseProcessor(): AudioTrackProcessor {
  return new RnnoiseTrackProcessor();
}

/**
 * Apply or remove RNNoise on a published mic track to match `enabled`
 * (idempotent). Add failures are logged so the raw track keeps publishing.
 */
export async function syncRnnoise(
  track: LocalAudioTrack | undefined,
  enabled: boolean,
): Promise<void> {
  if (!(track instanceof LocalAudioTrack)) return;
  const current = track.getProcessor();
  const hasOurs = current?.name === "rnnoise-noise-suppression";

  if (enabled && !hasOurs && rnnoiseSupported()) {
    try {
      // Cast: LiveKit's generic uses the Track.Kind enum vs our "audio" literal.
      await track.setProcessor(
        createRnnoiseProcessor() as unknown as Parameters<LocalAudioTrack["setProcessor"]>[0],
      );
    } catch (err) {
      console.warn("failed to enable RNNoise noise cancellation", err);
    }
  } else if (!enabled && hasOurs) {
    try {
      await track.stopProcessor();
    } catch (err) {
      console.warn("failed to disable RNNoise noise cancellation", err);
    }
  }
}
