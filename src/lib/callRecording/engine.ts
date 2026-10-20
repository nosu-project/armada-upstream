import tapUrl from "@/lib/callRecording/tap.worklet.ts?worker&url";
import type { RecordingFormat } from "@/lib/callRecording/formats";
import type { FromWorker, StagedFile, TapControl, ToWorker } from "@/lib/callRecording/protocol";

export type RecordingMode = "multichannel" | "mixdown";

/** One voice the policy allows into the recording right now. */
export interface RecordingSource {
  /** Stable per person (their pubkey), so a rejoin continues the same file. */
  key: string;
  /** The person's name: the file's title and `%user`. */
  title: string;
  track: MediaStreamTrack;
}

export const MIXDOWN_KEY = "mixdown";

export class RecordingError extends Error {
  constructor(
    message: string,
    readonly quota = false,
  ) {
    super(message);
  }
}

/** Whether this runtime has everything a recording needs (Web Audio worklets, workers, OPFS). */
export function isCallRecordingSupported(): boolean {
  return (
    typeof AudioWorkletNode !== "undefined" &&
    typeof Worker !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.storage?.getDirectory === "function"
  );
}

interface Tap {
  node: AudioWorkletNode;
  /** Mixdown: the sum every source feeds. */
  input: AudioNode;
}

interface Attached {
  trackId: string;
  node: MediaStreamAudioSourceNode;
}

/**
 * One take. Every voice runs through its own AudioWorklet tap in a context of
 * our own (LiveKit replaces its context on reconnect), so all of them share
 * one sample clock. Sources come and go through `setSources`: a source the
 * policy drops is disconnected at once, and its file carries silence from then.
 */
export class CallRecording {
  readonly id = crypto.randomUUID();
  private readonly taps = new Map<string, Tap>();
  private readonly attached = new Map<string, Attached>();
  private readonly sink: GainNode;
  private startTime = 0;
  private stopped = false;
  private failure: ((err: RecordingError) => void) | null = null;
  private pendingStop: ((files: StagedFile[]) => void) | null = null;
  private pendingStopError: ((err: RecordingError) => void) | null = null;

  private constructor(
    private readonly ctx: AudioContext,
    private readonly worker: Worker,
    readonly mode: RecordingMode,
    readonly format: RecordingFormat,
  ) {
    // Taps must be pulled by the destination to run; they feed it silence.
    this.sink = new GainNode(ctx, { gain: 0 });
    this.sink.connect(ctx.destination);
    worker.onmessage = (event: MessageEvent<FromWorker>) => this.onWorker(event.data);
  }

  /**
   * Build the graph and prove storage works. Call from the click that starts
   * the recording: the AudioContext needs the gesture to run.
   */
  static async prepare(mode: RecordingMode, format: RecordingFormat): Promise<CallRecording> {
    const ctx = new AudioContext({ sampleRate: 48_000, latencyHint: "playback" });
    const worker = new Worker(new URL("./recorder.worker.ts", import.meta.url), { type: "module" });
    const rec = new CallRecording(ctx, worker, mode, format);
    try {
      await Promise.all([ctx.audioWorklet.addModule(tapUrl), ctx.resume()]);
      await new Promise<void>((resolve, reject) => {
        rec.failure = reject;
        rec.readyResolve = resolve;
        rec.post({ type: "init", id: rec.id, format, sampleRate: ctx.sampleRate });
      });
      return rec;
    } catch (err) {
      rec.abort();
      throw err instanceof RecordingError ? err : new RecordingError(err instanceof Error ? err.message : String(err));
    }
  }

  private readyResolve: (() => void) | null = null;

  get sampleRate(): number {
    return this.ctx.sampleRate;
  }

  /** Start the clock. Everything before this is not part of the take. */
  begin(onError: (err: RecordingError) => void): void {
    this.failure = onError;
    this.startTime = this.ctx.currentTime;
    this.post({ type: "start", startFrame: Math.round(this.startTime * this.ctx.sampleRate) });
    if (this.mode === "mixdown") this.ensureTap(MIXDOWN_KEY, "Mixdown");
  }

  elapsedMs(): number {
    return Math.max(0, (this.ctx.currentTime - this.startTime) * 1000);
  }

  /** Converge on exactly `sources`: attach the new, re-attach a changed track, detach the rest. */
  setSources(sources: readonly RecordingSource[]): void {
    if (this.stopped) return;
    const wanted = new Map(sources.map((s) => [s.key, s]));
    for (const [key, att] of this.attached) {
      const want = wanted.get(key);
      if (!want || want.track.id !== att.trackId || want.track.readyState === "ended") {
        att.node.disconnect();
        this.attached.delete(key);
      }
    }
    for (const source of wanted.values()) {
      if (this.attached.has(source.key) || source.track.readyState === "ended") continue;
      const tap =
        this.mode === "mixdown" ? this.taps.get(MIXDOWN_KEY)! : this.ensureTap(source.key, source.title);
      const node = new MediaStreamAudioSourceNode(this.ctx, {
        mediaStream: new MediaStream([source.track]),
      });
      node.connect(tap.input);
      this.attached.set(source.key, { trackId: source.track.id, node });
    }
  }

  /** The keys being captured at this moment. */
  capturing(): ReadonlySet<string> {
    return new Set(this.attached.keys());
  }

  /** Finish every file; resolves with what was staged. */
  async stop(): Promise<StagedFile[]> {
    if (this.stopped) throw new RecordingError("already stopped");
    this.stopped = true;
    for (const att of this.attached.values()) att.node.disconnect();
    this.attached.clear();
    const endFrame = Math.round(this.ctx.currentTime * this.ctx.sampleRate);
    const files = new Promise<StagedFile[]>((resolve, reject) => {
      this.pendingStop = resolve;
      this.pendingStopError = reject;
    });
    for (const tap of this.taps.values()) tap.node.port.postMessage({ flush: true } satisfies TapControl);
    this.post({ type: "stop", endFrame });
    try {
      return await files;
    } finally {
      this.teardown();
    }
  }

  /** Drop the take and its staged files. */
  abort(): void {
    this.stopped = true;
    this.post({ type: "abort" });
    // Give the worker a moment to delete the staging directory.
    setTimeout(() => this.teardown(), 2_000);
    for (const att of this.attached.values()) att.node.disconnect();
    this.attached.clear();
  }

  private ensureTap(key: string, title: string): Tap {
    const existing = this.taps.get(key);
    if (existing) return existing;
    const node = new AudioWorkletNode(this.ctx, "armada-record-tap", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: "explicit",
      channelInterpretation: "speakers",
    });
    node.connect(this.sink);
    const channel = new MessageChannel();
    node.port.postMessage({ port: channel.port1 } satisfies TapControl, [channel.port1]);
    this.post({ type: "track", key, title, port: channel.port2 }, [channel.port2]);
    let input: AudioNode = node;
    if (this.mode === "mixdown") {
      input = new GainNode(this.ctx, { gain: 1 });
      input.connect(node);
    }
    const tap = { node, input };
    this.taps.set(key, tap);
    return tap;
  }

  private onWorker(msg: FromWorker): void {
    switch (msg.type) {
      case "ready":
        this.readyResolve?.();
        this.readyResolve = null;
        return;
      case "stopped":
        this.pendingStop?.(msg.files);
        return;
      case "error": {
        const err = new RecordingError(msg.message, msg.quota);
        if (this.pendingStopError) this.pendingStopError(err);
        else this.failure?.(err);
        return;
      }
    }
  }

  private post(msg: ToWorker, transfer: Transferable[] = []): void {
    this.worker.postMessage(msg, transfer);
  }

  private teardown(): void {
    for (const tap of this.taps.values()) tap.node.disconnect();
    this.taps.clear();
    this.sink.disconnect();
    void this.ctx.close().catch(() => undefined);
    this.worker.terminate();
  }
}
