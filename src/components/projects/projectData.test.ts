import { describe, expect, it } from "vitest";
import type { NostrEvent } from "@nostrify/nostrify";

import { sortProjectWorkItems, type ProjectWorkItem } from "./projectData";

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
