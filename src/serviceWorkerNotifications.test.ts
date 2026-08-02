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
  ownsNotifications?: boolean;
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
    postMessage: client.postMessage ?? ((message: unknown, transfer: Transferable[]) => {
      const port = transfer[0] as MessagePort | undefined;
      const type = (message as { type?: string })?.type;
      port?.postMessage(type === "armada-notification-owner-query"
        ? { owns: client.ownsNotifications === true }
        : { active: client.activeDm === true });
    }),
  }));
  const self = {
    location: { origin: "https://armada.buzz" },
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

describe("Web Push suppression", () => {
  it("suppresses an outgoing event marked by this device", async () => {
    const worker = loadWorker({ ownEventId: "own-wrap" });
    await worker.push({ scope: "dm", event_id: "own-wrap", url: "/dm" });
    expect(worker.showNotification).not.toHaveBeenCalled();
  });

  it.each(["group", "group-mention", "c1", "c2"])(
    "suppresses a locally-authored %s community event",
    async (scope) => {
      const worker = loadWorker({ ownEventId: "own-community-event" });
      await worker.push({ scope, event_id: "own-community-event", url: "/s/relay/community" });
      expect(worker.showNotification).not.toHaveBeenCalled();
    },
  );

  it("suppresses generic DM push while a specific DM thread is focused", async () => {
    const worker = loadWorker({
      clients: [{
        url: "https://armada.buzz/dm/npub1peer",
        visibilityState: "visible",
        focused: true,
      }],
    });
    await worker.push({ scope: "dm", event_id: "incoming-wrap", url: "/dm" });
    expect(worker.showNotification).not.toHaveBeenCalled();
  });

  it("suppresses when the focused window predates the /dms → /dm rename", async () => {
    const worker = loadWorker({
      clients: [{
        url: "https://armada.buzz/dms/npub1peer",
        visibilityState: "visible",
        focused: true,
      }],
    });
    await worker.push({ scope: "dm", event_id: "incoming-wrap", url: "/dm" });
    expect(worker.showNotification).not.toHaveBeenCalled();
  });

  it("queries the page when client.url still has the pre-navigation DM-list route", async () => {
    const worker = loadWorker({
      clients: [{
        url: "https://armada.buzz/dm",
        visibilityState: "visible",
        focused: true,
        activeDm: true,
      }],
    });
    await worker.push({ scope: "dm", event_id: "incoming-wrap", url: "/dm" });
    expect(worker.showNotification).not.toHaveBeenCalled();
  });

  it("still displays a DM push when Armada is focused outside a DM thread", async () => {
    const worker = loadWorker({
      clients: [{
        url: "https://armada.buzz/settings",
        visibilityState: "visible",
        focused: true,
      }],
    });
    await worker.push({ scope: "dm", event_id: "incoming-wrap", url: "/dm" });
    expect(worker.showNotification).toHaveBeenCalledTimes(1);
  });

  it("lets a live decrypted notifier replace the generic DM push", async () => {
    const worker = loadWorker({
      clients: [{
        url: "https://armada.buzz/settings",
        visibilityState: "hidden",
        focused: false,
        ownsNotifications: true,
      }],
    });
    await worker.push({ scope: "dm", event_id: "incoming-wrap", url: "/dm" });
    expect(worker.showNotification).not.toHaveBeenCalled();
  });

  it.each(["group", "group-mention", "c1", "c2"])(
    "hands an open-app %s push to the room-aware foreground notifier",
    async (scope) => {
      const worker = loadWorker({
        clients: [{
          url: "https://armada.buzz/c/community/channel",
          visibilityState: "visible",
          focused: true,
          ownsNotifications: true,
        }],
      });
      await worker.push({ scope, event_id: "incoming-community-event" });
      expect(worker.showNotification).not.toHaveBeenCalled();
    },
  );

  it.each(["group", "group-mention", "c1", "c2"])(
    "keeps the service-worker %s fallback when no page owns presentation",
    async (scope) => {
      const worker = loadWorker();
      await worker.push({ scope, event_id: "incoming-community-event" });
      expect(worker.showNotification).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps the generic DM fallback when no live page can decrypt it", async () => {
    const worker = loadWorker();
    await worker.push({ scope: "dm", event_id: "incoming-wrap", url: "/dm" });
    expect(worker.showNotification).toHaveBeenCalledTimes(1);
  });
});
