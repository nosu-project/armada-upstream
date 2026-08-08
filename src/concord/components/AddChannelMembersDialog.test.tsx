import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AddChannelMembersDialog } from "@/concord/components/AddChannelMembersDialog";

vi.mock("@/hooks/useToast", () => ({ toast: vi.fn() }));
vi.mock("@/hooks/useEventStore", () => ({ useEventStore: () => ({}) }));
vi.mock("@/hooks/useAuthor", () => ({
  useAuthor: () => ({ data: undefined }),
  authorQueryOptions: (_qc: unknown, _es: unknown, pk: string) => ({
    queryKey: ["author", pk],
    queryFn: async () => ({}),
  }),
}));
vi.mock("@/hooks/useScopedDisplayName", () => ({
  useScopedDisplayName: (pk: string) => pk.slice(0, 4),
}));
vi.mock("@/components/DisplayName", () => ({
  DisplayName: ({ name }: { name: string }) => <span>{name}</span>,
}));

const ALICE = "a1ce".padEnd(64, "0");
const BOB = "b0b0".padEnd(64, "0");
const ROLE = "role-1";

function setup(over: Partial<Parameters<typeof AddChannelMembersDialog>[0]> = {}) {
  const onAdd = vi.fn(async () => {});
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <AddChannelMembersDialog
        open
        onOpenChange={vi.fn()}
        channelName="secrets"
        candidates={[ALICE, BOB]}
        roles={[{ id: ROLE, name: "secrets" }]}
        onAdd={onAdd}
        isAdding={() => false}
        hasRole={() => false}
        holdsKey
        {...over}
      />
    </QueryClientProvider>,
  );
  return { onAdd };
}

describe("AddChannelMembersDialog", () => {
  it("adds a candidate by granting the channel's role", () => {
    const { onAdd } = setup();

    fireEvent.click(screen.getByRole("button", { name: `Add ${ALICE.slice(0, 4)}` }));

    expect(onAdd).toHaveBeenCalledWith(ALICE, ROLE);
  });

  it("marks a member the local intent already granted as Added, not addable", () => {
    // The fold lags the publish, so `candidates` still lists them; the row
    // must reflect the grant instead of offering a second one.
    const { onAdd } = setup({ hasRole: (pk) => pk === ALICE });

    expect(screen.getByText("Added")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: `Add ${ALICE.slice(0, 4)}` })).not.toBeInTheDocument();
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("says so when everyone already has access", () => {
    setup({ candidates: [] });

    expect(screen.getByText("Everyone in the community already has access to this channel.")).toBeInTheDocument();
  });

  it("warns when the viewer cannot vend the key", () => {
    setup({ holdsKey: false });

    expect(screen.getByText(/You don't hold this channel's key/)).toBeInTheDocument();
  });
});
