// @vitest-environment node

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  desktopSafeNotificationIcon,
  foregroundPushRoomKey,
  pageMayShowOsNotification,
  retireSeenRoomLines,
  showPageOsNotification,
} from "@/hooks/useForegroundNotifications";

const workerSource = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");

afterEach(() => vi.unstubAllGlobals());

interface WindowClientStub {
  url: string;
  visibilityState: string;
  focused: boolean;
  /** Exact opened event/room this page has already handled. */
  handledEventId?: string;
  handledRoomKey?: string;
  pushOutcome?: "presenting" | "presented" | "suppressed";
  navigateRejects?: boolean;
  navigateWait?: Promise<void>;
  /** Legacy capability claim: deliberately ignored by the current worker. */
  ownsNotifications?: boolean;
  postMessage?(message: unknown, transfer: Transferable[]): void;
}

interface PushEventStub {
  data?: { json(): unknown; text(): string };
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
  /** Fail the first N show calls, for commit-after-success coverage. */
  showNotificationFailures?: number;
  /** Hold presentation open, for concurrent PushEvent coverage. */
  showNotificationWait?: Promise<void>;
} = {}) {
  const handlers = new Map<string, (event: unknown) => unknown>();
  let showFailures = options.showNotificationFailures ?? 0;
  const showNotification = vi.fn(async (
    _title: string,
    _options: Record<string, unknown>,
  ) => {
    if (options.showNotificationWait) await options.showNotificationWait;
    if (showFailures > 0) {
      showFailures -= 1;
      throw new Error("show failed");
    }
  });
  const setAppBadge = vi.fn(async () => undefined);
  const unsubscribe = vi.fn(async () => true);
  const subscribe = vi.fn(async () => ({ endpoint: "https://push.example/new", unsubscribe }));
  // A real per-URL store: badge/rate state and the seen-event ledger all read
  // back what they wrote, and the ledger enumerates.
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
      const stored = store.get(request);
      return stored instanceof Response ? stored.clone() : stored;
    }),
    put: vi.fn(async (request: string, response: Response) => { store.set(request, response); }),
    delete: vi.fn(async (request: string) => store.delete(request)),
    keys: vi.fn(async () => [...store.keys()].map((url) => ({ url }))),
  };
  const clients = (options.clients ?? []).map((client) => {
    const stub = {
      ...client,
      navigate: vi.fn(async (_target: string) => {
        if (client.navigateWait) await client.navigateWait;
        if (client.navigateRejects) throw new Error("discarded client");
        return stub;
      }),
      focus: vi.fn(async () => stub),
      postMessage: client.postMessage ?? vi.fn((message: unknown, transfer: Transferable[]) => {
        const port = transfer[0] as MessagePort | undefined;
        const query = message as { type?: string; eventId?: string; roomKey?: string };
        if (
          query.type !== "armada-push-presentation-query"
          && query.type !== "armada-push-worker-claim"
        ) {
          // A legacy capability response must not suppress anything.
          port?.postMessage({ owns: client.ownsNotifications === true });
          return;
        }
        const exact = query.eventId === client.handledEventId
          && (!query.roomKey || query.roomKey === client.handledRoomKey);
        port?.postMessage({
          eventId: query.eventId,
          roomKey: exact ? client.handledRoomKey : query.roomKey,
          outcome: exact
            ? (client.pushOutcome ?? "suppressed")
            : query.type === "armada-push-worker-claim" ? "worker" : "unhandled",
        });
      }),
    };
    return stub;
  });
  const openWindow = vi.fn(async (_target: string) => undefined);
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
      openWindow,
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

  async function push(data?: Record<string, unknown>): Promise<void> {
    let pending: Promise<unknown> | undefined;
    const event: PushEventStub = {
      ...(data
        ? {
          data: {
            json: () => ({ title: "New message", body: "New direct message", data }),
            text: () => "",
          },
        }
        : {}),
      waitUntil: (promise) => { pending = promise; },
    };
    const handler = handlers.get("push") as ((event: PushEventStub) => void) | undefined;
    expect(handler).toBeTypeOf("function");
    handler!(event);
    await pending;
  }

  async function notificationClick(url?: string): Promise<void> {
    let pending: Promise<unknown> | undefined;
    const event = {
      notification: { data: { url }, close: vi.fn() },
      waitUntil: (promise: Promise<unknown>) => { pending = promise; },
    };
    const handler = handlers.get("notificationclick");
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

  return {
    push,
    notificationClick,
    pushSubscriptionChange,
    showNotification,
    setAppBadge,
    subscribe,
    unsubscribe,
    clients,
    openWindow,
  };
}

describe("page / service-worker presentation ownership", () => {
  it("resolves relay-scoped NIP-29 identity before an early self/mute suppression", () => {
    const candidate = { plane: "nip29" as const, roomKey: "", groupId: "general" };
    expect(foregroundPushRoomKey(
      candidate,
      new Map([["general", "wss://relay.example"]]),
    )).toBe("h:wss://relay.example|general");
    // Without authoritative relay identity the page must fail open to worker
    // presentation rather than acknowledge a same-id group on the wrong relay.
    expect(foregroundPushRoomKey(candidate, new Map())).toBe("");
  });

  it("prefers ingest's exact NIP-29 source over a colliding bare group map", () => {
    const candidate = {
      plane: "nip29" as const,
      roomKey: "",
      relayUrl: "wss://source.example",
      groupId: "general",
    };
    expect(foregroundPushRoomKey(
      candidate,
      new Map([["general", "wss://wrong.example"]]),
    )).toBe("h:wss://source.example|general");
  });

  it("does not let the page construct an OS notification while Web Push is active", async () => {
    const getSubscription = vi.fn(async () => ({ endpoint: "https://web.push.apple.com/x" }));
    vi.stubGlobal("navigator", {
      serviceWorker: {
        getRegistration: vi.fn(async () => ({ pushManager: { getSubscription } })),
      },
    });

    expect(await pageMayShowOsNotification()).toBe(false);
    expect(getSubscription).toHaveBeenCalledTimes(1);
  });

  it("fails closed when page ownership cannot be proven", async () => {
    vi.stubGlobal("navigator", {
      serviceWorker: { getRegistration: vi.fn(async () => { throw new Error("unavailable"); }) },
    });
    expect(await pageMayShowOsNotification()).toBe(false);
  });

  it("retires a room's accumulated lines once it is read, but keeps unread ones", () => {
    const roomLines = new Map<string, string[]>([
      ["read-room", ["msg1", "msg2"]],
      ["unread-room", ["msg1"]],
      ["no-readkey-room", ["msg1"]],
    ]);
    const roomReadKeys = new Map<string, string>([
      ["read-room", "rk:read"],
      ["unread-room", "rk:unread"],
      // no-readkey-room deliberately absent
    ]);
    const lastNotified = new Map<string, number>([
      ["read-room", 100],
      ["unread-room", 100],
      ["no-readkey-room", 100],
    ]);
    const alertTimes = new Map<string, number[]>([["read-room", [1, 2, 3]]]);

    retireSeenRoomLines(roomLines, roomReadKeys, lastNotified, alertTimes, {
      "rk:read": 100, // read up to the newest notified message → clear
      "rk:unread": 50, // behind the newest → keep
    });

    expect(roomLines.has("read-room")).toBe(false);
    expect(alertTimes.has("read-room")).toBe(false);
    expect(roomLines.get("unread-room")).toEqual(["msg1"]);
    // Without a read key there is no "seen" signal, so the body is retained.
    expect(roomLines.get("no-readkey-room")).toEqual(["msg1"]);
  });

  it("leaves a GIF avatar untouched off desktop", async () => {
    // Browsers render an animated GIF notification icon fine; only the desktop
    // shell's libnotify blanks it, so the flatten is desktop-only.
    const gif = "https://host.example/a.gif";
    expect(await desktopSafeNotificationIcon(gif)).toBe(gif);
  });

  it("passes a non-GIF icon straight through on desktop", async () => {
    vi.stubGlobal("window", { armadaDesktop: { isDesktop: true } });
    const png = "https://host.example/a.png";
    expect(await desktopSafeNotificationIcon(png)).toBe(png);
    expect(await desktopSafeNotificationIcon("/favicon.png")).toBe("/favicon.png");
  });

  it("drops a GIF on desktop when the host refuses a CORS-clean read", async () => {
    vi.stubGlobal("window", { armadaDesktop: { isDesktop: true } });
    // Stand in for an <img> whose cross-origin load fails: the rasterize
    // resolves undefined and the presenter falls back to the app mark.
    class FakeImage {
      crossOrigin = "";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_v: string) { queueMicrotask(() => this.onerror?.()); }
    }
    vi.stubGlobal("Image", FakeImage);
    expect(await desktopSafeNotificationIcon("https://host.example/a.gif")).toBeUndefined();
  });

  it("lets the page own presentation on desktop even when the SW lookup throws", async () => {
    // Electron serves from app://armada, where getRegistration() throws a
    // SecurityError. Desktop has no Web Push worker to defer to, so the page
    // always owns presentation rather than failing closed and suppressing every
    // unfocused notification.
    const getRegistration = vi.fn(async () => {
      throw new Error("The URL protocol of the current origin ('app://armada') is not supported.");
    });
    vi.stubGlobal("navigator", { serviceWorker: { getRegistration } });
    vi.stubGlobal("window", { armadaDesktop: { isDesktop: true } });
    expect(await pageMayShowOsNotification()).toBe(true);
    expect(getRegistration).not.toHaveBeenCalled();
  });

  it("uses registration presentation when the mobile page constructor is illegal", async () => {
    const showNotification = vi.fn(async () => undefined);
    const registration = {
      pushManager: { getSubscription: vi.fn(async () => null) },
      showNotification,
    };
    vi.stubGlobal("navigator", {
      serviceWorker: {
        getRegistration: vi.fn(async () => registration),
        ready: Promise.resolve(registration),
      },
    });
    const pageConstructor = vi.fn(() => { throw new TypeError("Illegal constructor"); });
    vi.stubGlobal("Notification", pageConstructor);

    await expect(showPageOsNotification("Alice", {
      body: "hello",
      data: { url: "/dm/alice" },
    })).resolves.toBeUndefined();
    expect(showNotification).toHaveBeenCalledWith("Alice", {
      body: "hello",
      data: { url: "/dm/alice" },
    });
    expect(pageConstructor).not.toHaveBeenCalled();
  });

  it("uses the page constructor on desktop even though a service worker is registered", async () => {
    const showNotification = vi.fn(async () => undefined);
    const registration = {
      pushManager: { getSubscription: vi.fn(async () => null) },
      showNotification,
    };
    vi.stubGlobal("navigator", {
      serviceWorker: {
        getRegistration: vi.fn(async () => registration),
        ready: Promise.resolve(registration),
      },
    });
    vi.stubGlobal("window", { armadaDesktop: { isDesktop: true } });
    const pageConstructor = vi.fn(function () { return {}; });
    vi.stubGlobal("Notification", pageConstructor);

    await showPageOsNotification("Alice", { body: "hello" });
    // Electron never surfaces registration.showNotification(); the OS banner
    // only appears through the renderer's Notification constructor.
    expect(showNotification).not.toHaveBeenCalled();
    expect(pageConstructor).toHaveBeenCalledWith("Alice", { body: "hello" });
  });

  it("re-checks ownership at presentation and never races an active PushEvent", async () => {
    const showNotification = vi.fn(async () => undefined);
    const registration = {
      pushManager: { getSubscription: vi.fn(async () => ({ endpoint: "https://push.apple.com/x" })) },
      showNotification,
    };
    vi.stubGlobal("navigator", {
      serviceWorker: {
        getRegistration: vi.fn(async () => registration),
        ready: Promise.resolve(registration),
      },
    });
    const pageConstructor = vi.fn();
    vi.stubGlobal("Notification", pageConstructor);

    expect(await showPageOsNotification("must not duplicate", { body: "secret" })).toBeNull();
    expect(showNotification).not.toHaveBeenCalled();
    expect(pageConstructor).not.toHaveBeenCalled();
  });

  it("lets a visible exact-event page cover a missing gateway PushEvent", async () => {
    const showNotification = vi.fn(async () => undefined);
    const registration = {
      pushManager: { getSubscription: vi.fn(async () => ({ endpoint: "https://push.apple.com/x" })) },
      showNotification,
    };
    vi.stubGlobal("navigator", {
      serviceWorker: {
        getRegistration: vi.fn(async () => registration),
        ready: Promise.resolve(registration),
      },
    });

    await expect(showPageOsNotification("Live message", {
      body: "arrived over the wire",
      tag: "c2:room",
    }, { allowActivePush: true })).resolves.toBeUndefined();
    expect(showNotification).toHaveBeenCalledTimes(1);
  });

  it("aborts late page work after the worker claims the exact event", async () => {
    const showNotification = vi.fn(async () => undefined);
    const registration = {
      pushManager: { getSubscription: vi.fn(async () => ({ endpoint: "https://push.apple.com/x" })) },
      showNotification,
    };
    vi.stubGlobal("navigator", {
      serviceWorker: {
        getRegistration: vi.fn(async () => registration),
        ready: Promise.resolve(registration),
      },
    });

    expect(await showPageOsNotification("Late page", { tag: "c2:room" }, {
      allowActivePush: true,
      shouldAbort: () => true,
    })).toBeNull();
    expect(showNotification).not.toHaveBeenCalled();
  });
});

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

  it("shows one quiet collapsed entry for every Apple PushEvent", async () => {
    const worker = loadWorker({
      ownEventId: "own-wrap",
      pushEndpoint: "https://web.push.apple.com/QKw71NdV3vO",
    });
    await worker.push({ scope: "dm", event_id: "own-wrap", url: "/dm" });
    await worker.push({ scope: "dm", event_id: "own-wrap", url: "/dm" });
    await worker.push({ scope: "dm", event_id: "own-wrap", url: "/dm" });
    expect(worker.showNotification).toHaveBeenCalledTimes(3);
    for (const [title, opts] of worker.showNotification.mock.calls as unknown as Array<[
      string,
      { body: string; silent: boolean; renotify: boolean; tag: string },
    ]>) {
      expect(title).toBe("Armada");
      expect(opts.body).toBe("Messages synced");
      expect(opts.silent).toBe(true);
      expect(opts.renotify).toBe(false);
      expect(opts.tag).toBe("armada-quiet-sync");
    }
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

  it("does not dedupe one NIP-29 event across two relay-scoped rooms", async () => {
    const worker = loadWorker({
      pushConfig: { policy: "generic", self: "me", knownPeers: [], sk: "aa" },
      runtime: {
        preparePush: async (data: unknown) => {
          const relay = (data as { relays: string[] }).relays[0];
          const roomKey = `h:${relay}|general`;
          return {
            tag: roomKey,
            roomKey,
            eventId: "same-event",
            url: "/",
            title: "Armada / #general",
            line: "author: hello",
            icon: "",
            badge: "",
            timestamp: 0,
            accumulate: true,
          };
        },
      },
    });
    const event = { id: "same-event", pubkey: "author", content: "hello", tags: [["h", "general"]] };
    await worker.push({
      scope: "group",
      event_id: "same-event",
      relays: ["wss://relay-a.example"],
      event,
    });
    await worker.push({
      scope: "group",
      event_id: "same-event",
      relays: ["wss://relay-b.example"],
      event,
    });

    expect(worker.showNotification).toHaveBeenCalledTimes(2);
    const tags = worker.showNotification.mock.calls.map(([, options]) =>
      (options as { tag: string }).tag);
    expect(new Set(tags)).toHaveLength(2);
  });

  it("turns every Apple replay into a quiet visible update", async () => {
    const worker = loadWorker({ pushEndpoint: "https://web.push.apple.com/QKw71NdV3vO" });
    await worker.push({ scope: "dm", event_id: "wrap", url: "/dm" }); // shown
    await worker.push({ scope: "dm", event_id: "wrap", url: "/dm" }); // replay
    await worker.push({ scope: "dm", event_id: "wrap", url: "/dm" }); // replay
    expect(worker.showNotification).toHaveBeenCalledTimes(3);
    for (const call of worker.showNotification.mock.calls.slice(1)) {
      const [title, opts] = call as unknown as [string, { body: string; silent: boolean }];
      expect(title).toBe("Armada");
      expect(opts.body).toBe("Messages synced");
      expect(opts.silent).toBe(true);
    }
  });

  it("keeps full suppression on non-Apple endpoints", async () => {
    const worker = loadWorker({
      ownEventId: "own-wrap",
      pushEndpoint: "https://fcm.googleapis.com/fcm/send/abc",
    });
    await worker.push({ scope: "dm", event_id: "own-wrap", url: "/dm" });
    expect(worker.showNotification).not.toHaveBeenCalled();
  });

  it("does not suppress an unresolved push from a stale client URL", async () => {
    const worker = loadWorker({
      clients: [{
        url: "https://armada.buzz/dm/npub1peer",
        visibilityState: "visible",
        focused: true,
      }],
    });
    await worker.push({ scope: "dm", event_id: "incoming-wrap", url: "/dm" });
    expect(worker.showNotification).toHaveBeenCalledTimes(1);
  });

  it("does not accept the removed capability-only page handoff", async () => {
    const worker = loadWorker({
      clients: [{
        url: "https://armada.buzz/c/community/channel",
        visibilityState: "visible",
        focused: true,
        ownsNotifications: true,
      }],
    });
    await worker.push({ scope: "c2", event_id: "incoming-community-event" });
    expect(worker.showNotification).toHaveBeenCalledTimes(1);
  });

  it.each(["group", "group-mention", "c2"])(
    "keeps the service-worker %s fallback when the event cannot be resolved",
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

  it("still shows a visible fallback when PushEvent.data is absent", async () => {
    const worker = loadWorker({ pushEndpoint: "https://web.push.apple.com/QKw71NdV3vO" });
    await worker.push();
    expect(worker.showNotification).toHaveBeenCalledTimes(1);
    const [title, opts] = worker.showNotification.mock.calls[0] as unknown as [
      string,
      { body: string },
    ];
    expect(title).toBe("Armada");
    expect(opts.body).toBe("Messages synced");
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

  it("commits the seen ledger only after presentation succeeds", async () => {
    const worker = loadWorker({ showNotificationFailures: 1 });
    const data = { scope: "dm", event_id: "retry-wrap", url: "/dm" };
    await expect(worker.push(data)).rejects.toThrow("show failed");

    // The failed first attempt was not marked seen, so the replay retries the
    // actual message instead of being swallowed as a duplicate.
    await worker.push(data);
    expect(worker.showNotification).toHaveBeenCalledTimes(2);
    expect(worker.showNotification.mock.calls[1]?.[0]).toBe("New message");
  });

  it("atomically claims concurrent deliveries of the same event", async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const worker = loadWorker({ showNotificationWait: wait });
    const data = { scope: "dm", event_id: "concurrent-wrap", url: "/dm" };

    const first = worker.push(data);
    const duplicate = worker.push(data);
    await vi.waitFor(() => expect(worker.showNotification).toHaveBeenCalledTimes(1));
    release();
    await Promise.all([first, duplicate]);

    // The duplicate waits on the in-flight claim and never creates a second
    // message alert on non-Apple push services.
    expect(worker.showNotification).toHaveBeenCalledTimes(1);
  });
});

describe("Web Push inline presentation", () => {
  const wrapEvent = { pubkey: "wrapper", content: "ciphertext", tags: [] };

  /** The bundle's answer for a fully-decoded room message. */
  const prepared = (over: Record<string, unknown> = {}) => ({
    tag: "c2:chan",
    roomKey: "c2:chan",
    eventId: "w",
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

  it("suppresses only after a page acknowledges the exact opened event and room", async () => {
    const worker = withRuntime(prepared(), {
      clients: [{
        url: "https://armada.buzz/c/comm/chan",
        visibilityState: "visible",
        focused: true,
        handledEventId: "w",
        handledRoomKey: "c2:chan",
      }],
    });
    await worker.push({ scope: "c2", event_id: "w", event: wrapEvent });
    expect(worker.showNotification).not.toHaveBeenCalled();
  });

  it("arbitrates an exact NIP-29 event when only the page resolved its relay-scoped room", async () => {
    const worker = withRuntime(prepared({
      tag: "h:general",
      roomKey: undefined,
      eventId: "nip29-event",
    }), {
      clients: [{
        url: "https://armada.buzz/s/relay/general",
        visibilityState: "visible",
        focused: true,
        handledEventId: "nip29-event",
        handledRoomKey: "h:wss://relay.example|general",
      }],
    });

    await worker.push({ scope: "group", event_id: "nip29-event", event: wrapEvent });
    expect(worker.showNotification).not.toHaveBeenCalled();
    const query = (worker.clients[0]?.postMessage as ReturnType<typeof vi.fn>)
      .mock.calls[0]?.[0] as { eventId?: string; roomKey?: string };
    expect(query).toMatchObject({ eventId: "nip29-event", roomKey: undefined });
  });

  it("uses the page-returned NIP-29 room tag for Apple's required quiet update", async () => {
    const pageRoom = "h:wss://relay.example|general";
    const worker = withRuntime(prepared({
      tag: "h:general",
      roomKey: undefined,
      eventId: "nip29-event",
    }), {
      pushEndpoint: "https://web.push.apple.com/device",
      clients: [{
        url: "https://armada.buzz/s/relay/general",
        visibilityState: "visible",
        focused: true,
        handledEventId: "nip29-event",
        handledRoomKey: pageRoom,
        pushOutcome: "presented",
      }],
    });

    await worker.push({ scope: "group", event_id: "nip29-event", event: wrapEvent });
    expect(worker.showNotification).toHaveBeenCalledTimes(1);
    expect(worker.showNotification.mock.calls[0]?.[1]).toMatchObject({
      tag: pageRoom,
      silent: true,
    });
  });

  it("claims the exact event before worker presentation so late page work aborts", async () => {
    const worker = withRuntime(prepared(), {
      clients: [{
        url: "https://armada.buzz/c/comm/chan",
        visibilityState: "visible",
        focused: true,
      }],
    });
    await worker.push({ scope: "c2", event_id: "w", event: wrapEvent });

    const messages = (worker.clients[0]?.postMessage as ReturnType<typeof vi.fn>).mock.calls
      .map(([message]) => message as { type?: string });
    expect(messages.map((message) => message.type)).toContain("armada-push-worker-claim");
    expect(worker.showNotification).toHaveBeenCalledTimes(1);
    const [, opts] = worker.showNotification.mock.calls[0] as unknown as [
      string,
      { tag: string },
    ];
    expect(opts.tag).toBe("c2:chan");
  });

  it("does not suppress when either exact acknowledgement coordinate differs", async () => {
    const worker = withRuntime(prepared(), {
      clients: [{
        url: "https://armada.buzz/c/comm/other",
        visibilityState: "visible",
        focused: true,
        handledEventId: "some-other-event",
        handledRoomKey: "c2:some-other-room",
      }],
    });
    await worker.push({ scope: "c2", event_id: "w", event: wrapEvent });
    expect(worker.showNotification).toHaveBeenCalledTimes(1);
    expect(worker.showNotification.mock.calls[0]?.[0]).toBe("Armada / #general");
  });

  it("uses one non-leaking Apple fallback after exact active-room suppression", async () => {
    const worker = withRuntime(prepared(), {
      pushEndpoint: "https://web.push.apple.com/QKw71NdV3vO",
      clients: [{
        url: "https://armada.buzz/c/comm/chan",
        visibilityState: "visible",
        focused: true,
        handledEventId: "w",
        handledRoomKey: "c2:chan",
      }],
    });
    await worker.push({
      scope: "c2",
      event_id: "w",
      event: wrapEvent,
      url: "/c/private/message",
      title: "secret sender",
    });

    // The page contract above forbids `new Notification` with a subscription;
    // the worker therefore remains the only OS presenter for this event.
    expect(worker.showNotification).toHaveBeenCalledTimes(1);
    const [title, opts] = worker.showNotification.mock.calls[0] as unknown as [
      string,
      {
        body: string;
        icon: string;
        badge: string;
        data: { url: string };
        tag: string;
        silent: boolean;
        renotify: boolean;
      },
    ];
    expect(title).toBe("Armada");
    expect(opts).toMatchObject({
      body: "Messages synced",
      icon: "/favicon.png",
      badge: "/badge-96.png",
      data: { url: "/" },
      tag: "armada-quiet-sync",
      silent: true,
      renotify: false,
    });
    expect(JSON.stringify([title, opts])).not.toContain("secret sender");
    expect(JSON.stringify([title, opts])).not.toContain("alex: shipped it");
    expect(JSON.stringify([title, opts])).not.toContain("/c/private/message");
  });

  it("silently updates the same real Apple notification after the page presented", async () => {
    const worker = withRuntime(prepared(), {
      pushEndpoint: "https://web.push.apple.com/QKw71NdV3vO",
      priorNotifications: [{
        tag: "c2:chan",
        data: { lines: ["alex: shipped it"] },
      }],
      clients: [{
        url: "https://armada.buzz/c/comm/chan",
        visibilityState: "visible",
        focused: true,
        handledEventId: "w",
        handledRoomKey: "c2:chan",
        pushOutcome: "presented",
      }],
    });

    await worker.push({ scope: "c2", event_id: "w", event: wrapEvent });
    await worker.push({ scope: "c2", event_id: "w", event: wrapEvent }); // replay

    expect(worker.showNotification).toHaveBeenCalledTimes(2);
    for (const [title, opts] of worker.showNotification.mock.calls as unknown as Array<[
      string,
      { body: string; tag: string; silent: boolean; renotify: boolean },
    ]>) {
      expect(title).toBe("Armada / #general");
      expect(opts.body).toBe("alex: shipped it");
      expect(opts.tag).toBe("c2:chan");
      expect(opts.silent).toBe(true);
      expect(opts.renotify).toBe(false);
    }
  });

  it("does not add a worker notification after a non-Apple page presentation", async () => {
    const worker = withRuntime(prepared(), {
      pushEndpoint: "https://fcm.googleapis.com/fcm/send/abc",
      clients: [{
        url: "https://armada.buzz/c/comm/chan",
        visibilityState: "visible",
        focused: true,
        handledEventId: "w",
        handledRoomKey: "c2:chan",
        pushOutcome: "presented",
      }],
    });
    await worker.push({ scope: "c2", event_id: "w", event: wrapEvent });
    expect(worker.showNotification).not.toHaveBeenCalled();
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

  it("shows a quiet Apple fallback for every dropped push", async () => {
    const worker = withRuntime(prepared({ drop: true }), {
      pushEndpoint: "https://web.push.apple.com/QKw71NdV3vO",
    });
    for (let i = 0; i < 3; i++) {
      await worker.push({ scope: "c2", event_id: `own-${i}`, event: wrapEvent });
    }
    expect(worker.showNotification).toHaveBeenCalledTimes(3);
    for (const [, opts] of worker.showNotification.mock.calls as unknown as Array<[
      string,
      { tag: string; silent: boolean },
    ]>) {
      expect(opts.tag).toBe("armada-quiet-sync");
      expect(opts.silent).toBe(true);
    }
  });

  it("uses explicit plane readiness before decrypt and returns Apple's quiet-sync", async () => {
    const preparePush = vi.fn(async (_data: unknown, config: unknown) => {
      expect(config).toMatchObject({ dmReady: true, concordReady: false });
      return prepared({ drop: true });
    });
    const worker = loadWorker({
      pushConfig: {
        policy: "generic",
        self: "me",
        knownPeers: [],
        dmReady: true,
        concordReady: false,
      },
      runtime: { preparePush },
      pushEndpoint: "https://web.push.apple.com/QKw71NdV3vO",
    });

    await worker.push({ scope: "c2", event_id: "unready-c2", event: wrapEvent });

    expect(preparePush).not.toHaveBeenCalled();
    expect(worker.showNotification).toHaveBeenCalledTimes(1);
    expect(worker.showNotification.mock.calls[0]?.[1]).toMatchObject({
      body: "Messages synced",
      tag: "armada-quiet-sync",
      silent: true,
      renotify: false,
    });
  });

  it("suppresses a non-inlined static DM before fetch while its plane is unready", async () => {
    const worker = loadWorker({
      pushConfig: {
        policy: "generic",
        self: "me",
        knownPeers: [],
        dmReady: false,
        concordReady: true,
      },
    });

    await worker.push({
      scope: "dm",
      event_id: "legacy-or-oversized-dm",
      relays: ["wss://dm.example"],
    });

    expect(worker.showNotification).not.toHaveBeenCalled();
  });

  it("uses only Apple's fixed quiet-sync for a non-inlined unready plane", async () => {
    const worker = loadWorker({
      pushConfig: {
        policy: "generic",
        self: "me",
        knownPeers: [],
        dmReady: true,
        concordReady: false,
      },
      pushEndpoint: "https://web.push.apple.com/QKw71NdV3vO",
    });

    await worker.push({
      scope: "c2",
      event_id: "oversized-c2",
      relays: ["wss://c2.example"],
    });

    expect(worker.showNotification).toHaveBeenCalledTimes(1);
    expect(worker.showNotification.mock.calls[0]).toEqual([
      "Armada",
      expect.objectContaining({
        body: "Messages synced",
        tag: "armada-quiet-sync",
        silent: true,
        renotify: false,
      }),
    ]);
  });

  it("keeps the non-inlined fallback for a legacy config with no plane flags", async () => {
    const worker = loadWorker({
      pushConfig: { policy: "generic", self: "me", knownPeers: [] },
    });

    await worker.push({ scope: "dm", event_id: "legacy-dm" });

    expect(worker.showNotification).toHaveBeenCalledTimes(1);
  });

  it("passes a legacy config without inventing readiness defaults", async () => {
    const preparePush = vi.fn(async (_data: unknown, config: unknown) => {
      expect(config).toEqual({ policy: "generic", self: "me", knownPeers: [], sk: "aa" });
      return prepared();
    });
    const worker = loadWorker({
      pushConfig: { policy: "generic", self: "me", knownPeers: [], sk: "aa" },
      runtime: { preparePush },
    });

    await worker.push({ scope: "dm", event_id: "legacy-dm", event: wrapEvent });

    expect(preparePush).toHaveBeenCalledTimes(1);
    expect(worker.showNotification).toHaveBeenCalledTimes(1);
    expect(worker.showNotification.mock.calls[0]?.[0]).toBe("Armada / #general");
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

describe("Web Push click routing", () => {
  it("awaits navigation before focusing the routed client", async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const worker = loadWorker({
      clients: [{
        url: "https://armada.buzz/",
        visibilityState: "hidden",
        focused: false,
        navigateWait: wait,
      }],
    });

    const click = worker.notificationClick("/dm/alice?from=push#message");
    await vi.waitFor(() => expect(worker.clients[0]?.navigate).toHaveBeenCalled());
    expect(worker.clients[0]?.focus).not.toHaveBeenCalled();
    release();
    await click;

    expect(worker.clients[0]?.navigate).toHaveBeenCalledWith("/dm/alice?from=push#message");
    expect(worker.clients[0]?.focus).toHaveBeenCalledTimes(1);
    expect(worker.openWindow).not.toHaveBeenCalled();
  });

  it("opens the exact route when an existing iOS client rejects navigation", async () => {
    const worker = loadWorker({
      clients: [{
        url: "https://armada.buzz/",
        visibilityState: "hidden",
        focused: false,
        navigateRejects: true,
      }],
    });
    await worker.notificationClick("/c/community/channel/m/event");
    expect(worker.openWindow).toHaveBeenCalledWith("/c/community/channel/m/event");
  });

  it("never routes a notification tap outside the installed app origin", async () => {
    const worker = loadWorker();
    await worker.notificationClick("https://attacker.example/secret");
    expect(worker.openWindow).toHaveBeenCalledWith("/");
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

  it("fetches the wrap and silently enriches the same stable entry", async () => {
    const preparePush = vi.fn(async () => prepared);
    const staticEntry = { tag: "wrap-1", data: {}, close: vi.fn() };
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

    // Static wake-up first, then a silent update under the exact same tag. It
    // may call showNotification twice, but produces one tray entry/one alert.
    expect(worker.showNotification).toHaveBeenCalledTimes(2);
    const [title, opts] = worker.showNotification.mock.calls[1] as unknown as [
      string,
      { tag: string; body: string; silent: boolean; renotify: boolean },
    ];
    expect(title).toBe("Alice");
    expect(opts.tag).toBe("wrap-1");
    expect(opts.silent).toBe(true);
    expect(opts.renotify).toBe(false);
    // preparePush received the fetched event as if the gateway had inlined it.
    const [dataArg] = preparePush.mock.calls[0] as unknown as [{ event?: { id?: string } }];
    expect(dataArg.event?.id).toBe("wrap-1");
    expect(staticEntry.close).not.toHaveBeenCalled();
  });

  it("turns a fetched dropped Apple event into a non-leaking same-tag update", async () => {
    const staticEntry = { tag: "wrap-own", data: {}, close: vi.fn() };
    const worker = loadWorker({
      runtime: { preparePush: vi.fn(async () => ({ ...prepared, drop: true })) },
      pushConfig: { self: "me" },
      relayEvent: { id: "wrap-own", kind: 1059, tags: [], content: "x" },
      priorNotifications: [staticEntry],
      pushEndpoint: "https://web.push.apple.com/QKw71NdV3vO",
    });

    await worker.push({
      scope: "dm",
      tag: "sub-1",
      event_id: "wrap-own",
      relays: ["wss://relay.example"],
      url: "/dm",
    });

    expect(worker.showNotification).toHaveBeenCalledTimes(2);
    const [title, opts] = worker.showNotification.mock.calls[1] as unknown as [
      string,
      { body: string; tag: string; silent: boolean; renotify: boolean; data: { url: string } },
    ];
    expect(title).toBe("Armada");
    expect(opts).toMatchObject({
      body: "Messages synced",
      tag: "wrap-own",
      silent: true,
      renotify: false,
      data: { url: "/" },
    });
    expect(JSON.stringify([title, opts])).not.toContain("hi there");
    expect(JSON.stringify([title, opts])).not.toContain("Alice");
    expect(staticEntry.close).not.toHaveBeenCalled();
  });

  it("leaves the static wake-up when the wrap cannot be opened", async () => {
    const staticEntry = { tag: "wrap-2", data: {}, close: vi.fn() };
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
