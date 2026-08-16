import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { NotifLevelIcon } from "./NotifLevelMenu";

describe("NotifLevelIcon", () => {
  it("only renders indicators for muted and mentions-only channels", () => {
    const { rerender } = render(<NotifLevelIcon level="all" />);
    expect(screen.queryByLabelText(/notify|muted/i)).toBeNull();

    rerender(<NotifLevelIcon level="mentions" />);
    expect(screen.getByLabelText("Only mentions notify")).toBeTruthy();

    rerender(<NotifLevelIcon level="nothing" />);
    expect(screen.getByLabelText("Notifications muted")).toBeTruthy();
  });
});
