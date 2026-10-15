import { beforeEach, describe, expect, it, vi } from "vitest";

import { NostrPush2Error, type NostrPush2Client } from "@/lib/nostrPush2";

const register = vi.fn();
const recordPushStatus = vi.fn(async (_line: string) => {});

vi.mock("@/lib/nativePush", () => ({
  ArmadaPush: { register: () => register() },
  recordPushStatus: (line: string) => recordPushStatus(line),
  clearIosPushConfig: vi.fn(),
  hasIosPush: () => true,
  writeIosPushConfig: vi.fn(),
}));

const { apnsPushTarget } = await import("@/hooks/useIosPush");

const TOKEN = "ab".repeat(32);

function fakeClient() {
  return {
    create: vi.fn(async () => {}),
    set: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  };
}

beforeEach(() => {
  register.mockReset().mockResolvedValue({
    granted: true,
    token: TOKEN,
    bundleId: "buzz.armada.app",
    environment: "sandbox",
  });
  recordPushStatus.mockClear();
});

describe("apnsPushTarget", () => {
  it("creates the APNs connection once, then only sets the list", async () => {
    const client = fakeClient();
    const target = apnsPushTarget(client as unknown as NostrPush2Client, () => {});
    const subs = [{ filters: [{ kinds: [1059] }], relays: ["wss://r"] }];

    await expect(target.set(subs, () => true)).resolves.toBe(true);
    await target.set(subs, () => true);

    expect(client.create).toHaveBeenCalledTimes(1);
    expect(client.create).toHaveBeenCalledWith({
      method: "apn",
      token: TOKEN,
      topic: "buzz.armada.app",
      environment: "sandbox",
    });
    expect(client.set).toHaveBeenCalledTimes(2);
    expect(client.set).toHaveBeenLastCalledWith(subs);
  });

  it("creates again when APNs rotates the token", async () => {
    const client = fakeClient();
    const target = apnsPushTarget(client as unknown as NostrPush2Client, () => {});
    await target.set([], () => true);
    register.mockResolvedValue({
      granted: true, token: "cd".repeat(32), bundleId: "buzz.armada.app", environment: "sandbox",
    });
    await target.set([], () => true);
    expect(client.create).toHaveBeenCalledTimes(2);
  });

  it("recreates a client the gateway forgot", async () => {
    const client = fakeClient();
    client.set.mockRejectedValueOnce(new NostrPush2Error("unknown client; call create first"));
    const target = apnsPushTarget(client as unknown as NostrPush2Client, () => {});

    await expect(target.set([], () => true)).resolves.toBe(true);
    expect(client.create).toHaveBeenCalledTimes(2);
    expect(client.set).toHaveBeenCalledTimes(2);
  });

  it("reports a refused prompt as denied and registers nothing", async () => {
    register.mockResolvedValue({ granted: false });
    const client = fakeClient();
    const onPermission = vi.fn();
    const target = apnsPushTarget(client as unknown as NostrPush2Client, onPermission);

    await expect(target.set([], () => true)).rejects.toThrow();
    expect(onPermission).toHaveBeenCalledWith("denied");
    expect(client.create).not.toHaveBeenCalled();
  });

  it("keeps the token out of the status line", async () => {
    const client = fakeClient();
    await apnsPushTarget(client as unknown as NostrPush2Client, () => {}).set([], () => true);
    const line = recordPushStatus.mock.calls.at(-1)?.[0];
    expect(line).toMatch(/^ok 0 subs env=sandbox token=…ababab$/);
    expect(line).not.toContain(TOKEN);
  });

  it("clears by deleting the client", async () => {
    const client = fakeClient();
    await apnsPushTarget(client as unknown as NostrPush2Client, () => {}).clear();
    expect(client.delete).toHaveBeenCalled();
  });
});
