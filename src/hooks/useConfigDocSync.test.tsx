import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultConfig, type AppConfig } from "@/contexts/AppContext";
import { useConfigDocSync } from "@/hooks/useConfigDocSync";

const h = vi.hoisted(() => ({
  config: {} as AppConfig,
  publish: vi.fn(),
  updateConfig: vi.fn(),
}));

vi.mock("@/hooks/useAppContext", () => ({
  useAppContext: () => ({ config: h.config, updateConfig: h.updateConfig }),
}));

vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ user: { pubkey: "a".repeat(64) } }),
}));

vi.mock("@/hooks/useSettingsDoc", () => ({
  useSettingsDoc: () => ({
    doc: { theme: "light" },
    event: { id: "settings-v1", created_at: 1 },
    update: h.publish,
    hasNip44Support: true,
  }),
}));

describe("useConfigDocSync automatic delivery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.config = { ...defaultConfig, theme: "light" };
    h.publish.mockReset();
    h.updateConfig.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries a durable config edit after relay delivery fails", async () => {
    h.publish
      .mockRejectedValueOnce(new Error("relay down"))
      .mockResolvedValueOnce({});
    const { rerender } = renderHook(() => useConfigDocSync("metadata"));

    h.config = { ...h.config, theme: "dark" };
    rerender();
    await act(() => vi.advanceTimersByTimeAsync(800));
    expect(h.publish).toHaveBeenCalledTimes(1);

    await act(() => vi.advanceTimersByTimeAsync(4_999));
    expect(h.publish).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(h.publish).toHaveBeenCalledTimes(2);
  });

  it("publishes the latest snapshot when config changes during delivery", async () => {
    let finishFirst!: () => void;
    h.publish
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        finishFirst = resolve;
      }))
      .mockResolvedValueOnce({});
    const { rerender } = renderHook(() => useConfigDocSync("metadata"));

    h.config = { ...h.config, theme: "dark" };
    rerender();
    await act(() => vi.advanceTimersByTimeAsync(800));
    expect(h.publish).toHaveBeenCalledTimes(1);

    h.config = { ...h.config, defaultZapAmount: 42 };
    rerender();
    await act(async () => finishFirst());
    await act(() => vi.advanceTimersByTimeAsync(800));

    expect(h.publish).toHaveBeenCalledTimes(2);
    expect(h.publish.mock.calls[1]![0]).toMatchObject({
      theme: "dark",
      defaultZapAmount: 42,
    });
  });
});
