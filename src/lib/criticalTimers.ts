import { CriticalTimers } from "livekit-client";

let installed = false;

/**
 * Runs LiveKit's signal ping and reconnect timers in a worker, where a hidden
 * page's timer throttling doesn't reach them. Swapped in only once the worker
 * has answered, so a worker that fails to load leaves the defaults in place.
 */
export function installWorkerCriticalTimers(): void {
  if (installed || typeof Worker === "undefined") return;
  installed = true;
  let worker: Worker;
  try {
    worker = new Worker(new URL("./criticalTimers.worker.ts", import.meta.url), { type: "module" });
  } catch (err) {
    console.warn("voice: worker timers unavailable", err);
    return;
  }
  const callbacks = new Map<number, { fn: () => void; repeat: boolean }>();
  // Negative, so they can't collide with the ids the defaults handed out.
  let nextId = -1;
  worker.onerror = (err) => console.warn("voice: worker timers failed", err);
  worker.onmessage = (event: MessageEvent<number>) => {
    if (event.data === 0) return swapIn();
    const entry = callbacks.get(event.data);
    if (!entry) return;
    if (!entry.repeat) callbacks.delete(event.data);
    entry.fn();
  };
  worker.postMessage({ op: "set", id: 0, ms: 0, repeat: false });

  const set = (repeat: boolean) => (handler: TimerHandler, ms = 0, ...args: unknown[]) => {
    if (typeof handler !== "function") throw new TypeError("string timer handlers are not supported");
    const id = nextId--;
    callbacks.set(id, { fn: () => handler(...args), repeat });
    worker.postMessage({ op: "set", id, ms, repeat });
    return id;
  };
  const clear = (id: unknown) => {
    if (typeof id !== "number" || !callbacks.delete(id)) return;
    worker.postMessage({ op: "clear", id });
  };

  function swapIn() {
    const timers = CriticalTimers as unknown as Record<string, (...a: unknown[]) => unknown>;
    const nativeClearTimeout = timers.clearTimeout;
    const nativeClearInterval = timers.clearInterval;
    timers.setTimeout = set(false);
    timers.setInterval = set(true);
    timers.clearTimeout = (id) => (typeof id === "number" && id < 0 ? clear(id) : nativeClearTimeout(id));
    timers.clearInterval = (id) => (typeof id === "number" && id < 0 ? clear(id) : nativeClearInterval(id));
  }
}
