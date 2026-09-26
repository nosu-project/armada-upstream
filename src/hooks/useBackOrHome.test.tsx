import { act, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";

import { useBackOrHome } from "./useBackOrHome";

function Page({ fallback }: { fallback?: string }) {
  const back = useBackOrHome(fallback);
  const { pathname } = useLocation();
  return (
    <>
      <p data-testid="at">{pathname}</p>
      <button type="button" onClick={back}>Back</button>
    </>
  );
}

// The hook reads the BROWSER history's entry index, which a memory router
// doesn't write, so each test sets the `idx` a data router would have left.
function setIdx(idx: number | undefined) {
  window.history.replaceState(idx === undefined ? null : { idx }, "");
}

function renderAt(entries: string[], fallback?: string) {
  const router = createMemoryRouter(
    [{ path: "*", element: <Page fallback={fallback} /> }],
    { initialEntries: entries, initialIndex: entries.length - 1 },
  );
  render(<RouterProvider router={router} />);
  return router;
}

afterEach(() => setIdx(undefined));

describe("useBackOrHome", () => {
  it("steps back when the app has an entry behind this one", async () => {
    setIdx(1);
    const router = renderAt(["/somewhere", "/changelog"]);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Back" })));
    expect(screen.getByTestId("at")).toHaveTextContent("/somewhere");
    expect(router.state.historyAction).toBe("POP");
  });

  it("replaces a cold load with home rather than leaving the app", async () => {
    setIdx(0);
    const router = renderAt(["/changelog"]);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Back" })));
    expect(screen.getByTestId("at")).toHaveTextContent(/^\/$/);
    expect(router.state.historyAction).toBe("REPLACE");
  });

  it("treats a missing index as a cold load and honours the fallback", async () => {
    setIdx(undefined);
    renderAt(["/c/abc/audit"], "/c/abc");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Back" })));
    expect(screen.getByTestId("at")).toHaveTextContent("/c/abc");
  });
});
