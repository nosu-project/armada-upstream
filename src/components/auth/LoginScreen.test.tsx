import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const clientPubkey = "a".repeat(64);
  const secret = "c00a9648-1a34-42a0-bf52-aa9a5fe28bbb";
  return {
    clientPubkey,
    secret,
    connectUri: `nostrconnect://${clientPubkey}?relay=wss%3A%2F%2Frelay.example&secret=${secret}&name=Armada`,
    writeClipboardText: vi.fn(async (_text: string) => {}),
    toast: vi.fn(),
    // Never settles: the handshake stays pending, so the QR view stays on screen.
    nostrconnect: vi.fn(() => new Promise<void>(() => {})),
  };
});

vi.mock("@/hooks/useLoginActions", () => ({
  useLoginActions: () => ({
    nsec: vi.fn(),
    bunker: vi.fn(),
    extension: vi.fn(),
    nostrconnect: h.nostrconnect,
    getRelayUrls: () => ["wss://relay.example"],
  }),
  generateNostrConnectParams: () => ({
    clientSecretKey: new Uint8Array(32),
    clientPubkey: h.clientPubkey,
    secret: h.secret,
    relays: ["wss://relay.example"],
  }),
  generateNostrConnectURI: () => h.connectUri,
}));
vi.mock("@/lib/clipboard", () => ({ writeClipboardText: h.writeClipboardText }));
vi.mock("@/hooks/useToast", () => ({ toast: h.toast }));
vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => false }));
vi.mock("@/hooks/useLoggedInAccounts", () => ({
  useLoggedInAccounts: () => ({ currentUser: null, accounts: [] }),
}));
vi.mock("@/lib/credentialManager", () => ({ getNsecCredential: async () => null }));
vi.mock("@/lib/shareOrigin", () => ({ shareOrigin: () => "https://armada.buzz" }));
vi.mock("@/components/auth/AndroidSignerOptions", () => ({ AndroidSignerOptions: () => null }));

import LoginScreen from "@/components/auth/LoginScreen";
import { NOSTR_CONNECT_PERMS } from "@/lib/nostrConnectPerms";

/** Desktop login, then "Connect remote signer" from the input's overflow menu. */
const openConnectQr = async () => {
  const trigger = screen.getByRole("button", { name: "More login options" });
  // jsdom has no `PointerEvent`, so the pointerdown Radix opens menus with is not
  // deliverable here; the keyboard path opens the same menu.
  fireEvent.keyDown(trigger, { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Connect remote signer" }));
  // The QR paints from a promise; awaiting it keeps the state update inside act.
  await screen.findByRole("img", { name: "QR code" });
};

/** The URI as the app built it, perms included. */
const CONNECT_URI = `${h.connectUri}&perms=${encodeURIComponent(NOSTR_CONNECT_PERMS)}`;

const renderLogin = () =>
  render(<LoginScreen isOpen onClose={vi.fn()} onLogin={vi.fn()} />);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("LoginScreen signer link", () => {
  it("offers the QR's link as text and copies exactly that", async () => {
    renderLogin();
    await openConnectQr();

    const field = (await screen.findByLabelText("Signer connect link")) as HTMLInputElement;
    expect(field.value).toBe(CONNECT_URI);
    expect(field.readOnly).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));

    await waitFor(() => expect(h.writeClipboardText).toHaveBeenCalledWith(CONNECT_URI));
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Link copied" }),
    );
    expect(await screen.findByRole("button", { name: "Link copied" })).toBeInTheDocument();
  });

  it("reports a refused clipboard without claiming the link was copied", async () => {
    h.writeClipboardText.mockRejectedValueOnce(new Error("Clipboard write is not available."));
    renderLogin();
    await openConnectQr();

    fireEvent.click(await screen.findByRole("button", { name: "Copy link" }));

    await waitFor(() =>
      expect(h.toast).toHaveBeenCalledWith(
        expect.objectContaining({ variant: "destructive" }),
      ),
    );
    // Still offering to copy: the failure must not look like the checkmark state.
    expect(screen.getByRole("button", { name: "Copy link" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Link copied" })).not.toBeInTheDocument();
  });
});
