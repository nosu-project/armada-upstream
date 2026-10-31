import { afterEach, describe, expect, it, vi } from "vitest";

import { isMeteredNetwork, onMeteredNetworkChange } from "./meteredNetwork";

function stubConnection(info: { type?: string; saveData?: boolean } | undefined): EventTarget | undefined {
  const target = info ? Object.assign(new EventTarget(), info) : undefined;
  vi.stubGlobal("navigator", { connection: target });
  return target;
}

describe("meteredNetwork", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads cellular and Data Saver as metered", () => {
    stubConnection({ type: "cellular" });
    expect(isMeteredNetwork()).toBe(true);
    stubConnection({ type: "wifi", saveData: true });
    expect(isMeteredNetwork()).toBe(true);
  });

  it("reads Wi-Fi, ethernet, an unknown type and a missing API as unmetered", () => {
    stubConnection({ type: "wifi" });
    expect(isMeteredNetwork()).toBe(false);
    stubConnection({ type: "ethernet" });
    expect(isMeteredNetwork()).toBe(false);
    stubConnection({});
    expect(isMeteredNetwork()).toBe(false);
    stubConnection(undefined);
    expect(isMeteredNetwork()).toBe(false);
  });

  it("notifies on connection change until unsubscribed", () => {
    const target = stubConnection({ type: "wifi" })!;
    const listener = vi.fn();
    const off = onMeteredNetworkChange(listener);
    target.dispatchEvent(new Event("change"));
    off();
    target.dispatchEvent(new Event("change"));
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
