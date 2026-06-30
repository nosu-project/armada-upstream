/**
 * RNNoise ML noise cancellation as a LiveKit audio `TrackProcessor`.
 *
 * This is the open-source, self-host-friendly answer to Discord's "Krisp"
 * background-noise removal. It runs Xiph's RNNoise (BSD) compiled to WASM inside
 * an AudioWorklet — the same engine Jitsi Meet ships — over the locally captured
 * mic, and publishes the cleaned track to the room. We deliberately avoid
 * `@livekit/krisp-noise-filter`, which is proprietary and gated behind LiveKit's
 * commercial Terms of Service (not usable on a self-hosted FOSS deployment).
 *
 * LiveKit drives the processor lifecycle: `init` is called with the raw mic
 * `MediaStreamTrack` + an `AudioContext`, we build a Web Audio graph
 * (source → RNNoise worklet → destination) and expose `processedTrack`, which
 * LiveKit publishes in place of the raw track. `restart` rebuilds the graph for
 * a new track (e.g. after a device switch / `restartTrack`), and `destroy`
 * tears everything down.
 *
 * RNNoise assumes a 48 kHz sample rate; LiveKit's capture AudioContext runs at
 * 48 kHz, which matches. If the worklet or WASM fails to load (old browser, CSP,
 * etc.) `init` rejects and the caller falls back to publishing the raw track.
 */

import { RnnoiseWorkletNode, loadRnnoise } from "@sapphi-red/web-noise-suppressor";
import rnnoiseWorkletUrl from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import rnnoiseWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseSimdWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";
import { LocalAudioTrack } from "livekit-client";

/**
 * LiveKit's `TrackProcessor` / `AudioProcessorOptions` types live behind a deep
 * path that the package's `exports` map doesn't expose, so we restate the small
 * structural shapes we need here. They match
 * `livekit-client/.../track/processor/types` exactly; `setProcessor` accepts any
 * structurally-compatible processor.
 */
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

/**
 * The compiled RNNoise WASM binary, fetched once and reused across calls /
 * processor instances. `loadRnnoise` picks the SIMD build when supported.
 */
let wasmBinary: Promise<ArrayBuffer> | undefined;

function getWasmBinary(): Promise<ArrayBuffer> {
  if (!wasmBinary) {
    wasmBinary = loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl });
  }
  return wasmBinary;
}

/**
 * Whether RNNoise can run in this environment: AudioWorklet support is required.
 * Used to hide the toggle / skip applying the processor where it can't work.
 */
export function rnnoiseSupported(): boolean {
  return (
    typeof AudioWorkletNode !== "undefined" &&
    typeof window !== "undefined" &&
    (typeof window.AudioContext !== "undefined" ||
      typeof (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext !==
        "undefined")
  );
}

class RnnoiseTrackProcessor implements AudioTrackProcessor {
  name = "rnnoise-noise-suppression";
  processedTrack?: MediaStreamTrack;

  private audioContext?: AudioContext;
  private source?: MediaStreamAudioSourceNode;
  private rnnoise?: RnnoiseWorkletNode;
  private destination?: MediaStreamAudioDestinationNode;
  /** Whether we registered the worklet module on this context already. */
  private static moduleByContext = new WeakMap<BaseAudioContext, Promise<void>>();

  async init(opts: AudioProcessorOptions): Promise<void> {
    await this.setup(opts);
  }

  /**
   * Re-wire the graph for a replacement track (device switch / restartTrack).
   * Tear the old graph down first so we don't leak nodes or stack processors.
   */
  async restart(opts: AudioProcessorOptions): Promise<void> {
    await this.teardown();
    await this.setup(opts);
  }

  async destroy(): Promise<void> {
    await this.teardown();
  }

  private async setup(opts: AudioProcessorOptions): Promise<void> {
    const audioContext = opts.audioContext;
    if (!audioContext) throw new Error("rnnoise: missing AudioContext");
    this.audioContext = audioContext;

    // Register the worklet module once per AudioContext.
    let modulePromise = RnnoiseTrackProcessor.moduleByContext.get(audioContext);
    if (!modulePromise) {
      modulePromise = audioContext.audioWorklet.addModule(rnnoiseWorkletUrl);
      RnnoiseTrackProcessor.moduleByContext.set(audioContext, modulePromise);
    }
    await modulePromise;

    const binary = await getWasmBinary();

    const source = audioContext.createMediaStreamSource(new MediaStream([opts.track]));
    const rnnoise = new RnnoiseWorkletNode(audioContext, {
      maxChannels: 1,
      wasmBinary: binary,
    });
    const destination = audioContext.createMediaStreamDestination();

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
 * Apply or remove the RNNoise processor on a published mic track so it matches
 * `enabled`. Idempotent: a no-op when the track already has (or lacks) our
 * processor. Used both when the mic is first published (CallProvider) and when
 * the user toggles noise cancellation mid-call (VoiceBar). Failures to add the
 * processor are swallowed (logged) so a broken worklet load never breaks the
 * call — the raw track keeps publishing.
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
      // Cast: our structural processor matches LiveKit's TrackProcessor shape,
      // but the (unexported) generic uses the Track.Kind enum vs our "audio"
      // literal, so TS can't see them as identical.
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
