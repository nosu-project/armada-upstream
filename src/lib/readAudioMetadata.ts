import type { AudioMetadata } from "@/lib/audioMetadata";
import type { WorkerRequest, WorkerResponse } from "@/lib/video/types";

/** An idle worker is closed after this long; a timeline of audio reuses one. */
const IDLE_MS = 30_000;

let worker: Worker | null = null;
let nextId = 0;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
const pending = new Map<number, (result: AudioMetadata) => void>();

function settleAll(): void {
  for (const resolve of pending.values()) resolve({});
  pending.clear();
}

function getWorker(): Worker {
  if (worker) return worker;
  // The media worker, which bundles mediabunny so the main bundle need not.
  const w = new Worker(new URL("./video/worker.ts", import.meta.url), { type: "module" });
  w.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const message = event.data;
    if (message.type !== "audioTags") return;
    pending.get(message.id)?.(message.result);
    pending.delete(message.id);
    if (pending.size === 0) scheduleIdle();
  };
  w.onerror = () => {
    w.terminate();
    if (worker === w) worker = null;
    settleAll();
  };
  worker = w;
  return w;
}

function scheduleIdle(): void {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (pending.size > 0) return;
    worker?.terminate();
    worker = null;
  }, IDLE_MS);
}

/**
 * Read an audio file's tags and front cover. http(s) URLs use range requests
 * so only the tag block is fetched. Never throws.
 */
export function readAudioMetadata(source: Blob | string): Promise<AudioMetadata> {
  if (typeof Worker === "undefined") return Promise.resolve({});
  return new Promise((resolve) => {
    let w: Worker;
    try {
      w = getWorker();
    } catch {
      resolve({});
      return;
    }
    clearTimeout(idleTimer);
    const id = nextId++;
    pending.set(id, resolve);
    w.postMessage({ type: "audioTags", id, source } satisfies WorkerRequest);
  });
}
