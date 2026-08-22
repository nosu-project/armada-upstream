import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  disabled: false,
  writes: 0,
  clears: 0,
  onClear: undefined as (() => void) | undefined,
}));

vi.mock("@/lib/swPushDisabled", () => ({
  writePushDisabledFlag: async () => {
    h.writes += 1;
    h.disabled = true;
  },
  clearPushDisabledFlag: async () => {
    h.clears += 1;
    h.disabled = false;
    h.onClear?.();
  },
}));

import {
  _resetBeforeAccountExitForTests,
  registerBeforeAccountExit,
  runBeforeAccountExit,
} from "@/lib/beforeAccountExit";
import {
  acquireWebPushSubscription,
  activateRegisteredWebPush,
  finishWebPushAccountExit,
  loadWebPushRetirementProof,
  retireWebPushEndpoint,
  WEB_PUSH_RETIREMENT_KEY,
} from "@/lib/webPushEndpoint";

function endpointFixture() {
  let current: PushSubscription | null;
  const old = {
    endpoint: "https://push.example/old-account",
    options: {},
    unsubscribe: vi.fn(async () => {
      current = null;
      return true;
    }),
  } as unknown as PushSubscription;
  const next = {
    endpoint: "https://push.example/next-account",
    options: {},
    unsubscribe: vi.fn(async () => true),
  } as unknown as PushSubscription;
  current = old;
  const subscribe = vi.fn(async () => {
    current = next;
    return next;
  });
  const registration = {
    pushManager: {
      getSubscription: vi.fn(async () => current),
      subscribe,
    },
  } as unknown as ServiceWorkerRegistration;
  return { registration, old, next, subscribe };
}

beforeEach(() => {
  h.disabled = false;
  h.writes = 0;
  h.clears = 0;
  h.onClear = undefined;
  localStorage.removeItem(WEB_PUSH_RETIREMENT_KEY);
  _resetBeforeAccountExitForTests();
});

afterEach(() => {
  _resetBeforeAccountExitForTests();
});

describe("web push account transitions", () => {
  it("retires the endpoint and keeps the kill switch set when gateway DELETE fails", async () => {
    const { registration, old } = endpointFixture();
    const clearConfig = vi.fn(async () => {});

    await expect(finishWebPushAccountExit({
      registration,
      clearConfig,
      deleteGatewayRecords: async () => { throw new Error("gateway offline"); },
    })).rejects.toThrow("gateway offline");

    expect(old.unsubscribe).toHaveBeenCalledTimes(1);
    expect(clearConfig).toHaveBeenCalledTimes(1);
    expect(h.disabled).toBe(true);
    expect(loadWebPushRetirementProof()?.unsubscribeSucceeded).toBe(true);
  });

  it("retires before timed-out cleanup and lets the next account create a new endpoint", async () => {
    const { registration, old, next, subscribe } = endpointFixture();
    const never = new Promise<void>(() => {});
    const unregister = registerBeforeAccountExit(() => finishWebPushAccountExit({
      registration,
      clearConfig: async () => {},
      deleteGatewayRecords: () => never,
    }));

    await runBeforeAccountExit("account-change", 5);
    expect(old.unsubscribe).toHaveBeenCalledTimes(1);
    expect(h.disabled).toBe(true);

    const acquired = await acquireWebPushSubscription(
      registration,
      new Uint8Array([1, 2, 3]).buffer,
      { userVisibleOnly: true },
    );
    expect(acquired).toBe(next);
    expect(subscribe).toHaveBeenCalledTimes(1);
    // Endpoint creation alone is not authority to expose the new account.
    expect(h.disabled).toBe(true);
    unregister();
  });

  it("activates a partial current-account registration on a different endpoint", async () => {
    const { registration, old, next } = endpointFixture();
    old.unsubscribe = vi.fn(async () => false);
    await retireWebPushEndpoint(registration);
    const prepareConfig = vi.fn(async () => {});

    expect(await activateRegisteredWebPush({
      subscription: next,
      registered: true,
      prepareConfig,
      isCurrent: () => true,
    })).toBe(true);
    expect(prepareConfig).toHaveBeenCalledTimes(1);
    expect(h.disabled).toBe(false);
  });

  it("keeps failed retirement on the same endpoint denied", async () => {
    const { registration, old } = endpointFixture();
    old.unsubscribe = vi.fn(async () => false);
    await retireWebPushEndpoint(registration);
    const prepareConfig = vi.fn(async () => {});

    expect(await activateRegisteredWebPush({
      subscription: old,
      registered: true,
      prepareConfig,
      isCurrent: () => true,
    })).toBe(false);
    expect(prepareConfig).not.toHaveBeenCalled();
    expect(h.disabled).toBe(true);
  });

  it("lets an explicit retirement retry recover an unknown failed proof", async () => {
    const unavailable = {
      pushManager: {
        getSubscription: vi.fn(async () => { throw new Error("push manager unavailable"); }),
      },
    } as unknown as ServiceWorkerRegistration;
    await retireWebPushEndpoint(unavailable);
    expect(loadWebPushRetirementProof()).toEqual({ unsubscribeSucceeded: false });

    // This is the explicit-disable retry: the browser is available again and
    // can prove the held endpoint has actually been retired.
    const { registration, old } = endpointFixture();
    await retireWebPushEndpoint(registration);
    expect(loadWebPushRetirementProof()).toMatchObject({ unsubscribeSucceeded: true });

    expect(await activateRegisteredWebPush({
      subscription: old,
      registered: true,
      prepareConfig: async () => {},
      isCurrent: () => true,
    })).toBe(true);
    expect(h.disabled).toBe(false);
  });

  it("writes current-account config before lifting the kill switch", async () => {
    const { registration, old } = endpointFixture();
    await retireWebPushEndpoint(registration);
    const order: string[] = [];
    h.onClear = () => { order.push("clear"); };

    expect(await activateRegisteredWebPush({
      // Successful retirement is sufficient even if a browser reuses the URL.
      subscription: old,
      registered: true,
      prepareConfig: async () => { order.push("config"); },
      isCurrent: () => true,
    })).toBe(true);
    expect(order).toEqual(["config", "clear"]);
  });

  it("does not lift the switch without a successful registration", async () => {
    h.disabled = true;
    const subscription = { endpoint: "https://push.example/current" } as PushSubscription;
    expect(await activateRegisteredWebPush({
      subscription,
      registered: false,
      prepareConfig: async () => {},
      isCurrent: () => true,
    })).toBe(true);
    expect(h.clears).toBe(0);
    expect(h.disabled).toBe(true);
  });

  it("restores the switch when exit starts during the final clear", async () => {
    const subscription = { endpoint: "https://push.example/current" } as PushSubscription;
    let current = true;
    h.disabled = true;
    h.onClear = () => { current = false; };
    expect(await activateRegisteredWebPush({
      subscription,
      registered: true,
      prepareConfig: async () => {},
      isCurrent: () => current,
    })).toBe(false);
    expect(h.disabled).toBe(true);
  });
});
