import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { NewChannelDialog } from "@/concord/components/NewChannelDialog";

vi.mock("@/hooks/useToast", () => ({ toast: vi.fn() }));

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
  fireEvent.click(screen.getByText("Text channel"));
  return { onCreateText };
}

const typeName = (value: string) =>
  fireEvent.change(screen.getByPlaceholderText(NAME_PLACEHOLDER), { target: { value } });
const submit = () => fireEvent.click(screen.getByRole("button", { name: "Create channel" }));

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
