import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LoginSetup } from "@/components/onboarding/LoginSetup";

import type { ReactNode } from "react";

const h = vi.hoisted(() => ({
  config: {
    relayMetadata: {
      relays: [] as Array<{ url: string; read: boolean; write: boolean }>,
      updatedAt: 0,
      pubkey: undefined as string | undefined,
    },
  },
  user: { pubkey: "a".repeat(64) },
  settings: { doc: null as unknown, isFetched: true },
  servers: [] as string[],
  platform: "web",
  nativeNotificationService: false,
  checkPermission: vi.fn(),
  isIgnoringBatteryOptimizations: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => h.platform },
}));

vi.mock("@/components/onboarding/WizardShell", () => ({
  WizardShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  WizardStepBody: ({ title, children }: { title: string; children: ReactNode }) => (
    <div><h1>{title}</h1>{children}</div>
  ),
}));

vi.mock("@/components/RelayBootstrapForm", () => ({
  RelayBootstrapForm: () => <div>relay form</div>,
}));

vi.mock("@/components/SyncGate", () => ({ useSyncGateActive: () => false }));
vi.mock("@/hooks/useOnboarding", () => ({ useOnboardingActive: () => false }));
vi.mock("@/hooks/useAppContext", () => ({ useAppContext: () => ({ config: h.config }) }));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: h.user }) }));
vi.mock("@/hooks/useEncryptedSettings", () => ({ useEncryptedSettings: () => h.settings }));
vi.mock("@/hooks/useNip29Servers", () => ({ useNip29Servers: () => h.servers }));
vi.mock("@/hooks/useNativeNotifications", () => ({
  enableNativeNotifications: vi.fn(),
  hasNativeNotificationService: () => h.nativeNotificationService,
  nativeNotificationIntent: () => false,
}));
vi.mock("@/lib/decryptConsent", () => ({
  registerConsentPromptOpener: () => () => undefined,
  resolveConsentPrompt: vi.fn(),
  setDecryptConsent: vi.fn(),
}));
vi.mock("@/lib/nativeNotifications", () => ({
  ArmadaNotification: { checkPermission: h.checkPermission },
  isIgnoringBatteryOptimizations: h.isIgnoringBatteryOptimizations,
  requestIgnoreBatteryOptimizations: vi.fn(),
}));
vi.mock("@/lib/webPushPrompt", () => ({
  markWebPushPromptShown: vi.fn(),
  registerWebPushOptInOpener: () => () => undefined,
  runWebPushEnable: vi.fn(),
}));

describe("LoginSetup relay discovery", () => {
  beforeEach(() => {
    localStorage.clear();
    h.platform = "web";
    h.nativeNotificationService = false;
    h.checkPermission.mockReset();
    h.isIgnoringBatteryOptimizations.mockReset();
    h.config.relayMetadata = { relays: [], updatedAt: 0, pubkey: undefined };
    h.settings = { doc: null, isFetched: true };
    h.servers = [];
  });

  it("dismisses a queued recovery prompt when signed discovery finishes", async () => {
    const view = render(<LoginSetup />);
    expect(await screen.findByRole("heading", { name: "restore your setup" })).toBeInTheDocument();

    h.config.relayMetadata = {
      relays: [{ url: "wss://relay.example", read: true, write: true }],
      updatedAt: 1,
      pubkey: h.user.pubkey,
    };
    view.rerender(<LoginSetup />);

    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "restore your setup" })).not.toBeInTheDocument();
    });
  });

  it("never prompts when the settings read is still in flight", async () => {
    h.settings = { doc: null, isFetched: false };
    render(<LoginSetup />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("heading", { name: "restore your setup" })).not.toBeInTheDocument();
  });

  it("does not prompt for an account that already restored data", async () => {
    h.settings = { doc: { theme: "dark" }, isFetched: true };
    render(<LoginSetup />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("heading", { name: "restore your setup" })).not.toBeInTheDocument();
  });

  it("does not prompt an account that was opted out (e.g. a fresh signup)", async () => {
    localStorage.setItem(`armada:relay-prompt-shown:${h.user.pubkey}`, "1");
    render(<LoginSetup />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("heading", { name: "restore your setup" })).not.toBeInTheDocument();
  });
});

describe("LoginSetup Android battery optimization", () => {
  beforeEach(() => {
    localStorage.clear();
    h.platform = "android";
    h.nativeNotificationService = true;
    h.checkPermission.mockReset().mockResolvedValue({ granted: true });
    h.isIgnoringBatteryOptimizations.mockReset().mockResolvedValue(false);
    h.config.relayMetadata = { relays: [], updatedAt: 0, pubkey: undefined };
    h.settings = { doc: { theme: "dark" }, isFetched: true };
    h.servers = [];
  });

  it("does not offer the exemption again after the user dismisses it", async () => {
    const view = render(<LoginSetup />);

    expect(await screen.findByRole("heading", { name: "keep it connected" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "keep it connected" })).not.toBeInTheDocument();
    });

    view.unmount();
    render(<LoginSetup />);
    await waitFor(() => expect(h.checkPermission).toHaveBeenCalled());
    expect(screen.queryByRole("heading", { name: "keep it connected" })).not.toBeInTheDocument();
    expect(h.isIgnoringBatteryOptimizations).toHaveBeenCalledTimes(1);
  });

  it("honors an old nudge timestamp as an already-offered prompt", async () => {
    localStorage.setItem("armada:battery-exemption-nudged-at", "1");
    render(<LoginSetup />);

    await waitFor(() => expect(h.checkPermission).toHaveBeenCalled());
    expect(screen.queryByRole("heading", { name: "keep it connected" })).not.toBeInTheDocument();
    expect(h.isIgnoringBatteryOptimizations).not.toHaveBeenCalled();
  });
});
