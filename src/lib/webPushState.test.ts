// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { markOwnWebPushEvent } from "@/lib/webPushState";

describe("Web Push local-event state", () => {
  afterEach(() => {
    Reflect.deleteProperty(window, "caches");
  });

  it("stores an event marker under the URL read by the service worker", async () => {
    const put = vi.fn(async (_request: string, _response: Response) => undefined);
    const cache = {
      put,
      keys: vi.fn(async () => []),
      delete: vi.fn(async () => true),
    };
    Object.defineProperty(window, "caches", {
      configurable: true,
      value: { open: vi.fn(async () => cache) },
    });

    await markOwnWebPushEvent("event/id");

    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]?.[0]).toBe(`${window.location.origin}/.armada-push-state/own/event%2Fid`);
  });
});
