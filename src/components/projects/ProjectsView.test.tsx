import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { NostrEvent } from "@nostrify/nostrify";

import { ProjectsView } from "@/components/projects/ProjectsView";
import type { ProjectRepo, ProjectWorkItem } from "@/components/projects/projectData";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("@/hooks/useAuthor", () => ({ useAuthor: () => ({ data: undefined }) }));
vi.mock("@/hooks/useScopedDisplayName", () => ({ useScopedDisplayName: () => "someone" }));
vi.mock("@/hooks/useToast", () => ({ toast: vi.fn() }));
vi.mock("@/lib/clipboard", () => ({ writeClipboardText: () => Promise.resolve() }));

const OWNER = "a".repeat(64);
const ARMADA = `30617:${OWNER}:armada`;
const CLIENT = `30617:${OWNER}:client`;
const NOW = Math.floor(Date.now() / 1000);

const event = { id: "", pubkey: OWNER, created_at: 0, kind: 1621, content: "", tags: [], sig: "" } as NostrEvent;

function repo(coord: string, name: string): ProjectRepo {
  return { coord, owner: OWNER, id: name, name, cloneUrls: [], contributors: [], createdAt: NOW - 1_000 };
}

function issue(overrides: Partial<ProjectWorkItem> & { id: string; title: string }): ProjectWorkItem {
  return {
    kind: "issue",
    content: "",
    author: OWNER,
    createdAt: NOW - 100,
    repoCoord: ARMADA,
    status: "open",
    event,
    ...overrides,
  };
}

const repos = [repo(ARMADA, "armada"), repo(CLIENT, "client")];
const items: ProjectWorkItem[] = [
  // Opened long ago, commented on minutes ago.
  issue({ id: "1", title: "Stale thing", createdAt: NOW - 900_000, updatedAt: NOW - 60 }),
  // Opened recently, untouched since.
  issue({ id: "2", title: "Fresh thing", createdAt: NOW - 3_600 }),
  issue({ id: "3", title: "Other project bug", repoCoord: CLIENT, labels: ["bug"] }),
];

function renderView() {
  return render(
    <TooltipProvider>
      <ProjectsView repos={repos} items={items} isLoading={false} />
    </TooltipProvider>,
  );
}

describe("ProjectsView ordering", () => {
  it("leads the overview feed with the most recently active item, not the newest", () => {
    renderView();
    const titles = screen.getAllByText(/thing$/).map((node) => node.textContent);
    expect(titles).toEqual(["Stale thing", "Fresh thing"]);
  });

  it("labels a bumped row with its activity time and keeps the opening in reach", () => {
    renderView();
    expect(screen.getByText(/^updated /)).toBeInTheDocument();
  });
});

describe("ProjectsView search", () => {
  it("narrows a list to matching items", () => {
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "Issues" }));
    expect(screen.getByText("Fresh thing")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "Search" }), { target: { value: "stale" } });
    expect(screen.getByText("Stale thing")).toBeInTheDocument();
    expect(screen.queryByText("Fresh thing")).not.toBeInTheDocument();
  });

  it("requires every term", () => {
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "Issues" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search" }), { target: { value: "stale fresh" } });
    expect(screen.queryByText("Stale thing")).not.toBeInTheDocument();
    expect(screen.getByText("Nothing matches the current filters.")).toBeInTheDocument();
  });

  it("focuses the search box on '/' but leaves editable targets alone", () => {
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "Issues" }));
    const search = screen.getByRole("textbox", { name: "Search" });

    fireEvent.keyDown(document.body, { key: "/" });
    expect(document.activeElement).toBe(search);

    const elsewhere = document.createElement("textarea");
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    fireEvent.keyDown(elsewhere, { key: "/" });
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });
});

describe("ProjectsView repository scope", () => {
  it("scopes the workspace to one repository and offers a way back", () => {
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "Repositories" }));
    fireEvent.click(screen.getByRole("button", { name: "Show client activity" }));

    // Back on the overview, showing only that repository's work.
    expect(screen.getByText("Other project bug")).toBeInTheDocument();
    expect(screen.queryByText("Stale thing")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show every repository" }));
    expect(screen.getByText("Stale thing")).toBeInTheDocument();
  });

  it("keeps every repository listed while one is the active scope", () => {
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "Repositories" }));
    fireEvent.click(screen.getByRole("button", { name: "Show client activity" }));
    fireEvent.click(screen.getByRole("button", { name: "Repositories" }));

    expect(screen.getByRole("button", { name: "Show armada activity" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show client activity" })).toHaveAttribute("aria-pressed", "true");
  });
});
