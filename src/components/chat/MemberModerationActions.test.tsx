import { fireEvent, render, screen } from "@testing-library/react";
import { Ban, UserMinus } from "lucide-react";
import { describe, expect, it, vi } from "vitest";

import { MemberModerationActions } from "./MemberModerationActions";

import type { RolePickerOption } from "@/components/chat/RolePickerItems";
import { MemberActionsContext, type MemberActionItem, type MemberRolePicker } from "@/contexts/MemberActionsContext";

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

describe("MemberModerationActions role picker", () => {
  const catalog: RolePickerOption[] = [
    { id: "r-helper", name: "Helper", color: 0, assignable: true },
    { id: "r-access", name: "Insiders", color: 0, channelName: "secrets", assignable: true },
    { id: "r-orphan", name: "Old access", color: 0, channelName: null, assignable: true },
    { id: "r-admin", name: "Admin", color: 0, assignable: false },
  ];

  function renderPicker(picker: MemberRolePicker | undefined, actions: MemberActionItem[] = [], onAction?: () => void) {
    return render(
      <MemberActionsContext.Provider value={{ actionsFor: () => actions, rolePickerFor: () => picker }}>
        <MemberModerationActions pubkey="abc" onAction={onAction} />
      </MemberActionsContext.Provider>,
    );
  }

  const picker = (over: Partial<MemberRolePicker> = {}): MemberRolePicker => ({
    catalog,
    heldRoleIds: ["r-helper"],
    isToggling: () => false,
    onToggle: vi.fn(),
    ...over,
  });

  const openRoles = () => {
    // Radix opens a DropdownMenu on pointerdown or a key, never on click, and
    // jsdom's synthetic pointer events carry no `button` for it to check.
    fireEvent.keyDown(screen.getByRole("button", { name: /Roles/ }), { key: "Enter" });
  };

  it("renders nothing when the viewer may change none of this member's roles", () => {
    const { container } = renderPicker(undefined);
    expect(container).toBeEmptyDOMElement();
  });

  it("stands alone under a Roles heading when there is nothing to moderate", () => {
    // The owner's own card: a cosmetic self-assignment, no moderation implied.
    renderPicker(picker());
    expect(screen.getByText("Roles", { selector: "div" })).toBeInTheDocument();
    expect(screen.queryByText("Moderation")).not.toBeInTheDocument();
  });

  it("sits in the Moderation group beside the actions", () => {
    renderPicker(picker(), [kick]);
    expect(screen.getByText("Moderation")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Roles/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Kick" })).toBeInTheDocument();
  });

  it("lists every role, checked by holding and disabled past the viewer's rank", () => {
    renderPicker(picker());
    openRoles();
    expect(screen.getByRole("menuitemcheckbox", { name: /Helper/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemcheckbox", { name: /Insiders/ })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("menuitemcheckbox", { name: /Admin/ })).toHaveAttribute("data-disabled");
  });

  it("names a live scoped channel and no deleted one", () => {
    renderPicker(picker());
    openRoles();
    expect(screen.getByRole("menuitemcheckbox", { name: /Insiders/ })).toHaveTextContent("# secrets");
    expect(screen.getByRole("menuitemcheckbox", { name: /Old access/ })).not.toHaveTextContent("#");
  });

  it("toggles through the provider and leaves the card open", () => {
    const onToggle = vi.fn();
    const onAction = vi.fn();
    renderPicker(picker({ onToggle }), [], onAction);
    openRoles();
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /Insiders/ }));
    expect(onToggle).toHaveBeenCalledWith("abc", "r-access", true);
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /Helper/ }));
    expect(onToggle).toHaveBeenCalledWith("abc", "r-helper", false);
    // Several roles in one visit, with the chips above updating in place.
    expect(onAction).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("disables a role while its toggle is still publishing", () => {
    renderPicker(picker({ isToggling: (_pk, roleId) => roleId === "r-access" }));
    openRoles();
    expect(screen.getByRole("menuitemcheckbox", { name: /Insiders/ })).toHaveAttribute("data-disabled");
    expect(screen.getByRole("menuitemcheckbox", { name: /Helper/ })).not.toHaveAttribute("data-disabled");
  });
});
