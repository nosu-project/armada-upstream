import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { VolumeSliderRow } from "@/components/VoiceUserContextMenu";

describe("VolumeSliderRow", () => {
  it("exposes the full 0 to 200 percent user range", () => {
    render(<VolumeSliderRow volume={2} apply={vi.fn()} displayName="Alice" />);

    const slider = screen.getByRole("slider", { name: "Volume for Alice" });
    expect(slider).toHaveAttribute("aria-valuemin", "0");
    expect(slider).toHaveAttribute("aria-valuemax", "2");
    expect(slider).toHaveAttribute("aria-valuenow", "2");
    expect(slider).toHaveAttribute("aria-valuetext", "200%");
  });

  it("labels screen-share volume and mute separately", () => {
    const apply = vi.fn();
    render(
      <VolumeSliderRow
        volume={1.5}
        apply={apply}
        displayName="Alice"
        target="screenShare"
      />,
    );

    const slider = screen.getByRole("slider", { name: "Screen share volume for Alice" });
    expect(slider).toHaveAttribute("aria-valuemax", "2");
    expect(slider).toHaveAttribute("aria-valuetext", "150%");
    fireEvent.click(screen.getByRole("button", { name: "Mute screen share" }));
    expect(apply).toHaveBeenCalledWith(0);
  });
});
