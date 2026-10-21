/// <reference lib="webworker" />

/**
 * The call recorder's worker: one file per voice (or one mixdown), each kept
 * on the recording's clock by a TrackTimeline, encoded, and written as it
 * arrives into OPFS through a sync access handle — so a crash or a closed tab
 * loses only the last moments, not the take. The main thread copies the
 * finished files out (`export.ts`).
 */

import { AuEncoder } from "@/lib/callRecording/au";
import type { Encoder } from "@/lib/callRecording/encoder";
import { FlacEncoder } from "@/lib/callRecording/flac";
import { FORMAT_EXTENSION, OPUS_BITRATE, type RecordingFormat } from "@/lib/callRecording/formats";
import { STAGING_DIR, type FromWorker, type StagedFile, type TapChunk, type ToWorker } from "@/lib/callRecording/protocol";
import { TrackTimeline } from "@/lib/callRecording/timeline";
import { WavEncoder } from "@/lib/callRecording/wav";

const FLUSH_EVERY_MS = 5_000;
/** How long `stop` waits for each tap's last batch. */
const DRAIN_TIMEOUT_MS = 2_000;
const SILENCE = new Float32Array(48_000);

class FileSink {
  size = 0;
  private flushedAt = Date.now();

  constructor(private readonly handle: FileSystemSyncAccessHandle) {}

  append(bytes: Uint8Array): void {
    this.writeAt(this.size, bytes);
  }

  writeAt(at: number, bytes: Uint8Array): void {
    let done = 0;
    while (done < bytes.length) done += this.handle.write(bytes.subarray(done), { at: at + done });
    this.size = Math.max(this.size, at + bytes.length);
    if (Date.now() - this.flushedAt > FLUSH_EVERY_MS) {
      this.handle.flush();
      this.flushedAt = Date.now();
    }
  }

  close(): void {
    this.handle.flush();
    this.handle.close();
  }
}

interface TrackWriter {
  write(samples: Float32Array): Promise<void>;
  finish(): Promise<void>;
}

class EncoderWriter implements TrackWriter {
  constructor(
    private readonly encoder: Encoder,
    private readonly sink: FileSink,
  ) {}

  async open(): Promise<this> {
    for (const bytes of await this.encoder.start()) this.sink.append(bytes);
    return this;
  }

  async write(samples: Float32Array): Promise<void> {
    for (const bytes of await this.encoder.write(samples)) this.sink.append(bytes);
  }

  async finish(): Promise<void> {
    const { tail, patches } = await this.encoder.finish();
    for (const bytes of tail) this.sink.append(bytes);
    for (const patch of patches) this.sink.writeAt(patch.at, patch.bytes);
  }
}

/** Ogg Opus through mediabunny (WebCodecs), loaded only when chosen. */
async function openOpusWriter(sink: FileSink, sampleRate: number, title: string): Promise<TrackWriter> {
  const { AudioSample, AudioSampleSource, OggOutputFormat, Output, StreamTarget } = await import("mediabunny");
  const writable = new WritableStream<{ data: Uint8Array; position: number }>({
    write: (chunk) => sink.writeAt(chunk.position, chunk.data),
  });
  const output = new Output({ format: new OggOutputFormat(), target: new StreamTarget(writable) });
  const source = new AudioSampleSource({ codec: "opus", bitrate: OPUS_BITRATE });
  output.addAudioTrack(source);
  output.setMetadataTags({ title });
  await output.start();
  let frames = 0;
  return {
    async write(samples) {
      const sample = new AudioSample({
        data: samples,
        format: "f32",
        numberOfChannels: 1,
        sampleRate,
        timestamp: frames / sampleRate,
      });
      frames += samples.length;
      await source.add(sample);
      sample.close();
    },
    async finish() {
      source.close();
      await output.finalize();
    },
  };
}

interface Track {
  key: string;
  title: string;
  staged: string;
  sink: FileSink | null;
  timeline: TrackTimeline;
  writer: Promise<TrackWriter>;
  /** Serializes every write to this track's file. */
  chain: Promise<unknown>;
  drained: Promise<void>;
}

let id = "";
let format: RecordingFormat = "flac";
let sampleRate = 48_000;
let startFrame = 0;
let dir: FileSystemDirectoryHandle | null = null;
let failed = false;
const tracks = new Map<string, Track>();

const post = (message: FromWorker) => (self as DedicatedWorkerGlobalScope).postMessage(message);

function fail(err: unknown): void {
  if (failed) return;
  failed = true;
  const quota = err instanceof DOMException && err.name === "QuotaExceededError";
  post({ type: "error", message: err instanceof Error ? err.message : String(err), quota });
}

async function openTrack(track: Track): Promise<TrackWriter> {
  const handle = await dir!.getFileHandle(track.staged, { create: true });
  const sink = new FileSink(await handle.createSyncAccessHandle());
  track.sink = sink;
  const opts = { sampleRate, title: track.title };
  if (format === "opus") return openOpusWriter(sink, sampleRate, track.title);
  const encoder = format === "wav" ? new WavEncoder(opts) : format === "au" ? new AuEncoder(opts) : new FlacEncoder(opts);
  return new EncoderWriter(encoder, sink).open();
}

async function writeSilence(writer: TrackWriter, frames: number): Promise<void> {
  for (let left = frames; left > 0; left -= SILENCE.length) {
    await writer.write(left >= SILENCE.length ? SILENCE : SILENCE.subarray(0, left));
  }
}

function addTrack(key: string, title: string, port: MessagePort): void {
  let resolveDrained!: () => void;
  const track: Track = {
    key,
    title,
    staged: `${tracks.size}.${FORMAT_EXTENSION[format]}`,
    sink: null,
    timeline: new TrackTimeline(),
    writer: null!,
    chain: Promise.resolve(),
    drained: new Promise((resolve) => (resolveDrained = resolve)),
  };
  tracks.set(key, track);
  track.writer = openTrack(track);
  track.chain = track.writer.catch(fail);
  port.onmessage = (event: MessageEvent<TapChunk>) => {
    const chunk = event.data;
    if ("done" in chunk) {
      resolveDrained();
      port.close();
      return;
    }
    track.chain = track.chain
      .then(async () => {
        if (failed) return;
        const writer = await track.writer;
        const placed = track.timeline.place(chunk.f - startFrame, chunk.d);
        await writeSilence(writer, placed.silence);
        if (placed.samples.length > 0) await writer.write(placed.samples);
      })
      .catch(fail);
  };
}

self.onmessage = (event: MessageEvent<ToWorker>) => {
  const msg = event.data;
  void (async () => {
    switch (msg.type) {
      case "init": {
        id = msg.id;
        format = msg.format;
        sampleRate = msg.sampleRate;
        try {
          const root = await navigator.storage.getDirectory();
          const base = await root.getDirectoryHandle(STAGING_DIR, { create: true });
          dir = await base.getDirectoryHandle(id, { create: true });
          // Prove sync access works here before anyone is told we're recording.
          const probe = await dir.getFileHandle(".probe", { create: true });
          (await probe.createSyncAccessHandle()).close();
          await dir.removeEntry(".probe");
          post({ type: "ready" });
        } catch (err) {
          fail(err);
        }
        return;
      }
      case "start":
        startFrame = msg.startFrame;
        return;
      case "track":
        if (!tracks.has(msg.key)) addTrack(msg.key, msg.title, msg.port);
        return;
      case "stop": {
        const total = Math.max(0, msg.endFrame - startFrame);
        await Promise.all(
          [...tracks.values()].map((t) =>
            Promise.race([t.drained, new Promise((r) => setTimeout(r, DRAIN_TIMEOUT_MS))]),
          ),
        );
        const files: StagedFile[] = [];
        for (const track of tracks.values()) {
          await track.chain;
          try {
            const writer = await track.writer;
            // Every file ends with the recording, so they line up end to end too.
            await writeSilence(writer, track.timeline.padTo(total));
            await writer.finish();
            track.sink?.close();
            files.push({ key: track.key, title: track.title, staged: track.staged, bytes: track.sink?.size ?? 0 });
          } catch (err) {
            fail(err);
          }
        }
        if (!failed) post({ type: "stopped", files });
        return;
      }
      case "abort":
        for (const track of tracks.values()) {
          try {
            track.sink?.close();
          } catch {
            /* already closed */
          }
        }
        try {
          const root = await navigator.storage.getDirectory();
          const base = await root.getDirectoryHandle(STAGING_DIR);
          await base.removeEntry(id, { recursive: true });
        } catch {
          /* nothing staged */
        }
        return;
    }
  })();
};
