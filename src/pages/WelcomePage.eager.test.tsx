import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { WelcomePage } from "@/pages/WelcomePage";

/**
 * The landing page's whole performance contract, pinned.
 *
 * `WelcomePage` is statically imported by `AppRouter` so it rides in the entry
 * chunk: a signed-out visitor at `/` gets the landing on the first frame React
 * mounts, with no route chunk to fetch first and no Suspense boundary in
 * between. Both halves matter and both are asserted here, because either can
 * be undone by an ordinary-looking edit:
 *
 *  - Adding a static import of something heavy (the login dialog, the wizard,
 *    `ProfileSettings`) would put it back in the entry chunk. Nothing in a
 *    unit test can see chunk boundaries, so what is checked instead is the
 *    observable consequence of them being lazy: neither is in the tree until
 *    it is asked for.
 *  - Making the page itself lazy again — or wrapping the landing in a
 *    Suspense-triggering child — would show up as the landing NOT being
 *    present synchronously, which is what the first assertion catches.
 */
describe("WelcomePage (the signed-out landing)", () => {
  it("renders the landing synchronously, with nothing to await", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <WelcomePage />
      </MemoryRouter>,
    );

    // No `findBy`, no `await act`: it is either in the first commit or the
    // page has stopped being eager. (Two of them — the deck opens and closes
    // on the same CTA.)
    expect(screen.getAllByRole("button", { name: "Join" }).length).toBeGreaterThan(0);
  });

  it("does not mount the login dialog or the wizard until asked", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <WelcomePage />
      </MemoryRouter>,
    );

    // The login dialog's own heading, and the wizard's first step. Neither is
    // reachable without a tap, so neither chunk is on the boot path.
    expect(screen.queryByRole("heading", { name: /log in/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/generate my key/i)).not.toBeInTheDocument();
  });
});
