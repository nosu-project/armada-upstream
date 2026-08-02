import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { NewChannelDialog2 } from "@/concord-v2/components/NewChannelDialog2";

vi.mock("@/hooks/useToast", () => ({ toast: vi.fn() }));

const NAME_PLACEHOLDER = "e.g. general, memes, dev-talk";

function setup() {
  const onCreateText = vi.fn(async () => {});
  render(
    <NewChannelDialog2
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

describe("NewChannelDialog2 — privacy controls reach the create call", () => {
  it("creates a PRIVATE channel when the box is ticked AFTER the name is typed", async () => {
    // The natural order of operations: name first, then decide it's private.
    // A submit handler closed over a stale `isPrivate` silently creates a
    // PUBLIC channel while reporting success — a privacy control failing open.
    const { onCreateText } = setup();

    typeName("secrets");
    fireEvent.click(screen.getByRole("checkbox", { name: /Private channel/i }));
    submit();

    await waitFor(() => expect(onCreateText).toHaveBeenCalled());
    expect(onCreateText).toHaveBeenCalledWith("secrets", { isPrivate: true });
  });

  it("still creates a public channel when the box is left alone", async () => {
    const { onCreateText } = setup();

    typeName("general");
    submit();

    await waitFor(() => expect(onCreateText).toHaveBeenCalled());
    expect(onCreateText).toHaveBeenCalledWith("general", undefined);
  });
});
