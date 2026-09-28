import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  mutatePushRegistrations,
  nappPushTarget,
  webPushTarget,
  type PushSyncJob,
  type PushTarget,
} from "@/hooks/useNostrPush";
import { loadLastPushSet, NAPP_LIMITS, saveLastPushSet, type NappSubscription } from "@/lib/nappPush";
import { NostrPush2Error, type NostrPush2Client } from "@/lib/nostrPush2";

import type { PushSubscriptionSpec } from "@/lib/pushSubscriptions";

const A = "a".repeat(64);

const spec = (id: string, relay: string, filter: PushSubscriptionSpec["filter"]): PushSubscriptionSpec => ({
  id,
  relays: [relay],
  filter,
  notification: { title: "", body: "", data: { scope: "dm", relays: [relay] } },
});
const dm17 = spec("armada-dm17", "wss://dm", { kinds: [1059], "#p": [A] });
const group = spec("armada-groups-x", "wss://g", { kinds: [9], "#h": ["general"] });

function fakeTarget(over: Partial<PushTarget> = {}) {
  const sets: NappSubscription[][] = [];
  const target: PushTarget = {
    kind: "napp",
    limits: NAPP_LIMITS,
    set: vi.fn(async (subscriptions: NappSubscription[]) => {
      sets.push(subscriptions);
      return true;
    }),
    clear: vi.fn(async () => {}),
    activate: vi.fn(async (prepareConfig: () => Promise<void>) => {
      await prepareConfig();
      return true;
    }),
    ...over,
  };
  return { target, sets };
}

const job = (target: PushTarget, over: Partial<PushSyncJob> = {}): PushSyncJob => ({
  kind: "sync",
  target,
  pubkey: A,
  specs: [dm17],
  notificationSettingsReady: true,
  planes: { groups: true, dm: true, concord: true },
  prepareConfig: vi.fn(async () => {}),
  ...over,
});

beforeEach(() => localStorage.clear());

describe("mutatePushRegistrations", () => {
  it("hands over nothing and lifts nothing before policy authority", async () => {
    const { target } = fakeTarget();
    const result = await mutatePushRegistrations(
      job(target, { notificationSettingsReady: false }),
      () => true,
    );
    expect(result.completed).toBe(false);
    expect(target.set).not.toHaveBeenCalled();
    expect(target.activate).not.toHaveBeenCalled();
  });

  it("hands over the whole list, then seals config and activates", async () => {
    const { target, sets } = fakeTarget();
    const prepareConfig = vi.fn(async () => {});
    const result = await mutatePushRegistrations(job(target, { prepareConfig }), () => true);

    expect(result).toEqual({ completed: true, activated: true, dropped: 0 });
    expect(sets).toEqual([[{ filters: [dm17.filter], relays: ["wss://dm"] }]]);
    expect(prepareConfig).toHaveBeenCalledTimes(1);
    expect(loadLastPushSet(A).map((w) => w.id)).toEqual(["armada-dm17"]);
  });

  it("keeps a plane that has not loaded subscribed as it was last set", async () => {
    saveLastPushSet(A, [group]);
    const { target, sets } = fakeTarget();
    await mutatePushRegistrations(
      job(target, { planes: { groups: false, dm: true, concord: true } }),
      () => true,
    );
    expect(sets[0]).toContainEqual({ filters: [group.filter], relays: ["wss://g"] });
    expect(loadLastPushSet(A).map((w) => w.id).sort()).toEqual(["armada-dm17", "armada-groups-x"]);
  });

  it("drops a loaded plane's stale watches", async () => {
    saveLastPushSet(A, [group]);
    const { target, sets } = fakeTarget();
    await mutatePushRegistrations(job(target), () => true);
    expect(sets[0]).toEqual([{ filters: [dm17.filter], relays: ["wss://dm"] }]);
  });

  it("records nothing when superseded mid-flight", async () => {
    let current = true;
    const { target } = fakeTarget({
      set: vi.fn(async () => {
        current = false;
        return false;
      }),
    });
    const result = await mutatePushRegistrations(job(target), () => current);
    expect(result.completed).toBe(false);
    expect(loadLastPushSet(A)).toEqual([]);
    expect(target.activate).not.toHaveBeenCalled();
  });

  it("reports an activation it could not make safely", async () => {
    const { target } = fakeTarget({ activate: vi.fn(async () => false) });
    await expect(mutatePushRegistrations(job(target), () => true)).rejects.toThrow("retired safely");
  });

  it("clears the target and forgets the last set", async () => {
    saveLastPushSet(A, [dm17]);
    const { target } = fakeTarget();
    await mutatePushRegistrations({ kind: "clear", target }, () => true);
    expect(target.clear).toHaveBeenCalled();
    expect(loadLastPushSet(A)).toEqual([]);
  });
});

describe("webPushTarget", () => {
  const key = new Uint8Array(65).fill(4).buffer;
  const subscription = {
    endpoint: "https://push.example/abc",
    options: { applicationServerKey: key },
    toJSON: () => ({ keys: { p256dh: "p", auth: "a" } }),
    unsubscribe: vi.fn(async () => true),
  } as unknown as PushSubscription;
  const prepared = {
    registration: {
      pushManager: {
        getSubscription: async () => subscription,
        subscribe: vi.fn(),
      },
    } as unknown as ServiceWorkerRegistration,
    key,
    options: { userVisibleOnly: true, applicationServerKey: key },
    identity: { secretKey: new Uint8Array(32), vapidPrivateKey: "d", vapidPublicKey: "k" },
  };

  it("creates the client once per endpoint, then sets", async () => {
    const client = { create: vi.fn(async () => {}), set: vi.fn(async () => {}) };
    const target = webPushTarget(client as unknown as NostrPush2Client, () => prepared);

    await target.set([], () => true);
    await target.set([], () => true);

    expect(client.create).toHaveBeenCalledTimes(1);
    expect(client.create).toHaveBeenCalledWith({
      method: "web",
      endpoint: "https://push.example/abc",
      p256dh: "p",
      auth: "a",
      vapid_private_key: "d",
    });
    expect(client.set).toHaveBeenCalledTimes(2);
  });

  it("registers again when the gateway has forgotten this client", async () => {
    const set = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new NostrPush2Error("unknown client; call create first"))
      .mockResolvedValueOnce(undefined);
    const client = { create: vi.fn(async () => {}), set };
    const target = webPushTarget(client as unknown as NostrPush2Client, () => prepared);

    await target.set([], () => true);
    await expect(target.set([], () => true)).resolves.toBe(true);
    expect(client.create).toHaveBeenCalledTimes(2);
    expect(set).toHaveBeenCalledTimes(3);
  });

  it("refuses before the worker and key are prepared", async () => {
    const target = webPushTarget({} as NostrPush2Client, () => undefined);
    await expect(target.set([], () => true)).rejects.toThrow("Push not ready");
  });
});

describe("nappPushTarget", () => {
  it("hands the list to the host and clears with an empty one", async () => {
    const api = { set: vi.fn(async () => {}), get: vi.fn(async () => []) };
    const target = nappPushTarget(api);
    const subs = [{ filters: [{ kinds: [1] }], relays: ["wss://r"] }];

    await expect(target.set(subs, () => true)).resolves.toBe(true);
    await target.clear();

    expect(api.set.mock.calls).toEqual([[subs], [[]]]);
  });

  it("seals the account's config before it activates", async () => {
    const target = nappPushTarget({ set: vi.fn(), get: vi.fn() });
    const prepareConfig = vi.fn(async () => {});
    await expect(target.activate(prepareConfig, () => true)).resolves.toBe(true);
    expect(prepareConfig).toHaveBeenCalled();
    await expect(target.activate(prepareConfig, () => false)).resolves.toBe(false);
  });
});
