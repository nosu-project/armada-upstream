// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  prove: vi.fn<() => Promise<"absent" | "present" | "unknown">>(),
  config: { automaticSettingsSync: true } as { automaticSettingsSync: boolean },
}));

vi.mock("@nostrify/react", () => ({ useNostr: () => ({ nostr: {} }) }));
vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ user: { pubkey: "a".repeat(64), signer: { nip44: { decrypt: vi.fn() } } } }),
}));
vi.mock("@/hooks/useAppContext", () => ({ useAppContext: () => ({ config: h.config }) }));
vi.mock("@/contexts/AppContext", () => ({ accountDataRelays: () => ["wss://one.example"] }));
vi.mock("@/lib/notificationSettingsProof", () => ({ proveNotificationSettingsAbsence: h.prove }));

const { useNotificationSettingsAbsenceProof } = await import("./useNotificationSettingsAbsenceProof");
const { _resetNotificationSettingsAuthorityForTests, notificationSettingsReady } = await import(
  "@/lib/notificationSettingsAuthority"
);

const PK = "a".repeat(64);

describe("useNotificationSettingsAbsenceProof", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    _resetNotificationSettingsAuthorityForTests();
    h.prove.mockReset();
    h.config = { automaticSettingsSync: true };
  });
  afterEach(() => vi.useRealTimers());

  it("retries an unanswered read until every relay proves the document absent", async () => {
    h.prove.mockResolvedValueOnce("unknown").mockResolvedValueOnce("absent");
    renderHook(() => useNotificationSettingsAbsenceProof());

    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.prove).toHaveBeenCalledTimes(1);
    expect(notificationSettingsReady(PK)).toBe(false);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.prove).toHaveBeenCalledTimes(2);
    expect(notificationSettingsReady(PK)).toBe(true);
  });

  it("leaves a found document to the settings sync that applies it", async () => {
    h.prove.mockResolvedValue("present");
    renderHook(() => useNotificationSettingsAbsenceProof());
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(h.prove).toHaveBeenCalledTimes(1);
    expect(notificationSettingsReady(PK)).toBe(false);
  });

  it("does nothing for an account that is already ready, or with settings sync off", async () => {
    localStorage.setItem(`armada:notification-settings-ready:v1:${PK}`, "1");
    const { unmount } = renderHook(() => useNotificationSettingsAbsenceProof());
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    unmount();

    localStorage.clear();
    _resetNotificationSettingsAuthorityForTests();
    h.config = { automaticSettingsSync: false };
    renderHook(() => useNotificationSettingsAbsenceProof());
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(h.prove).not.toHaveBeenCalled();
  });
});
