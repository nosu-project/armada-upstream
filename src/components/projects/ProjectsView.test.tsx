import { render, screen } from "@testing-library/react";
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
