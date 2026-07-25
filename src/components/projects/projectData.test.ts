import { describe, expect, it } from "vitest";
import type { NostrEvent } from "@nostrify/nostrify";

import {
  labelSuggestions,
  repoMatchesQuery,
  sortProjectWorkItems,
  workItemActivityAt,
  workItemMatchesQuery,
  type ProjectRepo,
  type ProjectWorkItem,
} from "./projectData";

const event = { id: "", pubkey: "", created_at: 0, kind: 1621, content: "", tags: [], sig: "" } as NostrEvent;

function item(id: string, title: string, createdAt: number): ProjectWorkItem {
  return {
    id,
    kind: "issue",
    title,
    content: "",
    author: "a".repeat(64),
    createdAt,
    repoCoord: null,
    status: "open",
    event,
  };
}

describe("sortProjectWorkItems", () => {
  const items = [item("b", "Zebra", 100), item("a", "apple", 300), item("c", "Mango", 200)];

  it("orders newest first by default", () => {
    expect(sortProjectWorkItems(items, "updated").map((i) => i.id)).toEqual(["a", "c", "b"]);
  });

  it("orders by title, case-insensitively, when sorting by name", () => {
    expect(sortProjectWorkItems(items, "name").map((i) => i.title)).toEqual(["apple", "Mango", "Zebra"]);
  });

  it("breaks ties on id so the order is stable", () => {
    const sameTime = [item("y", "Same", 5), item("x", "Same", 5)];
    expect(sortProjectWorkItems(sameTime, "updated").map((i) => i.id)).toEqual(["x", "y"]);
    expect(sortProjectWorkItems(sameTime, "name").map((i) => i.id)).toEqual(["x", "y"]);
  });

  it("does not mutate its input", () => {
    const original = [...items];
    sortProjectWorkItems(items, "name");
    expect(items).toEqual(original);
  });
});

describe("labelSuggestions", () => {
  const withLabels = (id: string, repoCoord: string | null, labels: string[]) => ({ ...item(id, id, 1), repoCoord, labels });

  it("ranks the repository's own labels by use, then fills gaps with presets", () => {
    const items = [
      withLabels("a", "repo1", ["ui", "bug"]),
      withLabels("b", "repo1", ["bug"]),
      withLabels("c", "repo2", ["perf"]),
    ];
    expect(labelSuggestions(items, "repo1", ["bug", "documentation"])).toEqual([
      "bug", // used twice
      "ui",  // used once
      "documentation", // preset, no equivalent yet
    ]);
  });

  it("ignores labels belonging to other repositories", () => {
    const items = [withLabels("c", "repo2", ["perf"])];
    expect(labelSuggestions(items, "repo1", [])).toEqual([]);
  });

  it("offers presets alone when nothing has been labelled yet", () => {
    expect(labelSuggestions([], "repo1", ["bug", "enhancement"])).toEqual(["bug", "enhancement"]);
  });
});

describe("workItemActivityAt", () => {
  it("falls back to the opening when nothing followed", () => {
    expect(workItemActivityAt(item("a", "A", 100))).toBe(100);
  });

  it("never reports activity older than the opening", () => {
    expect(workItemActivityAt({ ...item("a", "A", 100), updatedAt: 50 })).toBe(100);
  });
});

describe("sortProjectWorkItems by activity", () => {
  it("lifts an old item that was just commented on above a newer quiet one", () => {
    const commented = { ...item("old", "Old", 100), updatedAt: 900 };
    const quiet = item("new", "New", 500);
    expect(sortProjectWorkItems([quiet, commented], "updated").map((i) => i.id)).toEqual(["old", "new"]);
  });

  it("leaves sources that track no discussion ordered by their opening", () => {
    const items = [item("a", "A", 100), item("b", "B", 300)];
    expect(sortProjectWorkItems(items, "updated").map((i) => i.id)).toEqual(["b", "a"]);
  });
});

describe("workItemMatchesQuery", () => {
  const target = { ...item("a", "Relay timeout on reconnect", 1), content: "Happens with wss://relay.example", labels: ["bug"] };

  it("matches an empty query", () => {
    expect(workItemMatchesQuery(target, "   ")).toBe(true);
  });

  it("matches on the title, body and labels, case-insensitively", () => {
    expect(workItemMatchesQuery(target, "TIMEOUT")).toBe(true);
    expect(workItemMatchesQuery(target, "wss://relay.example")).toBe(true);
    expect(workItemMatchesQuery(target, "bug")).toBe(true);
  });

  it("matches the repository name when one is supplied", () => {
    expect(workItemMatchesQuery(target, "armada")).toBe(false);
    expect(workItemMatchesQuery(target, "armada", "armada")).toBe(true);
  });

  it("requires every term, so extra words narrow the result", () => {
    expect(workItemMatchesQuery(target, "relay reconnect")).toBe(true);
    expect(workItemMatchesQuery(target, "relay android")).toBe(false);
  });
});

describe("repoMatchesQuery", () => {
  const repo: ProjectRepo = {
    coord: "30617:owner:armada",
    owner: "o",
    id: "armada",
    name: "Armada",
    description: "A Nostr client",
    cloneUrls: [],
    contributors: [],
    createdAt: 1,
    subtitle: "#engineering",
  };

  it("matches the name, identifier, description and origin channel", () => {
    expect(repoMatchesQuery(repo, "armada")).toBe(true);
    expect(repoMatchesQuery(repo, "nostr")).toBe(true);
    expect(repoMatchesQuery(repo, "#engineering")).toBe(true);
    expect(repoMatchesQuery(repo, "gitlab")).toBe(false);
  });
});
