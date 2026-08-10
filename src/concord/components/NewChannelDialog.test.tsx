import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { NewChannelDialog } from "@/concord/components/NewChannelDialog";

vi.mock("@/hooks/useToast", () => ({ toast: vi.fn() }));

// The picker queries the relay pool for the ngit directory, which needs a
// NostrProvider; these tests only care that it is what the git door leads to.
vi.mock("@/components/projects/RepositoryPicker", () => ({
  RepositoryPicker: () => <div>repository picker</div>,
  OwnerAvatar: () => null,
  OwnerSlashRepo: () => null,
}));

const NAME_PLACEHOLDER = "e.g. general, memes, dev-talk";

function setup() {
  const onCreateText = vi.fn(async () => {});
  render(
    <NewChannelDialog
      open
      onOpenChange={vi.fn()}
      connectedCoordinates={new Set()}
      onCreateText={onCreateText}
      onCreateRepository={vi.fn(async () => {})}
    />,
  );
  // No chooser step to get past: a text channel is what the dialog opens on.
  return { onCreateText };
}

const typeName = (value: string) =>
  fireEvent.change(screen.getByPlaceholderText(NAME_PLACEHOLDER), { target: { value } });
const submit = () => fireEvent.click(screen.getByRole("button", { name: "Create channel" }));

describe("NewChannelDialog — the default path", () => {
  it("opens on the text channel form, with the repository path a step away", () => {
    setup();

    // Typing a name is possible on open; it used to cost a chooser step first.
    expect(screen.getByPlaceholderText(NAME_PLACEHOLDER)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create channel" })).toBeInTheDocument();

    // Git is a secondary door, not half of a chooser.
    fireEvent.click(screen.getByRole("button", { name: /connect a git repository/i }));
    expect(screen.getByText("repository picker")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(NAME_PLACEHOLDER)).not.toBeInTheDocument();

    // And it comes back to the form, which is the step behind it now.
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByPlaceholderText(NAME_PLACEHOLDER)).toBeInTheDocument();
  });
});

describe("NewChannelDialog — privacy controls reach the create call", () => {
  it("creates a PRIVATE channel by default when the box is left alone", async () => {
    const { onCreateText } = setup();

    typeName("secrets");
    submit();

    await waitFor(() => expect(onCreateText).toHaveBeenCalled());
    expect(onCreateText).toHaveBeenCalledWith("secrets", { isPrivate: true });
  });

  it("creates a public channel when the box is unticked AFTER the name is typed", async () => {
    // The natural order of operations: name first, then decide it's public.
    // A submit handler closed over a stale `isPrivate` would ignore the
    // untick and mint a private key + role for a channel meant to be open.
    const { onCreateText } = setup();

    typeName("general");
    fireEvent.click(screen.getByRole("checkbox", { name: /Private channel/i }));
    submit();

    await waitFor(() => expect(onCreateText).toHaveBeenCalled());
    expect(onCreateText).toHaveBeenCalledWith("general", undefined);
  });
});
