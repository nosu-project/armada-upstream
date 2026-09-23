import { fireEvent, render, screen } from "@testing-library/react";
import { Ban, UserMinus } from "lucide-react";
import { describe, expect, it, vi } from "vitest";

import { MemberModerationActions } from "./MemberModerationActions";

import { MemberActionsContext, type MemberActionItem } from "@/contexts/MemberActionsContext";

function renderWith(actions: MemberActionItem[] | undefined, onAction?: () => void) {
  const ui = <MemberModerationActions pubkey="abc" onAction={onAction} />;
  if (!actions) return render(ui);
  return render(
    <MemberActionsContext.Provider value={{ actionsFor: () => actions }}>
      {ui}
    </MemberActionsContext.Provider>,
  );
}

const kick: MemberActionItem = { id: "kick", label: "Kick", icon: UserMinus, onSelect: vi.fn() };

describe("MemberModerationActions", () => {
  it("renders nothing outside a scope that provides actions", () => {
    // The card is shared with DMs and bare profiles, which provide no context.
    const { container } = renderWith(undefined);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for a member the viewer has no authority over", () => {
    const { container } = renderWith([]);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a button per action, under a Moderation heading", () => {
    renderWith([kick, { id: "ban", label: "Ban & lock out", icon: Ban, destructive: true, onSelect: vi.fn() }]);
    expect(screen.getByText("Moderation")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Kick" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ban & lock out" })).toBeInTheDocument();
  });

  it("uses the provider's label, so a backend keeps its own vocabulary", () => {
    renderWith([{ id: "ban", label: "Ban", icon: Ban, destructive: true, onSelect: vi.fn() }]);
    expect(screen.getByRole("button", { name: "Ban" })).toBeInTheDocument();
  });

  it("styles a destructive action distinctly from a plain one", () => {
    renderWith([kick, { id: "ban", label: "Ban", icon: Ban, destructive: true, onSelect: vi.fn() }]);
    expect(screen.getByRole("button", { name: "Ban" }).className).toContain("text-destructive");
    expect(screen.getByRole("button", { name: "Kick" }).className).not.toContain("text-destructive");
  });

  it("closes the surrounding surface BEFORE running the action", () => {
    // The popover holding this unmounts on close; an action that opened a
    // dialog first would have it torn down in the same tick.
    const order: string[] = [];
    renderWith(
      [{ id: "ban", label: "Ban", icon: Ban, destructive: true, onSelect: () => order.push("action") }],
      () => order.push("close"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Ban" }));
    expect(order).toEqual(["close", "action"]);
  });

  it("runs the action without an onAction handler", () => {
    const onSelect = vi.fn();
    renderWith([{ id: "kick", label: "Kick", icon: UserMinus, onSelect }]);
    fireEvent.click(screen.getByRole("button", { name: "Kick" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
