import { afterEach, describe, expect, it, vi } from "vitest";

import { installServiceWorker, type PushRuntime } from "@/sw/worker";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function loadWorker() {
  const handlers = new Map<string, (event: unknown) => unknown>();
  const store = new Map<string, Response>();
  const keyOf = (request: string | { url: string }) => (typeof request === "string" ? request : request.url);
  const cache = {
    match: vi.fn(async (request: string) => store.get(keyOf(request))?.clone()),
    put: vi.fn(async (request: string, response: Response) => { store.set(keyOf(request), response); }),
    delete: vi.fn(async (request: string | { url: string }) => store.delete(keyOf(request))),
    keys: vi.fn(async () => [...store.keys()].map((url) => ({ url }))),
  };
  const self = {
    location: { origin: "https://armada.buzz" },
    registration: {
      showNotification: vi.fn(async () => undefined),
      pushManager: { getSubscription: async () => null, subscribe: vi.fn() },
    },
    clients: { matchAll: vi.fn(async () => []), claim: vi.fn(), openWindow: vi.fn() },
    skipWaiting: vi.fn(),
    addEventListener(name: string, handler: (event: unknown) => unknown) {
      handlers.set(name, handler);
    },
  };
  vi.stubGlobal("self", self);
  vi.stubGlobal("caches", { open: vi.fn(async () => cache), keys: vi.fn(async () => []) });
  const runtime: PushRuntime = {
    preparePush: async () => undefined,
    pushScope: () => undefined,
    openConfig: async () => null,
  };
  installServiceWorker(runtime);

  async function push(data: Record<string, unknown>): Promise<void> {
    let pending: Promise<unknown> | undefined;
    (handlers.get("push") as (e: unknown) => void)({
      data: { json: () => ({ title: "New message", body: "x", data }), text: () => "" },
      waitUntil: (p: Promise<unknown>) => { pending = p; },
    });
    await pending;
  }
  const alertKeys = () => [...store.keys()].filter((k) => k.includes("/.armada-push-state/alert/"));
  const silentFlags = () =>
    self.registration.showNotification.mock.calls.map((call) => Boolean((call as unknown[])[1] && ((call as unknown[])[1] as { silent?: boolean }).silent));
  return { push, alertKeys, silentFlags };
}

describe("roomAlertSilent alert/ entries", () => {
  it("bounds the alert/ entries, dropping the longest-quiet rooms first", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const w = loadWorker();
    for (let i = 0; i < 200; i++) {
      await w.push({ scope: "group", event_id: `ev-${i}`, tag: `room-${i}` });
    }
    const keys = w.alertKeys();
    expect(keys).toHaveLength(128);
    expect(keys.some((k) => k.endsWith("/alert/room-0"))).toBe(false);
    expect(keys.at(-1)).toContain("/alert/room-199");
  });

  it("keeps an active room's entry when it is re-written, and its flood stays silent", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const w = loadWorker();
    for (let i = 0; i < 6; i++) await w.push({ scope: "group", event_id: `f-${i}`, tag: "flood" });
    for (let i = 0; i < 127; i++) await w.push({ scope: "group", event_id: `o-${i}`, tag: `room-${i}` });
    await w.push({ scope: "group", event_id: "f-6", tag: "flood" });
    for (let i = 127; i < 200; i++) await w.push({ scope: "group", event_id: `o-${i}`, tag: `room-${i}` });
    expect(w.alertKeys().some((k) => k.endsWith("/alert/flood"))).toBe(true);
    await w.push({ scope: "group", event_id: "f-7", tag: "flood" });
    // Five alerting, then silent for the rest of the window.
    const flags = w.silentFlags();
    expect(flags.slice(0, 6)).toEqual([false, false, false, false, false, true]);
    expect(flags.at(-1)).toBe(true);
  });

  it("bounds legacy event-id rate keys too", async () => {
    const w = loadWorker();
    for (let i = 0; i < 150; i++) await w.push({ scope: "group", event_id: `untagged-${i}` });
    expect(w.alertKeys()).toHaveLength(128);
  });
});
