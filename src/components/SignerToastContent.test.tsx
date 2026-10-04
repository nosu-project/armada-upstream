import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { NudgeToastContent } from "./SignerToastContent";

describe("NudgeToastContent", () => {
  it("links to the signer app, then waits with a Cancel once tapped", () => {
    const onCancel = vi.fn();
    render(
      <NudgeToastContent
        description="Your signer hasn't answered yet."
        openSigner={[{ href: "nostrsigner:", label: "Open signer" }]}
        onCancel={onCancel}
      />,
    );
    const link = screen.getByRole("link", { name: "Open signer" });
    expect(link).toHaveAttribute("href", "nostrsigner:");
    expect(screen.getByRole("button", { name: "Skip" })).toBeInTheDocument();

    // jsdom can't follow a custom scheme; the click handler is what matters.
    link.addEventListener("click", (e) => e.preventDefault());
    fireEvent.click(link);
    expect(screen.getByText("Waiting for signer…")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("offers one button per candidate signer app", () => {
    render(
      <NudgeToastContent
        description="Your signer hasn't answered yet."
        openSigner={[{ href: "clave://", label: "Open Clave" }, { href: "aegis://", label: "Open Aegis" }]}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByRole("link", { name: "Open Clave" })).toHaveAttribute("href", "clave://");
    expect(screen.getByRole("link", { name: "Open Aegis" })).toHaveAttribute("href", "aegis://");
  });

  it("offers only Skip when there is no signer app to open", () => {
    render(<NudgeToastContent description="Approve the request in your signer." onCancel={() => {}} />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Skip" })).toBeInTheDocument();
  });
});
