import { describe, expect, it } from "vitest";
import type { NostrEvent } from "@nostrify/nostrify";

import { labelSuggestions, sortProjectWorkItems, type ProjectWorkItem } from "./projectData";

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
