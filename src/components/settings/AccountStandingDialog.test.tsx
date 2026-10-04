import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";

import { AccountStandingDialog } from "./AccountStandingDialog";

function renderDialog() {
  return render(
    <TooltipProvider>
      <AccountStandingDialog open onOpenChange={() => {}} />
    </TooltipProvider>,
  );
}

describe("AccountStandingDialog", () => {
  it("keeps the punchline verbatim", () => {
    renderDialog();
    expect(screen.getByRole("button", { name: "We can't ban you." })).toBeInTheDocument();
  });

  it("toggles the explanation on tap, since touch never hovers", () => {
    renderDialog();
    const punchline = screen.getByRole("button", { name: "We can't ban you." });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    // A real tap: pointerdown and focus precede the click. Radix's trigger
    // closes an open tooltip on pointerdown and opens one on focus — neither
    // may be undone by the click's toggle.
    const tap = () => {
      fireEvent.pointerDown(punchline);
      punchline.focus();
      fireEvent.click(punchline);
    };
    tap();
    expect(screen.getByRole("tooltip")).toHaveTextContent(/no Armada account to ban/);

    tap();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
});
