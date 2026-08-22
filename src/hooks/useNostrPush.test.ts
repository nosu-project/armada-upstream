import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  mutateWebPushRegistrations,
  type WebPushSyncJob,
} from "@/hooks/useNostrPush";
import { savePushRegistrationState } from "@/lib/pushRegistry";
import { scopePushSubscriptionId } from "@/lib/pushSubscriptions";

beforeEach(() => {
  localStorage.clear();
});

describe("mutateWebPushRegistrations", () => {
  it("does not register, replace worker config, or activate before policy authority", async () => {
    const getSubscription = vi.fn();
    const registerSubscription = vi.fn();
    const prepareConfig = vi.fn();
    const job = {
      kind: "sync",
      client: { registerSubscription },
      pubkey: "a".repeat(64),
      domain: "armada.example",
      installation: "install",
      prepared: {
        registration: { pushManager: { getSubscription } },
        key: new ArrayBuffer(0),
        options: { userVisibleOnly: true },
      },
      specs: [{
        id: "armada-dm17",
        relays: ["wss://relay.example"],
        filter: { kinds: [1059] },
        notification: {
          title: "New message",
          body: "New direct message",
          data: { scope: "dm", relays: ["wss://relay.example"] },
        },
      }],
      authoritative: false,
      notificationSettingsReady: false,
      groupPlaneReady: false,
      dmPlaneReady: false,
      concordPlaneReady: false,
      prepareConfig,
    } as unknown as WebPushSyncJob;

    await expect(mutateWebPushRegistrations(job, () => true)).resolves.toEqual({
      completed: false,
      activated: false,
      deferredRegistrations: [],
    });
    expect(getSubscription).not.toHaveBeenCalled();
    expect(registerSubscription).not.toHaveBeenCalled();
    expect(prepareConfig).not.toHaveBeenCalled();
  });

  it("activates an independent NIP-29 partial watch while encrypted planes are unready", async () => {
    const subscription = {
      endpoint: "https://push.example/nip29-only",
      options: {},
      toJSON: () => ({ keys: { p256dh: "p256", auth: "auth" } }),
    } as unknown as PushSubscription;
    const registerSubscription = vi.fn(async () => {});
    const prepareConfig = vi.fn(async () => {
      // The hook's real callback seals dmReady:false/concordReady:false here.
    });
    const job = {
      kind: "sync",
      client: {
        registerSubscription,
        deleteSubscription: vi.fn(async () => {}),
      },
      pubkey: "b".repeat(64),
      domain: "nip29-only.example",
      installation: "install",
      prepared: {
        registration: {
          pushManager: { getSubscription: vi.fn(async () => subscription) },
        },
        key: new ArrayBuffer(0),
        options: { userVisibleOnly: true },
      },
      specs: [{
        id: "armada-groups-relay",
        relays: ["wss://groups.example"],
        filter: { kinds: [9], "#h": ["general"] },
        notification: {
          title: "New message",
          body: "New message in a channel",
          data: { scope: "group", relays: ["wss://groups.example"] },
        },
      }],
      authoritative: false,
      notificationSettingsReady: true,
      groupPlaneReady: true,
      dmPlaneReady: false,
      concordPlaneReady: false,
      prepareConfig,
    } as unknown as WebPushSyncJob;

    const result = await mutateWebPushRegistrations(job, () => true);

    expect(result).toEqual({
      completed: true,
      activated: true,
      deferredRegistrations: [],
    });
    expect(registerSubscription).toHaveBeenCalledTimes(1);
    expect(prepareConfig).toHaveBeenCalledTimes(1);
  });

  it("activates stable records and reports a deferred full-quota partial addition", async () => {
    const pubkey = "c".repeat(64);
    const domain = "partial-quota.example";
    const installation = "install";
    const scoped = (id: string) => scopePushSubscriptionId(
      id,
      pubkey,
      domain,
      installation,
    );
    savePushRegistrationState({ pubkey, domain, installation }, {
      ids: [scoped("armada-c2-old"), scoped("armada-dm17")],
      legacyMigrationComplete: true,
    });
    const subscription = {
      endpoint: "https://push.example/partial-quota",
      options: {},
      toJSON: () => ({ keys: { p256dh: "p256", auth: "auth" } }),
    } as unknown as PushSubscription;
    const registerSubscription = vi.fn(async (input: { subscription_id: string }) => {
      if (input.subscription_id === scoped("armada-c2-new")) {
        throw new Error("quota exceeded");
      }
    });
    const prepareConfig = vi.fn(async () => {});
    const makeSpec = (id: string) => ({
      id,
      relays: ["wss://relay.example"],
      filter: { kinds: [1059] },
      notification: {
        title: "New message",
        body: "New message",
        data: { scope: "dm" as const, relays: ["wss://relay.example"] },
      },
    });
    const job = {
      kind: "sync",
      client: {
        registerSubscription,
        deleteSubscription: vi.fn(async () => {}),
      },
      pubkey,
      domain,
      installation,
      prepared: {
        registration: {
          pushManager: { getSubscription: vi.fn(async () => subscription) },
        },
        key: new ArrayBuffer(0),
        options: { userVisibleOnly: true },
      },
      specs: [
        makeSpec("armada-c2-new"),
        makeSpec("armada-dm17"),
        makeSpec("armada-c2-old"),
      ],
      authoritative: false,
      notificationSettingsReady: true,
      groupPlaneReady: false,
      dmPlaneReady: true,
      concordPlaneReady: false,
      prepareConfig,
    } as unknown as WebPushSyncJob;

    const result = await mutateWebPushRegistrations(job, () => true);

    expect(result).toEqual({
      completed: true,
      activated: true,
      deferredRegistrations: [scoped("armada-c2-new")],
    });
    expect(registerSubscription.mock.calls.map(([input]) => input.subscription_id))
      .toEqual([
        scoped("armada-dm17"),
        scoped("armada-c2-new"),
      ]);
    expect(prepareConfig).toHaveBeenCalledTimes(1);
  });

  it("uses Concord-only prune authority to recover a zero-overlap full quota", async () => {
    const pubkey = "d".repeat(64);
    const domain = "plane-prune.example";
    const installation = "install";
    const scoped = (id: string) => scopePushSubscriptionId(
      id,
      pubkey,
      domain,
      installation,
    );
    const oldId = scoped("armada-c2-old-relays");
    const newId = scoped("armada-c2-new-relays");
    const live = new Set([oldId]);
    savePushRegistrationState({ pubkey, domain, installation }, {
      ids: [...live],
      legacyMigrationComplete: true,
    });
    const order: string[] = [];
    const subscription = {
      endpoint: "https://push.example/plane-prune",
      options: {},
      toJSON: () => ({ keys: { p256dh: "p256", auth: "auth" } }),
    } as unknown as PushSubscription;
    const prepareConfig = vi.fn(async () => {});
    const job = {
      kind: "sync",
      client: {
        registerSubscription: vi.fn(async (input: { subscription_id: string }) => {
          order.push(`put:${input.subscription_id}`);
          if (!live.has(input.subscription_id) && live.size >= 1) {
            throw new Error("quota exceeded");
          }
          live.add(input.subscription_id);
        }),
        deleteSubscription: vi.fn(async (id: string) => {
          order.push(`delete:${id}`);
          live.delete(id);
        }),
      },
      pubkey,
      domain,
      installation,
      prepared: {
        registration: {
          pushManager: { getSubscription: vi.fn(async () => subscription) },
        },
        key: new ArrayBuffer(0),
        options: { userVisibleOnly: true },
      },
      specs: [{
        id: "armada-c2-new-relays",
        relays: ["wss://new.example"],
        filter: { kinds: [1059], authors: ["e".repeat(64)] },
        notification: {
          title: "New message",
          body: "New message in a community",
          data: { scope: "c2", relays: ["wss://new.example"] },
        },
      }],
      authoritative: false,
      notificationSettingsReady: true,
      groupPlaneReady: false,
      dmPlaneReady: false,
      concordPlaneReady: true,
      prepareConfig,
    } as unknown as WebPushSyncJob;

    await expect(mutateWebPushRegistrations(job, () => true)).resolves.toEqual({
      completed: true,
      activated: true,
      deferredRegistrations: [],
    });
    expect(order).toEqual([`delete:${oldId}`, `put:${newId}`]);
    expect(live).toEqual(new Set([newId]));
    expect(prepareConfig).toHaveBeenCalledTimes(1);
  });
});
