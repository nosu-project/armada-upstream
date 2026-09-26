import { render, screen } from "@testing-library/react";
import { Suspense } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { Nip19Route } from "@/components/Nip19Route";

vi.mock("@/pages/NaddrPage", () => ({ NaddrPage: () => <p>naddr page</p> }));
vi.mock("@/pages/UserPage", () => ({ UserPage: () => <p>user page</p> }));

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Suspense fallback={null}>
        <Routes>
          <Route path="/:user" element={<Nip19Route />} />
        </Routes>
      </Suspense>
    </MemoryRouter>,
  );
}

describe("Nip19Route", () => {
  it("sends an naddr segment to NaddrPage", async () => {
    renderAt("/naddr1qvzqqqr4gupzqexample");
    expect(await screen.findByText("naddr page")).toBeInTheDocument();
    expect(screen.queryByText("user page")).toBeNull();
  });

  it("matches the naddr prefix case-insensitively", async () => {
    renderAt("/NADDR1QVZQQQR4GUPZQEXAMPLE");
    expect(await screen.findByText("naddr page")).toBeInTheDocument();
  });

  it.each([
    "/npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m",
    "/nprofile1qqsexample",
    "/alice@example.com",
    "/example.com",
    "/note1naddr1",
  ])("sends %s to UserPage", async (path) => {
    renderAt(path);
    expect(await screen.findByText("user page")).toBeInTheDocument();
    expect(screen.queryByText("naddr page")).toBeNull();
  });
});
