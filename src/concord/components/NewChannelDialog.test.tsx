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

  it("carries a typed access role name: the role's name is not chained to the channel's", async () => {
    // The binding is the role's scope (CORD-04 §2), the name is display; a
    // channel #planning gated by an "editors" role is the whole point.
    const { onCreateText } = setup();

    typeName("planning");
    fireEvent.change(screen.getByLabelText("Access role name"), { target: { value: "editors" } });
    submit();

    await waitFor(() => expect(onCreateText).toHaveBeenCalled());
    expect(onCreateText).toHaveBeenCalledWith("planning", { isPrivate: true, accessRoleName: "editors" });
  });

  it("hides the role name field for a public channel and drops a stale draft", async () => {
    // Untick after typing a role name: the channel is public, so no role is
    // minted and the drafted name must not leak into the call.
    const { onCreateText } = setup();

    typeName("general");
    fireEvent.change(screen.getByLabelText("Access role name"), { target: { value: "editors" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Private channel/i }));
    expect(screen.queryByLabelText("Access role name")).not.toBeInTheDocument();
    submit();

    await waitFor(() => expect(onCreateText).toHaveBeenCalled());
    expect(onCreateText).toHaveBeenCalledWith("general", undefined);
  });
});

describe("NewChannelDialog — the forum option reaches the create call", () => {
  it("opens as a text channel, and chat rides as an absent view", async () => {
    // `chat` is the default; writing it explicitly would make two clients
    // holding the same state serialize different bytes (channelView.ts).
    const { onCreateText } = setup();
    expect(screen.getByRole("radio", { name: /Text/ })).toHaveAttribute("aria-checked", "true");

    typeName("general");
    fireEvent.click(screen.getByRole("checkbox", { name: /Private channel/i }));
    submit();

    await waitFor(() => expect(onCreateText).toHaveBeenCalled());
    expect(onCreateText).toHaveBeenCalledWith("general", undefined);
  });

  it("carries view: forum when the forum card is picked, beside the privacy options", async () => {
    const { onCreateText } = setup();

    fireEvent.click(screen.getByRole("radio", { name: /Forum/ }));
    typeName("proposals");
    submit();

    await waitFor(() => expect(onCreateText).toHaveBeenCalled());
    expect(onCreateText).toHaveBeenCalledWith("proposals", { isPrivate: true, view: "forum" });
  });

  it("a public forum passes only the view", async () => {
    const { onCreateText } = setup();

    fireEvent.click(screen.getByRole("radio", { name: /Forum/ }));
    // The subtitle follows the choice.
    expect(screen.getByText(/Titled posts with comments/)).toBeInTheDocument();
    typeName("help");
    fireEvent.click(screen.getByRole("checkbox", { name: /Private channel/i }));
    submit();

    await waitFor(() => expect(onCreateText).toHaveBeenCalled());
    expect(onCreateText).toHaveBeenCalledWith("help", { view: "forum" });
  });
});
