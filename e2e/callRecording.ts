// Browser-side harness for the call-recording e2e. It runs the REAL recorder
// — AudioWorklet taps, the worker, OPFS sync access handles, WebCodecs Opus —
// over synthetic voices, which no vitest environment has. Each voice is a tone
// on its own track, so the spec can tell from the files who was captured when.
import { CallRecording, type RecordingMode, type RecordingSource } from "@/lib/callRecording/engine";
import type { RecordingFormat } from "@/lib/callRecording/formats";
import { STAGING_DIR } from "@/lib/callRecording/protocol";

/** Which voices the policy allows, in phases of `ms` each. */
type Phase = { ms: number; voices: ("ana" | "ben")[] };

interface RecordedFile {
  key: string;
  title: string;
  base64: string;
}

interface CallRecordingHarness {
  record(format: RecordingFormat, mode: RecordingMode, phases: Phase[]): Promise<RecordedFile[]>;
}

declare global {
  interface Window {
    __callRecordingHarness?: CallRecordingHarness;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function voice(ctx: AudioContext, hz: number): MediaStreamTrack {
  const osc = new OscillatorNode(ctx, { frequency: hz });
  const gain = new GainNode(ctx, { gain: 0.5 });
  const dest = new MediaStreamAudioDestinationNode(ctx, { channelCount: 1 });
  osc.connect(gain).connect(dest);
  osc.start();
  return dest.stream.getAudioTracks()[0];
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

window.__callRecordingHarness = {
  async record(format, mode, phases) {
    const source = new AudioContext({ sampleRate: 48_000 });
    await source.resume();
    const tracks: Record<"ana" | "ben", RecordingSource> = {
      ana: { key: "ana", title: "Ana", track: voice(source, 440) },
      ben: { key: "ben", title: "Ben", track: voice(source, 1000) },
    };
    const rec = await CallRecording.prepare(mode, format);
    let failure: Error | null = null;
    rec.begin((err) => (failure = err));
    for (const phase of phases) {
      rec.setSources(phase.voices.map((v) => tracks[v]));
      await sleep(phase.ms);
    }
    const files = await rec.stop();
    if (failure) throw failure;
    const root = await navigator.storage.getDirectory();
    const dir = await (await root.getDirectoryHandle(STAGING_DIR)).getDirectoryHandle(rec.id);
    const out: RecordedFile[] = [];
    for (const file of files) {
      const bytes = new Uint8Array(await (await (await dir.getFileHandle(file.staged)).getFile()).arrayBuffer());
      out.push({ key: file.key, title: file.title, base64: toBase64(bytes) });
    }
    await source.close();
    return out;
  },
};
