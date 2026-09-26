import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RelayBootstrapForm } from "@/components/RelayBootstrapForm";
import { ExistingRelayListError } from "@/hooks/useNip65RelaySetup";

import type { NostrEvent } from "@nostrify/nostrify";

const h = vi.hoisted(() => ({
  config: {
    appRelays: ["wss://relay.one.example", "wss://relay.two.example"],
    relayMetadata: { relays: [], updatedAt: 0, pubkey: undefined as string | undefined },
  },
  user: { pubkey: "a".repeat(64) },
  publish: vi.fn(),
  discover: vi.fn(),
  discoverWithStatus: vi.fn(),
  adopt: vi.fn(),
}));

vi.mock("@/hooks/useAppContext", () => ({ useAppContext: () => ({ config: h.config }) }));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: h.user }) }));
vi.mock("@/hooks/useToast", () => ({ toast: vi.fn() }));
vi.mock("@/lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform")>()),
  RELAY_LIST_DISCOVERY_RELAYS: ["wss://index.one.example", "wss://index.two.example", "wss://index.three.example"],
}));
vi.mock("@/hooks/useNip65RelaySetup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useNip65RelaySetup")>()),
  useNip65RelaySetup: () => ({
    discover: h.discover,
    discoverWithStatus: h.discoverWithStatus,
    adopt: h.adopt,
    publish: h.publish,
  }),
}));

const BUTTON = "Use this app's relays";
const ALL_ANSWERED = [
  "wss://relay.one.example",
  "wss://relay.two.example",
  "wss://index.one.example",
  "wss://index.two.example",
  "wss://index.three.example",
];
const existing = {
  event: { id: "e".repeat(64), kind: 10002, created_at: 5, tags: [["r", "wss://mine.example"]] } as NostrEvent,
  relays: [{ url: "wss://mine.example", read: true, write: true }],
};

describe("RelayBootstrapForm", () => {
  beforeEach(() => {
    h.adopt.mockReset();
    h.publish.mockReset();
    h.publish.mockResolvedValue({ accepted: h.config.appRelays, rejected: [] });
    h.discoverWithStatus.mockReset();
    h.discoverWithStatus.mockResolvedValue({ events: [], answered: ALL_ANSWERED, failed: [] });
  });

  it("publishes the app's relays only after discovery confirms there is no list", async () => {
    const onDone = vi.fn();
    render(<RelayBootstrapForm onDone={onDone} onSkip={vi.fn()} />);

    expect(h.publish).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: BUTTON }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(h.discoverWithStatus).toHaveBeenCalledWith(h.config.appRelays);
    expect(h.publish).toHaveBeenCalledWith([
      { url: "wss://relay.one.example", read: true, write: true },
      { url: "wss://relay.two.example", read: true, write: true },
    ]);
  });

  it("adopts an existing list instead of publishing over it", async () => {
    h.discoverWithStatus.mockResolvedValue({
      events: [existing.event],
      answered: ["wss://index.one.example"],
      failed: [],
      discovery: existing,
    });
    const onDone = vi.fn();
    render(<RelayBootstrapForm onDone={onDone} />);

    fireEvent.click(screen.getByRole("button", { name: BUTTON }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(h.adopt).toHaveBeenCalledWith(existing);
    expect(h.publish).not.toHaveBeenCalled();
  });

  it("refuses to publish when too few relays answered to rule out an existing list", async () => {
    h.discoverWithStatus.mockResolvedValue({
      events: [],
      // One app relay and one index: enough for the old "any source answered" rule.
      answered: ["wss://relay.one.example", "wss://index.one.example"],
      failed: ["wss://relay.two.example"],
    });
    const onDone = vi.fn();
    render(<RelayBootstrapForm onDone={onDone} />);

    fireEvent.click(screen.getByRole("button", { name: BUTTON }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't reach enough relays");
    expect(h.publish).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("adopts the list the pre-sign refresh finds rather than reporting a change on another device", async () => {
    h.publish.mockRejectedValue(new ExistingRelayListError(existing));
    const onDone = vi.fn();
    render(<RelayBootstrapForm onDone={onDone} />);

    fireEvent.click(screen.getByRole("button", { name: BUTTON }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(h.adopt).toHaveBeenCalledWith(existing);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("offers to start fresh on a typed relay only once absence is confirmed", async () => {
    h.discoverWithStatus.mockResolvedValue({
      events: [],
      answered: ["wss://typed.example", ...ALL_ANSWERED],
      failed: [],
    });
    const onDone = vi.fn();
    render(<RelayBootstrapForm onDone={onDone} />);

    fireEvent.change(screen.getByLabelText("Relay address"), { target: { value: "wss://typed.example" } });
    fireEvent.click(screen.getByRole("button", { name: "Look up my setup" }));
    fireEvent.click(await screen.findByRole("button", { name: "Use this relay" }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(h.discoverWithStatus).toHaveBeenCalledWith(["wss://typed.example"]);
    expect(h.publish).toHaveBeenCalledWith([{ url: "wss://typed.example", read: true, write: true }]);
  });

  it("does not offer to create on a typed relay when the lookup couldn't be confirmed", async () => {
    h.discoverWithStatus.mockResolvedValue({
      events: [],
      // Every index answered, but the typed relay itself did not.
      answered: ALL_ANSWERED,
      failed: ["wss://typed.example"],
    });
    render(<RelayBootstrapForm />);

    fireEvent.change(screen.getByLabelText("Relay address"), { target: { value: "wss://typed.example" } });
    fireEvent.click(screen.getByRole("button", { name: "Look up my setup" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't reach enough relays");
    expect(screen.queryByRole("button", { name: "Use this relay" })).toBeNull();
    expect(h.publish).not.toHaveBeenCalled();
  });

  it("restores a list found on a typed relay", async () => {
    h.discoverWithStatus.mockResolvedValue({
      events: [existing.event],
      answered: ["wss://typed.example"],
      failed: [],
      discovery: existing,
    });
    const onDone = vi.fn();
    render(<RelayBootstrapForm onDone={onDone} />);

    fireEvent.change(screen.getByLabelText("Relay address"), { target: { value: "wss://typed.example" } });
    fireEvent.click(screen.getByRole("button", { name: "Look up my setup" }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(h.adopt).toHaveBeenCalledWith(existing);
    expect(h.publish).not.toHaveBeenCalled();
  });

  it("keeps the step open and shows the error when publishing fails", async () => {
    h.publish.mockRejectedValue(new Error("No relay accepted your signed relay list"));
    const onDone = vi.fn();
    render(<RelayBootstrapForm onDone={onDone} />);

    fireEvent.click(screen.getByRole("button", { name: BUTTON }));

    expect(await screen.findByRole("alert")).toHaveTextContent("No relay accepted");
    expect(onDone).not.toHaveBeenCalled();
  });
});
