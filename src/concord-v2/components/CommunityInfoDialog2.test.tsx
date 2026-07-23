import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CommunityV2 } from "@/concord-v2/lib/types";
import { ConnectedRepositoriesSection } from "./CommunityInfoDialog2";

const h = vi.hoisted(() => ({
  attach: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock("@nostrify/react", () => ({ useNostr: () => ({ nostr: {} }) }));
vi.mock("@/concord-v2/hooks/useControlPlane2", () => ({
  useChannels2: () => [{ idHex: "channel", name: "general" }],
  useControlFold2: () => ({ data: { channels: new Map([["channel", { metadata: { name: "general", private: false } }]]) } }),
}));
vi.mock("@/concord-v2/hooks/useCommunityActions2", () => ({
  useCommunityManagement2: () => ({ attachRepository: h.attach, detachRepository: vi.fn() }),
}));
vi.mock("@/lib/gitRepositoryResolver", () => ({
  resolveGitRepositoryAnnouncement: h.resolve,
  fetchGitRepositoryAnnouncement: vi.fn(),
}));
vi.mock("@/hooks/useToast", () => ({ toast: vi.fn() }));

const community = { idHex: "community" } as CommunityV2;

function renderSection(canManage: boolean) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}><ConnectedRepositoriesSection community={community} canManage={canManage} /></QueryClientProvider>);
}

describe("ConnectedRepositoriesSection", () => {
  beforeEach(() => vi.clearAllMocks());

  it("only shows repository management controls to channel managers", () => {
    renderSection(false);
    expect(screen.queryByRole("button", { name: "Connect repository" })).not.toBeInTheDocument();
    expect(screen.getByText("No repositories connected.")).toBeInTheDocument();
  });

  it("resolves and attaches a repository to the chosen channel", async () => {
    h.attach.mockResolvedValue(undefined);
    h.resolve.mockResolvedValue({
      address: { coordinate: `30617:${"a".repeat(64)}:armada` },
      relayHints: ["wss://git.example"],
      announcement: { name: "Armada" },
    });
    renderSection(true);
    fireEvent.click(screen.getByRole("button", { name: "Connect repository" }));
    fireEvent.change(screen.getByPlaceholderText("naddr or nostr://owner/repository"), { target: { value: "naddr1example" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(h.attach).toHaveBeenCalledWith({
      channelIdHex: "channel",
      address: `30617:${"a".repeat(64)}:armada`,
      relayHints: ["wss://git.example"],
    }));
  });

  it("shows resolver errors without attempting an attachment", async () => {
    h.resolve.mockRejectedValue(new Error("Repository announcement not found."));
    renderSection(true);
    fireEvent.click(screen.getByRole("button", { name: "Connect repository" }));
    fireEvent.change(screen.getByPlaceholderText("naddr or nostr://owner/repository"), { target: { value: "bad" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Repository announcement not found.");
    expect(h.attach).not.toHaveBeenCalled();
  });
});
