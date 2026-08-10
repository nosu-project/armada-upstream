import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Community } from "@/concord/lib/types";
import { ConnectedRepositoriesSection } from "./CommunitySettingsView";

const h = vi.hoisted(() => ({
  attach: vi.fn(),
  resolve: vi.fn(),
  // Per-test control-plane fold, so a test can give a channel an attachment.
  fold: { channels: new Map<string, unknown>([["channel", { metadata: { name: "general", private: false } }]]) },
}));

const OWNER = "a".repeat(64);
const ATTACHED = `30617:${"b".repeat(64)}:bitchat`;

vi.mock("@nostrify/react", () => ({ useNostr: () => ({ nostr: {} }) }));
vi.mock("@/concord/hooks/useControlPlane", () => ({
  useChannels: () => [{ idHex: "channel", name: "general" }],
  useControlFold: () => ({ data: h.fold }),
}));
vi.mock("@/concord/hooks/useCommunityActions", () => ({
  useCommunityManagement: () => ({ attachRepository: h.attach, detachRepository: vi.fn() }),
}));
vi.mock("@/lib/gitRepositoryResolver", () => ({
  resolveGitRepositoryAnnouncement: h.resolve,
  fetchGitRepositoryAnnouncement: vi.fn(),
}));
vi.mock("@/hooks/useToast", () => ({ toast: vi.fn() }));
// The picker's directory search is exercised by its own tests; here it stays
// empty so the pasted-address path is what drives the flow.
vi.mock("@/hooks/useGitRepositoryDirectory", () => ({
  useGitRepositoryDirectory: () => ({ data: [], isLoading: false, isError: false }),
  searchGitRepositories: () => [],
}));
vi.mock("@/hooks/useAuthor", () => ({ useAuthor: () => ({ data: undefined }) }));

const community = { idHex: "community" } as Community;
const SEARCH_PLACEHOLDER = "Search repositories, or paste an naddr / nostr:// address";

function renderSection(canManage: boolean) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const element = () => <QueryClientProvider client={queryClient}><ConnectedRepositoriesSection community={community} canManage={canManage} /></QueryClientProvider>;
  const view = render(element());
  // A fresh element each time, so a control-plane change is actually re-read.
  return { ...view, refresh: () => view.rerender(element()) };
}

/** Open the connect dialog and resolve a pasted address, landing on the channel step. */
function pasteAddress(value: string) {
  fireEvent.click(screen.getByRole("button", { name: "Connect repository" }));
  fireEvent.change(screen.getByPlaceholderText(SEARCH_PLACEHOLDER), { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: /Use this repository address/ }));
}

/** Give the one channel an active attachment for the duration of a test. */
function channelHoldsRepository() {
  h.fold.channels.set("channel", {
    metadata: {
      name: "general",
      private: false,
      custom: { "armada.git": { repositories: [{ address: ATTACHED, relayHints: ["wss://git.example"], attachedAt: 1 }] } },
    },
  });
}

describe("ConnectedRepositoriesSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.fold.channels.set("channel", { metadata: { name: "general", private: false } });
  });

  it("stays out of a community that has no repositories and no manager", () => {
    const { container } = renderSection(false);
    expect(container).toBeEmptyDOMElement();
  });

  it("offers a manager the empty section, so a first repository can be connected", () => {
    renderSection(true);
    expect(screen.getByRole("button", { name: "Connect repository" })).toBeInTheDocument();
    expect(screen.getByText("No repositories connected.")).toBeInTheDocument();
  });

  it("shows a connected repository to a member, without management controls", () => {
    channelHoldsRepository();
    renderSection(false);
    expect(screen.queryByRole("button", { name: "Connect repository" })).not.toBeInTheDocument();
    expect(screen.queryByText("No repositories connected.")).not.toBeInTheDocument();
  });

  it("resolves a pasted address and attaches it to the chosen channel", async () => {
    h.attach.mockResolvedValue(undefined);
    h.resolve.mockResolvedValue({
      address: { coordinate: `30617:${OWNER}:armada`, owner: OWNER, identifier: "armada" },
      relayHints: ["wss://git.example"],
      announcement: { name: "Armada" },
    });
    renderSection(true);
    pasteAddress("naddr1example");

    // Channel choice is its own step: attaching happens on that click, not on resolve.
    const channel = await screen.findByRole("button", { name: /general/ });
    expect(h.attach).not.toHaveBeenCalled();
    fireEvent.click(channel);

    await waitFor(() => expect(h.attach).toHaveBeenCalledWith({
      channelIdHex: "channel",
      address: `30617:${OWNER}:armada`,
      relayHints: ["wss://git.example"],
    }));
  });

  it("will not attach a second repository to a channel that already has one", async () => {
    channelHoldsRepository();
    h.resolve.mockResolvedValue({
      address: { coordinate: `30617:${OWNER}:armada`, owner: OWNER, identifier: "armada" },
      relayHints: ["wss://git.example"],
      announcement: { name: "Armada" },
    });
    renderSection(true);
    pasteAddress("naddr1example");

    const channel = await screen.findByRole("button", { name: /general/ });
    expect(channel).toBeDisabled();
    expect(channel).toHaveTextContent("Already connected to bitchat");
    fireEvent.click(channel);
    expect(h.attach).not.toHaveBeenCalled();
  });

  it("keeps the chosen channel pending while the attachment publishes", async () => {
    let settle: () => void = () => undefined;
    h.attach.mockImplementation(() => new Promise<void>((resolve) => { settle = resolve; }));
    h.resolve.mockResolvedValue({
      address: { coordinate: `30617:${OWNER}:armada`, owner: OWNER, identifier: "armada" },
      relayHints: ["wss://git.example"],
      announcement: { name: "Armada" },
    });
    const view = renderSection(true);
    pasteAddress("naddr1example");
    fireEvent.click(await screen.findByRole("button", { name: /general/ }));

    // The control plane folds our own write before the publish resolves; the
    // row must read as pending rather than "already connected", and the
    // all-taken notice must not fire on our own in-flight attachment.
    channelHoldsRepository();
    view.refresh();
    const channel = await screen.findByRole("button", { name: /general/ });
    expect(channel).toHaveTextContent("Connecting…");
    expect(channel).not.toHaveTextContent("Already connected");
    expect(screen.queryByText(/Every channel already has a repository/)).not.toBeInTheDocument();

    settle();
    await waitFor(() => expect(h.attach).toHaveBeenCalledTimes(1));
  });

  it("shows resolver errors without attempting an attachment", async () => {
    h.resolve.mockRejectedValue(new Error("Repository announcement not found."));
    renderSection(true);
    pasteAddress("naddr1bad");
    expect(await screen.findByRole("alert")).toHaveTextContent("Repository announcement not found.");
    expect(h.attach).not.toHaveBeenCalled();
  });
});
