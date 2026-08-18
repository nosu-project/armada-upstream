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
  /**
   * The runtime bundle (`src/sw/pushRuntime.ts`), stubbed. What it decides —
   * opening the inlined event, the DM request policy, storing, composing the
   * title/body/icon — is tested against the real crypto and the real store in
   * `src/sw/pushRuntime.test.ts`. What these tests own is the worker's half:
   * whether it asks, and whether it presents the answer faithfully.
   */
  runtime?: { preparePush?: (...args: unknown[]) => unknown };
  pushConfig?: Record<string, unknown>;
  pushEndpoint?: string;
  pushDisabled?: boolean;
  priorNotifications?: Array<{ tag: string; data: Record<string, unknown>; close?: () => void }>;
  /**
   * The event a relay answers the worker's by-id REQ with (the fetch path for
   * pushes the gateway didn't inline). Its `id` must match the push's
   * `event_id` for the worker to accept it.
   */
  relayEvent?: Record<string, unknown>;
} = {}) {
  const handlers = new Map<string, (event: unknown) => unknown>();
  const showNotification = vi.fn(async () => undefined);
  const setAppBadge = vi.fn(async () => undefined);
  const unsubscribe = vi.fn(async () => true);
  const subscribe = vi.fn(async () => ({ endpoint: "https://push.example/new", unsubscribe }));
  // A real per-URL store: the badge counter, the silent-push budget and the
  // seen-event ledger all read back what they wrote, and the ledger enumerates.
  const store = new Map<string, unknown>();
  if (options.pushDisabled) {
    // The kill switch swPushDisabled.ts writes when the user turns push off.
    store.set(
      new URL("/.armada-push-state/disabled", "https://armada.buzz").href,
      new Response("1"),
    );
  }
  const cache = {
    match: vi.fn(async (request: string) => {
      if (options.ownEventId && request.includes(`/own/${options.ownEventId}`)) return {};
      if (options.pushConfig && request.endsWith("/.armada-push-state/dm-config")) {
        // The worker reads sealed bytes and opens them via the bundle's
        // openConfig (stubbed below); the bytes themselves are opaque here.
        return { arrayBuffer: async () => new ArrayBuffer(16) };
      }
      return store.get(request);
    }),
    put: vi.fn(async (request: string, response: Response) => { store.set(request, response); }),
    delete: vi.fn(async (request: string) => store.delete(request)),
    keys: vi.fn(async () => [...store.keys()].map((url) => ({ url }))),
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
      pushManager: {
        getSubscription: async () =>
          options.pushEndpoint ? { endpoint: options.pushEndpoint, unsubscribe } : null,
        subscribe,
      },
      ...(options.priorNotifications
        ? {
          getNotifications: async ({ tag }: { tag: string }) =>
            options.priorNotifications!.filter((n) => n.tag === tag),
        }
        : {}),
    },
    // The worker opens the sealed config via the bundle's openConfig; stub it
    // to hand back the injected config directly (the vault crypto is unit-tested
    // separately in swSecretVault.test.ts).
    ArmadaDmCrypto: (options.runtime || options.pushConfig)
      ? { ...(options.runtime ?? {}), openConfig: async () => options.pushConfig ?? null }
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

  // A relay socket that answers the worker's by-id REQ with `relayEvent` (if
  // any) followed by EOSE — the fetch path for pushes without an inlined event.
  class FakeWebSocket {
    url: string;
    onopen?: () => void;
    onmessage?: (msg: { data: string }) => void;
    onerror?: () => void;
    constructor(url: string) {
      this.url = url;
      setTimeout(() => this.onopen?.(), 0);
    }
    send(raw: string) {
      const frame = JSON.parse(raw) as [string, string];
      if (frame[0] !== "REQ") return;
      setTimeout(() => {
        if (options.relayEvent) {
          this.onmessage?.({ data: JSON.stringify(["EVENT", frame[1], options.relayEvent]) });
        }
        this.onmessage?.({ data: JSON.stringify(["EOSE", frame[1]]) });
      }, 0);
    }
    close() {}
  }

  runInNewContext(workerSource, {
    self,
    caches,
    URL,
    MessageChannel,
    Response,
    console,
    setTimeout,
    clearTimeout,
    WebSocket: FakeWebSocket,
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

  async function pushSubscriptionChange(newSubscription?: { unsubscribe: () => Promise<boolean> }) {
    let pending: Promise<unknown> | undefined;
    const event = {
      oldSubscription: { options: { applicationServerKey: new ArrayBuffer(8) } },
      newSubscription,
      waitUntil: (promise: Promise<unknown>) => { pending = promise; },
    };
    const handler = handlers.get("pushsubscriptionchange");
    expect(handler).toBeTypeOf("function");
    handler!(event);
    await pending;
  }

  return { push, pushSubscriptionChange, showNotification, setAppBadge, subscribe, unsubscribe };
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

  it("spends the Apple keep-alive periodically, not on every suppressed push", async () => {
    // iOS revokes web push after too many pushes that display nothing, but it
    // tolerates a few. Every message the user SENDS is a suppressed push (their
    // own NIP-17 self-copy comes back through the gateway), so a keep-alive per
    // suppression put a "Messages synced" banner on screen for each one.
    const worker = loadWorker({
      ownEventId: "own-wrap",
      pushEndpoint: "https://web.push.apple.com/QKw71NdV3vO",
    });
    await worker.push({ scope: "dm", event_id: "own-wrap", url: "/dm" });
    await worker.push({ scope: "dm", event_id: "own-wrap", url: "/dm" });
    expect(worker.showNotification).not.toHaveBeenCalled();

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

  it("never re-alerts for an event it has already presented", async () => {
    // A gateway restart replays stored relay matches as fresh pushes; without
    // an event ledger each replay re-alerts (`renotify: true`) for a message
    // the user has read, on whatever period the restart happens.
    const worker = loadWorker();
    await worker.push({ scope: "dm", event_id: "incoming-wrap", url: "/dm" });
    expect(worker.showNotification).toHaveBeenCalledTimes(1);
    await worker.push({ scope: "dm", event_id: "incoming-wrap", url: "/dm" });
    await worker.push({ scope: "dm", event_id: "incoming-wrap", url: "/dm" });
    expect(worker.showNotification).toHaveBeenCalledTimes(1);
  });

  it("replenishes the silent budget whenever it displays a notification", async () => {
    const worker = loadWorker({ pushEndpoint: "https://web.push.apple.com/QKw71NdV3vO" });
    await worker.push({ scope: "dm", event_id: "wrap", url: "/dm" }); // shown
    await worker.push({ scope: "dm", event_id: "wrap", url: "/dm" }); // replay
    await worker.push({ scope: "dm", event_id: "wrap", url: "/dm" }); // replay
    expect(worker.showNotification).toHaveBeenCalledTimes(1);

    await worker.push({ scope: "dm", event_id: "wrap", url: "/dm" }); // budget out
    expect(worker.showNotification).toHaveBeenCalledTimes(2);
    expect((worker.showNotification.mock.calls[1] as unknown as [string])[0]).toBe("Armada");
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

  it("goes silent past the per-room interruption ceiling for one tag", async () => {
    // A flood in one room reaches every device's push. Past the ceiling the
    // worker still SHOWS each (iOS counts a silent push; the tray still updates)
    // but stops making noise — the web mirror of the native ALERT_BURST_MAX.
    // Distinct event ids (so the seen-ledger doesn't dedup them) sharing one
    // collapse `tag` (so they draw on the same room budget).
    const worker = loadWorker();
    for (let i = 0; i < 7; i++) {
      await worker.push({ scope: "group", event_id: `flood-${i}`, tag: "room-x" });
    }
    expect(worker.showNotification).toHaveBeenCalledTimes(7);
    const opts = (i: number) =>
      (worker.showNotification.mock.calls[i] as unknown as [string, { silent?: boolean }])[1];
    // The first five alert; the sixth and seventh are silenced.
    expect(opts(0).silent ?? false).toBe(false);
    expect(opts(4).silent ?? false).toBe(false);
    expect(opts(5).silent).toBe(true);
    expect(opts(6).silent).toBe(true);
  });

  it("keeps a different room's budget independent", async () => {
    const worker = loadWorker();
    for (let i = 0; i < 6; i++) {
      await worker.push({ scope: "group", event_id: `a-${i}`, tag: "room-a" });
    }
    // A first message in another room still alerts, unaffected by room-a's flood.
    await worker.push({ scope: "group", event_id: "b-0", tag: "room-b" });
    const last = (worker.showNotification.mock.calls.at(-1) as unknown as [string, { silent?: boolean }])[1];
    expect(last.silent ?? false).toBe(false);
  });

  it("increments the Home-Screen badge after displaying a push", async () => {
    const worker = loadWorker({ badging: true });
    await worker.push({ scope: "dm", event_id: "incoming-wrap", url: "/dm" });
    expect(worker.setAppBadge).toHaveBeenCalledWith(1);
  });
});

describe("Web Push inline presentation", () => {
  const wrapEvent = { pubkey: "wrapper", content: "ciphertext", tags: [] };

  /** The bundle's answer for a fully-decoded room message. */
  const prepared = (over: Record<string, unknown> = {}) => ({
    tag: "c2:chan",
    url: "/c/comm/chan/m/abc",
    title: "Armada / #general",
    line: "alex: shipped it",
    icon: "https://cdn.example/community.png",
    badge: "/badge-96.png",
    timestamp: 1700000000000,
    accumulate: true,
    ...over,
  });

  const withRuntime = (
    result: unknown,
    extra: Parameters<typeof loadWorker>[0] = {},
  ) =>
    loadWorker({
      pushConfig: { policy: "generic", self: "me", knownPeers: [], sk: "aa" },
      runtime: { preparePush: async () => result },
      ...extra,
    });

  it("presents the bundle's answer instead of the gateway's static wake-up", async () => {
    const worker = withRuntime(prepared());
    await worker.push({ scope: "c2", event_id: "w", event: wrapEvent });
    expect(worker.showNotification).toHaveBeenCalledTimes(1);
    const [title, opts] = worker.showNotification.mock.calls[0] as unknown as [
      string,
      { body: string; icon: string; badge: string; tag: string; timestamp: number; data: { url: string } },
    ];
    // The payload's own title/body ("New message" / "New direct message") are
    // only the fallback — the real event wins.
    expect(title).toBe("Armada / #general");
    expect(opts.body).toBe("alex: shipped it");
    expect(opts.icon).toBe("https://cdn.example/community.png");
    expect(opts.badge).toBe("/badge-96.png");
    expect(opts.timestamp).toBe(1700000000000);
    expect(opts.data.url).toBe("/c/comm/chan/m/abc");
  });

  it("collapses per ROOM, not per subscription", async () => {
    // One `armada-groups` subscription covers every group, so tagging by
    // subscription_id piled every channel into a single notification.
    const worker = withRuntime(prepared());
    await worker.push({ scope: "c2", event_id: "w", subscription_id: "armada-c2-abc", event: wrapEvent });
    const [, opts] = worker.showNotification.mock.calls[0] as unknown as [string, { tag: string }];
    expect(opts.tag).toBe("c2:chan");
  });

  it("accumulates a conversation's recent lines like the MessagingStyle expansion", async () => {
    const worker = withRuntime(prepared(), {
      priorNotifications: [{ tag: "c2:chan", data: { lines: ["bob: you up?"] } }],
    });
    await worker.push({ scope: "c2", event_id: "w", event: wrapEvent });
    const [, opts] = worker.showNotification.mock.calls[0] as unknown as [
      string,
      { body: string; data: { lines: string[] } },
    ];
    expect(opts.body).toBe("bob: you up?\nalex: shipped it");
    expect(opts.data.lines).toEqual(["bob: you up?", "alex: shipped it"]);
  });

  it("never accumulates behind a content-blind request ping", async () => {
    // The whole point of the ping is that it reveals nothing the sender chose;
    // replaying the room's earlier lines beside it would undo that.
    const worker = withRuntime(
      prepared({ tag: "armada-dm-requests", accumulate: false, line: "You have a new message request" }),
      { priorNotifications: [{ tag: "armada-dm-requests", data: { lines: ["a stranger's text"] } }] },
    );
    await worker.push({ scope: "dm", event_id: "w", event: wrapEvent });
    const [, opts] = worker.showNotification.mock.calls[0] as unknown as [
      string,
      { body: string; data: { lines?: string[] } },
    ];
    expect(opts.body).toBe("You have a new message request");
    expect(opts.data.lines).toBeUndefined();
  });

  it("shows a `quiet` answer silently, but still shows it", async () => {
    // iOS revokes a subscription that displays nothing, so the quietest the
    // worker gets is silent + non-re-alerting, never absent.
    const worker = withRuntime(prepared({ quiet: true, accumulate: false }));
    await worker.push({ scope: "dm", event_id: "w", event: wrapEvent });
    expect(worker.showNotification).toHaveBeenCalledTimes(1);
    const [, opts] = worker.showNotification.mock.calls[0] as unknown as [
      string,
      { silent: boolean; renotify: boolean },
    ];
    expect(opts.silent).toBe(true);
    expect(opts.renotify).toBe(false);
  });

  it("never attaches the inlined event to the notification it shows", async () => {
    const worker = withRuntime(prepared());
    await worker.push({ scope: "c2", event_id: "w", event: wrapEvent });
    const [, opts] = worker.showNotification.mock.calls[0] as unknown as [
      string,
      { data: Record<string, unknown> },
    ];
    expect(opts.data.event).toBeUndefined();
  });

  it("shows nothing at all for a `drop`, rather than the static wake-up", async () => {
    // The fallback is itself a visible notification, so "I opened it and you
    // must not see this" has to be distinguishable from "I couldn't decide".
    const worker = withRuntime(prepared({ drop: true }), { badging: true });
    await worker.push({ scope: "c2", event_id: "w", event: wrapEvent });
    expect(worker.showNotification).not.toHaveBeenCalled();
    expect(worker.setAppBadge).not.toHaveBeenCalled();
  });

  it("still spends the Apple keep-alive on a dropped push", async () => {
    // A dropped push displayed nothing, which iOS counts toward revoking the
    // subscription — so it draws on the same budget as any other suppression.
    const worker = withRuntime(prepared({ drop: true }), {
      pushEndpoint: "https://web.push.apple.com/QKw71NdV3vO",
    });
    for (let i = 0; i < 3; i++) {
      await worker.push({ scope: "c2", event_id: `own-${i}`, event: wrapEvent });
    }
    expect(worker.showNotification).toHaveBeenCalledTimes(1);
    const [, opts] = worker.showNotification.mock.calls[0] as unknown as [string, { tag: string }];
    expect(opts.tag).toBe("armada-quiet-sync");
  });

  it("falls back to the static wake-up when the bundle can't open the event", async () => {
    const worker = withRuntime(undefined);
    await worker.push({ scope: "dm", event_id: "w", url: "/dm", event: wrapEvent });
    const [title, opts] = worker.showNotification.mock.calls[0] as unknown as [string, { body: string }];
    expect(title).toBe("New message");
    expect(opts.body).toBe("New direct message");
  });

  it("falls back when the bundle throws", async () => {
    const worker = loadWorker({
      pushConfig: { policy: "off", self: "me", knownPeers: [] },
      runtime: { preparePush: async () => { throw new Error("boom"); } },
    });
    await worker.push({ scope: "dm", event_id: "w", url: "/dm", event: wrapEvent });
    expect(worker.showNotification).toHaveBeenCalledTimes(1);
    const [, opts] = worker.showNotification.mock.calls[0] as unknown as [string, { body: string }];
    expect(opts.body).toBe("New direct message");
  });

  it("never asks the bundle when no event was inlined (oversized / older server)", async () => {
    const preparePush = vi.fn(async () => prepared());
    const worker = loadWorker({
      pushConfig: { policy: "off", self: "me", knownPeers: [], sk: "aa" },
      runtime: { preparePush },
    });
    await worker.push({ scope: "dm", event_id: "w", url: "/dm" }); // no `event`
    expect(preparePush).not.toHaveBeenCalled();
    const [, opts] = worker.showNotification.mock.calls[0] as unknown as [string, { body: string }];
    expect(opts.body).toBe("New direct message");
  });

  it("falls back to the static wake-up in a build with no bundle", async () => {
    const worker = loadWorker();
    await worker.push({ scope: "dm", event_id: "w", url: "/dm", event: wrapEvent });
    const [, opts] = worker.showNotification.mock.calls[0] as unknown as [string, { body: string }];
    expect(opts.body).toBe("New direct message");
  });

  it("silences an inline notification past the room's alert ceiling", async () => {
    const worker = withRuntime(prepared());
    for (let i = 0; i < 6; i++) {
      await worker.push({ scope: "c2", event_id: `flood-${i}`, tag: "room-x", event: wrapEvent });
    }
    const last = (worker.showNotification.mock.calls.at(-1) as unknown as [string, { silent?: boolean }])[1];
    expect(last.silent).toBe(true);
  });
});

describe("Web Push kill switch", () => {
  // The disable path's unsubscribe and gateway deletes are best-effort over
  // the network. The flag is the local truth: while it is set the worker
  // shows NOTHING (yes, breaking userVisibleOnly — revocation is the goal)
  // and tears its own subscription down, so a gateway that never saw the
  // delete stops reaching the device at the source.
  it("shows nothing and tears down the subscription while disabled", async () => {
    const worker = loadWorker({
      pushDisabled: true,
      pushEndpoint: "https://web.push.apple.com/QKw71NdV3vO",
    });
    await worker.push({ scope: "dm", event_id: "incoming-wrap", url: "/dm" });
    expect(worker.showNotification).not.toHaveBeenCalled();
    expect(worker.unsubscribe).toHaveBeenCalled();
  });

  it("retries the teardown on every stray push", async () => {
    const worker = loadWorker({
      pushDisabled: true,
      pushEndpoint: "https://web.push.apple.com/QKw71NdV3vO",
    });
    await worker.push({ scope: "group", event_id: "a" });
    await worker.push({ scope: "group", event_id: "b" });
    expect(worker.unsubscribe).toHaveBeenCalledTimes(2);
    expect(worker.showNotification).not.toHaveBeenCalled();
  });

  it("does not auto-resubscribe on pushsubscriptionchange while disabled", async () => {
    const worker = loadWorker({ pushDisabled: true });
    await worker.pushSubscriptionChange();
    expect(worker.subscribe).not.toHaveBeenCalled();
  });

  it("unsubscribes a browser-minted replacement subscription while disabled", async () => {
    const replacement = { unsubscribe: vi.fn(async () => true) };
    const worker = loadWorker({ pushDisabled: true });
    await worker.pushSubscriptionChange(replacement);
    expect(replacement.unsubscribe).toHaveBeenCalled();
    expect(worker.subscribe).not.toHaveBeenCalled();
  });

  it("still auto-resubscribes on rotation when push is enabled", async () => {
    const worker = loadWorker();
    await worker.pushSubscriptionChange();
    expect(worker.subscribe).toHaveBeenCalled();
  });
});

describe("Fetched (non-inlined) encrypted pushes", () => {
  // The gateway inlines the matched event best-effort; past its payload budget
  // the static wake-up arrives with only an `event_id`. The worker then shows
  // the wake-up immediately (userVisibleOnly) and fetches the event by id to
  // finish the job late, through the same preparePush the inline path uses.
  const prepared = {
    tag: "dm-alice",
    url: "/dm/alice",
    title: "Alice",
    line: "hi there",
    icon: "/favicon.png",
    badge: "/badge-96.png",
    timestamp: 1_000_000,
    accumulate: true,
  };

  it("fetches the wrap, decrypts it, and replaces the static wake-up", async () => {
    const preparePush = vi.fn(async () => prepared);
    const staticEntry = { tag: "sub-1", data: {}, close: vi.fn() };
    const worker = loadWorker({
      runtime: { preparePush },
      pushConfig: { self: "me" },
      relayEvent: { id: "wrap-1", kind: 1059, tags: [], content: "x" },
      priorNotifications: [staticEntry],
    });

    await worker.push({
      scope: "dm",
      tag: "sub-1",
      event_id: "wrap-1",
      relays: ["wss://relay.example"],
      url: "/dm",
    });

    // Static wake-up first, then the decrypted replacement under its room tag.
    expect(worker.showNotification).toHaveBeenCalledTimes(2);
    const [title, opts] = worker.showNotification.mock.calls[1] as unknown as [
      string,
      { tag: string; body: string },
    ];
    expect(title).toBe("Alice");
    expect(opts.tag).toBe("dm-alice");
    // preparePush received the fetched event as if the gateway had inlined it.
    const [dataArg] = preparePush.mock.calls[0] as unknown as [{ event?: { id?: string } }];
    expect(dataArg.event?.id).toBe("wrap-1");
    // The wake-up's subscription-tag entry was withdrawn.
    expect(staticEntry.close).toHaveBeenCalled();
  });

  it("withdraws the static wake-up when the fetched wrap is the user's own", async () => {
    const staticEntry = { tag: "sub-1", data: {}, close: vi.fn() };
    const worker = loadWorker({
      runtime: { preparePush: vi.fn(async () => ({ ...prepared, drop: true })) },
      pushConfig: { self: "me" },
      relayEvent: { id: "wrap-own", kind: 1059, tags: [], content: "x" },
      priorNotifications: [staticEntry],
      // Apple endpoint: the drop must NOT spend a "Messages synced" keep-alive
      // — the static wake-up already satisfied userVisibleOnly for this push.
      pushEndpoint: "https://web.push.apple.com/QKw71NdV3vO",
    });

    await worker.push({
      scope: "dm",
      tag: "sub-1",
      event_id: "wrap-own",
      relays: ["wss://relay.example"],
      url: "/dm",
    });

    // Only the static wake-up was shown, and it was withdrawn afterwards.
    expect(worker.showNotification).toHaveBeenCalledTimes(1);
    expect(staticEntry.close).toHaveBeenCalled();
  });

  it("leaves the static wake-up when the wrap cannot be opened", async () => {
    const staticEntry = { tag: "sub-1", data: {}, close: vi.fn() };
    const worker = loadWorker({
      // No decrypt key for this login: preparePush declines.
      runtime: { preparePush: vi.fn(async () => undefined) },
      pushConfig: { self: "me" },
      relayEvent: { id: "wrap-2", kind: 1059, tags: [], content: "x" },
      priorNotifications: [staticEntry],
    });

    await worker.push({
      scope: "dm",
      tag: "sub-1",
      event_id: "wrap-2",
      relays: ["wss://relay.example"],
      url: "/dm",
    });

    expect(worker.showNotification).toHaveBeenCalledTimes(1);
    expect(staticEntry.close).not.toHaveBeenCalled();
  });
});
