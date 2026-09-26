import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DetailPage } from "@/components/layout/DetailPage";

const h = vi.hoisted(() => ({ navigate: vi.fn() }));

vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => h.navigate,
}));
vi.mock("@/components/layout/ServerRail", () => ({ ServerRail: () => null }));

function clickBack(state: unknown) {
  window.history.replaceState(state, "");
  render(<DetailPage title="Thing">body</DetailPage>);
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
}

describe("DetailPage back button", () => {
  afterEach(() => {
    h.navigate.mockReset();
    window.history.replaceState(null, "");
  });

  it("goes back when the previous entry is in the app", () => {
    clickBack({ idx: 2 });
    expect(h.navigate).toHaveBeenCalledWith(-1);
  });

  it("goes home on a cold load, even when the tab has earlier history", () => {
    window.history.pushState(null, "", "/elsewhere");
    expect(window.history.length).toBeGreaterThan(1);
    clickBack({ idx: 0 });
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true });
  });

  it("goes home when the router has left no index", () => {
    clickBack(null);
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true });
  });
});
