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

function loadWorker(options: {
  clients?: WindowClientStub[];
  ownEventId?: string;
  badging?: boolean;
  dmCrypto?: { unwrapDm: (...args: unknown[]) => unknown };
  dmConfig?: Record<string, unknown>;
  pushEndpoint?: string;
} = {}) {
  const handlers = new Map<string, (event: unknown) => unknown>();
  const showNotification = vi.fn(async () => undefined);
  const setAppBadge = vi.fn(async () => undefined);
  let badgeResponse: Response | undefined;
  const cache = {
    match: vi.fn(async (request: string) => {
      if (options.ownEventId && request.includes(`/own/${options.ownEventId}`)) return {};
      if (request.endsWith("/.armada-push-state/badge")) return badgeResponse;
      if (options.dmConfig && request.endsWith("/.armada-push-state/dm-config")) {
        // The worker reads sealed bytes and decrypts via ArmadaDmCrypto.openConfig
        // (stubbed below); the bytes themselves are opaque here.
        return { arrayBuffer: async () => new ArrayBuffer(16) };
      }
      return undefined;
    }),
    put: vi.fn(async (_request: string, response: Response) => { badgeResponse = response; }),
    delete: vi.fn(async () => true),
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
    navigator: options.badging ? { setAppBadge, clearAppBadge: vi.fn() } : undefined,
    registration: {
      showNotification,
      ...(options.pushEndpoint
        ? { pushManager: { getSubscription: async () => ({ endpoint: options.pushEndpoint }) } }
        : {}),
    },
    // The worker opens the sealed config via ArmadaDmCrypto.openConfig; stub it
    // to hand back the injected config directly (the vault crypto is unit-tested
    // separately in swSecretVault.test.ts).
    ArmadaDmCrypto: (options.dmCrypto || options.dmConfig)
      ? { ...(options.dmCrypto ?? {}), openConfig: async () => options.dmConfig ?? null }
      : undefined,
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
    Response,
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

  return { push, showNotification, setAppBadge };
}

describe("Web Push suppression", () => {
  it("suppresses an outgoing event marked by this device", async () => {
    const worker = loadWorker({ ownEventId: "own-wrap" });
    await worker.push({ scope: "dm", event_id: "own-wrap", url: "/dm" });
    expect(worker.showNotification).not.toHaveBeenCalled();
  });

  it.each(["group", "group-mention", "c2"])(
    "suppresses a locally-authored %s community event",
    async (scope) => {
      const worker = loadWorker({ ownEventId: "own-community-event" });
      await worker.push({ scope, event_id: "own-community-event", url: "/s/relay/community" });
      expect(worker.showNotification).not.toHaveBeenCalled();
    },
  );

  it("shows a silent placeholder instead of nothing on an Apple endpoint", async () => {
    // iOS revokes web push after a few pushes that display nothing, so a
    // suppressed push on an Apple endpoint must still show SOMETHING.
    const worker = loadWorker({
      ownEventId: "own-wrap",
      pushEndpoint: "https://web.push.apple.com/QKw71NdV3vO",
    });
    await worker.push({ scope: "dm", event_id: "own-wrap", url: "/dm" });
    expect(worker.showNotification).toHaveBeenCalledTimes(1);
    const [, opts] = worker.showNotification.mock.calls[0] as unknown as [
      string,
      { silent: boolean; renotify: boolean; tag: string },
    ];
    expect(opts.silent).toBe(true);
    expect(opts.renotify).toBe(false);
    expect(opts.tag).toBe("armada-quiet-sync");
  });

  it("keeps full suppression on non-Apple endpoints", async () => {
    const worker = loadWorker({
      ownEventId: "own-wrap",
      pushEndpoint: "https://fcm.googleapis.com/fcm/send/abc",
    });
    await worker.push({ scope: "dm", event_id: "own-wrap", url: "/dm" });
    expect(worker.showNotification).not.toHaveBeenCalled();
  });

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

  it.each(["group", "group-mention", "c2"])(
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

  it.each(["group", "group-mention", "c2"])(
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

  it("increments the Home-Screen badge after displaying a push", async () => {
    const worker = loadWorker({ badging: true });
    await worker.push({ scope: "dm", event_id: "incoming-wrap", url: "/dm" });
    expect(worker.setAppBadge).toHaveBeenCalledWith(1);
  });
});

describe("Web Push DM gating (inlined wrap)", () => {
  const wrapEvent = { pubkey: "wrapper", content: "ciphertext", tags: [] };
  const opened = (sender: string, over: Record<string, unknown> = {}) => ({
    unwrapDm: () => ({ sender, kind: 14, content: "meet at 8 by the pier", ...over }),
  });

  const dmPush = (config: Record<string, unknown>, crypto: { unwrapDm: (...a: unknown[]) => unknown }) =>
    loadWorker({ dmConfig: config, dmCrypto: crypto });

  it("shows decrypted content for a known sender", async () => {
    const worker = dmPush(
      { policy: "generic", self: "me", knownPeers: ["peer"], sk: "aa" },
      opened("peer"),
    );
    await worker.push({ scope: "dm", event_id: "w", url: "/dm", event: wrapEvent });
    expect(worker.showNotification).toHaveBeenCalledTimes(1);
    const [title, opts] = worker.showNotification.mock.calls[0] as unknown as [string, { body: string; data: { url: string } }];
    expect(title).toBe("New message");
    expect(opts.body).toContain("meet at 8");
    expect(opts.data.url).toBe("/dm/peer");
  });

  it("shows a content-blind request for an unknown sender under `generic`", async () => {
    const worker = dmPush(
      { policy: "generic", self: "me", knownPeers: [], sk: "aa" },
      opened("stranger", { content: "vile slur from a random" }),
    );
    await worker.push({ scope: "dm", event_id: "w", url: "/dm", event: wrapEvent });
    expect(worker.showNotification).toHaveBeenCalledTimes(1);
    const [title, opts] = worker.showNotification.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(title).toBe("Message request");
    // Nothing the sender controls (their text) reaches the notification.
    expect(JSON.stringify([title, opts])).not.toContain("slur");
  });

  it("still shows (quietly) for an unknown sender under `off`, to satisfy userVisibleOnly", async () => {
    const worker = dmPush(
      { policy: "off", self: "me", knownPeers: [], sk: "aa" },
      opened("stranger"),
    );
    await worker.push({ scope: "dm", event_id: "w", url: "/dm", event: wrapEvent });
    // Never zero notifications (iOS revokes the subscription otherwise) — but
    // silent, non-re-alerting, and content-blind.
    expect(worker.showNotification).toHaveBeenCalledTimes(1);
    const [title, opts] = worker.showNotification.mock.calls[0] as unknown as [string, { silent: boolean; renotify: boolean }];
    expect(title).toBe("Message requests");
    expect(opts.silent).toBe(true);
    expect(opts.renotify).toBe(false);
  });

  it("shows full content for an unknown sender under `full`", async () => {
    const worker = dmPush(
      { policy: "full", self: "me", knownPeers: [], sk: "aa" },
      opened("stranger"),
    );
    await worker.push({ scope: "dm", event_id: "w", url: "/dm", event: wrapEvent });
    const [title, opts] = worker.showNotification.mock.calls[0] as unknown as [string, { body: string }];
    expect(title).toBe("New message");
    expect(opts.body).toContain("meet at 8");
  });

  it("treats a non-message rumor (reaction/delete) as a quiet request", async () => {
    const worker = dmPush(
      { policy: "full", self: "me", knownPeers: ["peer"], sk: "aa" },
      { unwrapDm: () => ({ sender: "peer", kind: 7, content: "+" }) },
    );
    await worker.push({ scope: "dm", event_id: "w", url: "/dm", event: wrapEvent });
    expect((worker.showNotification.mock.calls[0] as unknown as [string])[0]).toBe("Message requests");
  });

  it("falls back to the generic wake-up for a login the worker has no key for", async () => {
    const unwrapDm = vi.fn(() => ({ sender: "peer", kind: 14, content: "x" }));
    const worker = loadWorker({
      dmConfig: { policy: "off", self: "me", knownPeers: [] }, // no sk (bunker/NIP-07)
      dmCrypto: { unwrapDm },
    });
    await worker.push({ scope: "dm", event_id: "w", url: "/dm", event: wrapEvent });
    expect(unwrapDm).not.toHaveBeenCalled(); // never decrypts without a key
    expect(worker.showNotification).toHaveBeenCalledTimes(1);
    const [, opts] = worker.showNotification.mock.calls[0] as unknown as [string, { body: string }];
    expect(opts.body).toBe("New direct message");
  });

  it("falls back to the generic wake-up when the wrap can't be opened", async () => {
    const worker = dmPush(
      { policy: "off", self: "me", knownPeers: [], sk: "aa" },
      { unwrapDm: () => null },
    );
    await worker.push({ scope: "dm", event_id: "w", url: "/dm", event: wrapEvent });
    const [, opts] = worker.showNotification.mock.calls[0] as unknown as [string, { body: string }];
    expect(opts.body).toBe("New direct message");
  });

  it("falls back to generic when no wrap was inlined (oversized / older server)", async () => {
    const worker = dmPush(
      { policy: "off", self: "me", knownPeers: [], sk: "aa" },
      opened("stranger"),
    );
    await worker.push({ scope: "dm", event_id: "w", url: "/dm" }); // no `event`
    const [, opts] = worker.showNotification.mock.calls[0] as unknown as [string, { body: string }];
    expect(opts.body).toBe("New direct message");
  });
});
