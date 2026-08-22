import { afterEach, describe, expect, it, vi } from "vitest";

import {
  _resetBeforeAccountExitForTests,
  registerBeforeAccountExit,
  runBeforeAccountExit,
} from "@/lib/beforeAccountExit";

afterEach(() => {
  _resetBeforeAccountExitForTests();
  vi.useRealTimers();
});

describe("beforeAccountExit", () => {
  it("awaits every registered controller and passes the exit reason", async () => {
    const seen: string[] = [];
    registerBeforeAccountExit(async (reason) => { seen.push(`web:${reason}`); });
    registerBeforeAccountExit(async (reason) => { seen.push(`native:${reason}`); });

    await runBeforeAccountExit("account-change");
    expect(seen.sort()).toEqual([
      "native:account-change",
      "web:account-change",
    ]);
  });

  it("does not let a rejected controller block account exit", async () => {
    registerBeforeAccountExit(async () => { throw new Error("gateway offline"); });
    await expect(runBeforeAccountExit("final-logout")).resolves.toBeUndefined();
  });

  it("unregisters duplicate function registrations independently", async () => {
    const handler = vi.fn(async () => {});
    const unregisterFirst = registerBeforeAccountExit(handler);
    registerBeforeAccountExit(handler);
    unregisterFirst();

    await runBeforeAccountExit("account-change");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("bounds a controller that never settles", async () => {
    vi.useFakeTimers();
    registerBeforeAccountExit(() => new Promise<void>(() => {}));

    const exit = runBeforeAccountExit("final-logout", 25);
    await vi.advanceTimersByTimeAsync(25);
    await expect(exit).resolves.toBeUndefined();
  });
});
