// @vitest-environment node

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const workerSource = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");

interface WindowClientStub {
  url: string;
  visibilityState: string;
  focused: boolean;
  activeDm?: boolean;
  postMessage?(message: unknown, transfer: Transferable[]): void;
}

interface PushEventStub {
  data: { json(): unknown; text(): string };
  waitUntil(promise: Promise<unknown>): void;
}

function loadWorker(options: { clients?: WindowClientStub[]; ownEventId?: string } = {}) {
  const handlers = new Map<string, (event: unknown) => unknown>();
  const showNotification = vi.fn(async () => undefined);
  const cache = {
    match: vi.fn(async (request: string) => (
      options.ownEventId && request.includes(`/own/${options.ownEventId}`) ? {} : undefined
    )),
  };
  const clients = (options.clients ?? []).map((client) => ({
    ...client,
    postMessage: client.postMessage ?? ((_message: unknown, transfer: Transferable[]) => {
      const port = transfer[0] as MessagePort | undefined;
      port?.postMessage({ active: client.activeDm === true });
    }),
  }));
  const self = {
    location: { origin: "https://chat.dill.moe" },
    registration: { showNotification },
    clients: {
      matchAll: vi.fn(async () => clients),
      claim: vi.fn(async () => undefined),
      openWindow: vi.fn(async () => undefined),
    },
    skipWaiting: vi.fn(),
    addEventListener(name: string, handler: (event: unknown) => unknown) {
      handlers.set(name, handler);
    },
  };
  const caches = {
    open: vi.fn(async () => cache),
    keys: vi.fn(async () => []),
  };

  runInNewContext(workerSource, {
    self,
    caches,
    URL,
    MessageChannel,
    console,
    setTimeout,
    clearTimeout,
  });

  async function push(data: Record<string, unknown>): Promise<void> {
    let pending: Promise<unknown> | undefined;
    const event: PushEventStub = {
      data: { json: () => ({ title: "New message", body: "New direct message", data }), text: () => "" },
      waitUntil: (promise) => { pending = promise; },
    };
    const handler = handlers.get("push") as ((event: PushEventStub) => void) | undefined;
    expect(handler).toBeTypeOf("function");
    handler!(event);
    await pending;
  }

  return { push, showNotification };
}

describe("DM Web Push suppression", () => {
  it("suppresses an outgoing event marked by this device", async () => {
    const worker = loadWorker({ ownEventId: "own-wrap" });
    await worker.push({ scope: "dm", event_id: "own-wrap", url: "/dms" });
    expect(worker.showNotification).not.toHaveBeenCalled();
  });

  it("suppresses generic DM push while a specific DM thread is focused", async () => {
    const worker = loadWorker({
      clients: [{
        url: "https://chat.dill.moe/armada/dms/npub1peer",
        visibilityState: "visible",
        focused: true,
      }],
    });
    await worker.push({ scope: "dm", event_id: "incoming-wrap", url: "/dms" });
    expect(worker.showNotification).not.toHaveBeenCalled();
  });

  it("queries the page when client.url still has the pre-navigation DM-list route", async () => {
    const worker = loadWorker({
      clients: [{
        url: "https://chat.dill.moe/armada/dms",
        visibilityState: "visible",
        focused: true,
        activeDm: true,
      }],
    });
    await worker.push({ scope: "dm", event_id: "incoming-wrap", url: "/dms" });
    expect(worker.showNotification).not.toHaveBeenCalled();
  });

  it("still displays a DM push when Armada is focused outside a DM thread", async () => {
    const worker = loadWorker({
      clients: [{
        url: "https://chat.dill.moe/settings",
        visibilityState: "visible",
        focused: true,
      }],
    });
    await worker.push({ scope: "dm", event_id: "incoming-wrap", url: "/dms" });
    expect(worker.showNotification).toHaveBeenCalledTimes(1);
  });
});
